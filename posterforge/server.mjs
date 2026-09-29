#!/usr/bin/env node
/**
 * server.mjs —— poster-forge 站点服务器
 *
 * 设计原则：
 *   1. 零运行时依赖：只用 Node 内置模块（node:http / fs / path / child_process）。
 *      「本地部署」的敌人是依赖树，不是代码量。这样解压即跑，不用 npm install。
 *   2. 生成是真链路：/api/generate 真的去调 poster-forge 的 Python 渲染器，
 *      不是返回假图。跑不通就如实报错，方便排查环境问题。
 *   3. 静态资源与 API 同端口，省掉 CORS 和反代配置。
 *
 * 用法：
 *   node server.mjs               # 默认 8787 端口
 *   node server.mjs --port 9000
 */

import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, stat, unlink, rm } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
// 本地出图：diffusers 直接加载 SDXL-Turbo，不需要任何常驻服务（原 comfy.mjs 那条路
// 要求用户先手动点 ComfyUI 启动器，而那个启动器上还印着与实际模型不符的 MiniMax-H3）。
// 旧客户端保留在仓库里以便对照，但站点已不再走它。
import {
  generateImage as aigenGenerate, status as aigenStatus, interrupt as aigenInterrupt,
  envCheck as aigenEnvCheck, preload as preloadAigen, AIGEN_MODEL, AigenError,
} from "./aigen.mjs";
import { fetchFeeds, createFeedCache, SOURCES } from "./feeds.mjs";
// 模板检索增强：nomic-embed-text 向量 + 余弦 + 采纳反馈增益（不训练模型，见该模块注释）
import {
  buildIndex as buildTemplateIndex, rank as rankTemplates, rankStatus as templateRankStatus,
  RankError as TemplateRankError,
} from "./templates-rank.mjs";
// 模板联网轮换：从每日灵感图里提取**配色倾向**（只取元数据，图片不进成品），
// 据此调整模板推荐顺序，让模板区每天有依据地不一样。
import { getRotation, applyRotation } from "./templates-rotate.mjs";
// 文案大脑：让大模型决定"生成什么"（读图 + 写文案），几何仍由渲染器算
import {
  loadBrainConfig, brainStatus, composeCopy, BrainError,
  BRAIN_LAYOUTS, BRAIN_KINDS, deriveImagePrompt, unloadModels, analyzeLayout, assistantChat,
} from "./brain.mjs";
// 版面几何：服务端与浏览器共用同一份，避免两条路渲出两种版式
import { buildPosterSpecFrom, buildCheckinSpecFrom, POSTER_TONES, POSTER_COMPOSITIONS } from "./public/poster-layout.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = __dirname;
const REPO_ROOT = path.dirname(SITE_ROOT);
// 渲染引擎在哪。
//
// v8.0 把项目合并时，原来平级的 `poster-forge/` 改名成了 `renderer/`。
// 这里**两个名字都认**：先找 renderer，没有再退回 poster-forge。
// 为什么不用单一名字：改名只改了目录，代码里写死的路径不会自己跟着变 ——
// 实测合并后 `/api/health` 报 `渲染器=False`，接口 200 但出图全废。
// 兼容两种名字，无论目录叫哪个都能跑。
// 也支持用 PF_FORGE_ROOT 环境变量显式指定（引擎装在别处时用）。
const FORGE_ROOT = (() => {
  if (process.env.PF_FORGE_ROOT && existsSync(process.env.PF_FORGE_ROOT)) return process.env.PF_FORGE_ROOT;
  for (const name of ["renderer", "poster-forge"]) {
    const p = path.join(REPO_ROOT, name);
    if (existsSync(path.join(p, "render.py"))) return p;
  }
  return path.join(REPO_ROOT, "renderer");   // 都没有时给个明确的预期路径，好让报错看得懂
})();
const PUBLIC_DIR = path.join(SITE_ROOT, "public");
const WORK_DIR = path.join(SITE_ROOT, ".work");        // 生成中间产物
const OUT_DIR = path.join(SITE_ROOT, "public", "generated");
const UPLOAD_DIR = path.join(SITE_ROOT, "public", "uploads");   // 用户上传的照片与 AI 背景
const COPYBOOK_DIR = path.join(SITE_ROOT, "public", "copybooks"); // 生成的 PDF 手册
const CACHE_DIR = path.join(SITE_ROOT, ".cache");                 // 联网素材缓存（含灵感图）
const ROTATE_FILE = path.join(CACHE_DIR, "templates-rotate.json"); // 当天的模板轮换结果
// 出图历史：用户生成过的每一张都留一条，能回看、能重新下载、能看当时用的模板与文案。
// 为什么单独一个文件而不是塞进 generated/：图会被清理（按数量/天数），
// 但"我什么时候做过什么"这个记录不该跟着图一起消失。
const HISTORY_FILE = path.join(SITE_ROOT, "history.json");
const HISTORY_MAX = 300;

function loadHistory() {
  try {
    const raw = JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(raw.items) ? raw.items : [];
  } catch { return []; }
}

/**
 * AI 助手的个性化设置。
 *
 * 存在单独一个文件而不是塞进 brain.config.json：
 * 那个是"项目怎么连模型"的部署配置，这个是**用户的个人偏好**（叫它什么、什么语气、
 * 开不开虚拟形象）。混在一起会让"改个称呼"看起来像在改部署。
 */
const ASSISTANT_FILE = path.join(SITE_ROOT, "assistant.json");
const ASSISTANT_DEFAULTS = {
  avatar: false,        // 虚拟形象**默认关闭** —— 它是重资源，不该拖慢默认使用
  avatarModel: "hiyori",
  nickname: "小旅",
  style: "",            // 表达风格：简短 / 详细 / 幽默 …
  persona: "",          // 自定义人设，覆盖默认
};

function loadAssistantPrefs() {
  try {
    const raw = JSON.parse(readFileSync(ASSISTANT_FILE, "utf8"));
    return { ...ASSISTANT_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  } catch { return { ...ASSISTANT_DEFAULTS }; }
}

function saveAssistantPrefs(patch) {
  const cur = loadAssistantPrefs();
  const next = { ...cur };
  for (const k of Object.keys(ASSISTANT_DEFAULTS)) {
    if (k in patch) next[k] = patch[k];
  }
  // 只收白名单字段，长度也夹一下 —— 这些值会被拼进系统提示词
  next.avatar = !!next.avatar;
  next.nickname = String(next.nickname || "").slice(0, 20);
  next.style = String(next.style || "").slice(0, 40);
  next.persona = String(next.persona || "").slice(0, 400);
  // 可选的虚拟形象。**必须和 public/avatar/models/ 下的目录一一对应。**
  // 踩过的坑：原来写的是 ["hiyori","haru","mao"] —— haru 根本不存在，
  // 而 hanfu / mudan / cangyixiu 会被这里**静默拒绝**、退回 hiyori：
  // 用户选了"汉服"、保存、再看变成"日和"，且没有任何报错。
  // 白名单和实际资源不一致时，静默回退比报错更难查。
  next.avatarModel = ["hiyori", "mao", "hanfu", "mudan", "cangyixiu"].includes(next.avatarModel)
    ? next.avatarModel : "hiyori";
  try { writeFileSync(ASSISTANT_FILE, JSON.stringify(next, null, 2), "utf8"); } catch { /* 写不进去就用内存里的 */ }
  return next;
}

/** 记一条出图历史。失败不影响出图本身 —— 记录是附带的，不该拖累主流程。 */function recordHistory(entry) {
  try {
    const items = loadHistory();
    items.unshift({ id: "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), ...entry });
    writeFileSync(HISTORY_FILE, JSON.stringify({ version: 1, items: items.slice(0, HISTORY_MAX) }, null, 2), "utf8");
  } catch (e) {
    console.warn("[history] 记录失败:", e.message);
  }
}
// 自生成底图的缓存目录：同一提示词只生成一次，保证可复现、也省 18 秒/张
const BG_CACHE_DIR = path.join(UPLOAD_DIR, ".bgcache");

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;  // 单文件 12 MB（手机原图足够）
const ALLOWED_IMAGE_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

// ---------------------------------------------------------------- 配置
// Python 解释器：可用环境变量覆盖，默认走 devenv，再退到 PATH 上的 python。
function findPython() {
  const cands = [
    process.env.PF_PYTHON,
    "E:\\devenv\\Scripts\\python.exe",
    "python",
    "python3",
  ].filter(Boolean);
  for (const c of cands) {
    if (c.includes(path.sep) || c.includes("/")) {
      if (existsSync(c)) return c;
    } else {
      return c; // 交给 PATH 解析
    }
  }
  return "python";
}
const PYTHON = findPython();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jp2": "image/jp2",
  ".qoi": "image/qoi",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};

// ---------------------------------------------------------------- 图片归一化
//
// 手机竖拍的照片存成横向 + 一个 EXIF Orientation 标签。三处都需要正确方向：
//   1. 浏览器 <img> 预览 —— 多数浏览器会自动应用 EXIF，但不能依赖
//   2. 渲染器 —— 它按像素读，不做校正就横着进版式
//   3. 隐私 —— EXIF 里常含 GPS 定位
// 所以落盘时就用 PIL 转正并**去掉 EXIF**，后续所有环节都拿到干净的图。
const NORMALIZE_HELPER = `
import io, os, sys, json
from PIL import Image, ImageOps

p = sys.argv[1]
suffix = os.path.splitext(p)[1].lower()
report = {"converted": False}

def finish(im, orient, via):
    """转正 + 去 EXIF + 按真实格式另存。

    坑（真踩过）：早先这里按**文件后缀**选保存格式（.png 存 PNG，其它存 JPEG），
    于是 WebP/BMP/TIFF/GIF 一律被当成 JPEG 保存 —— 文件没报错，内容却已经不是原图了。
    现在按 PIL 识别到的真实格式存。
    """
    fixed = ImageOps.exif_transpose(im)
    fmt = (fixed.format or im.format or "").upper()
    # 动图只取第一帧：海报只用一张静态图
    if fmt == "GIF" and getattr(fixed, "n_frames", 1) > 1:
        fixed.seek(0)
    if fmt in ("JPEG", "JPG", "MPO"):
        out = fixed if fixed.mode == "RGB" else fixed.convert("RGB")
        out.save(p, "JPEG", quality=92, optimize=True)
    elif fmt == "PNG" or fixed.mode in ("RGBA", "LA", "P"):
        out = fixed if fixed.mode in ("RGB", "RGBA") else fixed.convert("RGBA")
        out.save(p, "PNG", optimize=True)
    else:
        # WebP / BMP / TIFF / AVIF / ICO / QOI ... 原样格式重存即可
        out = fixed if fixed.mode in ("RGB", "RGBA") else fixed.convert("RGB")
        out.save(p, fmt or "PNG")
    report["orientation"] = orient
    report["rotated"] = orient not in (None, 1)
    report["size"] = list(out.size)
    report["via"] = via
    return out

try:
    im = Image.open(p)
    try:
        orient = im.getexif().get(274)
    except Exception:
        orient = None
    finish(im, orient, "PIL")
except Exception as pil_err:
    # PIL 打不开 —— 目前实测只有 HEIC/HEIF 会走到这里。
    # 用 PyAV（FFmpeg 的 HEVC 解码器）解出第一帧，转成 JPEG 落盘，
    # 这样渲染器那条 PIL-only 的路径也能吃下 iPhone 照片。
    try:
        import av
        c = av.open(p)
        frame = None
        for fr in c.decode(video=0):
            frame = fr
            break
        c.close()
        if frame is None:
            raise ValueError("没有可解码的帧")
    except Exception as av_err:
        # 两条路都解不开：明确告诉调用方"这个文件不能用"，
        # 由服务端拒绝上传。放行的话错误会推迟到"生成"那一刻才爆，
        # 而且报错跟用户上传的图对不上，很难查。
        sys.stderr.write("UNDECODABLE: %s / %s" % (pil_err, av_err))
        sys.exit(3)   # 约定：3 = 认得出但解不开，调用方据此拒绝上传
    img = frame.to_image()
    if img.mode != "RGB":
        img = img.convert("RGB")
    jpg = os.path.splitext(p)[0] + ".jpg"
    img.save(jpg, "JPEG", quality=92, optimize=True)
    if os.path.abspath(jpg) != os.path.abspath(p):
        try:
            os.remove(p)
        except Exception:
            pass
    report.update({"converted": True, "to": jpg, "size": list(img.size),
                   "orientation": None, "rotated": False, "via": "PyAV"})

print(json.dumps(report))
`;

// HEIC/HEIF 解不了码时用的备用解释器（ComfyUI 便携版自带 PyAV/FFmpeg）。
// 为什么不让主解释器干：devenv 里没有 pip，装不了 pillow-heif，
// 而便携版那个 python 里 av / cv2 / PIL 都是现成的，直接借来用。
const COMFY_PYTHON = process.env.PF_HEIC_PYTHON ||
  path.join("E:\\ComfyUI_windows_portable", "python_embeded", "python.exe");

async function normalizeOrientation(absPath) {
  const helperPath = path.join(WORK_DIR, "normalize-exif.py");
  try {
    await mkdir(WORK_DIR, { recursive: true });
    await writeFile(helperPath, NORMALIZE_HELPER, "utf8");
    // 先用站点自带解释器；HEIC 会失败，再借便携版解释器解一次
    const runners = [PYTHON];
    if (existsSync(COMFY_PYTHON)) runners.push(COMFY_PYTHON);

    let info = null;
    let undecodable = false;
    for (const py of runners) {
      const r = await run(py, [helperPath, absPath], { cwd: SITE_ROOT });
      if (r.code === 3) { undecodable = true; continue; }
      if (r.code !== 0) continue;
      const line = (r.out || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
      try {
        info = JSON.parse(line);
        break;
      } catch {
        continue;
      }
    }
    // 认得出是图片、但本机真的解不开：直接判失败，别让它进系统等渲染时才炸。
    // 这个标记由调用方检查，决定是否拒绝这次上传。
    if (!info) return undecodable ? { undecodable: true } : null;

    // 转码过（HEIC → JPEG）时文件名变了，调用方必须用新名字，
    // 否则 URL 指向一个已经被删掉的文件。
    const outPath = info.converted && info.to ? info.to : absPath;
    const st = await stat(outPath);
    return { ...info, file: outPath, bytes: st.size };
  } catch {
    // 归一化失败不应阻断上传 —— 原图仍然可用，渲染器还有自己的兜底校正
    return null;
  }
}

// ---------------------------------------------------------------- 工具
// 图片魔数校验：不看客户端声明的 MIME，只看真字节 —— 声明是可以伪造的。
//
// 这里认的格式，必须同时满足两条，否则宁可拒绝：
//   1. 能靠**固定魔数**认出来（避免误判，比如 TGA 没有魔数就不收）
//   2. 下游 PIL 打得开（渲染器只走 PIL；HEIC/HEIF 例外，靠 PyAV 转码后落 JPEG）
// 只放行第 1 条会造成"收得下、画不出"，比直接拒绝更糟。
function sniffImage(buf) {
  if (buf.length < 16) return null;
  const ascii = (s, e) => buf.toString("ascii", s, e);

  if (buf[0] === 0x89 && ascii(1, 4) === "PNG") return { ext: ".png", mime: "image/png" };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: ".jpg", mime: "image/jpeg" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { ext: ".webp", mime: "image/webp" };
  if (ascii(0, 3) === "GIF") return { ext: ".gif", mime: "image/gif" };
  if (buf[0] === 0x42 && buf[1] === 0x4d) return { ext: ".bmp", mime: "image/bmp" };
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00)) {
    return { ext: ".tiff", mime: "image/tiff" };
  }
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
    return { ext: ".ico", mime: "image/x-icon" };
  }
  if (ascii(0, 4) === "qoif") return { ext: ".qoi", mime: "image/qoi" };
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    // WebP 之外，PIL 还认 jp2/jpx 与 avif；HEIC/HEIF 走 PyAV 转 JPEG
    if (brand === "avif" || brand === "avis") return { ext: ".avif", mime: "image/avif" };
    if (/^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(brand)) {
      return { ext: ".heic", mime: "image/heic" };
    }
    if (/^(jp2|jpx|jpm)$/.test(brand)) return { ext: ".jp2", mime: "image/jp2" };
  }
  return null;
}

