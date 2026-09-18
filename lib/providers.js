/**
 * providers.js —— 外部大模型接入（OpenAI 兼容协议一族）
 *
 * 这个模块把 AIRI 的「供应商 / Provider」能力搬到了本项目里。AIRI 那边是一套
 * TypeScript + zod 的重型注册表（packages/provider-inference，约 50 个定义）；
 * 本项目是零第三方依赖的原生 JS，不能照搬，所以只取它的**本质**：
 *
 *   一个 provider ≈ 三元组 (baseUrl, apiKey, model)，走 OpenAI 兼容的 HTTP 协议。
 *
 * 为什么只做 OpenAI 兼容一族就够用：
 *   DeepSeek / 月之暗面 / 智谱 / 通义千问 / 硅基流动 / OpenRouter / Gemini /
 *   Groq / Mistral / xAI / Together / Perplexity / 火山方舟 / 混元 / 星火 /
 *   本机 Ollama / LM Studio …… 全都提供 `/chat/completions` 这个形状的接口。
 *   差别只在域名和模型名，所以一张预设表 + 一个自定义端点就能覆盖绝大多数。
 *   真正的例外是 Anthropic 的 Messages 协议（报文结构完全不同，不能复用），
 *   本项目按约定不做，需要时用 OpenRouter 之类的中转即可。
 *
 * 三条设计原则，和 lib/ollama.js 保持一致：
 *   1. **默认不出网**。没配置外部供应商时，全流程仍走本机 Ollama；
 *      外部接入是显式打开的能力，不是默认行为。
 *   2. **预设只是"填好初值的表单"**，不是白名单。baseUrl 和模型名永远可改 ——
 *      厂商域名会变（阿里云百炼 2026 年就把推荐域名从 dashscope.aliyuncs.com
 *      换成了 {WorkspaceId}.cn-beijing.maas.aliyuncs.com，旧域名仅保留可用），
 *      把默认值写死会变成"用着用着就连不上"。
 *   3. **错误码跟 lib/ollama.js 同一套**（NO_MODEL / TIMEOUT / AUTH_ERROR …），
 *      这样上层 server.js 不用为"本地还是外部"写两套分支。
 */

const fs = require('fs');
const path = require('path');

// 复用 ollama.js 的思考链剥离：qwen3 / deepseek-reasoner 这类模型在外部接口上
// 同样会吐  thinking 段，剥法完全一样，没必要写第二份。
const { stripThinking } = require('./ollama');

const DEFAULT_TIMEOUT = Number(process.env.EXTERNAL_TIMEOUT_MS || 120000);

/**
 * 预设供应商表。
 *
 * 字段说明：
 *   id         稳定标识，写进配置文件，改名会让人已有的配置失效，所以慎改
 *   label      界面上显示的名字
 *   baseUrl    默认端点。注意结尾是 `/v1` 这种"根"，不是完整的 `/chat/completions`
 *   chatModel  默认对话模型
 *   models     常见模型名，仅用于下拉框的初始建议（真实列表靠「拉取模型列表」）
 *   local      本机服务（无需 API Key，也不该把 Key 发出去）
 *   caps       这家是否提供视觉 / 向量接口。false 只是"不建议"，不阻止用户填
 *   keyUrl     去哪申请 Key
 *   note       界面上的一句提醒（域名变更、model 要填接入点 ID 之类）
 */
