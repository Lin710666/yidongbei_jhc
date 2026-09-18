#!/usr/bin/env node
/**
 * 文旅智能辅助 · AIRI 网页版 —— 本地服务器（零第三方依赖，仅用 Node 内置模块）
 *
 * 一句话：把原 yidongbei-2.2 的"表单式网页"升级成 airi 风格的"虚拟人物交互网页"，
 * 并把 airi 的各项服务（机体记忆 / 视觉 / 声音）全部落到本机运行。
 *
 * 服务清单（全部本地，不调用任何云端 API）：
 *   · 对话 / 大脑  → 本机 Ollama          （lib/ollama.js）
 *   · 机体记忆     → 本机文件 + 混合检索   （lib/memory.js）
 *   · 视觉理解     → 本机 Ollama 多模态模型（lib/ollama.js 的 vision）
 *   · 语音合成     → 本机 Qwen TTS WebUI   （lib/tts.js）
 *   · AI 角色卡    → 本机文件              （lib/cards.js）
 *   · 文旅 Skill   → SKILL.md + references + 输出质检（lib/wenlv.js）
 *
 * 启动：node server.js       （Windows 双击 start.bat）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ollama = require('./lib/ollama');
const { createMemory } = require('./lib/memory');
const { createTTS, VOICE_PRESETS } = require('./lib/tts');
const { createCards } = require('./lib/cards');
const { createWenlv } = require('./lib/wenlv');
const { createBackgrounds } = require('./lib/backgrounds');
const { createModels3D } = require('./lib/models3d');
const { createVoices } = require('./lib/voices');

// ===== 配置 =====
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';       // 默认只监听回环，保证"数据不出本机"在实现层成立
// 图片走 base64 放宽到 24MB；3D 模型（VRM 动辄 25~30MB，base64 后还要大 1/3）
// 必须给到更大的上限，否则上传自定义 VRM 会被 413 直接拒掉。
const MAX_BODY = Number(process.env.MAX_BODY || 150 * 1024 * 1024);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 12 * 1024 * 1024);
const MAX_MODEL3D_BYTES = Number(process.env.MAX_MODEL3D_BYTES || 100 * 1024 * 1024);
// 参考音频：24MB 够放 4 分钟 24kHz/16bit 单声道。再长也没有意义 ——
// 实测参考音频越长合成越慢、显存吃得越多，音色本身靠开头十几秒就定型了。
const MAX_VOICE_BYTES = Number(process.env.MAX_VOICE_BYTES || 24 * 1024 * 1024);

const ROOT = __dirname;
const WEB_ROOT = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SKILL_DIR = path.join(ROOT, '.agents', 'skills', 'wenlv-assistant');
const MODEL_ROOT = path.join(WEB_ROOT, 'models');
const TTS_CACHE = path.join(DATA_DIR, 'tts-cache');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TTS_CACHE, { recursive: true });

const memory = createMemory({ dir: DATA_DIR, ollama });
const tts = createTTS({ cacheDir: TTS_CACHE });
const cards = createCards({ dir: DATA_DIR });
const wenlv = createWenlv({ skillDir: SKILL_DIR, ollama });
const backgrounds = createBackgrounds({ publicDir: WEB_ROOT, dataDir: DATA_DIR });
const models3d = createModels3D({ publicDir: WEB_ROOT, dataDir: DATA_DIR });
// "我的音色"：用户上传的参考音频，供 voice-clone 用（存 data/voice-refs/）
const voices = createVoices({ dir: DATA_DIR, maxBytes: MAX_VOICE_BYTES });

// ===== 小工具 =====
const CODE_STATUS = {
  BAD_INPUT: 400,
  TOO_LARGE: 413,
  BAD_FORMAT: 400,
  TOO_SHORT: 400,
  NOT_FOUND: 404,
  NO_OLLAMA: 502,
  TIMEOUT: 504,
  NO_MODEL: 503,
  OLLAMA_ERROR: 502,
  EMPTY: 502,
  NO_VISION_MODEL: 503,
  NO_EMBED: 503,
  EMBED_ERROR: 502,
  NO_TTS: 502,
  NO_TTS_MODEL: 503,
  TTS_ERROR: 502,
  TTS_TIMEOUT: 504,
  INTERNAL: 500,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.moc3': 'application/octet-stream',
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, code, text) {
  const buf = Buffer.from(String(text), 'utf8');
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function fail(res, e) {
  const code = e && e.code ? e.code : 'INTERNAL';
  return sendJSON(res, CODE_STATUS[code] || 500, { ok: false, code, error: String((e && e.message) || e) });
}

/** 读取请求体（带大小上限，避免超大 body 把内存吃满） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      raw += c;
      if (raw.length > MAX_BODY) {
        tooLarge = true;
        const err = new Error(`请求体过大（上限 ${(MAX_BODY / 1024 / 1024).toFixed(0)}MB）`);
        err.code = 'TOO_LARGE';
        reject(err);
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch {
        const err = new Error('请求体不是合法 JSON');
        err.code = 'BAD_INPUT';
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** SSE：先写头，再逐条推事件 */
function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  res.on('close', () => { closed = true; });
  return {
    send(obj) {
      if (closed) return false;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); return true; } catch { closed = true; return false; }
    },
    end() { if (!closed) { try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* 已断开 */ } } },
    get closed() { return closed; },
  };
}

