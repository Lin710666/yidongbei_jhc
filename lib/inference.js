/**
 * inference.js —— 模型调用路由层（本地 Ollama ⇄ 外部 OpenAI 兼容 API）
 *
 * 为什么需要这一层：
 *   项目里所有"要模型"的地方（对话、方案、文案、视觉、记忆向量）原本都直接
 *   require lib/ollama.js。如果我在每个调用点写 if (外部) {...} else {...}，
 *   分支会散落到 5 个文件里，加一种能力就要再改一圈。
 *
 *   好在原设计是依赖注入的 —— createWenlv({ ollama }) / createMemory({ ollama })。
 *   所以这里做一个**和 ollama.js 同接口的对象**替换掉它，调用方一行都不用改：
 *
 *     resolveModels() / chat() / chatStream() / embed() / vision() / status()
 *
 *   结果是：路由规则只有一处，且 lib/wenlv.js、lib/memory.js 保持零改动。
 *
 * 路由规则（按能力分开，不是一个开关全切）：
 *   对话  —— mode = 'external' 时走外部
 *   视觉  —— 需要 useFor.vision 且填了 visionModel
 *   向量  —— 需要 useFor.embed  且填了 embedModel
 *
 *   为什么视觉/向量要各自独立：绝大多数外部供应商（DeepSeek、Groq、Kimi…）
 *   只有对话接口，没有向量或视觉。用一个开关全切过去，记忆检索会当场坏掉。
 *   默认这两个都保持本地。
 *
 * 一个额外好处：mode = 'external' 且外部配好之后，**Ollama 没装也能对话**。
 * 所以 resolveModels() 在外部对话可用时不再因为 Ollama 连不上就抛错。
 */

const providersLib = require('./providers');

const NO_LOCAL_MODEL_HINT = '本机没有可用的对话模型。请先运行：ollama pull qwen2.5:7b（或 qwen3:8b），或者在「设置 → 模型接入」里配置一个外部 API。';