// PIL 能识别的图片格式（用于拒绝伪装成图片的文件）
function safeBaseName(name) {
  return String(name || "upload")
    .replace(/[^\w.\-\u4e00-\u9fa5]/g, "_")
    .slice(0, 60);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("请求体过大（上限 2 MB）");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      ...opts,
      windowsHide: true,
      env: {
        ...process.env,
        // 把站点的 public/ 告诉渲染器：用户上传的照片与 AI 背景图存在那里，
        // spec 里的路径是相对站点的（如 "uploads/xxx.png"）。
        PF_IMAGE_ROOT: PUBLIC_DIR,
        // 关键：python.exe 输出到**管道**时默认用系统 ANSI 编码（中文 Windows 上是 GBK），
        // 而 Node 按 UTF-8 读 —— 结果是校验器的中文报错全变成乱码。
        // 终端里手跑不会暴露这个问题，只有作为子进程被读输出时才会。
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        ...(opts.env || {}),
      },
    });
    let out = "";
    let err = "";
    // 显式按 UTF-8 解码，并保留残缺字节而不是静默丢字符
    p.stdout.on("data", (d) => (out += d.toString("utf8")));
    p.stderr.on("data", (d) => (err += d.toString("utf8")));
    p.on("error", (e) => resolve({ code: -1, out, err: err + String(e) }));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

async function serveStatic(res, absPath) {
  try {
    const st = await stat(absPath);
    if (!st.isFile()) throw new Error("not a file");
    let data = await readFile(absPath);
    const ext = path.extname(absPath).toLowerCase();
    const base = path.basename(absPath);

    // HTML 里给助手组件带上**版本号**。
    //
    // 为什么非做不可：`no-cache` 只对"新收到的响应"生效。用户浏览器里
    // 可能还存着改之前用 max-age=3600 缓存的那份，没过期就**不会去问服务器** ——
    // 拿不到新的缓存头，也拿不到新文件。表现就是"海报页和门户还是旧版，
    // 只有旅游规划页是新的"。
    // 换 URL 是唯一能绕过它的办法：地址变了，浏览器就当新资源。
    if (ext === ".html") {
      let text = data.toString("utf8");
      if (text.indexOf("/ai-ball.js") >= 0) {
        const av = await stat(path.join(PUBLIC_DIR, "ai-ball.js")).catch(() => null);
        const v = av ? Math.round(av.mtimeMs).toString(36) : "1";
        text = text.replace(/\/ai-ball\.js(\?[^"']*)?/g, "/ai-ball.js?v=" + v);
      }
      data = Buffer.from(text, "utf8");
    }

    // 助手组件、主脚本、模板缩略图**都必须每次回源校验**。
    //
    // 踩过的坑（两回）：
    //  1) 给 ai-ball.js 设 max-age=3600，我改了组件，用户刷新看到的还是旧版；
    //  2) 重渲了 41 张缩略图（配上实拍图，好让七种构图看得出区别），
    //     但缩略图 URL 没变、还带 3600 缓存 —— 用户看到的仍是旧的纯渐变图，
    //     反馈"两个功能页都没改变"。
    // 结论：**会被迭代覆盖的静态资源，一律不许长缓存。**
    // 缩略图虽然多，但都是几十 KB，回源校验（304）比"改了看不见"便宜得多。
    const isThumb = absPath.includes(path.sep + "thumbs" + path.sep);
    const noCache = ext === ".html" || isThumb ||
      base === "ai-ball.js" || base === "app.js" || base === "style.css";
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": data.length,
      // 缩略图允许缓存，HTML/脚本不缓存（方便改完刷新就见效）
      "cache-control": noCache ? "no-cache, must-revalidate" : "public, max-age=3600",
      etag: `W/"${data.length}-${Math.round(st.mtimeMs)}"`,
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404");
  }
}

// ---------------------------------------------------------------- 数据
const CATEGORIES = [
  { id: "poster", name: "海报", en: "Poster" },
  { id: "checkin", name: "打卡", en: "Check-in" },
  { id: "copybook", name: "手册", en: "Copybook" },
];

// 模板库从 templates.json 读（而不是硬编码）。
// 为什么要外置：模板现在不只用于展示卡片，还要能「套用」——
// 需要 brief（可直接编辑的示例内容）、tone（调性）、layout（版式）这些字段，
// 而且后续要按用户反馈调整排序权重，硬编码在源码里改不动。
const TEMPLATES_FILE = path.join(SITE_ROOT, "templates.json");
// 用户自己存下来的模板放**独立文件**。
// 为什么不合进 templates.json：那个文件是随版本更新的内置库，
// 用户数据混在里面，一次升级就可能被覆盖掉。
const USER_TEMPLATES_FILE = path.join(SITE_ROOT, "templates-user.json");

function readTemplateFile(file, source) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return (Array.isArray(raw.templates) ? raw.templates : []).map((t) => ({ ...t, source }));
  } catch {
    return [];
  }
}

function loadTemplates() {
  try {
    const builtin = readTemplateFile(TEMPLATES_FILE, "local");
    const user = readTemplateFile(USER_TEMPLATES_FILE, "user");
    return [...builtin, ...user].map((t) => ({
      id: t.id,
      title: t.title,
      audience: t.audience,
      tags: t.tags || [],
      likes: t.likes ?? 0,
      comments: t.comments ?? 0,
      featured: !!t.featured,
      // 「套用」需要的字段
      brief: t.brief || "",
      tone: typeof t.tone === "number" ? t.tone : null,
      layout: t.layout || null,
      // 构图：决定这套模板套出来是什么版面（对齐/图文关系/标题占比）。
      // 不加进这个白名单的话前端拿不到，41 套模板会退回同一套骨架 —— 那正是要修的问题。
      composition: t.composition || null,
      // 变体：同一构图内的字号与留白差异。不带上它的话，
      // 同构图的十几套模板又会渲染成一模一样的几何。
      variant: t.variant || null,
      // 逐套精调：位置与字号的档位。不带的话同构图同变体会渲染成一模一样。
      tuning: t.tuning && typeof t.tuning === "object"
        ? { y: Number(t.tuning.y) || 0, s: Number(t.tuning.s) || 1 } : null,
      thumb: t.thumb || (t.source === "user" ? "" : `thumbs/${t.id}.jpg`),
      // 列表用小图（240×320）。大图 540×720 一并解码 41 张要占 ~63MB 位图内存，
      // 而列表里只显示 48~220px 宽 —— 多出来的像素全白解码，是页面卡的主因。
      // 预览弹层仍用大图（那里真的要看清）。
      thumbSmall: t.thumb || (t.source === "user" ? "" : `thumbs/s/${t.id}.jpg`),
      // 采纳次数：用户点了几次「套用」，用于检索排序（见 templates-rank.mjs）
      picked: t.picked ?? 0,
      source: t.source || "local",
      createdAt: t.createdAt || null,
    }));
  } catch (e) {
    console.warn("[templates] 读取模板失败：", e.message);
    return [];
  }
}

let TEMPLATES = loadTemplates();

/**
 * 广告法禁用词，**从 validate.py 读**，不在服务端再抄一份。
 *
 * 为什么不在服务端写死：这个词表已经有两份副本（validate.py 与前端预检），
 * 再加一份就是三处维护，必然漂移。validate.py 是权威源，直接解析它。
 * 只在启动时读一次；读不到就返回空数组（预检失效但不影响主流程，
 * 真正出图时 validate.py 仍会拦）。
 */
function loadAdLawBanned() {
  try {
    const src = readFileSync(path.join(FORGE_ROOT, "validate.py"), "utf8");
    const m = src.match(/AD_LAW_BANNED\s*=\s*\[([\s\S]*?)\]/);
    if (!m) return [];
    return (m[1].match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1));
  } catch (e) {
    console.warn("[adlaw] 读取 validate.py 词表失败：", e.message);
    return [];
  }
}
const AD_LAW_BANNED = loadAdLawBanned();

/** 合法的构图名集合 —— 用来挡掉前端传来的野值 */
const RE_COMPOSITIONS = new Set(Object.keys(POSTER_COMPOSITIONS));

/** 本地预检：只查硬禁词（需资质词交给 validate.py 出 warning） */
function checkAdLaw(text) {
  const t = String(text || "");
  const hard = AD_LAW_BANNED.filter((w) => w && t.includes(w));
  return { hard, clean: hard.length === 0 };
}

// ---- 模板向量索引（懒加载 + 落盘缓存）----
// 懒加载的理由：建索引要对每套模板调一次嵌入模型，没用到检索时不该付这个成本。
const TEMPLATE_INDEX_FILE = path.join(SITE_ROOT, ".cache", "templates-embed.json");
let templateIndex = null;
let templateIndexBusy = null;
// 当天的模板轮换结果。**必须放在模块作用域** ——
// 原先声明在 /api/templates 的 if 块里，/api/templates/rotate 在外面给它赋值，
// 严格模式下直接 ReferenceError（表现为那个路由恒定 500）。
let rotation = null;

