/**
 * brain.mjs —— 让大模型决定"生成什么"。
 *
 * 分工（这是整个改动的核心，别搞混）：
 *   · 大模型负责**内容与调性**：读用户给的图，读懂用户那句要求，写出海报上真正要印的字。
 *   · 渲染器负责**几何与字体**：坐标、字号、行高、避让、缩到放得下 —— 全部确定性。
 *
 * 为什么不让模型直接吐坐标：
 * 它是概率模型，坐标会飘（重叠、越界、字号不匹配），而这正是渲染引擎已经解决得更好、
 * 且可复现的部分。同类项目也是这个分工 —— PosterLLaVa 用 MLLM 出布局 JSON 后，
 * 仍要交给 SVG 渲染器落地（https://arxiv.org/abs/2406.02884）。
 * 我们这里更进一步：模型连坐标都不出，只出"内容 + 用不用图"，几何由引擎按版面算。
 *
 * 为什么不用模板库顶替：
 * 模板库只能把用户的话换个说法，写不出"西湖今日实拍"这种针对具体照片和地点的文案。
 * 模型能；而且模型能读懂"帮我融合这两张图并配上去西湖的旅游文案"这种要求。
 *
 * 本文件不依赖任何第三方 npm 包，走 Ollama 的 HTTP API。
 */

import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

export const BRAIN_LAYOUTS = ["poster_text", "poster_photo_bg", "poster_photo_strip"];
export const BRAIN_KINDS = ["tourism", "food", "stay", "event", "sale"];
/** 打卡卡的照片排法：单张大图 / 并排两栏 / 三栏 / 2×2 网格 */
export const CHECKIN_GRIDS = ["single", "two-col", "three-col", "quad"];

// 断行规则与前端共用同一份（public/poster-layout.mjs），避免两条路排出来两个样
import { splitTitleLines, TITLE_LINE_MAX } from "./public/poster-layout.mjs";
export { splitTitleLines, TITLE_LINE_MAX };

/* ------------------------------------------------------------------ 提示词 */
//
// 提示词里每一条"禁止"都对应一个真实踩过的坑：
//   · 把用户的要求原样当标题 → 海报上印出"帮我融合这两张图片…"
//   · 写"限时特惠"这类空话 → 换个店名也能用，等于没写
//   · 编价格电话销量 → 假信息被用户直接发布出去
//   · 复述画面描述 → "夕阳西下海面波光粼粼"当标题，读者看不到任何信息
const COPY_SYSTEM = `你是一位给文旅、酒店、餐饮写中文宣传海报的策划。用户会给你「硬事实」（店名、价格、电话、时间等）和「画面描述」（他上传的照片里有什么）。
你的任务：写出这张海报上真正要印的字。

只输出一个 JSON 对象，不要输出解释、不要用 markdown 代码块。字段：
{
  "title": "主标题。**总长 10-14 个汉字**，最多两行（用 \\n 断行，每行 ≤7 字最稳）。要具体：写清地点/店名/活动名 + 卖点，让人一眼知道这是什么、值不值得来。不要写成一句长话。",
  "sub": "副标题。1-3 行，每行不超过 18 字，用 \\n 分隔。补标题没说完的信息。",
  "tags": ["2-4 个短标签，每个不超过 6 字"],
  "price": "价格文案，如 ￥299。用户没给价格就填 null。",
  "phone": "联系电话。用户没给就填 null。",
  "address": "地址。用户没给就填 null。",
  "brand": "店名/机构名。用户没给就填 null。",
  "layout": "${BRAIN_LAYOUTS.join('" | "')}",
  "kind": "${BRAIN_KINDS.join('" | "')}",
  "tone": 0.0 到 1.0 的小数，越大越热闹（促销/市集偏大，景区/民宿偏小）,
  "reason": "一句话说明你为什么这么写（给人工核对用，不会印上海报）"
}

layout 怎么选：
  · 有照片且是多张 → "poster_photo_strip"（照片会在版面顶部拼成图带）
  · 有照片且只有一张 → "poster_photo_bg"（照片铺满做底图）
  · 没照片，或照片不适合当底图（杂乱、过暗、纯截图）→ "poster_text"

硬规则（违反即作废）：
1. 绝对不要把用户的要求原样当标题。像"帮我融合这两张图片""请生成一张海报"这类话是**指令**，
   你要照它做，不能把它印上去。
2. 不要写"限时特惠""火热进行中""欢迎光临""不容错过"这类放之四海皆可的空话。
3. 不要编造具体事实：价格、电话、地址、销量、优惠幅度、日期 —— 用户给了才能写，没给就填 null。
4. 可以引用画面描述里的**景物**（海、日落、雪、茶山…）来起标题，但不要把描述整句抄成标题。
5. 标题里的数字只在用户给了具体数字时才用。`;

// 提示词用"填空格式 + 一个示例"，而不是"第一行/第二行"的说明。
// 原因：3B 视觉模型对示例的服从度远高于对说明的理解 ——
// 实测它会把"第一行：画面主体 + 氛围"原文抄回来当答案，
// 换成"主体：/主题："这种标签格式后就老实了（同三张图对比验证过）。
const VISION_SYSTEM = `看这张照片，用两行中文回答，严格照下面格式，不要序号、不要重复我的话、不要解释：

主体：<画面里是什么，含氛围，20字内>
主题：<适合做什么主题的海报，12字内>

例如：
主体：夕阳下的海面，波光粼粼，宁静
主题：海边日落`;

const MIXABLE_SYSTEM = `你要判断用户上传的一组照片能不能放进**同一张**打卡卡讲同一个主题。
照片如果主体、场景、风格能自然讲成同一件事，就算能；
写实风景配二次元人物、互不相干的场景，就算不能。

只输出一个 JSON 对象，不要解释：
{"mixable": true 或 false, "why": "不能时用一句话说清为什么不搭（20 字内）；能则填空字符串"}`;