function createInference({ ollama, providers, gpu }) {
  /* ======================================================================
   * 本地显存共享闸门
   *
   * **只给走本地的分支加**，外部 API 分支一律不加 —— 外部调用不占本机显存，
   * 让它去排本地的队就成了纯粹的添堵（用户配了外部 API 就是为了分流）。
   * 这也正是"本地与外部不冲突"的落点：两条路的资源根本不在一个池子里。
   *
   * 共享（而不是独占）是因为 Ollama 自己会管模型的装载与淘汰，
   * 我们只需要保证"独占任务（Whisper / TripoSR / 深度图 / TTS）在跑时它别来掺一脚"。
   * ====================================================================*/
  async function localShared(name, fn) {
    if (!gpu || !gpu.withShared) return fn(null);
    return gpu.withShared({ name }, fn);
  }

  /** 流式版本：租约必须覆盖整个迭代过程，否则一 yield 就被当成"干完了" */
  async function* localSharedStream(name, makeIter) {
    if (!gpu || !gpu.acquireShared) { yield* makeIter(); return; }
    const lease = await gpu.acquireShared({ name });
    try {
      yield* makeIter();
    } finally {
      lease.release();
    }
  }

  /**
   * 决定这一次调用用哪个模型。
   *
   * 走外部时**以配置为准，忽略调用方传来的模型名**。理由是调用方传来的名字
   * 通常来自本地语境：角色卡里 pin 的 `qwen2.5:7b`、resolveModels() 给的本地模型名。
   * 把它们原样发给 DeepSeek 只会得到 404，而且报错信息会让人以为是密钥问题。
   */
  function pickModel(kind, requested) {
    if (providers.routes(kind)) {
      const t = providers.target(kind);
      if (!t.model) {
        throw Object.assign(
          new Error(`已经切到外部 API，但还没填「${kind === 'vision' ? '视觉' : kind === 'embed' ? '向量' : '对话'}模型」名字。请到「设置 → 模型接入」补上，或点「拉取模型列表」挑一个。`),
          { code: 'NO_MODEL' },
        );
      }
      return t.model;
    }
    if (!requested) throw Object.assign(new Error(NO_LOCAL_MODEL_HINT), { code: 'NO_MODEL' });
    return requested;
  }

  /**
   * 探测可用模型。
   *
   * 与 ollama.resolveModels() 的关键差别：Ollama 连不上时**不再直接抛错**，
   * 而是把错误记下来继续走 —— 因为外部通道可能是通的，这时对话完全可用。
   */
  async function resolveModels() {
    let local = { models: [], chat: null, vision: null, embed: null };
    let localError = null;
    try {
      local = await ollama.resolveModels();
    } catch (e) {
      localError = e;
    }

    const extChat = providers.routes('chat') ? providers.target('chat').model : null;
    const extVision = providers.routes('vision') ? providers.target('vision').model : null;
    const extEmbed = providers.routes('embed') ? providers.target('embed').model : null;

    const chat = extChat || local.chat || null;
    const vision = extVision || local.vision || null;
    const embed = extEmbed || local.embed || null;

    return {
      models: local.models.map(m => m.name),
      chat,
      vision,
      embed,
      // 两个别名都留着：调用方有的按用途命名、有的按语义命名（沿用 ollama.js 的做法）
      chatModel: chat,
      visionModel: vision,
      embedModel: embed,
      // 额外信息，方便界面如实显示"这个名字来自哪"
      source: {
        chat: extChat ? 'external' : (local.chat ? 'local' : null),
        vision: extVision ? 'external' : (local.vision ? 'local' : null),
        embed: extEmbed ? 'external' : (local.embed ? 'local' : null),
      },
      localModels: local.models.map(m => m.name),
      localError: localError ? String(localError.message || localError) : null,
      // 勾了外部但没填模型名的能力：本次已安全回落到本地，但要如实报出来
      misconfigured: providers.misconfigured(),
    };
  }

  /** 非流式对话；opts.tools 存在时模型可能返回 toolCalls 而不是正文 */
  async function chat(opts = {}) {
    const { model, messages, temperature = 0.7, numPredict = 2048, timeout, format, tools } = opts;
    const useModel = pickModel('chat', model);
    if (providers.routes('chat')) {
      const t = providers.target('chat');
      const r = await providersLib.chat({
        baseUrl: t.baseUrl,
        apiKey: t.apiKey,
        model: useModel,
        messages,
        temperature,
        // 外部协议的字段叫 max_tokens；numPredict 是本地的叫法，在这里对齐
        maxTokens: format ? Math.max(numPredict, 512) : numPredict,
        timeout,
        tools,
      });
      return {
        content: r.content,
        raw: r.raw,
        model: useModel,
        source: 'external',
        usage: r.usage,
        toolCalls: r.toolCalls || null,
      };
    }
    // 本地：opts 整体透传，ollama.chat 已支持 tools
    return localShared('对话', async () => {
      const r = await ollama.chat(opts);
      return { ...r, source: 'local' };
    });
  }

  /** 流式对话：转发 ollama 或外部，事件形状保持一致 */
  async function* chatStream(opts = {}) {
    const { model, messages, temperature = 0.7, numPredict = 2048, timeout, signal, tools } = opts;
    const useModel = pickModel('chat', model);

    if (providers.routes('chat')) {
      const t = providers.target('chat');
      for await (const chunk of providersLib.chatStream({
        baseUrl: t.baseUrl,
        apiKey: t.apiKey,
        model: useModel,
        messages,
        temperature,
        maxTokens: numPredict,
        timeout,
        signal,
        tools,
      })) {
        if (chunk.delta) yield { delta: chunk.delta, source: 'external' };
        if (chunk.done) yield { ...chunk, model: useModel, source: 'external' };
      }
      return;
    }

    // 本地流式：租约要覆盖整个迭代（一 yield 就释放的话等于没锁）
    yield* localSharedStream('对话', async function* () {
      for await (const chunk of ollama.chatStream(opts)) {
        yield { ...chunk, source: 'local' };
      }
    });
  }
  /** 文本向量化 */
  async function embed(opts = {}) {
    const { model, input } = opts;
    const useModel = pickModel('embed', model);
    if (providers.routes('embed')) {
      const t = providers.target('embed');
      return providersLib.embed({ baseUrl: t.baseUrl, apiKey: t.apiKey, model: useModel, input });
    }
    return localShared('向量', () => ollama.embed(opts));
  }

  /** 视觉理解 */
  async function vision(opts = {}) {
    const { model, prompt, imagesBase64, temperature = 0.3, timeout } = opts;
    const useModel = pickModel('vision', model);
    if (providers.routes('vision')) {
      const t = providers.target('vision');
      const r = await providersLib.vision({
        baseUrl: t.baseUrl,
        apiKey: t.apiKey,
        model: useModel,
        prompt,
        imagesBase64,
        temperature,
        timeout,
      });
      return { content: r.content, raw: r.raw, model: useModel, source: 'external' };
    }
    return localShared('视觉', async () => {
      const r = await ollama.vision(opts);
      return { ...r, source: 'local' };
    });
  }

  /**
   * 状态：在 ollama.status() 的基础上补一段外部接入的情况。
   *
   * 保留 ollama 那套字段不动，是因为 /api/status 与前端状态灯、冒烟测试都
   * 依赖 `ollama.chatModel` 这些字段；加字段是安全的，改字段不是。
   */
  async function status() {
    const local = await ollama.status();
    let resolved = null;
    try { resolved = await resolveModels(); } catch { /* 忽略 */ }

    // 「本地优先」的显存侧那一半：三项能力都切到外部时，本地模型完全用不上，
    // 让它继续按 keep_alive 占着 5GB 显存纯属浪费。放在 status() 里做是因为
    // 这个函数本来就会被 /api/status 定期调用，且每次改完配置前端都会刷一次 ——
    // 正好是"用户刚把最后一个能力切到外部"的那个时刻。
    if (gpu && gpu.releaseLocalIfUnused) {
      const allExternal = providers.routes('chat') && providers.routes('vision') && providers.routes('embed');
      gpu.releaseLocalIfUnused({ allExternal, reason: '三项能力均已切到外部 API' })
        .catch(() => { /* 让不出显存不该影响状态查询 */ });
    }

    const pc = providers.publicConfig();
    const extTarget = providers.target('chat');

    const external = {
      active: providers.isExternal(),
      presetId: pc.external.presetId,
      presetLabel: (pc.preset && pc.preset.label) || '自定义',
      baseUrl: pc.external.baseUrl,
      hasApiKey: pc.external.hasApiKey,
      apiKeyMasked: pc.external.apiKeyMasked,
      chatModel: pc.external.chatModel,
      visionModel: pc.external.visionModel,
      embedModel: pc.external.embedModel,
      useFor: pc.useFor,
    };

    return {
      ...local,
      // 覆盖成"路由后真正生效"的名字，界面就该显示这个
      chatModel: resolved ? resolved.chatModel : local.chatModel,
      visionModel: resolved ? resolved.visionModel : local.visionModel,
      embedModel: resolved ? resolved.embedModel : local.embedModel,
      // ready 的口径也要跟着变：外部配好时，Ollama 没起来也算就绪
      ready: Boolean(resolved && resolved.chatModel),
      localReady: local.ready,
      external,
      route: resolved ? resolved.source : null,
      // 配置没填完的能力（已回落本地），界面要据此给出提示而不是假装一切正常
      misconfigured: resolved ? resolved.misconfigured : {},
      // 外部端点可读性检查：不真发请求，只判断配置是否完整
      externalReady: providers.isExternal() ? Boolean(extTarget.baseUrl && extTarget.model) : false,

      /**
       * 「本地优先」的口径，直接给界面用。
       *
       * 为什么要把结论算好给前端：前端自己从 providers 配置推的话，得同时理解
       * useFor、各能力的 model 是否填了、预设是否完整 —— 三处一起看才不会推错。
       * 推错的后果是界面显示"走本地"而实际走了外部，用户对"数据出不出本机"的
       * 判断就建立在一个错误的前提上。这种事不该靠前端复刻一遍逻辑。
       */
      localFirst: {
        policy: '本地优先：本地可用时默认走本地；外部只在你于「设置 → 模型接入」里逐项指定时才启用',
        chat: providers.routes('chat') ? 'external' : 'local',
        vision: providers.routes('vision') ? 'external' : 'local',
        embed: providers.routes('embed') ? 'external' : 'local',
        // 外部失败时该往哪退：三项里只要还有走本地的，就说明本地这条退路是通的
        canFallbackToLocal: Boolean(local.chatModel || local.ready),
      },
    };
  }

  /**
   * 把一轮工具调用编织成"下一轮要发出去的 messages"。
   *
   * 为什么必须放在这里而不是 agent 里：**两家协议对工具消息的要求不一样**，
   * 只有本模块知道当前走的是哪条路。
   *   Ollama：assistant.tool_calls[].function.arguments 是**对象**；
   *           tool 消息只要 { role, content }
   *   OpenAI：assistant.tool_calls[] 要带 id 与 type:'function'，arguments 是**JSON 字符串**；
   *           tool 消息必须回填 tool_call_id
   * 写错任何一条，表现都是"模型莫名其妙开始重复调用同一个工具"或直接 400 —— 
   * 而且报错信息完全指不到格式上去。
   */
  function buildToolRound({ content, toolCalls, results }) {
    const external = providers.routes('chat');
    const msgs = [];

    if (external) {
      msgs.push({
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls.map((tc, i) => ({
          id: tc.id || `call_${Date.now()}_${i}`,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
        })),
      });
      for (let i = 0; i < results.length; i++) {
        const tc = toolCalls[i];
        msgs.push({
          role: 'tool',
          tool_call_id: tc.id || `call_${Date.now()}_${i}`,
          content: results[i].forModel,
        });
      }
      return msgs;
    }

    msgs.push({
      role: 'assistant',
      content: content || '',
      tool_calls: toolCalls.map(tc => ({ function: { name: tc.name, arguments: tc.arguments || {} } })),
    });
    for (const r of results) msgs.push({ role: 'tool', content: r.forModel });
    return msgs;
  }

  return {
    // ---- ollama.js 的同名接口（调用方依赖的就是这些）----
    resolveModels,
    chat,
    chatStream,
    embed,
    vision,
    status,
    buildToolRound,
    // ---- 便于排查/界面使用 ----
    providers,
    isExternal: () => providers.isExternal(),
    routes: kind => providers.routes(kind),
  };
}

module.exports = { createInference };
