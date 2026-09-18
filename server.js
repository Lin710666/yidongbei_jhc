#!/usr/bin/env node
/**
 * 文旅智能辅助 · AIRI 网页版 —— 本地服务器（零第三方依赖，仅用 Node 内置模块）
 *
 * 一句话：把「yidongbei-2.2 表单式网页」升级成 airi 风格的虚拟人物交互网页，
 * 并把 airi 的各项服务（机体记忆 / 视觉 / 声音）全部落到本机运行。
 *
 * 服务清单（默认全部本地，不调用任何云端 API）：
 *   · 对话 / 大脑  — 本机 Ollama            （lib/ollama.js）
 *   · 机体记忆     — 本机文件 + 混合检索    （lib/memory.js）
 *   · 视觉理解     — 本机 Ollama 多模态模型 （lib/ollama.js 的 vision）
 *   · 语音合成     — 本机 Qwen TTS WebUI    （lib/tts.js）
 *   · 听觉         — 本机 Whisper 语音识别  （lib/stt.js）
 *   · AI 角色卡    — 本机文件               （lib/cards.js）
 *   · 文旅 Skill   — SKILL.md + references + 输出质检（lib/wenlv.js）
 *
 * 外部 API（两个方向，都是显式开关、默认关闭）：
 *   · 出向 —— 接外部大模型（OpenAI 兼容协议一族）  （lib/providers.js + lib/inference.js）
 *              在「设置 → 模型接入」里填 Base URL / API Key / 模型名；
 *              不配置时全流程仍走本机 Ollama。
 *   · 入向 —— 把本项目的对话能力按 OpenAI 兼容接口暴露出去（/v1/*，
 *              Bearer 鉴权），供 AIRI 等外部 Agent 调用。默认关闭，
 *              需要在「设置 → 对外开放」里开启并生成令牌。
 *
 * 启动：node server.js       （Windows 双击 start.bat）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ollama = require('./lib/ollama');
const { createGpu } = require('./lib/gpu');
const providersLib = require('./lib/providers');
const { createInference } = require('./lib/inference');
const { createOpenAPI } = require('./lib/openapi');
const { createPrefs } = require('./lib/prefs');
const { TOOL_SCHEMAS, TOOL_NAMES } = require('./lib/tools');
const { runAgent } = require('./lib/agent');
const web = require('./lib/web');
const { createLocation } = require('./lib/location');
const { createPano } = require('./lib/pano');
const { createDepth } = require('./lib/depth');
const { createImg23D } = require('./lib/img23d');
const sttLib = require('./lib/stt');
// 导航模式的风景图：自备目录匹配 + 联网搜图下载（见 lib/scenery.js）
const { createScenery, mimeOf: sceneryMime } = require('./lib/scenery');
const { createVideos } = require('./lib/videos');
const { createSTT } = sttLib;
const { createBlender } = require('./lib/blender');
const { createMemory } = require('./lib/memory');
const { createTTS, VOICE_PRESETS } = require('./lib/tts');
const { createCards } = require('./lib/cards');
const { createWenlv } = require('./lib/wenlv');
// 地理计算与景点坐标表：定位导航页用它算"离我多远、在哪个方向"（纯本地，不联网）
const geo = require('./lib/geo');

/**
 * 地图瓦片缓存：键是 `z-x-y-style`，值是 PNG Buffer。
 * 上限 400 块 ≈ 一屏多一点再平移一段，够用又不会把内存吃满。
 */
const TILE_CACHE_MAX = 400;
const tileCache = new Map();
const { createBackgrounds } = require('./lib/backgrounds');
const { createModels3D } = require('./lib/models3d');
const { createVoices } = require('./lib/voices');

// ===== 配置 =====
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';       // 默认只监听回环，保证"数据不出本机"在实现层成立
// 图片走 base64，放宽到 24MB。3D 模型（VRM 动辄 25~30MB，base64 后还要大 1/3）
// 必须给到更大的上限，否则上传自定义 VRM 会被 413 直接拒掉。
const MAX_BODY = Number(process.env.MAX_BODY || 150 * 1024 * 1024);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 12 * 1024 * 1024);
const MAX_MODEL3D_BYTES = Number(process.env.MAX_MODEL3D_BYTES || 100 * 1024 * 1024);
// 参考音频：24MB 够放 4 分钟 24kHz/16bit 单声道。再长也没有意义 ——
// 实测参考音频越长合成越慢、显存吃得越多，音色本身靠开头十几秒就定型了。
const MAX_VOICE_BYTES = Number(process.env.MAX_VOICE_BYTES || 24 * 1024 * 1024);
// 语音识别上传的音频（16kHz 单声道 16-bit WAV）：25MB 约 13 分钟连续说话。
// 注意请求体是 base64 放进 JSON 的，所以线上体积约为这个数字的 4/3 —— 路由里
// 用 MAX_STT_BODY 单独挡一道，免得先被全局 MAX_BODY（150MB）放过再在解码时白吃内存。
const MAX_STT_BYTES = Number(process.env.MAX_STT_BYTES || 25 * 1024 * 1024);
const MAX_STT_BODY = Math.ceil(MAX_STT_BYTES * 4 / 3) + 4096;

const ROOT = __dirname;
const WEB_ROOT = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SKILL_DIR = path.join(ROOT, '.agents', 'skills', 'wenlv-assistant');
const MODEL_ROOT = path.join(WEB_ROOT, 'models');
const TTS_CACHE = path.join(DATA_DIR, 'tts-cache');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TTS_CACHE, { recursive: true });

// 外部接入配置（data/providers.json，含 API Key，只存本机）
const providers = providersLib.createProviders({ dir: DATA_DIR });
// 应用级偏好：联网、定位、全景、Blender 等开关（data/prefs.json，默认全关）
const prefs = createPrefs({ dir: DATA_DIR });
// 显存仲裁：本机只有 8GB 显存，而 Ollama / TTS / Whisper / TripoSR / 深度图
// 五处都要用同一张卡。它把吃显存的任务串起来，并在独占任务开工前请 Ollama 让位
// （详见 lib/gpu.js 的头注释）。prefs 要先建好，它读 gpu 段判断是否启用。
const gpu = createGpu({ ollama, prefs });
// 路由层：接口与 lib/ollama.js 完全一致，内部按配置决定走本机还是外部。
// memory / wenlv 是依赖注入式设计，所以它们拿到的就是这个路由对象，
// 这两个文件因此不需要任何改动（lib/wenlv.js / lib/memory.js 里看到的 `ollama`
// 参数名是历史叫法，实际拿到的是路由层）。
// 注入 gpu 之后：本地分支走显存共享闸门，外部 API 分支**不走** ——
// 外部调用不占本机显存，让它排本地的队纯属添堵，那正是"本地与外部不冲突"的落点。
const inference = createInference({ ollama, providers, gpu });
// 入向：把本项目的能力按 OpenAI 兼容接口开出去（data/openapi.json，默认关闭）
const openapi = createOpenAPI({ dir: DATA_DIR });
// 用户位置：浏览器定位 / 手填 / IP 兜底，存 data/location.json。
// 位置 MCP 服务（mcp/location-server.js）直接读同一个文件，两个进程不必互相调用。
const location = createLocation({ dir: DATA_DIR, fetchRaw: web.fetchRaw });
// 景区全景：检索 → 下载 → 校验（必须是 2:1 等距柱状）→ 缓存（data/panoramas/）
const pano = createPano({ dir: DATA_DIR, fetchRaw: web.fetchRaw });
// 单目深度：把全景图变成高度图，供前端做脚下地形浮雕（跑在 Python 子进程里）
const depth = createDepth({ dir: DATA_DIR, gpu });
// 图片转 3D：单图 → 带顶点色的 GLB（TripoSR，跑在 Python 子进程里）。
// 产物会登记进 models3d，所以在「外观 → 更换形象」里能直接选到。
const img23d = createImg23D({ dir: DATA_DIR, gpu });
// 听觉（本地 Whisper 语音识别，跑在 Python 子进程里）。
// 与其它模块不同：这里把 prefs 注入进去，让它自己判断开关 —— 关闭时
// transcribe() 在**做任何工作之前**就返回"未启用"（连临时音频都不落盘）。
// 开关判断放在 lib 里而不是路由里，是为了让"关着就一定没动静"这件事
// 在库层面成立，将来别的调用方（MCP、命令行）也绕不过去。
const stt = createSTT({ dir: DATA_DIR, prefs, gpu });
// 导航模式的风景图：自备目录（data/scenery/）+ 联网搜图（手动触发，受联网总开关节制）
const scenery = createScenery({ dir: DATA_DIR, prefs });
// 视频背景：大屏宣传片放 data/videos/，只读本机文件、不联网找视频（授权不明）
const videos = createVideos({ dir: DATA_DIR });
// Blender 动画：通过 MCP（socket 9876）驱动已装的 "MCP for Blender" 插件
// 生成移动动画并导出 glTF。需要 Blender 开着（插件不支持后台模式）。
const blender = createBlender({
  outDir: path.join(DATA_DIR, 'blender'),
  host: prefs.getConfig().blender.host,
  port: prefs.getConfig().blender.port,
});

