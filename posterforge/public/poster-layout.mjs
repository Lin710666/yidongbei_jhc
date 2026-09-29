/**
 * poster-layout.mjs —— 海报版面的**唯一**几何定义。
 *
 * 为什么要单独一个文件：现在有两条路都会生成海报 ——
 *   1. 浏览器本地构造（用户没联网/没开模型时的兜底）
 *   2. 服务端由大模型出文案后构造（/api/compose）
 * 两条路必须给出同一套坐标，否则同一个输入会渲出两种版式，改一处忘一处。
 * 所以几何只写在这里，服务端 import，浏览器也 import（原生 ESM，不需要打包器）。
 *
 * 分工边界：本文件只处理**几何**（放哪、多大、什么颜色）；
 * 印什么字由大模型决定（见 site/brain.mjs）。
 */

/** 拼图带（2~4 张照片时用）的外框 */
export const POSTER_STRIP = { top: 0.100, left: 0.068, width: 0.864, gap: 0.014 };

/**
 * 两套纵向版面。
 *
 * plain：无照片 / 单张照片铺满底图
 * strip：2 张以上，顶部让出一条拼图带，文字整体收在带子下方
 *
 * 每张表都必须**闭合在 0~1 之内**：早先用"给文字加一个固定偏移"的办法，
 * 结果价格块和页脚被顶出画布（实测截图才发现）。所以这里写死两套显式坐标。
 */
/**
 * 三套纵向版面。
 *
 * plain：无照片 / 单张照片铺满底图
 * strip：2 张以上，顶部让出一条拼图带，文字整体收在带子下方
 * noprice：同上但**没有价格块**，联系方式上移收口。
 *
 * 为什么需要 noprice：把价格块整块去掉后，plain/strip 那两套会在下半页留下
 * 一大片空白（实测渲染出来就是个空洞）。这里把分隔线与联系方式上移，
 * 版心收得更紧。每张表都必须**闭合在 0~1 之内**。
 */
/**
 * 同构图内的变体。
 *
 * 为什么需要这一层：只有构图的话，14 套 fullbleed 模板会渲染出**完全相同**的几何 ——
 * 用户验收标准是"任意两套模板的版面几何必须有实质差异"，
 * 同族共享一套几何不满足这个标准。
 *
 * 变体只动三件事，都是看得见的：
 *   shift   在**可用余量**里下移多少（0 = 贴顶，1 = 贴到底线）—— 改变留白节奏
 *   size    标题字号倍率（改变视觉层级：谁压得住画面）
 *   maxH    标题允许高度倍率（连带影响它最多占几行）
 *
 * shift 是**比例**而不是绝对距离 —— 这点很关键。
 * 我第一版写的是固定 dy（0 / 0.072 / 0.134），结果 15 种组合里有 11 种
 * 副标题压到了价格面板上：文字块往下走，面板却钉在原地。
 * 改成"在余量里按比例下移"之后，下移量由版面自己算出来，不可能越界。
 */
export const POSTER_VARIANTS = [
  { key: "a", label: "紧凑", shift: 0.00, size: 1.00, maxH: 1.00 },
  { key: "b", label: "下沉", shift: 0.55, size: 0.92, maxH: 0.94 },
  { key: "c", label: "强调", shift: 1.00, size: 1.08, maxH: 0.88 },
];

/**
 * 海报构图族。
 *
 * 为什么要有这一层：原先 POSTER_LAYOUT 里的 plain/strip/plainNoPrice/stripNoPrice
 * 四个变体**字段名完全相同**，只是 y 坐标微调 —— 也就是同一套骨架换数字。
 * 用户一眼就看穿了："排版都是同一套，就换个背景加文案"。
 *
 * 真实海报设计的构图是可以分类的（满版/中轴/分割/重心…），
 * 差别在于**对齐方式、图文关系、阅读路径**，而不是坐标偏移。
 * 所以这里把"构图"显式建模出来，让每个版面真的不一样：
 *
 *   align       文字的水平对齐基准（left / center）—— 决定阅读动线
 *   imgMode     图片与文字的关系：
 *                 full  图铺满，文字压在上面（满版型）
 *                 band  图只占上一条，文字在下方实色区（分割型）
 *                 none  不用图，纯排版（文字主导型）
 *   stack       版块的纵向顺序。'info-first' = 先给信息再给标题，
 *               阅读节奏和默认的"标题优先"完全不同。
 */