const CHECKIN_SYSTEM = `你在给用户的照片写「打卡卡」上要印的中文文案。
打卡卡是发朋友圈/小红书那种：上面是照片，下面是短标题 + 一两句描述。

只输出一个 JSON 对象，不要解释、不要 markdown 代码块。字段：
{
  "caption": "卡片上的短标题，10-18 个汉字，最多两行（用 \\n 断行）。",
  "body": "描述，1-2 句，最多 44 字，一行写完不换行。",
  "tags": ["2-3 个短标签，每个不超过 6 字"],
  "grid": "single | two-col | three-col | quad",
  "reason": "一句话说明为什么这么写（给人工核对，不会印到卡上）"
}

grid 选择：1 张→single；2 张→two-col；3 张→three-col；4 张→quad。

硬规则（违反即作废）：
1. 绝对不要把用户的话原样当 caption。像"帮我把两张图片融合""帮我写好文案"这类是**指令**，
   你要照它做，不能把它印上去。用户没说要什么主题时，就从画面里找主题。
2. 不要写"随手一拍就是大片""最佳机位""欢迎光临"这类放哪都能用的空话。
3. 要具体：画面里有什么、什么时间、什么感受。可以引用画面里的景物、天气、颜色。
4. 不要编造数字（价格、销量、日期、门牌号）。
5. 如果用户给的照片**主题互不相干**（比如一张风景 + 一张动漫人物），
   不要硬把它们编成一个故事；caption 就写这次记录本身（如"今天走了两万步"），
   body 分别点一下两张照片里各自的东西。`;

/* ------------------------------------------------------------------ 图像提示词 */
const IMAGE_PROMPT_SYSTEM = `你在为一张中文宣传海报写**图像生成提示词**（给扩散模型用）。

只输出一个 JSON 对象，不要解释：
{"prompt": "英文提示词", "reason": "一句中文说明为什么这么画"}

prompt 要求：
1. 用**英文**写，逗号分隔的短语，不要整句、不要用中文。
2. 描述**画面**：主体、场景、时间、天气、色调、光线、风格。
3. 构图要给下方留出空白放文字 —— 主体放在上 2/3，末尾固定加上：
   "no text, no words, no watermark, no logo, clean empty space at the bottom for typography"
4. **绝对不要出现中文、汉字、招牌文字**（扩散模型画中文会糊成乱码）。
5. 不要画人物特写（肖像权与观感都麻烦），需要"人"时写 distant silhouette。
6. 不要出现商标、品牌、真实地名招牌。

例：
{"prompt":"West Lake in early morning mist, calm water, distant pagoda silhouette, weeping willow branches framing the top, ink-wash painting mood, soft natural light, no text, no words, no watermark, no logo, clean empty space at the bottom for typography","reason":"西湖清晨的意境，留白给标题"}`;

/**
 * 让文案模型把"这次要宣传什么"翻译成给扩散模型用的图像提示词。
 *
 * 为什么让模型写而不是拼模板：底图要贴合这次的**具体主题**（西湖 / 火锅 / 雪场），
 * 而且必须刻意避开中文和文字 —— 扩散模型画汉字会糊成乱码，
 * 把这条写进提示词规则里比事后补救靠谱。
 */
export async function deriveImagePrompt(cfg, { brief = "", copy = null, scenes = [] } = {}) {
  if (!cfg.copy) return { ok: false, reason: "未配置文案模型", prompt: "" };
  const parts = [`【这次要宣传的内容】\n${brief || "（用户只说要一张海报）"}`];
  if (copy) {
    const head = copy.title || copy.caption || "";
    const tail = copy.sub || copy.body || "";
    if (head) parts.push(`【海报上会印的字（仅用于理解主题，不要画成字）】\n${head}\n${tail}`);
  }
  if (scenes.length) {
    parts.push(`【用户照片里的画面（作为风格参考）】\n${scenes.map((s) => s.scene).join("；")}`);
  }
  parts.push("【请作答】输出那个 JSON，prompt 必须是英文且不含任何文字/汉字。");
  try {
    const raw = await ollamaChat(cfg, {
      model: cfg.copy,
      messages: [
        { role: "system", content: IMAGE_PROMPT_SYSTEM },
        { role: "user", content: parts.join("\n\n") },
      ],
      format: "json",
      maxTokens: 320,
    });
    const j = JSON.parse(extractJson(raw));
    let prompt = String(j.prompt || "").trim();
    // 保险：模型偶尔还是塞中文进来。含中文就判失败，由调用方回落 ——
    // 硬画中文的结果是一堆乱码笔画，比没有底图更糟。
    if (!prompt || /[\u4e00-\u9fa5]/.test(prompt)) {
      return { ok: false, reason: "模型给的提示词为空或含中文", prompt: "", raw };
    }
    if (!/no text|no words|without text/i.test(prompt)) {
      prompt += ", no text, no words, no watermark, no logo, clean empty space at the bottom for typography";
    }
    return { ok: true, prompt, reason: String(j.reason || "").trim(), raw };
  } catch (e) {
    return { ok: false, reason: e.message, prompt: "" };
  }
}

/**
 * 让 Ollama 把模型从显存里卸掉。
 *
 * 为什么需要：8 GB 显存上，Ollama 的视觉/文案模型和 ComfyUI 的图像模型放不下两张。
 * 出图前先卸 Ollama，出完图下一次对话时它会自动重新加载（首次约几秒）。
 */
