#!/usr/bin/env node
/**
 * verify-hidden.mjs -- 验「[hidden] 必须真的隐藏」。
 *
 * 为什么单独写这条：drive-template.mjs 里我读的是 element.hidden **属性**，
 * 它返回 true 就判定通过 —— 但元素实际还在页面上显示。
 *
 * 两次踩坑，两次都是"量错了东西"：
 *   1. 读 el.hidden 属性 -> 属性 true，元素却还在显示
 *      （.tpl-picker 的 display:flex 盖掉了浏览器默认的 [hidden]{display:none}）
 *   2. 读元素自身的 computed display -> 父容器 display:none 时，
 *      子元素自身仍返回 flex，看着像"还显示着"，其实用户根本看不见
 *
 * 唯一可信的是 getClientRects()：返回空数组 = 真的没渲染。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8800";
const PROFILE = path.join(__dirname, ".work", "hidden-profile");
const PORT = 9280;
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, note = "") => {
  console.log(`  ${ok ? "[OK]" : "[X] "} ${name}${note ? "  " + note : ""}`);
  ok ? pass++ : fail++;
};

await rm(PROFILE, { recursive: true, force: true });
const proc = spawn(EDGE, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, "--window-size=1440,1200", "about:blank",
], { windowsHide: true, stdio: "ignore" });

let v = null;
for (let i = 0; i < 60 && !v; i++) {
  await sleep(400);
  try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
}
let t = null;
for (let i = 0; i < 25 && !t; i++) {
  const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => []);
  t = l.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
  if (!t) await sleep(300);
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = Math.floor(Math.random() * 1e9);
  const h = (e) => {
    const m = JSON.parse(e.data);
    if (m.id === id) {
      ws.removeEventListener("message", h);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  ws.addEventListener("message", h);
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("page error: " + (r.exceptionDetails.exception?.description || "?"));
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: BASE });
await sleep(4000);

const vis = (sel) => ev(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return 'MISSING';
  const rendered = el.getClientRects().length > 0;
  return (rendered ? 'VISIBLE' : 'HIDDEN') + ' hidden=' + el.hidden + ' self=' + getComputedStyle(el).display;
})()`);
const isHidden = (s) => String(s).startsWith("HIDDEN");
const clickCap = (name) => ev(`(() => {
  const b = Array.from(document.querySelectorAll('#capMenu button'))
    .find((x) => x.textContent.includes(${JSON.stringify(name)}));
  if (!b) return 'NO_BUTTON';
  b.click();
  return 'ok';
})()`);

console.log("[1] initial: picker must not be rendered");
check("#tplPicker hidden", isHidden(await vis("#tplPicker")), await vis("#tplPicker"));
check("#tplRotate hidden", isHidden(await vis("#tplRotate")), await vis("#tplRotate"));

console.log("\n[2] switch to template: picker must be visible");
console.log("   click ->", await clickCap("模板"));
await sleep(1200);
const on = await vis("#tplPicker");
check("#tplPicker visible", !isHidden(on), on);

console.log("\n[3] switch back to poster: picker must disappear (the reported bug)");
console.log("   click ->", await clickCap("海报"));
await sleep(1000);
const off = await vis("#tplPicker");
const offRot = await vis("#tplRotate");
check("#tplPicker hidden", isHidden(off), off);
check("#tplRotate hidden", isHidden(offRot), offRot);

console.log("\n[4] other capabilities must not show it either");
for (const name of ["打卡", "手册", "批量"]) {
  await clickCap(name);
  await sleep(700);
  const s = await vis("#tplPicker");
  check(`hidden on ${name}`, isHidden(s), s);
}

console.log("\n[5] full-page sweep: [hidden] elements that still render");
const bad = await ev(`(() => {
  const out = [];
  document.querySelectorAll('[hidden]').forEach((el) => {
    if (el.getClientRects().length > 0) out.push((el.id || el.className || el.tagName) + ' self=' + getComputedStyle(el).display);
  });
  return JSON.stringify(out);
})()`);
console.log("   ", bad);
check("no [hidden] element renders", JSON.parse(bad).length === 0);

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
ws.close?.();
proc.kill();
process.exit(fail === 0 ? 0 : 1);