const PRESETS = [
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索',
    baseUrl: 'https://api.deepseek.com/v1',
    chatModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    caps: { vision: false, embed: false },
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    chatModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2-0711-preview'],
    caps: { vision: true, embed: false },
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    chatModel: 'glm-4-plus',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4v-plus', 'embedding-3'],
    caps: { vision: true, embed: true },
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼 通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chatModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-vl-max', 'text-embedding-v3'],
    caps: { vision: true, embed: true },
    keyUrl: 'https://bailian.console.aliyun.com/',
    note: '阿里云已主推业务空间专属域名：把 dashscope.aliyuncs.com 换成 <空间ID>.cn-beijing.maas.aliyuncs.com（后面仍接 /compatible-mode/v1）。旧域名当前仍可用。API Key 与地域绑定，跨地域调用会 401。',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    chatModel: 'Qwen/Qwen2.5-7B-Instruct',
    models: [
      'Qwen/Qwen2.5-7B-Instruct',
      'Qwen/Qwen2.5-72B-Instruct',
      'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen2.5-VL-72B-Instruct',
      'BAAI/bge-m3',
    ],
    caps: { vision: true, embed: true },
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '模型名带组织前缀（如 Qwen/…、deepseek-ai/…），照抄别漏斜杠。',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    chatModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'text-embedding-3-small'],
    caps: { vision: true, embed: true },
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter 聚合',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatModel: 'openai/gpt-4o-mini',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-flash-1.5', 'deepseek/deepseek-chat'],
    caps: { vision: true, embed: false },
    keyUrl: 'https://openrouter.ai/keys',
    note: '一个 Key 转调各家模型，模型名形如 厂商/模型。可在同一处用到 Anthropic。',
  },
  {
    id: 'gemini',
    label: 'Google Gemini（OpenAI 兼容）',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    chatModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'text-embedding-004'],
    caps: { vision: true, embed: true },
    keyUrl: 'https://aistudio.google.com/app/apikey',
    note: '这是 Gemini 的 OpenAI 兼容入口，不是它原生的 generateContent 接口。',
  },
  {
    id: 'groq',
    label: 'Groq 高速推理',
    baseUrl: 'https://api.groq.com/openai/v1',
    chatModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen-2.5-32b'],
    caps: { vision: false, embed: false },
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    chatModel: 'mistral-small-latest',
    models: ['mistral-small-latest', 'mistral-large-latest', 'open-mistral-nemo'],
    caps: { vision: true, embed: true },
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    chatModel: 'grok-3-mini',
    models: ['grok-3-mini', 'grok-3', 'grok-2-vision-1212'],
    caps: { vision: true, embed: false },
    keyUrl: 'https://console.x.ai/',
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    chatModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
    caps: { vision: true, embed: true },
    keyUrl: 'https://api.together.xyz/settings/api-keys',
  },
  {
    id: 'perplexity',
    label: 'Perplexity 联网搜索',
    baseUrl: 'https://api.perplexity.ai',
    chatModel: 'sonar',
    models: ['sonar', 'sonar-pro'],
    caps: { vision: false, embed: false },
    keyUrl: 'https://www.perplexity.ai/settings/api',
    note: '这家响应里带联网检索结果，适合"查实时信息"；注意它的 baseUrl 结尾没有 /v1。',
  },
  {
    id: 'volcengine',
    label: '火山方舟 豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    chatModel: '',
    models: [],
    caps: { vision: true, embed: true },
    keyUrl: 'https://console.volcengine.com/ark',
    note: 'model 一般要填"推理接入点 ID"（ep- 开头）而不是模型名，请到方舟控制台创建接入点后复制。',
  },
  {
    id: 'hunyuan',
    label: '腾讯混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    chatModel: 'hunyuan-turbos-latest',
    models: ['hunyuan-turbos-latest', 'hunyuan-large', 'hunyuan-standard'],
    caps: { vision: false, embed: true },
    keyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
  },
  {
    id: 'spark',
    label: '讯飞星火',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    chatModel: 'generalv3.5',
    models: ['generalv3.5', '4.0Ultra', 'lite'],
    caps: { vision: false, embed: false },
    keyUrl: 'https://console.xfyun.cn/',
    note: '这里用的是星火的"OpenAI 兼容"HTTP 入口，Key 形如 APIKey:APISecret。',
  },
  {
    id: 'ollama-local',
    label: '本机 Ollama（OpenAI 兼容）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    chatModel: 'qwen2.5:7b',
    models: [],
    local: true,
    caps: { vision: true, embed: true },
    note: '走 Ollama 的 OpenAI 兼容层。日常对话仍建议用内置的本地通道（更快、能保活），这里主要用于对比排查。',
  },
  {
    id: 'lmstudio',
    label: '本机 LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    chatModel: '',
    models: [],
    local: true,
    caps: { vision: true, embed: true },
    note: 'LM Studio 启动本地服务器后的默认端口。',
  },
  {
    id: 'custom',
    label: '自定义（任意 OpenAI 兼容端点）',
    baseUrl: '',
    chatModel: '',
    models: [],
    caps: { vision: true, embed: true },
    note: '自己填 Base URL。以 /chat/completions 为结尾的完整地址会被自动截到根路径。',
  },
];

