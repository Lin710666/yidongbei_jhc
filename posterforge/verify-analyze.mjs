#!/usr/bin/env node
/**
 * verify-analyze.mjs -- 图片分析功能端到端验证
 *
 * 为什么必须真跑一遍：这个功能全靠模型"看图说话"，
 * 语法通过、接口存在，都不代表模型真能从图里判断出版式。
 */
const BASE = process.argv[2] || "http://127.0.0.1:8800";
let pass = 0, fail = 0;
const check = (n, ok, note = "") => { console.log(`  ${ok ? "[OK]" : "[X] "} ${n}${note ? "  " + note : ""}`); ok ? pass++ : fail++; };

// 造一张测试图：横向宽幅的"风景"（左绿右蓝 + 一条地平线），
// 这种横构图理论上更接近 fullbleed 而不是 splitv
const { spawn } = await import("node:child_process");
const py = "E:\\ComfyUI_windows_portable\\python_embeded\\python.exe";
const imgPath = "E:\\deepseck\\site\\.work\\_anatest.jpg";
const gen = spawn(py, ["-c", `
from PIL import Image, ImageDraw
im = Image.new("RGB", (1600, 900), "#2b6cb0")
d = ImageDraw.Draw(im)
d.rectangle([0, 0, 1600, 520], fill="#7fb069")     # 上半绿色山丘
d.ellipse([300, 120, 900, 420], fill="#c8d96f")    # 一个亮色主体
im.save(r"${imgPath}", "JPEG", quality=90)
print("ok")
`], { stdio: ["ignore", "pipe", "pipe"] });
await new Promise((r) => gen.on("exit", r));
console.log("  测试图已生成");

const fs = await import("node:fs");
const b64 = "data:image/jpeg;base64," + fs.readFileSync(imgPath).toString("base64");
console.log(`  图大小 ${(b64.length / 1024).toFixed(0)} KB（dataURL）`);

console.log("\n[1] 上传（走普通上传接口，但前端不会把它放进 state.files）");
const up = await (await fetch(BASE + "/api/upload", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ files: [{ name: "_anatest.jpg", data: b64 }] }),
})).json();
const sf = (up.files || [])[0];
check("上传成功", !!sf && !!sf.url, sf ? sf.url : JSON.stringify(up).slice(0, 120));
if (!sf) { console.log("\n上传失败，后续跳过"); process.exit(1); }

console.log("\n[2] 分析版式（要读图，10~40 秒）");
const t0 = Date.now();
let r;
try {
  r = await (await fetch(BASE + "/api/analyze-layout", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ photo: sf.url }),
    signal: AbortSignal.timeout(300000),
  })).json();
} catch (e) { r = { ok: false, message: e.message }; }
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`   耗时 ${secs}s  →`, JSON.stringify(r).slice(0, 260));

check("接口返回 ok", r.ok === true, r.message || "");
if (r.ok) {
  const KEYS = ["fullbleed", "axial", "split", "splitv", "focal", "grid", "typeled"];
  check("给出的构图在合法集合里", KEYS.includes(r.composition), r.composition);
  check("给了判断理由", typeof r.reason === "string" && r.reason.length > 2, r.reason);
  check("理由里没有明显胡话（长度合理）", (r.reason || "").length <= 80, `${(r.reason || "").length} 字`);
}

console.log("\n[3] 错误的输入要被挡住");
for (const [name, body] of [
  ["空 body", {}],
  ["不存在的图", { photo: "/uploads/__nope__.jpg" }],
]) {
  const rr = await fetch(BASE + "/api/analyze-layout", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  check(`${name} → ${rr.status}`, rr.status >= 400, `HTTP ${rr.status}`);
}

console.log("\n[4] 分析入口与普通上传是分开的");
const caps = await (await fetch(BASE + "/api/capabilities")).json();
const names = (caps.capabilities || []).map((c) => c.name);
check("菜单里有「图片分析」", names.includes("图片分析"), names.join(" / "));
check("「图片分析」和「海报生成」是两个入口", names.indexOf("图片分析") !== names.indexOf("海报生成"));

console.log(`\n${fail === 0 ? "全部通过" : fail + " 项未通过"}`);
process.exit(fail === 0 ? 0 : 1);
