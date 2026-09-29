/* =========================================================================
   poster-forge 站点前端
   要点：
     - 「生成什么」由大模型决定：POST /api/compose 让模型读图 + 写文案，
       再把模型给的内容交给渲染器出图（见 site/brain.mjs）
     - 模板与灵感数据从 API 取，不写死在页面里
     - 「生成」走真实链路：POST /api/generate -> Python 渲染器 -> 回真实 PNG
     - 图片上传走真实链路：POST /api/upload -> 落盘 -> 路径写进 spec
     - 「AI 背景」开关走真实链路：POST /api/aigen/background -> 本地 diffusers / SDXL-Turbo
     - 文案手册走真实链路：POST /api/copybook -> 多页 PDF
     - 生成前会先过 validate.py，所以广告法/结构错误会当场报出来
     - 模型不可用时自动退回本地确定性构造，页面不会因为模型没开就废掉
   ========================================================================= */

// 版面几何与服务端共用同一份模块，避免两条路渲出两种版式。
// ESM 的 import 必须写在模块顶层，所以放在这里而不是文件中间。
import { buildPosterSpecFrom, buildCheckinSpecFrom, POSTER_TONES, toneFor, splitTitleLines } from "./poster-layout.mjs";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/**
 * HTML 转义。**必须放在模块作用域** ——
 * 它原先只在 renderComposeNote 内部以 const 声明，是函数级作用域；
 * 套用模板的选择器也用到了它，于是抛 ReferenceError: esc is not defined。
 * 这类错误 node --check 查不出来（语法没问题），只有真的在浏览器里点一遍才暴露。
 */
const esc = (s) => String(s == null ? "" : s)
  .replace(/[<>&]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m]));

/** 风格片的字符串 id ↔ 服务端要的 0~1 调性数值 */
const TONE_VALUE = { cool: 0.25, calm: 0.5, warm: 0.75 };

const state = {
  templates: [],
  cases: [],
  feed: [],
  capabilities: [],
  mode: "poster",
  cap: "poster",
  tone: "auto",
  files: [],        // [{ name, url, bytes, mime, uploaded, uploading }]
  aiBgUrl: null,
  lastUploadErrors: null,
  generating: false,
  // 大模型上一次决定的内容（文案 + 版式 + 调性）。
  // 有它就出图时直接用；没有就走本地兜底。改输入或改照片时清空。
  composeSpec: null,
  composeCopy: null,
  composeScenes: null,
  brain: null,      // /api/brain 的状态
};

/* ---------------------------------------------------------------- 工具 */
function fmt(n) {
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, "") + "\u4e07";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const text = await r.text();
  try {
    return { status: r.status, data: JSON.parse(text) };
  } catch {
    return { status: r.status, data: { ok: false, message: text.slice(0, 500) } };
  }
}

/**
 * 带进度的请求：手册渲染要 15–25 秒（6 页 A4@300DPI），
 * 期间界面只有一个静态按钮，用户分不清"在跑"还是"卡死"。
 * 这里用 AbortController 加超时，并周期性回调已用时间，让按钮上的文字会动。
 */
async function apiWithProgress(path, { timeoutMs = 180000, onTick, intervalMs = 1000, ...opts } = {}) {
  const ctl = new AbortController();
  const t0 = Date.now();
  let timer = null;
  if (onTick) {
    onTick(0);
    timer = setInterval(() => onTick(Date.now() - t0), intervalMs);
  }
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, { ...opts, signal: ctl.signal });
    const text = await r.text();
    try {
      return { status: r.status, data: JSON.parse(text) };
    } catch {
      return { status: r.status, data: { ok: false, message: text.slice(0, 500) } };
    }
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(
        `请求超时（已等 ${Math.round((Date.now() - t0) / 1000)} 秒，上限 ${timeoutMs / 1000} 秒）。` +
        `手册渲染 6 页 A4 需要十几到二十几秒；若机器同时在跑其他重负载会显著变慢。`
      );
    }
    throw e;
  } finally {
    clearTimeout(to);
    if (timer) clearInterval(timer);
  }
}

function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(new Error("读取文件失败: " + file.name));
    fr.readAsDataURL(file);
  });
}

/* ---------------------------------------------------------------- 功能菜单 */
const ICONS = { poster: "🖼", template: "▤", checkin: "📍", copybook: "📖", batch: "▦", history: "🕘", analyze: "🔍" };

function renderCapMenu() {
  const box = $("#capMenu");
  box.innerHTML = "";
  state.capabilities.forEach((c) => {
    const b = el("button", null, `<span aria-hidden="true">${ICONS[c.icon] || "◆"}</span> ${c.name}`);
    b.setAttribute("aria-current", String(c.id === state.cap));
    b.onclick = () => selectCap(c.id);
    box.appendChild(b);
  });
}

/** 切换功能。抽成函数是因为「套用模板」选中后也要切回海报模式。 */
function selectCap(id) {
  state.cap = id;
  if (id === "checkin") setMode("checkin");
  else if (id === "poster") setMode("poster");
  // 换功能必须让上一次的模型结果作废。
  // 否则切到「打卡」后仍会拿海报那份 composeSpec 出图 ——
  // 表现就是"我要打卡却拿到带价格的海报"（矩阵测试抓到的真实 bug）。
  invalidateCompose();
  renderCapMenu();
  syncCapCard();
}

function syncCapCard() {
  const c = state.capabilities.find((x) => x.id === state.cap) || state.capabilities[0];
  if (!c) return;
  $("#capIcon").textContent = ICONS[c.icon] || "◆";
  $("#capName").textContent = c.name;
  $("#capDesc").textContent = c.desc;

  const btn = $("#genBtn");
  if (c.id === "copybook") btn.textContent = "生成文案手册（PDF）";
  else if (c.id === "checkin") btn.textContent = "生成打卡卡";
  else btn.textContent = "生成海报";

  // 手册是纯文案结构，不需要图片与背景开关，界面相应收起
  const isBook = c.id === "copybook";
  // 「套用模板」不是生成模式，而是一个挑选入口：把生成相关控件全收起换成选择器。
  // 选中后会自动切回海报模式，继续走正常出图链路。
  const isPicker = c.id === "template";
  // 「历史记录」同理：不是生成模式，是一个回看入口
  const isHistory = c.id === "history";
  const hideGen = isBook || isPicker || isHistory || c.id === "analyze";
  $("#drop").style.display = hideGen ? "none" : "";
  $("#styleChips").style.display = hideGen ? "none" : "";
  $("#uploadBtn").style.display = hideGen ? "none" : "";
  $("#toggles").style.display = hideGen ? "none" : "";
  // 输入框那一整块。
  //
  // **手册模式要保留输入框** —— 它的用法就是"写内容 → 生成 PDF"。
  // 踩过的坑：我为了修"分析面板下露出多余控件"，用 hideGen 一刀切把它藏了，
  // 而 hideGen 里含 isBook —— 结果文案手册整个面板空了，用户反馈"用不了了"。
  // 一刀切的隐藏条件，总会误伤某个模式：这里把"要输入"和"要出图"分开判断。
  const needPrompt = !(isPicker || isHistory || c.id === "analyze");
  const pw = $("#promptWrap"); if (pw) pw.style.display = needPrompt ? "" : "none";
  const pt = $("#promptTips"); if (pt) pt.style.display = needPrompt ? "" : "none";
  const ph = $("#promptHint"); if (ph) ph.style.display = needPrompt ? "" : "none";
  const picker = $("#tplPicker");
  if (picker) {
    picker.hidden = !isPicker;
    if (isPicker) renderTplPicker();
  }
  const his = $("#hisPanel");
  if (his) {
    his.hidden = !isHistory;
    if (isHistory) renderHistory();
  }
  // 版式片 + 参考图分析。
  // 版式片只在**海报类**模式有意义（手册是多页 PDF，没有"构图"这个概念）。
  // 但**参考图分析在手册里也有用** —— 用户传张参考图，至少能定调性，
  // 而且手册的图片页也能用上。所以两者分开判断，不再一刀切。
  const isGenMode = !(isPicker || isHistory || c.id === "analyze");
  const cc = $("#compChips"); if (cc) cc.style.display = isGenMode && !isBook ? "" : "none";
  const ai = $("#anaInline"); if (ai) ai.style.display = isGenMode ? "" : "none";
  const ar = $("#anaResult"); if (ar && !isGenMode) ar.hidden = true;
  const kw = $("#kwChips"); if (kw) kw.style.display = isGenMode ? "" : "none";
  // 生成按钮：**手册模式要留着** —— 它用的就是这个按钮（点了出 PDF）。
  // 踩过的坑：hideGen 一刀切把它连手册一起藏了，面板上没有任何按钮可点，
  // 用户反馈"文案手册用不了了"。
  // 只有"不是生成模式的"那几个入口（挑模板、看历史、图片分析）才该藏。
  btn.style.display = (isPicker || isHistory || c.id === "analyze") ? "none" : "";
}

/* ---------------------------------------------------------------- 图片分析 */

/** 七种构图的键名与中文名（与服务端 poster-layout.mjs 的键一一对应）*/
const COMPOSITIONS = [
  ["fullbleed", "满版压暗", "图铺满，文字压图上 —— 风景、氛围强的照片"],
  ["axial", "中轴对称", "全部居中，沿中轴排列 —— 仪式感、正式场合"],
  ["split", "上下分割", "图在上，文字在下方实色区 —— 要写清价格/时间"],
  ["splitv", "左右分割", "图在右侧，文字挤左窄栏 —— 竖构图的单品特写"],
  ["focal", "重心环绕", "图是居中悬浮卡片，文字环绕 —— 主体明确"],
  ["grid", "网格信息", "图 + 四格信息（时间/价格/电话/地址）—— 票务、赛事"],
  ["typeled", "文字主导", "不用图，居中大标题 —— 通知、公告"],
];

/** 分析一张参考图，得出建议版式；顺手把它设成当前构图 */
async function analyzePhoto(file) {
  const box = $("#anaResult");
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `<div class="ana-loading">正在上传并分析…这一步要读图，约 10~30 秒</div>`;
  try {
    // 复用普通上传接口落盘 —— 但**不进 state.files**，所以不会成为海报底图
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(new Error("读取文件失败"));
      fr.readAsDataURL(file);
    });
    const up = await api("/api/upload", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ name: file.name, data: dataUrl }] }),
    });
    const sf = (up.data.files || [])[0];
    if (!sf || !sf.url) throw new Error("上传失败：" + (up.data.message || "没有返回文件"));

    const r = await api("/api/analyze-layout", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ photo: sf.url }),
    });
    if (!r.data.ok) throw new Error(r.data.message || "分析失败");

    const key = r.data.composition;
    const hit = COMPOSITIONS.find((c) => c[0] === key);
    // 手册模式没有"构图"这个概念（它是多页 PDF），但**调性有用** ——
    // 调性决定手册的配色。所以这里分两种落地方式，而不是生搬构图。
    const inBook = state.cap === "copybook";
    if (!inBook) {
      state.composition = key;      // 海报类：分析结果直接落到当前构图上
      renderCompChips();
    }
    if (r.data.tone && TONES[r.data.tone]) {
      state.tone = r.data.tone;
      // 风格片的选中态要跟着走 —— 只改 state 的话按钮上还是旧的选中项，
      // 用户看不出"分析帮我选了调性"
      $$("#styleChips .chip").forEach((x) => {
        x.setAttribute("aria-pressed",
          (x.dataset.kv || "").split(":")[1] === state.tone ? "true" : "false");
      });
    }
    box.innerHTML = `
      <div class="ana-head">
        <span class="ana-tag">${inBook ? "建议调性" : "建议版式"}</span>
        <b>${esc(inBook ? (r.data.tone || "—") : (hit ? hit[1] : key))}</b>
        <code>${esc(key)}</code>
      </div>
      ${r.data.reason ? `<div class="ana-why">${esc(r.data.reason)}</div>` : ""}
      ${inBook
        ? `<div class="ana-dim" style="margin-top:6px">手册没有"构图"，已按这张图的调性帮你选好配色（${esc(r.data.tone || "—")}）。回上面点生成即可。</div>`
        : `<div class="ana-dim">调性建议：${esc(r.data.tone || "—")}</div>`}
      <div class="ana-dim" style="margin-top:6px">已经帮你选好版式了，回「海报生成」直接点生成即可。</div>`;
  } catch (e) {
    box.innerHTML = `<div class="ana-loading err">分析失败：${esc(e.message || "")}</div>`;
  }
}

// 参考图分析：生成区里的一个按钮 —— **与普通上传分开走**
// （普通上传的照片会成为海报素材，参考图只是用来判断版式的，不该混进去）
$("#anaBtn")?.addEventListener("click", () => {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.onchange = () => { if (inp.files && inp.files[0]) analyzePhoto(inp.files[0]); };
  inp.click();
});

/** 版式关键词片：让用户直接选构图，而不是让模型每次随机挑 */
function renderCompChips() {
  const box = $("#compChips");
  if (!box) return;
  const cur = state.composition || "";
  box.innerHTML =
    `<span class="chip-label">版式</span>` +
    `<button class="chip" data-comp="" aria-pressed="${cur === ""}">自动</button>` +
    COMPOSITIONS.map(([k, name, tip]) =>
      `<button class="chip" data-comp="${k}" aria-pressed="${cur === k}" title="${esc(tip)}">${esc(name)}</button>`
    ).join("");
}

$("#compChips")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-comp]");
  if (!b) return;
  state.composition = b.dataset.comp || "";
  // 手动选了版式就不再跟模板走 —— 否则用户会疑惑"我选了为什么没生效"
  if (state.composition) window.__pickedTemplate = null;
  renderCompChips();
});

/* ---------------------------------------------------------------- 历史记录 */

