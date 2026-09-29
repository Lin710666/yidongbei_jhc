#!/usr/bin/env node
/**
 * verify-composition-e2e.mjs -- 构图从前端一路走到 spec 的端到端验证
 *
 * 为什么要单独验：单元层面「模板带 composition」「构函数认 composition」都通过了，
 * 但中间还隔着 /api/compose 这一层 —— 少一个字段的转发，整条就断，
 * 而单元测试照样全绿（这正是上一轮 41 套模板共用一套骨架却没被发现的原因）。
 */
const BASE = process.argv[2] || "http://127.0.0.1:8800";
let pass = 0, fail = 0;
const check = (n, ok, note = "") => { console.log(`  ${ok ? "[OK]" : "[X] "} ${n}${note ? "  " + note : ""}`); ok ? pass++ : fail++; };

const { buildPosterSpecFrom } = await import("file:///E:/deepseck/site/public/poster-layout.mjs");

// 取一套 split 构图的模板（餐厅午市套餐），把它整条走一遍
const tj = await (await fetch(BASE + "/api/templates")).json();
const tpl = (tj.templates || []).find((t) => t.composition === "split") || tj.templates[0];
console.log(`用模板: ${tpl.id} (${tpl.composition})  ${tpl.title}`);

console.log("\n[1] 不带 composition 时走回退路径");
const a = await (await fetch(BASE + "/api/compose", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ brief: tpl.brief, photos: [], facts: {}, mode: "poster", render: false }),
})).json();
if (!a.ok) { check("compose 成功", false, a.message); process.exit(1); }
const titleA = a.spec.layers.find((l) => l.name === "title");
console.log("   标题层:", JSON.stringify({ y: titleA.y, align: titleA.align || "left", max: titleA.fit.maxSize }));
check("回退到默认构图（左对齐，标题靠上）", (titleA.align || "left") === "left" && titleA.y < 0.3);

console.log("\n[2] 带上模板的 composition");
const b = await (await fetch(BASE + "/api/compose", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ brief: tpl.brief, photos: [], facts: {}, mode: "poster", render: false,
                         composition: tpl.composition }),
})).json();
if (!b.ok) { check("compose 成功", false, b.message); process.exit(1); }
const titleB = b.spec.layers.find((l) => l.name === "title");
const bandB = b.spec.layers.find((l) => l.name === "bandPhoto");
console.log("   标题层:", JSON.stringify({ y: titleB.y, align: titleB.align || "left", max: titleB.fit.maxSize }));
console.log("   图带层:", bandB ? JSON.stringify(bandB.box) : "无");
check("标题位置与回退路径不同", titleB.y !== titleA.y, `${titleA.y} → ${titleB.y}`);
check("split 构图确实更低", titleB.y > 0.45, String(titleB.y));
check("少了自动底图（图带构图不该再挂满版底图）", b.spec.background.type === "gradient", b.spec.background.type);

console.log("\n[3] 非法构图名要被挡掉");
const c = await (await fetch(BASE + "/api/compose", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ brief: tpl.brief, photos: [], facts: {}, mode: "poster", render: false,
                         composition: "../../etc/passwd" }),
})).json();
check("野值被忽略并回退", c.ok && c.spec.layers.find((l) => l.name === "title").y === titleA.y);

console.log(`\n${fail === 0 ? "全部通过" : fail + " 项未通过"}`);
process.exit(fail === 0 ? 0 : 1);