export const POSTER_COMPOSITIONS = {
  // ① 满版压暗：图铺满 + 遮罩，文字压在左下。现有那套。
  fullbleed: { align: "left", imgMode: "full", stack: "title-first", label: "满版压暗" },
  // ② 中轴对称：图铺满，但所有元素居中，标题压在垂直中轴线上。
  //    和①的差别不只是"居中"—— 阅读动线从"左对齐扫读"变成"沿中轴向下"。
  axial: { align: "center", imgMode: "full", stack: "title-first", label: "中轴对称" },
  // ③ 上下分割：图只占上方约一半，下方是实色信息区。
  //    图与字**不重叠**，所以不需要遮罩 —— 这是结构差异，不是参数差异。
  split: { align: "left", imgMode: "band", stack: "title-first", label: "上下分割" },
  // ⑤ 左右分割：图在**右侧出血**，文字在左侧实色栏。
  //    和③上下分割是正交的两种切法 —— ③是横切（上下），⑤是竖切（左右）。
  //    适合竖构图风景照：文字不压图，图也不被文字切碎。
  splitv: { align: "left", imgMode: "side", stack: "title-first", label: "左右分割" },
  // ④ 文字主导：完全不用图，超大标题占据中部。通知/公告类本来就该如此。
  typeled: { align: "center", imgMode: "none", stack: "title-first", label: "文字主导" },
  // ⑥ 重心环绕：图不再是背景、也不是色块，而是**悬在画面中间的一张圆角卡片**，
  //    文字在它上下两侧环绕。和前面五种的根差别是"图的身份"变了 ——
  //    从"承载文字的底"变成"被文字环绕的主体"。
  focal: { align: "center", imgMode: "card", stack: "card-mid", label: "重心环绕" },
  // ⑦ 网格信息：图在上，下面是一个 2×2 信息格（时间/价格/电话/地址各占一格）。
  //    和前面六种的根差别是**信息密度**：它们都是"一个标题 + 一段副标题"，
  //    这种把四个字段摊成表格 —— 适合活动预告、票务、招商这类要比对信息的物料。
  grid: { align: "left", imgMode: "band", stack: "cells", label: "网格信息" },
};

export const POSTER_LAYOUT = {
  // ── ① 满版压暗（左对齐，图铺满）—— 原有那套 ──────────────
  plain: {
    stripHeight: 0,
    eyebrow: 0.192, title: 0.234, titleRule: 0.463, subtitle: 0.508,
    panelTop: 0.688, panelH: 0.090, priceRow: 0.733, divider: 0.842,
    phone: 0.866, address: 0.906, footer: 0.946,
    titleMaxH: 0.20, subMaxH: 0.14, titleMaxSize: 104,
  },
  strip: {
    stripHeight: 0.215,
    eyebrow: 0.368, title: 0.406, titleRule: 0.570, subtitle: 0.610,
    panelTop: 0.735, panelH: 0.078, priceRow: 0.774, divider: 0.868,
    phone: 0.889, address: 0.923, footer: 0.966,
    titleMaxH: 0.155, subMaxH: 0.115, titleMaxSize: 78,
  },
  // 无价格：正文可以放开一点（省下的空间给标题/描述），尾部整体上移
  plainNoPrice: {
    stripHeight: 0,
    eyebrow: 0.206, title: 0.250, titleRule: 0.492, subtitle: 0.538,
    panelTop: 0.700, panelH: 0.090, priceRow: 0.745, divider: 0.800,
    phone: 0.828, address: 0.872, footer: 0.946,
    titleMaxH: 0.215, subMaxH: 0.20, titleMaxSize: 104,
  },
  stripNoPrice: {
    stripHeight: 0.215,
    eyebrow: 0.368, title: 0.406, titleRule: 0.570, subtitle: 0.610,
    panelTop: 0.720, panelH: 0.078, priceRow: 0.759, divider: 0.812,
    phone: 0.842, address: 0.884, footer: 0.966,
    titleMaxH: 0.155, subMaxH: 0.19, titleMaxSize: 78,
  },

  // ── ② 中轴对称 ────────────────────────────────────────────
  // 图仍然铺满，但全部元素居中对齐、沿垂直中轴向下推进。
  // 与①的实质差别是**阅读动线**：①是左对齐扫读，②是沿中轴下行。
  // 标题给得比①更大 —— 中轴对称天然适合放一个大标题压住画面。
  axial: {
    stripHeight: 0,
    composition: "axial",
    eyebrow: 0.168, title: 0.212, titleRule: 0.470, subtitle: 0.514,
    panelTop: 0.676, panelH: 0.092, priceRow: 0.722, divider: 0.836,
    phone: 0.860, address: 0.902, footer: 0.948,
    titleMaxH: 0.235, subMaxH: 0.135, titleMaxSize: 116,
  },

  // ── ③ 上下分割 ────────────────────────────────────────────
  // 图只占上方 44%，**文字完全在图之外**的实色区里 —— 所以不需要遮罩。
  // 这是结构性差异：① 是"字压在图上"，③ 是"图和字各占一块"。
  split: {
    stripHeight: 0,
    composition: "split",
    bandHeight: 0.44,               // 图片带的高度（新字段，只有这个构图用）
    eyebrow: 0.486, title: 0.520, titleRule: 0.668, subtitle: 0.700,
    panelTop: 0.800, panelH: 0.068, priceRow: 0.824, divider: 0.890,
    phone: 0.908, address: 0.936, footer: 0.968,
    titleMaxH: 0.130, subMaxH: 0.085, titleMaxSize: 86,
  },

  // ── ⑤ 左右分割 ────────────────────────────────────────────
  // 图在右侧（从 46% 处出血到右边缘），文字全部在左侧 40% 的窄栏里。
  // 窄栏意味着标题必须更小、行数更多 —— 这是**信息密度**的差异，
  // 不是把③旋转 90 度那么简单。
  splitv: {
    stripHeight: 0,
    composition: "splitv",
    imgRight: 0.46,                 // 图片左边缘（右侧出血到 1.0）
    textW: 0.38,                    // 文字栏宽度：0.074 起 + 0.38 = 0.454 < 0.46，不压图
    eyebrow: 0.118, title: 0.152, titleRule: 0.386, subtitle: 0.424,
    panelTop: 0.640, panelH: 0.088, priceRow: 0.684, divider: 0.790,
    phone: 0.816, address: 0.860, footer: 0.946,
    titleMaxH: 0.215, subMaxH: 0.190, titleMaxSize: 74,
  },

  // ── ⑥ 重心环绕 ────────────────────────────────────────────
  // 卡片占据画面中段（0.20~0.52），标题压在卡片下方 0.56 起 —— 视线路径是
  // "先看到图，再读到标题"，和①的"先读标题再看图"是相反的。
  focal: {
    stripHeight: 0,
    composition: "focal",
    cardTop: 0.170, cardH: 0.300, cardW: 0.620,
    eyebrow: 0.108, title: 0.508, titleRule: 0.682, subtitle: 0.714,
    panelTop: 0.800, panelH: 0.062, priceRow: 0.820, divider: 0.884,
    phone: 0.902, address: 0.930, footer: 0.968,
    titleMaxH: 0.140, subMaxH: 0.072, titleMaxSize: 92,
  },

  // ── ⑦ 网格信息 ────────────────────────────────────────────
  // 图带压到 34%（比 split 的 44% 还矮），把省下的空间给 2×2 信息格。
  // 标题不占大块（92 → 72），因为这一版的诉求是"信息清楚"不是"标题压场"。
  grid: {
    stripHeight: 0,
    composition: "grid",
    bandHeight: 0.34,
    eyebrow: 0.386, title: 0.418, titleRule: 0.536, subtitle: 0.566,
    cellsTop: 0.652, cellH: 0.108, cellGap: 0.016,
    divider: 0.900, phone: 0.924, address: 0.952, footer: 0.980,
    panelTop: 0.900, panelH: 0.0, priceRow: 0.900,
    titleMaxH: 0.112, subMaxH: 0.072, titleMaxSize: 72,
  },

  // ── ④ 文字主导 ────────────────────────────────────────────
  // 完全不用图。标题占画面高度的 30%（①只有 20%），居中，四周大量留白。
  // 通知、公告、招募这类本来就该这么做 —— 它们没有可用的图，硬配图反而假。
  typeled: {
    stripHeight: 0,
    composition: "typeled",
    eyebrow: 0.262, title: 0.312, titleRule: 0.666, subtitle: 0.706,
    panelTop: 0.836, panelH: 0.062, priceRow: 0.858, divider: 0.900,
    phone: 0.920, address: 0.948, footer: 0.976,
    titleMaxH: 0.300, subMaxH: 0.112, titleMaxSize: 124,   // subMaxH 原为 0.130：0.706+0.130=0.836 正好压到面板顶边，没有余量
  },
};