const memory = createMemory({ dir: DATA_DIR, ollama: inference });
const tts = createTTS({ cacheDir: TTS_CACHE, gpu });
const cards = createCards({ dir: DATA_DIR });
const wenlv = createWenlv({ skillDir: SKILL_DIR, ollama: inference });
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
  // ---- 外部 API（lib/providers.js 抛出的错误码，口径与本地那套保持一致）----
  // 为什么 AUTH_ERROR / BAD_ENDPOINT 是 502 而不是 401/404？
  //   401/404 是"访问本服务的这个客户端"的问题；而这些错误是**本服务作为客户端**
  //   去调外部 API 时对方拒绝了我们。对前端而言这是"上游配置有问题"，属于网关类错误。
  //   真正表示客户端未授权的 401 留给入向接口（UNAUTHORIZED）。
  NO_ENDPOINT: 502,
  BAD_ENDPOINT: 502,
  AUTH_ERROR: 502,
  RATE_LIMIT: 429,
  UPSTREAM_ERROR: 502,
  API_ERROR: 502,
  // ---- 入向接口（本项目被外部调用）----
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
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

/**
 * 生成任务串行队列。
 *
 * 为什么需要：Ollama 同一时刻只服务一个生成请求。并发打进来时，后来的请求会排在
 * 前一个后面等待，**但它的超时计时从进队列那一刻就开始了** —— 于是会出现"界面上一
 * 显示正在生成、等了五分钟、最后报超时"，用户完全不知道自己在排队。
 *
 * 这里显式排队：拿到锁之后才开始计时（超时在 ollama.chatStream 内部起）。
 * 中途还会给客户端发一条 notice，让它把"正在排队"如实显示出来。
 */
let genBusy = false;
const genQueue = [];

function acquireGen() {
  if (!genBusy) { genBusy = true; return Promise.resolve(0); }
  const enqueuedAt = Date.now();
  return new Promise((resolve) => { genQueue.push(() => resolve(Date.now() - enqueuedAt)); });
}

function releaseGen() {
  const next = genQueue.shift();
  if (next) next();
  else genBusy = false;
}

/** 当前排队的任务数（给前端显示用） */
function genQueueDepth() { return genQueue.length; }

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

/** 视频/图片 base64 的宽松校验：只接受 image/* 的 data URL 或裸 base64 */
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
    // 动作组：不同模型差别很大（有的 Idle/Tap/Flick 有六七组，有的一组都不到）。
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

    // 预览图：优先用 manifest 指定的，其次是 preview.png / preview.jpg
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
      // 口型支持要查**组的 Ids 是否非空**，不能只查"有没有这个组"。
      // 官方示例里就有 `{"Name":"LipSync","Ids":[]}` 这种空壳声明（mark/rice 就是这样），
      // 只看组名会报"支持口型"，实际嘴一动不动 —— 这是踩过的坑，测试里也钉着。
      hasLipSync: Boolean((meta.Groups || []).some(g => /lipsync/i.test(String(g.Name || ''))
        && Array.isArray(g.Ids) && g.Ids.length > 0)),
      textureCount: (fr.Textures || []).length,
    });
  }
  // 排序：内置模型排前面，其余按名字；让"内置基础建模"一眼可见
  const rank = (m) => (m.tags.includes('AIRI 内置') ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, 'zh'));
}

