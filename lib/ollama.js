/**
 * ollama.js —— 本地大模型统一客户端（零第三方依赖，仅用 Node 内置 fetch）
 *
 * 本文件把 airi 里"机体大脑 / 视觉 / 记忆向量"这三类服务全部落到本机 Ollama 上：
 *   · chat   —— 机体对话（虚拟人格，即 ai 角色卡的人设提示词）
 *   · vision —— 视觉理解（多模态 VLM，用于"拍照识景 / 看懂这张图"）
 *   · embed  —— 文本向量化（机体记忆的语义检索）
 *
 * 设计原则：
 *   1. 模型名不写死。启动时探测本机 `ollama list`，按候选优先级自动挑选，
 *      用户机器上装的是 qwen3:8b 就用 qwen3:8b，装了 qwen2.5:7b 就用它。
 *   2. 连不上 / 没装模型时，抛出带 code 的错误，由上层转成可执行的排查指引，
 *      绝不静默降级去"编一个看起来像样的结果"。
 *   3. 流式与非流式都支持：对话走流式（打字机效果），方案/文案走非流式（便于整体质检）。
 */

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const DEFAULT_TIMEOUT = Number(process.env.OLLAMA_TIMEOUT_MS || 300000);

/**
 * 模型保活时长。
 *
 * Ollama 自己默认 5 分钟不活动就把模型从显存里卸掉，下次提问要重新加载。
 * 本机实测差距极大（qwen2.5:7b 约 5GB，显卡 8GB）：
 *   冷启动（模型已被卸载）：首字 70.2 秒
 *   热启动（模型还在显存）：首字  0.2 秒
 * 对答辩演示来说，用户隔几分钟回来问一句就要干等一分多钟，观感非常差，
 * 所以统一给一个较长的保活时间；要覆盖就设环境变量 WENLV_KEEP_ALIVE。
 */
const KEEP_ALIVE = process.env.WENLV_KEEP_ALIVE || '30m';

/**
 * 是否让模型"先想再答"。
 *
 * 默认关闭，原因有三条，都是实测踩出来的：
 *   1. qwen3 这类思考型模型会把 num_predict 大量花在思维链上。本机是 20%/80% CPU/GPU
 *      混合推理，开着思考出一份 2 天行程要 5 分钟以上，关掉后是几十秒级。
 *   2. 思维链会挤占输出预算，导致"方案只写了 3 天就收尾"——正是原项目 README 里
 *      记录的那个"长天数方案写不满"的问题，关思考能明显缓解。
 *   3. 流式时思维链会先糊到界面上，观感像答非所问（代码里虽然会剥离
 *      区块，但已经浪费了时间）。
 *
 * 需要思维链时设 OLLAMA_THINK=1 即可恢复。
 */
const THINK = process.env.OLLAMA_THINK === '1' ? true : (process.env.OLLAMA_THINK === '0' ? false : false);

/** 各用途的候选模型：按顺序取本机第一个存在的 */
const CANDIDATES = {
  // qwen2.5:7b 放在第一位是**刻意的**，不是随手排的：
  //   1. 它不是思考型模型，不会把 num_predict 预算花在思维链上；
  //   2. 中文结构化输出（表格、逐日字段、费用合计）比 qwen3 稳；
  //   3. 显存占用比 qwen3:8b 小，更容易整块装进 8GB 显卡。
  // qwen3 系列保留在后面当后备：本机只装了 qwen3 时会自动用它，不会因为找不到 qwen2.5 就报错。
  chat: [
    process.env.OLLAMA_MODEL,
    'qwen2.5:7b', 'qwen2.5:14b', 'qwen2.5:3b', 'qwen2.5:1.5b',
    'qwen3:8b', 'qwen3:4b', 'qwen3:14b',
    'llama3.1:8b', 'gemma3:4b', 'glm4:9b',
  ].filter(Boolean),
  vision: [
    process.env.OLLAMA_VISION_MODEL,
    'qwen2.5vl:7b', 'qwen2.5vl:3b', 'qwen2.5-vl:7b', 'qwen3-vl:8b',
    'llava:7b', 'llava:13b', 'minicpm-v:8b', 'moondream:1.8b', 'gemma3:4b', 'gemma3:12b',
  ].filter(Boolean),
  embed: [
    process.env.OLLAMA_EMBED_MODEL,
    'nomic-embed-text', 'bge-m3', 'mxbai-embed-large', 'qwen3-embedding:0.6b',
    'snowflake-arctic-embed2', 'all-minilm',
  ].filter(Boolean),
};