/** 回看生成过的图。只读记录，不碰图片文件本身。 */
async function renderHistory() {
  const box = $("#hisList");
  const cnt = $("#hisCount");
  if (!box) return;
  box.innerHTML = `<div class="tpl-empty">读取中…</div>`;
  let j;
  try {
    j = (await api("/api/history")).data;
  } catch (e) {
    box.innerHTML = `<div class="tpl-empty">读不到历史记录：${esc(e.message || "")}</div>`;
    return;
  }
  const items = j.items || [];
  if (cnt) cnt.textContent = `共 ${j.total} 条`;
  if (!items.length) {
    box.innerHTML = `<div class="tpl-empty">还没有记录。生成一张海报后，这里会留下痕迹。</div>`;
    return;
  }
  box.innerHTML = items.map((h) => {
    const d = new Date(h.at);
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `
    <div class="his-item">
      <img src="${esc(h.url)}" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'" />
      <span class="his-meta">
        <b>${esc(h.title || "(无标题)")}</b>
        <em>${esc(when)} · ${h.mode === "checkin" ? "打卡卡" : "海报"}${h.photos ? " · " + h.photos + " 图" : ""}${h.hasPrice ? " · 有价格" : ""}</em>
        <i>${esc(String(h.brief || "").split("\n")[0].slice(0, 30))}</i>
      </span>
      <a class="his-dl" href="${esc(h.url)}" download title="下载">↓</a>
      <button class="his-del" data-del="${esc(h.id)}" title="删除这条记录">×</button>
    </div>`;
  }).join("");
}

$("#hisList")?.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-del]");
  if (!b) return;
  try {
    await api("/api/history/" + encodeURIComponent(b.dataset.del), { method: "DELETE" });
    renderHistory();
  } catch (err) { console.warn("[history] 删除失败:", err.message); }
});

$("#hisClear")?.addEventListener("click", async () => {
  try {
    await api("/api/history", { method: "DELETE" });
    renderHistory();
  } catch (err) { console.warn("[history] 清空失败:", err.message); }
});

/* ---------------------------------------------------------------- 套用模板 */
//
// 独立入口。原先模板只能在大图预览弹层里套用：用户得先滚到「热门模板」区块、
// 点开预览、再点套用 —— 三步，主页上没有任何直接入口。
//
// 这里是一个轻量选择器：搜索框 + 受众筛选 + 紧凑列表。
// 选中后把该模板的 brief 填进输入框、切回海报模式，用户改完即可出图 ——
// 这才是"套用"的实际价值：不用从零写文案。
let tplFilter = "all";
let tplQuery = "";

/* ---------------------------------------------------------------- 选版式 */

/** 七种构图的列表渲染。点一个就把它设成当前版式。 */
function renderCompositionPicker(box) {
  const cur = state.composition || "";
  const fbox = $("#tplFilters"); if (fbox) fbox.innerHTML = "";
  const rotBox = $("#tplRotate"); if (rotBox) rotBox.innerHTML = "";
  const cnt = $("#tplCount"); if (cnt) cnt.textContent = `${state.compositions.length} 种版式`;
  const cnt2 = $("#tplCountInline"); if (cnt2) cnt2.textContent = `${state.compositions.length} 种`;

  const q = tplQuery.trim().toLowerCase();
  const list = state.compositions.filter((c) =>
    !q || (c.label + " " + c.hint + " " + c.key).toLowerCase().includes(q));

  box.innerHTML = list.map((c) => `
    <div class="tpl-item comp-item${cur === c.key ? " on" : ""}" data-comp="${esc(c.key)}">
      ${c.thumb ? `<img src="/${esc(c.thumb)}" alt="" loading="lazy" decoding="async" />`
                : `<span class="ci-blank"></span>`}
      <span class="ci-body">
        <b>${esc(c.label)}</b>
        <em>${esc(c.key)} · ${c.count} 套样例</em>
        <i>${esc(c.hint)}</i>
      </span>
      ${cur === c.key ? `<span class="ci-on">当前</span>` : ""}
    </div>`).join("");

  // 选版式 = 设定构图，同时清掉之前套的模板（否则它会盖回来）
  box.querySelectorAll(".comp-item").forEach((el) => {
    el.onclick = () => {
      state.composition = el.dataset.comp;
      window.__pickedTemplate = null;
      renderCompChips();
      renderTplPicker();
      const hint = $("#tplHint");
      const hit = state.compositions.find((c) => c.key === el.dataset.comp);
      if (hint && hit) {
        hint.textContent = `已选「${hit.label}」——回「海报生成」写下内容点生成即可。文案由你自己填，不用套别人的。`;
      }
    };
  });
}

function renderTplPicker() {
  const box = $("#tplList");
  if (!box) return;

  // 「套用模板」现在是**选版式**，不是选别人家的文案模板。
  //
  // 为什么改：原来 41 套各带一份文案（"烧烤摊夜宵档""火锅店冬季暖场"…），
  // 用户真正要复用的是**版面结构**，不是那些文案 —— 而且 41 套看下来会觉得
  // "都差不多"，因为它们本来就在同一个题材维度里重复。
  // 现在只列七种构图，选完结构，文案自己填。
  if (state.compositions && state.compositions.length) {
    renderCompositionPicker(box);
    return;
  }

  const all = state.templates || [];

  const fbox = $("#tplFilters");
  if (fbox) {
    const audiences = [["all", "全部"], ["hotel", "酒店民宿"],
                       ["restaurant", "餐饮"], ["bureau", "文旅景区"]];
    fbox.innerHTML = audiences.map(([id, name]) =>
      `<button class="mini-chip" data-aud="${id}" aria-pressed="${tplFilter === id}">${esc(name)}</button>`
    ).join("");
  }

  const q = tplQuery.trim().toLowerCase();
  const list = all.filter((t) => {
    if (tplFilter !== "all" && t.audience !== tplFilter) return false;
    if (!q) return true;
    return (t.title + " " + (t.tags || []).join(" ") + " " + (t.brief || ""))
      .toLowerCase().includes(q);
  });

  const cnt = $("#tplCount");
  // 数量提示移到工具栏里（输入框旁边原来那个 span 换成了"存为我的模板"按钮）
  if (cnt) cnt.textContent = `${list.length} / ${all.length} 套`;
  const cnt2 = $("#tplCountInline");
  if (cnt2) cnt2.textContent = `${list.length}/${all.length}`;
  // 今日轮换说明：模板顺序每天按联网抓到的图提取的配色倾向调整。
  // 必须说清"图有版权、只用了颜色" —— 否则用户会以为站点在分发别人的图。
  const rot = state.rotation;
  const rotBox = $("#tplRotate");
  if (rotBox) {
    if (rot && rot.paletteCount) {
      const biasCN = rot.bias === "warm" ? "偏暖" : rot.bias === "cool" ? "偏冷" : "中性";
      const swatches = (rot.palettes || []).slice(0, 4)
        .map((p) => `<i style="background:linear-gradient(135deg,${esc(p.from)},${esc(p.to)})"
                        title="${esc(p.from)} → ${esc(p.to)}"></i>`).join("");
      rotBox.innerHTML =
        `<span class="rot-sw">${swatches}</span>` +
        `<span class="rot-txt">今日看点 <b>${biasCN}</b>（暖度 ${rot.avgWarmth}）· ` +
        `${rot.paletteCount} 组配色取自「${esc(rot.source)}」，` +
        `模板顺序已据此调整。只取颜色倾向，图片本身不进成品。</span>`;
      rotBox.hidden = false;
    } else {
      rotBox.hidden = true;
    }
  }

  if (!list.length) {
    box.innerHTML = `<p class="tpl-empty">没有匹配的模板。换个词试试，或点「全部」。</p>`;
    return;
  }
  box.innerHTML = list.map((t) => `
    <div class="tpl-item${t.source === "user" ? " is-mine" : ""}" data-id="${esc(t.id)}" role="button" tabindex="0">
      <img src="${esc(t.thumbSmall || t.thumb || "")}" alt="" loading="lazy" decoding="async"
           onerror="this.style.visibility='hidden'" />
      <span class="tpl-meta">
        <b>${esc(t.title)}${t.source === "user" ? ' <i class="mine-tag">我的</i>' : ""}</b>
        <em>${esc((t.tags || []).join(" · ")) || "—"}</em>
        <i>${esc((t.brief || "").split("\n")[0].slice(0, 34))}</i>
      </span>
      ${t.source === "user"
        ? `<button class="tpl-del" data-del="${esc(t.id)}" title="删除这套模板" aria-label="删除">×</button>`
        : ""}
    </div>`).join("");
}

/** 把输入框里的内容存成用户自己的模板 */
async function saveCurrentAsTemplate() {
  const box = $("#promptInput");
  const brief = (box?.value || "").trim();
  const msg = $("#tplSaveMsg");
  const show = (text, ok) => {
    if (!msg) return;
    msg.textContent = text;
    msg.className = "tpl-save-msg" + (ok ? " ok" : " err");
    msg.hidden = false;
    if (ok) setTimeout(() => { msg.hidden = true; }, 4000);
  };
  if (brief.length < 4) {
    show("输入框里还没有内容 —— 先写点文案，或者套用一套模板改改再存。", false);
    return;
  }
  const name = ($("#tplSaveName")?.value || "").trim();
  try {
    const { data } = await api("/api/templates/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: name,
        brief,
        tone: TONE_VALUE[state.tone] ?? 0.5,
        audience: "restaurant",
        tags: ["我的模板"],
      }),
    });
    if (!data.ok) { show("保存失败：" + (data.message || "未知原因"), false); return; }
    state.templates = [ ...(state.templates || []), data.template ];
    $("#tplSave").hidden = true;
    if ($("#tplSaveName")) $("#tplSaveName").value = "";
    show("已存为「" + data.template.title + "」。下次在列表里点它就能一键套用。", true);
    renderTplPicker();
  } catch (e) {
    // 服务端会做广告法预检，被拦下时要把是哪个词说清楚
    show(e.message || "保存失败", false);
  }
}

/** 删除自己存的模板 */
async function deleteUserTemplate(id) {
  try {
    await api("/api/templates/user/" + encodeURIComponent(id), { method: "DELETE" });
    state.templates = (state.templates || []).filter((t) => t.id !== id);
    renderTplPicker();
  } catch (e) {
    const msg = $("#tplSaveMsg");
    if (msg) { msg.textContent = "删除失败：" + (e.message || ""); msg.className = "tpl-save-msg err"; msg.hidden = false; }
  }
}

/** 把一套模板套进输入框并切回海报模式 */
function applyTemplateById(id) {
  const t = (state.templates || []).find((x) => x.id === id);
  if (!t) return;
  window.__pickedTemplate = t;

  // 把示例内容填进输入框
  const box = $("#promptInput");
  if (box && t.brief) {
    box.value = t.brief;
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }
  // 按模板的调性选风格片
  if (typeof t.tone === "number") {
    state.tone = t.tone >= 0.66 ? "warm" : t.tone <= 0.33 ? "cool" : "calm";
    $$("#styleChips .chip").forEach((x) => {
      const isMatch = (x.dataset.kv || "").split(":")[1] === state.tone;
      x.setAttribute("aria-pressed", isMatch ? "true" : "false");
    });
  }
  // 记一次采纳：服务端累加，用于模板检索排序。失败不影响主流程。
  api("/api/templates/pick", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: t.id }),
  }).catch(() => {});

  // 切回海报生成
  selectCap("poster");
  invalidateCompose();
  const card = $(".cap-card");
  if (card) {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.style.transition = "box-shadow .3s";
    card.style.boxShadow = "0 0 0 2px rgba(232,160,94,.7), 0 24px 60px rgba(0,0,0,.55)";
    setTimeout(() => { card.style.boxShadow = ""; }, 1200);
  }
}

/* ------------------------------------------------- 套用模板：选择器事件 */
//
// 三个交互都在这里绑：搜索、受众筛选、点击套用。
// 事件委托到容器上，因为列表是每次筛选后重建的。
$("#tplSearch")?.addEventListener("input", (e) => {
  tplQuery = e.target.value || "";
  renderTplPicker();
});
$("#tplFilters")?.addEventListener("click", (e) => {
  const b = e.target.closest(".mini-chip");
  if (!b) return;
  tplFilter = b.dataset.aud || "all";
  renderTplPicker();
});
$("#tplList")?.addEventListener("click", (e) => {
  // 删除按钮优先：它在条目内部，不拦就会被套用逻辑吃掉
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    deleteUserTemplate(del.dataset.del);
    return;
  }
  const item = e.target.closest(".tpl-item");
  if (!item) return;
  applyTemplateById(item.dataset.id);
});
$("#tplSaveBtn")?.addEventListener("click", () => {
  const row = $("#tplSave");
  const msg = $("#tplSaveMsg");
  if (msg) msg.hidden = true;
  if (row) {
    row.hidden = !row.hidden;
    if (!row.hidden) {
      // 预填名称：用输入框第一行，用户可以直接改或留空
      const first = (($("#promptInput")?.value || "").trim().split("\n")[0] || "").slice(0, 14);
      const nameEl = $("#tplSaveName");
      if (nameEl && !nameEl.value) nameEl.value = first;
      nameEl?.focus();
    }
  }
});
$("#tplSaveOk")?.addEventListener("click", saveCurrentAsTemplate);
$("#tplSaveCancel")?.addEventListener("click", () => {
  const row = $("#tplSave");
  if (row) row.hidden = true;
  const msg = $("#tplSaveMsg");
  if (msg) msg.hidden = true;
});

/* ---------------------------------------------------------------- 模式 */// 顶部胶囊标签已按需求移除，模式改由左侧功能菜单驱动：
//   海报生成 → poster ／ 打卡模板 → checkin
// setMode 保留为唯一的模式入口，便于以后再加别的入口时不必改多处。
function setMode(mode) {
  state.mode = mode;
}

/* ---------------------------------------------------------------- 风格片 */
$("#styleChips").addEventListener("click", (e) => {
  const b = e.target.closest(".chip");
  if (!b) return;
  $$("#styleChips .chip").forEach((x) => x.setAttribute("aria-pressed", "false"));
  b.setAttribute("aria-pressed", "true");
  state.tone = b.dataset.kv.split(":")[1];
});

