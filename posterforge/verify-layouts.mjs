#!/usr/bin/env node
/**
 * verify-layouts.mjs -- 版面差异验收
 *
 * 为什么必须有这个文件：上一轮我把 8 套模板扩到 41 套，就宣称"多样性做好了"。
 * 实际上 41 套渲染出来的版面骨架**完全一样** —— 同一组字段名、同一个对齐、
 * 同一个阅读顺序，只是文字和背景不同。用户一眼就看穿了。
 *
 * 所以把"版面必须真的有差异"变成机器可查的断言：
 *   ① 41 套模板不能只有一种版面签名（这是上一轮的实际状态）
 *   ② 不同构图之间，签名必须有实质差异（对齐 / 标题位置 / 标题占比 / 图文关系）
 *   ③ 同构图内的模板签名必须一致（否则说明映射是随机的）
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8800";
let pass = 0, fail = 0;
const check = (n, ok, note = "") => { console.log(`  ${ok ? "[OK]" : "[X] "} ${n}${note ? "  " + note : ""}`); ok ? pass++ : fail++; };

const m = await import("file:///" + path.join(__dirname, "public", "poster-layout.mjs").replace(/\\/g, "/"));

/** 从 spec 里抽出版面指纹 —— 只看"结构"，不看文字 */
function signature(spec) {
  const L = spec.layers;
  const title = L.find((l) => l.name === "title") || {};
  const rule = L.find((l) => l.name === "titleRule") || {};
  const band = L.find((l) => l.name === "bandPhoto");
  const side = L.find((l) => l.name === "sidePhoto");
  const card = L.find((l) => l.name === "cardPhoto");
  const imgMode = card ? "card" : side ? "side" : band ? "band"
    : spec.background.type === "image" ? "full" : "none";
  return [
    "align=" + (title.align || "left"),
    "titleY=" + Number(title.y).toFixed(3),
    "titleMax=" + (title.fit ? title.fit.maxSize : "?"),
    "titleH=" + (title.fit ? Number(title.fit.maxHeight).toFixed(3) : "?"),
    "titleW=" + (title.fit ? Number(title.fit.maxWidth).toFixed(2) : "?"),
    "ruleX=" + Number(rule.box ? rule.box.box[0] : -1).toFixed(3),
    "img=" + imgMode,
  ].join("|");
}

// ---------------------------------------------------------------- 取模板
const tj = await (await fetch(BASE + "/api/templates")).json();
const tpls = (tj.templates || []).filter((t) => t.source !== "user");
console.log(`模板 ${tpls.length} 套`);

const content = {
  brand: "○○（填你的店名）", title: "夜市开街",
  sub: "○○ 家小吃 + 非遗手作 + 江景灯光秀\n每晚 18:00-24:00，连开 ○○ 天",
  price: "○○○ 元起", phone: "", address: "",
};

// 统一给一张照片，这样「有没有图带」的差异才看得出来
const withPhoto = { layout: "poster_photo_bg", photoUrls: ["uploads/x.jpg"], tone: "warm" };

console.log("\n[1] 每套模板的版面指纹");
const sigs = new Map();
const byComp = new Map();
for (const t of tpls) {
  const spec = m.buildPosterSpecFrom(content, {
    ...withPhoto, composition: t.composition,
    variant: Math.max(0, ["a", "b", "c"].indexOf(String(t.variant || "a"))),
    tuning: t.tuning || null,
  });
  const sig = signature(spec);
  sigs.set(t.id, sig);
  if (!byComp.has(t.composition)) byComp.set(t.composition, new Set());
  byComp.get(t.composition).add(sig);
}

const uniqueSigs = new Set(sigs.values());
console.log(`  共 ${uniqueSigs.size} 种版面签名 / ${tpls.length} 套模板`);
for (const [comp, set] of [...byComp].sort()) {
  const first = [...sigs].find(([, s]) => set.has(s));
  console.log(`   ${String(comp).padEnd(10)} ${set.size} 种  ${String(first ? first[1] : "").slice(0, 74)}`);
}