const PRESET_MAP = new Map(PRESETS.map(p => [p.id, p]));

function getPreset(id) {
  return PRESET_MAP.get(String(id || '')) || null;
}

/**
 * 规范化 baseUrl：去掉结尾斜杠，并把用户误填的完整端点截回根路径。
 *
 * 为什么要做后者：很多人从文档里直接复制的是
 *   https://api.deepseek.com/v1/chat/completions
 * 而我们拼路径时会再加一次 /chat/completions，结果就是 404。
 * 与其让用户对着 404 猜，不如在这里识别并纠正。
 */
function normalizeBaseUrl(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/(chat\/completions|completions|embeddings|models)$/i, '');
  return u.replace(/\/+$/, '');
}

/** 拼端点：baseUrl 可能带 /v1 也可能不带，交给调用方保证语义 */
function joinUrl(baseUrl, suffix) {
  return `${normalizeBaseUrl(baseUrl)}/${String(suffix).replace(/^\/+/, '')}`;
}

/** 只保留头尾，中间打码。用于回传给前端展示，避免密钥明文在页面/日志里滚 */
function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function mkError(message, code, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/**
 * 把 HTTP 错误翻译成"能照着做"的中文提示。
 *
 * 这张映射表是这个模块最有价值的部分之一：外部 API 的失败原因九成落在
 * 401/403/404/429 这四类里，而原始报文往往只有一句英文。
 */
function explainHttpError(status, bodyText, { baseUrl, model } = {}) {
  const snippet = String(bodyText || '').slice(0, 400);
  let detail = snippet;
  try {
    const j = JSON.parse(bodyText);
    detail = (j.error && (j.error.message || j.error.code))
      || j.message || j.msg || j.detail || snippet;
  } catch { /* 不是 JSON 就用原文 */ }

  const tail = detail ? `\n服务端返回：${detail}` : '';

  if (status === 401 || status === 403) {
    return mkError(
      `外部 API 拒绝了这个密钥（HTTP ${status}）。\n`
      + '请检查 API Key 是否填对、是否已过期、是否欠费，以及它和这个 Base URL 是否属于同一家/同一地域（阿里云百炼的 Key 是按地域绑定的）。'
      + tail,
      'AUTH_ERROR', { status },
    );
  }
  if (status === 404) {
    return mkError(
      `外部 API 返回 404：接口地址可能不对（${baseUrl}）。\n`
      + `请确认 Base URL 是"根地址"（通常以 /v1 结尾），不要把 /chat/completions 也一起填进去。\n`
      + '另外 404 有时也表示模型名不存在，可以点「拉取模型列表」看看真实可用的名字。'
      + tail,
      'BAD_ENDPOINT', { status },
    );
  }
  if (status === 429) {
    return mkError(
      '外部 API 限流或额度用尽（HTTP 429）。\n'
      + '稍等片刻重试；如果是免费额度，请到厂商控制台确认余额与速率限制。'
      + tail,
      'RATE_LIMIT', { status },
    );
  }
  if (status === 400 || status === 422) {
    return mkError(
      `外部 API 拒绝了这次请求（HTTP ${status}）。\n`
      + (model ? `当前模型：${model}\n` : '')
      + '常见原因：模型名写错、该模型不支持当前参数（比如给纯文本模型发图片）、内容被安全策略拦截。'
      + tail,
      'BAD_REQUEST', { status },
    );
  }
  if (status >= 500) {
    return mkError(`外部 API 服务端错误（HTTP ${status}），通常是对面出了问题，稍后重试。${tail}`, 'UPSTREAM_ERROR', { status });
  }
  return mkError(`外部 API 返回异常状态 ${status}。${tail}`, 'API_ERROR', { status });
}

/**
 * 统一发起请求：负责超时、网络错误翻译、错误体读取。
 * 所有协议函数都从这里出去，保证错误码口径一致。
 */
async function request(url, { method = 'POST', apiKey, body, timeout = DEFAULT_TIMEOUT, signal, accept } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (accept) headers.Accept = accept;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw mkError(
        `外部 API 超过 ${Math.round(timeout / 1000)} 秒没有响应。\n`
        + '可能是网络不通（需要能访问该厂商域名），或者这次请求确实太大。\n'
        + '可以设 EXTERNAL_TIMEOUT_MS 环境变量放宽超时。',
        'TIMEOUT',
      );
    }
    throw mkError(
      `连不上外部 API：${url}\n`
      + `底层错误：${e.message}\n`
      + '常见原因：Base URL 写错、本机网络/代理不通、对方域名被拦截。'
      + '可以先在浏览器里打开 Base URL 看能不能连通。',
      'NO_ENDPOINT',
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    clearTimeout(timer);
    throw explainHttpError(res.status, text, { baseUrl: url });
  }
  return { res, clearTimer: () => clearTimeout(timer) };
}