/* ---------------------------------------------------------------- 模板网格 */
function tplHTML(t) {
  const initial = (t.title || "T")[0];
  return `
    <div class="thumb">
      <img src="/thumbs/s/${t.id}.jpg" alt="${t.title}" loading="lazy" decoding="async"
           onerror="this.style.display='none';this.parentNode.style.background='linear-gradient(150deg,#2a1710,#3d2118)'" />
      <button class="fav" title="收藏" aria-label="收藏">♡</button>
      <span class="badge">${(t.tags || [])[0] || "模板"}</span>
    </div>
    <div class="body">
      <span class="av">${initial}</span>
      <span class="t">${t.title}</span>
      <span class="n" title="点赞">♥ ${fmt(t.likes)}</span>
      <span class="n" title="评论">💬 ${t.comments ?? 0}</span>
    </div>`;
}

async function loadTemplates() {
  const { data } = await api("/api/templates");
  state.templates = data.templates || [];
  // 构图清单：选版式用的，也是模板库现在的主入口
  api("/api/compositions").then((r) => {
    state.compositions = r.data.compositions || [];
    if (!$("#tplPicker")?.hidden) renderTplPicker();
  }).catch(() => { state.compositions = []; });
  // 联网轮换结果（当天的配色倾向）——用来给用户一个"为什么今天这么排"的交代
  state.rotation = data.rotation || null;
  // 「热门模板」整块已从主页移除（和「套用模板」选择器重复，且每次开页面都要拉 41 张图）。
  // 这里保留判断：容器不在就只把数据装进 state，不再渲染网格。
  const grid = $("#tplGrid");
  if (!grid) return;
  grid.innerHTML = "";
  state.templates.forEach((t) => {
    const c = el("div", "card", tplHTML(t));
    c.querySelector(".fav").onclick = (ev) => {
      ev.stopPropagation();
      const f = ev.currentTarget;
      const on = f.classList.toggle("on");
      f.textContent = on ? "♥" : "♡";
    };
    c.onclick = () => openPreview("template", state.templates, state.templates.indexOf(t));
    grid.appendChild(c);
  });
}

function pickTemplate(t) {
  window.__pickedTemplate = t;
  const c = currentContent();
  $("#genBtn").textContent = "生成海报";
  // 滚动到生成区并给一个短暂高亮，让用户明确"模板已套用"
  const card = $(".cap-card");
  if (card) {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.style.transition = "box-shadow .3s";
    card.style.boxShadow = "0 0 0 2px rgba(232,160,94,.7), 0 24px 60px rgba(0,0,0,.55)";
    setTimeout(() => { card.style.boxShadow = ""; }, 1100);
  }
  return c;
}

/* ---------------------------------------------------------------- 预览弹层 */
//
// 原来点卡片只滚动，看不出东西，用户反映"无法点击预览"。
// 现在模板与案例共用一个弹层：大图 + 信息 + 操作 + 左右切换 + Esc 关闭。
const preview = { list: [], index: 0, kind: "template" };

function openPreview(kind, list, index) {
  preview.kind = kind;
  preview.list = list;
  preview.index = Math.max(0, Math.min(index, list.length - 1));
  $("#previewModal").hidden = false;
  document.body.style.overflow = "hidden";
  renderPreview();
}

function closePreview() {
  $("#previewModal").hidden = true;
  document.body.style.overflow = "";
  const img = $("#pvImg");
  if (img) img.removeAttribute("src");
}

function stepPreview(delta) {
  if (!preview.list.length) return;
  const n = preview.list.length;
  preview.index = (preview.index + delta + n) % n;
  renderPreview();
}