async function ensureTemplateIndex(templates) {
  if (templateIndex) return templateIndex;
  // 并发去重：同时来几个请求时只建一次
  if (!templateIndexBusy) {
    templateIndexBusy = buildTemplateIndex(templates, TEMPLATE_INDEX_FILE, {
      log: (m) => console.log("[templates-rank]", m),
    }).then((r) => {
      if (r.added) console.log(`[templates-rank] 索引更新：新增/重算 ${r.added} 套，复用 ${r.reused} 套`);
      templateIndex = r.index;
      return r.index;
    }).finally(() => { templateIndexBusy = null; });
  }
  return templateIndexBusy;
}

async function rebuildTemplateIndex(templates) {
  templateIndex = null;
  const r = await buildTemplateIndex(templates, TEMPLATE_INDEX_FILE, {
    log: (m) => console.log("[templates-rank]", m),
  });
  templateIndex = r.index;
  return { ...templateRankStatus(r.index), reused: r.reused, added: r.added };
}

// 案例/资讯演示数据（CASES、FEED）已随对应页面区块删除，原件留档在 site/deleted-cases.json。
// 「每日灵感」用的是 feeds.mjs 的真实联网图源，与这里的 FEED 无关。

const CAPABILITIES = [
  { id: "poster", name: "海报生成", desc: "提示词 + 图片 + 模板 → 宣传海报", icon: "poster" },
  { id: "template", name: "套用模板", desc: "从模板库挑一套，内容直接填好再改", icon: "template" },
  { id: "checkin", name: "打卡模板", desc: "对话 + 照片 → 可发布打卡卡", icon: "checkin" },
  { id: "copybook", name: "文案手册", desc: "一键生成多页互联网宣传手册", icon: "book" },
  { id: "batch", name: "批量出图", desc: "一套内容，多尺寸多平台分发", icon: "grid" },
  { id: "history", name: "历史记录", desc: "回看生成过的图，可重新下载或删掉", icon: "history" },
  // 「图片分析」**不做独立入口** —— 它是辅助生成的手段，不是一种生成模式。
  // 独立成一个菜单项会让用户以为"分析完能得到什么成品"，其实它只是帮你选版式。
  // 现在它是生成区里的一个按钮（见 index.html 的 anaBtn），在这几个模式下都能用。
];

// ---------------------------------------------------------------- 生成链路
async function generate(spec, { timeoutMs = 180000 } = {}) {
  await mkdir(WORK_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const specPath = path.join(WORK_DIR, `${stamp}.spec.json`);
  const outPath = path.join(OUT_DIR, `${stamp}.png`);

  await writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");

  // 1) 先校验：结构 / 颜色令牌 / 广告法。错误当场返回，不浪费一次渲染。
  const v = await run(PYTHON, [path.join(FORGE_ROOT, "validate.py"), "--spec", specPath], {
    cwd: FORGE_ROOT,
  });
  const validation = (v.out + v.err).trim();
  if (v.code !== 0) {
    return { ok: false, stage: "validate", message: validation, code: v.code };
  }

  // 2) 渲染
  const r = await run(
    PYTHON,
    [path.join(FORGE_ROOT, "render.py"), "--spec", specPath, "--out", outPath],
    { cwd: FORGE_ROOT }
  );
  const renderLog = (r.out + r.err).trim();
  if (r.code !== 0 || !existsSync(outPath)) {
    return { ok: false, stage: "render", message: renderLog, code: r.code };
  }

  const st = await stat(outPath);
  return {
    ok: true,
    url: `/generated/${path.basename(outPath)}`,
    bytes: st.size,
    validation,
    renderLog,
  };
}

// ---------------------------------------------------------------- 文案手册
const COPYBOOK_SPEC_REQUIRED = ["meta", "theme", "sections"];

// 注意这里的分工：结构/调色板/合规的细查交给 validate-copybook.py，
// 服务端只做"够不够格去校验"的粗筛（必填字段、版块类型）。
// 词表与判定规则只维护一份，避免两套标准漂移。
async function validateCopybook(specPath) {
  const r = await run(
    PYTHON,
    [path.join(FORGE_ROOT, "validate-copybook.py"), "--spec", specPath, "--json"],
    { cwd: FORGE_ROOT }
  );
  const raw = (r.out || "").trim();
  let parsed = null;
  try {
    // 取最后一行 JSON —— 避免任何前置输出干扰解析
    const line = raw.split(/\r?\n/).filter(Boolean).pop() || "";
    parsed = JSON.parse(line);
  } catch {
    /* 落到下面的兜底 */
  }
  if (!parsed) {
    return {
      ok: false,
      errors: ["校验器无法执行：\n" + (raw + r.err).trim().slice(0, 500)],
      warnings: [],
    };
  }
  return parsed;
}

async function generateCopybook(spec, { timeoutMs = 300000 } = {}) {
  for (const k of COPYBOOK_SPEC_REQUIRED) {
    if (!spec || !(k in spec)) {
      return {
        ok: false,
        stage: "structure",
        errors: [`手册 spec 缺少必填字段: ${k}`],
        warnings: [],
        message: `手册 spec 缺少必填字段: ${k}`,
      };
    }
  }
  await mkdir(WORK_DIR, { recursive: true });
  await mkdir(COPYBOOK_DIR, { recursive: true });

  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const specPath = path.join(WORK_DIR, `copybook-${stamp}.spec.json`);
  const pdfPath = path.join(COPYBOOK_DIR, `${stamp}.pdf`);
  const pngDir = path.join(COPYBOOK_DIR, `${stamp}-pages`);

  await writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");

  // ---- 第一步：校验。不通过就返回报告，不浪费一次渲染 ----
  const v = await validateCopybook(specPath);
  if (!v.ok) {
    return {
      ok: false,
      stage: "validate",
      errors: v.errors || [],
      warnings: v.warnings || [],
      message: `校验未通过（${(v.errors || []).length} error / ${(v.warnings || []).length} warning）`,
    };
  }

  // ---- 第二步：渲染 ----
  const r = await run(
    PYTHON,
    [path.join(SITE_ROOT, "copybook.py"), "--spec", specPath, "--out", pdfPath, "--png-dir", pngDir],
    { cwd: SITE_ROOT, timeoutMs }
  );
  const log = (r.out + r.err).trim();
  if (r.code !== 0 || !existsSync(pdfPath)) {
    return {
      ok: false,
      stage: "render",
      errors: [log || `退出码 ${r.code}`],
      warnings: v.warnings || [],
      message: log || `退出码 ${r.code}`,
      code: r.code,
    };
  }

  const st = await stat(pdfPath);
  let pageFiles = [];
  try {
    pageFiles = (await readdir(pngDir))
      .filter((f) => f.endsWith(".png"))
      .sort()
      .map((f) => `/copybooks/${path.basename(pngDir)}/${f}`);
  } catch {
    /* 预览页缺失不影响 PDF 交付 */
  }

  return {
    ok: true,
    url: `/copybooks/${path.basename(pdfPath)}`,
    pages: pageFiles,
    pageCount: pageFiles.length || (spec.sections || []).length,
    bytes: st.size,
    validation: v.ok ? `校验通过（${(v.warnings || []).length} warning）` : "",
    warnings: v.warnings || [],
    log,
  };
}

// ---------------------------------------------------------------- 目录清理
//
// 上传目录与产出目录会无限增长。这不是"以后再说"的问题 ——
// 一次游客批量上传就是几十 MB，跑一周就能吃掉几个 GB。
//
// 策略：按「最多个数」+「最长天数」**双条件**保留，两个都满足才删。
//
// ⚠ 这个取舍要清楚：数量上限只在文件同时过期时才生效，
//   所以**磁盘占用没有硬上限**。好处是绝不会删掉用户刚上传的文件
//   （那比占空间严重得多）；代价是密集使用期间目录会持续变大。
//   运维上用 GET /api/storage 观察增长，必要时调小这两个阈值。
const KEEP_RULES = {
  uploads: { maxFiles: 200, maxAgeDays: 30 },
  generated: { maxFiles: 200, maxAgeDays: 7 },
  copybooks: { maxFiles: 100, maxAgeDays: 30 },
};

async function cleanDir(dir, { maxFiles, maxAgeDays }) {
  if (!existsSync(dir)) return { dir, removed: 0, kept: 0, freedBytes: 0 };
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { dir, removed: 0, kept: 0, freedBytes: 0 };
  }

  const items = [];
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    try {
      // 手册的预览页是目录（xxx-pages），一并按同一规则处理
      const st = await stat(abs);
      items.push({ abs, name: e.name, isDir: e.isDirectory(), mtime: st.mtimeMs, size: st.size });
    } catch {
      /* 忽略读不到的项目 */
    }
  }

  items.sort((a, b) => b.mtime - a.mtime); // 新的在前
  const cutoff = Date.now() - maxAgeDays * 86400000;
  let removed = 0;
  let freedBytes = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const tooMany = i >= maxFiles;
    const tooOld = it.mtime < cutoff;
    // 两个条件都满足才删：避免"刚上传但文件数超了"被误删
    if (tooMany && tooOld) {
      try {
        await rm(it.abs, { recursive: it.isDir, force: true });
        removed++;
        freedBytes += it.isDir ? 0 : it.size;
      } catch {
        /* 删除失败不影响其它项 */
      }
    }
  }
  return { dir: path.basename(dir), removed, kept: items.length - removed, freedBytes };
}

async function cleanAll() {
  const out = [];
  out.push(await cleanDir(UPLOAD_DIR, KEEP_RULES.uploads));
  out.push(await cleanDir(OUT_DIR, KEEP_RULES.generated));
  out.push(await cleanDir(COPYBOOK_DIR, KEEP_RULES.copybooks));
  return out;
}

// ---------------------------------------------------------------- 联网素材
//
// 配置来源优先级：环境变量 > site/feed.config.json > 内置默认。
// key 只放在本地文件或环境变量里，不进前端、不进仓库。
const FEED_CONFIG_FILE = path.join(SITE_ROOT, "feed.config.json");
const FEED_CACHE_FILE = path.join(SITE_ROOT, ".cache", "feed.json");
const feedCache = createFeedCache(FEED_CACHE_FILE);

async function loadFeedConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(await readFile(FEED_CONFIG_FILE, "utf8"));
  } catch {
    /* 没有配置文件就用默认 */
  }
  const env = { ...process.env };
  // 配置文件里的 keys 注入 env（供 feeds.mjs 的 envKey 查找）
  for (const [k, v] of Object.entries(fileCfg.keys || {})) {
    if (v && !env[k]) env[k] = v;
  }
  return {
    sources: fileCfg.sources || ["bing", "picsum", "pexels", "unsplash"],
    count: Number(fileCfg.count) || 8,
    query: fileCfg.query || "travel",
    autoRefreshHours: Number(fileCfg.autoRefreshHours) || 12,
    env,
  };
}

// ---------------------------------------------------------------- 图片代理
//
// 为什么需要它：
//   1. 浏览器直连第三方图床可能被防盗链/尺寸校验拦掉
//      （实测 Bing 的 _800x450 返回 404，_1920x1080 才可用）
//   2. 本地磁盘缓存 → 断网也能看，且同一张图只下载一次
//   3. 统一在这里加 UA / Referer，不必逐个源调
const IMG_CACHE_DIR = path.join(SITE_ROOT, ".cache", "images");
const IMG_MAX_BYTES = 12 * 1024 * 1024;

