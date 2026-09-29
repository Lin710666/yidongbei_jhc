#!/usr/bin/env node
/**
 * drive-template.mjs —— 验「套用模板」独立入口。
 *
 * 验的不是"代码看起来对"，而是真的点一遍：
 *   1. 功能菜单里有「套用模板」
 *   2. 点它 → 出现选择器、生成控件收起
 *   3. 搜索与受众筛选真的过滤
 *   4. 点一套模板 → 内容填进输入框、切回海报模式、采纳被记录
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8800";
const OUT = path.join(__dirname, ".work");
const PROFILE = path.join(OUT, "tpltest-profile");
const PORT = 9270;
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, note = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${note ? "  " + note : ""}`);
  ok ? pass++ : fail++;
};

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errs = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method === "Runtime.exceptionThrown") {
        this.errs.push(m.params.exceptionDetails.exception?.description || "?");
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("超时 " + method)); } }, 60000);
    });
  }
  async ev(expr, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description || "?"));
    return r.result.value;
  }
}

await mkdir(OUT, { recursive: true });
await rm(PROFILE, { recursive: true, force: true });
const proc = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--hide-scrollbars", "--window-size=1440,1200", "about:blank",
], { windowsHide: true, stdio: "ignore" });

let ver = null;
for (let i = 0; i < 60 && !ver; i++) {
  await sleep(400);
  try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
}
let target = null;
for (let i = 0; i < 25 && !target; i++) {
  const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => []);
  target = l.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!target) await sleep(300);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
const cdp = new CDP(ws);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Network.enable");
await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
await cdp.send("Page.navigate", { url: BASE });
await sleep(4000);

console.log("[1] 功能菜单里有「套用模板」");
const caps = await cdp.ev(`JSON.stringify(Array.from(document.querySelectorAll('#capMenu button')).map(b => b.textContent.trim()))`);
console.log("  菜单:", caps);
check("菜单含「套用模板」", caps.includes("▤ 套用模板") || caps.includes("套用模板"));

console.log("\n[2] 点它 → 选择器出现、生成控件收起");
await cdp.ev(`(() => {
  const b = Array.from(document.querySelectorAll('#capMenu button')).find(x => x.textContent.includes('套用模板'));
  b.click(); return true;
})()`);
await sleep(900);
const state1 = JSON.parse(await cdp.ev(`JSON.stringify({
  pickerShown: !document.querySelector('#tplPicker').hidden,
  items: document.querySelectorAll('#tplList .tpl-item').length,
  filters: document.querySelectorAll('#tplFilters .mini-chip').length,
  count: (document.querySelector('#tplCount')||{}).textContent,
  promptHidden: document.querySelector('#promptWrap').style.display === 'none',
  dropHidden: document.querySelector('#drop').style.display === 'none',
  genBtnHidden: document.querySelector('#genBtn').style.display === 'none',
  capName: document.querySelector('#capName').textContent,
})`));
console.log("  ", JSON.stringify(state1, null, 0));
check("选择器已显示", state1.pickerShown);
check("列出了模板", state1.items > 0, `${state1.items} 套`);
check("有受众筛选", state1.filters >= 4, `${state1.filters} 个`);
check("输入框已收起", state1.promptHidden);
check("上传区已收起", state1.dropHidden);
check("生成按钮已收起", state1.genBtnHidden);
check("标题是「套用模板」", state1.capName === "套用模板");

console.log("\n[3] 搜索真的过滤");
await cdp.ev(`(() => {
  const i = document.querySelector('#tplSearch');
  i.value = '夜市';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(500);
const searched = JSON.parse(await cdp.ev(`JSON.stringify({
  items: Array.from(document.querySelectorAll('#tplList .tpl-item b')).map(b => b.textContent),
  count: document.querySelector('#tplCount').textContent,
})`));
console.log("  结果:", JSON.stringify(searched));
check("搜索命中夜市模板", searched.items.length >= 1 && searched.items.join("").includes("夜市"), searched.count);

await cdp.ev(`(() => {
  const i = document.querySelector('#tplSearch');
  i.value = '不存在的关键词xyz';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(400);
check("无结果时有空态提示", await cdp.ev(`!!document.querySelector('#tplList .tpl-empty')`));

console.log("\n[4] 受众筛选真的过滤");
await cdp.ev(`(() => {
  const i = document.querySelector('#tplSearch');
  i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
  const f = Array.from(document.querySelectorAll('#tplFilters .mini-chip')).find(x => x.dataset.aud === 'restaurant');
  f.click(); return true;
})()`);
await sleep(500);
// 断言要**语义化**，不能写死数量 ——
// 原先写的是 filtered.length === 2，那是模板库只有 8 套时的数字；
// 库扩到 41 套后这条就假失败了（筛选其实是对的）。
// 正确的断言：筛出来的每一条，受众都必须是餐饮。
const filtered = JSON.parse(await cdp.ev(`(() => {
  const ids = Array.from(document.querySelectorAll('#tplList .tpl-item')).map(x => x.dataset.id);
  const all = window.posterforge.__debug.templates || [];
  const byId = Object.fromEntries(all.map(t => [t.id, t.audience]));
  return JSON.stringify({ ids, audiences: ids.map(id => byId[id]) });
})()`));
console.log("  餐饮筛选结果:", filtered.ids.length, "套 →", JSON.stringify(filtered.ids));
const allRestaurant = filtered.audiences.length > 0 && filtered.audiences.every((a) => a === "restaurant");
check("筛出来的全是餐饮模板", allRestaurant, `受众: ${JSON.stringify([...new Set(filtered.audiences)])}`);
check("餐饮模板不止一套（库已扩容）", filtered.ids.length >= 5, `${filtered.ids.length} 套`);

console.log("\n[5] 点一套 → 内容填进输入框 + 切回海报模式 + 采纳被记录");
await cdp.ev(`(() => {
  const f = Array.from(document.querySelectorAll('#tplFilters .mini-chip')).find(x => x.dataset.aud === 'all');
  f.click(); return true;
})()`);
await sleep(400);
const target1 = await cdp.ev(`document.querySelector('#tplList .tpl-item').dataset.id`);
const pickedBefore = await (await fetch(BASE + "/api/templates")).json()
  .then((j) => (j.templates.find((t) => t.id === target1) || {}).picked || 0);

await cdp.ev(`(() => {
  document.querySelector('#tplList .tpl-item').click(); return true;
})()`);
await sleep(1200);

const after = JSON.parse(await cdp.ev(`JSON.stringify({
  cap: window.posterforge.state.cap,
  capName: document.querySelector('#capName').textContent,
  prompt: document.querySelector('#promptInput').value,
  pickerHidden: document.querySelector('#tplPicker').hidden,
  promptShown: document.querySelector('#promptWrap').style.display !== 'none',
  tone: window.posterforge.state.tone,
})`));
console.log("  套用后:", JSON.stringify(after).slice(0, 240));
check("已切回海报生成", after.cap === "poster" && after.capName === "海报生成");
check("输入框被填上模板内容", after.prompt.length > 10, `${after.prompt.length} 字`);
check("填入的是占位内容而非编造数字", /○○/.test(after.prompt));
check("选择器已收起", after.pickerHidden);
check("输入框重新出现", after.promptShown);

await sleep(900);
const pickedAfter = await (await fetch(BASE + "/api/templates")).json()
  .then((j) => (j.templates.find((t) => t.id === target1) || {}).picked || 0);
check("采纳次数被记录", pickedAfter === pickedBefore + 1, `${pickedBefore} → ${pickedAfter}（模板 ${target1}）`);

console.log("\n[6] 无 JS 异常");
check("没有未捕获异常", cdp.errs.length === 0, cdp.errs.slice(0, 2).join(" | "));

const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
await writeFile(path.join(OUT, "tpl-picker.png"), Buffer.from(shot.data, "base64"));
console.log("\n截图 → .work/tpl-picker.png");

console.log(`\n${fail === 0 ? "全部通过 ✓" : fail + " 项未通过 ✗"}`);
ws.close?.();
proc.kill();
process.exit(fail === 0 ? 0 : 1);