/** 用于"看起来像不像多模态"的兜底匹配（用户自己 pull 了别的 VLM 也能认出来） */
const VISION_HINT = /vl|vision|llava|minicpm-v|moondream|bakllava|gemma3|internvl|pixtral/i;
/** 用于"看起来像不像向量模型" */
const EMBED_HINT = /embed|bge|gte|e5-|minilm|arctic-embed/i;

function mkError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** 规范化模型名比较：`qwen3:8b` 与 `qwen3:latest` 视为同一个 */
function normName(n) {
  return String(n || '').toLowerCase().replace(/:latest$/, '');
}

/** 拉取本机模型列表；Ollama 没起来时抛出 NO_OLLAMA */
async function listModels({ timeout = 5000 } = {}) {
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(timeout) });
  } catch {
    throw mkError(
      `无法连接本地 Ollama（${OLLAMA_URL}）。\n`
      + '请确认 Ollama 已安装并正在运行：\n'
      + '  · Windows：开始菜单打开 Ollama，或在命令行执行 ollama serve\n'
      + '  · 安装：winget install Ollama.Ollama',
      'NO_OLLAMA',
    );
  }
  if (!res.ok) throw mkError(`Ollama 返回异常状态 ${res.status}`, 'OLLAMA_ERROR');
  const data = await res.json().catch(() => ({}));
  return (data.models || []).map(m => ({
    name: m.name,
    size: m.size || 0,
    family: (m.details && m.details.family) || '',
    families: (m.details && m.details.families) || [],
  }));
}

/**
 * 挑选模型：先按候选表精确匹配，再用启发式兜底。
 * @returns {Promise<{models:Array, chat:string|null, vision:string|null, embed:string|null}>}
 */
async function resolveModels() {
  const models = await listModels();
  const names = models.map(m => m.name);
  const exists = (cand) => {
    const c = normName(cand);
    return names.find(n => normName(n) === c || normName(n).startsWith(`${c}:`) || normName(n).startsWith(c)) || null;
  };

  // chat：排除明显是向量/纯视觉的模型，避免把 embedding 模型当聊天模型用
  let chat = null;
  for (const c of CANDIDATES.chat) {
    const hit = exists(c);
    if (hit && !EMBED_HINT.test(hit)) { chat = hit; break; }
  }
  if (!chat) chat = names.find(n => !EMBED_HINT.test(n) && !VISION_HINT.test(n)) || names[0] || null;

  // vision：优先候选表，其次按命名启发式，再其次看 details.families 里有没有 clip/vision
  let vision = null;
  for (const c of CANDIDATES.vision) { const hit = exists(c); if (hit) { vision = hit; break; } }
  if (!vision) {
    vision = models.find(m =>
      VISION_HINT.test(m.name)
      || (m.families || []).some(f => /clip|vision|vit/i.test(f)),
    )?.name || null;
  }

  // embed：同 vision 思路
  let embed = null;
  for (const c of CANDIDATES.embed) { const hit = exists(c); if (hit) { embed = hit; break; } }
  if (!embed) embed = names.find(n => EMBED_HINT.test(n)) || null;

  // 同时给出 `chat`/`chatModel` 两种别名：调用方有的按用途命名、有的按语义命名，
  // 统一在这里都提供，避免出现"取到 undefined 却当成没装模型"这类静默错误。
  return { models, chat, vision, embed, chatModel: chat, visionModel: vision, embedModel: embed };
}