async function serveProxiedImage(res, remote) {
  let u;
  try {
    u = new URL(remote);
  } catch {
    return json(res, 400, { ok: false, message: "非法图片地址" });
  }
  // 只允许 http/https，避免 file:// 之类的意外
  if (!/^https?:$/.test(u.protocol)) {
    return json(res, 400, { ok: false, message: "仅支持 http/https" });
  }

  const key = createHash("sha1").update(remote).digest("hex") + (path.extname(u.pathname) || ".jpg");
  const cachePath = path.join(IMG_CACHE_DIR, key);

  // Bing 图床支持在 URL 上直接要尺寸（w/h/c 参数），原图 300KB+ 而卡片只显示 ~300px 宽。
  // 这里统一压到 800px —— 卡片放大看也够，传输量降到约 1/5。
  // 其他图源没有这个参数，原样取，不改写（乱加参数可能让对方返回错误图）。
  if (/(^|\.)bing\.com$/.test(u.hostname) && !u.searchParams.has("w")) {
    u.searchParams.set("w", "800");
    u.searchParams.set("c", "7");
  }
  const fetchUrl = u.toString();

  // 命中缓存：直接回，不打网络
  if (existsSync(cachePath)) {
    try {
      const buf = await readFile(cachePath);
      res.writeHead(200, {
        "content-type": guessMime(key),
        "content-length": buf.length,
        "cache-control": "public, max-age=86400",
        "x-img-cache": "hit",
      });
      return res.end(buf);
    } catch {
      /* 读失败就往下走网络 */
    }
  }

  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    let r;
    try {
      r = await fetch(fetchUrl, {
        headers: { "User-Agent": FEED_UA, Referer: `${u.protocol}//${u.host}/` },
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    if (!r.ok) throw new Error(`远端 HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > IMG_MAX_BYTES) throw new Error(`图片过大（${(buf.length / 1024 / 1024).toFixed(1)} MB）`);

    await mkdir(IMG_CACHE_DIR, { recursive: true });
    await writeFile(cachePath, buf).catch(() => {});

    res.writeHead(200, {
      "content-type": r.headers.get("content-type") || guessMime(key),
      "content-length": buf.length,
      "cache-control": "public, max-age=86400",
      "x-img-cache": "miss",
    });
    res.end(buf);
  } catch (e) {
    json(res, 502, { ok: false, message: `取图失败：${String(e.message || e).slice(0, 160)}` });
  }
}

function guessMime(p) {
  const e = path.extname(p).toLowerCase();
  return e === ".png" ? "image/png" : e === ".webp" ? "image/webp" : "image/jpeg";
}

const FEED_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// ---------------------------------------------------------------- 路由
async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === "/api/upload" && req.method === "POST") {
    let payload;
    try {
      payload = JSON.parse(await readBody(req, 20 * 1024 * 1024));
    } catch (e) {
      return json(res, 400, { ok: false, message: "请求体不是合法 JSON: " + e.message });
    }

    // 前端把文件读成 dataURL（"data:image/png;base64,...."）后提交。
    // 用 base64 而不是 multipart：Node 内置模块不解析 multipart，
    // 而「本地部署零依赖」比省那 33% 传输量更重要。
    const items = Array.isArray(payload.files) ? payload.files : [payload];
    const saved = [];
    const errors = [];

    await mkdir(UPLOAD_DIR, { recursive: true });

    for (const it of items) {
      const raw = it?.dataUrl || it?.data || "";
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(raw));
      if (!m) {
        errors.push({ name: it?.name, reason: "不是合法的 dataURL" });
        continue;
      }
      let buf;
      try {
        buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "binary");
      } catch (e) {
        errors.push({ name: it?.name, reason: "base64 解码失败" });
        continue;
      }
      if (!buf.length) {
        errors.push({ name: it?.name, reason: "空文件" });
        continue;
      }
      if (buf.length > MAX_UPLOAD_BYTES) {
        errors.push({
          name: it?.name,
          reason: `超过上限 ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB（实际 ${(buf.length / 1024 / 1024).toFixed(1)} MB）`,
        });
        continue;
      }

      // 只信真字节，不信客户端声明的 MIME
      const sniff = sniffImage(buf);
      if (!sniff) {
        errors.push({
          name: it?.name,
          reason: "认不出图片格式（按字节校验）。支持 PNG / JPEG / WebP / GIF / BMP / TIFF / AVIF / HEIC，"
            + "HEIC 需本机 ComfyUI 便携版 Python 在位",
        });
        continue;
      }

      const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const fname = `${stamp}-${safeBaseName(it?.name)}`.replace(/\.[^.]*$/, "") + sniff.ext;
      const abs = path.join(UPLOAD_DIR, fname);
      await writeFile(abs, buf);

      // 落盘后做一次方向归一化。
      // 为什么不在 JS 里做：浏览器不会把 EXIF 方向信息交给我们（createImageBitmap 已应用它），
      // 而 Node 侧没有 EXIF 处理能力 —— PIL 的 exif_transpose 是干净解法。
      // 好处有三：预览方向正确、渲染器不必再猜、顺带去掉 EXIF 里的定位等隐私信息。
      const norm = await normalizeOrientation(abs);
      // 认得出是图片但解不开（坏 HEIC、截断的 TIFF 等）：删掉落盘文件并拒收。
      // 早先这里是放行的，结果文件进了系统，直到"生成"那一步才炸，报错还对不上号。
      if (norm?.undecodable) {
        await unlink(abs).catch(() => {});
        errors.push({
          name: it?.name,
          reason: "文件头是图片，但本机解码失败（文件可能损坏或被截断）",
        });
        continue;
      }
      // HEIC → JPEG 转码后文件名变了，URL 必须指向**转码后**那份，
      // 否则前端拿到的是一个已经被删掉的原文件路径（预览必然 404）。
      const finalName = norm?.file ? path.basename(norm.file) : fname;
      saved.push({
        name: it?.name || fname,
        file: finalName,
        url: `/uploads/${finalName}`,
        bytes: norm?.bytes ?? buf.length,
        mime: norm?.converted ? "image/jpeg" : sniff.mime,
        orientation: norm?.orientation ?? null,
        convertedFrom: norm?.converted ? sniff.mime : null,
        normalized: norm ? (norm.via || "PIL") : "未归一化",
      });
    }

    if (!saved.length) {
      return json(res, 400, { ok: false, message: "没有任何文件通过校验", errors });
    }
    return json(res, 200, { ok: true, files: saved, errors });
  }

  if (p === "/api/copybook" && req.method === "POST") {
    let payload;
    try {
      payload = JSON.parse(await readBody(req, 4 * 1024 * 1024));
    } catch (e) {
      return json(res, 400, { ok: false, message: "请求体不是合法 JSON: " + e.message });
    }
    if (!payload.spec) return json(res, 400, { ok: false, message: "缺少 spec" });
    const result = await generateCopybook(payload.spec);
    return json(res, result.ok ? 200 : 422, result);
  }

  // ---- AI 助手：通用对话 + 个性化设置 ----
  //
  // 为什么不转发到 HikiTravel 的 /api/chat：那是**旅游规划**接口。
  // 助手说"你好"，它回"还缺少这些信息：目的地、游玩天数、预算" —— 驴唇不对马嘴。
  // 这里直接用本机 Ollama 做真对话。
  if (p === "/api/assistant/chat" && req.method === "POST") {
    let payload;
    try { payload = JSON.parse(await readBody(req, 512 * 1024)); }
    catch { return json(res, 400, { ok: false, message: "请求体不是合法 JSON" }); }

    const text = String(payload.message || "").trim();
    if (!text) return json(res, 400, { ok: false, message: "没有内容" });
    if (text.length > 2000) return json(res, 400, { ok: false, message: "太长了（上限 2000 字）" });

    const cfgA = loadBrainConfig(SITE_ROOT);
    const prefs = loadAssistantPrefs();
    if (!cfgA.enabled) {
      return json(res, 409, { ok: false, message: "对话已在 brain.config.json 里关闭", code: "brain_disabled" });
    }

    // 人设 + 用户自定义（prefs 由设置面板写入）
    const sys = [
      prefs.persona || "你是「浙里文旅」的助手，帮文旅局、酒店、饭馆做宣传物料，也帮游客做行程。",
      "回答用中文，简洁口语，不要 markdown 标题。你不知道的事就说不确定，不要编造价格、电话、地址。",
      prefs.style ? `表达风格：${prefs.style}。` : "",
    ].filter(Boolean).join("");

    const history = Array.isArray(payload.history) ? payload.history.slice(-8) : [];
    const messages = [
      { role: "system", content: sys },
      ...history.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: String(m.content).slice(0, 1500) })),
      { role: "user", content: text },
    ];

    // SSE：让字一个个蹦出来。本地模型首字要 1~3 秒，不给反馈用户以为卡死了。
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (o) => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch { /* 客户端断了 */ } };
    let closed = false;
    req.on("close", () => { closed = true; });

    try {
      await assistantChat(cfgA, messages, {
        onDelta: (piece) => { if (!closed) send({ type: "delta", text: piece }); },
      });
      if (!closed) send({ type: "done" });
    } catch (e) {
      if (!closed) send({ type: "error", message: e.message, kind: e.kind || null });
    }
    return res.end();
  }

  // 助手面板里的示例问题。**不写死** —— 结合当天联网素材轮换。
  //
  // 写死的问题永远是那四句，用户看两天就腻，也跟当天的热点脱节。
  // 这里用两路真实数据拼：
  //   1. 当日联网素材（Bing 每日壁纸带中文标题，正好是"今天哪儿的景好看"）
  //   2. 模板库（挑几套热门，拼成"帮我做一张…的海报"）
  // 再按时间片轮换，所以每个人每个时段看到的可能不一样。
  if (p === "/api/assistant/prompts" && req.method === "GET") {
    const out = [];
    try {
      const cached = await feedCache.read();
      const items = (cached && cached.items) || [];
      // 每天轮换：用当天日期做种子，同一天内稳定（免得刷新一次变一次，像抽奖）
      const day = Math.floor(Date.now() / 86400000);
      const picks = [];
      for (let i = 0; i < items.length && picks.length < 2; i++) {
        const it = items[(day * 3 + i) % items.length];
        const t = String((it && it.title) || "").replace(/[（(].*?[)）]/g, "").trim();
        // Bing 的标题常是"某地某景"，直接当地名用；太长的截断
        if (t && t.length >= 2 && t.length <= 18 && picks.indexOf(t) < 0) picks.push(t);
      }
      for (const place of picks) {
        // 措辞要经得起"它不是地名"。Bing 的标题多是"金色时节""冰川孕育之河"
        // 这类描述性短语，套进"××秋季出游"会读不通（第一版就是这么写的）。
        // 用「围绕…主题」的说法，是地名还是意象都通顺。
        out.push(`围绕「${place}」写一段秋季出游的宣传文案`);
      }
    } catch { /* 拿不到联网素材就只出模板那几条 */ }

    try {
      const tpls = await loadTemplates();
      const list = (tpls.templates || tpls || []).filter((t) => t.title);
      if (list.length) {
        const day = Math.floor(Date.now() / 86400000);
        const a = list[day % list.length], b = list[(day * 7 + 3) % list.length];
        if (a && a.title) out.push(`帮我做一张${a.title}的海报`);
        if (b && b.title && b.title !== a.title) out.push(`帮我写一段${b.title}的文案`);
      }
    } catch { /* 模板库读不到就算了 */ }

    // 兜底：两路都没拿到时至少给点能用的
    if (out.length < 2) {
      out.push("做一张夜市开街的宣传海报", "帮我写一段民宿秋季促销的文案");
    }
    return json(res, 200, { ok: true, generatedAt: new Date().toISOString(), prompts: out.slice(0, 3) });
  }

  if (p === "/api/assistant/settings" && req.method === "GET") {
    return json(res, 200, { ok: true, settings: loadAssistantPrefs() });
  }

  if (p === "/api/assistant/settings" && req.method === "POST") {
    let payload;
    try { payload = JSON.parse(await readBody(req, 64 * 1024)); }
    catch { return json(res, 400, { ok: false, message: "请求体不是合法 JSON" }); }
    return json(res, 200, { ok: true, settings: saveAssistantPrefs(payload || {}) });
  }

  // 图片分析：只看版式，不生成海报。
  // 独立于 /api/compose —— 用户只是想知道"这张图该怎么排"，不该因此出一张图。
  if (p === "/api/analyze-layout" && req.method === "POST") {
    let payload;
    try { payload = JSON.parse(await readBody(req, 2 * 1024 * 1024)); }
    catch { return json(res, 400, { ok: false, message: "请求体不是合法 JSON" }); }

    const photo = String(payload.photo || "");
    if (!photo) return json(res, 400, { ok: false, message: "没有给图片" });
    const absA = path.join(UPLOAD_DIR, path.basename(photo.replace(/^\/+/, "").replace(/^uploads\//, "")));
    if (!existsSync(absA)) return json(res, 404, { ok: false, message: "图片不在 uploads 里，请先上传" });

    const cfgA = loadBrainConfig(SITE_ROOT);
    if (!cfgA.enabled) {
      return json(res, 409, { ok: false, message: "文案大脑已在 brain.config.json 里关闭", code: "brain_disabled" });
    }
    const ra = await analyzeLayout(cfgA, absA);
    if (!ra.ok) {
      return json(res, 503, {
        ok: false,
        message: ra.reason || "分析失败",
        code: ra.kind ? "brain_" + ra.kind : "analyze_failed",
      });
    }
    return json(res, 200, {
      ok: true, composition: ra.composition, tone: ra.tone, reason: ra.reason, raw: ra.raw,
    });
  }

  // 构图清单：**只给版式，不给文案**。
  //
  // 为什么改成这样：原来挑模板是 41 套各带一份文案（"烧烤摊夜宵档""火锅店冬季暖场"…），
  // 用户真正要复用的是**版面结构**，不是别人家的文案 ——
  // 而且 41 套文案模板看下来会觉得"都差不多"，因为它们本来就在重复同一个题材维度。
  // 现在只列七种构图，用户选结构，文案自己填。
  if (p === "/api/compositions" && req.method === "GET") {
    let tpls = [];
    try {
      const raw = await loadTemplates();
      // loadTemplates() 返回的是数组，/api/templates 才包一层 {templates}。
      // 两种都兼容 —— 猜错结构会让示例图整列变空，而且不报错。
      tpls = Array.isArray(raw) ? raw : (raw && raw.templates) || [];
    } catch { tpls = []; }
    // 每种构图挑一套当示例图（优先有 featured 的，其次第一套）
    const rep = {};
    for (const t of tpls) {
      const c = t.composition;
      if (!c) continue;
      if (!rep[c] || (t.featured && !rep[c].featured)) rep[c] = t;
    }
    const list = Object.entries(POSTER_COMPOSITIONS).map(([key, c]) => ({
      key,
      label: c.label,
      align: c.align,
      imgMode: c.imgMode,
      // 说明写"适合什么"，不写"是什么" —— 用户选版式时想的是用途
      hint: {
        fullbleed: "图铺满整张，文字压在图上。风景、氛围强的照片最出效果。",
        axial: "所有元素居中沿中轴排列。仪式感、正式场合。",
        split: "图在上半，文字在下方实色区。要写清价格、时间、地址的物料。",
        splitv: "图在右侧出血，文字在左边窄栏。竖构图的单品特写。",
        focal: "图是居中悬浮的圆角卡片，文字环绕上下。主体明确的照片。",
        grid: "图在顶部，下面是四格信息。票务、赛事这类要逐项比对的。",
        typeled: "完全不用图，居中大标题。通知、公告、纯文字物料。",
      }[key] || "",
      sampleId: rep[key] ? rep[key].id : null,
      thumb: rep[key] ? `thumbs/s/${rep[key].id}.jpg` : null,
      count: tpls.filter((t) => t.composition === key).length,
    }));
    return json(res, 200, { ok: true, total: list.length, compositions: list });
  }

  // 出图历史 ----
  if (p === "/api/history" && req.method === "GET") {
    const items = loadHistory();
    return json(res, 200, { ok: true, total: items.length, items: items.slice(0, 100) });
  }

  if (p.startsWith("/api/history/") && req.method === "DELETE") {
    const id = decodeURIComponent(p.slice("/api/history/".length));
    try {
      const items = loadHistory();
      const left = items.filter((x) => x.id !== id);
      if (left.length === items.length) return json(res, 404, { ok: false, message: "没有这条记录" });
      writeFileSync(HISTORY_FILE, JSON.stringify({ version: 1, items: left }, null, 2), "utf8");
      return json(res, 200, { ok: true, removed: id, total: left.length });
    } catch (e) {
      return json(res, 500, { ok: false, message: "删除失败：" + e.message });
    }
  }

  if (p === "/api/history" && req.method === "DELETE") {
    // 清空记录**不删图** —— 图在 public/generated 里另有保留策略，
    // 两者分开，免得"清列表"变成"删作品"。
    try {
      writeFileSync(HISTORY_FILE, JSON.stringify({ version: 1, items: [] }, null, 2), "utf8");
      return json(res, 200, { ok: true, total: 0 });
    } catch (e) {
      return json(res, 500, { ok: false, message: "清空失败：" + e.message });
    }
  }

  // ---- 本地出图（diffusers / SDXL-Turbo）----
  // 旧路径 /api/comfy/status 保留为别名，避免旧脚本一夜之间全挂；
  // 但它现在报告的是**本地出图环境**，与 ComfyUI 无关。
  if ((p === "/api/aigen/status" || p === "/api/comfy/status") && req.method === "GET") {
    const st = await aigenStatus();
    return json(res, 200, { ok: true, ...st, models: { ready: st.ready, missing: st.missing } });
  }

  // 预热：把模型加载进 worker，用户第一次点 AI 背景时就不用等那 ~20 秒
  if (p === "/api/aigen/preload" && req.method === "POST") {
    const r = await preloadAigen();
    return json(res, 200, { ok: r.ok, message: r.message || "已预热" });
  }

/**
 * 没给照片时，自己生成一张底图（并缓存）。
 *
 * 为什么要有缓存：同一句要求反复出图时，18 秒的图像生成没必要每次都跑；
 * 而且同一提示词固定用同一张底图，结果可复现 —— 否则用户每次点生成都换一张，
 * 没法比较文案改动带来的差别。
 *
 * 为什么出图前先卸 Ollama 模型：8 GB 显存放不下"视觉+文案模型"和"图像模型"两套。
 */
async function ensureBackground({ imagePrompt, cacheKeySeed, size = 768, height = 1024, steps = 4, log = () => {} }) {
  const env = aigenEnvCheck();
  if (!env.ok) {
    return { ok: false, code: "aigen_unavailable", message: env.problems.join("；") };
  }
  await mkdir(BG_CACHE_DIR, { recursive: true });
  // 缓存键用**用户输入**算，不用模型生成的英文提示词。
  // 为什么：同一句话模型每次给的英文提示词会差几个词（"early morning mist" vs
  // "morning mist"），拿它做键就永远命不中 —— 实测同一句要求连跑两次出了两张不同的底图。
  // 用用户输入做键，同一句要求稳定复用同一张图，结果可复现、也省一次生成。
  const key = createHash("sha1")
    .update(`${cacheKeySeed || imagePrompt}|${size}x${height}|${steps}`)
    .digest("hex").slice(0, 16);
  const cached = path.join(BG_CACHE_DIR, `bg-${key}.png`);
  if (existsSync(cached)) {
    log("底图命中缓存");
    return {
      ok: true, url: `/uploads/.bgcache/bg-${key}.png`,
      cached: true, prompt: imagePrompt,
    };
  }

  // 注意：**不再卸载 Ollama 模型**。
  // 旧路径（ComfyUI + Qwen-Image）整模型塞满 8GB 显存，必须先把对话模型踢出去；
  // 新路径用 model cpu offload，出图只占约 1.2GB，两者可以共存 ——
  // 少一次"踢出去再重载"，用户下次提问不用等模型冷启动。

  log("开始生成底图（本地 diffusers / SDXL-Turbo）");
  const t0 = Date.now();
  const out = cached;
  const r = await aigenGenerate({ prompt: imagePrompt, out, width: size, height, steps, seed: 0 });
  log(`底图完成 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return {
    ok: true, url: `/uploads/.bgcache/bg-${key}.png`,
    cached: false, elapsedMs: Date.now() - t0, prompt: imagePrompt,
    engine: r.engine || "diffusers/SDXL-Turbo",
  };
}

  if ((p === "/api/aigen/background" || p === "/api/comfy/background") && req.method === "POST") {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      return json(res, 400, { ok: false, message: "请求体不是合法 JSON: " + e.message });
    }
    const env = aigenEnvCheck();
    if (!env.ok) {
      return json(res, 503, {
        ok: false,
        stage: "env",
        message: "本地出图环境不可用：" + env.problems.join("；"),
      });
    }

    const size = Math.min(Math.max(Number(payload.size) || 768, 512), 1536);
    const prompt = String(payload.prompt || "").trim();
    if (!prompt) return json(res, 400, { ok: false, message: "缺少 prompt" });

    try {
      const r = await aigenGenerate({
        prompt,
        out: path.join(UPLOAD_DIR, "ai-bg-" + Date.now().toString(36) + ".png"),
        width: size,
        height: Math.min(Math.max(Number(payload.height) || 1024, 512), 1536),
        steps: Math.min(Math.max(Number(payload.steps) || 4, 1), 8),
        seed: Number(payload.seed) || 0,
      });
      await mkdir(UPLOAD_DIR, { recursive: true });
      const rel = path.relative(PUBLIC_DIR, r.out).split(path.sep).join("/");
      const { size: bytes } = await stat(r.out);
      return json(res, 200, {
        ok: true,
        url: "/" + rel,
        bytes,
        elapsedMs: r.ms,
        engine: r.engine || "diffusers/SDXL-Turbo",
        note: "本地模型生成（SDXL-Turbo，OpenRAIL++ 许可，可商用）。底图之上由确定性引擎叠加文字与版式。",
      });
    } catch (e) {
      const stage = e instanceof AigenError ? e.stage : "unknown";
      return json(res, 500, {
        ok: false,
        stage,
        message: String(e.message || e),
        hint: stage === "startup"
          ? "首次出图要把模型搬上显卡（约 20 秒），之后每张约 6 秒"
          : (stage === "env" ? "检查模型目录与 Python 路径（见 /api/aigen/status）" : ""),
      });
    }
  }

  if ((p === "/api/aigen/interrupt" || p === "/api/comfy/interrupt") && req.method === "POST") {
    const ok = aigenInterrupt();
    return json(res, 200, { ok, message: ok ? "已中断并回收出图进程" : "当前没有在跑的出图进程" });
  }

  if (p === "/api/health" && req.method === "GET") {
    const py = await run(PYTHON, ["-c", "import PIL, sys; print(sys.version.split()[0])"]);
    const aig = aigenEnvCheck();
    return json(res, 200, {
      ok: true,
      python: PYTHON,
      pythonOk: py.code === 0,
      pythonDetail: (py.out + py.err).trim().slice(0, 200),
      forgeRoot: FORGE_ROOT,
      forgeFound: existsSync(path.join(FORGE_ROOT, "render.py")),
      copybookFound: existsSync(path.join(SITE_ROOT, "copybook.py")),
      aigenReady: aig.ok,
      aigenProblems: aig.problems,
      aigenModel: AIGEN_MODEL,
      // 兼容字段：前端早期按 comfyRunning 判断，现在语义是"本地出图是否可用"
      comfyRunning: aig.ok,
      platform: `${os.platform()} ${os.release()}`,
      node: process.version,
    });
  }

  if (p === "/api/cleanup" && req.method === "POST") {
    const result = await cleanAll();
    const totalRemoved = result.reduce((a, r) => a + r.removed, 0);
    const totalFreed = result.reduce((a, r) => a + r.freedBytes, 0);
    return json(res, 200, {
      ok: true,
      rules: KEEP_RULES,
      detail: result,
      removed: totalRemoved,
      freedBytes: totalFreed,
      message: `清理完成：删除 ${totalRemoved} 项，释放约 ${(totalFreed / 1024 / 1024).toFixed(1)} MB`,
    });
  }

  if (p === "/api/storage" && req.method === "GET") {
    const measure = async (dir) => {
      if (!existsSync(dir)) return { exists: false, files: 0, bytes: 0 };
      let files = 0;
      let bytes = 0;
      const walk = async (d) => {
        for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
          const abs = path.join(d, e.name);
          if (e.isDirectory()) await walk(abs);
          else {
            files++;
            bytes += (await stat(abs).catch(() => ({ size: 0 }))).size;
          }
        }
      };
      await walk(dir);
      return { exists: true, files, bytes };
    };
    return json(res, 200, {
      ok: true,
      rules: KEEP_RULES,
      dirs: {
        uploads: await measure(UPLOAD_DIR),
        generated: await measure(OUT_DIR),
        copybooks: await measure(COPYBOOK_DIR),
      },
    });
  }

  // ---- 图片代理（带磁盘缓存）----
  if (p === "/api/img" && req.method === "GET") {
    const remote = url.searchParams.get("u");
    if (!remote) return json(res, 400, { ok: false, message: "缺少 u 参数" });
    return await serveProxiedImage(res, remote);
  }

  // ---- 联网素材（灵感/参考）----
  if (p === "/api/feed" && req.method === "GET") {
    const cfg = await loadFeedConfig();
    const cached = await feedCache.read();
    const age = await feedCache.age();
    const stale = age > cfg.autoRefreshHours * 3600000;

    // 有缓存且未过期：直接用缓存，不打网络（首页秒开）
    if (cached && !stale) {
      return json(res, 200, {
        ok: true,
        fromCache: true,
        fetchedAt: cached.fetchedAt,
        ageMinutes: Math.round(age / 60000),
        stale: false,
        autoRefreshHours: cfg.autoRefreshHours,
        status: cached.status || [],
        items: cached.items || [],
      });
    }

    // 缓存过期：**立刻返回旧内容**，同时后台去拉新的。
    //
    // 这里原来是 `await fetchFeeds(...)` —— 注释写着"后台刷新，本次先返回能拿到的东西"，
    // 代码却在同步等网络。抓 Bing 要几秒到几十秒，首屏就是空的；
    // 等用户一刷新，上一次的后台请求已经写进缓存了，所以"刷新才出来"。
    // 现在改成名副其实：有旧内容就先给旧的，新的一边拉一边写缓存，下次访问自然就是新的。
    if (cached) {
      fetchFeeds({
        cache: feedCache, sources: cfg.sources, count: cfg.count,
        query: cfg.query, env: cfg.env,
      }).catch((e) => console.warn("[feed] 后台刷新失败:", String(e.message || e).slice(0, 120)));
      return json(res, 200, {
        ok: true,
        fromCache: true,
        refreshing: true,
        fetchedAt: cached.fetchedAt,
        ageMinutes: Math.round(age / 60000),
        stale: true,
        autoRefreshHours: cfg.autoRefreshHours,
        status: cached.status || [],
        items: cached.items || [],
      });
    }

    // 一份缓存都没有：只能等（没有别的可返回）
    try {
      const fresh = await fetchFeeds({
        cache: feedCache,
        sources: cfg.sources,
        count: cfg.count,
        query: cfg.query,
        env: cfg.env,
      });
      return json(res, 200, {
        ok: true,
        fromCache: false,
        fetchedAt: fresh.fetchedAt,
        ageMinutes: 0,
        stale: false,
        autoRefreshHours: cfg.autoRefreshHours,
        status: fresh.status,
        items: fresh.items,
      });
    } catch (e) {
      return json(res, 200, {
        ok: false,
        fromCache: false,
        fetchedAt: null,
        items: [],
        status: [{ source: "*", ok: false, reason: String(e.message || e).slice(0, 200) }],
        message: "联网素材不可用，且没有本地缓存",
      });
    }
  }

  if (p === "/api/feed/refresh" && req.method === "POST") {
    const cfg = await loadFeedConfig();
    try {
      const fresh = await fetchFeeds({
        cache: feedCache,
        sources: cfg.sources,
        count: cfg.count,
        query: cfg.query,
        env: cfg.env,
      });
      return json(res, 200, {
        ok: true,
        forced: true,
        fetchedAt: fresh.fetchedAt,
        status: fresh.status,
        items: fresh.items,
        available: Object.entries(SOURCES).map(([k, v]) => ({
          source: k, label: v.label, needsKey: v.needsKey,
          configured: !v.needsKey || !!cfg.env[v.envKey],
        })),
      });
    } catch (e) {
      return json(res, 502, { ok: false, message: String(e.message || e).slice(0, 300) });
    }
  }

  if (p === "/api/templates" && req.method === "GET") {
    // 每次读盘，这样联网轮换/反馈累计写回后前端立刻能看到
    TEMPLATES = loadTemplates();
    // 当天轮换（懒算 + 当天缓存，同日结果稳定）
    try {
      rotation = await getRotation({
        cacheDir: CACHE_DIR, stateFile: ROTATE_FILE, siteRoot: SITE_ROOT,
        log: (m) => console.log("[rotate]", m),
      });
    } catch (e) {
      rotation = { date: "", bias: "neutral", palettes: [], error: String(e.message || e) };
    }
    return json(res, 200, {
      categories: CATEGORIES,
      templates: applyRotation(TEMPLATES, rotation),
      rotation: {
        date: rotation.date,
        bias: rotation.bias,
        avgWarmth: rotation.avgWarmth,
        paletteCount: (rotation.palettes || []).length,
        palettes: (rotation.palettes || []).slice(0, 4),
        source: rotation.source,
        licenseNote: rotation.licenseNote,
        cached: !!rotation.cached,
      },
    });
  }

  // 联网轮换：GET 看当天结果，POST 强制重算（换了一批灵感图之后用）
  if (p === "/api/templates/rotate" && (req.method === "GET" || req.method === "POST")) {
    try {
      rotation = await getRotation({
        cacheDir: CACHE_DIR, stateFile: ROTATE_FILE, siteRoot: SITE_ROOT,
        force: req.method === "POST",
        log: (m) => console.log("[rotate]", m),
      });
      return json(res, 200, { ok: true, ...rotation });
    } catch (e) {
      return json(res, 500, { ok: false, message: String(e.message || e) });
    }
  }

  // 用户把自己的内容存成模板（「上传自己的模板」）
  //
  // 为什么做成"存当前内容"而不是"传一张图"：
  //   用户真正想复用是**一整套设定**（文案骨架 + 调性 + 版式），
  //   而不只是张缩略图。存下来之后下次一键套用，改两个数字就能出图。
  if (p === "/api/templates/save" && req.method === "POST") {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { ok: false, message: "请求体不是合法 JSON" }); }

    const brief = String(payload.brief || "").trim();
    const title = String(payload.title || "").trim();
    if (brief.length < 4) return json(res, 400, { ok: false, message: "内容太短，至少写几个字" });
    if (brief.length > 1200) return json(res, 400, { ok: false, message: "内容太长（上限 1200 字）" });

    // 广告法预检：存进模板就等于以后还会再用，脏词必须现在拦住
    const banned = checkAdLaw(brief);
    if (banned.hard.length) {
      return json(res, 400, {
        ok: false, stage: "adlaw",
        message: `内容里有广告法禁用词：${banned.hard.join("、")}`,
        hits: banned.hard,
      });
    }

    const now = new Date();
    const id = "user-" + now.getTime().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    const entry = {
      id,
      title: title || brief.split("\n")[0].slice(0, 14) || "我的模板",
      audience: ["hotel", "restaurant", "bureau", "tourist"].includes(payload.audience)
        ? payload.audience : "restaurant",
      tags: Array.isArray(payload.tags) ? payload.tags.slice(0, 5).map(String) : ["我的模板"],
      layout: BRAIN_LAYOUTS.includes(payload.layout) ? payload.layout : "poster_photo_bg",
      tone: Number.isFinite(Number(payload.tone))
        ? Math.max(0, Math.min(1, Number(payload.tone))) : 0.5,
      brief,
      likes: 0, comments: 0, picked: 0,
      source: "user",
      createdAt: now.toISOString(),
    };

    try {
      let store = { version: 1, templates: [] };
      if (existsSync(USER_TEMPLATES_FILE)) {
        try { store = JSON.parse(readFileSync(USER_TEMPLATES_FILE, "utf8")); } catch { /* 坏了就重建 */ }
      }
      if (!Array.isArray(store.templates)) store.templates = [];
      if (store.templates.length >= 100) {
        return json(res, 400, { ok: false, message: "自己的模板最多存 100 套，先删几个" });
      }
      store.templates.push(entry);
      writeFileSync(USER_TEMPLATES_FILE, JSON.stringify(store, null, 2), "utf8");
      TEMPLATES = loadTemplates();
      return json(res, 200, { ok: true, template: entry, total: TEMPLATES.length });
    } catch (e) {
      return json(res, 500, { ok: false, message: "保存失败：" + e.message });
    }
  }

  // 删除自己存的模板（内置库的不允许删）
  if (p.startsWith("/api/templates/user/") && req.method === "DELETE") {
    const id = decodeURIComponent(p.slice("/api/templates/user/".length));
    try {
      if (!existsSync(USER_TEMPLATES_FILE)) return json(res, 404, { ok: false, message: "没有这个模板" });
      const store = JSON.parse(readFileSync(USER_TEMPLATES_FILE, "utf8"));
      const before = (store.templates || []).length;
      store.templates = (store.templates || []).filter((t) => t.id !== id);
      if (store.templates.length === before) return json(res, 404, { ok: false, message: "没有这个模板（内置模板不能删）" });
      writeFileSync(USER_TEMPLATES_FILE, JSON.stringify(store, null, 2), "utf8");
      TEMPLATES = loadTemplates();
      templateIndex = null;   // 索引里还留着已删模板的向量，作废重建
      return json(res, 200, { ok: true, removed: id, total: TEMPLATES.length });
    } catch (e) {
      return json(res, 500, { ok: false, message: "删除失败：" + e.message });
    }
  }

  // 模板检索（向量）：按用户原话找最匹配的几套模板。
  // 走 nomic-embed-text 嵌入 + 余弦相似度 + 采纳反馈增益，见 templates-rank.mjs。
  if (p === "/api/templates/search" && req.method === "GET") {
    const q = String(url.searchParams.get("q") || "").trim();
    const topK = Math.min(Math.max(Number(url.searchParams.get("k")) || 3, 1), 8);
    TEMPLATES = loadTemplates();
    if (!q) return json(res, 200, { ok: true, query: "", results: [], note: "缺少 q 参数" });
    try {
      const idx = await ensureTemplateIndex(TEMPLATES);
      const ranked = await rankTemplates(q, TEMPLATES, idx, { topK });
      // 低置信提示：中心化后，真正匹配的分数通常在 0.2 以上；
      // 全部低于 0.12 基本等于"库里没有这一类"，这时不该装作匹配上了
      //（实测「公司年会聚餐套餐」最高只有 0.08 —— 因为库里确实没有年会/团建模板）。
      const top = ranked[0]?.score ?? 0;
      return json(res, 200, {
        ok: true, query: q, model: idx.model,
        topScore: Number(top.toFixed(4)),
        lowConfidence: top < 0.12,
        hint: top < 0.12 ? "模板库里没有很贴近这一类的，建议看看全部模板或直接自己写" : "",
        results: ranked.map((r) => ({
          id: r.template.id, title: r.template.title, brief: r.template.brief,
          tone: r.template.tone, layout: r.template.layout, tags: r.template.tags,
          picked: r.template.picked || 0,
          sim: r.sim ?? null, score: r.score, fallback: !!r.fallback,
        })),
      });
    } catch (e) {
      return json(res, 200, { ok: false, query: q, results: [], message: String(e.message || e) });
    }
  }

  // 重建模板索引（模板库改了之后调一次；平时懒加载自动建）
  if (p === "/api/templates/index" && req.method === "POST") {
    TEMPLATES = loadTemplates();
    try {
      const r = await rebuildTemplateIndex(TEMPLATES);
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 500, { ok: false, message: String(e.message || e) });
    }
  }

  // 采纳反馈：用户点了一次「套用」，记下来用于检索排序。
  // 为什么记这个而不是"训练模型"：8GB 显存跑不了微调，而"哪个模板真被选走"
  // 是最直接的相关性信号 —— 用它调排序权重，效果等价且今天就能落地。
  if (p === "/api/templates/pick" && req.method === "POST") {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { return json(res, 400, { ok: false, message: "请求体不是合法 JSON" }); }
    const id = String(payload.id || "");
    try {
      const raw = JSON.parse(readFileSync(TEMPLATES_FILE, "utf8"));
      const t = (raw.templates || []).find((x) => x.id === id);
      if (!t) return json(res, 404, { ok: false, message: "没有这个模板: " + id });
      t.picked = (t.picked || 0) + 1;
      t.lastPickedAt = new Date().toISOString();
      writeFileSync(TEMPLATES_FILE, JSON.stringify(raw, null, 2), "utf8");
      TEMPLATES = loadTemplates();
      return json(res, 200, { ok: true, id, picked: t.picked });
    } catch (e) {
      return json(res, 500, { ok: false, message: "记录失败: " + e.message });
    }
  }

  // /api/cases 已随「爆火案例 + STORY 三点钟」两节一起删除。
  // 原案例数据（case-01..06 的平台/播放量/时长）留档在 site/deleted-cases.json，
  // 前端若要恢复案例区，把路由和数据一起加回来即可。

  if (p === "/api/capabilities" && req.method === "GET") {
    return json(res, 200, { capabilities: CAPABILITIES });
  }

  // 文案大脑状态：前端据此决定按钮文案要不要说"由模型生成"
  if (p === "/api/brain" && req.method === "GET") {
    const cfg = loadBrainConfig(SITE_ROOT);
    const st = await brainStatus(cfg);
    const aig = aigenEnvCheck().ok;
    return json(res, 200, {
      enabled: cfg.enabled,
      ...st,
      vision: cfg.vision,
      copy: cfg.copy,
      tones: Object.entries(POSTER_TONES).map(([id, v]) => ({ id, name: v.name })),
      layouts: BRAIN_LAYOUTS,
      kinds: BRAIN_KINDS,
      ready: cfg.enabled && st.up && st.hasCopy,
      // AI 底图能力：前端据此决定"没照片时"要不要提示会自生成
      autoBgAvailable: aig,
      // 兼容旧字段名（前端早期用过 comfyUp）
      comfyUp: aig,
      autoBgEngine: "diffusers/SDXL-Turbo",
    });
  }

  /**
   * /api/compose —— 大模型出内容，引擎出图。
   *
   * 请求：{ brief, photos:[站内url], facts:{price,phone,address,brand}, render:true }
   * 响应：{ ok, copy, spec, url, scenes, model, ms }
   *
   * 为什么把这三步放在一个接口里：前端只需要"一次等待"，中间不需要把
   * 模型中间产物（读图描述、文案 JSON）暴露给浏览器，也就没有半成品状态要处理。
   */
  if (p === "/api/compose" && req.method === "POST") {
    let payload;
    try {
      payload = JSON.parse(await readBody(req, 2 * 1024 * 1024));
    } catch (e) {
      return json(res, 400, { ok: false, message: "请求体不是合法 JSON: " + e.message });
    }
    const brief = String(payload.brief || "").slice(0, 2000);
    // checkin = 打卡卡，poster = 宣传海报。两者文案结构不同（caption/body vs title/sub），
    // 所以模式必须显式传进来，不能靠猜。
    const mode = payload.mode === "checkin" ? "checkin" : "poster";
    const photoUrls = (Array.isArray(payload.photos) ? payload.photos : [])
      .map((u) => String(u || ""))
      .filter(Boolean)
      .slice(0, 6);
    const facts = payload.facts && typeof payload.facts === "object" ? payload.facts : {};
    const cfg = loadBrainConfig(SITE_ROOT);

    if (!cfg.enabled) {
      return json(res, 409, { ok: false, message: "文案大脑已在 brain.config.json 里关闭", code: "brain_disabled" });
    }
    if (!brief.trim() && !photoUrls.length) {
      return json(res, 400, { ok: false, message: "既没有文字也没有图片，无可生成的内容" });
    }

    // 照片 url → 本地绝对路径（视觉模型要读文件）
    const absPhotos = [];
    for (const u of photoUrls) {
      const rel = u.replace(/^\/+/, "").replace(/^uploads\//, "");
      const abs = path.join(UPLOAD_DIR, path.basename(rel));
      if (existsSync(abs)) absPhotos.push(abs);
    }

    let out;
    try {
      out = await composeCopy(cfg, brief, absPhotos, { facts, mode });
    } catch (e) {
      const kind = e instanceof BrainError ? e.kind : "brain";
      const hint = kind === "offline"
        ? "模型服务没在跑。启动 Ollama 后重试（ollama serve）。"
        : kind === "timeout"
        ? "模型响应超时，可在 brain.config.json 调大 timeoutMs，或换更小的模型。"
        : "模型调用失败。";
      return json(res, 503, { ok: false, message: `${hint}（${e.message}）`, code: "brain_" + kind });
    }

    if (!out.ok || !out.copy) {
      return json(res, 422, {
        ok: false,
        message: "模型输出没通过校验：" + out.errors.join("；"),
        code: "brain_invalid",
        raw: String(out.raw || "").slice(0, 500),
        scenes: out.scenes,
        ms: out.ms,
      });
    }

    // 硬事实优先：用户话里明确写的价格/电话/地址，比模型的转述可靠
    const c = out.copy;
    // 照片主题不搭时打个标：卡片上显示"#混搭"，
    // 而不是硬把它们编成一个故事（用户传风景 + 动漫人物那次就是这个情况）
    const mixed = out.mixable === false;

    /* ---------- 一张照片都没传 → 自己生成一张底图 ----------
     * 用户的要求原话：「根据用户需要，如果没有你就自己生成，并加上引导，
     * 用户不满意可以根据引导去改」。所以这里：
     *   1. 先让模型把主题翻成图像提示词（英文，且不许含汉字）
     *   2. 出图（有缓存就复用），失败不阻断 —— 退回纯文字版并说明原因
     *   3. 把提示词一并回给前端，让人看见"它画的是什么、想改就改这一行"
     */
    let autoBg = null;
    const wantAutoBg = photoUrls.length === 0 && payload.autoBg !== false;
    if (wantAutoBg) {
      const ip = await deriveImagePrompt(cfg, { brief, copy: c, scenes: out.scenes });
      if (!ip.ok) {
        autoBg = { ok: false, code: "prompt_failed", message: ip.reason };
      } else {
        try {
          const bg = await ensureBackground({
            imagePrompt: ip.prompt,
            // 用「用户原话 + 模式」当缓存种子，保证同一句要求稳定复用同一张底图
            cacheKeySeed: `${mode}::${brief.trim()}`,
            size: Number(payload.bgSize) || 768,
            height: Number(payload.bgHeight) || 1024,
            steps: Number(payload.bgSteps) || 4,
          });
          autoBg = { ...bg, reason: ip.reason };
        } catch (e) {
          autoBg = {
            ok: false,
            code: e instanceof AigenError ? e.stage : "generate_failed",
            message: String(e.message || e).slice(0, 200),
            prompt: ip.prompt,
          };
        }
      }
    }

    let spec;
    if (mode === "checkin") {
      const merged = {
        caption: c.caption,
        body: c.body,
        tags: c.tags,
        grid: c.grid,
        topLabel: facts.brand || "现场打卡 · " + (facts.brand || "○○（填你的店名）"),
      };
      spec = buildCheckinSpecFrom(merged, { photoUrls, grid: c.grid, mixed });
      if (payload.render === false) {
        return json(res, 200, { ok: true, mode, copy: merged, modelCopy: c, spec, scenes: out.scenes, mixed, ms: out.ms });
      }
      const result = await generate(spec);
      return json(res, result.ok ? 200 : 422, {
        ok: result.ok,
        mode,
        url: result.url || null,
        copy: merged,
        modelCopy: c,
        spec,
        scenes: out.scenes,
        visionErrors: out.visionErrors,
        mixed,
        mixedWhy: out.mixWhy || "",
        validation: result.validation || null,
        error: result.error || null,
        ms: out.ms,
        model: out.model,
        attempts: out.attempts,
      });
    }

    const merged = {
      brand: facts.brand || c.brand,
      title: c.title,
      sub: c.sub,
      price: facts.price || c.price,
      phone: facts.phone || c.phone,
      address: facts.address || c.address,
      // 这几个不是"字"，是模型对版式和调性的决定。放进 copy 一起回给前端，
      // 前端才能在"重新生成"时知道上一次用的是什么，也便于人工核对。
      layout: c.layout,
      kind: c.kind,
      tone: c.tone,
      tags: c.tags,
    };

    spec = buildPosterSpecFrom(merged, {
      photoUrls,
      layout: c.layout,
      // 构图由「套用模板」带过来（模板的 composition 字段）。
      // 没套模板时为 null，构函数会回退到按图片数量选原有的两套版面。
      composition: RE_COMPOSITIONS.has(String(payload.composition || ""))
        ? String(payload.composition) : null,
      // 变体用序号传（构函数按序号取模）。只接受 a/b/c，野值一律当 a。
      variant: Math.max(0, ["a", "b", "c"].indexOf(String(payload.variant || "a"))),
      // 精调只接受有限区间，野值一律夹回安全范围（越界会把文字挤出画布）
      tuning: payload.tuning && typeof payload.tuning === "object" ? {
        y: Math.max(0, Math.min(1, Number(payload.tuning.y) || 0)),
        s: Math.max(0.88, Math.min(1.16, Number(payload.tuning.s) || 1)),
      } : null,
      tone: c.tone,
      kind: c.kind,
      // 自生成的底图：没有用户照片时才可能非空
      autoBgUrl: autoBg?.ok ? autoBg.url : null,
      factsSource: `大模型生成（${cfg.vision || "无视觉"} 读图 + ${cfg.copy} 写文案）`,
    });

    if (payload.render === false) {
      return json(res, 200, {
        ok: true, mode, copy: merged, modelCopy: c, spec,
        scenes: out.scenes, autoBg, ms: out.ms,
      });
    }

    const result = await generate(spec);
    // 出图成功才记历史 —— 失败的不进列表，否则用户会看到一堆打不开的记录
    if (result.ok && result.url) {
      recordHistory({
        url: result.url,
        mode,
        title: merged.title || "",
        brief: String(brief || "").slice(0, 200),
        brand: merged.brand || "",
        templateId: payload.templateId || null,
        composition: spec?.layers?.find((l) => l.name === "title") ? (payload.composition || null) : null,
        hasPrice: !!merged.price,
        photos: Array.isArray(payload.photos) ? payload.photos.length : 0,
      });
    }
    return json(res, result.ok ? 200 : 422, {
      ok: result.ok,
      mode,
      url: result.url || null,
      copy: merged,
      modelCopy: c,
      spec,
      scenes: out.scenes,
      visionErrors: out.visionErrors,
      autoBg,
      validation: result.validation || null,
      error: result.error || null,
      ms: out.ms,
      model: out.model,
      attempts: out.attempts,
    });
  }

  if (p === "/api/generate" && req.method === "POST") {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      return json(res, 400, { ok: false, message: "请求体不是合法 JSON: " + e.message });
    }
    // 允许传 { template: "tpl-xxx" } 走模板，或直接传 { spec: {...} }
    let spec = payload.spec;
    if (!spec && payload.template) {
      const t = TEMPLATES.find((x) => x.id === payload.template);
      if (!t) return json(res, 404, { ok: false, message: "模板不存在: " + payload.template });
      return json(res, 501, {
        ok: false,
        message: "按模板生成需要传入完整 spec（模板只提供缩略图预览）。请用 spec 字段。",
      });
    }
    if (!spec) return json(res, 400, { ok: false, message: "缺少 spec 或 template" });

    const result = await generate(spec);
    return json(res, result.ok ? 200 : 422, result);
  }

  return json(res, 404, { ok: false, message: "未知 API: " + p });
}