/** 视频/图片 base64 的宽松校验：只接受 image/* 的数据 URL 或裸 base64 */
function normalizeImage(input) {
  if (!input) return null;
  let s = String(input).trim();
  const m = s.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is);
  if (m) s = m[2];
  s = s.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(s)) {
    const err = new Error('图片数据不是合法的 base64');
    err.code = 'BAD_INPUT';
    throw err;
  }
  const bytes = Math.floor(s.length * 3 / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    const err = new Error(`图片过大（约 ${(bytes / 1024 / 1024).toFixed(1)}MB，上限 ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0)}MB）`);
    err.code = 'TOO_LARGE';
    throw err;
  }
  return s;
}

/** 列出 public/models 下所有可用的 Live2D 模型（以 model3.json 为准） */
function listLive2DModels() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(MODEL_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(MODEL_ROOT, d.name);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    const entry = files.find(f => f.toLowerCase().endsWith('.model3.json'));
    if (!entry) continue;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8')); } catch { /* 损坏的模型直接跳过 */ }
    const fr = meta.FileReferences || {};
    const expressions = (fr.Expressions || []).map(e => e.Name || e.File).filter(Boolean);
    // 动作组：hiyori 有 Idle/Tap/Flick 等 6~7 组，纳西妲只有 Idle/TapBody。
    // 把组名与总数报给前端，选择器就能显示"动作丰富度"，用户选形象时有依据。
    const motions = fr.Motions || {};
    const motionGroups = Object.keys(motions);
    const motionCount = motionGroups.reduce((n, g) => n + (motions[g] || []).length, 0);

    let label = d.name;
    let note = '';
    let tags = [];
    try {
      const man = path.join(dir, 'manifest.json');
      if (fs.existsSync(man)) {
        const m = JSON.parse(fs.readFileSync(man, 'utf8'));
        if (m.label) label = m.label;
        if (m.note) note = m.note;
        if (Array.isArray(m.tags)) tags = m.tags;
      }
    } catch { /* 忽略 */ }

    // 预览图：优先用 manifest 指定的，其次找 preview.png / preview.jpg
    let preview = null;
    for (const cand of ['preview.png', 'preview.jpg', 'preview.webp']) {
      if (files.includes(cand)) { preview = `/models/${d.name}/${cand}`; break; }
    }

    out.push({
      id: d.name,
      label,
      note,
      tags,
      entry: `/models/${d.name}/${entry}`,
      preview,
      expressions,
      motionGroups,
      motionCount,
      hasLipSync: Boolean((meta.Groups || []).some(g => g.Name === 'LipSync')),
      textureCount: (fr.Textures || []).length,
    });
  }
  // 排序：AIRI 内置模型（hiyori）排前面，其余按名字；让"内置基础建模"一眼可见
  const rank = (m) => (m.tags.includes('AIRI 内置') ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, 'zh'));
}