/**
 * 图片底图用的竖向渐变遮罩参数（交给渲染器逐行画，见 poster-forge/bg.py 的 apply_scrim）。
 *
 * 为什么不在这里用多个半透明矩形拼：那是近似渐变，在深色底上看不出来，
 * 换成浅色照片（清晨薄雾那种）就露出**一道一道的横条**，像渲染坏了。
 * 真正的逐行渐变只有渲染器做得到。
 */
export const POSTER_SCRIM = { top: 0.16, bottom: 0.80, start: 0.0, end: 1.0, color: "#000000" };

/** 调色板：按 tone（0 安静 → 1 热闹）选一套，模型给的 tone 决定用哪套 */
export const POSTER_TONES = {
  calm: { name: "安静", bgFrom: "#0b2a30", bgTo: "#1d5f66", accent: "#e8c37a" },
  warm: { name: "热闹", bgFrom: "#33110d", bgTo: "#7a2d17", accent: "#ffb347" },
  cool: { name: "清冷", bgFrom: "#101826", bgTo: "#26344a", accent: "#8fd6c2" },
  // 兼容名：文案手册等旧调用点还在用 TONES.auto / TONES.hotel 取色，
  // 少一个 key 就会 undefined.bgFrom 直接抛错（做这个重构时真的差点踩到）。
  auto: { name: "默认", bgFrom: "#0b2a30", bgTo: "#1d5f66", accent: "#e8c37a" },
  hotel: { name: "酒店", bgFrom: "#0b2a30", bgTo: "#1d5f66", accent: "#e8c37a" },
  restaurant: { name: "餐饮", bgFrom: "#33110d", bgTo: "#7a2d17", accent: "#ffb347" },
  bureau: { name: "政务", bgFrom: "#101826", bgTo: "#26344a", accent: "#8fd6c2" },
};

/** tone 数值 → 调色板 */
export function toneFor(tone) {
  if (typeof tone !== "number") return POSTER_TONES.calm;
  if (tone >= 0.66) return POSTER_TONES.warm;
  if (tone <= 0.33) return POSTER_TONES.cool;
  return POSTER_TONES.calm;
}