// ---------------------------------------------------------------- HikiTravel 反代
//
// 为什么要有这一段：HikiTravel（AIRI-2.0 分支）是独立项目，跑在自己的 8000 端口。
// 门户要"做成一个项目"，就得让浏览器只看到一个源 —— 否则跨域、两个端口、
// 两套地址，用起来还是两个东西。所以在这里把它挂到 /wenlv/ 下。
//
// 为什么必须改写内容：AIRI 的页面**全部用绝对路径**引用资源
// （实测 index.html 23 个引用里 21 个是 /js/... /css/... 这种），
// 直接挂在子路径下会全部 404 —— <base href> 对绝对路径无效。
// 所以对文本类响应做前缀改写，把 /api/ /js/ /css/ 这些挂到 /wenlv/ 下。
// 二进制（模型/图片）原样透传，不改。
// 默认指向 main-repair（8001）。
// 之前指过 AIRI-2.0（8000）—— 那个分支自带 public/ 界面；
// 现在按需求换成 main-repair（React 前端构建到 frontend/dist，只引用 /assets/）。
// 两个都在本机，想切回去改这个环境变量即可：PF_WENLV_ORIGIN=http://127.0.0.1:8000
const WENLV_ORIGIN = process.env.PF_WENLV_ORIGIN || "http://127.0.0.1:8001";
const WENLV_PREFIX = "/wenlv";