/**
 * 去掉 qwen3 等"思考型"模型输出的 思考…<｜end▁of▁thinking｜> 段落。
 * 不清掉的话，思维链会直接糊到用户界面上，看起来像答非所问。
 */
function stripThinking(text) {
  return String(text || '')
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/^\s*<think(?:ing)?>[\s\S]*$/i, '')
    .trim();
}

/** 非流式对话，返回完整文本 */
async function chat({ model, messages, temperature = 0.7, numCtx = 8192, numPredict = 2048, timeout = DEFAULT_TIMEOUT, format, keepAlive, think }) {
  if (!model) throw mkError('未指定对话模型', 'NO_MODEL');
  const body = {
    model,
    stream: false,
    messages,
    think: think === undefined ? THINK : think,
    options: { temperature, num_ctx: numCtx, num_predict: numPredict, repeat_penalty: 1.1 },
  };
  if (format) body.format = format;
  // keepAlive === false 表示这次不指定、交给 Ollama 默认；其余情况用 KEEP_ALIVE
  if (keepAlive !== false) body.keep_alive = keepAlive || KEEP_ALIVE;

  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw mkError(
        `本地模型超过 ${Math.round(timeout / 1000)} 秒仍未返回。\n`
        + `首次调用需要把模型加载进显存，稍等片刻重试即可；也可先执行 "ollama run ${model}" 预热。`,
        'TIMEOUT',
      );
    }
    throw mkError(`无法连接 Ollama（${OLLAMA_URL}），请确认 Ollama 正在运行。`, 'NO_OLLAMA');
  }
  if (res.status === 404) throw mkError(`模型 ${model} 未下载。请在命令行运行：ollama pull ${model}`, 'NO_MODEL');
  if (!res.ok) throw mkError(`Ollama 返回异常状态 ${res.status}`, 'OLLAMA_ERROR');

  const data = await res.json().catch(() => ({}));
  const raw = (data.message && data.message.content) || '';
  const content = stripThinking(raw);
  if (!content) throw mkError('模型返回为空，请重试', 'EMPTY');
  return { content, raw, model };
}

/**
 * 流式对话：返回一个异步生成器，逐段吐出 `{delta}` 与最后 `{done, content}`。
 * 为什么需要它：7B 模型出一份完整方案要几十秒，不流式用户会以为界面卡死。
 */
async function* chatStream({ model, messages, temperature = 0.7, numCtx = 8192, numPredict = 2048, timeout = DEFAULT_TIMEOUT, signal, think }) {
  if (!model) throw mkError('未指定对话模型', 'NO_MODEL');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });

  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        messages,
        think: think === undefined ? THINK : think,
        keep_alive: KEEP_ALIVE,
        options: { temperature, num_ctx: numCtx, num_predict: numPredict, repeat_penalty: 1.1 },
      }),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw mkError(`本地模型超过 ${Math.round(timeout / 1000)} 秒未返回`, 'TIMEOUT');
    throw mkError(`无法连接 Ollama（${OLLAMA_URL}）`, 'NO_OLLAMA');
  }
  if (res.status === 404) { clearTimeout(timer); throw mkError(`模型 ${model} 未下载`, 'NO_MODEL'); }
  if (!res.ok) { clearTimeout(timer); throw mkError(`Ollama 返回异常状态 ${res.status}`, 'OLLAMA_ERROR'); }

  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let thinkBuf = '';        // 跨 chunk 的  thinking 块需要在整条流的层面剥离，不能只按行剥
  let inThink = false;

  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const piece = (obj.message && obj.message.content) || '';
        if (piece) {
          full += piece;
          // 逐字符状态机剥离思考块：遇到  thinking 进入、<｜end▁of▁thinking｜> 退出
          let visible = '';
          for (let i = 0; i < piece.length; i++) {
            thinkBuf += piece[i];
            if (!inThink && thinkBuf.endsWith(' thinking')) { inThink = true; thinkBuf = ''; continue; }
            if (inThink && thinkBuf.endsWith('<｜end▁of▁thinking｜>')) { inThink = false; thinkBuf = ''; continue; }
            if (!inThink) { visible += thinkBuf; thinkBuf = ''; }
            else if (thinkBuf.length > 16) thinkBuf = '';   // 防止缓冲无限增长
          }
          if (visible) yield { delta: visible };
        }
        if (obj.done) {
          clearTimeout(timer);
          yield { done: true, content: stripThinking(full), model };
          return;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  yield { done: true, content: stripThinking(full), model };
}

