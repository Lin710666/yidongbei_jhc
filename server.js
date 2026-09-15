#!/usr/bin/env node
/**
 * 文旅智能辅助 —— 本地部署服务器（零第三方依赖，仅用 Node 内置模块）
 *
 * 它做了四件事：
 *   1. 把 demo/index.html 以 http://127.0.0.1:8000 提供给浏览器
 *      —— 解决"双击 file:// 打开后 fetch 本地模型会撞 CORS 跨域"的问题
 *   2. 提供 POST /api/generate：把「SKILL.md 说明书 + references 知识库」
 *      组装成提示词，发给本地 Ollama 大模型，再把生成的 Markdown 传回浏览器
 *   3. 对模型输出做质检：核对推荐项是否真的来自本地样本库、字段有没有漏填、
 *      表格与章节结构是否规范。发现问题会**如实标注给用户**，而不是静默放行
 *   4. 模型不可用时，返回可执行的排查指引（不降级、不伪造结果）
 *
 * 启动：node server.js    （或在 Windows 双击 start.bat）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ===== 配置 =====
const PORT = process.env.PORT || 8000;
const HOST = process.env.HOST || '127.0.0.1';   // 默认只监听回环地址，保证"数据不出本机"这个承诺真正成立
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 300000);  // 单次生成超时（5 分钟）
const MAX_BODY = 1e6;                           // 请求体上限 1MB（正常请求不足 1KB）

const ROOT = __dirname;                                                // 项目根目录
const WEB_ROOT = path.join(ROOT, 'demo');                              // 静态页面目录
const SKILL_DIR = path.join(ROOT, '.agents', 'skills', 'wenlv-assistant');
const REF_DIR = path.join(SKILL_DIR, 'references');

// ===== 0. 样本库分片：按功能只注入相关文件，不把上下文预算浪费在无关数据上 =====
const REF_MAP = {
  plan: ['destinations.md', 'hotels.md', 'dining.md'],
  marketing: ['marketing-playbook.md'],
  intake: [],                       // 需求采集阶段只需要 SKILL.md，不需要样本库
};
const WHITELIST_FILES = ['destinations.md', 'hotels.md', 'dining.md'];  // 参与质检的样本库

function readRef(f) {
  return fs.readFileSync(path.join(REF_DIR, f), 'utf8');
}

// ===== 1. 输出质检器（逻辑在 lib/audit.js，便于独立单元测试） =====
// 质检要能识别四类问题：编造库外条目、把某类条目用错位置（如住宿当餐厅）、
// 字段漏填、结构异常（天数不足 / 总览表为空 / 章节重复 / 表格列数不符）。
const { createAuditor } = require('./lib/audit');
const auditor = createAuditor(REF_DIR);

// ===== 2. 组装「系统提示词」：Skill 说明书 + 相关样本库 + 分类型输出规则（启动后缓存） =====
const OUT_RULES = {
  plan: [
    '【输出要求】你是文旅智能辅助助手，请严格按上面 Skill 规范与样本库数据生成结果。',
    '只输出 Markdown 正文：不要"好的""以下是"等客套话、不要解释、不要用代码块围栏包裹。',
    '',
    '【硬性约束】',
    '1. 推荐的所有景点、餐厅、住宿，必须逐字来自上面样本库表格中的「名称」列；不得改写名称、不得虚构、不得使用样本库以外的名称。',
    '2. 样本库中没有合适条目时，写「样本库暂无推荐」并说明建议补充哪类数据，禁止自行编造商家名称或价格。',
    '3. 每天六个字段（上午 / 午餐 / 下午 / 晚餐 / 住宿 / 交通贴士）都必须有实际内容，禁止用「无」「待定」等占位符敷衍；确实没有合适条目时按第 2 条处理。',
    '4. 「## 费用预估」表必须含「项目 | 档位 | 预估」三列，且"总计"必须等于各分项之和。',
    '5. 「## 行程总览」「## 费用预估」「## 替代方案 & 避坑提示」三个章节各只允许出现一次，严禁重复输出。',
    '6. 必须完整输出用户要求的每一天：请求 N 天就要有 Day 1 到 Day N 共 N 段，且「行程总览」表必须有 N 行数据（每天一行）。不得提前结束、不得只写总览不写明细、不得因为写累了就少写几天。上面样本库已覆盖该目的地的全部条目，景点数量足够安排 N 天不重复；若个别字段确实没有合适条目，按第 2 条写「样本库暂无推荐」，但**天数必须写满 N 天**。',
    '7. 「## 行程总览」表必须逐行填写，不能只留表头。先写完总览表，再写 Day 1 ~ Day N 的明细。',
    '8. 每个字段的值**只写名称本身**（可跟一个括号补充说明），不要写成一整句话。',
    '   正确：`- 上午：西溪湿地（约 80 元，摇橹船）`；错误：`- 上午：深入西溪国家湿地公园内游玩`。',
    '   正确：`- 午餐：外婆家（人均约 70 元）`；错误：`- 午餐：在萧山区的老字号外婆家中品味地道的农家风味`。',
  ].join('\n'),
  marketing: [
    '【输出要求】你是文旅智能辅助助手，请严格按上面 Skill 规范与各平台模板生成结果。',
    '只输出 Markdown 正文：不要"好的""以下是"等客套话、不要解释、不要用代码块围栏包裹。',
    '',
    '【硬性约束】',
    '1. 不得编造具体价格、折扣、评分、销量、获奖等无法核实的数据；需要体现优惠时用"限时优惠"这类不涉及具体数字的表述。',
    '2. 必须输出 A、B 两个版本（理性卖点版 + 感性情绪版），每版都含：标题、正文、话题标签、配图建议、CTA。',
    '3. 同一段落、同一小节标题只允许出现一次，严禁重复输出。',
  ].join('\n'),
  intake: [
    '【输出要求】用户尚未提供任何需求信息，请按 SKILL.md「2.2 需求采集」的要求，一次性集中追问。',
    '输出格式：先用一句话说明你能做什么，然后逐个字段列出 2-5 个可点选的候选选项（Markdown 列表）。',
    '需要追问的字段：目的地、游玩天数、预算档位、同行人群、兴趣偏好（可多选）、饮食禁忌。',
    '不要生成行程方案，不要输出费用预估，不要使用代码块围栏。',
  ].join('\n'),
};

const promptCache = new Map();                    // 启动后缓存，避免每次请求重复读盘拼串

// 列出样本库里已覆盖的城市（`## 城市名` 分节）
function listCities(content) {
  return [...String(content).matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1].trim());
}

// 从多城市样本库中切出目标城市那一节
// 为什么需要它：样本库扩充到多城市后，若全量注入会超出模型上下文，
// 因此只注入用户所选目的地的数据。找不到该城市时返回 null。
function sliceCitySection(content, city) {
  const target = String(city || '').trim();
  if (!target) return null;
  const lines = String(content).split('\n');
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!m) continue;
    const name = m[1].trim();
    if (start === -1) {
      if (name === target) start = i;
      continue;
    }
    end = i;
    break;
  }
  if (start === -1) return null;
  return lines.slice(start, end).join('\n').trim();
}

function buildSystemPrompt(type = 'plan', city = '') {
  const cacheKey = `${type}|${city || ''}`;
  if (promptCache.has(cacheKey)) return promptCache.get(cacheKey);

  const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const refs = (REF_MAP[type] || REF_MAP.plan)
    .map((f) => {
      const raw = readRef(f);
      const cities = listCities(raw);

      // 只有「按城市分节」的样本库才做切片（营销方法论那类不分城市，原样注入）
      if (type !== 'plan' || !cities.length) {
        return `\n\n===== ${f} =====\n${raw}`;
      }

      const sliced = city ? sliceCitySection(raw, city) : null;
      if (sliced) {
        return (
          `\n\n===== ${f} =====\n` +
          `（以下为「${city}」的样本数据，其它城市的数据未注入）\n\n${sliced}`
        );
      }
      return (
        `\n\n===== ${f} =====\n` +
        `（本地样本库当前**未覆盖**「${city || '未指定'}」；已覆盖：${cities.join('、')}。）\n` +
        `请按 SKILL.md「2.3 生成逻辑」第 1 条处理：退回通用文旅知识生成，` +
        `并在结果开头明确标注「本地样本库暂无该目的地，以下为通用建议，建议补充本地数据」。`
      );
    })
    .join('');

  const text = `${skill}\n\n${refs}\n\n${OUT_RULES[type] || OUT_RULES.plan}`;
  promptCache.set(cacheKey, text);
  return text;
}

// ===== 3. 把前端传来的参数，拼成一句自然的"用户请求" =====
function buildUserPrompt(type, params) {
  params = params || {};
  if (type === 'plan') {
    const { city, days, budget, crowd, interests, diet } = params;
    return (
      `请为我生成个性化「游玩·旅居·餐饮」一体化方案：\n` +
      `- 目的地：${city}\n- 游玩天数：${days} 天\n- 预算档位：${budget}\n` +
      `- 同行人群：${crowd}\n- 兴趣偏好：${(interests || []).join('、') || '不限'}\n- 饮食禁忌：${diet}`
    );
  }
  if (type === 'marketing') {
    const { product, platform, audience, style } = params;
    return (
      `请为「${product}」生成「${platform}」平台的营销文案：\n` +
      `- 产品/主体：${product}\n- 目标平台：${platform}\n- 目标客群：${audience}\n- 文案风格：${style}\n` +
      `请输出 A/B 两个版本（理性卖点版 + 感性情绪版），各含：标题、正文、话题标签、配图建议、CTA。`
    );
  }
  if (type === 'intake') {
    // 异常处理演示：故意不提供任何信息，让模型按 SKILL.md 的"集中追问（带选项）"规范回应
    return '我还没有提供任何需求信息，请先按规范向我集中追问（每个字段都给出可点选的候选选项）。';
  }
  const err = new Error('未知类型: ' + type);
  err.code = 'BAD_INPUT';
  throw err;
}

// ===== 4. 按功能给不同的采样参数：行程要稳、文案要活、追问要短 =====
function ollamaOptions(type) {
  if (type === 'marketing') {
    return { temperature: 0.85, repeat_penalty: 1.15, repeat_last_n: 512, num_ctx: 8192, num_predict: 2048 };
  }
  if (type === 'intake') {
    return { temperature: 0.3, num_ctx: 4096, num_predict: 700 };
  }
  // plan：长文生成温度压低，repeat_penalty 提高以抑制"结尾整块重复"的退化
  return { temperature: 0.4, repeat_penalty: 1.18, repeat_last_n: 512, num_ctx: 16384, num_predict: 4096 };
}

// ===== 5. 调用本地 Ollama 大模型（带超时与错误分类） =====
async function callOllama(type, params) {
  const body = {
    model: MODEL,
    stream: false,                                  // 教学版；进阶可改流式（见 README「已知限制」）
    options: ollamaOptions(type),
    messages: [
      { role: 'system', content: buildSystemPrompt(type, params && params.city) },  // 角色 + 目标城市样本库 + 硬性约束
      { role: 'user', content: buildUserPrompt(type, params) },  // 本次需求
    ],
  };

  let res;
  try {
    // Node 18+ 自带全局 fetch，直接 HTTP 调用本地 Ollama
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // 超时：多数情况下是模型冷启动加载权重太慢，给出可执行的等待建议
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      const err = new Error(
        `本地模型超过 ${Math.round(TIMEOUT_MS / 1000)} 秒仍未返回。\n` +
        `首次调用需要把模型加载进显存，稍等片刻后重试即可；` +
        `若持续超时，可先在命令行执行一次 "ollama run ${MODEL}" 预热模型。`
      );
      err.code = 'TIMEOUT';
      throw err;
    }
    // 连不上 Ollama：给出可执行的排查指引
    const err = new Error(
      `无法连接 Ollama 服务（${OLLAMA_URL}）。\n` +
      `请确认 Ollama 已安装并运行：安装 "winget install Ollama.Ollama"，运行 "ollama serve" 或 "ollama list" 检查。`
    );
    err.code = 'NO_OLLAMA';
    throw err;
  }

  if (res.status === 404) {
    const err = new Error(`模型 ${MODEL} 未下载。请在命令行运行：ollama pull ${MODEL}`);
    err.code = 'NO_MODEL';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Ollama 返回异常状态 ${res.status}`);
    err.code = 'OLLAMA_ERROR';
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  const content = data.message && data.message.content;
  if (!content || !content.trim()) {
    const err = new Error('模型返回为空，请重试');
    err.code = 'EMPTY';
    throw err;
  }
  return content.trim();
}

// ===== 7. 探测 Ollama 是否在线、目标模型是否真的已下载（供前端显示状态） =====
async function ollamaStatus() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return { running: false, models: [], hasModel: false };
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    // Ollama 的名称可能带 tag，用宽松匹配，避免误报"已就绪"
    const hasModel = models.some((n) => n === MODEL || n.startsWith(MODEL + ':') || normName(n) === normName(MODEL));
    return { running: true, models, hasModel };
  } catch {
    return { running: false, models: [], hasModel: false };
  }
}

// ===== 8. HTTP 服务器（静态文件 + 两个 API） =====
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// 错误码 → HTTP 状态码（业务失败不再一律返回 200）
const CODE_STATUS = {
  BAD_INPUT: 400,
  TOO_LARGE: 413,
  NO_OLLAMA: 502,
  TIMEOUT: 504,
  NO_MODEL: 503,
  OLLAMA_ERROR: 502,
  EMPTY: 502,
  INTERNAL: 500,
};

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 纯文本响应：给 Agent 引擎的 web_fetch 用（模型直接读到可展示的正文）
function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// 把生成结果与质检告警拼成一段"Agent 可直接转述给用户"的纯文本
function formatForAgent(content, warnings, type, params) {
  const head = [];
  if (type === 'plan') {
    head.push(
      `【由本地样本库驱动生成】目的地：${params.city} ｜ 天数：${params.days} 天 ｜ ` +
      `预算：${params.budget} ｜ 同行人群：${params.crowd} ｜ 饮食禁忌：${params.diet}`
    );
  } else {
    head.push(
      `【由本地样本库驱动生成】产品：${params.product} ｜ 平台：${params.platform} ｜ ` +
      `目标客群：${params.audience} ｜ 风格：${params.style}`
    );
  }
  if (warnings && warnings.length) {
    head.push('');
    head.push(`⚠️ 输出质检发现 ${warnings.length} 处需要注意（已与本地样本库核对）：`);
    warnings.forEach((w, i) => head.push(`${i + 1}. ${w}`));
  }
  head.push('');
  head.push('---------- 以下为生成结果（请原样转述，不要改写、不要复述本段说明）----------');
  head.push('');
  return head.join('\n') + content + '\n';
}

function serveStatic(reqUrl, res) {
  // 解码失败（如 /%）必须当作 400 处理，否则会抛异常把整个服务带崩
  let pathname;
  try {
    pathname = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, '');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request: 非法的 URL 编码');
    return;
  }
  if (pathname === '') pathname = 'index.html';

  const filePath = path.normalize(path.join(WEB_ROOT, pathname));
  // 防目录穿越：必须带路径分隔符边界，避免同前缀的兄弟目录（如 demo-x）被放行
  if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found: ' + pathname);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  // 整个请求处理都在 try 里：任何未预料的异常都返回 500，绝不让进程退出
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // 状态探测：前端页面加载时调用
    if (req.method === 'GET' && reqUrl.pathname === '/api/status') {
      const st = await ollamaStatus();
      return sendJSON(res, 200, { model: MODEL, ...st });
    }

    // ===== Agent 引擎集成接口（供 OpenClaw 等引擎用 web_fetch 直接调用）=====
    // 设计意图：让外部 Agent 也能用上本项目的「样本库约束 + 输出质检 + 固定模板」，
    // 返回纯文本，模型读到即可原样转述。参数通过查询串传入，中文会被正确解码。
    //
    //   GET /api/quick-plan?city=杭州&days=2&budget=舒适&crowd=情侣&interests=自然风光,美食&diet=无
    //   GET /api/quick-marketing?product=景区&platform=小红书&audience=年轻情侣&style=种草
    if (
      req.method === 'GET' &&
      (reqUrl.pathname === '/api/quick-plan' || reqUrl.pathname === '/api/quick-marketing')
    ) {
      const q = reqUrl.searchParams;
      const isPlan = reqUrl.pathname === '/api/quick-plan';
      const type = isPlan ? 'plan' : 'marketing';
      const params = isPlan
        ? {
            city: (q.get('city') || '杭州').trim(),
            days: Number(q.get('days')) || 2,
            budget: (q.get('budget') || '舒适').trim(),
            crowd: (q.get('crowd') || '朋友').trim(),
            interests: (q.get('interests') || '').split(/[,，、\s]+/).filter(Boolean),
            diet: (q.get('diet') || '无').trim(),
          }
        : {
            product: (q.get('product') || '景区').trim(),
            platform: (q.get('platform') || '小红书').trim(),
            audience: (q.get('audience') || '年轻情侣').trim(),
            style: (q.get('style') || '种草').trim(),
          };
      try {
        const content = await callOllama(type, params);
        const warnings = auditor.audit(content, type, params);
        return sendText(res, 200, formatForAgent(content, warnings, type, params));
      } catch (e) {
        const code = e.code || 'INTERNAL';
        return sendText(
          res,
          CODE_STATUS[code] || 500,
          `【生成失败】${String(e.message || e)}\n`
        );
      }
    }

    // 生成接口：前端"生成方案/文案"按钮调用
    if (req.method === 'POST' && reqUrl.pathname === '/api/generate') {
      let raw = '';
      let tooLarge = false;
      req.on('data', (c) => {
        if (tooLarge) return;
        raw += c;
        if (raw.length > MAX_BODY) {                 // 限制请求体，避免无限累加
          tooLarge = true;
          sendJSON(res, 413, { ok: false, code: 'TOO_LARGE', error: '请求体过大' });
          req.destroy();
        }
      });
      req.on('end', async () => {
        if (tooLarge) return;
        let payload;
        try {
          payload = JSON.parse(raw || '{}');
        } catch {
          return sendJSON(res, 400, { ok: false, code: 'BAD_INPUT', error: '请求体不是合法 JSON' });
        }
        const { type, params } = payload;
        try {
          const content = await callOllama(type, params);
          const warnings = auditor.audit(content, type, params);   // 输出质检：编造 / 分类错位 / 漏填 / 结构异常
          sendJSON(res, 200, { ok: true, source: 'local-llm', model: MODEL, content, warnings });
        } catch (e) {
          // 出错：按错误类型返回对应状态码 + 明确文案，由前端展示给用户
          const code = e.code || 'INTERNAL';
          sendJSON(res, CODE_STATUS[code] || 500, { ok: false, code, error: String(e.message || e) });
        }
      });
      return;
    }

    if (req.method === 'GET') return serveStatic(reqUrl, res);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    console.error('[未捕获异常]', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('服务器内部错误');
    } else {
      res.end();
    }
  }
});

// 端口占用时给出明确提示，而不是抛出难懂的 EADDRINUSE 堆栈
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[错误] 端口 ${PORT} 已被占用。请关闭占用该端口的程序，或用 PORT=8001 node server.js 换端口启动。`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log(`  文旅智能辅助已启动： http://localhost:${PORT}`);
  console.log(`  监听地址：${HOST}（仅本机可访问，数据不出本机）`);
  console.log(`  本地模型：${MODEL}   (Ollama @ ${OLLAMA_URL})`);
  console.log(`  样本库实体：${auditor.entityCount} 条（按景区/酒店/餐饮三类分库核对），输出质检已启用`);
  console.log('  按 Ctrl+C 停止。');
  console.log('==============================================');
});

// 进程级兜底：即使将来某处漏了 try/catch，也先留日志、不直接崩服务
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