/**
 * 列出该端点可用的模型（GET /models）。
 * 这是 AIRI 那条 ModelList 校验的等价物，也是本模块最实用的一步：
 * 与其猜模型名，不如把真实列表拉下来让用户选。
 */
async function listModels({ baseUrl, apiKey, timeout = 20000 } = {}) {
  if (!baseUrl) throw mkError('还没填 Base URL', 'NO_ENDPOINT');
  const { res, clearTimer } = await request(joinUrl(baseUrl, 'models'), { method: 'GET', apiKey, timeout });
  try {
    const data = await res.json().catch(() => ({}));
    // OpenAI 规范是 {data:[{id}]}，但各家有出入，这里做几种兼容
    const arr = Array.isArray(data.data) ? data.data
      : Array.isArray(data.models) ? data.models
        : Array.isArray(data) ? data : [];
    return arr.map(m => (typeof m === 'string' ? m : (m.id || m.name || m.model))).filter(Boolean);
  } finally {
    clearTimer();
  }
}

/**
 * 规范化工具调用，与 lib/ollama.js 的同名函数保持一致的口径：
 * 统一成 { id, name, arguments(对象) }。
 *
 * OpenAI 这条链路上 arguments 是**分片下发的 JSON 字符串**（要按 index 拼起来），
 * Ollama 那边直接给对象。两条链路在上层必须长得一模一样，否则 agent 循环里
 * 就得处处判"这是哪来的工具调用"。
 */