// AIRI 用到的所有根级路径前缀。改写只认这些，避免误伤正文里的普通斜杠文本。
const WENLV_DIRS = [
  "api", "css", "js", "icons", "app", "m", "planner", "vendor",
  "models", "models3d", "backgrounds", "manifest.webmanifest", "sw.js",
  "assets",   // ← main-repair 的前端产物（Vite 输出到 /assets/）
];

/** 把文本里的 "/api/..." 改成 "/wenlv/api/..."（只改上面列出的前缀） */
function rewriteWenlvPaths(text, kind) {
  let out = text;
  for (const d of WENLV_DIRS) {
    // 三种引号 + url(...) 里的绝对路径。前后各有边界，避免把已经带前缀的再改一次。
    const esc = d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(`(["'\`(])\\/(${esc})(?=[/"'\`)?#])`, "g"),
      (_m, pre, dir) => `${pre}${WENLV_PREFIX}/${dir}`
    );
  }
  // HTML 里的 src=/href=/action= 不带引号的情况（少见但存在）
  if (kind === "html") {
    // **不能无差别加前缀。**
    // 踩过的坑：给「返回主页」写的是 href="/hub.html"，被这行改成了
    // /wenlv/hub.html，点下去反代转发给 HikiTravel → {"detail":"Not Found"}。
    // 用户看到的就是"点了返回没回到主页"。
    // 负向先行断言排掉**我们自己站点**的路径（门户、助手组件、形象资源）。
    out = out.replace(
      /\b(src|href|action)=(["']?)\/(?!hub\.html|ai-ball\.js|avatar\/|api\/assistant)/g,
      (_m, attr, q) => `${attr}=${q}${WENLV_PREFIX}/`
    );
    // 已经改过的不要去重前缀
    out = out.replace(new RegExp(`${WENLV_PREFIX}${WENLV_PREFIX}/`, "g"), `${WENLV_PREFIX}/`);
  }
  return out;
}

function proxyWenlv(req, res, url) {
  const sub = url.pathname.slice(WENLV_PREFIX.length) || "/";

  // favicon：上游没有（:8000/favicon.ico 本来就是 404，浏览器却一定会来要），
  // 在这里给一个，免得每个页面的请求列表里都挂一条红。
  if (sub === "/favicon.ico") {
    res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="7" fill="#0e2a33"/>
      <path d="M7 21c4-1 7-4 9-9 2 5 5 8 9 9" stroke="#e8c37a" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    </svg>`);
  }

  // 助手组件**永远只服务我们这一份**，不管请求来自哪个前缀。
  //
  // 踩过的坑：磁盘上曾有 4 份 ai-ball.js（我们一份 + HikiTravel 三个静态目录各一份）。
  // 我改了组件、加了设置齿轮、换了对话接口，但 /wenlv/ 那边加载的是 main-repair
  // 里的旧拷贝 —— 用户看到的还是老面板，反馈"设置功能仍然未实装"。
  // 代码是对的，送错了文件，争论就没有意义。
  // 所以这里直接截胡：任何 */ai-ball.js 都从本站读。
  if (/\/ai-ball\.js$/.test(sub)) {
    const local = path.join(PUBLIC_DIR, "ai-ball.js");
    if (existsSync(local)) {
      const buf = readFileSync(local);
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "content-length": buf.length,
        "cache-control": "no-cache, must-revalidate",
      });
      return res.end(buf);
    }
  }

  const target = new URL(WENLV_ORIGIN);
  const options = {
    hostname: target.hostname,
    port: target.port,
    // 保留原始 path + query，交给后端按原样处理
    path: sub + url.search,
    method: req.method,
    headers: { ...req.headers, host: `${target.hostname}:${target.port}` },
  };
  // 上游返回压缩内容的话没法做文本改写，直接声明只要原文
  delete options.headers["accept-encoding"];
  delete options.headers["content-length"];   // 可能因改写而变化，交给 node 重算

  const upstream = httpRequest(options, (up) => {
    const ct = String(up.headers["content-type"] || "");
    // JSON 也要改：接口返回里带的是根路径
    // （实测 /api/models3d 返回 "url": "/models3d/seed-san/Seed-san.vrm"），
    // 页面拿到后直接去加载 —— 不改的话这些资源在子路径下全是 404。
    // manifest 同理，里面写的是 /icons/xxx.png。
    const isText = /text\/html|text\/css|javascript|application\/json|application\/manifest\+json|text\/plain|image\/svg/.test(ct);

    if (!isText) {
      // 模型、图片、字体等：原样流式透传
      res.writeHead(up.statusCode || 502, up.headers);
      return up.pipe(res);
    }

    const chunks = [];
    up.on("data", (c) => chunks.push(c));
    up.on("end", () => {
      const body = Buffer.concat(chunks);
      const kind = /text\/html/.test(ct) ? "html" : /text\/css/.test(ct) ? "css" : "js";
      // ai-ball.js 是**我们自己的**文件，里面的路径已经是最终形态，不能再改写。
      // 踩过的坑：它写的是 WENLV + '/api/health'，改写会把 '/api/health' 换成
      // '/wenlv/api/health'，结果变成 /wenlv/wenlv/api/health —— 404。
      const skipRewrite = /\/ai-ball\.js(\?|$)/.test(sub);
      let text = skipRewrite ? body.toString("utf8") : rewriteWenlvPaths(body.toString("utf8"), kind);

      // 往上游页面的 HTML 里注入悬浮球助手。
      //
      // 为什么用注入而不是改它的源码：HikiTravel 是独立项目、按约定不修改。
      // 它的页面全都经过这个代理，所以在响应里插一行 <script> 就够了 ——
      // 它的仓库、它的构建产物都保持原样。
      // 只在 HTML 上注入；JS/CSS/JSON 不碰。
      // 防重复要按**带不带 data-api-base** 判，不能只看文件名。
      // 踩过的坑：上游页面的构建产物里已经被直接注入过一个不带属性的
      // HikiTravel 的 HTML 里**自带一份** <script src="/wenlv/ai-ball.js">，
      // 我们又要注入一份。两份都加载，而组件有防重复注入的守卫
      // （window.__pfAiBall）—— **先加载的那个赢**。
      // 原来先到的是 HikiTravel 静态目录里的旧拷贝，导致我改的组件
      // （设置齿轮、新对话接口）根本没生效，用户看到的一直是老面板。
      // 所以先把它的引用摘掉，只留我们注入的这一份。
      if (kind === "html") {
        text = text.replace(/<script[^>]*src=["'][^"']*ai-ball\.js[^"']*["'][^>]*>\s*<\/script>/gi, "");
      }

      // <script src="/ai-ball.js">（为了直连端口也能用），这里若只判文件名
      // 就会跳过注入，于是 /wenlv/ 页面上缺少 data-api-base，
      // 组件跑去问 8800 自己的 /api/health，被判成"离线"。
      if (kind === "html" && !/data-api-base="\/wenlv"/.test(text)) {
        // data-api-base 告诉组件规划接口在哪：反代页面在 /wenlv/api/ 下。
        // 不写这个属性的话组件会按同源 /api/ 找，在 /wenlv/ 页面上就 404。
        //
        // ?v= 是**必须**的：不带版本的地址一旦被浏览器按旧的 max-age 缓存住，
        // 它压根不会回源，改了组件也送不过去（海报页和门户就是这样卡住的）。
        // 注意用同步版：这段在 http 回调里，**不是 async 函数**。
        // statSync 包 try：文件万一不在，版本号退化成 1，总比整个反代 500 强。
        let v = "1";
        try { v = Math.round(statSync(path.join(PUBLIC_DIR, "ai-ball.js")).mtimeMs).toString(36); } catch { /* 兜底 */ }
        const tag = `<script src="/ai-ball.js?v=${v}" data-api-base="/wenlv" defer></script>`;
        // 旅游规划页是独立的 React 应用，它自己没有回门户的入口 ——
        // 进去就出不来，只能改地址栏。这里补一个固定的返回链接。
        // 旅游规划页是独立的 React 应用，它自己没有回门户的入口 ——
        // 进去就出不来，只能改地址栏。这里补一个固定的返回链接。
        //
        // 为什么要 !important 和最大 z-index：第一版只写了 position:fixed +
        // z-index:9998，结果被那个应用的样式盖住，用户反馈"返回主页没做上去"。
        // 它是注入到别人页面里的元素，不能指望对方的 CSS 不跟自己打架。
        const back = `<a href="/hub.html" id="pf-back-hub" style="` +
          `position:fixed !important;left:14px !important;top:12px !important;` +
          `z-index:2147483647 !important;display:inline-flex !important;` +
          `align-items:center !important;gap:6px !important;` +
          `padding:7px 14px !important;border-radius:999px !important;` +
          `background:#ffffff !important;border:1px solid #d8dde6 !important;` +
          `color:#2b3540 !important;font-size:13px !important;line-height:1.4 !important;` +
          `font-family:system-ui,-apple-system,'Microsoft YaHei',sans-serif !important;` +
          `text-decoration:none !important;box-shadow:0 2px 10px rgba(16,24,29,.18) !important;` +
          `pointer-events:auto !important" title="回到门户">← 返回主页</a>`;
        const inject = (text.includes("pf-back-hub") ? "" : back) + tag;
        if (/<\/body>/i.test(text)) text = text.replace(/<\/body>/i, inject + "</body>");
        else text += inject;   // 没有 </body> 的页面直接追加
      }

      const headers = { ...up.headers };
      delete headers["content-length"];
      delete headers["content-encoding"];
      // **改写过的 HTML 绝不能让它带缓存头。**
      //
      // 踩过的坑：反代原样透传 HikiTravel 的 cache-control，浏览器把 HTML 缓存了，
      // 结果我后来往注入里加的「返回主页」按钮（id=pf-back-hub）怎么都送不到页面上 ——
      // 服务端查得到、浏览器 DOM 里没有，实测 found:false。
      // 只要这段代码还在往页面里插东西，这个响应就是动态的，不能缓存。
      if (kind === "html") {
        delete headers["etag"];
        delete headers["last-modified"];
        headers["cache-control"] = "no-store, must-revalidate";
      }
      res.writeHead(up.statusCode || 502, headers);
      res.end(Buffer.from(text, "utf8"));
    });
  });

  upstream.on("error", (e) => {
    // 后端没起来时给一句人话，而不是让门户上出现一个空白页
    if (res.headersSent) return res.end();
    res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8">
      <body style="font:15px/1.7 system-ui;background:#fff;color:#16181d;padding:48px;max-width:640px">
      <h2 style="margin:0 0 12px">旅游规划服务没在运行</h2>
      <p style="color:#5c6470">它是独立进程（不在本服务里），需要单独启动：</p>
      <pre style="background:#f7f8fa;border:1px solid #e9ebef;padding:14px 16px;border-radius:10px;overflow:auto">cd E:\\deepseck\\HikiTravel-main-repair\\backend
uv run python -m uvicorn app.main:app --host 127.0.0.1 --port 8001</pre>
      <p style="color:#5c6470">启动后刷新本页即可。<b>海报生成不受影响</b> —— 返回门户点左边那张卡就能用。</p>
      <p style="color:#8b929e;font-size:13px">原始错误：${e.message}</p>
      <p><a href="/hub.html" style="color:#ff5a3c;font-weight:600">← 返回主界面</a></p></body>`);
  });

  req.pipe(upstream);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const isApi = url.pathname.startsWith("/api/");
  const t0 = Date.now();
  // 请求日志：加它是为了排查"请求发出去但服务端不响应"这类问题 ——
  // 没有日志的时候只能靠猜，而猜错过好几次。
  if (isApi) {
    res.on("finish", () => {
      const ms = Date.now() - t0;
      // 慢请求单独标出来，便于定位卡在哪一步
      const flag = ms > 5000 ? " ⚠慢" : "";
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${req.method} ${url.pathname} -> ${res.statusCode} (${ms}ms)${flag}`);
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        console.log(`[${new Date().toISOString().slice(11, 19)}] ${req.method} ${url.pathname} -> 连接断开 (${Date.now() - t0}ms)`);
      }
    });
  }
  try {
    // 站点图标：浏览器默认会来要 /favicon.ico，缺了就在每个页面的
    // 网络面板里留一条 404。用内联 SVG 直接回，不占文件。
    if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
        <rect width="32" height="32" rx="7" fill="#2a1206"/>
        <rect x="6" y="7" width="20" height="15" rx="2.5" fill="none" stroke="#f0b070" stroke-width="2"/>
        <path d="M9 18l4-5 3.5 40 3-3.2 2.5 4.2" stroke="#f0b070" stroke-width="2" fill="none"
              stroke-linecap="round" stroke-linejoin="round" transform="translate(0,-4)"/>
      </svg>`);
    }
    if (url.pathname === WENLV_PREFIX || url.pathname.startsWith(WENLV_PREFIX + "/")) {
      return proxyWenlv(req, res, url);
    }
    if (isApi) return await handleApi(req, res, url);

    // 静态：public/ 下，支持 / 与 /index.html
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const abs = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ""));
    if (!abs.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end("403");
      return;
    }
    return await serveStatic(res, abs);
  } catch (e) {
    console.error(`[错误] ${req.method} ${url.pathname}:`, e);
    json(res, 500, { ok: false, message: String(e && e.stack ? e.stack : e) });
  }
});

// ---------------------------------------------------------------- 启动
const args = process.argv.slice(2);
function argOf(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const PORT = Number(argOf("--port", process.env.PF_PORT || 8787));
const HOST = argOf("--host", "127.0.0.1");

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log("");
  console.log("  poster-forge 站点已启动");
  console.log("  ----------------------------------------");
  console.log(`  地址        ${url}`);
  console.log(`  Python      ${PYTHON}`);
  console.log(`  渲染器      ${FORGE_ROOT}`);
  console.log(`  渲染器就绪  ${existsSync(path.join(FORGE_ROOT, "render.py")) ? "是" : "否（检查 poster-forge 目录）"}`);
  console.log("  ----------------------------------------");
  console.log("  自检： " + url + "/api/health");
  console.log("  停止： Ctrl + C");
  console.log("");
});