/** 文本向量化。没有向量模型时抛出 NO_EMBED，由记忆模块回退到词法检索 */
async function embed({ model, input, timeout = 60000 }) {
  if (!model) throw mkError('本机未安装向量模型（embedding model）', 'NO_EMBED');
  const list = Array.isArray(input) ? input : [input];
  const out = [];
  for (const text of list) {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
      signal: AbortSignal.timeout(timeout),
    }).catch(() => { throw mkError(`无法连接 Ollama（${OLLAMA_URL}）`, 'NO_OLLAMA'); });
    if (res.status === 404) throw mkError(`向量模型 ${model} 未下载：ollama pull ${model}`, 'NO_EMBED');
    if (!res.ok) throw mkError(`向量化失败，Ollama 状态 ${res.status}`, 'EMBED_ERROR');
    const data = await res.json().catch(() => ({}));
    const vec = data.embedding || (data.embeddings && data.embeddings[0]);
    if (!Array.isArray(vec) || !vec.length) throw mkError('向量化返回为空', 'EMBED_ERROR');
    out.push(vec);
  }
  return out;
}

/**
 * 视觉理解：把图片（base64，不带 data: 前缀）交给本机多模态模型。
 * Ollama 的 /api/chat 支持 messages[].images 字段。
 */
async function vision({ model, prompt, imagesBase64, temperature = 0.3, timeout = DEFAULT_TIMEOUT }) {
  if (!model) {
    throw mkError(
      '本机没有可用的多模态模型，无法做视觉理解。\n'
      + '请任选一个下载（推荐中文效果好的）：\n'
      + '  ollama pull qwen2.5vl:7b     （约 6 GB，中文场景识别最准）\n'
      + '  ollama pull llava:7b         （约 4.7 GB，体积小一些）\n'
      + '下载完成后回到本页点"刷新状态"即可，无需重启服务。',
      'NO_VISION_MODEL',
    );
  }
  return chat({
    model,
    temperature,
    numCtx: 8192,
    numPredict: 1024,
    timeout,
    messages: [{
      role: 'user',
      content: prompt || '请用中文详细描述这张图片的内容。如果这是文旅场景（景点、景区指示牌、菜单、酒店、街景等），请说明它是什么、有哪些可见特征，以及可以给游客什么建议。',
      images: imagesBase64,
    }],
  });
}

/** 供前端展示的运行状态 */
async function status() {
  try {
    const { models, chat, vision: v, embed: e } = await resolveModels();
    return {
      running: true,
      url: OLLAMA_URL,
      models: models.map(m => m.name),
      chatModel: chat,
      visionModel: v,
      embedModel: e,
      ready: Boolean(chat),
    };
  } catch (err) {
    return {
      running: false,
      url: OLLAMA_URL,
      models: [],
      chatModel: null,
      visionModel: null,
      embedModel: null,
      ready: false,
      error: String(err.message || err),
      code: err.code || 'NO_OLLAMA',
    };
  }
}

module.exports = {
  OLLAMA_URL,
  CANDIDATES,
  THINK,
  listModels,
  resolveModels,
  stripThinking,
  chat,
  chatStream,
  embed,
  vision,
  status,
};