function parseToolArguments(str) {
  if (!str) return {};
  try {
    const v = JSON.parse(str);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function normalizeToolCalls(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = [];
  for (const tc of list) {
    const fn = (tc && tc.function) || {};
    const name = fn.name || tc.name || '';
    if (!name) continue;
    let args = fn.arguments !== undefined ? fn.arguments : tc.arguments;
    if (typeof args === 'string') args = parseToolArguments(args);
    if (!args || typeof args !== 'object') args = {};
    out.push({ id: tc.id || '', name, arguments: args });
  }
  return out.length ? out : null;
}

/** 非流式对话；带 tools 时模型可能返回 toolCalls 而不是正文 */
async function chat({ baseUrl, apiKey, model, messages, temperature = 0.7, maxTokens = 2048, timeout = DEFAULT_TIMEOUT, tools }) {
  if (!baseUrl) throw mkError('还没配置外部 API 的 Base URL', 'NO_ENDPOINT');
  if (!model) throw mkError('还没配置外部 API 的模型名', 'NO_MODEL');

  const payload = {
    model,
    stream: false,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (Array.isArray(tools) && tools.length) payload.tools = tools;

  const { res, clearTimer } = await request(joinUrl(baseUrl, 'chat/completions'), {
    apiKey,
    timeout,
    body: payload,
  });

  try {
    const data = await res.json().catch(() => ({}));
    const choice = (data.choices && data.choices[0]) || {};
    const raw = (choice.message && choice.message.content) || '';
    const content = stripThinking(raw);
    const toolCalls = normalizeToolCalls(choice.message && choice.message.tool_calls);
    if (!content && !toolCalls) {
      // 有些推理模型把内容全放在 reasoning_content 里；这时给出明确提示而不是空报错
      const reasoning = (choice.message && choice.message.reasoning_content) || '';
      if (reasoning) {
        throw mkError(
          '模型只返回了思考过程，没有正文（reasoning_content 有内容但 content 为空）。\n'
          + '换一个非推理版模型，或缩短问题再试。',
          'EMPTY',
        );
      }
      throw mkError('外部模型返回为空，请重试', 'EMPTY');
    }
    return { content, raw, model, toolCalls, usage: data.usage || null };
  } finally {
    clearTimer();
  }
}

/**
 * 流式对话：把 OpenAI 的 SSE（`data: {...}` 行 + `data: [DONE]`）转成
 * 与 lib/ollama.js 的 chatStream 完全一样的异步生成器（`{delta}` / `{done}`）。
 *
 * 上层 server.js 的 SSE 转发逻辑因此完全不需要改。
 */
async function* chatStream({ baseUrl, apiKey, model, messages, temperature = 0.7, maxTokens = 2048, timeout = DEFAULT_TIMEOUT, signal, tools }) {
  if (!baseUrl) throw mkError('还没配置外部 API 的 Base URL', 'NO_ENDPOINT');
  if (!model) throw mkError('还没配置外部 API 的模型名', 'NO_MODEL');

  const { res, clearTimer } = await request(joinUrl(baseUrl, 'chat/completions'), {
    apiKey,
    timeout,
    signal,
    accept: 'text/event-stream',
    body: (() => {
      const b = {
        model,
        stream: true,
        messages,
        temperature,
        max_tokens: maxTokens,
      };
      if (Array.isArray(tools) && tools.length) b.tools = tools;
      return b;
    })(),
  });

  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let thinkBuf = '';
  let inThink = false;
  // OpenAI 的工具调用是**按 index 分片**流下来的：
  //   第 1 片给 id 和 function.name，后面若干片只给 arguments 的字符串碎片。
  // 所以要按 index 累积再拼接，最后才 JSON.parse —— 直接解析单片必然失败。
  const toolAcc = [];

  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith('data:')) continue;      // 忽略空行与 `: ping` 注释行
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') {
          yield { done: true, content: stripThinking(full), model, toolCalls: normalizeToolCalls(toolAcc) };
          return;
        }
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }

        // 有的厂商会在流里夹一个 error 对象（而不是用 HTTP 状态码）
        if (obj.error) {
          throw mkError(`外部模型返回错误：${obj.error.message || JSON.stringify(obj.error)}`, 'API_ERROR');
        }

        const choice = (obj.choices && obj.choices[0]) || {};

        // 累积工具调用分片
        const dtc = (choice.delta && choice.delta.tool_calls) || [];
        for (const part of dtc) {
          const idx = Number.isInteger(part.index) ? part.index : toolAcc.length;
          if (!toolAcc[idx]) toolAcc[idx] = { id: '', function: { name: '', arguments: '' } };
          if (part.id) toolAcc[idx].id = part.id;
          if (part.function) {
            if (part.function.name) toolAcc[idx].function.name = part.function.name;
            if (typeof part.function.arguments === 'string') {
              toolAcc[idx].function.arguments += part.function.arguments;
            }
          }
        }

        const piece = (choice.delta && choice.delta.content) || '';
        if (piece) {
          full += piece;
          // 与 ollama.js 相同的逐字符状态机：跨 chunk 的  thinking 块要在整条流上剥
          let visible = '';
          for (let i = 0; i < piece.length; i++) {
            thinkBuf += piece[i];
            if (!inThink && thinkBuf.endsWith(' thinking')) { inThink = true; thinkBuf = ''; continue; }
            if (inThink && thinkBuf.endsWith('<｜end▁of▁thinking｜>')) { inThink = false; thinkBuf = ''; continue; }
            if (!inThink) { visible += thinkBuf; thinkBuf = ''; }
            else if (thinkBuf.length > 16) thinkBuf = '';
          }
          if (visible) yield { delta: visible };
        }
      }
    }
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      const got = stripThinking(full).length;
      throw mkError(
        `外部模型超过 ${Math.round(timeout / 1000)} 秒仍未生成完。`
        + (got ? `\n已经写出来约 ${got} 字，后面卡住了。` : '')
        + '\n可以设 EXTERNAL_TIMEOUT_MS 放宽超时。',
        'TIMEOUT',
      );
    }
    throw e;
  } finally {
    clearTimer();
  }
  yield { done: true, content: stripThinking(full), model, toolCalls: normalizeToolCalls(toolAcc) };
}