console.log("\n[2] 不能只有一种版面（上一轮的实际状态）");
check("模板间存在多种版面签名", uniqueSigs.size >= 8, `${uniqueSigs.size} 种`);
// 有变体之后，签名数必然**多于**构图数（每个构图至少 2 个变体）。
// 原先断言的是两者相等 —— 那是没有变体时的标准。
check("签名数多于构图数（变体在起作用）", uniqueSigs.size > byComp.size,
  `构图 ${byComp.size} 个 → 签名 ${uniqueSigs.size} 种`);
check("每套模板的版面签名都唯一（用户定的验收标准）",
  uniqueSigs.size === tpls.length,
  `${uniqueSigs.size}/${tpls.length}`);
console.log("\n[3] 同一构图内部也要有差异（变体机制）");
for (const [comp, set] of [...byComp].sort()) {
  const list = tpls.filter((t) => t.composition === comp);
  // 原先这里断言的是"必须一致"—— 那是只有构图、没有变体时的标准。
  // 用户要的是"任意两套模板的版面几何必须有实质差异"，
  // 所以现在反过来：同构图内也必须有多种签名。
  const need = Math.min(2, list.length);
  check(`${String(comp).padEnd(10)} ${list.length} 套 → ${set.size} 种签名`, set.size >= need,
    set.size >= need ? "" : `至少要 ${need} 种`);
}

console.log("\n[4] 关键结构差异必须真实存在");
// 结构差异要比**构图基线**（不带变体精调），不能比某一套模板 ——
// 每套都被 tuning 调过之后，"第一套"的字号不再代表这个构图。
const parse = (s) => Object.fromEntries(s.split("|").map((kv) => kv.split("=")));
const baseSig = (comp) => signature(m.buildPosterSpecFrom(content, {
  ...withPhoto, composition: comp, variant: 0, tuning: null,
}));
const pick = (comp) => (m.POSTER_COMPOSITIONS[comp] ? parse(baseSig(comp)) : null);
const fb = pick("fullbleed"), ax = pick("axial"), sp = pick("split"), ty = pick("typeled"), sv = pick("splitv");

check("对齐方式不同（fullbleed 左 / axial 居中）", fb.align !== ax.align, `${fb.align} vs ${ax.align}`);
check("标题纵向位置不同（split 明显更低）", Number(sp.titleY) > Number(fb.titleY) + 0.15,
  `split ${sp.titleY} vs fullbleed ${fb.titleY}`);
check("标题字号不同（typeled 最大）", Number(ty.titleMax) > Number(fb.titleMax), `${ty.titleMax} vs ${fb.titleMax}`);
check("标题占比不同（typeled 最大）", Number(ty.titleH) > Number(fb.titleH), `${ty.titleH} vs ${fb.titleH}`);
check("图文关系不同（split 是上带）", sp.img === "band" && fb.img === "full", `split=${sp.img} fullbleed=${fb.img}`);
check("图文关系不同（typeled 无图）", ty.img === "none", `typeled=${ty.img}`);
check("分隔线位置随对齐变化", fb.ruleX !== ax.ruleX, `${fb.ruleX} vs ${ax.ruleX}`);
if (sv) {
  check("左右分割真的把图放到侧边", sv.img === "side", `splitv=${sv.img}`);
  check("左右分割与上下分割是两种结构", sv.img !== sp.img && sv.titleY !== sp.titleY,
    `split=${sp.img}@${sp.titleY}  splitv=${sv.img}@${sv.titleY}`);
}
const fo = pick("focal");
if (fo) {
  check("重心环绕的图是卡片（不是底也不是块）", fo.img === "card", `focal=${fo.img}`);
  check("重心环绕的标题在图下方（阅读顺序相反）",
    Number(fo.titleY) > Number(fb.titleY) + 0.2, `focal ${fo.titleY} vs fullbleed ${fb.titleY}`);
}

console.log("\n[5] 空构图回退不能崩");
try {
  const s = m.buildPosterSpecFrom(content, { ...withPhoto, composition: null });
  check("composition 为 null 时正常回退", s.layers.some((l) => l.name === "title"));
  const bad = m.buildPosterSpecFrom(content, { ...withPhoto, composition: "不存在的构图" });
  check("非法构图名也正常回退", bad.layers.some((l) => l.name === "title"));
} catch (e) {
  check("回退路径", false, e.message);
}

console.log(`\n${fail === 0 ? "全部通过" : fail + " 项未通过"}`);
process.exit(fail === 0 ? 0 : 1);