export async function unloadModels(cfg, models = []) {
  const out = [];
  for (const model of models.filter(Boolean)) {
    try {
      await fetch(`${cfg.endpoint}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: "", keep_alive: 0 }),
        signal: AbortSignal.timeout(15000),
      });
      out.push({ model, ok: true });
    } catch (e) {
      out.push({ model, ok: false, reason: e.message });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 配置 */
export function loadBrainConfig(siteRoot) {
  const file = path.join(siteRoot, "brain.config.json");
  const cfg = {
    enabled: true,
    endpoint: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
    vision: "qwen2.5vl:3b",
    copy: "qwen2.5:7b",
    timeoutMs: 120000,
    maxImageSide: 896,
    visionMaxTokens: 160,
    copyMaxTokens: 500,
    temperature: 0.7,
    keepAlive: "30m",
  };
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      for (const k of Object.keys(cfg)) {
        if (raw[k] !== undefined && !k.startsWith("_")) cfg[k] = raw[k];
      }
    }
  } catch {
    // 配置坏了就用默认值，不要让整站起不来
  }
  return cfg;
}

/* ------------------------------------------------------------------ 调用 */
export class BrainError extends Error {
  constructor(message, { kind = "brain", cause = null } = {}) {
    super(message);
    this.name = "BrainError";
    this.kind = kind;
    this.cause = cause;
  }
}

/**
 * 确保本机 Ollama 在跑；没跑就**自己把它拉起来**。
 *
 * 为什么要有这个：原来模型不在时，界面直接退回确定性规则，
 * 提示"要让模型写文案，确认 Ollama 在运行"—— 把责任推给用户。
 * 但 Ollama 就装在本机、命令是确定的，没理由让用户自己去开。
 *
 * 拉起方式用 detached + unref：它必须活得比本进程久。
 * （踩过的坑：非 detached 的子进程会随父进程一起被带走，
 *  服务一重启模型就没了。）
 */
const OLLAMA_CANDIDATES = [
  process.env.PF_OLLAMA_BIN,
  path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe"),
  "C:\\Program Files\\Ollama\\ollama.exe",
  "C:\\Program Files (x86)\\Ollama\\ollama.exe",
  "ollama",
].filter(Boolean);

async function pingOllama(cfg, timeoutMs = 1500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`${cfg.endpoint}/api/tags`, { signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

let starting = null;   // 并发调用时只拉一次，不要同时起好几个 serve

async function ensureOllama(cfg, { waitMs = 40000 } = {}) {
  if (await pingOllama(cfg)) return { ok: true, already: true };

  if (!starting) {
    starting = (async () => {
      let bin = null;
      for (const c of OLLAMA_CANDIDATES) {
        if (c === "ollama" || existsSync(c)) { bin = c; break; }
      }
      if (!bin) return { ok: false, message: "找不到 ollama 可执行文件（可用 PF_OLLAMA_BIN 指定路径）" };
      try {
        const p = spawn(bin, ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
        p.unref();
        return { ok: true, spawned: bin };
      } catch (e) {
        return { ok: false, message: `启动 ollama 失败：${e.message}` };
      }
    })().finally(() => { setTimeout(() => { starting = null; }, 5000); });
  }
  const r = await starting;
  if (!r.ok) return r;

  // 等它把端口监听起来（首次启动要几秒）
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    if (await pingOllama(cfg)) return { ok: true, spawned: r.spawned, waitedMs: Date.now() - t0 };
    await new Promise((s) => setTimeout(s, 700));
  }
  return { ok: false, message: `已尝试启动 ollama，但 ${waitMs / 1000}s 内没起来` };
}

async function ollamaChat(cfg, { model, messages, format, maxTokens, temperature }) {
  if (!model) throw new BrainError("没有配置模型", { kind: "config" });
  // 进来先确认模型服务在 —— 不在就自己拉，别等请求失败了再说
  await ensureOllama(cfg).catch(() => {});
  try {
    return await ollamaChatOnce(cfg, { model, messages, format, maxTokens, temperature });
  } catch (e) {
    // 还是离线：可能刚才那次拉起没成功，再试一次（可能是端口刚起来还没就绪）
    if (e instanceof BrainError && e.kind === "offline") {
      const r = await ensureOllama(cfg).catch(() => ({ ok: false }));
      if (r.ok) return await ollamaChatOnce(cfg, { model, messages, format, maxTokens, temperature });
      throw new BrainError(
        `${e.message}｜自动拉起失败：${r.message || "未知原因"}`,
        { kind: "offline" },
      );
    }
    throw e;
  }
}

async function ollamaChatOnce(cfg, { model, messages, format, maxTokens, temperature }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  try {
    const r = await fetch(`${cfg.endpoint}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctl.signal,
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        format: format || undefined,
        keep_alive: cfg.keepAlive,
        options: {
          temperature: temperature ?? cfg.temperature,
          num_predict: maxTokens,
        },
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new BrainError(`模型返回 ${r.status}：${text.slice(0, 200)}`, { kind: "http" });
    }
    const j = await r.json();
    if (j.error) throw new BrainError(String(j.error).slice(0, 300), { kind: "model" });
    return (j.message?.content || "").trim();
  } catch (e) {
    if (e.name === "AbortError") {
      throw new BrainError(`模型超时（${Math.round(cfg.timeoutMs / 1000)}s）`, { kind: "timeout" });
    }
    if (e instanceof BrainError) throw e;
    throw new BrainError(`连不上模型服务（${cfg.endpoint}）：${e.message}`, { kind: "offline" });
  } finally {
    clearTimeout(timer);
  }
}

/** Ollama 是否在跑，以及有哪些模型 */
export async function brainStatus(cfg) {
  const out = { up: false, endpoint: cfg.endpoint, models: [], hasVision: false, hasCopy: false };
  try {
    const r = await fetch(`${cfg.endpoint}/api/tags`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    out.up = true;
    out.models = (j.models || []).map((m) => m.name);
    out.hasVision = !!cfg.vision && out.models.some((n) => n === cfg.vision || n.startsWith(cfg.vision));
    out.hasCopy = !!cfg.copy && out.models.some((n) => n === cfg.copy || n.startsWith(cfg.copy));
  } catch {
    out.up = false;
  }
  return out;
}

/* ------------------------------------------------------------------ 读图 */
/**
 * 把视觉模型的输出解析成场景描述。
 *
 * 这里要处理的脏输出（都是我实测遇到过的原始输出）：
 *   "第1行：画面主体 + 氛围，20 字以内：实拍风景…"   ← 把提示词抄回来
 *   "画面主体：汉服博物馆的走廊，氛围：古色古香…"      ← 带标签
 *   "这张照片适合做成汉服文化主题。"                  ← 主题没换行，跟在前一句后面
 *   "夕阳下的海面，宁静而美丽。  \n夕阳下的海面…"     ← 两行一模一样（没答主题）
 * 不清理的话这些标签会当画面描述喂给文案模型，写出的文案就带上提示词味。
 */
export function parseVisionText(text) {
  // 摘掉"把提示词抄回来"的那一段。
  // 实测原始输出：`第1行：画面主体 + 氛围，20 字以内：实拍风景，色彩鲜艳…`
  // 标签是**串在一起**的（第1行： + 画面主体 + 氛围 + 字数要求 + ：），
  // 逐个 replace 会被中间那截" + 氛围，20 字以内"挡住，所以这里做整段前缀剥离：
  // 只要这一行出现过提示词特征（字数要求 / 第N行），就取**最后一个冒号之后**的内容。
  const deEcho = (s) => {
    let t = String(s || "");
    if (/字以内|第\s*[一二三四1234]\s*行|不要序号|不要解释/.test(t)) {
      const cut = Math.max(t.lastIndexOf("："), t.lastIndexOf(":"));
      if (cut >= 0) t = t.slice(cut + 1);
    }
    return t;
  };

  const strip = (s) =>
    deEcho(s)
      .replace(/^\s*第\s*[一二三四1234]\s*行\s*[:：]?\s*/, "")
      .replace(/^\s*[（(]?\d\s*[)）.、]\s*/, "")
      .replace(/^[-*·]\s*/, "")
      // 标签前缀：主体/画面主体/氛围/主题/这张照片适合做成…
      .replace(/^\s*(?:画面主体|主体|氛围|这张照片适合做成什么主题|这张照片适合做成|适合做成什么主题|适合做成|主题)\s*(?:和氛围)?\s*[:：]?\s*/, "")
      .replace(/\s*[:：]\s*$/, "")
      .trim();

  let lines = String(text || "")
    .split(/\n+/)
    .map(strip)
    .filter(Boolean);

  // 主题常被模型并进第一行（"…红灯笼。这张照片适合做成汉服文化主题。"）
  const merged = lines.findIndex((l) => /适合做成|适合做|主题[:：]/.test(l));
  if (merged >= 0) {
    const one = lines[merged];
    const cut = one.search(/这张照片适合做成|适合做成|适合做|主题[:：]/);
    if (cut > 0) {
      const head = strip(one.slice(0, cut));
      const tail = strip(one.slice(cut).replace(/^[^:：]*[:：]?\s*/, ""));
      lines = [head, tail].filter(Boolean);
    } else {
      lines[merged] = strip(one.replace(/^[^:：]*[:：]?\s*/, ""));
    }
  }

  // 两行完全相同 = 模型没答主题，别把同一句当主题用
  if (lines.length >= 2 && lines[0] === lines[1]) lines = [lines[0]];

  return { ok: true, raw: text, scene: lines[0] || "", theme: lines[1] || "" };
}

/** 让视觉模型看一张照片 */
export async function describeImage(cfg, absImagePath) {
  if (!cfg.vision) return { ok: false, reason: "未配置视觉模型" };
  if (!existsSync(absImagePath)) return { ok: false, reason: "图片不存在" };
  try {
    const b64 = (await readFile(absImagePath)).toString("base64");
    const text = await ollamaChat(cfg, {
      model: cfg.vision,
      messages: [
        { role: "system", content: VISION_SYSTEM },
        { role: "user", content: "看这张照片。", images: [b64] },
      ],
      maxTokens: cfg.visionMaxTokens,
      // 读图要的是稳定描述，不是创意，所以温度压低
      temperature: 0.2,
    });
    return parseVisionText(text);
  } catch (e) {
    return { ok: false, reason: e.message, kind: e.kind };
  }
}

/**
 * 分析一张参考图，判断它适合哪种**版式构图**。
 *
 * 为什么单独做这一件事、而不是复用 describeImage：
 * describeImage 回答的是"照片里有什么"（用来写文案）；
 * 这个回答的是"这张图该怎么排"（用来选版面）—— 两个问题不同，
 * 提示词也不同，混在一起会互相干扰。
 *
 * 为什么要让用户能单独传一张图来分析：用户手上常有一张"我就想要这种感觉"的
 * 参考图，它未必是他要用的素材。把它塞进普通上传会污染海报底图，
 * 所以分析入口和上传入口分开。
 */
const LAYOUT_ANALYSIS_SYSTEM = `你是海报版式顾问。看这张参考图，判断它最适合下列哪一种海报构图。

可选构图（只能选一个，回复英文键名）：
- fullbleed  满版压暗：图铺满整张，文字压在图上，适合风景/氛围强的照片
- axial      中轴对称：全部元素居中，沿中轴排列，适合仪式感、正式场合
- split      上下分割：图在上半，文字在下方实色区，适合需要清楚写价格/时间的物料
- splitv     左右分割：图在右侧，文字在左侧窄栏，适合竖构图的单品特写
- focal      重心环绕：图是居中悬浮的卡片，文字环绕上下，适合有明确单一主体
- grid       网格信息：图在上方，下面是四格信息（时间/价格/电话/地址），适合票务/赛事
- typeled    文字主导：不用图，居中大标题，适合通知/公告

严格按三行回答，不要序号、不要解释、不要重复我的问题：
构图: <上面七个键名之一>
调性: <warm 或 cool 或 calm>
理由: <一句话，20 字以内，说清这张图的什么特征让你这么判断>`;

export async function analyzeLayout(cfg, absImagePath) {
  if (!cfg.vision) return { ok: false, reason: "未配置视觉模型（brain.config.json 的 vision）" };
  if (!absImagePath || !existsSync(absImagePath)) return { ok: false, reason: "图片不存在" };
  try {
    const b64 = (await readFile(absImagePath)).toString("base64");
    const text = await ollamaChat(cfg, {
      model: cfg.vision,
      messages: [
        { role: "system", content: LAYOUT_ANALYSIS_SYSTEM },
        { role: "user", content: "分析这张图适合的版式。", images: [b64] },
      ],
      maxTokens: 200,
      temperature: 0.1,     // 这是判断题，不是创作题
    });

    // 解析三行。模型有时会加序号或多余空格，这里都容忍。
    const KEYS = ["fullbleed", "axial", "split", "splitv", "focal", "grid", "typeled"];
    const clean = (s) => String(s || "").replace(/^[\s\d.、)）*#-]+/, "").trim();
    let composition = null, tone = null, reason = "";
    for (const line of String(text).split(/\n+/)) {
      const m = line.match(/^\s*(构图|版式|调性|理由)\s*[:：]\s*(.+)$/);
      if (!m) continue;
      const val = clean(m[2]);
      if (m[1] === "构图" || m[1] === "版式") {
        // 模型可能回中文名或英文键名，两种都认
        const hit = KEYS.find((k) => val.toLowerCase().includes(k));
        if (hit) composition = hit;
      } else if (m[1] === "调性") {
        tone = ["warm", "cool", "calm"].find((t) => val.toLowerCase().includes(t)) || null;
      } else {
        reason = val.slice(0, 60);
      }
    }
    // 一行都没解析出来时，退而求其次：全文里找键名
    if (!composition) composition = KEYS.find((k) => String(text).toLowerCase().includes(k)) || null;
    if (!composition) {
      return { ok: false, reason: "模型没给出可识别的构图", raw: String(text).slice(0, 200) };
    }
    return { ok: true, composition, tone, reason, raw: String(text).slice(0, 200) };
  } catch (e) {
    return { ok: false, reason: e.message, kind: e.kind };
  }
}

/**
 * AI 助手的通用对话（流式）。
 *
 * 为什么不用 HikiTravel 的 /api/chat：那是**旅游规划**接口，不是聊天 ——
 * 你对它说"你好"，它回的是"还缺少这些信息：目的地、游玩天数、预算"。
 * 助手要的是能闲聊、能答疑、能帮改文案的对话，所以拿本机 Ollama 现建一个。
 *
 * 用流式是为了让用户看到字在往外蹦 —— 本地模型首字要 1~3 秒，
 * 不给反馈用户会以为卡死了。
 */
export async function assistantChat(cfg, messages, { onDelta, signal } = {}) {
  if (!cfg.copy) throw new BrainError("没有配置对话模型", { kind: "config" });
  await ensureOllama(cfg).catch(() => {});
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs || 120000);
  // 外部想取消（用户关掉面板）时也要能中断，不然模型还在白跑
  if (signal) signal.addEventListener("abort", () => ctl.abort(), { once: true });
  try {
    const r = await fetch(`${cfg.endpoint}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctl.signal,
      body: JSON.stringify({
        model: cfg.copy, messages, stream: true, keep_alive: cfg.keepAlive,
        options: { temperature: 0.7, num_predict: 500 },
      }),
    });
    if (!r.ok) throw new BrainError(`模型返回 ${r.status}`, { kind: "http" });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", full = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.error) throw new BrainError(String(j.error).slice(0, 200), { kind: "model" });
        const piece = j.message?.content || "";
        if (piece) { full += piece; if (onDelta) onDelta(piece); }
      }
    }
    return full.trim();
  } catch (e) {
    if (e.name === "AbortError") throw new BrainError("对话超时或被取消", { kind: "timeout" });
    if (e instanceof BrainError) throw e;
    throw new BrainError(`连不上模型服务：${e.message}`, { kind: "offline" });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 逐张读图，再用**文案模型**判断"这组照片搭不搭"。
 *
 * 为什么不让视觉模型一次看多张：实测 qwen2.5vl:3b 一次给两张图时
 * 只描述第一张，第二张完全没看（多次复现）。逐张看更可靠。
 * 而"搭不搭"是个纯文本判断题，交给 7B 文案模型准得多 ——
 * 实测它能准确说出"色彩主题与汉服文化不相关"。
 * 这一步会让文案更贴图：不搭就不硬编成一个故事。
 */
export async function describeImages(cfg, absImagePaths) {
  const paths = absImagePaths.slice(0, 4).filter((p) => existsSync(p));
  const scenes = [];
  const visionErrors = [];
  for (const p of paths) {
    const d = await describeImage(cfg, p);
    if (d.ok) scenes.push({ file: path.basename(p), scene: d.scene, theme: d.theme });
    else visionErrors.push({ file: path.basename(p), reason: d.reason });
  }

  let mixable = true;
  let mixWhy = "";
  if (scenes.length >= 2 && cfg.copy) {
    try {
      const raw = await ollamaChat(cfg, {
        model: cfg.copy,
        messages: [
          { role: "system", content: MIXABLE_SYSTEM },
          {
            role: "user",
            content:
              `照片画面：\n` +
              scenes.map((s, i) => `  第${i + 1}张：${s.scene}（主题：${s.theme}）`).join("\n") +
              `\n\n它们能放进同一张卡片讲同一个主题吗？`,
          },
        ],
        format: "json",
        maxTokens: 120,
        temperature: 0.2,
      });
      const j = JSON.parse(extractJson(raw));
      mixable = j.mixable !== false;
      // 模型偶尔把 why 写成乱码，只接受像句子的内容
      mixWhy = mixable ? "" : String(j.why || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9，。、：（）\s]/g, "").slice(0, 40);
    } catch {
      // 判不出来就当"搭"，不给用户添乱
      mixable = true;
    }
  }

  return {
    ok: scenes.length > 0,
    scenes,
    visionErrors,
    mixable,
    mixWhy,
    reason: scenes.length ? "" : (visionErrors[0]?.reason || "读图失败"),
  };
}

/* ------------------------------------------------------------------ 写文案 */
/** 把模型输出里夹带的 markdown 代码块 / 前后废话剥掉，尽量拿到纯 JSON */
function extractJson(text) {
  let s = String(text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return s;
}

function str(v, max) {
  if (typeof v !== "string") return null;
  let t = v
    .replace(/\r/g, "")
    // 模型有时把"两行"写成字面量反斜杠 n（"静享海风\\n品味宁静"），
    // 不转换就会原样印到海报上变成一串 "\n" 字母
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    // 模型有时用 HTML 实体代替换行（"多彩生活&nbsp;西湖之旅"），这不是"换行"，
    // 会原样印到海报上变成一串乱码字母
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/<br\s*\/?>/gi, "\n")
    // 去掉字面量 "null" / "None" / "undefined"：模型把没值的字段写进句子里了
    .replace(/[（(]?\s*(?:联系电话|电话|咨询电话|地址|价格)\s*[:：]?\s*(?:null|None|undefined|无)\s*[)）]?/gi, "")
    .replace(/\b(?:null|None|undefined)\b/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

/** 联系方式类字段已经从 title/sub 里摘掉后，句尾常留下悬空的标点 */
function tidy(s) {
  if (!s) return s;
  return s
    .split("\n")
    .map((l) => l.replace(/[，,、：:；;·\s]+$/, "").replace(/^[，,、：:；;·\s]+/, "").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * 校验并收敛模型输出。
 *
 * 为什么必须校验：模型会超字数、会自己造字段、会把价格写成"详询"、会挑一个不存在的 layout。
 * 这些如果直接透到渲染器，轻则排版挤爆，重则渲染失败。
 * 校验失败不静默通过 —— 返回 errors，让调用方决定是重试还是退回兜底。
 */
export function validateCopy(raw, { hasPhotos = 0, brief = "" } = {}) {
  const errors = [];
  const fatalErrors = [];
  const source = String(brief || "");
  const sourceDigits = source.replace(/\D/g, "");
  let j;
  try {
    j = JSON.parse(extractJson(raw));
  } catch (e) {
    return { ok: false, errors: ["模型输出不是合法 JSON: " + e.message], copy: null };
  }
  if (!j || typeof j !== "object") return { ok: false, errors: ["模型输出不是对象"], copy: null };

  const title = tidy(str(j.title, 40));
  const sub = tidy(str(j.sub, 90));
  if (!title) errors.push("缺 title");
  if (title && title.length < 4) errors.push("title 太短");

  // 标题最多两行，且每行有字数上限 —— 超了排版会挤爆或被硬切。
  // 用共用断行器判断"能不能好好断成两行"，顺便把结果回写进 copy，
  // 保证印出来的断行和这里判定的一致。
  let titleLines = [];
  if (title) {
    titleLines = splitTitleLines(title, TITLE_LINE_MAX);
    if (titleLines.length > 2 || titleLines.some((l) => l.length > TITLE_LINE_MAX + 2)) {
      errors.push(`title 太长，排不进两行（每行上限 ${TITLE_LINE_MAX} 字）：${title}`);
    }
  }

  // 标题不能是"要我怎么干活"的话 —— 这条是用户直接投诉过的
  const REQUESTS = /帮我|请(你|帮)?|麻烦|生成|制作|设计|排版|融合|合成|拼接|配上|做一张|做张|做一份|出一张|给我/;
  if (title && REQUESTS.test(title)) errors.push(`title 里带了指令词，模型没按要求改写：${title}`);

  // layout 必须**先 trim 再比对**：模型常写成 "poster_photo_strip "（尾随空格），
  // 直接 includes 会因为一个空格判定为"不在白名单"，然后回落到错误的版式。
  const wantedRaw = typeof j.layout === "string" ? j.layout.trim() : j.layout;
  const wanted = BRAIN_LAYOUTS.includes(wantedRaw) ? wantedRaw : null;
  let layout = wanted;
  if (j.layout !== undefined && !wanted) {
    errors.push(`layout 不在白名单（收到 ${JSON.stringify(j.layout)}），已按照片数量回落`);
  }
  // 用户传了多张，模型却选了只显示一张的版式 —— 那第 2 张起就白传了。
  // 这是"图片没配上"的直接复现路径，必须挡住：多张一律强制拼图带。
  if (hasPhotos >= 2 && layout && layout !== "poster_photo_strip") {
    errors.push(`用户给了 ${hasPhotos} 张照片，layout=${layout} 只会用上一张，已强制改为 poster_photo_strip`);
    layout = "poster_photo_strip";
  }
  if (!layout) layout = hasPhotos >= 2 ? "poster_photo_strip" : hasPhotos === 1 ? "poster_photo_bg" : "poster_text";
  // 一张图都没有却选了用图的版式：回落为纯文字，避免底图缺省成空白
  if (hasPhotos === 0 && layout !== "poster_text") {
    errors.push(`没有照片，layout=${layout} 不可用，已回落 poster_text`);
    layout = "poster_text";
  }

  const kind = BRAIN_KINDS.includes(j.kind) ? j.kind : "tourism";

  const price = str(j.price, 16);
  // 价格必须是"钱"的样子，别把"详询""面议"当价格印到一个 ￥xx 的版位上
  let priceOk = price && /[￥¥$]|\d/.test(price) ? price : null;
  // 更狠的一条：价格里的数字必须**能在用户原话里找到**。
  // 模型真的会自己编价格 —— 实测给"厦门环岛路海边民宿，含双早"编出了"￥599"。
  // 海报上的价格是报价承诺，编一个等于给用户埋雷，所以这条判为致命错误并触发重写。
  if (priceOk) {
    const digits = priceOk.replace(/\D/g, "");
    if (!digits || !sourceDigits.includes(digits)) {
      fatalErrors.push(`模型编造了价格 ${priceOk}（用户没给过这个数字），已丢弃`);
      errors.push(`编造价格：${priceOk}`);
      priceOk = null;
    }
  }

  const phone = str(j.phone, 24);
  let phoneOk = phone && /\d/.test(phone) ? phone : null;
  if (phoneOk) {
    const digits = phoneOk.replace(/\D/g, "");
    if (digits.length < 7 || !sourceDigits.includes(digits)) {
      fatalErrors.push(`模型编造了电话 ${phoneOk}（用户没给过），已丢弃`);
      errors.push(`编造电话：${phoneOk}`);
      phoneOk = null;
    }
  }

  // 地址不是硬承诺，编了只警告不重写，但仍然不能凭空印一个地址上去
  let address = str(j.address, 40);
  if (address) {
    const tail = address.replace(/\s/g, "").slice(-4);
    if (!source.includes(address) && !source.includes(tail)) {
      errors.push(`地址「${address}」在用户输入里找不到，已丢弃`);
      address = null;
    }
  }

  const tags = Array.isArray(j.tags)
    ? j.tags.map((t) => str(t, 8)).filter(Boolean).slice(0, 4)
    : [];

  const tone = typeof j.tone === "number" && j.tone >= 0 && j.tone <= 1 ? j.tone : null;

  const copy = {
    title,
    // 断好行的标题（前端直接用，别自己再切一遍）
    titleLines,
    sub,
    tags,
    price: priceOk,
    phone: phoneOk,
    address,
    brand: str(j.brand, 20),
    layout,
    kind,
    tone,
    reason: str(j.reason, 80),
  };

  // 有 error 也不算彻底失败：能修的（layout 已回落、地址已丢弃）继续用，
  // 但把 errors 交出去，调用方可以据此重试一次。
  // 致命项（编造价格/电话、标题里带指令词、没标题、不是 JSON）必须重写。
  const fatal = errors.filter((e) =>
    /缺 title|不是合法 JSON|不是对象|带了指令词|编造价格|编造电话|title 太长/.test(e)
  );
  return { ok: fatal.length === 0, errors, fatal, copy };
}

/* ------------------------------------------------------------------ 打卡卡校验 */
/**
 * 打卡卡只要 caption(短标题) + body(描述) + tags + grid。
 * 规则和海报那条一样严格：不许把用户的指令印上去、不许说空话。
 */
export function validateCheckin(raw, { hasPhotos = 0, brief = "" } = {}) {
  const errors = [];
  let j;
  try {
    j = JSON.parse(extractJson(raw));
  } catch (e) {
    return { ok: false, errors: ["模型输出不是合法 JSON: " + e.message], copy: null };
  }
  if (!j || typeof j !== "object") return { ok: false, errors: ["模型输出不是对象"], copy: null };

  const caption = tidy(str(j.caption, 44));
  const body = tidy(str(j.body, 90));
  if (!caption) errors.push("缺 caption");
  if (caption && caption.length < 4) errors.push("caption 太短");

  // 这条是用户直接投诉过的：输入框里写的是"帮我把2张图片融合并帮我写好文案"，
  // 结果这整句被印到了打卡卡的标题上。指令不是文案，必须拦住。
  const REQUESTS = /帮我|请(你|帮)?|麻烦|生成|制作|设计|排版|融合|合成|拼接|配上|做一张|做张|做一份|写好|写一|给我|我要/;
  if (caption && REQUESTS.test(caption)) errors.push(`caption 里带了指令词，模型没按要求改写：${caption}`);
  if (body && REQUESTS.test(body)) errors.push(`body 里带了指令词：${body.slice(0, 30)}`);

  // 空话：放哪都能用的话等于没写
  const CLICHES = /随手一拍就是大片|欢迎光临|不容错过|限时特惠|火热进行中|最佳机位/;
  if (caption && CLICHES.test(caption)) errors.push(`caption 是空话：${caption}`);

  const wantedGrid = typeof j.grid === "string" ? j.grid.trim() : null;
  let grid = CHECKIN_GRIDS.includes(wantedGrid) ? wantedGrid : null;
  if (j.grid !== undefined && !grid) errors.push(`grid 不在白名单（收到 ${JSON.stringify(j.grid)}）`);
  // grid 必须和照片数量一致，否则会出现"选了 single 但传了 3 张"这种丢图情况
  const byCount = { 0: "single", 1: "single", 2: "two-col", 3: "three-col", 4: "quad" };
  const expect = byCount[Math.min(hasPhotos, 4)];
  if (grid && hasPhotos >= 1 && grid !== expect) {
    errors.push(`grid=${grid} 与 ${hasPhotos} 张照片不匹配，已改为 ${expect}`);
    grid = expect;
  }
  if (!grid) grid = expect;

  const tags = Array.isArray(j.tags) ? j.tags.map((t) => str(t, 8)).filter(Boolean).slice(0, 3) : [];

  const copy = {
    caption,
    body,
    tags,
    grid,
    reason: str(j.reason, 80),
  };

  const fatal = errors.filter((e) =>
    /缺 caption|不是合法 JSON|不是对象|带了指令词|是空话/.test(e)
  );
  return { ok: fatal.length === 0, errors, fatal, copy };
}

/* ------------------------------------------------------------------ 主入口 */
/**
 * 完整链路：读图（可选）→ 写文案 → 校验。
 *
 * @param cfg           loadBrainConfig 的返回值
 * @param brief         用户输入的原话
 * @param imagePaths    用户照片在本地的绝对路径
 * @param opts.mode     "poster"（默认）| "checkin"
 * @param opts.facts    从用户输入里确定性解析出来的硬事实（价格/电话/地址），优先级高于模型
 * @param opts.retry    校验失败时是否让模型重写一次
 */
export async function composeCopy(cfg, brief, imagePaths = [], opts = {}) {
  const mode = opts.mode === "checkin" ? "checkin" : "poster";
  const hasPhotos = imagePaths.length;
  const started = Date.now();

  // 1) 读图：一次把所有照片交给视觉模型，同时问出"这组照片搭不搭"
  const vision = await describeImages(cfg, imagePaths);
  const scenes = vision.scenes || [];
  const visionErrors = vision.ok ? [] : [{ file: "(全部)", reason: vision.reason || "读图失败" }];
  if (vision.ok && vision.mixable === false && vision.mixWhy) {
    visionErrors.push({ file: "(主题)", reason: `照片主题不太搭：${vision.mixWhy}` });
  }

  // 2) 组织给文案模型的输入
  const parts = [];
  parts.push(`【用户的话】\n${brief || "（用户没有写文字，只有照片）"}`);
  if (opts.facts && Object.keys(opts.facts).length) {
    const lines = Object.entries(opts.facts)
      .filter(([, v]) => v)
      .map(([k, v]) => `  ${k}: ${v}`);
    if (lines.length) parts.push(`【从用户话里提取到的硬事实（必须照用，不要改写数字）】\n${lines.join("\n")}`);
  }
  if (scenes.length) {
    parts.push(
      `【用户上传了 ${hasPhotos} 张照片，画面如下】\n` +
        scenes.map((s, i) => `  第${i + 1}张：${s.scene}${s.theme ? `（适合主题：${s.theme}）` : ""}`).join("\n")
    );
    // 明确告诉文案模型"这组照片不搭"，否则它会硬编一个共同故事
    if (vision.mixable === false) {
      parts.push(
        `【重要】这 ${hasPhotos} 张照片主题互不相干${vision.mixWhy ? `（${vision.mixWhy}）` : ""}。` +
          `不要硬把它们编成一个故事：标题写这次记录本身，描述里分别点一下各自画面里的东西。`
      );
    }
  } else if (hasPhotos) {
    parts.push(`【用户上传了 ${hasPhotos} 张照片，但读图失败，请只依据文字写文案】`);
  }

  const system = mode === "checkin" ? CHECKIN_SYSTEM : COPY_SYSTEM;
  const validator = mode === "checkin" ? validateCheckin : validateCopy;
  parts.push(
    mode === "checkin"
      ? `【请作答】输出那个 JSON。grid 只能从 ${CHECKIN_GRIDS.join(" / ")} 里选，且必须和 ${hasPhotos} 张照片匹配。`
      : `【请作答】输出那个 JSON。layout 只能从 ${BRAIN_LAYOUTS.join(" / ")} 里选。`
  );
  const userMsg = parts.join("\n\n");

  // 3) 写文案。校验不过就带着"哪里不合格"再问一次 ——
  //    模型偶尔会吐不合规 JSON 或把指令词写进文案，重试一次的成本远低于让用户重填。
  const maxAttempts = opts.retry === false ? 1 : 2;
  let attempt = 0;
  let last = null;
  let ask = userMsg;
  while (attempt < maxAttempts) {
    attempt++;
    const rawDraft = await ollamaChat(cfg, {
      model: cfg.copy,
      messages: [
        { role: "system", content: system },
        { role: "user", content: ask },
      ],
      format: "json",
      maxTokens: cfg.copyMaxTokens,
    });
    last = validator(rawDraft, { hasPhotos, brief });
    last.raw = rawDraft;
    if (last.ok) break;
    if (attempt < maxAttempts) {
      ask =
        userMsg +
        `\n\n【上一次的回答不合格，请修正后重新输出 JSON】\n问题：\n` +
        last.errors.map((e) => `  - ${e}`).join("\n") +
        `\n上一次的输出：\n${String(rawDraft).slice(0, 400)}`;
    }
  }

  return {
    ok: !!(last && last.ok),
    mode,
    copy: last?.copy || null,
    raw: last?.raw || "",
    errors: last?.errors || ["未产生输出"],
    scenes,
    visionErrors,
    mixable: vision.ok ? vision.mixable : null,
    mixWhy: vision.mixWhy || "",
    ms: Date.now() - started,
    model: { vision: cfg.vision, copy: cfg.copy },
    attempts: attempt,
  };
}
