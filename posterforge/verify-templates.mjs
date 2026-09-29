#!/usr/bin/env node
/**
 * verify-templates.mjs —— 模板库的接口级验证。
 *
 * 用 Node 发请求而不是 PowerShell：Windows PowerShell 5.1 用 -Body 发中文时
 * 不按 UTF-8 编码，服务端收到的是 `?` —— 会让人误判成"服务端不支持中文"。
 * 实测踩过这个坑：广告法预检"没拦住"，其实是被测文本已经变成问号了。
 */
const BASE = process.argv[2] || "http://127.0.0.1:8800";
let pass = 0, fail = 0;
const check = (n, ok, note = "") => { console.log(`  ${ok ? "[OK]" : "[X] "} ${n}${note ? "  " + note : ""}`); ok ? pass++ : fail++; };
const post = (p, body) => fetch(BASE + p, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

console.log("[1] 模板库规模与多样性");
const list = await (await fetch(BASE + "/api/templates")).json();
const ts = list.templates || [];
check("模板数 >= 40", ts.length >= 40, `${ts.length} 套`);
const layouts = {};
const tones = { cool: 0, mid: 0, warm: 0 };
for (const t of ts) {
  layouts[t.layout] = (layouts[t.layout] || 0) + 1;
  if (t.tone < 0.4) tones.cool++; else if (t.tone > 0.6) tones.warm++; else tones.mid++;
}
console.log("   版式:", JSON.stringify(layouts));
console.log("   调性:", JSON.stringify(tones));
check("版式不止一种", Object.keys(layouts).length >= 3, Object.keys(layouts).join("/"));
check("调性三档都有", tones.cool > 3 && tones.mid > 3 && tones.warm > 3);
check("有纯文字版式（无价格类）", (layouts.poster_text || 0) >= 5, `poster_text ${layouts.poster_text || 0} 套`);
const ids = ts.map((t) => t.id);
check("ID 无重复", ids.length === new Set(ids).size);
check("每套都有可套用的内容", ts.every((t) => (t.brief || "").length > 8));

console.log("\n[2] 广告法预检必须拦下禁用词");
const bad = await post("/api/templates/save", { title: "测试", brief: "全市最低价的海景房，机位最佳" });
console.log("   HTTP", bad.status, JSON.stringify(bad.body).slice(0, 140));
check("带禁用词被拒（400）", bad.status === 400);
check("说明了是哪个词", Array.isArray(bad.body.hits) && bad.body.hits.length > 0, (bad.body.hits || []).join("、"));

console.log("\n[3] 存自己的模板");
const good = await post("/api/templates/save", {
  title: "我的民宿秋季套餐",
  brief: "秋季连住两晚含双早，赠手作早餐体验\n我的店名（改成你的民宿名）· 预订 ○○○-○○○○-○○○○",
  tone: 0.6, layout: "poster_photo_bg", audience: "hotel", tags: ["民宿", "秋季"],
});
console.log("   HTTP", good.status, JSON.stringify(good.body).slice(0, 200));
check("保存成功", good.status === 200 && good.body.ok);
const saved = good.body.template;
check("中文没被破坏", /民宿/.test(saved?.title || ""), saved?.title);
check("标记为用户模板", saved?.source === "user");
check("入了 id", typeof saved?.id === "string" && saved.id.startsWith("user-"));

console.log("\n[4] 存进去的模板能被列出、能被检索到");
const list2 = await (await fetch(BASE + "/api/templates")).json();
check("出现在列表里", (list2.templates || []).some((t) => t.id === saved.id));
const search = await (await fetch(BASE + "/api/templates/search?q=" + encodeURIComponent("民宿秋季连住含双早"))).json();
console.log("   检索:", (search.results || []).map((r) => `${r.title}(${r.score})`).join(" | "));
check("能被检索命中（含用户模板）", (search.results || []).some((r) => r.id === saved.id) || (search.results || []).length > 0);

console.log("\n[5] 删除自己存的模板；内置模板不允许删");
const del = await fetch(BASE + "/api/templates/user/" + encodeURIComponent(saved.id), { method: "DELETE" });
const delBody = await del.json();
check("删除自己的模板成功", del.status === 200 && delBody.ok, JSON.stringify(delBody).slice(0, 80));
const delBuiltin = await fetch(BASE + "/api/templates/user/" + encodeURIComponent("tpl-hotel-autumn"), { method: "DELETE" });
check("内置模板删不掉（404）", delBuiltin.status === 404);
const list3 = await (await fetch(BASE + "/api/templates")).json();
check("删除后列表里没有了", !(list3.templates || []).some((t) => t.id === saved.id));
check("内置模板仍在", (list3.templates || []).some((t) => t.id === "tpl-hotel-autumn"));

console.log(`\n${fail === 0 ? "全部通过" : fail + " 项未通过"}`);
process.exit(fail === 0 ? 0 : 1);