/** 文本向量化（POST /embeddings） */
async function embed({ baseUrl, apiKey, model, input, timeout = 60000 }) {
  if (!baseUrl) throw mkError('还没配置外部 API 的 Base URL', 'NO_ENDPOINT');
  if (!model) throw mkError('当前外部供应商没有配置向量模型', 'NO_EMBED');

  const list = Array.isArray(input) ? input : [input];
  const { res, clearTimer } = await request(joinUrl(baseUrl, 'embeddings'), {
    apiKey,
    timeout,
    body: { model, input: list },
  });
  try {
    const data = await res.json().catch(() => ({}));
    const arr = Array.isArray(data.data) ? data.data : [];
    const out = arr
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map(d => d.embedding)
      .filter(v => Array.isArray(v) && v.length);
    if (out.length !== list.length) throw mkError('向量化返回条数与请求不一致', 'EMBED_ERROR');
    return out;
  } finally {
    clearTimer();
  }
}

/**
 * 视觉理解。
 *
 * 协议上和本地 Ollama 的差别只有一处：Ollama 用 `messages[].images` 放 base64，
 * OpenAI 兼容接口用标准的 `content: [{type:'image_url', image_url:{url:'data:...'}}]`。
 * 上层传进来的还是裸 base64，在这里补成 data URL。
 */