/* ------------------------------------------------------------------ 断行 */
//
// 断行规则**只有这一份**。本地构造和模型输出校验都调它，否则两条路的
// 换行规则会漂移（一边按字数切、一边按标点切，同一句话排出来两个样）。
//
// 每行 12 字这个数是怎么来的：标题字号 104pt、可用宽度 85%（≈918px），
// 中文字宽约等于字号，所以一行最多放 ~8.8 个宽字符。留出安全余量取 12 是**上限**，
// 实际 2 行标题建议总共 ≤14 字；超了渲染器会缩字号，但不该指望它兜底。
export const TITLE_LINE_MAX = 12;

/**
 * 把标题断成 1~2 行。
 *
 * 铁律：**绝不切在词中间**。
 * 踩过的坑：模型给「清晨西湖·水墨薄雾」，旧代码按 12 字等长硬切，
 * 结果第二行只剩一个"雾"字，看着像排版事故。
 * 所以只在**语义边界**断：换行符、间隔号、逗号、顿号，最后才看长度。
 */
export function splitTitleLines(raw, max = TITLE_LINE_MAX) {
  const text = String(raw || "").replace(/\r/g, "").trim();
  if (!text) return [];
  // 模型可能已经自己断好了行，尊重它
  const given = text.split("\n").map((s) => s.trim()).filter(Boolean);
  if (given.length >= 2) return given.slice(0, 2);

  if (text.length <= max) return [text];

  // 语义边界优先（间隔号 ·／・ 也算：标题里常写成"地点·卖点"）
  const parts = text.split(/[·・，,、；;：:]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const lines = [];
    let cur = "";
    for (const p of parts) {
      // 单段自己就超长：它独占一行（超出的交给渲染器缩字号，不切字）
      if (p.length >= max) {
        if (cur) { lines.push(cur); cur = ""; }
        lines.push(p);
        continue;
      }
      if (!cur) { cur = p; continue; }
      if ((cur + "·" + p).length <= max) cur = cur + "·" + p;
      else { lines.push(cur); cur = p; }
    }
    if (cur) lines.push(cur);
    if (lines.length >= 2) return lines.slice(0, 2);
    if (lines.length === 1) return [lines[0]];
  }

  // 没有语义边界可用：按"虚词后"找断点，仍然不切字
  const window = text.slice(0, max + 1);
  const m = window.match(/^.*[的地得和与及]/);
  if (m && m[0].length >= Math.floor(max * 0.5)) {
    return [text.slice(0, m[0].length), text.slice(m[0].length)].filter(Boolean);
  }
  // 实在没有断点：整句给第一行，由渲染器的 fit 缩字号兜底（宁可不切，也不切字）
  return [text];
}