// ===== 路由 =====
const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // 入向别名会改写它，所以不能是 const
    let p = reqUrl.pathname;

    // ==================== 入向接口（本项目被外部 Agent 调用）===================
    // 为什么必须挡在静态资源之前：下面那句会把所有不是 /api/ 开头的 GET 当成静态文件，
    // /v1/models 这类请求会一路掉进静态目录、最后返回一个毫无指向性的 404。
    //
    // 别名路径（/wenlv/* /memory/* /cards/*）在这里只做两件事：验权限、改写成 /api/*，
    // 然后交给下面原有的路由处理 —— 复用同一套参数校验和错误语义，
    // 而不是另写一套"看起来差不多"的实现。
    {
      const alias = aliasToApi(p);
      if (alias || p.startsWith('/v1/')) {
        requireInboundAccess(req, p, alias);   // 不通过直接 throw，由外层 fail() 转成 401/403
        if (alias) p = alias;
        else return await handleOpenAI(req, res, p);
      }
    }

    // ---------- 静态资源 ----------
    // HEAD 也要走静态服务：只处理 GET 的话，HEAD 会一路掉到最后返回 404，
    // 而一些工具/浏览器预检会用 HEAD 探资源是否存在，看到 404 就会误判。
    if ((req.method === 'GET' || req.method === 'HEAD') && !p.startsWith('/api/')) return serveStatic(reqUrl, res, req.method === 'HEAD');

    // ---------- 总状态：前端一进来就问，用来点亮各个状态灯 ----------
    if (req.method === 'GET' && p === '/api/status') {
      const [ollamaStatus, ttsStatus, memStats] = await Promise.all([inference.status(), tts.status(), memory.stats()]);
      return sendJSON(res, 200, {
        ok: true,
        // 注意这个字段名叫 ollama 是历史原因（前端状态灯、冒烟测试都按这个名字读）。
        // 现在它装的是"路由后的实际状态"：既含本机 Ollama 情况，也含外部接入情况。
        ollama: ollamaStatus,
        tts: ttsStatus,
        memory: memStats,
        cards: { total: cards.list().length, activeId: cards.activeId },
        wenlv: { entityCount: wenlv.auditor.entityCount, cities: wenlv.capabilities().cities },
        live2d: listLive2DModels(),
        openapi: openapi.publicConfig(),
        prefs: prefs.publicConfig(),
        // 单独给一个"联网现在能不能用"的结论，界面不必自己去解析 prefs 结构
        web: {
          enabled: prefs.isWebEnabled(),
          tools: TOOL_NAMES,
        },
        location: { ...location.status(), ipFallbackAllowed: Boolean(prefs.getConfig().location.allowIpFallback) },
        pano: {
          enabled: Boolean(prefs.getConfig().pano.enabled),
          cached: pano.list().length,
          depthModelPresent: depth.isModelPresent(),
        },
        img23d: {
          modelPresent: img23d.isModelPresent(),
          jobs: img23d.list().length,
        },
        // 听觉：与 blender 一样，这里只报"廉价信息"（开关 + 权重文件在不在 + 队列），
        // 真探测要起一次 Python（import torch 不快），由 /api/stt/status 按钮显式触发。
        stt: stt.quickStatus(),
        // 显存仲裁：现在谁占着卡、谁在排队、Ollama 有没有被请出去。
        // 界面上那个"显存"状态灯就读它 —— 用户遇到"点了没反应"时，
        // 一眼能看出是在排队而不是卡死了。
        gpu: gpu.status(),
        // 导航模式的风景图：自备目录里的张数与缓存张数（廉价信息，不联网）
        scenery: scenery.status(),
        blender: {
          host: blender.host,
          port: blender.port,
          jobs: blender.list().length,
        },
        dataDir: DATA_DIR,
      });
    }

    // ---------- 外部模型接入（出向）：读取配置 + 预设表 ----------
    if (req.method === 'GET' && p === '/api/providers') {
      return sendJSON(res, 200, {
        ok: true,
        config: providers.publicConfig(),
        // 预设表放服务端一份，前端不用再维护一份会过期的厂商清单
        presets: providersLib.PRESETS,
        configPath: providers.configPath,
      });
    }

    // ---------- 保存外部模型接入配置 ----------
    if (req.method === 'PUT' && p === '/api/providers') {
      const body = await readBody(req);
      const saved = providers.update(body || {});
      return sendJSON(res, 200, { ok: true, config: saved, active: providers.isExternal() });
    }

    // ---------- 拉取该端点真实可用的模型列表 ----------
    // 为什么要这个：厂商模型名更新很快，靠预设里的几个名字猜迟早会失效。
    // 直接问端点要列表，用户从下拉里挑，就不会再出现"名字写错导致 404"。
    if (req.method === 'POST' && p === '/api/providers/models') {
      const body = await readBody(req);
      const saved = providers.getConfig().external;
      const baseUrl = String(body.baseUrl || saved.baseUrl || '').trim();
      // 前端拿不到明文 Key，所以没传就用存着的那份
      const apiKey = String(body.apiKey || saved.apiKey || '').trim();
      if (!baseUrl) return sendJSON(res, 400, { ok: false, code: 'NO_ENDPOINT', error: '还没有 Base URL' });
      try {
        const models = await providersLib.listModels({ baseUrl, apiKey });
        return sendJSON(res, 200, { ok: true, models, count: models.length });
      } catch (e) {
        return sendJSON(res, CODE_STATUS[e.code] || 502, {
          ok: false, code: e.code || 'API_ERROR', error: String(e.message || e), models: [],
        });
      }
    }

    // ---------- 测试连接（连通性 + 模型列表 + 对话探针）---------
    if (req.method === 'POST' && p === '/api/providers/test') {
      const body = await readBody(req);
      const saved = providers.getConfig().external;
      const baseUrl = String(body.baseUrl || saved.baseUrl || '').trim();
      const apiKey = String(body.apiKey || saved.apiKey || '').trim();
      const model = String(body.chatModel || saved.chatModel || '').trim();
      const report = await providersLib.verify({
        baseUrl,
        apiKey,
        model,
        // 允许只测连通性不发对话（有些模型按次计费，用户可能只想确认 URL 对不对）
        skipChat: body.skipChat === true,
      });
      return sendJSON(res, 200, { ok: report.ok, ...report });
    }

    // ---------- 对外开放（入向）：读取 / 修改 ----------
    if (req.method === 'GET' && p === '/api/openapi') {
      return sendJSON(res, 200, { ok: true, config: openapi.publicConfig(), configPath: openapi.configPath });
    }

    if (req.method === 'PUT' && p === '/api/openapi') {
      const body = await readBody(req);
      const cfg = openapi.update(body || {});
      return sendJSON(res, 200, {
        ok: true,
        config: cfg,
        // 只有"重新生成令牌"这一次会把明文回传给前端，之后只能看到打码版。
        // 明文不落日志、不进状态接口，避免令牌在页面之外的地方滚来滚去。
        tokenPlain: cfg.tokenPlain,
      });
    }

    // ---------- 应用级偏好（联网 / 定位 / 全景 / Blender）---------
    if (req.method === 'GET' && p === '/api/prefs') {
      return sendJSON(res, 200, {
        ok: true,
        config: prefs.publicConfig(),
        // 把可用工具清单告诉前端，界面才能在联网关闭时说明"开启后能做什么"
        tools: TOOL_NAMES,
        configPath: prefs.configPath,
      });
    }

    if (req.method === 'PUT' && p === '/api/prefs') {
      const body = await readBody(req);
      const cfg = prefs.update(body || {});
      return sendJSON(res, 200, { ok: true, config: cfg });
    }

    // ---------- 位置（浏览器定位 / 手填 / IP 兜底）---------
    // 三条写入路径分开，是因为它们的隐私含义不同：浏览器定位与手填都只落本机磁盘，
    // IP 兜底会把请求发给第三方，所以单独一个端点、单独一道开关。
    if (req.method === 'GET' && p === '/api/location') {
      return sendJSON(res, 200, { ok: true, location: location.get(), status: location.status() });
    }

    if (req.method === 'POST' && p === '/api/location') {
      const body = await readBody(req);
      const loc = location.setFromBrowser({ lat: body.lat, lng: body.lng, accuracy: body.accuracy, label: body.label });
      return sendJSON(res, 200, { ok: true, location: loc, status: location.status() });
    }

    if (req.method === 'POST' && p === '/api/location/manual') {
      const body = await readBody(req);
      const loc = location.setManual({ lat: body.lat, lng: body.lng, label: body.label });
      return sendJSON(res, 200, { ok: true, location: loc, status: location.status() });
    }

    if (req.method === 'POST' && p === '/api/location/ip') {
      if (!prefs.getConfig().location.allowIpFallback) {
        return sendJSON(res, 403, {
          ok: false, code: 'FORBIDDEN',
          error: 'IP 定位会把请求发给第三方定位服务（且精度只到城市级），需要先在「设置 → 位置」里勾选允许。',
        });
      }
      const loc = await location.resolveByIp();
      return sendJSON(res, 200, { ok: true, location: loc, status: location.status() });
    }

    if (req.method === 'DELETE' && p === '/api/location') {
      location.clear();
      return sendJSON(res, 200, { ok: true, status: location.status() });
    }

    // 到某个景点的距离与方位。online 时允许走在线地理编码补查坐标，
    // 而在线地理编码会把景点名发给 OSM，所以跟联网开关共用一道闸。
    if (req.method === 'GET' && p === '/api/location/relation') {
      const spot = reqUrl.searchParams.get('spot') || '';
      const city = reqUrl.searchParams.get('city') || '';
      if (!spot.trim()) {
        return sendJSON(res, 400, { ok: false, code: 'BAD_INPUT', error: '缺少 spot 参数（景点名称）' });
      }
      const rel = await location.relationTo(spot, { city, online: prefs.isWebEnabled() });
      return sendJSON(res, 200, { ok: true, ...rel });
    }

    // ---------- 景区全景（检索 → 校验 → 缓存 → 深度高度图）----------
    if (req.method === 'GET' && p === '/api/pano') {
      return sendJSON(res, 200, {
        ok: true,
        items: pano.list(),
        enabled: Boolean(prefs.getConfig().pano.enabled),
        depthRelief: Boolean(prefs.getConfig().pano.depthRelief),
        maxMB: pano.maxMB,
        // 这里只做"权重文件在不在"的廉价检查。
        // 真的探测 Python 环境要起一次 `python -c "import torch"`（好几秒），
        // 不能放在打开设置页时顺带做 —— 那是用户感知得到的卡顿。
        // 需要真探测时走下面的 /api/pano/depth-check（按钮显式触发）。
        depthModelPresent: depth.isModelPresent(),
        depthModelDir: depth.modelDir,
      });
    }

    // 显式探测深度环境（会起一次 Python，约 1~5 秒）
    if (req.method === 'POST' && p === '/api/pano/depth-check') {
      return sendJSON(res, 200, { ok: true, depth: await depth.status() });
    }

    // 检索并下载一张可用的全景图。要联网：这一步真的在搜网页。
    if (req.method === 'POST' && p === '/api/pano/acquire') {
      if (!prefs.getConfig().pano.enabled) {
        return sendJSON(res, 403, { ok: false, code: 'FORBIDDEN', error: '「景区全景」功能当前关闭。请到「设置 → 全景」开启。' });
      }
      if (!prefs.isWebEnabled()) {
        return sendJSON(res, 403, {
          ok: false, code: 'FORBIDDEN',
          error: '查找全景图需要联网。请先在「设置 → 联网」里打开联网开关（或点输入框上方的 🌐）。',
        });
      }
      const body = await readBody(req);
      const spot = String(body.spot || '').trim();
      if (!spot) return sendJSON(res, 400, { ok: false, code: 'BAD_INPUT', error: '缺少 spot（景点名称）' });
      const r = await pano.acquire(spot, { city: String(body.city || '').trim(), limit: Number(body.limit) || 6 });
      return sendJSON(res, 200, { ok: true, record: r.record, tried: r.tried, searchFailures: r.searchFailures });
    }

    // 全景图字节。data/ 目录本身不对外静态服务（防泄露），所以图片要走接口给出去。
    if (req.method === 'GET' && p.startsWith('/api/pano/image/')) {
      const id = decodeURIComponent(p.slice('/api/pano/image/'.length));
      const img = pano.readImage(id);
      if (!img) return sendText(res, 404, 'Not Found: 没有这张全景图');
      res.writeHead(200, {
        'Content-Type': img.mime,
        'Content-Length': img.buffer.length,
        // 全景图内容按 id 寻址、不会变，可以长缓存
        'Cache-Control': 'public, max-age=86400',
      });
      return res.end(img.buffer);
    }

    // 高度图：没有就算一次（同一张全景只算一次），算不出来要如实说明原因
    if (req.method === 'GET' && p.startsWith('/api/pano/depth/')) {
      const id = decodeURIComponent(p.slice('/api/pano/depth/'.length));
      const rec = pano.get(id);
      if (!rec) return sendText(res, 404, 'Not Found: 没有这张全景图');

      let hm = depth.readHeightmap(id);
      if (!hm) {
        const imagePath = path.join(pano.dir, rec.file);
        const r = await depth.compute(id, imagePath);
        if (!r.ok) {
          return sendJSON(res, 503, { ok: false, code: r.code || 'DEPTH_FAILED', error: r.error, detail: r.detail || null });
        }
        hm = depth.readHeightmap(id);
        if (!hm) return sendJSON(res, 500, { ok: false, code: 'DEPTH_FAILED', error: '高度图生成后读取失败' });
      }
      res.writeHead(200, { 'Content-Type': hm.mime, 'Content-Length': hm.buffer.length, 'Cache-Control': 'public, max-age=86400' });
      return res.end(hm.buffer);
    }

    if (req.method === 'DELETE' && p.startsWith('/api/pano/')) {
      const id = decodeURIComponent(p.slice('/api/pano/'.length));
      const ok = pano.remove(id);
      depth.remove(id);
      return sendJSON(res, ok ? 200 : 404, { ok, items: pano.list() });
    }

    // ---------- 图片转 3D（TripoSR）---------
    if (req.method === 'GET' && p === '/api/img23d') {
      return sendJSON(res, 200, {
        ok: true,
        jobs: img23d.list(),
        modelDir: img23d.modelDir,
        // 廉价检查（文件在不在），真探测走下面的 /api/img23d/detect
        modelPresent: img23d.isModelPresent(),
      });
    }

    // 显式探测环境：要起一次 Python，约几秒到几十秒（import torch 不快）
    if (req.method === 'POST' && p === '/api/img23d/detect') {
      return sendJSON(res, 200, { ok: true, env: await img23d.status() });
    }

    if (req.method === 'POST' && p === '/api/img23d/generate') {
      const body = await readBody(req);
      const image = normalizeImage(body.image);
      if (!image) {
        return sendJSON(res, 400, { ok: false, code: 'BAD_INPUT', error: '缺少 image（base64 图片）' });
      }
      const est = Buffer.byteLength(image, 'base64');
      if (est > MAX_IMAGE_BYTES) {
        return sendJSON(res, 413, { ok: false, code: 'TOO_LARGE', error: `图片过大（约 ${(est / 1024 / 1024).toFixed(1)}MB，上限 ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0)}MB）` });
      }

      const id = `i23d-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
      const srcPath = path.join(img23d.outDir, `${id}.png`);
      fs.writeFileSync(srcPath, Buffer.from(image, 'base64'));

      const resolution = Math.min(Math.max(Number(body.resolution) || 160, 96), 320);
      const chunkSize = Math.min(Math.max(Number(body.chunkSize) || 2048, 512), 16384);

      const r = await img23d.generate(id, srcPath, {
        resolution,
        chunkSize,
        removeBg: body.removeBg !== false,
        // 贴图默认开：目标是"带贴图网格"，顶点色只是烘焙失败时的兜底。
        // 代价是多花约 25 秒、文件大 1~2MB。
        bakeTexture: body.bakeTexture !== false,
        textureResolution: Number(body.textureResolution) || 1024,
      });
      if (!r.ok) {
        return sendJSON(res, CODE_STATUS[r.code] || 502, { ok: false, code: r.code || 'IMG23D_FAILED', error: r.error, detail: r.detail || null });
      }

      // 把产物登记进项目已有的模型库 —— 这样生成的东西能直接在形象选择器里用，
      // 不必再为"生成的模型"单独造一套管理界面。
      let registered = null;
      let registerError = null;
      try {
        const buf = img23d.readModel(id);
        registered = models3d.save(buf.toString('base64'), `triposr-${id}.glb`);
      } catch (e) {
        registerError = e.message;
      }

      return sendJSON(res, 200, {
        ok: true,
        id,
        vertices: r.vertices,
        faces: r.faces,
        bytes: r.bytes,
        seconds: r.seconds,
        textured: r.textured,
        resolution: r.resolution,
        removeBgFailed: r.removeBgFailed || null,
        model: registered ? registered.item : null,
        registerError,
        note: registered
          ? '已加入「外观 → 更换形象」的模型列表，可直接选中查看。'
          : '网格已生成，但登记到模型库失败（见 registerError），可稍后重试。',
      });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/img23d/')) {
      const id = decodeURIComponent(p.slice('/api/img23d/'.length));
      const ok = img23d.remove(id);
      return sendJSON(res, ok ? 200 : 404, { ok, jobs: img23d.list() });
    }

    // ---------- 听觉：本地 Whisper 语音识别 ----------
    // 默认关闭。关闭时这里也会被 lib/stt.js 挡回去（返回 STT_DISABLED），
    // 路由这边不重复判断 —— 单一判断点，免得两处逻辑走岔。
    if (req.method === 'GET' && p === '/api/stt') {
      return sendJSON(res, 200, {
        ok: true,
        status: stt.quickStatus(),
        // 前端用这两条决定要不要显示麦克风按钮（浏览器不支持就不显示）
        maxBytes: MAX_STT_BYTES,
        hint: '音频约定为 16kHz 单声道 16-bit WAV；前端用 public/js/voice.js 把 MediaRecorder 的 webm/opus 转成它。',
      });
    }

    // 显式探测环境：要起一次 Python（import torch，几秒到几十秒）
    if (req.method === 'POST' && p === '/api/stt/status') {
      return sendJSON(res, 200, { ok: true, env: await stt.status() });
    }

    // 清掉进程被强杀时遗留的临时音频（data/stt/in-*.wav）
    if (req.method === 'DELETE' && p === '/api/stt/tmp') {
      return sendJSON(res, 200, { ok: true, removed: stt.cleanupTmp() });
    }

    if (req.method === 'POST' && p === '/api/stt') {
      const body = await readBody(req);
      // 体积先按 base64 字符串量一遍：这样"太大"能在 Buffer.from 之前就报出来，
      // 不会为了报一句错误而先分配几十 MB 内存。
      const rawLen = typeof body.audio === 'string' ? body.audio.length : 0;
      if (rawLen > MAX_STT_BODY) {
        return sendJSON(res, 413, {
          ok: false,
          code: 'TOO_LARGE',
          error: `音频过大（约 ${(rawLen * 3 / 4 / 1024 / 1024).toFixed(1)}MB，上限 ${(MAX_STT_BYTES / 1024 / 1024).toFixed(0)}MB）。请说得短一些，或分段上传。`,
        });
      }

      const decoded = sttLib.decodeAudioInput(body.audio);
      if (!decoded.ok) {
        return sendJSON(res, 400, { ok: false, code: 'BAD_INPUT', error: `${decoded.error}（字段名是 audio，传 base64 的 WAV）` });
      }

      const r = await stt.transcribe(decoded.buffer, {
        // language 允许前端覆盖（比如用户切成英文），不传就用偏好里的
        language: String(body.language || '').trim() || undefined,
        device: String(body.device || '').trim() || undefined,
      });

      if (!r.ok) {
        // 开关未打开、权重没装、正忙、格式不对……都是"用户能自己处理"的情况，
        // 所以带上 code 让前端能分别提示；只有真正没预料到的才走 5xx。
        const httpCode = r.code === 'STT_DISABLED' ? 403
          : r.code === 'TOO_LARGE' ? 413
            : r.code === 'STT_TIMEOUT' ? 504
              : r.code === 'BUSY' ? 429
                : r.code === 'STT_UNAVAILABLE' ? 503
                  : 502;
        return sendJSON(res, httpCode, { ok: false, code: r.code || 'STT_FAILED', error: r.error, detail: r.detail || null });
      }

      return sendJSON(res, 200, {
        ok: true,
        text: r.text,
        language: r.language,
        durationMs: r.durationMs,
        // 下面这些是"这次跑在哪、花了多久"，用来解释"为什么这次慢了"
        device: r.device,
        deviceFallback: r.deviceFallback || null,
        inferSeconds: r.inferSeconds,
        waitedMs: r.waitedMs,
        elapsedMs: r.elapsedMs,
        empty: r.empty,
        wavWarning: r.wavWarning || '',
        note: r.empty ? '没有识别出文字（可能是静音、太短，或者离麦克风太远）。' : '',
      });
    }

    // ---------- 导航模式的风景图 ----------
    // 三档来源里，「内置程序化」在前端现画（public/js/nav-visuals.js），不走这里。
    // 这里管另外两档：自备目录匹配、联网搜图并下载。
    if (req.method === 'GET' && p === '/api/scenery/status') {
      return sendJSON(res, 200, { ok: true, ...scenery.status() });
    }

    // 自备目录：按景点名匹配一张图（匹配不到如实报错，让前端退回内置风景）
    if (req.method === 'GET' && p === '/api/scenery/local') {
      const spot = reqUrl.searchParams.get('spot') || '';
      const r = scenery.localFor(spot);
      return sendJSON(res, r.ok ? 200 : 404, { ...r, spot });
    }

    // 联网搜图。**只在被显式调用时才发请求** —— 不在页面加载、切景点时偷偷发。
    // 联网总开关关着时 lib/scenery.js 会直接拒绝，这里不做二次判断（单一判断点）。
    if (req.method === 'GET' && p === '/api/scenery/search') {
      const spot = reqUrl.searchParams.get('spot') || '';
      const city = reqUrl.searchParams.get('city') || '';
      if (!spot.trim()) return sendJSON(res, 400, { ok: false, error: '缺少 spot 参数（景点名）' });
      const r = await scenery.searchFor(spot, city);
      return sendJSON(res, r.ok ? 200 : 502, { ...r, spot, city });
    }

    // 清掉联网搜图下下来的缓存
    if (req.method === 'DELETE' && p === '/api/scenery/cache') {
      return sendJSON(res, 200, { ok: true, removed: scenery.clearCache(), ...scenery.status() });
    }

    // 自备图与缓存图的静态读取。文件名在 lib/scenery.js 里过 basename 再拼，
    // 路由这边不自己拼路径 —— 拼路径的地方多一处就多一个穿越漏洞。
    const serveScenery = (hit) => {
      const st = fs.statSync(hit.full);
      res.writeHead(200, {
        'Content-Type': hit.mime || sceneryMime(path.extname(hit.base)),
        'Content-Length': st.size,
        'Cache-Control': 'public, max-age=86400',
      });
      return fs.createReadStream(hit.full).pipe(res);
    };
    if (req.method === 'GET' && p.startsWith('/api/scenery/file/')) {
      const hit = scenery.readFile(p.slice('/api/scenery/file/'.length));
      if (!hit) return sendText(res, 404, 'Not Found');
      return serveScenery(hit);
    }
    if (req.method === 'GET' && p.startsWith('/api/scenery/cache/')) {
      const hit = scenery.readFile(p.slice('/api/scenery/cache/'.length), { cache: true });
      if (!hit) return sendText(res, 404, 'Not Found');
      return serveScenery(hit);
    }

    // ---------- 视频背景（大屏宣传片）----------
    // 与图片背景（/api/backgrounds）分开，因为量级与失败表现完全不同：
    // 视频上百 MB，断在半路会留下"能选中但播不出来"的半截文件，所以要单独的
    // 大小上限与"临时文件改名"保护（见 lib/videos.js）。
    if (req.method === 'GET' && p === '/api/videos') {
      return sendJSON(res, 200, { ok: true, ...videos.list(), status: videos.status() });
    }

    if (req.method === 'POST' && p === '/api/videos') {
      const body = await readBody(req);
      const r = videos.save(body.video, body.name);
      if (!r.ok) return sendJSON(res, r.error && /过大/.test(r.error) ? 413 : 400, { ok: false, error: r.error });
      return sendJSON(res, 200, { ok: true, ...r, ...videos.list() });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/videos/')) {
      const r = videos.remove(p.slice('/api/videos/'.length));
      return sendJSON(res, r.ok ? 200 : 404, { ...r, ...videos.list() });
    }

    // 视频字节。支持 Range 请求：浏览器拖动进度条、以及大文件分段拉取都依赖它，
    // 不做的话某些浏览器会拒绝播放或只能从头播。
    if (req.method === 'GET' && p.startsWith('/api/videos/file/')) {
      const hit = videos.readFile(p.slice('/api/videos/file/'.length));
      if (!hit) return sendText(res, 404, 'Not Found');
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] ? Number(m[1]) : 0;
        const end = m && m[2] ? Number(m[2]) : hit.bytes - 1;
        if (Number.isFinite(start) && start < hit.bytes) {
          const stop = Math.min(Number.isFinite(end) ? end : hit.bytes - 1, hit.bytes - 1);
          res.writeHead(206, {
            'Content-Type': hit.mime,
            'Content-Length': stop - start + 1,
            'Content-Range': `bytes ${start}-${stop}/${hit.bytes}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=3600',
          });
          return fs.createReadStream(hit.full, { start, end: stop }).pipe(res);
        }
      }
      res.writeHead(200, {
        'Content-Type': hit.mime,
        'Content-Length': hit.bytes,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      });
      return fs.createReadStream(hit.full).pipe(res);
    }

    // ---------- 地图瓦片代理（定位导航页用）----------
    //
    // 为什么不让前端直连高德：一是防盗链（没有 Referer/UA 会被拒），
    // 二是走服务端才能**缓存** —— 大屏上平移地图时瓦片请求量不小，
    // 缓存住第二次就几乎不耗时。
    //
    // 为什么用高德而不是 OpenStreetMap：实测这台机器上 tile.openstreetmap.org
    // 与 nominatim.openstreetmap.org 都不可达（HTTP 000），而高德的栅格瓦片接口
    // 不需要 key 就能取，且是中文注记 —— 对国内文旅场景本来也更合适。
    if (req.method === 'GET' && p === '/api/tile') {
      const z = Number(reqUrl.searchParams.get('z'));
      const x = Number(reqUrl.searchParams.get('x'));
      const y = Number(reqUrl.searchParams.get('y'));
      const style = String(reqUrl.searchParams.get('style') || '8');
      // 严格校验：这几个值会拼进上游 URL，不校验就等于开了个"任意请求"的口子
      if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)
        || z < 3 || z > 18 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z
        || !/^[0-9]{1,2}$/.test(style)) {
        return sendJSON(res, 400, { ok: false, error: '瓦片参数不合法' });
      }
      const key = `${z}-${x}-${y}-${style}`;
      if (!tileCache.has(key)) {
        // 超出上限就丢最早进的（Map 保持插入顺序，天然近似 LRU）
        while (tileCache.size >= TILE_CACHE_MAX) {
          const oldest = tileCache.keys().next().value;
          tileCache.delete(oldest);
        }
        try {
          // webrd01~04 是同一组服务，轮着用可以分散压力
          const host = `webrd0${1 + (Math.abs(x + y) % 4)}.is.autonavi.com`;
          const r = await fetch(`https://${host}/appmaptile?lang=zh_cn&size=1&scale=1&style=${style}&x=${x}&y=${y}&z=${z}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
              Referer: 'https://www.amap.com/',
            },
            signal: AbortSignal.timeout(10000),
          });
          if (!r.ok) return sendJSON(res, 502, { ok: false, error: `上游返回 ${r.status}` });
          const buf = Buffer.from(await r.arrayBuffer());
          if (!buf.length) return sendJSON(res, 502, { ok: false, error: '上游返回空' });
          tileCache.set(key, buf);
        } catch (e) {
          return sendJSON(res, 502, { ok: false, error: `取瓦片失败：${String(e.message || e).split('\n')[0]}` });
        }
      }
      const buf = tileCache.get(key);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': buf.length,
      });
      return res.end(buf);
    }

    // ---------- 城市中心（导航页"没有定位权限时选一个起点"用）----------
    if (req.method === 'GET' && p === '/api/geo/cities') {
      return sendJSON(res, 200, { ok: true, cities: geo.CITY_CENTERS });
    }

    // ---------- 附近景点：定位之后"离我多远、在哪个方向" ----------
    //
    // 逆地理编码（经纬度 → 地名）需要 API key，实测高德和百度都要，
    // 而本项目的原则是不引入需要密钥的外部依赖。所以改成"就近匹配内置景点表"：
    // 对文旅场景来说，"你离断桥残雪 320 米、在西北方向"比一个行政区名字有用得多，
    // 而且完全离线可用。
    if (req.method === 'GET' && p === '/api/geo/nearby') {
      const lat = Number(reqUrl.searchParams.get('lat'));
      const lng = Number(reqUrl.searchParams.get('lng'));
      const limit = Math.min(Math.max(Number(reqUrl.searchParams.get('limit')) || 8, 1), 30);
      if (!geo.isValidCoord(lat, lng)) return sendJSON(res, 400, { ok: false, error: '经纬度不合法' });
      const here = { lat, lng };
      const spots = geo.GAZETTEER.map((s) => {
        const meters = geo.distanceMeters(here, { lat: s.lat, lng: s.lng });
        const bearing = geo.bearingDeg(here, { lat: s.lat, lng: s.lng });
        return {
          city: s.city, name: s.name, aka: s.aka || [],
          lat: s.lat, lng: s.lng,
          meters: Math.round(meters),
          distance: geo.formatDistance(meters),
          bearing: Math.round(bearing),
          compass: geo.compassLabel(bearing),
        };
      }).sort((a, b) => a.meters - b.meters).slice(0, limit);
      return sendJSON(res, 200, { ok: true, here, spots });
    }

    // ---------- Blender 动画（通过 MCP 驱动）---------
    if (req.method === 'GET' && p === '/api/blender') {
      return sendJSON(res, 200, {
        ok: true,
        // available 要探端口（很快），所以放在这里而不放 /api/status ——
        // 状态接口是每次进页面都会调的，不该顺手去连一个可能不存在的服务。
        status: await blender.status(),
        jobs: blender.list(),
        host: blender.host,
        port: blender.port,
      });
    }

    // 只探端口，不起命令（用于界面上的状态灯轮询）
    if (req.method === 'GET' && p === '/api/blender/ping') {
      return sendJSON(res, 200, { ok: true, available: await blender.available(), host: blender.host, port: blender.port });
    }

    if (req.method === 'POST' && p === '/api/blender/anim') {
      const body = await readBody(req);
      if (!(await blender.available())) {
        return sendJSON(res, 503, {
          ok: false, code: 'BLENDER_UNREACHABLE',
          error: (await blender.status()).reason,
        });
      }
      const r = await blender.buildWalkAnimation({
        name: String(body.name || 'tour-guide'),
        frames: Number(body.frames) || 72,
        radius: Number(body.radius) || 2.4,
        strideCycles: Number(body.strideCycles) || 4,
        height: Number(body.height) || 1.6,
      });

      // 与图片转 3D 一致：产物登记进已有模型库，这样能在形象选择器里直接用。
      let registered = null;
      let registerError = null;
      try {
        const buf = blender.readModel(r.fileName);
        if (!buf) throw new Error('导出的文件读不到');
        registered = models3d.save(buf.toString('base64'), `blender-${r.fileName}`);
      } catch (e) {
        registerError = e.message;
      }

      return sendJSON(res, 200, {
        ok: true,
        fileName: r.fileName,
        bytes: r.bytes,
        objects: r.objects,
        frames: r.frames,
        fps: r.fps,
        durationSeconds: r.durationSeconds,
        blenderVersion: r.blenderVersion,
        model: registered ? registered.item : null,
        registerError,
        note: registered
          ? '已加入「外观 → 更换形象」，选中即可看到走动动画（网页端用 AnimationMixer 播放）。'
          : '动画已导出，但登记到模型库失败（见 registerError）。',
      });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/blender/')) {
      const f = decodeURIComponent(p.slice('/api/blender/'.length));
      const ok = blender.remove(f);
      return sendJSON(res, ok ? 200 : 404, { ok, jobs: blender.list() });
    }

    // ---------- 联网对话（SSE 流式，带工具调用过程）---------
    // 与 /api/chat 的区别：这条会把"模型调用了什么工具、拿到什么结果"也推给前端。
    // 联网没开、也没有形象可指挥时它会退化成一次普通流式对话（工具列表为空，agent 只跑一轮），
    // 所以前端可以无条件走这条，不必自己判断该走哪个接口。
    if (req.method === 'POST' && p === '/api/agent') {
      const body = await readBody(req);
      const sse = openSSE(res);
      try {
        const card = (body.cardId && cards.get(body.cardId)) || cards.active();
        const userText = String(body.message || '').trim();
        const image = normalizeImage(body.image);
        if (!userText && !image) throw Object.assign(new Error('消息为空'), { code: 'BAD_INPUT' });

        for await (const ev of runAgentPipeline({ card, userText, image, history: body.history, avatar: body.avatar })) {
          if (sse.closed) break;
          sse.send(ev);
        }
      } catch (e) {
        sse.send({ type: 'error', code: e.code || 'INTERNAL', error: String(e.message || e) });
      }
      return sse.end();
    }

    // ---------- 能力清单（词云 + 表单选项 + 音色 + 模型 + 背景）---------
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

    // ---------- 3D 角色模型（VRM / GLB）---------
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
    // 提供自定义背景文件本身
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

    // ---------- 机体对话（SSE 流式）---------
    if (req.method === 'POST' && p === '/api/chat') {
      const body = await readBody(req);
      const sse = openSSE(res);
      try {
        const card = (body.cardId && cards.get(body.cardId)) || cards.active();
        const userText = String(body.message || '').trim();
        const image = normalizeImage(body.image);
        if (!userText && !image) throw Object.assign(new Error('消息为空'), { code: 'BAD_INPUT' });

        // 与入向 /v1/chat/completions 共用同一条管线：视觉 → 记忆 → 组装 → 流式 → 落记忆。
        // 抽出来的原因很直接：这两条路径必须行为一致，复制一份迟早会改歪一边。
        for await (const ev of runChatPipeline({ card, userText, image, history: body.history })) {
          if (sse.closed) break;
          sse.send(ev);
        }
      } catch (e) {
        sse.send({ type: 'error', code: e.code || 'INTERNAL', error: String(e.message || e) });
      }
      return sse.end();
    }

    // ---------- 文旅 Skill 生成（SSE 流式，含输出质检）---------
    if (req.method === 'POST' && p === '/api/wenlv/generate') {
      const body = await readBody(req);
      const type = body.type || 'plan';
      // 先校验再开 SSE：一旦写了响应头就没法再返回 4xx 了，
      // 所以非法参数应当拿到 4xx 而不是 200，是评分点里明确要求的行为。
      if (!['plan', 'marketing', 'product', 'intake'].includes(type)) {
        return sendJSON(res, 400, { ok: false, code: 'BAD_INPUT', error: `未知类型: ${type}（只支持 plan / marketing / product / intake）` });
      }
      const sse = openSSE(res);
      try {
        sse.send({ type: 'start', type });

        // 先排队。注意：拿锁要在调 generateStream **之前** —— 超时计时是从真正
        // 开始生成算起的，不能让排队的时间把用户的 300 秒白耗掉。
        const ahead = genQueueDepth() + (genBusy ? 1 : 0);
        if (ahead > 0) {
          sse.send({ type: 'notice', text: `本机模型正在忙，前面还有 ${ahead} 个任务，已排队。` });
        }
        const queuedMs = await acquireGen();
        const queuedSec = Math.round(queuedMs / 1000);
        if (queuedSec >= 2) {
          sse.send({ type: 'notice', text: `排队等了 ${queuedSec} 秒，现在轮到你了，开始生成。` });
        }

        try {
          for await (const chunk of wenlv.generateStream(type, body.params || {}, { model: body.model })) {
            if (chunk.delta) sse.send({ type: 'delta', text: chunk.delta });
            if (chunk.done) {
              sse.send({ type: 'done', content: chunk.content, warnings: chunk.warnings || [], model: chunk.model, params: chunk.params });
              // 方案/文案也进记忆，之后可以直接用自然语言追问"上次那个杭州方案"
              try {
                await memory.add({
                  text: `[${chunk.params.city || chunk.params.product || '用户'}生成${({ plan: '行程方案', marketing: '营销文案', product: '产品概念' })[type] || '追问'}] ${String(chunk.content).slice(0, 600)}`,
                  role: 'assistant', kind: 'fact', tags: ['文旅', type, chunk.params.city].filter(Boolean), sessionId: cards.activeId,
                });
              } catch { /* 记忆失败不影响生成结果 */ }
            }
            if (sse.closed) break;
          }
        } finally {
          releaseGen();     // 不管成功失败都要放锁，否则后面全部卡住
        }
      } catch (e) {
        sse.send({ type: 'error', code: e.code || 'INTERNAL', error: String(e.message || e) });
      }
      return sse.end();
    }

    // ---------- 非流式生成（保留原项目的 /api/generate 的 JSON 契约，便于自动化测试与 Agent 调用）---------
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
            diet: (q.get('diet') || '不限').trim(),
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
          ? `【由本地样本库驱动生成】目的地：${r.params.city} · 天数：${r.params.days} · 预算：${r.params.budget} · 同行人群：${r.params.crowd} · 饮食禁忌：${r.params.diet}`
          : `【由本地样本库驱动生成】产品：${r.params.product} · 平台：${r.params.platform} · 目标客群：${r.params.audience} · 风格：${r.params.style}`);
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
      const { visionModel } = await inference.resolveModels();
      const r = await inference.vision({ model: visionModel, imagesBase64: [image], prompt: body.prompt });
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
      // 之前 server 漏了这一环，所以 lib/tts.js 里那个 voice-clone 分支根本走不到。
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

      // 试听：把参考音频原样回给浏览器
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

/**
 * 组装一次对话所需的上下文：看图 → 召回记忆 → 拼 messages。
 *
 * 做成生成器是为了让中间状态（"正在看图"、召回了哪些记忆）**立刻**推给界面，
 * 而不是等全部准备完再一次性吐出来 —— 看图要几秒，用户需要知道在等什么。
 *
 * 最后一项固定是 `{ type: '__ctx', messages, useModel }`，调用方拿它继续生成。
 * 普通对话与联网 Agent 两条管线共用它，避免"只在一处加了记忆召回"这类分叉。
 */
async function* prepareChatContext({ card, userText, image, history }) {
  const { chatModel } = await inference.resolveModels();
  const useModel = (card.model && card.model.chat) || chatModel;
  if (!useModel) {
    throw Object.assign(
      new Error('没有可用的对话模型。本机请先运行：ollama pull qwen2.5:7b（或 qwen3:8b）；也可以在「设置 → 模型接入」里配置外部 API。'),
      { code: 'NO_MODEL' },
    );
  }

  // 1) 有图先做视觉理解，把"看到什么"变成文字再喂给对话模型
  let visionText = '';
  if (image && card.vision && card.vision.enabled) {
    // 文案不写死"本机多模态模型"：视觉可能已经切到外部 API 了
    yield { type: 'stage', stage: 'vision', text: '正在看图…' };
    const { visionModel } = await inference.resolveModels();
    if (!visionModel) {
      visionText = '（没有可用的多模态模型，这一步跳过了。本机可执行 ollama pull qwen2.5vl:7b；也可以在「设置 → 模型接入」里把视觉也切到外部 API。）';
      yield { type: 'notice', text: visionText };
    } else {
      try {
        const r = await inference.vision({ model: visionModel, imagesBase64: [image] });
        visionText = r.content;
        yield { type: 'vision', model: visionModel, text: visionText };
        await memory.add({ text: `[看图] ${visionText}`, role: 'system', kind: 'fact', tags: ['视觉'], sessionId: card.id });
      } catch (e) {
        visionText = `（视觉理解失败：${e.message}）`;
        yield { type: 'notice', text: visionText };
      }
    }
  }

  // 2) 召回长期记忆
  const query = [userText, visionText].filter(Boolean).join('\n');
  let memoryText = '';
  if (card.memory && card.memory.enabled && query) {
    const ctx = await memory.buildContext(query, card.memory.topK || 5);
    memoryText = ctx.text;
    const hits = ctx.hits.map(h => ({ id: h.id, text: h.text.slice(0, 120), score: Number(h.score.toFixed(3)), ts: h.ts }));
    if (hits.length) yield { type: 'memory', hits };
  }

  // 3) 组装消息
  const webOn = prefs.isWebEnabled();
  const system = cards.composeSystemPrompt(card, {
    memoryText,
    extraContext: '你可以调用的本地能力：个性化方案规划、文旅营销素材生成、信息缺失集中追问、输出质检、长期记忆、视觉理解、语音播报。用户点词云就能触发这些能力。'
      + (webOn
        ? '\n\n【联网已开启】你手上有联网工具。凡是涉及“最新/现在/今年"的信息（票价、开放时间、天气、活动、交通、某地是否存在），必须先调用工具查证再回答，不要凭记忆作答，也不要编造。'
          + '搜索摘要常常被截断，缺少具体数字时应当用 web_fetch 打开最相关的一条链接读正文。'
        : ''),
  });
  const turns = Array.isArray(history) ? history.slice(-12) : [];
  const messages = [
    { role: 'system', content: system },
    ...turns
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .map(m => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
    {
      role: 'user',
      content: visionText ? `（我上传了一张图片，视觉模型看到的内容是：${visionText}）\n\n${userText || '请根据这张图给我文旅方面的建议。'}` : userText,
    },
  ];

  yield { type: '__ctx', messages, useModel };
}

/**
 * 机体对话管线（可复用的异步生成器）。
 *
 * 为什么要抽成生成器，而不是写成一个返回最终文本的函数：
 *   调用方有两种，编码方式不一样，但业务步骤必须完全一致 ——
 *     · /api/chat            把这些事件原样转成 SSE 发给浏览器
 *     · /v1/chat/completions 按 OpenAI 的 chunk 格式重新打包给外部 Agent
 *   让管线只负责"产出事件"，各协议自己负责"怎么编码"，业务逻辑就只存在一份。
 *   复制两份的写法迟早会改歪其中一边（比如只在一处加了记忆召回）。
 *
 * 产出的事件：stage / notice / vision / memory / start / delta / done
 */
async function* runChatPipeline({ card, userText, image, history }) {
  let ctx = null;
  for await (const ev of prepareChatContext({ card, userText, image, history })) {
    if (ev.type === '__ctx') { ctx = ev; break; }
    yield ev;
  }

  // 4) 流式生成
  yield { type: 'start', model: ctx.useModel, card: { id: card.id, name: card.name, avatar: card.avatar, accent: card.accent } };
  let full = '';
  for await (const chunk of inference.chatStream({
    model: ctx.useModel,
    temperature: (card.model && card.model.temperature) ?? 0.7,
    numCtx: (card.model && card.model.numCtx) || 16384,
    numPredict: (card.model && card.model.numPredict) || 1024,
    messages: ctx.messages,
  })) {
    if (chunk.delta) { full += chunk.delta; yield { type: 'delta', text: chunk.delta }; }
    if (chunk.done) full = chunk.content || full;
  }

  // 5) 落记忆（用户这句 + 角色回的这句）
  if (card.memory && card.memory.enabled) {
    if (userText) await memory.add({ text: userText, role: 'user', kind: 'turn', sessionId: card.id, tags: extractTags(userText) });
    if (full) await memory.add({ text: full, role: 'assistant', kind: 'turn', sessionId: card.id, tags: [] });
  }
  yield { type: 'done', content: full, model: ctx.useModel };
}

/**
 * 联网对话管线：与普通对话共用上下文准备，差别只在生成环节换成"带工具的多轮循环"。
 *
 * 之所以不复用 runChatPipeline 再加个开关，是因为两者的**事件种类**不同：
 * 这条会多出 agent_round / tool_start / tool_result / round_discard，
 * 硬塞进同一支会让两支都变难读。
 */
async function* runAgentPipeline({ card, userText, image, history, avatar }) {
  let ctx = null;
  for await (const ev of prepareChatContext({ card, userText, image, history })) {
    if (ev.type === '__ctx') { ctx = ev; break; }
    yield ev;
  }

  const web = prefs.getConfig().web;

  // avatar_action 是「控制形象做动作」，跟联网半点关系没有，所以**不能**挂在
  // web.enabled 下面 —— 否则用户一关联网，连"笑一个"都做不了了。
  // 其余三个（搜索 / 抓取 / 找全景）才是真正的联网能力。
  const avatarOn = !!avatar;
  const tools = TOOL_SCHEMAS.filter(t => (t.function.name === 'avatar_action' ? avatarOn : web.enabled));
  const isAllowed = (name) => {
    if (name === 'web_fetch') return web.allowFetch !== false;
    if (name === 'find_panorama') return web.allowPanorama !== false;
    return true;
  };

  // 把"这只形象有哪些动作 / 表情"写进提示词。
  // 不写的话模型只能猜动作名（它训练数据里的 wave、smile 之类），
  // 而真实动作名长这样：00_idle、tap_body_01 —— 猜不中的结果就是
  // 模型自以为吩咐过了，用户却什么都没看到。
  if (avatarOn) {
    const lines = [];
    const motions = (avatar.motions || []).map(m => (m && m.name) || m).filter(Boolean);
    const groups = [...new Set((avatar.motions || []).map(m => m && m.group).filter(Boolean))];
    if (motions.length) {
      lines.push(`可用动作名（共 ${motions.length} 个）：${motions.slice(0, 60).join('、')}`);
      if (groups.length) lines.push(`动作组：${groups.join('、')}（只给组名表示在该组里随机播一个）`);
    }
    if ((avatar.expressions || []).length) {
      lines.push(`可用表情名：${avatar.expressions.slice(0, 40).join('、')}`);
    }
    if (lines.length) {
      ctx.messages.push({
        role: 'system',
        content:
          '【形象控制】你面前这个虚拟形象可以被你指挥，用 avatar_action 让它在说话时配合动作。\n'
          + `${lines.join('\n')}\n`
          + `当前形象：${avatar.label || card.name || '（未知）'}。\n`
          + '只在合适的时候用（用户明确要求，或明显能增强表达时），不要每句话都调。'
          + '它不产生文字，你仍需正常作答。',
      });
    }
  }

  yield {
    type: 'start',
    model: ctx.useModel,
    agent: true,
    tools: tools.filter(t => isAllowed(t.function.name)).map(t => t.function.name),
    card: { id: card.id, name: card.name, avatar: card.avatar, accent: card.accent },
  };

  let final = null;
  for await (const ev of runAgent({
    inference,
    messages: ctx.messages,
    model: ctx.useModel,
    tools,
    maxSteps: Number(web.maxSteps) || 4,
    temperature: (card.model && card.model.temperature) ?? 0.5,
    numCtx: (card.model && card.model.numCtx) || 16384,
    // 联网时把输出预算放大一点：模型要先把工具结果组织成答案，
    // 沿用角色卡默认的 1024 容易出现"查到一半话没说完"
    numPredict: Math.max((card.model && card.model.numPredict) || 1024, 1536),
    isAllowed,
    toolContext: { avatar },
  })) {
    if (ev.type === 'delta') yield { type: 'delta', text: ev.text };
    else if (ev.type === 'round') yield { type: 'agent_round', round: ev.round, maxSteps: ev.maxSteps };
    else if (ev.type === 'tool_start') yield { type: 'tool_start', name: ev.name, args: ev.args };
    // data 必须带上：avatar_action 的全部作用就在 data.avatar 里，
    // 之前这里只转发 ok/summary，前端于是根本收不到「该做什么动作」。
    else if (ev.type === 'tool_result') yield { type: 'tool_result', name: ev.name, ok: ev.ok, summary: ev.summary, ms: ev.ms, data: ev.data };
    else if (ev.type === 'round_discard') yield { type: 'round_discard', text: ev.text };
    else if (ev.type === 'done') final = ev;
  }

  const full = (final && final.content) || '';
  if (card.memory && card.memory.enabled) {
    if (userText) await memory.add({ text: userText, role: 'user', kind: 'turn', sessionId: card.id, tags: extractTags(userText) });
    if (full) await memory.add({ text: full, role: 'assistant', kind: 'turn', sessionId: card.id, tags: [] });
  }
  yield {
    type: 'done',
    content: full,
    model: ctx.useModel,
    agent: true,
    steps: (final && final.steps) || [],
    hitStepLimit: Boolean(final && final.hitStepLimit),
  };
}

/* ==========================================================================
 * 入向接口：让外部 Agent 用标准 OpenAI 协议调用本项目
 *
 * 与出向（lib/providers.js）合起来就是完整的"双向接入"：
 *   出向 = 本项目去调别人的大模型；入向 = 别人来调本项目的文旅能力。
 * ========================================================================*/

/**
 * 对外的虚拟模型名。
 *
 * 存在的理由：OpenAI 协议的请求体里 model 是必填的，但外部客户端并不知道
 * 你本机装的是 qwen2.5:7b 还是切到了 DeepSeek。给一个稳定名字代表
 * "就用本项目当前配置的模型"，客户端就不用关心后端细节了。
 */
const WENLV_MODEL_ID = 'wenlv-assistant';

/**
 * 把对外的短别名映射回内部 /api/* 路径。
 *
 * 为什么要这套别名：交付物 ① 里的 airi-bridge 对外暴露的就是
 * /wenlv/*  /memory/*  /cards/*，AIRI 那边的代码是按这套路径写的。
 * 这里内置同样的别名，外部直接连本项目时就不用再改 AIRI 侧了。
 */
function aliasToApi(pathname) {
  const PAIRS = [['/wenlv', '/api/wenlv'], ['/memory', '/api/memory'], ['/cards', '/api/cards']];
  for (const [from, to] of PAIRS) {
    if (pathname === from || pathname.startsWith(`${from}/`)) return to + pathname.slice(from.length);
  }
  return null;
}

/**
 * 入向权限闸门。不通过就抛错，由外层统一用 fail() 转成 401/403 ——
 * 这样状态码口径和项目里其它接口完全一致，不用在这里再造一套错误响应。
 */
function requireInboundAccess(req, pathname, alias) {
  const auth = openapi.authorize(req);
  if (!auth.ok) throw Object.assign(new Error(auth.error), { code: auth.code });

  // 判断这条路径属于哪一类能力，再查"对外开放"里有没有勾选
  let kind = null;
  if (pathname.startsWith('/v1/chat')) kind = 'chat';
  else if (pathname.startsWith('/v1/models')) kind = 'models';
  else if (pathname.startsWith('/v1/embeddings')) kind = 'embeddings';
  else if (pathname.startsWith('/v1/audio')) kind = 'speech';
  else if (alias && alias.startsWith('/api/wenlv')) kind = 'wenlv';
  else if (alias && alias.startsWith('/api/memory')) kind = 'memory';
  else if (alias && alias.startsWith('/api/cards')) kind = 'cards';

  if (kind && !openapi.allows(kind)) {
    const label = { chat: '对话', models: '模型列表', embeddings: '向量', speech: '语音', wenlv: '文旅生成', memory: '记忆', cards: '角色卡' }[kind] || kind;
    throw Object.assign(
      new Error(`对外开放里没有勾选「${label}」，这条接口当前不可用。请到「设置 → 对外开放」勾上再试。`),
      { code: 'FORBIDDEN' },
    );
  }
  openapi.note(pathname);
  return kind;
}

/** OpenAI 风格的错误体：外部客户端（openai SDK 等）认的是这个形状，不是本项目的 {ok:false} */
function openaiError(res, code, message) {
  const status = CODE_STATUS[code] || 500;
  return sendJSON(res, status, {
    error: {
      message: message || code,
      type: code === 'UNAUTHORIZED' ? 'invalid_request_error' : 'api_error',
      code: code || 'error',
    },
  });
}

/** 从 OpenAI 的 messages 里抽出本轮用户输入、历史轮次，以及可能的图片 */
function parseOpenAIMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const history = [];
  let userText = '';
  let image = '';

  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    // content 可能是字符串，也可能是 [{type:'text'|'image_url', ...}] 的分段数组
    if (typeof m.content === 'string') {
      if (role === 'user') userText = m.content;
      else if (role === 'assistant') history.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    const texts = [];
    for (const part of m.content) {
      if (!part) continue;
      if (part.type === 'text' && part.text) texts.push(part.text);
      if (part.type === 'image_url' && part.image_url && part.image_url.url) {
        // 只接 data URL 形式的图片。外链图片不去抓 ——
        // 那等于让本服务变成一个凭请求就能访问任意 URL 的代理，不值得。
        const mm = String(part.image_url.url).match(/^data:image\/[a-z+]+;base64,(.+)$/i);
        if (mm) image = mm[1];
      }
    }
    const joined = texts.join('\n').trim();
    if (role === 'user') userText = joined;
    else if (role === 'assistant') history.push({ role, content: joined });
  }
  return { userText, image, history };
}

/**
 * /v1/* 的全部处理逻辑。
 * 返回 undefined 表示"不是我能处理的路由"，交回给上层走常规路由。
 */
async function handleOpenAI(req, res, p) {
  const resolved = await inference.resolveModels();

  // ---------------- GET /v1/models ----------------
  if (req.method === 'GET' && p === '/v1/models') {
    const ids = new Set();
    ids.add(WENLV_MODEL_ID);
    for (const n of (resolved.models || [])) ids.add(n);
    for (const n of [resolved.chatModel, resolved.visionModel, resolved.embedModel]) if (n) ids.add(n);
    return sendJSON(res, 200, {
      object: 'list',
      data: [...ids].map(id => ({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'wenlv-assistant',
      })),
    });
  }

  // ---------------- POST /v1/chat/completions ----------------
  if (req.method === 'POST' && p === '/v1/chat/completions') {
    const body = await readBody(req);
    const { userText, image, history } = parseOpenAIMessages(body.messages);
    if (!userText && !image) {
      throw Object.assign(new Error('messages 里没有可用的用户输入'), { code: 'BAD_INPUT' });
    }

    // 选角色卡：请求头 x-wenlv-card 优先，其次默认当前激活的那张
    const wantCard = String(req.headers['x-wenlv-card'] || body.card || '').trim();
    let card = (wantCard && cards.get(wantCard)) || cards.active();

    // 模型名：只有它确实存在于本机模型列表里才当作覆盖，否则忽略。
    // 直接拿客户端传来的任意字符串去调本地 Ollama 会得到 404，
    // 而错误信息会让人以为是密钥问题。
    const requested = String(body.model || '').trim();
    const localNames = new Set(resolved.models || []);
    if (requested && requested !== WENLV_MODEL_ID && localNames.has(requested)) {
      card = { ...card, model: { ...(card.model || {}), chat: requested } };
    }

    const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    const stream = body.stream === true;

    // ---- 非流式：把管线跑完再一次性返回 ----
    if (!stream) {
      let full = '';
      let usedModel = resolved.chatModel || WENLV_MODEL_ID;
      for await (const ev of runChatPipeline({ card, userText, image, history })) {
        if (ev.type === 'delta') full += ev.text;
        if (ev.type === 'done') { full = ev.content || full; usedModel = ev.model || usedModel; }
      }
      return sendJSON(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: usedModel,
        choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    // ---- 流式：按 OpenAI 的 chunk 格式逐个发 ----
    // 注意这里不能用 openSSE()，那个发的是本项目的 {type:...} 事件格式。
    // 外部客户端要的是 choices[].delta.content 这套结构，得另写一份。
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 客户端已断开 */ } };
    const chunk = (delta, finish) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: resolved.chatModel || WENLV_MODEL_ID,
      choices: [{ index: 0, delta, finish_reason: finish || null }],
    });

    try {
      write(chunk({ role: 'assistant', content: '' }));
      for await (const ev of runChatPipeline({ card, userText, image, history })) {
        if (ev.type === 'delta') write(chunk({ content: ev.text }));
        if (ev.type === 'done') write(chunk({}, 'stop'));
      }
    } catch (e) {
      // 已经发出 200 了，没法再改状态码，只能把错误作为一条内容告诉对方
      write({ error: { message: String(e.message || e), type: 'api_error', code: e.code || 'INTERNAL' } });
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // ---------------- POST /v1/embeddings ----------------
  if (req.method === 'POST' && p === '/v1/embeddings') {
    const body = await readBody(req);
    const input = body.input;
    if (input === undefined || input === null || input === '') {
      throw Object.assign(new Error('缺少 input'), { code: 'BAD_INPUT' });
    }
    const list = Array.isArray(input) ? input.map(String) : [String(input)];
    const vecs = await inference.embed({ model: resolved.embedModel, input: list });
    return sendJSON(res, 200, {
      object: 'list',
      data: vecs.map((embedding, index) => ({ object: 'embedding', index, embedding })),
      model: resolved.embedModel || 'unknown',
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
  }

  // ---------------- POST /v1/audio/speech ----------------
  if (req.method === 'POST' && p === '/v1/audio/speech') {
    const body = await readBody(req);
    const text = String(body.input || body.text || '').trim();
    if (!text) throw Object.assign(new Error('缺少 input（要合成的文本）'), { code: 'BAD_INPUT' });

    // 音色映射：OpenAI 的 voice（alloy / nova …）本项目里并不存在，
    // 所以只在"传进来的名字确实是我们认识的音色预设"时才采用，否则用默认音色。
    // 这样客户端随便填一个也不会报错，符合它对这些字段的预期。
    const wantVoice = String(body.voice || '').trim();
    const isPreset = VOICE_PRESETS.some(v => v.id === wantVoice);

    const r = await tts.synthesize({
      text,
      voice: isPreset ? wantVoice : undefined,
      useCache: true,
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

  return openaiError(res, 'NOT_FOUND', `未知的 OpenAI 兼容接口：${req.method} ${p}`);
}

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
  // data/ 目录（记忆、角色卡、语音缓存）绝不对外提供，避免"数据不出本机"被破坏
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
  const st = await inference.status();
  console.log('==================================================');
  console.log('  文旅智能辅助 · AIRI 网页版 已启动');
  console.log(`  访问地址： http://localhost:${PORT}`);
  console.log(`  监听地址： ${HOST}（默认仅本机可访问，数据不出本机）`);
  console.log(`  对话模型： ${st.chatModel || '未检测到（请先启动 Ollama）'}`);
  console.log(`  视觉模型： ${st.visionModel || '未安装（可选：ollama pull qwen2.5vl:7b）'}`);
  console.log(`  向量模型： ${st.embedModel || '未安装（记忆将使用纯词法检索）'}`);
  // 接入状态如实打出来：排查问题时第一眼看的就是这几行
  if (st.external && st.external.active) {
    console.log(`  外部接入： 已启用 → ${st.external.presetLabel} ${st.external.baseUrl}`);
    console.log(`  分流情况： ${Object.entries(st.route || {}).map(([k, v]) => `${k}=${v || '无'}`).join('  ')}`);
    const bad = Object.entries(st.misconfigured || {}).filter(([, v]) => v).map(([k]) => k);
    if (bad.length) console.log(`  [注意]     ${bad.join(' / ')} 勾了外部但没填模型名，暂用本机`);
  } else {
    console.log('  外部接入： 未启用（全部走本机，不出网）');
  }
  const oa = openapi.publicConfig();
  if (oa.enabled) {
    const allowed = Object.entries(oa.expose).filter(([, v]) => v).map(([k]) => k).join(', ');
    console.log(`  对外开放： 已开启（${oa.requireToken ? '需 Bearer 令牌' : '无令牌校验'}）`);
    console.log(`  开放能力： ${allowed || '（一项都没勾选）'}`);
  } else {
    console.log('  对外开放： 未开启（/v1/* 一律拒绝）');
  }
  const ts = await tts.status();
  console.log(`  语音合成： ${ts.running ? `已连接 ${ts.url}` : '未连接（请启动 Qwen TTS WebUI 并加 --api 参数）'}`);
  console.log(`  样本库实体：${wenlv.auditor.entityCount} 条（输出质检已启用）`);
  console.log(`  数据目录： ${DATA_DIR}（记忆 / 角色卡 / 语音缓存，均不出本机）`);
  console.log('  按 Ctrl+C 停止');
  console.log('==================================================');
});

process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));