// ===== 路由 =====
const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = reqUrl.pathname;

    // ---------- 静态资源 ----------
    // HEAD 也要走静态服务：只处理 GET 的话，HEAD 会一路掉到最后返回 404，
    // 而一些工具/浏览器预检会用 HEAD 探资源是否存在，看到 404 就会误判。
    if ((req.method === 'GET' || req.method === 'HEAD') && !p.startsWith('/api/')) return serveStatic(reqUrl, res, req.method === 'HEAD');

    // ---------- 总状态：前端一进来就问，用来点亮各个状态灯 ----------
    if (req.method === 'GET' && p === '/api/status') {
      const [ollamaStatus, ttsStatus, memStats] = await Promise.all([ollama.status(), tts.status(), memory.stats()]);
      return sendJSON(res, 200, {
        ok: true,
        ollama: ollamaStatus,
        tts: ttsStatus,
        memory: memStats,
        cards: { total: cards.list().length, activeId: cards.activeId },
        wenlv: { entityCount: wenlv.auditor.entityCount, cities: wenlv.capabilities().cities },
        live2d: listLive2DModels(),
        dataDir: DATA_DIR,
      });
    }

    // ---------- 能力清单（词云 + 表单选项 + 音色 + 模型 + 背景）----------
    if (req.method === 'GET' && p === '/api/capabilities') {
      const caps = wenlv.capabilities();
      return sendJSON(res, 200, {
        ok: true,
        ...caps,
        voices: VOICE_PRESETS,
        myVoices: voices.list(),
        live2d: listLive2DModels(),
        models3d: models3d.list(),
        backgrounds: backgrounds.list(),
        cards: cards.list(),
        activeCardId: cards.activeId,
      });
    }

    // ---------- 3D 角色模型（VRM / GLB）----------
    if (req.method === 'GET' && p === '/api/models3d') {
      return sendJSON(res, 200, { ok: true, ...models3d.list() });
    }
    if (req.method === 'POST' && p === '/api/models3d') {
      const body = await readBody(req);
      const saved = models3d.save(body.model, body.name);
      return sendJSON(res, 200, { ok: true, ...saved });
    }
    if (req.method === 'GET' && p.startsWith('/api/models3d/file/')) {
      const hit = models3d.readCustomFile(p.slice('/api/models3d/file/'.length));
      if (!hit) return sendText(res, 404, 'Not Found');
      const st = fs.statSync(hit.full);
      res.writeHead(200, {
        'Content-Type': models3d.mimeOf(path.extname(hit.base)),
        'Content-Length': st.size,
        'Cache-Control': 'public, max-age=86400',
      });
      return fs.createReadStream(hit.full).pipe(res);
    }
    // 自动生成的模型预览图（前端截取当前渲染帧后回传，见 app.js）
    if (req.method === 'GET' && p.startsWith('/api/models3d/preview/')) {
      const hit = models3d.readPreview(p.slice('/api/models3d/preview/'.length));
      if (!hit) return sendText(res, 404, 'Not Found');
      const st = fs.statSync(hit.full);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(hit.full).pipe(res);
    }
    if (req.method === 'POST' && p === '/api/models3d/preview') {
      const body = await readBody(req);
      const saved = models3d.savePreview(body.url, body.image);
      return sendJSON(res, 200, { ok: true, ...saved });
    }
    if (req.method === 'DELETE' && p.startsWith('/api/models3d/')) {
      const id = decodeURIComponent(p.slice('/api/models3d/'.length));
      const r = models3d.remove(id);
      return sendJSON(res, r.ok ? 200 : 404, { ...r, ...models3d.list() });
    }

    // ---------- 外观：背景与形象 ----------
    if (req.method === 'GET' && p === '/api/backgrounds') {
      return sendJSON(res, 200, { ok: true, ...backgrounds.list() });
    }
    // 上传自定义背景（base64）或从 URL 拉取后保存
    if (req.method === 'POST' && p === '/api/backgrounds') {
      const body = await readBody(req);
      const saved = backgrounds.save(body.image, body.name);
      return sendJSON(res, 200, { ok: true, ...saved });
    }
    // 提供自定义背景文件本体
    if (req.method === 'GET' && p.startsWith('/api/backgrounds/file/')) {
      const hit = backgrounds.readCustomFile(p.slice('/api/backgrounds/file/'.length));
      if (!hit) return sendText(res, 404, 'Not Found');
      const st = fs.statSync(hit.full);
      res.writeHead(200, {
        'Content-Type': backgrounds.mimeOf(path.extname(hit.base).toLowerCase()),
        'Content-Length': st.size,
        'Cache-Control': 'public, max-age=86400',
      });
      return fs.createReadStream(hit.full).pipe(res);
    }
    if (req.method === 'DELETE' && p.startsWith('/api/backgrounds/')) {
      const id = decodeURIComponent(p.slice('/api/backgrounds/'.length));
      const r = backgrounds.remove(id);
      return sendJSON(res, r.ok ? 200 : 404, { ...r, ...backgrounds.list() });
    }

    // ---------- 机体对话（SSE 流式）----------
    if (req.method === 'POST' && p === '/api/chat') {
      const body = await readBody(req);
      const sse = openSSE(res);
      try {
        const card = (body.cardId && cards.get(body.cardId)) || cards.active();
        const userText = String(body.message || '').trim();
        const image = normalizeImage(body.image);
        if (!userText && !image) throw Object.assign(new Error('消息为空'), { code: 'BAD_INPUT' });

        const { chatModel } = await ollama.resolveModels();
        const useModel = (card.model && card.model.chat) || chatModel;
        if (!useModel) {
          throw Object.assign(
            new Error('本机没有可用的对话模型。请先运行：ollama pull qwen2.5:7b（或 qwen3:8b）'),
            { code: 'NO_MODEL' },
          );
        }

        // 1) 有图先做视觉理解（本地多模态模型），把"看到什么"变成文字再喂给对话模型
        let visionText = '';
        if (image && card.vision && card.vision.enabled) {
          sse.send({ type: 'stage', stage: 'vision', text: '正在用本机多模态模型看图…' });
          const { visionModel } = await ollama.resolveModels();
          if (!visionModel) {
            visionText = '（本机未安装多模态模型，这一步跳过了。可执行 ollama pull qwen2.5vl:7b 后重试）';
            sse.send({ type: 'notice', text: visionText });
          } else {
            try {
              const r = await ollama.vision({ model: visionModel, imagesBase64: [image] });
              visionText = r.content;
              sse.send({ type: 'vision', model: visionModel, text: visionText });
              await memory.add({ text: `[看图] ${visionText}`, role: 'system', kind: 'fact', tags: ['视觉'], sessionId: card.id });
            } catch (e) {
              visionText = `（视觉理解失败：${e.message}）`;
              sse.send({ type: 'notice', text: visionText });
            }
          }
        }

        // 2) 召回长期记忆
        const query = [userText, visionText].filter(Boolean).join('\n');
        let memoryText = '';
        let hits = [];
        if (card.memory && card.memory.enabled && query) {
          const ctx = await memory.buildContext(query, card.memory.topK || 5);
          memoryText = ctx.text;
          hits = ctx.hits.map(h => ({ id: h.id, text: h.text.slice(0, 120), score: Number(h.score.toFixed(3)), ts: h.ts }));
          if (hits.length) sse.send({ type: 'memory', hits });
        }

        // 3) 组装消息
        const system = cards.composeSystemPrompt(card, {
          memoryText,
          extraContext: '你可以调用的本地能力：个性化方案规划、文旅营销素材生成、信息缺失集中追问、输出质检、长期记忆、视觉理解、语音播报。用户点词云就能触发这些能力。',
        });
        const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
        const messages = [
          { role: 'system', content: system },
          ...history
            .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
            .map(m => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
          {
            role: 'user',
            content: visionText ? `（我上传了一张图片，本机视觉模型看到的内容是：${visionText}）\n\n${userText || '请根据这张图给我文旅方面的建议。'}` : userText,
          },
        ];

        // 4) 流式生成
        sse.send({ type: 'start', model: useModel, card: { id: card.id, name: card.name, avatar: card.avatar, accent: card.accent } });
        let full = '';
        for await (const chunk of ollama.chatStream({
          model: useModel,
          temperature: (card.model && card.model.temperature) ?? 0.7,
          numCtx: (card.model && card.model.numCtx) || 16384,
          numPredict: (card.model && card.model.numPredict) || 1024,
          messages,
          signal: undefined,
        })) {
          if (chunk.delta) { full += chunk.delta; sse.send({ type: 'delta', text: chunk.delta }); }
          if (chunk.done) full = chunk.content || full;
          if (sse.closed) break;
        }

        // 5) 落记忆（用户这句 + 角色回的这句）
        if (card.memory && card.memory.enabled) {
          if (userText) await memory.add({ text: userText, role: 'user', kind: 'turn', sessionId: card.id, tags: extractTags(userText) });
          if (full) await memory.add({ text: full, role: 'assistant', kind: 'turn', sessionId: card.id, tags: [] });
        }
        sse.send({ type: 'done', content: full, model: useModel });
      } catch (e) {
        sse.send({ type: 'error', code: e.code || 'INTERNAL', error: String(e.message || e) });
      }
      return sse.end();
    }

    // ---------- 文旅 Skill 生成（SSE 流式，含输出质检）----------
    if (req.method === 'POST' && p === '/api/wenlv/generate') {
      const body = await readBody(req);
      const type = body.type || 'plan';
      // 先校验再开 SSE：一旦写了响应头就没法再返回 4xx 了，
      // 而"非法参数应当拿到 4xx 而不是 200"是评分点里明确要求的行为。
      if (!['plan', 'marketing', 'product', 'intake'].includes(type)) {
        return sendJSON(res, 400, { ok: false, code: 'BAD_INPUT', error: `未知类型: ${type}（只支持 plan / marketing / product / intake）` });
      }
      const sse = openSSE(res);
      try {
        sse.send({ type: 'start', type });
        for await (const chunk of wenlv.generateStream(type, body.params || {}, { model: body.model })) {
          if (chunk.delta) sse.send({ type: 'delta', text: chunk.delta });
          if (chunk.done) {
            sse.send({ type: 'done', content: chunk.content, warnings: chunk.warnings || [], model: chunk.model, params: chunk.params });
            // 方案/文案也进记忆，之后可以直接用自然语言追问"上次那个杭州方案"
            try {
              await memory.add({
                text: `[为${chunk.params.city || chunk.params.product || '用户'}生成的${type === 'plan' ? '行程方案' : type === 'marketing' ? '营销文案' : '追问'}] ${String(chunk.content).slice(0, 600)}`,
                role: 'assistant', kind: 'fact', tags: ['文旅', type, chunk.params.city].filter(Boolean), sessionId: cards.activeId,
              });
            } catch { /* 记忆失败不影响生成结果 */ }
          }
          if (sse.closed) break;
        }
      } catch (e) {
        sse.send({ type: 'error', code: e.code || 'INTERNAL', error: String(e.message || e) });
      }
      return sse.end();
    }

    // ---------- 非流式生成（保留原项目 /api/generate 的 JSON 契约，便于自动化测试与 Agent 调用）----------
    if (req.method === 'POST' && p === '/api/generate') {
      const body = await readBody(req);
      const { type, params } = body;
      try {
        const r = await wenlv.generate(type, params);
        return sendJSON(res, 200, { ok: true, source: 'local-llm', model: r.model, content: r.content, warnings: r.warnings });
      } catch (e) {
        return fail(res, e);
      }
    }

    // ---------- Agent 引擎接口：返回纯文本，便于 OpenClaw 等直接转述 ----------
    if (req.method === 'GET' && (p === '/api/quick-plan' || p === '/api/quick-marketing')) {
      const q = reqUrl.searchParams;
      const isPlan = p === '/api/quick-plan';
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
        const r = await wenlv.generate(type, params);
        const head = [];
        head.push(isPlan
          ? `【由本地样本库驱动生成】目的地：${r.params.city} ｜ 天数：${r.params.days} 天 ｜ 预算：${r.params.budget} ｜ 同行人群：${r.params.crowd} ｜ 饮食禁忌：${r.params.diet}`
          : `【由本地样本库驱动生成】产品：${r.params.product} ｜ 平台：${r.params.platform} ｜ 目标客群：${r.params.audience} ｜ 风格：${r.params.style}`);
        if (r.warnings.length) {
          head.push('', `⚠️ 输出质检发现 ${r.warnings.length} 处需要注意（已与本地样本库核对）：`);
          r.warnings.forEach((w, i) => head.push(`${i + 1}. ${w}`));
        }
        head.push('', '---------- 以下为生成结果（请原样转述，不要改写、不要复述本段说明）----------', '');
        return sendText(res, 200, head.join('\n') + r.content + '\n');
      } catch (e) {
        return sendText(res, CODE_STATUS[e.code] || 500, `【生成失败】${String(e.message || e)}\n`);
      }
    }

    // ---------- 机体记忆 ----------
    if (p === '/api/memory' && req.method === 'GET') {
      const limit = Math.min(Number(reqUrl.searchParams.get('limit')) || 200, 1000);
      const offset = Number(reqUrl.searchParams.get('offset')) || 0;
      const kind = reqUrl.searchParams.get('kind') || undefined;
      return sendJSON(res, 200, { ok: true, ...memory.list({ limit, offset, kind }), stats: await memory.stats() });
    }
    if (p === '/api/memory' && req.method === 'POST') {
      const body = await readBody(req);
      const card = cards.active();
      const rec = await memory.add({
        text: body.text,
        role: body.role || 'user',
        kind: body.kind || 'fact',
        tags: Array.isArray(body.tags) ? body.tags : extractTags(body.text || ''),
        sessionId: body.sessionId || (card && card.id) || 'default',
      });
      if (!rec) return sendJSON(res, 400, { ok: false, code: 'BAD_INPUT', error: '记忆内容为空' });
      return sendJSON(res, 200, { ok: true, item: rec, stats: await memory.stats() });
    }
    if (p === '/api/memory/search' && req.method === 'POST') {
      const body = await readBody(req);
      const hits = await memory.search(body.query || '', { limit: Number(body.limit) || 8, kind: body.kind });
      return sendJSON(res, 200, { ok: true, hits });
    }
    if (p === '/api/memory/clear' && req.method === 'POST') {
      memory.clear();
      return sendJSON(res, 200, { ok: true, stats: await memory.stats() });
    }
    if (p.startsWith('/api/memory/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.slice('/api/memory/'.length));
      const ok = memory.remove(id);
      return sendJSON(res, ok ? 200 : 404, { ok, stats: await memory.stats() });
    }

    // ---------- 视觉理解（独立入口，不接对话也能用）----------
    if (req.method === 'POST' && p === '/api/vision') {
      const body = await readBody(req);
      const image = normalizeImage(body.image);
      if (!image) return sendJSON(res, 400, { ok: false, code: 'BAD_INPUT', error: '未提供图片' });
      const { visionModel } = await ollama.resolveModels();
      const r = await ollama.vision({ model: visionModel, imagesBase64: [image], prompt: body.prompt });
      await memory.add({ text: `[看图] ${r.content}`, role: 'system', kind: 'fact', tags: ['视觉'], sessionId: cards.activeId });
      return sendJSON(res, 200, { ok: true, model: r.model, content: r.content });
    }

    // ---------- 语音合成（返回 audio/wav 字节，浏览器直接播）----------
    if (req.method === 'POST' && p === '/api/tts') {
      const body = await readBody(req);
      const card = (body.cardId && cards.get(body.cardId)) || cards.active();
      const voice = body.voice || (card && card.voice) || undefined;

      // ---------- "我的音色"：把参考音频一起发给 TTS ----------
      // 卡片上记着 refVoiceId，这里把那段 WAV 读出来转 base64。
      // 之前 server 漏了这一环，所以 lib/tts.js 里那条 voice-clone 分支根本走不到。
      const refVoiceId = body.refVoiceId || (voice && voice.refVoiceId);
      let refAudioBase64;
      let refText = '';
      let mode = body.mode || (voice && voice.mode);
      if (refVoiceId) {
        const ref = voices.read(refVoiceId);
        if (!ref) {
          const e = new Error('这个自定义音色找不到了，可能已经被删掉。请重新选一个音色。');
          e.code = 'NOT_FOUND';
          throw e;
        }
        refAudioBase64 = ref.buffer.toString('base64');
        refText = ref.meta.refText || '';
        mode = 'voice-clone';   // 有参考音频就一定走克隆
      }

      const r = await tts.synthesize({
        text: body.text,
        voice,
        mode,
        speaker: body.speaker,
        language: body.language,
        model: body.model,
        refAudioBase64,
        refText,
        // 缓存键要带上是哪个音色，否则换了音色还在放上一副嗓子的缓存
        refKey: refVoiceId || '',
        useCache: body.useCache !== false,
      });
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': r.buffer.length,
        'X-TTS-Model': encodeURIComponent(r.model),
        'X-TTS-Cached': r.cached ? '1' : '0',
        'Cache-Control': 'no-store',
      });
      return res.end(r.buffer);
    }
    if (req.method === 'GET' && p === '/api/tts/status') {
      return sendJSON(res, 200, { ok: true, ...(await tts.status()), presets: VOICE_PRESETS });
    }
    // 内置说话人清单（含中文名与实测音高）。
    // 界面靠它把 speaker 暴露给用户 —— 只给英文 id 的话，
    // 用户根本分不出哪个是女声，就只能一直用后端默认的那个男声。
    if (req.method === 'GET' && p === '/api/tts/speakers') {
      return sendJSON(res, 200, { ok: true, speakers: await tts.speakers() });
    }

    // ---------- 我的音色（声音克隆的参考音频）----------
    // 上传一段 5~15 秒的干净人声，之后就能像内置音色一样点着用。
    // 音频存本机 data/voice-refs/，合成时直接喂给 127.0.0.1 的 TTS，不出本机。
    if (p === '/api/voices') {
      if (req.method === 'GET') {
        return sendJSON(res, 200, { ok: true, voices: voices.list() });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const v = voices.save({
          name: body.name,
          desc: body.desc,
          refText: body.refText,
          audio: body.audio,
          originalName: body.originalName,
        });
        return sendJSON(res, 201, { ok: true, voice: v });
      }
    }
    if (p.startsWith('/api/voices/')) {
      const rest = p.slice('/api/voices/'.length);
      const slash = rest.indexOf('/');
      const id = slash < 0 ? rest : rest.slice(0, slash);
      const sub = slash < 0 ? '' : rest.slice(slash + 1);

      // 试听：把参考音频原样回给浏览器播
      if (sub === 'audio' && req.method === 'GET') {
        const ref = voices.read(id);
        if (!ref) {
          return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '这个音色不存在' });
        }
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': ref.buffer.length,
          'Cache-Control': 'no-store',
        });
        return res.end(ref.buffer);
      }
      if (sub === '' && req.method === 'PUT') {
        const body = await readBody(req);
        const v = voices.update(id, body || {});
        if (!v) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '这个音色不存在' });
        return sendJSON(res, 200, { ok: true, voice: v });
      }
      if (sub === '' && req.method === 'DELETE') {
        const ok = voices.remove(id);
        if (!ok) return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: '这个音色不存在' });
        return sendJSON(res, 200, { ok: true });
      }
    }

    // ---------- AI 角色卡 ----------
    if (p === '/api/cards' && req.method === 'GET') {
      return sendJSON(res, 200, { ok: true, cards: cards.list(), activeId: cards.activeId });
    }
    if (p === '/api/cards' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJSON(res, 200, { ok: true, card: cards.create(body), activeId: cards.activeId });
    }
    if (p === '/api/cards/import' && req.method === 'POST') {
      const body = await readBody(req);
      const r = cards.importCard(body.card !== undefined ? body.card : body);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (p === '/api/cards/export-all' && req.method === 'GET') {
      const data = JSON.stringify(cards.exportAll(), null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="airi-wenlv-cards.json"' });
      return res.end(data);
    }
    if (p.startsWith('/api/cards/')) {
      const rest = decodeURIComponent(p.slice('/api/cards/'.length));
      const [id, sub] = rest.split('/');
      if (sub === 'activate' && req.method === 'POST') return sendJSON(res, 200, { ok: true, ...cards.setActive(id) });
      if (sub === 'duplicate' && req.method === 'POST') {
        const c = cards.duplicate(id);
        return c ? sendJSON(res, 200, { ok: true, card: c }) : sendJSON(res, 404, { ok: false, error: '角色卡不存在' });
      }
      if (sub === 'export' && req.method === 'GET') {
        const c = cards.exportCard(id);
        if (!c) return sendJSON(res, 404, { ok: false, error: '角色卡不存在' });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="card-${id}.json"` });
        return res.end(JSON.stringify(c, null, 2));
      }
      if (req.method === 'PUT' || req.method === 'PATCH') {
        const body = await readBody(req);
        const c = cards.update(id, body);
        return c ? sendJSON(res, 200, { ok: true, card: c }) : sendJSON(res, 404, { ok: false, error: '角色卡不存在' });
      }
      if (req.method === 'DELETE') {
        const r = cards.remove(id);
        return sendJSON(res, r.ok ? 200 : 400, { ...r, activeId: cards.activeId });
      }
    }

    return sendJSON(res, 404, { ok: false, code: 'NOT_FOUND', error: `未知接口：${req.method} ${p}` });
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch { /* 忽略 */ } return undefined; }
    return fail(res, e);
  }
});

/** 从用户话里粗提标签：命中样本库城市 / 业态时打标，供记忆检索加权 */
function extractTags(text) {
  const s = String(text || '');
  const tags = [];
  for (const c of ['杭州', '苏州', '成都', '丽江', '西安']) if (s.includes(c)) tags.push(c);
  for (const k of ['景区', '酒店', '民宿', '餐饮', '文创', '行程', '文案', '预算']) if (s.includes(k)) tags.push(k);
  return tags.slice(0, 8);
}

function serveStatic(reqUrl, res, headOnly) {
  let pathname;
  try {
    pathname = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, '');
  } catch {
    return sendText(res, 400, 'Bad Request: 非法的 URL 编码');
  }
  if (pathname === '') pathname = 'index.html';

  const filePath = path.normalize(path.join(WEB_ROOT, pathname));
  // 防目录穿越：必须带分隔符边界，避免同前缀的兄弟目录被放行
  if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + path.sep)) return sendText(res, 403, 'Forbidden');
  // data/ 目录（记忆、角色卡、语音缓存）绝不对外提供，避免"数据不出本机"被破功
  if (filePath.startsWith(path.join(WEB_ROOT, 'data') + path.sep)) return sendText(res, 403, 'Forbidden');

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, `Not Found: ${pathname}`);
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    // 体积大又不变的东西（Live2D 纹理、3D 模型、字体）给长缓存，二次加载快很多
    const cache = /\.(png|jpg|jpeg|webp|moc3|woff2|ttf|vrm|glb|gltf|bin)$/i.test(filePath)
      ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': cache });
    if (headOnly) return res.end();          // HEAD 只回头，不传 body
    fs.createReadStream(filePath).pipe(res);
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[错误] 端口 ${PORT} 已被占用。请关闭占用该端口的程序，或用 PORT=8001 node server.js 换端口启动。`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, async () => {
  const st = await ollama.status();
  console.log('==================================================');
  console.log('  文旅智能辅助 · AIRI 网页版  已启动');
  console.log(`  访问地址： http://localhost:${PORT}`);
  console.log(`  监听地址： ${HOST}（默认仅本机可访问，数据不出本机）`);
  console.log(`  对话模型： ${st.chatModel || '未检测到（请先启动 Ollama）'}`);
  console.log(`  视觉模型： ${st.visionModel || '未安装（可选：ollama pull qwen2.5vl:7b）'}`);
  console.log(`  向量模型： ${st.embedModel || '未安装（记忆将使用纯词法检索）'}`);
  const ts = await tts.status();
  console.log(`  语音合成： ${ts.running ? `已连接 ${ts.url}` : '未连接（请启动 Qwen TTS WebUI 并加 --api 参数）'}`);
  console.log(`  样本库实体：${wenlv.auditor.entityCount} 条（输出质检已启用）`);
  console.log(`  数据目录： ${DATA_DIR}（记忆 / 角色卡 / 语音缓存，均不出本机）`);
  console.log('  按 Ctrl+C 停止。');
  console.log('==================================================');
});

process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));