function stripLayers(urls, height) {
  const n = Math.min(urls.length, 4);
  const { top: TOP, left: L, width: W, gap: G } = POSTER_STRIP;
  const out = [];
  for (let i = 0; i < n; i++) {
    const w = (W - G * (n - 1)) / n;
    out.push({
      type: "image", name: "photo" + (i || ""),
      src: String(urls[i]).replace(/^\//, ""),
      box: { box: [L + i * (w + G), TOP], size: [w, height] },
      fit: "cover", radius: 0.026,
      stroke: "#ffffff40", strokeWidth: 2,
    });
  }
  return out;
}

/** 打卡卡的照片网格（比例值，间隙 0.015 ≈ 60px @1080） */
export function checkinPhotoGrid(n) {
  const G = 0.015;
  if (n <= 1) {
    return { cells: [{ box: [0.068, 0.106], size: [0.864, 0.522] }], framed: true };
  }
  if (n === 2) {
    const w = (0.864 - G) / 2;
    return {
      cells: [
        { box: [0.068, 0.106], size: [w, 0.522] },
        { box: [0.068 + w + G, 0.106], size: [w, 0.522] },
      ],
      framed: false,
    };
  }
  if (n === 3) {
    const w = (0.864 - 2 * G) / 3;
    return {
      cells: [
        { box: [0.068, 0.106], size: [w, 0.522] },
        { box: [0.068 + (w + G), 0.106], size: [w, 0.522] },
        { box: [0.068 + 2 * (w + G), 0.106], size: [w, 0.522] },
      ],
      framed: false,
    };
  }
  const w = (0.864 - G) / 2;
  const h = (0.522 - G) / 2;
  return {
    cells: [
      { box: [0.068, 0.106], size: [w, h] },
      { box: [0.068 + w + G, 0.106], size: [w, h] },
      { box: [0.068, 0.106 + h + G], size: [w, h] },
      { box: [0.068 + w + G, 0.106 + h + G], size: [w, h] },
    ],
    framed: false,
  };
}

/**
 * 构造打卡卡 spec。
 *
 * @param content {caption, body, tags, topLabel}
 * @param opts.photoUrls  用户照片（0 张时退回占位素材）
 * @param opts.grid       single | two-col | three-col | quad（由模型选，或按照片数推断）
 * @param opts.mixed      照片主题不搭（模型判定）—— 会在卡上标明"混搭"，不假装是一个故事
 */
export function buildCheckinSpecFrom(content, opts = {}) {
  const urls = (opts.photoUrls || []).filter(Boolean).slice(0, 4);
  const n = urls.length;
  const gridName = opts.grid ||
    ({ 0: "single", 1: "single", 2: "two-col", 3: "three-col", 4: "quad" }[n]) || "single";
  const grid = checkinPhotoGrid(n);
  const srcs = n ? urls.map((u) => String(u).replace(/^\//, "")) : ["assets/sample-photo.png"];

  const palette = {
    bgFrom: "#101826", bgTo: "#26344a", ink: "#ffffff", inkSoft: "#e6edf7",
    inkMute: "#a7b6cb", accent: "#8fd6c2", accent2: "#ffd08a",
    gold: "#8fd6c2", price: "#ffd08a", panel: "#0a111c", divider: "#ffffff2e",
  };

  const layers = [
    { type: "text", name: "topLabel",
      text: content.topLabel || "现场打卡 · ○○（填你的店名）",
      x: 0.068, y: 0.046, font: "bold", size: 28, color: "accent" },
    { type: "text", name: "topDate",
      text: n ? `已载入 ${n} 张照片` : "未上传照片",
      x: 0.932, y: 0.046, align: "right", font: "sans", size: 22, color: "inkMute" },
  ];

  grid.cells.forEach((g, i) => {
    layers.push({
      type: "image", name: "photo" + (i || ""),
      src: srcs[i] || srcs[0],
      box: { box: g.box, size: g.size }, fit: "cover", radius: 0.04,
      ...(grid.framed ? {} : { stroke: "#ffffff40", strokeWidth: 2 }),
    });
  });

  if (grid.framed) {
    const first = grid.cells[0];
    const last = grid.cells[grid.cells.length - 1];
    layers.push({
      type: "shape", name: "photoFrame", shape: "rect",
      box: { box: first.box, size: [last.box[0] + last.size[0] - first.box[0], first.size[1]] },
      fill: null, stroke: "#ffffff44", strokeWidth: 2, radius: 38,
    });
  }

  const captionY = n >= 4 ? 0.700 : 0.672;
  layers.push(
    { type: "text", name: "caption",
      text: content.caption || "○○（填这次打卡的标题）",
      x: 0.068, y: captionY, font: "heavy", size: 56, lineHeight: 1.32, color: "ink",
      fit: { maxSize: 56, minSize: 30, maxWidth: 0.864, maxHeight: 0.14, maxLines: 3 },
      shadow: { color: "#00000088", dx: 0, dy: 3, blur: 10 } },
    { type: "text", name: "body",
      text: content.body || "在输入里写一句这次打卡的实情，文案就跟着变",
      x: 0.068, y: 0.836, font: "sans", size: 28, lineHeight: 1.55, color: "inkSoft",
      fit: { maxSize: 28, minSize: 18, maxWidth: 0.864, maxHeight: 0.10, maxLines: 3 } },
    { type: "shape", name: "tag1Bg", shape: "rect",
      box: { box: [0.068, 0.922], size: [0.22, 0.042] }, fill: "#ffffff22", radius: 24 },
    { type: "text", name: "tag1",
      text: opts.mixed ? "#混搭" : "#现场打卡", x: 0.178, y: 0.943,
      align: "center", valign: "center", font: "sans", size: 22, color: "accent" },
    { type: "text", name: "watermark", text: "PosterForge", x: 0.932, y: 0.943,
      align: "right", valign: "center", font: "sans", size: 18, color: "inkMute" }
  );

  return {
    meta: {
      id: "site-generate-checkin", audience: "tourist", client: "游客打卡",
      facts_source: n
        ? `用户上传 ${n} 张照片 + 对话自述`
        : "示例照片（未上传，使用占位素材）",
    },
    layout: "@layout:checkin-photo-card",
    canvas: { width: 1080, height: 1350 },
    theme: { palette },
    background: { type: "gradient", from: "bgFrom", to: "bgTo", angle: 160 },
    layers,
    grid: gridName,
  };
}

/**
 * 构造海报 spec。
 *
 * @param content  要印的字：{brand,title,sub,price,phone,address}
 * @param opts.photoUrls    用户照片的站点相对或绝对 URL（["/uploads/a.jpg", ...]）
 * @param opts.layout       "poster_text" | "poster_photo_bg" | "poster_photo_strip"
 *                          —— 由大模型选，或按照片数量推断
 * @param opts.tone         0~1，选调色板
 * @param opts.canvas       默认 1080x1440
 */
export function buildPosterSpecFrom(content, opts = {}) {
  const urls = (opts.photoUrls || []).filter(Boolean);
  const layout = opts.layout ||
    (urls.length >= 2 ? "poster_photo_strip" : urls.length === 1 ? "poster_photo_bg" : "poster_text");
  const many = layout === "poster_photo_strip" && urls.length >= 2;
  const useBg = layout === "poster_photo_bg" && urls.length >= 1;
  // 有价格用带价格块的表；没有价格就用尾部上移的那套，避免下半页留个空洞
  const hasPrice = !!(content.price && String(content.price).trim());
  // 版面选择：显式指定构图时优先用它，否则按图片数量回退到原有两套。
  // （原先只按「有没有拼图带 + 有没有价格」选，所以四种构图全落在同一套骨架上。）
  const wantComp = opts.composition && POSTER_LAYOUT[opts.composition] ? opts.composition : null;
  const L = wantComp
    ? POSTER_LAYOUT[wantComp]
    : many
    ? (hasPrice ? POSTER_LAYOUT.strip : POSTER_LAYOUT.stripNoPrice)
    : (hasPrice ? POSTER_LAYOUT.plain : POSTER_LAYOUT.plainNoPrice);
  // 构图决定对齐方式、图文关系和留白 —— 不是坐标微调。
  const comp = POSTER_COMPOSITIONS[L.composition || "fullbleed"];
  const centered = comp.align === "center";
  // 居中构图用 x=0.5 + align:center（渲染器支持），左右各留 8% 版心
  const X = centered ? 0.5 : 0.074;
  // 栏宽要跟着构图画。左右分割时文字栏只有 imgRight 那么宽（0.46），
  // 还用 0.85 的话字会压到右半边的图上去 —— 分割型的意义就没了。
  const W = L.textW ? L.textW : (centered ? 0.84 : 0.85);
  const al = centered ? { align: "center" } : {};

  // 变体：在同构图内再拉开差异（见 POSTER_VARIANTS 的注释）。
  //
  // 下移量是**算出来的**，不是写死的：先求文字块底部到价格面板之间还剩多少余量，
  // 再按 shift 比例下移。写死距离会越界 —— 第一版 15 种组合里 11 种压到了面板上。
  const V = POSTER_VARIANTS[Math.abs(Number(opts.variant) || 0) % POSTER_VARIANTS.length];
  // 逐套精调：模板可以带 tuning 覆盖变体的默认值。
  //   tuning.y  0~1，在可用余量里下移多少（0=贴顶，1=贴到底线）
  //   tuning.s  字号倍率（0.88~1.16 是安全区间，再大就会挤出画布）
  // 为什么要有这一层：只有"构图 × 变体"的话，同构图同变体的模板几何完全一样，
  // 达不到"任意两套模板都要有实质差异"。精调让每套模板能各自定位到不同档位。
  const T = opts.tuning && typeof opts.tuning === "object" ? opts.tuning : {};
  const vShift = Number.isFinite(T.y) ? Math.max(0, Math.min(1, T.y)) : V.shift;
  const vSize = V.size * (Number.isFinite(T.s) ? Math.max(0.88, Math.min(1.16, T.s)) : 1);
  const vH = V.maxH;
  // 尾部边界：有价格面板就贴着面板上沿，没有就贴着分隔线
  const tailTop = hasPrice ? L.panelTop : L.divider;
  const blockBottom = L.subtitle + L.subMaxH * vH;      // 文字块原本的底部
  const slack = Math.max(0, (tailTop - 0.028) - blockBottom);
  const dy = slack * vShift;

  const autoBg = opts.autoBgUrl ? String(opts.autoBgUrl).replace(/^\//, "") : null;
  const photo = urls.length ? String(urls[0]).replace(/^\//, "") : null;

  // 图片与文字的关系分三种，这是「构图」而不是「参数」：
  //   full  图铺满、文字压在图上 → 需要遮罩保证可读
  //   band  图只占上方一条、文字在图外的实色区 → **不需要遮罩**（图字不重叠）
  //   none  不用图 → 纯排版，靠留白和字号建立层级
  let bg, bandLayers = [];
  if (comp.imgMode === "band" && (photo || autoBg)) {
    const bh = L.bandHeight || 0.44;
    // 文字区底面：实色，保证图与字彻底分离
    bg = { type: "gradient", from: "bgFrom", to: "bgTo", angle: 130 };
    bandLayers = [
      { type: "image", name: "bandPhoto", src: photo || autoBg,
        box: { box: [0, 0], size: [1, bh] }, fit: "cover" },
      // 图带下缘压一道细金线，把两块明确切开（分割型的关键视觉线索）
      { type: "shape", name: "bandEdge", shape: "rect",
        box: { box: [0, bh - 0.004], size: [1, 0.004] }, fill: "gold", opacity: 0.9 },
    ];
  } else if (comp.imgMode === "side" && (photo || autoBg)) {
    // 左右分割：图在右侧出血，文字在左侧窄栏。图和字同样不重叠，不需要遮罩。
    const ix = L.imgRight || 0.46;
    bg = { type: "gradient", from: "bgFrom", to: "bgTo", angle: 130 };
    bandLayers = [
      { type: "image", name: "sidePhoto", src: photo || autoBg,
        box: { box: [ix, 0], size: [1 - ix, 1] }, fit: "cover" },
      // 图与文之间压一道竖金线 —— 分割型的视觉分隔
      { type: "shape", name: "sideEdge", shape: "rect",
        box: { box: [ix - 0.004, 0], size: [0.004, 1] }, fill: "gold", opacity: 0.9 },
    ];
  } else if (comp.imgMode === "card" && (photo || autoBg)) {
    // 重心环绕：图是一张悬空圆角卡片，不是背景也不是色块。
    // 卡片外压一道浅描边 + 投影，让它"浮"起来 —— 否则看着像贴歪了的色块。
    const cw = L.cardW || 0.64, ch = L.cardH || 0.32, ct = L.cardTop || 0.20;
    bg = { type: "gradient", from: "bgFrom", to: "bgTo", angle: 130 };
    bandLayers = [
      { type: "shape", name: "cardShadow", shape: "rect",
        box: [0.5 - cw / 2 + 0.012, ct + 0.014, 0.5 + cw / 2 + 0.012, ct + ch + 0.014],
        fill: "#000000", opacity: 0.34, radius: 26 },
      { type: "image", name: "cardPhoto", src: photo || autoBg,
        box: { box: [0.5 - cw / 2, ct], size: [cw, ch] }, fit: "cover", radius: 24 },
      // 不加描边：渲染器的圆角描边要求 shape 有非透明 fill，
      // 而这里只需要"框住"卡片 —— 透明 fill 会退化成**方角矩形**，
      // 和圆角图片对不上（实测就是图圆角、框方角）。
      // 投影已经足够让卡片浮起来，描边是多余的。
    ];
  } else if (comp.imgMode === "none") {
    bg = { type: "gradient", from: "bgFrom", to: "bgTo", angle: 130 };
  } else {
    // 满版：照片 > AI 底图 > 渐变，凡是用图都带逐行遮罩
    bg = useBg && photo
      ? { type: "image", image: photo, blobs: [], scrim: POSTER_SCRIM }
      : autoBg
      ? { type: "image", image: autoBg, blobs: [], scrim: POSTER_SCRIM }
      : { type: "gradient", from: "bgFrom", to: "bgTo", angle: 130 };
  }

  // 满版以外的构图不需要顶部图带拼图；拼图带只在原有 strip 模式里保留
  const stripL = comp.imgMode === "full" && many ? stripLayers(urls, L.stripHeight) : [];

  const layers = [
    ...bandLayers,
    ...stripL,
    { type: "text", name: "brand", text: content.brand || "○○（填你的店名）",
      x: centered ? 0.5 : 0.074, y: 0.054, ...(centered ? { align: "center" } : {}),
      font: "bold", size: 34, color: "gold",
      shadow: { color: "#00000066", dx: 0, dy: 2, blur: 6 } },
    { type: "text", name: "eyebrow", text: "PosterForge 生成 · 模板可替换",
      x: X, y: L.eyebrow + dy, ...al, font: "sans", size: 28, color: "inkSoft" },
    { type: "text", name: "title", text: content.title || "○○（填标题）", x: X, y: L.title + dy,
      ...al, font: "heavy", size: Math.round(L.titleMaxSize * vSize), lineHeight: 1.16, color: "ink",
      fit: { maxSize: Math.round(L.titleMaxSize * vSize), minSize: 44, maxWidth: W,
             maxHeight: L.titleMaxH * vH, maxLines: 2 },
      shadow: { color: "#00000099", dx: 0, dy: 4, blur: 14 } },
    // 分隔线：左对齐时是短横线（版心左侧），居中时也居中
    { type: "shape", name: "titleRule", shape: "rect",
      box: centered
        ? { box: [0.5 - 0.055, L.titleRule + dy], size: [0.11, 0.005] }
        : { box: [0.074, L.titleRule + dy], size: [0.11, 0.005] },
      fill: "gold", radius: 3 },
    { type: "text", name: "subtitle", text: content.sub || "副标题待补", x: X, y: L.subtitle + dy,
      ...al, font: "sans", size: 32, lineHeight: 1.55, color: "inkSoft",
      fit: { maxSize: 32, minSize: 22, maxWidth: W,
             maxHeight: L.subMaxH * vH, maxLines: 3 } },
  ];

  const t = toneFor(opts.tone);

  // 网格信息：把四个字段摊成 2×2 格子。
  // 这一版**不画单个价格面板** —— 信息密度就是它的构图特征，
  // 用格子的形式呈现，和"一个价格面板 + 一行联系方式"是两种信息组织方式。
  if (L.cellsTop) {
    const cw = (W - 0.014) / 2, ch = L.cellH;
    const cells = [
      { lb: "时间", v: String(content.sub || "").split("\n")[0] || "见正文" },
      { lb: "价格", v: content.price || "○○○ 元" },
      { lb: "电话", v: content.phone || "○○○-○○○○-○○○○" },
      { lb: "地址", v: content.address || "○○（填地址）" },
    ];
    cells.forEach((c, i) => {
      const cx = 0.074 + (i % 2) * (cw + 0.014);
      const cy = L.cellsTop + Math.floor(i / 2) * (ch + L.cellGap);
      layers.push(
        { type: "shape", name: "cell" + i, shape: "rect",
          box: [cx, cy, cx + cw, cy + ch], fill: "panel", radius: 12, opacity: 0.66 },
        { type: "shape", name: "cellBar" + i, shape: "rect",
          box: { box: [cx, cy], size: [0.007, ch] }, fill: "gold", radius: 3 },
        { type: "text", name: "cellLb" + i, text: c.lb, x: cx + 0.026, y: cy + 0.014,
          font: "sans", size: 20, color: "inkMute" },
        { type: "text", name: "cellVal" + i, text: c.v, x: cx + 0.026, y: cy + 0.040,
          font: "bold", size: 26, color: i === 1 ? "price" : "ink",
          fit: { maxSize: 26, minSize: 16, maxWidth: cw - 0.044, maxLines: 1 } });
    });
  }

  if (hasPrice && !L.cellsTop) {
    // 价格面板的右边界要跟着栏宽走。写死 0.926 的话，
    // 左右分割构图下面板会横跨到右侧图片上去（实测截图里就是这样）。
    const pR = centered ? 0.926 : Math.min(0.926, 0.074 + W + 0.012);
    // 窄栏（左右分割）里标签和价格并排会撞在一起 —— 实测"限○○○ 元起"叠成一团。
    // 栏窄时改成上下堆叠。
    const narrow = W < 0.5;
    layers.push(
      { type: "shape", name: "pricePanel", shape: "rect",
        box: [0.074, L.panelTop, pR, L.panelTop + L.panelH], fill: "panel", radius: 22, opacity: 0.72 },
      { type: "shape", name: "pricePanelEdge", shape: "rect",
        box: { box: [0.074, L.panelTop], size: [0.010, L.panelH] }, fill: "gold", radius: 6 });

    if (narrow) {
      layers.push(
        { type: "text", name: "priceNote", text: "限时特惠价", x: 0.100, y: L.panelTop + 0.014,
          font: "sans", size: 20, color: "inkMute" },
        { type: "text", name: "price", text: String(content.price), x: 0.100, y: L.panelTop + 0.046,
          font: "heavy", size: 44, color: "price",
          fit: { maxSize: 44, minSize: 26, maxWidth: W - 0.05, maxLines: 1 },
          shadow: { color: "#00000088", dx: 0, dy: 3, blur: 10 } });
    } else {
      layers.push(
        { type: "text", name: "priceNote", text: "限时特惠价", x: 0.112, y: L.priceRow,
          font: "sans", size: 26, color: "inkMute", valign: "center" },
        { type: "text", name: "price", text: String(content.price), x: pR - 0.024, y: L.priceRow,
          align: "right", font: "heavy", size: 74, color: "price", valign: "center",
          shadow: { color: "#00000088", dx: 0, dy: 3, blur: 10 } });
    }
  }

  layers.push(
    { type: "shape", name: "divider", shape: "rect",
      box: { box: [0.074, L.divider], size: [0.852, 0.0014] }, fill: "divider", radius: 2 },
    // 网格版把电话/地址放进格子里了，尾部再印一遍就是重复信息。
    // 尾行只留"预订"这一条行动号召，其余交给格子。
    { type: "text", name: "phone",
      text: L.cellsTop ? "" : (content.phone ? "预订 " + content.phone : ""),
      x: 0.074, y: L.phone, font: "bold", size: 30, color: "ink" },
    { type: "text", name: "address",
      text: L.cellsTop ? "" : (content.address || ""),
      x: 0.074, y: L.address, font: "sans", size: 22, color: "inkMute",
      fit: { maxSize: 22, minSize: 16, maxWidth: 0.62, maxLines: 2 } },
    { type: "text", name: "footerNote", text: "示意物料 · 替换真实文案后发布",
      x: 0.902, y: L.footer, align: "right", font: "sans", size: 15, color: "inkMute" }
  );

  // 联系方式一个字都没给时，尾部不能就留一片空白 —— 那样看着像做坏了。
  // 补一行提示，既填住版心也告诉用户"这里可以放电话"。
  if (!content.phone && !content.address) {
    layers.push({
      type: "text", name: "contactHint",
      text: "在输入里写「电话：…」或「地址：…」，就会印在这条线上",
      x: 0.074, y: L.phone, font: "sans", size: 22, color: "inkMute",
      fit: { maxSize: 22, minSize: 16, maxWidth: 0.78, maxLines: 2 },
    });
  }
  // 空文本层会被渲染器跳过，但留在 spec 里会让人误以为"有联系方式"。
  // 统一在最后一步剔掉，保证 spec 里只有真的要印的东西。
  const visible = layers.filter((el) => !(el.type === "text" && !String(el.text || "").trim()));

  return {
    meta: {
      id: "site-generate-poster",
      audience: opts.kind || "tourism",
      client: content.brand || "",
      facts_source: opts.factsSource || "站点表单输入（用户提供）",
    },
    layout: "@layout:poster-vertical-gold",
    canvas: opts.canvas || { width: 1080, height: 1440 },
    theme: {
      palette: {
        bgFrom: t.bgFrom, bgTo: t.bgTo, ink: "#ffffff", inkSoft: "#dcecec",
        inkMute: "#9fc4c6", gold: t.accent, amber: t.accent, accent: t.accent,
        price: "#ffdb8f", panel: "#08202a", divider: "#ffffff2e",
      },
    },
    background: bg,
    layers: visible,
  };
}