async function vision({ baseUrl, apiKey, model, prompt, imagesBase64, temperature = 0.3, timeout = DEFAULT_TIMEOUT }) {
  const images = (Array.isArray(imagesBase64) ? imagesBase64 : [imagesBase64]).filter(Boolean);
  const content = [
    { type: 'text', text: prompt || '请用中文详细描述这张图片的内容。如果这是文旅场景（景点、景区指示牌、菜单、酒店、街景等），请说明它是什么、有哪些可见特征，以及可以给游客什么建议。' },
    ...images.map(b64 => ({
      type: 'image_url',
      image_url: { url: b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}` },
    })),
  ];
  return chat({
    baseUrl,
    apiKey,
    model,
    temperature,
    maxTokens: 1024,
    timeout,
    messages: [{ role: 'user', content }],
  });
}

/**
 * 连通性 + chat 探针校验，对应 AIRI 的 Connectivity / ModelList / ChatCompletions
 * 三级校验。分级返回，让用户知道"哪一步过了、哪一步没过"。
 *
 * 为什么 chat 探针要单独一步：能列出模型 ≠ 能用这个模型。密钥额度、模型权限、
 * 参数兼容性都只有真的发一次请求才暴露得出来。
 */
async function verify({ baseUrl, apiKey, model, timeout = 30000, skipChat = false } = {}) {
  const steps = [];

  // 第一步：能不能连上并列出模型
  let models = [];
  try {
    models = await listModels({ baseUrl, apiKey, timeout });
    steps.push({ name: '连接与模型列表', ok: true, detail: `拉到 ${models.length} 个模型` });
  } catch (e) {
    steps.push({ name: '连接与模型列表', ok: false, detail: e.message, code: e.code });
    // 连不上就没必要继续了
    return { ok: false, steps, models: [] };
  }

  // 第二步：模型名是否在列表里（不在不算失败，很多中转站不暴露全量列表）
  if (model) {
    const hit = models.some(m => m === model || m.endsWith(`/${model}`) || model.endsWith(`/${m}`));
    steps.push({
      name: '模型名检查',
      ok: true,
      detail: hit ? `列表里有 ${model}` : `列表里没看到 ${model}（不一定是错，有些中转不暴露全量列表；下一步真正发请求才算数）`,
      warn: !hit,
    });
  }

  if (skipChat || !model) {
    return { ok: true, steps, models };
  }

  // 第三步：真的发一次最小对话
  try {
    const r = await chat({
      baseUrl,
      apiKey,
      model,
      maxTokens: 16,
      temperature: 0,
      timeout,
      messages: [{ role: 'user', content: '回复两个字：可用' }],
    });
    steps.push({ name: '对话探针', ok: true, detail: `模型回话：${String(r.content).slice(0, 40)}` });
    return { ok: true, steps, models };
  } catch (e) {
    steps.push({ name: '对话探针', ok: false, detail: e.message, code: e.code });
    return { ok: false, steps, models };
  }
}

/* ==========================================================================
 * 配置持久化
 * ========================================================================*/

/**
 * 配置形状（data/providers.json）：
 *
 * {
 *   version: 1,
 *   mode: 'local' | 'external',        // 总开关；local 时下面全部不生效
 *   external: {
 *     presetId, baseUrl, apiKey,
 *     chatModel, visionModel, embedModel
 *   },
 *   useFor: { vision: bool, embed: bool },   // 视觉/向量是否也走外部
 *   updatedAt
 * }
 *
 * 为什么 mode 和 useFor 要分开：绝大多数外部供应商（DeepSeek、Groq 等）只有对话，
 * 没有向量或视觉接口。如果用一个开关全切过去，记忆检索会立刻坏掉。
 * 所以对话归对话，视觉/向量各自独立开关，默认保持本地。
 */
const DEFAULT_CONFIG = {
  version: 1,
  mode: 'local',
  external: {
    presetId: 'deepseek',
    baseUrl: PRESET_MAP.get('deepseek').baseUrl,
    apiKey: '',
    chatModel: PRESET_MAP.get('deepseek').chatModel,
    visionModel: '',
    embedModel: '',
  },
  useFor: { vision: false, embed: false },
  updatedAt: 0,
};

function createProviders({ dir, file = 'providers.json' } = {}) {
  const filePath = path.join(dir, file);
  fs.mkdirSync(dir, { recursive: true });

  let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  function load() {
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      // 逐字段合并而不是整体替换：以后加新字段时，老配置文件不会因为缺字段而崩
      config = {
        ...DEFAULT_CONFIG,
        ...raw,
        external: { ...DEFAULT_CONFIG.external, ...(raw.external || {}) },
        useFor: { ...DEFAULT_CONFIG.useFor, ...(raw.useFor || {}) },
      };
      // 环境变量兜底：适合不方便写进配置文件（比如多人共用一个 data 目录）的场合
      if (process.env.EXTERNAL_API_KEY) config.external.apiKey = process.env.EXTERNAL_API_KEY;
      if (process.env.EXTERNAL_BASE_URL) config.external.baseUrl = process.env.EXTERNAL_BASE_URL;
      if (process.env.EXTERNAL_MODEL) config.external.chatModel = process.env.EXTERNAL_MODEL;
      if (process.env.WENLV_USE_EXTERNAL === '1') config.mode = 'external';
    } catch (e) {
      console.error('[providers] 配置文件损坏，已改用默认配置（本机 Ollama）：', e.message);
      try { fs.copyFileSync(filePath, `${filePath}.corrupt`); } catch { /* 忽略 */ }
      config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }
  load();

  function persist() {
    config.updatedAt = Date.now();
    try {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);   // 原子替换，防止写一半断电把密钥文件写坏
    } catch (e) {
      console.error('[providers] 配置写入失败：', e.message);
    }
  }

  /** 是否真的要走外部 */
  function isExternal() {
    return config.mode === 'external'
      && Boolean(normalizeBaseUrl(config.external.baseUrl));
  }

  /** 取出可直接用于请求的目标三元组 */
  function target(kind = 'chat') {
    const e = config.external;
    return {
      baseUrl: normalizeBaseUrl(e.baseUrl),
      apiKey: e.apiKey || '',
      model: (kind === 'chat' ? e.chatModel : kind === 'vision' ? e.visionModel : e.embedModel) || '',
    };
  }

  /** 某一类能力是否走外部 */
  function routes(kind) {
    if (!isExternal()) return false;
    if (kind === 'chat') return true;
    return Boolean(config.useFor[kind]) && Boolean(target(kind).model);
  }

  /**
   * 勾了"这一类也走外部"、却没填对应的模型名。
   *
   * 这时 routes() 会返回 false，也就是**安全地回落到本地**，功能不会断。
   * 但不能让它悄悄发生 —— 用户以为在用外部视觉、实际在用本地，
   * 一旦本机又没装视觉模型，就会看到一堆莫名其妙的报错。
   * 所以单独把这个状态报出来，由界面明确提示"配置没填完"。
   */
  function misconfigured() {
    const out = {};
    for (const kind of ['vision', 'embed']) {
      out[kind] = Boolean(isExternal() && config.useFor[kind] && !target(kind).model);
    }
    return out;
  }

  /** 回传给前端：密钥打码，并带上预设表（前端不用再存一份厂商列表） */
  function publicConfig() {
    const e = config.external;
    const preset = getPreset(e.presetId);
    return {
      mode: config.mode,
      active: isExternal(),
      external: {
        presetId: e.presetId,
        baseUrl: e.baseUrl,
        apiKeyMasked: maskKey(e.apiKey),
        hasApiKey: Boolean(e.apiKey),
        chatModel: e.chatModel,
        visionModel: e.visionModel,
        embedModel: e.embedModel,
      },
      useFor: { ...config.useFor },
      preset: preset || null,
      updatedAt: config.updatedAt,
    };
  }

  /**
   * 保存配置。
   *
   * 一个安全细节：前端拿不到明文密钥，所以保存时如果 apiKey 字段没传，
   * 就沿用原来存着的那个，而不是把它清空 —— 否则用户每改一次模型名，
   * 密钥就被抹掉了。
   */
  function update(patch = {}) {
    const p = patch || {};
    if (p.mode === 'local' || p.mode === 'external') config.mode = p.mode;

    const ext = p.external || {};
    if (ext.presetId !== undefined) {
      const preset = getPreset(ext.presetId);
      config.external.presetId = preset ? preset.id : 'custom';
      // 切换预设时把 baseUrl/默认模型一起带过去，省得用户手抄
      if (preset && ext.baseUrl === undefined) config.external.baseUrl = preset.baseUrl;
      if (preset && preset.chatModel && ext.chatModel === undefined) config.external.chatModel = preset.chatModel;
    }
    for (const k of ['baseUrl', 'chatModel', 'visionModel', 'embedModel']) {
      if (ext[k] !== undefined) config.external[k] = String(ext[k] || '').trim();
    }
    // 只接受非空的新密钥；传空串视为"不改"，要清除得用 clearApiKey
    if (typeof ext.apiKey === 'string' && ext.apiKey.trim()) {
      config.external.apiKey = ext.apiKey.trim();
    }
    if (p.clearApiKey === true) config.external.apiKey = '';

    if (p.useFor) {
      if (p.useFor.vision !== undefined) config.useFor.vision = Boolean(p.useFor.vision);
      if (p.useFor.embed !== undefined) config.useFor.embed = Boolean(p.useFor.embed);
    }

    persist();
    return publicConfig();
  }

  return {
    PRESETS,
    configPath: filePath,
    getConfig: () => config,
    publicConfig,
    update,
    isExternal,
    target,
    routes,
    misconfigured,
  };
}

module.exports = {
  PRESETS,
  PRESET_MAP,
  DEFAULT_CONFIG,
  getPreset,
  normalizeBaseUrl,
  joinUrl,
  maskKey,
  explainHttpError,
  normalizeToolCalls,
  createProviders,
  listModels,
  chat,
  chatStream,
  embed,
  vision,
  verify,
};
