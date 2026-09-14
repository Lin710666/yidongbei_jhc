#!/usr/bin/env node
/**
 * 文旅智能辅助 —— 本地部署服务器（零第三方依赖，仅用 Node 内置模块）
 *
 * 它做了三件事：
 *   1. 把 demo/index.html 以 http://localhost:8000 提供给浏览器
 *      —— 解决"双击 file:// 打开后 fetch 本地模型会撞 CORS 跨域"的问题
 *   2. 提供 POST /api/generate：把「SKILL.md 说明书 + references 知识库」
 *      组装成提示词，发给本地 Ollama 大模型，再把生成的 Markdown 传回浏览器
 *   3. 模型不可用时，返回 fallback 信号，让前端降级到内置规则引擎（保证双击也能用）
 *
 * 启动：node server.js    （或在 Windows 双击 start.bat）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ===== 配置 =====
const PORT = process.env.PORT || 8000;                                  // 本地端口
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';  // Ollama 推理服务地址
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';                 // 本地模型（可按需换）

const ROOT = __dirname;                                                // 项目根目录
const WEB_ROOT = path.join(ROOT, 'demo');                              // 静态页面目录
const SKILL_DIR = path.join(ROOT, '.agents', 'skills', 'wenlv-assistant');

// ===== 1. 组装「系统提示词」：Skill 说明书 + 本地知识库 =====
// 这是 Plan B 的核心思想：SKILL.md 不再是"一张纸"，而是被读进内存、
// 拼成系统提示词，让本地模型"照着它干活"。
function buildSystemPrompt() {
  const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');

  const refFiles = ['destinations.md', 'hotels.md', 'dining.md', 'marketing-playbook.md'];
  const refs = refFiles.map((f) => {
    const content = fs.readFileSync(path.join(SKILL_DIR, 'references', f), 'utf8');
    return `\n\n===== ${f} =====\n${content}`;
  }).join('');

  return (
    `${skill}\n\n${refs}\n\n` +
    `【输出要求】你是文旅智能辅助助手，请严格按上面 Skill 规范与样本库数据生成结果。` +
    `只输出 Markdown 正文：不要"好的""以下是"等客套话、不要解释、不要用代码块围栏包裹。`
  );
}

// ===== 2. 把前端传来的参数，拼成一句自然的"用户请求" =====
function buildUserPrompt(type, params) {
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
  throw new Error('未知类型: ' + type);
}

// ===== 3. 调用本地 Ollama 大模型（关键一步：真正的"智能"发生在这里） =====
async function callOllama(type, params) {
  const body = {
    model: MODEL,
    stream: false,                         // 一次性返回完整结果（教学版；进阶可改流式）
    options: { temperature: 0.7, num_ctx: 8192 },  // temperature 控制随机性
    messages: [
      { role: 'system', content: buildSystemPrompt() },  // 角色 + 知识库
      { role: 'user', content: buildUserPrompt(type, params) },  // 本次需求
    ],
  };

  // Node 24 自带全局 fetch，直接 HTTP 调用本地 Ollama
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // 连不上 Ollama：给出可执行的排查指引
    throw new Error(
      `无法连接 Ollama 服务（${OLLAMA_URL}）。\n` +
      `请确认 Ollama 已安装并运行：安装 "winget install Ollama.Ollama"，运行 "ollama serve" 或 "ollama list" 检查。`
    );
  }

  if (res.status === 404) {
    throw new Error(`模型 ${MODEL} 未下载。请在命令行运行：ollama pull ${MODEL}`);
  }
  if (!res.ok) throw new Error(`Ollama 返回异常状态 ${res.status}`);

  const data = await res.json().catch(() => ({}));
  const content = data.message && data.message.content;
  if (!content || !content.trim()) throw new Error('模型返回为空，请重试');
  return content.trim();
}

// ===== 4. 探测 Ollama 是否在线、已装了哪些模型（供前端显示状态） =====
async function ollamaStatus() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return { running: false, models: [] };
    const data = await res.json();
    return { running: true, models: (data.models || []).map((m) => m.name) };
  } catch {
    return { running: false, models: [] };
  }
}

// ===== 5. HTTP 服务器（静态文件 + 两个 API） =====
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function serveStatic(reqUrl, res) {
  let pathname = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, '');
  if (pathname === '') pathname = 'index.html';
  const filePath = path.normalize(path.join(WEB_ROOT, pathname));
  // 防目录穿越：确保解析后的路径仍在 WEB_ROOT 内
  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not Found: ' + pathname); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 状态探测：前端页面加载时调用
  if (req.method === 'GET' && reqUrl.pathname === '/api/status') {
    const st = await ollamaStatus();
    return sendJSON(res, 200, { model: MODEL, ...st });
  }

  // 生成接口：前端"生成方案/文案"按钮调用
  if (req.method === 'POST' && reqUrl.pathname === '/api/generate') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        const { type, params } = JSON.parse(raw || '{}');
        const content = await callOllama(type, params);
        sendJSON(res, 200, { ok: true, source: 'local-llm', model: MODEL, content });
      } catch (e) {
        // 出错：返回明确错误信息，由前端展示给用户
        sendJSON(res, 200, { ok: false, error: String(e.message || e) });
      }
    });
    return;
  }

  if (req.method === 'GET') return serveStatic(reqUrl, res);
  res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, () => {
  console.log('==============================================');
  console.log(`  文旅智能辅助已启动： http://localhost:${PORT}`);
  console.log(`  本地模型：${MODEL}   (Ollama @ ${OLLAMA_URL})`);
  console.log('  按 Ctrl+C 停止。');
  console.log('==============================================');
});