function renderPreview() {
  const item = preview.list[preview.index];
  if (!item) return;
  const isFeed = preview.kind === "feed";

  const img = $("#pvImg");
  // 灵感图用远程图，模板用本地缩略图
  img.src = isFeed
    ? item.full || item.thumb
    : `/thumbs/${item.id}.jpg?t=${Date.now()}`;
  img.alt = item.title || "预览";

  $("#pvKind").textContent = isFeed
    ? (item.kind === "asset" ? "可商用素材" : "灵感参考")
    : "模板";
  $("#pvTitle").textContent = item.title || "—";

  const rows = [];
  if (isFeed) {
    rows.push(`<div>来源　　　<b>${item.sourceName || item.source || "—"}</b></div>`);
    if (item.credit) rows.push(`<div>署名　　　<b>© ${item.credit}</b></div>`);
    if (item.date) rows.push(`<div>日期　　　<b>${item.date}</b></div>`);
    if (item.licenseNote) rows.push(`<div style="margin-top:6px;color:#e9c9a8">${item.licenseNote}</div>`);
  } else {
    rows.push(`<div>服务对象　<b>${AUDIENCE[item.audience] || item.audience || "—"}</b></div>`);
    rows.push(`<div>尺寸　　　<b>${item.size || "1080 × 1440"}</b></div>`);
    rows.push(`<div>点赞　　　<b>♥ ${fmt(item.likes || 0)}</b>　评论 <b>💬 ${item.comments || 0}</b></div>`);
  }
  $("#pvMeta").innerHTML = rows.join("");

  $("#pvTags").innerHTML = (item.tags || []).map((t) => `<span>${t}</span>`).join("");

  if (isFeed) {
    $("#pvActions").innerHTML =
      `<a class="cta" style="text-align:center;text-decoration:none;display:block"
          href="${item.full || item.thumb}" target="_blank" rel="noopener">查看原图</a>
       <button class="ghost" id="pvBack">返回生成区</button>`;
    $("#pvBack").onclick = () => {
      closePreview();
      $(".cap-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    $("#pvHint").textContent =
      "这张图来自公开图源，仅作版式与配色参考；直接用于商业交付前请自行确认授权。";
  } else {
    $("#pvActions").innerHTML =
      `<button class="cta" id="pvApply">套用此模板</button>
       <a class="ghost" style="text-align:center;text-decoration:none;display:block"
          href="/thumbs/${item.id}.jpg" download>下载模板图</a>`;
    $("#pvApply").onclick = () => {
      pickTemplate(item);
      closePreview();
    };
    $("#pvHint").textContent = "套用后会切到生成区，可直接改字改图再生成。";
  }

  const many = preview.list.length > 1;
  $("#pvPrev").style.display = many ? "" : "none";
  $("#pvNext").style.display = many ? "" : "none";
}

// 事件绑定（弹层元素在 index.html 里）
$("#pvClose").onclick = closePreview;
$("#pvPrev").onclick = () => stepPreview(-1);
$("#pvNext").onclick = () => stepPreview(1);
$("#previewModal").addEventListener("click", (e) => {
  if (e.target.dataset.close === "1") closePreview();
});
window.addEventListener("keydown", (e) => {
  if ($("#previewModal").hidden) return;
  if (e.key === "Escape") closePreview();
  else if (e.key === "ArrowLeft") stepPreview(-1);
  else if (e.key === "ArrowRight") stepPreview(1);
});

/* ---------------------------------------------------------------- 每日灵感（联网） */
//
// 数据来自 /api/feed：Bing 每日壁纸（无需 key，每天更新）+ Picsum。
// 这些图**有版权**，所以每张都强制显示署名，并在底部统一说明"仅作灵感参考"。
// 需要可商用素材时，在 site/feed.config.json 里配 Pexels / Unsplash 的 key。
async function loadFeed({ force = false } = {}) {
  const grid = $("#feedGrid");
  const note = $("#feedNote");
  const btn = $("#feedRefresh");

  if (force) {
    btn.disabled = true;
    btn.textContent = "…";
  }
  try {
    const { data } = force
      ? await apiWithProgress("/api/feed/refresh", {
          method: "POST",
          timeoutMs: 90000,
          onTick: (ms) => { btn.textContent = `${Math.round(ms / 1000)}s`; },
        })
      : await api("/api/feed");

    if (!data.items || !data.items.length) {
      grid.innerHTML = `<div class="feed-empty">暂时拿不到联网素材${
        data.message ? "：" + data.message : ""
      }<br><span style="font-size:11.5px">可检查网络，或稍后点右上角 ⟳ 重试</span></div>`;
      note.textContent = "";
      return;
    }

    grid.innerHTML = "";
    data.items.forEach((it) => {
      const card = el("div", "feed-card", `
        <div class="fc-thumb">
          <img src="${it.thumb}" alt="${it.title}"
               onerror="this.style.display='none';this.parentNode.classList.add('loadfail')" />
          <span class="fc-kind">${it.kind === "asset" ? "可商用" : "灵感"}</span>
        </div>
        <div class="fc-body">
          <div class="fc-title">${it.title || "—"}</div>
          <div class="fc-credit">${it.credit ? "© " + it.credit : it.sourceName || ""}</div>
        </div>`);
      card.style.cursor = "zoom-in";
      card.onclick = () => openFeedPreview(data.items, data.items.indexOf(it));
      grid.appendChild(card);
    });

    // 状态与署名说明 —— 不能只展示图而不说明来源
    const okSources = (data.status || []).filter((s) => s.ok);
    const skipped = (data.status || []).filter((s) => s.skipped);
    $("#feedSub").textContent =
      `${okSources.map((s) => s.label).join(" + ") || "联网素材"} · ${
        data.fromCache ? "来自缓存" : "刚刚更新"
      }`;
    $("#feedAge").textContent = data.fetchedAt
      ? `更新于 ${new Date(data.fetchedAt).toLocaleString("zh-CN", {
          month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
        })}`
      : "";

    const hasAsset = data.items.some((i) => i.kind === "asset");
    note.innerHTML =
      `<b>关于版权</b>：这些图片来自公开图源，<b>仅作版式与配色参考</b>，不可直接用于商业交付。` +
      (hasAsset
        ? " 其中标注「可商用」的条目来自你配置的素材库，使用时请按该站许可署名。"
        : ` 需要可商用素材，请在 <code>site/feed.config.json</code> 里配置 Pexels 或 Unsplash 的 key。`) +
      (skipped.length
        ? `<br><span style="color:var(--ink-3)">未启用的源：${skipped
            .map((s) => s.label + "（缺 key）")
            .join("、")}</span>`
        : "");
  } catch (e) {
    grid.innerHTML = `<div class="feed-empty">联网素材获取失败：${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "⟳";
  }
}

/** 灵感图也用同一个弹层，但操作是"看大图/下载参考"，不套模板 */
function openFeedPreview(list, index) {
  preview.kind = "feed";
  preview.list = list;
  preview.index = Math.max(0, Math.min(index, list.length - 1));
  $("#previewModal").hidden = false;
  document.body.style.overflow = "hidden";
  renderPreview();
}

$("#feedRefresh").onclick = () => loadFeed({ force: true });

/* ---------------------------------------------------------------- 弹层文案常量 */
// 「爆火案例」整节已按需求删除：loadCases()、案例卡、PLAT 平台表一并移除。
// AUDIENCE 保留，模板弹层仍要显示服务对象。
const AUDIENCE = { hotel: "酒店", restaurant: "饭馆", bureau: "文旅局", tourist: "游客" };

/* ---------------------------------------------------------------- 文件上传（真实链路） */
async function addFiles(list) {
  const incoming = Array.from(list).filter((f) => f.type.startsWith("image/"));
  if (!incoming.length) return;
  const room = Math.max(0, 6 - state.files.length);
  const take = incoming.slice(0, room);
  if (!take.length) return;

  // 先占位，让用户立刻看到反馈
  const pending = take.map((f) => ({ name: f.name, uploading: true }));
  state.files.push(...pending);
  renderFileList();

  try {
    const payload = { files: [] };
    for (const f of take) payload.files.push({ name: f.name, dataUrl: await fileToDataURL(f) });
    const { data } = await api("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const idx = state.files.indexOf(pending[0]);
    if (idx >= 0) state.files.splice(idx, pending.length);
    if (data.ok && data.files) {
      data.files.forEach((sf) => state.files.push({ ...sf, uploaded: true }));
    }
    state.lastUploadErrors = data.errors && data.errors.length ? data.errors : null;
    renderFileList();
  } catch (e) {
    const idx = state.files.indexOf(pending[0]);
    if (idx >= 0) state.files.splice(idx, pending.length);
    state.lastUploadErrors = [{ name: take.map((f) => f.name).join("、"), reason: String(e.message || e) }];
    renderFileList();
    // 注意：不要在这里用 alert —— 无头浏览器里 alert 会阻塞脚本，
    // 导致状态永远停在"上传中"。错误已经写进 lastUploadErrors 并在 chips 里显示。
    console.error("[upload] 失败:", e);
  }
}

function renderFileList() {
  const box = $("#fileList");
  box.innerHTML = "";
  state.files.forEach((f, i) => {
    const label = f.uploading ? `⏳ ${f.name.slice(0, 12)}` : `🖼 ${(f.name || "").slice(0, 12)}`;
    const chip = el("span", "chip", `${label} ✕`);
    chip.title = f.uploading ? "上传中…" : `${f.name} · ${(f.bytes / 1024).toFixed(0)} KB`;
    if (!f.uploading && f.url) {
      chip.style.borderColor = "rgba(232,160,94,.6)";
      chip.style.background = "rgba(232,160,94,.12)";
    }
    chip.onclick = () => {
      state.files.splice(i, 1);
      renderFileList();
    };
    box.appendChild(chip);
  });

  if (state.files.length) {
    const ok = state.files.filter((f) => f.uploaded && f.url).length;
    const info = el("span", "chip", `已上传 ${ok}/${state.files.length}`);
    info.style.pointerEvents = "none";
    info.style.opacity = "0.75";
    box.appendChild(info);
  }
  if (state.lastUploadErrors?.length) {
    const bad = el("span", "chip", `⚠ 被拒 ${state.lastUploadErrors.length} 个`);
    bad.style.color = "#ffb4b4";
    bad.style.pointerEvents = "none";
    bad.title = state.lastUploadErrors.map((e) => `${e.name}: ${e.reason}`).join("\n");
    box.appendChild(bad);
  }
  // 照片增减会改变「图 + 文一起出图」的说明，提示语跟着刷；
  // 同时让上一次的模型结果过期（否则会出现"新照片配旧文案"）
  updatePromptHint();
  invalidateCompose();
  updateAdLawNote();
}

const drop = $("#drop");
$("#uploadBtn").onclick = () => $("#fileInput").click();
drop.onclick = () => $("#fileInput").click();
drop.onkeydown = (e) => {
  if (e.key === "Enter" || e.key === " ") $("#fileInput").click();
};
$("#fileInput").onchange = (e) => {
  addFiles(e.target.files);
  e.target.value = "";
};

["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  })
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  })
);
drop.addEventListener("drop", (e) => {
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});
window.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const it of items) if (it.kind === "file") files.push(it.getAsFile());
  if (files.length) addFiles(files);
});

/* ---------------------------------------------------------------- 文字输入 */
//
// 用户在输入框里说的话，会与上传的图片一起决定产出内容。
// 这里做"轻量意图解析"：不引入模型，用关键词把自然语言拆成结构化字段。
// 为什么不用 LLM：本地跑不起第二个模型，且这段规则是可测、可解释的；
// 接 LLM 的位置在 poster-forge 的 Skill 层，这里是确定性兜底。
function parsePrompt(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  const out = { raw: text };

  // 先去掉括号里的补充说明。
  // 通用模板写的是「我的店名（改成你的酒店名）」，而"酒店"正是品牌后缀词，
  // 不剥掉的话整句会被当成店名/地名切走，标题和卖点都被咬掉一块。
  // 这里"剥括号"比加断言可靠：断言只能看一位，管不住"改成你的"这种多字前缀。
  const clean = text.replace(/[（(][^）)]{0,50}[）)]/g, "");
  out.text = clean;

  const lines = clean.split(/[\n。；;]/).map((s) => s.trim()).filter(Boolean)
    // 价格已经从文本里解析出来了，标题里不该再出现"价格 ￥599"这种字眼
    //（实测标题被并成「双人套餐 4 菜 1 汤/价格 ￥599」）。
    .map((l) => l.replace(/(?:价格|售价|价位|门票|票价|人均|现价|原价)\s*[:：]?\s*(?:￥|¥)?\s*[\d,]+(?:\.\d+)?/g, ""))
    .map((l) => l.replace(/[，,、:：\s]+$/, "").trim())
    .filter(Boolean);

  // 价格：优先**明确标注**的价格，再退回裸数字。
  // 为什么要有优先：实测输入「连住两晚立减 300 元…价格 ￥599」时，
  // 旧写法取到的是"300"（优惠幅度的数字），真正标价 599 反而丢了。
  // 海报上印错价格比不印更糟，所以标注优先。
  const labeled = text.match(/(?:价格|售价|价位|门票|票价|人均|现价|原价)\s*[:：]?\s*(?:￥|¥)?\s*([\d,]+(?:\.\d+)?)/);
  const pm = labeled
    ? labeled
    : text.match(/(?:￥|¥)\s*([\d,]+(?:\.\d+)?)|(\d[\d,]*)\s*元/);
  if (pm) out.price = "￥" + String(pm[1] || pm[2]).replace(/,/g, "");

  // 电话
  const ph = text.match(/(1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}|0\d{2,3}[\s-]?\d{3,4}[\s-]?\d{4})/);
  if (ph) out.phone = ph[0];

  // 营业/活动时间
  const tm = text.match(/(\d{1,2}[:：]\d{2}\s*[-–~至]\s*\d{1,2}[:：]\d{2})/);
  if (tm) out.hours = tm[1];

  // 地址：只在用户**明确写了**地址时才取。
  // 早先海报上的地址是写死的演示地址（"福建省厦门市…"）—— 通用模板一上来就
  // 印一个编造的地址，等于把假信息当事实交给用户去发布，这条必须堵住。
  const am = clean.match(/(?:地址|位置|地点)\s*[:：]?\s*([^\n]{4,40})/);
  if (am) out.address = am[1].replace(/[（(][^）)]{0,50}[）)]/g, "").trim();

  // 品牌/地点名：带行业后缀的短语。
  // 后缀表来自文旅实际场景 —— 少了"竹海/所城/古镇"这类专有名词就会漏识别。
  //
  // 专名类字符里刻意不含"的了是在和与及你我"：品牌名不会以这些字开头，
  // 含进去会一路吃到前面的说明话里（踩过："改成你的酒店"被整个当成店名）。
  // 断言 (?<![你的]) 拦的是「你的酒店」这种占位说法。
  const bm = clean.match(
    /((?<![你的])[\u4e00-\u9fa5A-Za-z0-9·]{2,14}?(?:酒店|民宿|度假村|饭店|餐厅|私房菜|酒楼|茶事|茶馆|景区|博物馆|夜市|公园|竹海|古镇|所城|温泉|山庄|度假区|老街))/
  );
  // "我的店名"这类占位是给用户看的，不该当成真店名往海报上印
  if (bm && !/^[你我]的/.test(bm[1])) out.brand = bm[1];

  // 标题：优先取"含数字或动作"的卖点句 —— 那才是用户真正想突出的信息。
  // 早先直接取第一段，结果"山海楼酒店秋季促销"被当成标题，
  // 而"住三晚送一晚"这个真正的卖点反而丢了。
  const OFFER = /送|赠|含|免费|连住|次|折|减|元|￥|¥|\d/;
  // 写给用户看的填写说明（"改成你的店名"之类）不是海报文案，必须排除，
  // 否则会作为卖点印到海报上。
  const ADVICE = /改成|换成|替换|可替换|填成|写成|删掉|删除|可改/;
  const candidates = lines
    .filter((l) => !ADVICE.test(l))
    // 联系方式单独成行的那句要先摘掉：电话已经进 out.phone 了，
    // 留着这行只会把"我的店名· 电话 000-0000-0000"当卖点印到海报上。
    .map((l) =>
      l
        .replace(out.brand ? out.brand : "", "")
        .replace(/(?:电话|咨询|客服|联系|预订)?\s*[\d][\d\s\-]{5,}/g, "")
        .replace(/^[，,、:：·\s]+/, "")
        .replace(/[，,、:：·\s]+$/, "")
        .trim()
    )
    .filter((l) => l.length >= 2 && l.length <= 26)
    // "我的店名 / 我的打卡点"这类占位不是文案，是让用户替换的提示
    .filter((l) => !/^[你我]的[\u4e00-\u9fa5]{0,3}(店名|品牌名|活动名|地名|景区名|打卡点)?$/.test(l));
  const offer = candidates.find((l) => OFFER.test(l));
  out.titleLine = offer || candidates[0] || clean.slice(0, 20).trim();

  // 卖点：其它候选句（去掉标题那句）
  out.points = candidates.filter((l) => l !== out.titleLine).slice(0, 3);

  return out;
}

/* ---------------------------------------------------------------- 要求 vs 文案 */
//
// 用户打的常常是"让我怎么干活"，不是"要印什么字"。
// 真实案例：输入「帮我融合这两张图片并配上去西湖的旅游文案」，
// 旧版把整句当成文案原样印到海报上 —— 海报上出现"帮我融合这两张…"这种话，
// 完全是错的。这里把"要求"识别出来，转成实际文案再排。
//
// 处理顺序：
//   1. 「」/『』/"" 里括起来的内容 = 用户点名要原样印的字，优先
//   2. 含指令词（帮我/生成/融合/配上…）的长句 = 要求 → 生成文案
//   3. 其它 = 当作事实内容，走原来的解析（价格/电话/卖点）
const BRIEF_VERBS = [
  "帮我", "帮忙", "请你", "请帮", "麻烦", "生成", "做一张", "做张", "做一个", "做一份",
  "出一张", "出张", "出一份", "设计", "制作", "排版", "写一个", "写一份", "给我",
  "融合", "合成", "拼接", "拼一张", "拼个", "配文", "配上", "配上文案", "搭一个",
  "加文字", "加个标题", "来一张", "来一份", "搞一张", "弄一张",
];
// 内容类型：用来决定文案库的分类
const BRIEF_KINDS = [
  ["tourism", ["旅游文案", "旅游", "旅行", "游记", "攻略", "打卡文案", "游玩"]],
  ["food", ["餐饮文案", "餐厅文案", "美食文案", "饭馆", "餐厅", "餐饮", "菜品", "menu", "菜单"]],
  ["stay", ["住宿文案", "酒店文案", "民宿文案", "住宿", "酒店", "民宿", "客房", "房间"]],
  ["event", ["活动文案", "活动通知", "开市", "市集", "展览", "演出", "讲座", "报名"]],
  ["sale", ["新品文案", "促销文案", "上新", "新品", "优惠", "折扣", "特价"]],
];
const PLACE_SUFFIX = "省|市|区|县|镇|乡|村|街道|路|街|巷|湖|山|河|江|海|岛|湾|港|峰|岭|谷|林|园|寺|庙|塔|桥|城|关|门|洲|泉|瀑|洞|峡|原|滩|湿地|古镇|古城|公园|景区|博物馆|美术馆|广场|大道|胡同|里弄";

/**
 * 拆解出的候选是不是真地名。
 *
 * 有些词天生就不是地名，但结尾恰好撞上后缀表 —— "活动海报"撞"海"、
 * "宣传海报"撞"海"、会生成出「来活动海的这一天」这种荒唐标题。
 * 这类词收进拒绝名单比逐个放行省事得多。
 */
const SUBJECT_REJECT = /海报|宣传|活动|文案|促销|广告|招贴|邀请|报名|上新|优惠|打折|特价|通知|公告|预告|推荐|攻略|打卡|标题|素材|模板/;

/**
 * 从要求里找出地名 / 主题。
 *
 * 为什么不直接用 /([\u4e00-\u9fa5]{2,6}(?:湖|山|...))/：
 * "并配上去西湖"里的"并配上去"也是汉字，长度也够，"配"前面正好有"去"，
 * 结果整个短语被当成地名，生成出「把片并配上去西湖收进一天里」这种句子（真踩过）。
 *
 * 现在的做法：先给每个字打上"能不能当地名组成字"的标记（动词、量词、标点、虚词一律不行），
 * 再从**每个后缀出现的位置往前取最短的合法连续片段** —— 短即优先，
 * 所以"杭州西湖"会取到"西湖"，"请生成一张杭州西湖"也只会取到"西湖"。
 */
function extractSubject(text) {
  const clean = String(text || "")
    .replace(/[（(][^）)]{0,50}[）)]/g, "")
    .replace(/[「『"“][^」』"”]{2,40}[」』"”]/g, "");   // 引号里是要印的字，不是主题

  // 不能出现在地名里的字：动词、量词、虚词、标点、常见说明词的字
  const BAD = /[的了是在和与并配上去来把用这那请帮我要做写生成张份个文案图片照告每位给让或及到从对为着过往向于以及末初底前后中旬，,。、：:；;！!？?（）()【】\[\]\s]/;
  const isPlaceChar = (ch) => !!ch && /[\u4e00-\u9fa5A-Za-z0-9]/.test(ch) && !BAD.test(ch);

  const re = new RegExp(PLACE_SUFFIX, "g");
  let m;
  while ((m = re.exec(clean))) {
    const end = m.index + m[0].length;
    // 往左取：1~4 个字（"杭州西湖"取"西湖"，"云栖竹海"取"云栖竹海"）
    for (let len = m[0].length + 1; len <= 6; len++) {
      const start = end - len;
      if (start < 0) break;
      const cand = clean.slice(start, end);
      if (cand.length !== len) break;
      if (![...cand].every(isPlaceChar)) continue;
      if (SUBJECT_REJECT.test(cand)) continue;
      // 左边一个字如果也能当地名字，说明地名还没到头，继续往左扩
      if (start > 0 && isPlaceChar(clean[start - 1])) continue;
      // 右边紧跟连接词/标点，说明这个地名到这就结束了
      if (/^[并和与配加的，,。、：:]/.test(clean.slice(end, end + 1))) return cand;
      return cand;
    }
  }

  // 兜底：主题不一定是地名（"海边日出""秋季踏青""第一缕光"）。
  // 做法是把"要我干活"的话和"要哪类文案"的类目词都剥掉，剩下的就是主题。
  const MEASURE = "[一二三四五六七八九十\\d]*";
  const stripped = clean
    // 注意顺序：**先剥动词，再剥量词**。
    // 反过来的话"帮我做两张图配餐饮文案"里的"做"会挡住量词匹配
    //（"两张"匹配到、"做两张"没匹配到），最后剩下"做两案"当标题（真踩过）。
    .replace(/帮我|帮忙|请你|请帮|麻烦|生成|制作|设计|排版|做一张|做张|做一个|做份|做一份|出一张|出张|出一份|来一张|搞一张|弄一张|给|把|将/g, "")
    .replace(new RegExp(`[这那]${MEASURE}[张个份句篇]|${MEASURE}[张个份句篇]`, "g"), "")
    // 类目词：出现就说明用户是在说要哪一类文案，不是主题
    .replace(/民宿住宿|民宿|酒店|餐厅|餐饮|住宿|客房|旅游|旅行|打卡|新品|促销|优惠|活动通知|活动/g, "")
    .replace(/图片|照片/g, "")
    .replace(/配上文案|配上|配文|配|融合|合成|拼接|拼一张|拼个|加上|加个?|附上/g, "")
    .replace(/海报|宣传|推广|物料|文案|图/g, "")
    .replace(/[的了是在和与并这那用,，。、：:；;！!？?（）()「」『』"“”]/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (stripped.length >= 2 && stripped.length <= 10 && !SUBJECT_REJECT.test(stripped)
      // 日期 / 时间段不是主题："10月1日"这种剥完会剩下一串数字当标题
      && !/\d\s*[月日号周]/.test(clean) && !/周[一二三四五六日末]/.test(stripped)) {
    return stripped;
  }
  return null;
}

/** 判断这句是"要求"还是"要印的文案" */
function detectBrief(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  const out = { isBrief: false, quoted: [], photos: 0, subject: null, kind: null };

  // 1) 引号里的字是用户明确要印的
  const q = text.match(/[「『"“]([^」』"”]{2,40})[」』"”]/g);
  if (q) out.quoted = q.map((s) => s.replace(/^[「『"“]|[」』"”]$/g, "").trim()).filter(Boolean);

  // 2) 照片张数（"这两张图片""用 3 张照片"）
  const pm = text.match(/([\d一二两三四五六七八九十]+)\s*张/);
  if (pm) {
    const map = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    out.photos = map[pm[1]] || parseInt(pm[1], 10) || 0;
  } else if (/这些图|这几张|两张图|多张图/.test(text)) {
    out.photos = 2;
  }

  // 3) 内容类型
  for (const [kind, words] of BRIEF_KINDS) {
    if (words.some((w) => text.includes(w))) { out.kind = kind; break; }
  }

  out.subject = extractSubject(text);

  // 4) 判定
  const verbHits = BRIEF_VERBS.filter((v) => text.includes(v));
  const hasVerb = verbHits.length > 0;
  const namedPhotos = /图片|照片|图/.test(text);
  const hasImageOp = /融合|合成|拼接|拼|配上|配文|加文字|加个标题/.test(text);
  const asksKind = out.kind !== null;

  out.verbHits = verbHits;
  // 短句且没有"要我干活"的动词 → 当事实内容处理
  out.isBrief = (hasVerb || hasImageOp || (namedPhotos && asksKind)) &&
    (hasVerb || hasImageOp || asksKind) &&
    (text.length >= 6 || hasVerb);

  // 有引号就不用生成了：用户已经把要印的字给了
  if (out.quoted.length && !hasVerb && !hasImageOp) out.isBrief = false;
  return out;
}

/** 按"要求"生成文案 —— 确定性模板 + 关键词，不用第二个模型 */
function briefCopy(brief, fallbackTitle) {
  const kind = brief.kind || "tourism";
  const s = brief.subject || "";
  const CAT = {
    tourism: {
      pool: ["把{0}收进一天里", "{0}今日实拍", "来{0}的这一天", "在{0}慢慢走"],
      subs: ["随手一拍都是可以当桌面的一天", "把路过的地方重新看一遍", "慢一点，才看得见细节"],
      cta: "收藏这篇，下次直接照着走",
    },
    food: {
      pool: ["{0}这顿值得专程来", "{0}今日现做", "在{0}吃好一顿"],
      subs: ["现点现做，热的时候最好吃", "当季食材，卖完为止", "两个人点这几样就够"],
      cta: "提前预约，到店不用等",
    },
    stay: {
      pool: ["{0}住一晚再走", "{0}这一晚", "把{0}当作家"],
      subs: ["含双早，退房时间可延至 14:00", "窗外就是景，离店前别急着退房", "行李可以先寄存，走的时候再来取"],
      cta: "连住两晚更划算",
    },
    event: {
      pool: ["{0}本周开市", "{0}限时开放", "{0}这周末见"],
      subs: ["现场有摊位与手作体验", "当天免费入场，无需预约", "每场名额有限，先到先得"],
      cta: "把时间记下来，别错过",
    },
    sale: {
      pool: ["{0}上新了", "{0}首发", "{0}新一季"],
      subs: ["首发期间价格最低", "数量有限，售完即止", "前 100 名下单赠同款小样"],
      cta: "点击咨询，锁定名额",
    },
  };
  const c = CAT[kind] || CAT.tourism;
  // 用主题算个稳定下标：同一主题每次生成结果一致（可复现），不随刷新乱跳
  const seed = [...(s || kind)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % c.pool.length;
  if (s) {
    return {
      title: c.pool[seed].replace("{0}", s),
      sub: c.subs[seed % c.subs.length] + "\n" + c.cta,
      fromBrief: true,
      kind,
      subject: s,
    };
  }
  // 连地名都没给：不编，直接告诉用户缺什么
  const hint = kind === "tourism"
    ? "文案待补：写清「地点 + 想推什么」，或点上面的通用模板"
    : "副标题待补：写清「地点 / 门店 + 想推什么」，或点上面的通用模板";
  return {
    title: fallbackTitle || "○○（填地点或活动名）",
    sub: hint,
    fromBrief: true,
    kind,
    subject: null,
    needsDetail: true,
  };
}

/** 把解析结果变成海报标题（最多两行） */
function titleFromParsed(p) {
  if (!p) return null;
  let t = p.titleLine || "";
  // 去掉品牌前缀（品牌另有 brand 字段展示），标题只留卖点
  if (p.brand && t.startsWith(p.brand)) t = t.slice(p.brand.length);
  t = t.replace(/^[，,、:：\s]+/, "").trim();
  if (!t) return null;
  // 断行规则交给共用模块（本地与模型两条路必须一致），且**绝不切在词中间**
  return splitTitleLines(t).join("\n");
}

/* ---------------------------------------------------------------- 通用关键词模板 */
//
// 为什么正文放在 JS 里而不是 HTML 的 data-* 属性里：
// HTML 属性值里的换行会被解析成空格，多行结构（优惠行 / 受众行 / 联系方式行）
// 就在解析前被压平了，标题只会拿到第一行。放这里能原样保留 \n。
//
// 另一条硬规矩：这些模板必须是**通用的**，不许出现任何示例店名、真实电话、
// 具体地名或编造的销量数字 —— 用户会把它当成模板去改，不是当数据去读。
const GENERIC_PROMPTS = {
  stay:
    "连住两晚立减 300 元，含双早，周末不加价\n" +
    "限 2 位成人入住\n" +
    "我的店名（改成你的酒店名）· 电话 000-0000-0000",
  dining:
    "双人套餐 4 菜 1 汤，现点现做\n" +
    "工作日 11:00-14:00 可用，节假日通用\n" +
    "我的店名（改成你的餐厅名）· 电话 000-0000-0000",
  ticket:
    "景区门票 2 张立减 60 元，含往返摆渡\n" +
    "下单后 30 天内有效，随时可退\n" +
    "我的景区名（改成你的景区名）· 电话 000-0000-0000",
  checkin:
    "今日实拍，随手一拍就是大片\n" +
    "观景台机位出片，建议日落前一小时到\n" +
    "我的打卡点（改成你的地名）",
  event:
    "本周末开市，20 个摊位不重样\n" +
    "周六 10:00-21:00，免费入场\n" +
    "我的活动名（改成你的活动名）· 咨询 000-0000-0000",
  newarrival:
    "新品上市，首发价 199 元起\n" +
    "前 100 名下单赠同款小样\n" +
    "我的品牌名（改成你的品牌名）· 电话 000-0000-0000",
};

/* ---------------------------------------------------------------- 广告法预检 */
//
// 服务端 poster-forge/validate.py 会因为广告法禁用词**直接拒绝出图**
// （"最佳""最好""第一"这类，《广告法》第九条，处罚不是风格问题）。
//
// 但用户是在点完生成、等了几十秒之后才看到这个错 —— 体验很差，而且他不知道该改哪。
// 所以这里在**输入阶段**就用同一份词表做一次预检：当场标红 + 给一键改写。
//
// 注意这是宽松版预检（只挡硬禁词 + 提示需资质词），最终仍以服务端校验为准，
// 两边词表不一致时以服务端为准 —— 预检只负责"别让用户白等一次"。
const AD_LAW_HARD = [
  "国家级", "世界级", "最高级", "最佳", "最好", "最优", "最强", "最便宜", "最低价",
  "第一品牌", "全国第一", "全市第一", "销量第一", "排名第一",
  "绝无仅有", "独一无二", "百分百", "100%", "永久", "根治", "特效",
  "国家免检", "免检产品", "央视上榜",
];
const AD_LAW_PROOF = ["特级", "极品", "首家", "独家", "领先", "权威", "驰名商标", "老字号"];

/** 命中的违规词 + 改写建议（改写要尽量保住原意，不能只是删掉） */
const AD_LAW_FIX = {
  // 注意：替换词里**不能再用"最"**。早先把「最佳」换成「很最佳」，
  // 结果改写完仍然命中禁词、警告又冒出来（测试抓到的）。
  最佳: "很出片",
  最好: "很合适",
  最优: "很划算",
  最强: "很扎实",
  最高级: "高规格",
  最便宜: "很实惠",
  最低价: "优惠价",
  国家级: "高规格",
  世界级: "很有名",
  绝无仅有: "少见",
  独一无二: "少见",
  百分百: "基本",
  "100%": "基本",
  永久: "长期",
  根治: "改善",
  特效: "明显效果",
  国家免检: "合格",
  免检产品: "合格产品",
  央视上榜: "广受关注",
  第一品牌: "知名品牌",
  全国第一: "广受认可",
  全市第一: "广受认可",
  销量第一: "销量可观",
  排名第一: "名列前茅",
  特级: "优质",
  极品: "上等",
  首家: "较早做起",
  独家: "自营",
  领先: "表现不错",
  权威: "专业",
  驰名商标: "知名品牌",
  老字号: "多年老店",
};

/** 扫一段文本，返回命中的硬禁词与需资质词 */
function checkAdLaw(text) {
  const s = String(text || "");
  const hard = AD_LAW_HARD.filter((w) => s.includes(w));
  const proof = AD_LAW_PROOF.filter((w) => s.includes(w) && !hard.includes(w));
  return { hard, proof, clean: hard.length === 0 && proof.length === 0 };
}

/**
 * 按建议表改写命中词。
 *
 * **必须循环到稳定**：替换词本身可能又命中禁词（"最"字就是这么漏的），
 * 单趟替换会留下一个仍然违规的结果，比不改更坑 —— 用户以为改好了，生成又失败。
 * 上限 6 轮防死循环；仍不干净的直接删词兜底。
 */
function fixAdLaw(text) {
  let s = String(text || "");
  const words = [...AD_LAW_HARD, ...AD_LAW_PROOF];
  for (let pass = 0; pass < 6; pass++) {
    const hit = words.filter((w) => s.includes(w));
    if (!hit.length) break;
    for (const w of hit) s = s.split(w).join(AD_LAW_FIX[w] ?? "");
  }
  const left = words.filter((w) => s.includes(w));
  for (const w of left) s = s.split(w).join("");   // 兜底：实在换不掉就删
  // 改写后的常见病句：连续空格、叠字
  return s.replace(/[ \t]{2,}/g, " ").replace(/(很|的)\1+/g, "$1").trim();
}

/** 把某个 spec 里所有会印出来的文字收集起来做预检 */
function specTexts(spec) {
  const out = [];
  const walk = (list) => (list || []).forEach((el) => {
    if (!el || typeof el !== "object") return;
    if (el.type === "text" && typeof el.text === "string") out.push(el.text);
    walk(el.layers);
    walk(el.children);
  });
  walk(spec?.layers);
  return out.join("\n");
}

/** 输入变化时刷新预检结果，并把提示条显示出来 */
function updateAdLawNote() {
  const box = $("#adLawNote");
  if (!box) return;
  const hide = () => {
    // 隐藏时把内容和 class 一起清掉：留着旧文本会让"读 DOM 做判断"的人
    // （包括我自己写测试时）看到已经过期的提示，误以为警告还在
    if (!box.hidden) {
      box.hidden = true;
      box.innerHTML = "";
      box.className = "adlaw";
    }
  };
  const raw = currentPrompt().trim();
  if (!raw) return hide();

  const { hard, proof } = checkAdLaw(raw);
  if (!hard.length && !proof.length) return hide();

  box.hidden = false;
  if (hard.length) {
    box.className = "adlaw hard";
    box.innerHTML =
      `<b>⚠ 这些词会让海报被服务端拒绝出图</b>` +
      `<span class="adlaw-words">${hard.map((w) => `「${w}」`).join(" ")}</span>` +
      `<span class="adlaw-dim">《广告法》第九条禁用，生成时会被校验拦下。</span>` +
      `<button class="adlaw-fix" id="adLawFix">一键改写</button>`;
  } else {
    box.className = "adlaw warn";
    box.innerHTML =
      `<b>提示：这些词可能需要资质证明</b>` +
      `<span class="adlaw-words">${proof.map((w) => `「${w}」`).join(" ")}</span>` +
      `<span class="adlaw-dim">有资质可以留着；没有建议改掉。</span>` +
      `<button class="adlaw-fix" id="adLawFix">一键改写</button>`;
  }
  const btn = $("#adLawFix");
  if (btn) {
    btn.onclick = () => {
      const before = currentPrompt();
      const after = fixAdLaw(before);
      setPrompt(after);
      // 手动触发一次，让提示条与文案状态一起刷新
      $("#promptInput").dispatchEvent(new Event("input", { bubbles: true }));
      btn.textContent = "已改写";
      setTimeout(() => updateAdLawNote(), 900);
    };
  }
}

/** 提示语随状态变化：让「图片 + 文字一起出图」这件事在界面上是可见的 */
function updatePromptHint() {
  const box = $("#promptHint");
  if (!box) return;
  const n = state.files.filter((f) => f.uploaded && f.url).length;
  const typed = currentPrompt().trim().length > 0;
  const brief = typed ? detectBrief(currentPrompt()) : null;

  // 说明"谁来写文案"：模型在就说模型写，不在就说用本地规则
  const brainReady = !!state.brain?.ready;
  const brainLoading = !state.brain;
  const who = brainReady
    ? `文案由 ${state.brain.copy} 现写`
    : brainLoading
    ? "正在检查模型状态"
    : "模型未就绪，本次用本地规则兜底";
  const tail = `（${who}）`;

  if (n >= 2) {
    box.textContent = typed
      ? `已载入 ${n} 张照片，会在海报顶部拼成一条图带（每张都上版面）；文字按下面内容排。`
      : `已载入 ${n} 张照片，会在海报顶部拼成一条图带；再写一句要宣传的内容即可。`;
    box.textContent += tail;
    return;
  }
  if (n && typed) {
    box.textContent = `已载入 1 张照片 + 你的文字：这张图会作为海报底图，文字按下面内容排。`;
    box.textContent += tail;
  } else if (n) {
    box.textContent = "已载入 1 张照片，会作为海报底图；再补一句活动实情，文案就跟着变。" + tail;
  } else if (typed) {
    box.textContent = brief?.isBrief
      ? "这句是「要求」不是「文案」，模型会按它写文案；想要原文照排就用「」把文案括起来。" + tail
      : "已有文字，还没有图片 —— 现在是纯文字海报；上传一张照片，模型会读图后一起写。" + tail;
  } else {
    // 手册模式不提"上传照片" —— 那个模式里上传是藏起来的，
    // 提示语却写着"或上传照片"，用户会去找一个不存在的按钮。
    const isBookNow = state.cap === "copybook";
    box.textContent = isBookNow
      ? `写下这次活动的实情（店名、价格、电话都可以留占位），${state.brain.copy || "模型"} 会整理成多页手册。点上面的通用模板能快速填。`
      : brainReady
        ? `直接写一句要求（例如「帮我做一张西湖的旅游海报」）或上传照片，${state.brain.copy} 会现写文案；点上面的通用模板也能快速填。`
        : "点上面的通用模板会填入占位文案，把「我的店名 / 电话 / 价格」换成你的即可；再上传图片，就会和文字一起出图。";
  }
}

function currentPrompt() {
  const el = $("#promptInput");
  return el ? el.value : "";
}

function setPrompt(v) {
  const el = $("#promptInput");
  if (!el) return;
  el.value = v;
  updatePromptCount();
}

function updatePromptCount() {
  const n = currentPrompt().length;
  const c = $("#promptCount");
  if (c) c.textContent = n ? `${n} 字` : "未填写";
  updatePromptHint();
}

if ($("#promptInput")) {
  $("#promptInput").addEventListener("input", () => {
    updatePromptCount();
    invalidateCompose();     // 文案被改了，上一次模型的结果就过期了
    updateAdLawNote();       // 广告法预检：命中硬禁词当场标出来，别等生成失败
  });
  $("#promptClear").onclick = () => {
    setPrompt("");
    $("#promptInput").focus();
  };
  // 通用模板：点一下填进去，可再编辑。
  // 留空时点模板 = 直接填入；已有内容时点模板 = 追加，避免手一抖把写好的文案冲掉。
  //
  // 注意选择器必须带 [data-tpl]：这里原来只按 .mini-chip 类名选，
  // 而 .mini-chip 是**样式类**，后来新增的「存为我的模板」按钮也用了它 ——
  // 于是那个按钮被当成通用模板芯片，它没有 data-tpl，
  // GENERIC_PROMPTS[undefined] 得到 undefined，点一下就把用户写好的内容清空了。
  // 行为选择器不能复用样式类名。
  document.querySelectorAll(".mini-chip[data-tpl], .mini-chip[data-fill]").forEach((b) => {
    b.onclick = () => {
      const tpl = GENERIC_PROMPTS[b.dataset.tpl] ?? b.dataset.fill ?? "";
      if (!tpl) return;   // 空内容绝不写入，宁可什么都不做
      const cur = currentPrompt().trim();
      setPrompt(cur && !cur.includes(tpl) ? cur + "\n" + tpl : tpl);
      updatePromptHint();
      $("#promptInput").focus();
    };
  });
  // Ctrl/Cmd + Enter 直接生成
  $("#promptInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      doGenerate();
    }
  });
  updatePromptCount();
}

/* ---------------------------------------------------------------- 规格构造 */
const TONES = POSTER_TONES;

/**
 * 产出内容来源，优先级：
 *   1. 用户在输入框里写的话（最贴近意图）
 *   2. 被点选的模板
 *   3. 内置演示文案
 *
 * 输入框为空时行为与之前完全一致，不会因为新增输入框而破坏原有操作。
 */
function currentContent() {
  const parsed = parsePrompt(currentPrompt());
  const picked = window.__pickedTemplate;
  const brief = parsed ? detectBrief(currentPrompt()) : null;

  // 「要求」优先于「事实内容」：
  // 用户写"帮我融合这两张图并配上西湖旅游文案"时，要印的是**生成出来的文案**，
  // 不是这句要求本身。引号里的内容仍然原样印（用户点名要的字最大）。
  if (brief?.isBrief) {
    // 引号里是用户点名要印的字，优先；但要的是"一类文案"（旅游文案/活动文案）时，
    // 那句话只是题眼，仍走生成。
    const wantsKind = brief.kind !== null;
    if (brief.quoted.length && !wantsKind) {
      return {
        fromPrompt: true, fromBrief: true,
        parsed,
        brand: parsed.brand || (picked ? picked.title : "○○（填你的店名）"),
        title: brief.quoted[0],
        sub: brief.quoted.slice(1).join("\n") || parsed.points.join("\n") || "文案来自你的输入",
        price: parsed.price || null,
        phone: parsed.phone || null,
        address: parsed.address || null,
      };
    }
    const copy = briefCopy(brief, brief.quoted[0] || null);
    return {
      fromPrompt: true,
      fromBrief: true,
      brief,
      parsed,
      brand: parsed.brand || (picked ? picked.title : "○○（填你的店名）"),
      title: copy.title,
      sub: copy.sub,
      price: parsed.price || null,
      phone: parsed.phone || null,
      address: parsed.address || null,
      needsDetail: !!copy.needsDetail,
    };
  }

  if (parsed) {
    const title = titleFromParsed(parsed) || (picked ? picked.title : "限时特惠");

    // 副标题放"卖点句"。
    // 注意不要把品牌名塞进来 —— 品牌已经在顶部展示，副标题再写一遍是重复。
    // 输入里没有独立卖点句时，明确说明文案来源，而不是拿品牌凑数。
    let subTitle = (parsed.points || [])
      .filter((s) => s && s !== parsed.brand && !/^[\d\s:：\-–~至]+$/.test(s))
      // 地址已经从输入里单独解析出来、有专门的版位，别再当卖点重复一遍
      .filter((s) => !/^(地址|地点|位置)\s*[:：]/.test(s))
      .filter((s) => !parsed.address || !s.includes(parsed.address))
      .slice(0, 3)
      .map((s) => s.slice(0, 30))
      .join("\n");
    if (parsed.hours) subTitle = (subTitle ? subTitle + "\n" : "") + "营业时间 " + parsed.hours;
    if (!subTitle.trim()) subTitle = "文案来自你的输入";

    return {
      fromPrompt: true,
      parsed,
      // 没写店名就用**占位**，不要拿站内演示酒店名顶上：
      // 用户会觉得那是自己的店，拿去发布就是给别人做广告。
      brand: parsed.brand || (picked ? picked.title : "○○（填你的店名）"),
      title,
      sub: subTitle,
      price: parsed.price || null,
      phone: parsed.phone || null,
      address: parsed.address || null,
    };
  }

  if (picked) {
    return {
      brand: "○○（填你的店名）",
      title: picked.title,
      sub: (picked.tags || []).join(" · "),
      address: null,
    };
  }
  return {
    brand: "○○（填你的店名）",
    title: "限时特惠\n○○（填主推优惠）",
    sub: "在上方输入活动实情 · 再上传一张照片即可出图",
    address: null,
  };
}

/**
 * 照片底图上方压的遮罩。
 *
 * 为什么需要：海报上的白字原本是压在自己生成的深色渐变上的，换成用户照片后
 * 照片亮部（天空、雪地、白墙）会把标题吃掉。用几块"上疏下密"的半透明矩形
 * 拼出近似竖向渐变，既保住照片观感，又保证文字对比度 —— 不需要给渲染器加新特性。
 *
 * 几何定义已搬到 public/poster-layout.mjs（服务端与浏览器共用），
 * 这里只保留一个包装函数给打卡卡复用。
 */
function bgConfig(fallbackFrom, fallbackTo, angle, photoUrl) {
  // AI 背景生成过后换成那张图（AI 只出图像层，文字仍由引擎叠加）
  if (state.aiBgUrl) {
    return { type: "image", image: state.aiBgUrl.replace(/^\//, ""), blobs: [] };
  }
  // 没有 AI 底图时，用用户上传的照片当底图 —— 要求「图和文字一起出图」的核心
  if (photoUrl) {
    return { type: "image", image: photoUrl.replace(/^\//, ""), blobs: [] };
  }
  return { type: "gradient", from: fallbackFrom, to: fallbackTo, angle };
}

/**
 * 本地兜底：用户没联网 / 模型没开时，用确定性规则拼出海报内容。
 *
 * 注意这是**兜底**，不是主路径。主路径是 /api/compose（大模型读图 + 写文案）。
 */
function localFallbackSpec() {
  const content = currentContent();
  const urls = state.files.filter((f) => f.uploaded && f.url).map((f) => f.url);
  const toneId = state.tone && TONES[state.tone] ? state.tone : null;
  const tone = toneId === "restaurant" ? 0.8 : toneId === "bureau" ? 0.2 : 0.5;
  // AI 背景优先当底图（用户主动开过开关）
  const photos = state.aiBgUrl ? [state.aiBgUrl, ...urls] : urls;
  return buildPosterSpecFrom(content, {
    photoUrls: photos,
    layout: state.aiBgUrl
      ? "poster_photo_bg"
      : urls.length >= 2 ? "poster_photo_strip" : urls.length === 1 ? "poster_photo_bg" : "poster_text",
    tone,
    kind: state.tone || "tourism",
    factsSource: "站点表单输入（用户提供）",
  });
}

/** 兜底入口：保持旧函数名，内部走共用模块 */
function buildPosterSpec() {
  // composeSpec 只有在"模型这会儿刚给我一份、而且给的确实是海报版式"时才能用。
  // 加上版式判断是防呆：万一它里面装的是打卡卡 spec，印出来的就是海报版式。
  if (state.composeSpec && /poster/.test(state.composeSpec.layout || "")) return state.composeSpec;
  return localFallbackSpec();
}

/**
 * 按照片数量给出网格几何（比例值，间隙 0.015 ≈ 60px @1080）。
 *
 * 边框策略：**只有单图用统一外框，多图一律每张各自描边。**
 * 原因是圆角半径不匹配 —— 外框半径 38 与图片半径 ~20 不一致，
 * 框线会在角上切过图片，看起来像排版事故。
 */
function photoGrid(n) {
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
  // 4 张：2×2
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

/** 打卡卡：本地兜底构造（模型可用时由 /api/compose 出更贴图的文案） */
function buildCheckinSpec() {
  // 同样要防呆：composeSpec 里必须是打卡版式才能直接用，
  // 否则会出现"海报的 composeSpec 被当成打卡卡出图"（带价格块那种）。
  if (state.composeSpec && /checkin/.test(state.composeSpec.layout || "")) return state.composeSpec;
  const content = currentContent();
  const urls = state.files.filter((f) => f.uploaded && f.url).map((f) => f.url);
  const n = Math.min(urls.length, 4);
  // 本地兜底只能拿用户原话凑，所以这里**不做指令识别**——
  // 真正的"把要求变成文案"由模型负责（见 /api/compose 的 checkin 模式）。
  const caption = content.fromPrompt
    ? (content.parsed.titleLine || content.title || "").replace(/\\n/g, "\n").slice(0, 40)
    : "五点半的海，\n值得早起一次";
  const bodyText = content.fromPrompt
    ? (content.parsed.points || []).join(" ").slice(0, 60) || content.sub.replace(/\n/g, " ").slice(0, 60)
    : "从民宿走过去 8 分钟。风大，记得带件外套。";
  return buildCheckinSpecFrom(
    {
      caption,
      body: bodyText,
      topLabel: content.fromPrompt && content.parsed.brand
        ? content.parsed.brand.slice(0, 16)
        : "现场打卡 · " + content.brand,
    },
    { photoUrls: urls, grid: { 0: "single", 1: "single", 2: "two-col", 3: "three-col", 4: "quad" }[n] }
  );
}

/** 手册 spec 的测试注入点（正常运行时恒为 null）。
 *  存在的理由：app.js 是 ES module，模块内函数不挂全局，
 *  自动化测试无法再靠 `window.buildCopybookSpec = …` 打桩。
 *  与其为了让测试能桩而把函数泄漏到全局，不如留这一个明确的口子。 */
let __copybookSpecOverride = null;

/** 手册是纯文案结构，由服务端先校验再渲染成多页 PDF */
function buildCopybookSpec() {
  const content = currentContent();
  const t = TONES[state.tone] || TONES.auto;
  // 手册也要消费用户传的照片 —— 见下面 image 版块
  const photoUrls = state.files.filter((f) => f.uploaded && f.url).map((f) => f.url);
  return {
    meta: {
      id: "site-copybook", client: content.brand, title: "宣传文案手册",
      audience: "hotel", footer: "由 PosterForge 生成 · 示意物料",
      // 校验器要求：含价格/电话就必须标注事实来源，否则报 error
      facts_source: "站点表单输入（用户提供）· " + new Date().toISOString().slice(0, 10),
    },
    theme: {
      palette: {
        bgFrom: t.bgFrom, bgTo: t.bgTo, panel: "#08202a",
        ink: "#ffffff", inkSoft: "#d6ecec", inkMute: "#9fc4c6",
        gold: t.accent, divider: "#ffffff2e",
        paper: "#faf8f5", inkOnPaper: "#1e1a17", inkMuteOnPaper: "#57504a",
        accentOnPaper: t.accent, dividerOnPaper: "#00000022", zebra: "#00000010",
      },
    },
    sections: [
      { type: "cover", eyebrow: "2026 秋季", title: content.title,
        subtitle: content.sub,
        footer: content.phone ? "预订 " + content.phone : "预订 ○○○-○○○○-○○○○" },
      // 用户传了照片就插一整页实拍图。
      // 原先手册模式**没有任何位置能放图** —— 用户传了照片却被丢掉，
      // 界面还写着"这张图会作为海报底图"，是句骗人的提示。
      ...(photoUrls.length
        ? [{
            type: "image",
            heading: "实拍图",
            src: photoUrls[0],
            caption: photoUrls.length > 1
              ? `本页为第 1 张实拍图（共 ${photoUrls.length} 张）。其余照片可用「批量出图」分发到各平台尺寸。`
              : "本页为实拍图。替换成你自己的照片后重新生成即可。",
          }]
        : []),
      { type: "text", heading: "产品说明",
        lead: content.fromPrompt
          ? `以下内容依据你填写的说明整理：${content.parsed.raw.split("\n")[0].slice(0, 60)}`
          : "本手册由 PosterForge 生成，用于展示多页文案手册的排版能力。",
        body: content.fromPrompt
          ? [content.parsed.raw, "以上为示意内容。正式交付前请替换为客户确认的信息，并核对价格、电话、有效期。"]
          : [
              "这是文案手册的第一个正文版块。与海报不同，手册需要考虑阅读节奏：封面建立印象，导语交代背景，卖点展开细节，价格与联系方式收尾。",
              "所有文字都走确定性排版，不经过图像模型 —— 这保证了中文的准确性，也保证了同一份内容每次渲染结果完全一致。",
            ] },
      { type: "bullets", heading: "核心卖点",
        items: [
          { head: "确定性排版", body: "文字、价格、二维码走引擎合成，AI 只负责背景与图像层。" },
          { head: "可追溯", body: "每份产出旁边落一份 spec，半年后要改价直接改 spec 重渲。" },
          { head: "多尺寸分发", body: "同一份内容可出竖版、方图、横版，不必重排版。" },
        ] },
      { type: "table", heading: "版本与交付",
        columns: ["版本", "包含内容", "修改次数", "交付形式"],
        // 这里**不放价格**。原先写的是 ￥299 / ￥899 / ￥1999 ——
        // 那是给 PosterForge 自己编的价目表，会被客户当成真实报价。
        // 和手机号/邮箱同一条规矩：客户没给的钱数，一个都不印。
        rows: [
          ["基础版", "单页海报", "2 次", "PNG 源文件"],
          ["标准版", "海报 + 文案手册", "5 次", "PNG + PDF"],
          ["定制版", "全套物料 + 专属版式", "按需", "PNG + PDF + spec"],
        ] },
      // 价格页只在**用户真的给了价格**时才出 —— 与海报同一条规则：
      // 没给价格就整块不画，绝不回落默认值（回落等于编造报价）。
      ...(content.price
        ? [{ type: "price", note: "参考价", price: content.price, unit: "元 / 套",
             includes: ["竖版海报 1080×1440", "多页文案手册 PDF", "多尺寸适配导出"] }]
        : []),
      { type: "contact", title: "联系我们",
        items: [
          { k: "咨询电话", v: content.phone || "○○○-○○○○-○○○○" },
          { k: "服务时间", v: content.parsed?.hours || "○○:○○ - ○○:○○" },
          // 邮箱原先写死成 hello@example.com —— 那是**编造的联系方式**，
          // 和手机号同一条规矩：客户没给就留占位符，不能印一个能被人真去发的邮箱。
          { k: "电子邮箱", v: content.parsed?.email || "○○○@○○○.○○○" },
        ],
        qr_note: "本手册为 PosterForge 生成的示意物料，替换客户真实信息后方可对外发布。" },
    ],
  };
}

/* ---------------------------------------------------------------- 生成 */
async function generateAiBackground() {
  const { data } = await api("/api/aigen/status");
  if (!data.running && !data.workerUp) {
    // 环境就绪但 worker 还没起来是正常的（首次出图会现拉，约 20 秒），
    // 只有环境本身不行才算错。
    if (!data.ready) throw new Error(data.message || "本地出图环境不可用");
  }

  const { data: bg } = await api("/api/aigen/background", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // 提示词必须是**英文** —— 扩散模型画中文必然出乱码。
      // 原先这里写的是一句中文描述，那是按 Qwen-Image（中文友好）配的；
      // 换成 SDXL-Turbo 后中文提示词只会得到一堆无意义的笔画。
      // 走 /api/compose 自动出图时，提示词由 qwen2.5:7b 按用户原话生成（见 brain.mjs）。
      prompt:
        "serene coastal landscape at sunset, warm orange and deep teal gradient sky, "
        + "soft focus distant scenery, large clean empty area in the lower half, "
        + "gentle light, cinematic, no text, no words, no logo, no watermark",
      size: 768, height: 1024, steps: 4, seed: 42,
    }),
  });
  if (!bg.ok) throw new Error(`背景生成失败（${bg.stage}）：${bg.message}`);
  return bg;
}

function showResult({ imgUrl, metaText, errText, extraHTML }) {
  const res = $("#result");
  const img = $("#resultImg");
  const meta = $("#resultMeta");
  const err = $("#resultErr");
  const extra = $("#resultExtra");
  res.classList.add("show");
  if (errText) {
    err.textContent = errText;
    err.style.display = "block";
    img.removeAttribute("src");
    img.style.display = "none";
    meta.textContent = "";
    extra.innerHTML = "";
    return;
  }
  err.style.display = "none";
  if (imgUrl) {
    img.src = imgUrl;
    img.style.display = "";
  } else {
    img.removeAttribute("src");
    img.style.display = "none";
  }
  meta.textContent = metaText || "";
  extra.innerHTML = extraHTML || "";
}

/** 渲染手册生成结果（成功/失败两种）。抽出来是为了让 doGenerate 保持短小、可读。 */
function renderCopybookResult(data) {
  if (!data || !data.ok) {
    const list = ((data && data.errors) || []).map((e) => "· " + e).join("\n");
    const warns = ((data && data.warnings) || []).map((w) => "⚠ " + w).join("\n");
    showResult({
      errText:
        `手册生成失败（阶段：${(data && data.stage) || "未知"}）\n` +
        `${(data && data.message) || ""}\n\n` +
        (list || "") +
        (warns ? "\n\n警告：\n" + warns : ""),
    });
    return;
  }

  const pages = (data.pages || [])
    .map((p) => `<a href="${p}" target="_blank" rel="noopener"><img src="${p}" style="width:86px;border:1px solid var(--line-2);border-radius:6px" /></a>`)
    .join("");

  // 手工内容触发 warning 时也要让用户看到 —— 不能只报"成功"
  const warnHTML = (data.warnings || []).length
    ? `<div style="margin-top:12px;text-align:left;max-width:560px;margin-left:auto;margin-right:auto;
            padding:10px 13px;border-radius:10px;border:1px solid rgba(232,160,94,.35);
            background:rgba(232,160,94,.08);font-size:12px;line-height:1.7;color:#e9c9a8">
         <b>校验通过，但有 ${data.warnings.length} 条提醒：</b><br>
         ${data.warnings.map((w) => "· " + w).join("<br>")}
       </div>`
    : "";

  showResult({
    imgUrl: data.pages?.[0] || "",
    metaText: `已生成 ${data.pageCount} 页 PDF · ${(data.bytes / 1024).toFixed(0)} KB · ${data.validation || "校验通过"}`,
    extraHTML: `<div style="margin-top:13px">
        <a class="cta" style="display:inline-block;text-decoration:none;padding:11px 26px"
           href="${data.url}" download>下载 PDF</a>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:14px">${pages}</div>
      ${warnHTML}`,
  });
}

/**
 * 让大模型决定"生成什么"，拿回一份完整 spec。
 *
 * 这是主路径。模型不可用（没装 / 没开 / 超时 / 输出违规）时抛错，
 * 由调用方决定是否退回本地兜底 —— 兜底必须存在，否则模型一挂整站就不能出图。
 */
async function composeWithModel({ onProgress, mode = "poster" } = {}) {
  const brief = currentPrompt().trim();
  const photos = state.files.filter((f) => f.uploaded && f.url).map((f) => f.url);
  // 用户话里明确写出的硬事实：价格/电话/地址。这些比模型的转述可靠，
  // 由前端确定性解析后作为"必须照用"的事实交给模型。
  const parsed = parsePrompt(brief) || {};
  const facts = {
    price: parsed.price || null,
    phone: parsed.phone || null,
    address: parsed.address || null,
    brand: parsed.brand || null,
  };

  // composition 来自「套用模板」时选中的那套模板。
  // 为什么让模板决定构图而不是让模型现挑：构图是"这份物料该长什么样"，
  // 是版式决策，不该每次生成都变。用户看到的缩略图就是这个构图，
  // 换一套模板就该换一种版面 —— 否则 41 套模板全是同一张脸。
  const picked = window.__pickedTemplate || null;
  const { data } = await apiWithProgress("/api/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      brief, photos, facts, mode,
      composition: state.composition || (picked && picked.composition ? picked.composition : null),
      variant: picked && picked.variant ? picked.variant : "a",
      // 精调只跟模板走 —— 用户手选版式后 __pickedTemplate 会被清空，
      // 这时不该再套用旧模板的字号档位
      tuning: (picked && picked.tuning) ? picked.tuning : null,
    }),
    timeoutMs: 240000,   // 模型首次加载权重可能要十几秒，读图 + 写文案再叠加
    onTick: (ms) => onProgress && onProgress(ms),
  });
  if (!data.ok) {
    const err = new Error(data.message || "模型没能给出可用文案");
    err.code = data.code;
    err.raw = data.raw;
    throw err;
  }
  return data;
}

/**
 * 把模型决定的内容显示出来。
 *
 * 为什么必须显示：模型写的东西是"生成"的，用户有权看到它到底写了什么、
 * 依据是什么。藏在图片里等于黑箱 —— 出了错用户也不知道该改哪。
 */
function renderComposeNote(composed, errMsg) {
  const box = $("#composeNote");
  if (!box) return;
  if (!composed) {
    box.hidden = false;
    // 措辞不能再写"确认 Ollama 在运行" —— 那是把责任推给用户。
    // 服务端现在会**自己把本机模型拉起来**（见 brain.mjs 的 ensureOllama），
    // 走到这里说明自动拉起也失败了，该说的是"拉不起来"以及为什么。
    box.innerHTML =
      `<b>模型没有参与这次生成</b><br>` +
      `<span class="cn-err">${errMsg ? String(errMsg).slice(0, 200) : "原因未知"}</span><br>` +
      `<span class="cn-dim">已用本地确定性规则兜底，图照样能出。` +
      `服务端会自动启动本机模型（ollama serve），本次没成功 —— 上面那句是原因。</span>`;
    return;
  }
  const c = composed.copy || {};
  const scenes = composed.scenes || [];
  const isCheckin = composed.mode === "checkin";
  const photoCount = scenes.length;
  const rows = [];
  if (isCheckin) {
    rows.push(`<span>标题</span><b>${esc(c.caption).replace(/\n/g, " / ")}</b>`);
    rows.push(`<span>描述</span><b>${esc(c.body).replace(/\n/g, " ")}</b>`);
    if (c.tags?.length) rows.push(`<span>标签</span><b>${esc(c.tags.join(" · "))}</b>`);
    rows.push(`<span>照片排法</span><b>${esc(c.grid)}${composed.mixed ? " · 混搭" : ""}</b>`);
  } else {
    rows.push(`<span>标题</span><b>${esc(c.title).replace(/\n/g, " / ")}</b>`);
    rows.push(`<span>副标题</span><b>${esc(c.sub).replace(/\n/g, " / ")}</b>`);
    if (c.tags?.length) rows.push(`<span>标签</span><b>${esc(c.tags.join(" · "))}</b>`);
    rows.push(`<span>版式</span><b>${esc(c.layout)} · 调性 ${toneFor(c.tone).name}</b>`);
  }
  if (scenes.length) {
    rows.push(`<span>画面</span><b>${scenes.map((s) => esc(s.scene)).join(" ； ")}</b>`);
  }
  if (composed.modelCopy?.reason) {
    rows.push(`<span>理由</span><b class="cn-dim">${esc(composed.modelCopy.reason)}</b>`);
  }
  if (composed.mixed) {
    rows.push(`<span>混搭提示</span><b class="cn-dim">这组照片主题不完全一致${composed.mixedWhy ? "：" + esc(composed.mixedWhy) : ""}，没有编成一个故事</b>`);
  }

  // ---- 没照片时自生成的底图：把"画了什么"和"怎么改"一起告诉用户 ----
  // 用户的要求原话：「如果没有你就自己生成，并加上引导，用户不满意可以根据引导去改」。
  const bg = composed.autoBg;
  let bgHTML = "";
  if (!photoCount && bg) {
    if (bg.ok) {
      bgHTML =
        `<div class="cn-bg">` +
        `<b>底图是自动生成的</b>` +
        `<span class="cn-dim">你一张照片都没传，所以按下面的提示词生成了一张底图${bg.cached ? "（复用上次同一提示词的结果，保证可复现）" : `，用了 ${((bg.elapsedMs || 0) / 1000).toFixed(0)} 秒`}。</span>` +
        `<div class="cn-prompt" title="这是给图像模型的英文提示词">${esc(bg.prompt || "")}</div>` +
        `<span class="cn-dim">不满意怎么改：① 直接上传你自己的照片（照片永远优先于 AI 底图）；` +
        `② 在输入框里写清地点和氛围（例如「清晨的西湖，薄雾，水墨感」），提示词会跟着变；` +
        `③ 同一句要求再点一次生成，会复用同一张底图；改了文字才会重新画。</span>` +
        (bg.reason ? `<span class="cn-dim">模型的构思：${esc(bg.reason)}</span>` : "") +
        `</div>`;
    } else {
      bgHTML =
        `<div class="cn-bg cn-bg-fail">` +
        `<b>没能自动生成底图</b>` +
        `<span class="cn-err">${esc(bg.message || "未知原因")}</span>` +
        `<span class="cn-dim">这次用渐变底出了纯文字版。想让它自己画图：把输入框上方的「AI 背景」开关打开` +
        `（本地模型直接出图，不需要启动任何外部服务），或直接上传一张照片。</span>` +
        (bg.prompt ? `<div class="cn-prompt">${esc(bg.prompt)}</div>` : "") +
        `</div>`;
    }
  }

  box.hidden = false;
  box.innerHTML =
    `<b>模型决定的内容</b> <span class="cn-dim">${esc(composed.model?.copy || "")}${
      photoCount ? ` · 读图 ${photoCount} 张` : " · 未读图"
    }${isCheckin ? " · 打卡卡" : ""} · ${((composed.ms || 0) / 1000).toFixed(1)}s</span>` +
    `<div class="cn-grid">${rows.join("")}</div>` +
    bgHTML +
    ((composed.visionErrors || []).length
      ? `<div class="cn-dim">${esc(composed.visionErrors.map((v) => v.reason).join("；")).slice(0, 120)}</div>`
      : "");
}

/** 输入或照片一变，上一次的模型结果就作废 —— 否则会拿旧文案配新照片 */
function invalidateCompose() {
  state.composeSpec = null;
  state.composeCopy = null;
  state.composeScenes = null;
  const box = document.getElementById("composeNote");
  if (box) box.hidden = true;
}

async function doGenerate() {
  if (state.generating) return;
  state.generating = true;
  const btn = $("#genBtn");
  const label = btn.textContent;
  btn.disabled = true;

  try {
    // ---- 文案手册 ----
    if (state.cap === "copybook") {
      btn.textContent = "生成手册中…";
      // 分步构造 + 探针：曾出现"点生成后按钮永久卡住、服务端收不到请求"的状况，
      // 没有中间日志只能靠猜。这里把每一步都记下来（失败时也会显示出来）。
      let step = "start";
      try {
        step = "buildSpec";
        // 测试注入点：drive-copybook-error.mjs 需要喂一份"埋错 spec"进这条**真实**链路，
        // 才能验前端的逐条报错展示。ES module 里函数不挂全局，没法像以前那样
        // 直接 window.buildCopybookSpec = ...，所以留一个显式的、只在被测时非空的钩子。
        const spec = __copybookSpecOverride ? __copybookSpecOverride() : buildCopybookSpec();
        step = "stringify";
        const bodyText = JSON.stringify({ spec });
        step = "fetch";
        const { data } = await apiWithProgress("/api/copybook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: bodyText,
          timeoutMs: 180000,
          // 让按钮文字会动 —— 否则 15~25 秒的渲染看起来就是"卡死"
          onTick: (ms) => {
            btn.textContent = `渲染中… ${Math.round(ms / 1000)}s（6 页 A4 需十几秒）`;
          },
        });
        step = "responded";
        renderCopybookResult(data);
      } catch (e) {
        showResult({
          errText: `手册流程异常（步骤：${step}）\n\n${e && e.message ? e.message : e}\n\n` +
                   `如果是步骤 fetch 卡住，请看服务端日志是否有该请求。`,
        });
      }
      return;
    }

    // ---- 可选：先生成 AI 背景 ----
    let aiNote = "";
    if ($("#aiBg").checked) {
      btn.textContent = "生成 AI 背景中…（首次需加载 15 GB 权重）";
      const bg = await generateAiBackground();
      state.aiBgUrl = bg.url;
      aiNote = ` · AI 背景 ${(bg.elapsedMs / 1000).toFixed(0)}s`;
    } else {
      state.aiBgUrl = null;
    }

    const isCheckin = state.mode === "checkin" || state.cap === "checkin";

    // ---- 海报 / 打卡卡：先让大模型决定生成什么，再交给渲染器 ----
    let modelNote = "";
    if (state.brain?.ready) {
      const t0 = Date.now();
      try {
        btn.textContent = isCheckin ? "模型读图 + 写打卡文案…" : "模型读图 + 写文案…";
        const composed = await composeWithModel({
          mode: isCheckin ? "checkin" : "poster",
          onProgress: (ms) => {
            btn.textContent = `模型创作中… ${Math.round(ms / 1000)}s（读图 + 写文案）`;
          },
        });
        state.composeSpec = composed.spec;
        state.composeCopy = composed.copy;
        state.composeScenes = composed.scenes;
        const usedVision = (composed.scenes || []).length;
        modelNote =
          ` · 文案由 ${composed.model?.copy || "模型"} 生成` +
          (usedVision ? `（已读图 ${usedVision} 张）` : "") +
          (composed.mixed ? " · 照片主题不搭，已按混搭处理" : isCheckin ? "" : ` · 调性 ${toneFor(composed.copy?.tone).name}`) +
          ` · ${((Date.now() - t0) / 1000).toFixed(0)}s`;
        // 把模型决定的内容回填到界面，让用户看得见"它写了什么"
        renderComposeNote(composed);
        // 模型也可能写出禁词，写完就检一次（下面的出图前预检会再兜一道底）
        updateAdLawNote();
      } catch (e) {
        // 模型失败不阻断出图：说清楚原因，退回本地兜底
        state.composeSpec = null;
        modelNote = ` · ⚠ 模型未参与（${String(e.message).slice(0, 60)}），已用本地规则兜底`;
        renderComposeNote(null, e.message);
      }
    } else {
      // 用 brain 的实际状态说人话，别一律说"Ollama 未运行" ——
      // 也可能是模型没装、或在 brain.config.json 里被关掉了。
      const why = !state.brain
        ? "模型状态未知"
        : !state.brain.enabled
        ? "模型已在配置里关闭"
        : !state.brain.up
        ? "模型服务未连接"
        : "未配置文案模型";
      modelNote = ` · ⚠ 模型未参与（${why}），已用本地规则兜底`;
      // 必须显式覆盖面板：否则上一次模型的结果会留在屏幕上，
      // 让人以为这次也是模型写的（测试就是抓到这个才失败的）。
      renderComposeNote(null, why + "，本次文案由本地规则生成");
    }

    // ---- 出图 ----
    btn.textContent = "渲染中…";
    const spec = isCheckin ? buildCheckinSpec() : buildPosterSpec();

    // 出图前的本地预检：用和服务端同一套判断（含模型刚写出来的字）。
    // 服务端命中广告法禁用词会**直接拒绝**，与其等二三十秒再看到失败，
    // 不如在这里当场拦住并给出改写建议。
    const pre = checkAdLaw(specTexts(spec));
    if (pre.hard.length) {
      btn.textContent = "被广告法拦截，已停止";
      const fixed = fixAdLaw(specTexts(spec));
      showResult({
        errText:
          `未提交生成：文案里含广告法禁用词 ${pre.hard.map((w) => "「" + w + "」").join(" ")}\n\n` +
          `服务端校验会直接拒绝这类词，所以没有浪费一次渲染。\n` +
          `建议改成：\n${fixed.split("\n").map((l) => "  " + l).join("\n")}\n\n` +
          `点输入框上方的「一键改写」可以直接替换。`,
      });
      updateAdLawNote();
      return;
    }

    const { data } = await api("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec }),
    });

    if (data.ok) {
      const usedPhoto = isCheckin
        ? state.files.some((f) => f.uploaded && f.url)
        : (spec.layers || []).some((l) => l.type === "image");
      showResult({
        imgUrl: data.url + "?t=" + Date.now(),
        metaText:
          `已生成 · ${(data.bytes / 1024).toFixed(0)} KB` +
          (usedPhoto ? " · 使用上传照片" : isCheckin ? " · 未上传照片，使用占位图" : "") +
          modelNote + aiNote,
        extraHTML: `<div style="margin-top:10px"><a class="cta" style="display:inline-block;text-decoration:none;padding:10px 24px"
            href="${data.url}" download>下载图片</a></div>`,
      });
    } else {
      showResult({
        errText: `生成失败（阶段：${data.stage || "未知"}，退出码 ${data.code ?? "-"}）\n\n${data.message || "无详情"}`,
      });
    }
  } catch (e) {
    showResult({ errText: "失败：" + e.message });
  } finally {
    state.generating = false;
    btn.disabled = false;
    btn.textContent = label;
  }
}
$("#genBtn").onclick = doGenerate;

/* ---------------------------------------------------------------- 自检 */
async function health() {
  const box = $("#health");
  const { data } = await api("/api/health");
  const bad = !data.pythonOk || !data.forgeFound;
  box.innerHTML =
    `<b>${bad ? "⚠ 环境待检查" : "✓ 环境就绪"}</b><br>` +
    `Python ${data.pythonOk ? data.pythonDetail : "不可用"}<br>` +
    `渲染器 ${data.forgeFound ? "✓" : "✗"} · 手册 ${data.copybookFound ? "✓" : "✗"}<br>` +
    `本地出图 ${data.aigenReady ? "✓ SDXL-Turbo 就绪" : "— 不可用（AI 背景将退回渐变底）"}`;
  box.classList.add("show");
  setTimeout(() => box.classList.remove("show"), 10000);
}

/* ---------------------------------------------------------------- 启动 */
(async function init() {
  await loadTemplates();
  // 联网素材单独加载：它要打网络，失败也不能拖住页面其它部分
  loadFeed().catch((e) => console.warn("[feed] 加载失败:", e.message));
  const { data } = await api("/api/capabilities");
  state.capabilities = data.capabilities || [
    { id: "poster", name: "海报生成", desc: "提示词 + 图片 + 模板 → 宣传海报", icon: "poster" },
    { id: "template", name: "套用模板", desc: "从模板库挑一套，内容直接填好再改", icon: "template" },
    { id: "checkin", name: "打卡模板", desc: "对话 + 照片 → 可发布打卡卡", icon: "checkin" },
    { id: "copybook", name: "文案手册", desc: "一键生成多页互联网宣传手册", icon: "book" },
    { id: "batch", name: "批量出图", desc: "一套内容，多尺寸多平台分发", icon: "grid" },
  ];
  renderCapMenu();
  syncCapCard();
  renderCompChips();   // 版式关键词片：让用户能直接选构图
  health();

  // 深链：门户里的 AI 助手推荐模板时会带上 /?tpl=<id>。
  // 这里读到就直接切到「套用模板」并套上那一套 —— 从助手到出图少点两下。
  // 放在 loadTemplates() 之后，因为 applyTemplateById 要在 state.templates 里找它。
  try {
    const want = new URLSearchParams(location.search).get("tpl");
    if (want && (state.templates || []).some((t) => t.id === want)) {
      applyTemplateById(want);
      // 地址栏擦掉参数，免得刷新时又套一次把用户改好的内容冲掉
      history.replaceState(null, "", location.pathname);
    }
  } catch (e) {
    console.warn("[deeplink] 模板深链失败:", e.message);
  }
  // 模型状态单独探一次：决定"生成"按钮的说明文字，也决定 /api/compose 会不会被调用
  loadBrain();
})();

/** 探一次文案大脑状态（Ollama 在不在、模型有没有装） */
async function loadBrain() {
  try {
    const { data } = await api("/api/brain");
    state.brain = data;
    const btn = $("#genBtn");
    if (btn && data.ready) {
      btn.title = `文案由 ${data.copy} 生成，照片由 ${data.vision} 读图`;
    }
    const hint = $("#promptHint");
    if (hint && data.ready) {
      hint.dataset.brain = "ready";
      updatePromptHint();
    }
  } catch {
    state.brain = { ready: false, up: false };
  }
}

/* 顶栏已按需求移除，相关占位按钮的处理也一并删掉。
   如果以后加回顶栏，注意别用 alert() —— 无头浏览器里它会阻塞脚本。 */

/* 暴露只读状态给自动化测试（drive-test.mjs）。不影响业务逻辑。 */
window.posterforge = {
  get state() {
    return {
      mode: state.mode,
      cap: state.cap,
      tone: state.tone,
      files: state.files.map((f) => ({
        name: f.name, url: f.url, bytes: f.bytes, uploaded: !!f.uploaded,
      })),
      aiBgUrl: state.aiBgUrl,
      brainReady: !!state.brain?.ready,
      composeCopy: state.composeCopy,
      composeScenes: state.composeScenes,
    };
  },
  // 只读快照：测试要能在不改动页面的前提下看到"究竟会印什么字"。
  // 必须与"真的会出图的那份 spec"一致 —— 早先这里写死用 buildPosterSpec()，
  // 于是在打卡模式下也回报海报的图层，审计脚本读到的全是错的东西
  //（据此误报了一堆"打卡卡里有价格层"）。
  snapshot(spec) {
    const s = spec || (() => {
      const isCheckin = state.mode === "checkin" || state.cap === "checkin";
      return isCheckin ? buildCheckinSpec() : buildPosterSpec();
    })();
    const texts = [];
    const walk = (list) => (list || []).forEach((el) => {
      if (!el || typeof el !== "object") return;
      if (el.type === "text" && typeof el.text === "string") texts.push({ name: el.name, text: el.text });
      walk(el.layers);
      walk(el.children);
    });
    walk(s.layers);
    return {
      background: s.background,
      layout: s.layout,
      texts,
      images: (s.layers || []).filter((l) => l.type === "image").map((l) => l.src),
      fromModel: !!state.composeSpec,
    };
  },
  // 仅供自动化测试：模拟"模型不可用"，验证兜底路径还能出图
  __setBrainReady(v) {
    state.brain = { ...(state.brain || {}), ready: !!v };
  },
  // 仅供自动化测试：当前这次出图用的是哪种版式。
  // 用于穷尽核对"功能 ↔ 版式"是否对得上（海报 ≠ 打卡卡）。
  currentLayout() {
    const isCheckin = state.mode === "checkin" || state.cap === "checkin";
    const spec = isCheckin ? buildCheckinSpec() : buildPosterSpec();
    return spec.layout;
  },
  // 仅供自动化测试：直接切功能，等同于点左侧菜单（会带上 mode）
  __setCap(id) {
    state.cap = id;
    if (id === "checkin") setMode("checkin");
    else if (id === "poster") setMode("poster");
    invalidateCompose();   // 与点菜单按钮保持一致：换功能就让旧结果作废
    renderCapMenu();
    syncCapCard();
    return state.mode;
  },
  // 仅供自动化测试：app.js 现在是 ES module，函数不再挂在全局，
  // 测试需要这层显式出口才能验解析器和兜底构造（drive-chips.mjs 用到）。
  __debug: {
    parsePrompt,
    detectBrief,
    briefCopy,
    buildPosterSpec,
    buildCheckinSpec,
    localFallbackSpec,
    currentContent,
    checkAdLaw,
    fixAdLaw,
    // 套用模板：自动化测试要用，也方便在控制台里手查
    renderTplPicker,
    applyTemplateById,
    /** 当前模板列表（测试用；state.templates 不在对外快照里） */
    get templates() { return state.templates || []; },
    // 手册构造也要暴露：drive-copybook-error.mjs 靠它构造"埋错 spec"。
    // 早先漏了这一个，那条测试一直停在"无法打桩"，等于**没在验**手册的报错链路。
    buildCopybookSpec,
    /** 注入手册 spec 构造器；传 null 恢复。仅供自动化测试。 */
    setCopybookSpecOverride(fn) {
      __copybookSpecOverride = typeof fn === "function" ? fn : null;
      return true;
    },
  },
};
