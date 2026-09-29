#!/usr/bin/env node
/**
 * drive-test.mjs —— 用 CDP 真正"操作"页面，验证交互链路可用。
 *
 * 为什么需要它：静态截图只能证明"渲染出来了"，
 * 证明不了"点上传真的会上传"、"点生成真的会出图"。
 * 这里通过 CDP 在页面里构造 File 对象塞进 input，再点按钮，读回真实结果。
 *
 * 用法：node drive-test.mjs [baseUrl] [--with-ai-bg]
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const WITH_AI_BG = process.argv.includes("--with-ai-bg");
const OUT = path.join(__dirname, ".work");
const PROFILE = path.join(OUT, "drive-profile");
const PORT = 9222;

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) throw new Error("找不到 Edge");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("超时: " + method)); }
      }, 1800000);
    });
  }
  async evalJs(expr, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise,
    });
    if (r.exceptionDetails) {
      throw new Error("页面脚本异常: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
    }
    return r.result.value;
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await rm(PROFILE, { recursive: true, force: true });

  const proc = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    "--hide-scrollbars", "--window-size=1440,950", "about:blank",
  ], { windowsHide: true, stdio: "ignore" });

  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) {
    await sleep(400);
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
  }
  if (!ver) { proc.kill(); throw new Error("调试端口未就绪"); }
  console.log("浏览器:", ver["Browser"]);

  let target = null;
  for (let i = 0; i < 25 && !target; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => []);
    target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!target) await sleep(300);
  }
  if (!target) { proc.kill(); throw new Error("找不到页面 target"); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 950, deviceScaleFactor: 1, mobile: false,
  });

  // 收集页面 console 报错，任何 JS 错误都要暴露出来
  const pageErrors = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") {
      pageErrors.push(JSON.stringify(m.params?.exceptionDetails?.exception?.description || m.params).slice(0, 300));
    }
  });

  console.log("\n打开页面 ...");
  await cdp.send("Page.navigate", { url: BASE });
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const n = await cdp.evalJs("document.querySelectorAll('#tplGrid .card').length");
    if (n > 0) break;
  }
  const ready = await cdp.evalJs("document.querySelectorAll('#tplGrid .card').length");
  console.log(`  模板卡 ${ready} 个 → 页面就绪`);

  // ---------------------------------------------------------------- 测试 A：上传
  console.log("\n[A] 通过 UI 上传图片 ...");
  const imgB64 = (await readFile(path.join(__dirname, "..", "poster-forge", "assets", "sample-photo.png"))).toString("base64");

  // 在页面里把 base64 还原成 File 塞进 input，并派发 change 事件 —— 等价于用户选文件
  await cdp.evalJs(`(async () => {
    const b64 = ${JSON.stringify(imgB64)};
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], 'ui-test-photo.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('#fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

  // 等上传完成。
  // 注意：不要只读 chip 文案 —— renderFileList 更新 DOM 的瞬间可能读到
  // "⏳" 与 "已上传 0/1" 并存的中间态，导致竞态性假失败（真发生过，白查了一轮）。
  // 改为读 window.posterforge.state（应用状态，不是 DOM 中间态），
  // 并要求连续两次快照一致才判定，避开抖动。
  let up = null;
  let prev = "";
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const snap = await cdp.evalJs(`(() => {
      const s = window.posterforge && window.posterforge.state;
      const chips = Array.from(document.querySelectorAll('#fileList .chip')).map(c => c.textContent.trim());
      return JSON.stringify({
        chips,
        files: s ? s.files.map(f => ({ name: f.name, uploaded: !!f.uploaded, url: f.url || null })) : null
      });
    })()`);
    if (snap === prev) {
      up = JSON.parse(snap);
      if ((up.files || []).filter((f) => f.uploaded && f.url).length > 0) break;
    }
    prev = snap;
  }
  const upFiles = (up && up.files) || [];
  const uploadedCount = upFiles.filter((f) => f.uploaded && f.url).length;
  console.log("  状态快照:", JSON.stringify(upFiles));
  console.log("  文件区文案:", JSON.stringify((up && up.chips) || []));
  const uploadedOk = uploadedCount > 0;
  console.log(`  上传结果: ${uploadedOk ? "✓ 成功" : "✗ 失败"}（${uploadedCount} 个已上传）`);

  // ---------------------------------------------------------------- 测试 B：打卡卡
  // 顶部胶囊标签已移除，模式改由左侧功能菜单驱动，所以从 capMenu 里点。
  console.log("\n[B] 从左侧菜单切到「打卡模板」并生成（应使用刚上传的照片）...");
  const capSwitched = await cdp.evalJs(`(() => {
    const btn = Array.from(document.querySelectorAll('#capMenu button'))
      .find(b => b.textContent.includes('打卡'));
    if (!btn) return 'NOT_FOUND';
    btn.click();
    const st = window.posterforge && window.posterforge.state;
    return st ? (st.cap + '/' + st.mode) : 'NO_STATE';
  })()`);
  console.log("  切换后 cap/mode =", capSwitched);
  if (!String(capSwitched).startsWith("checkin")) {
    console.log("  ✗ 打卡模式切换失败，中止");
    process.exit(1);
  }
  await sleep(400);
  await cdp.evalJs(`document.querySelector('#genBtn').click(); true`);

  let resB = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    resB = JSON.parse(await cdp.evalJs(`(() => {
      const img = document.querySelector('#resultImg');
      return JSON.stringify({
        shown: document.querySelector('#result').classList.contains('show'),
        src: img.getAttribute('src') || '',
        meta: document.querySelector('#resultMeta').textContent,
        err: document.querySelector('#resultErr').style.display === 'block'
             ? document.querySelector('#resultErr').textContent.slice(0, 300) : ''
      });
    })()`));
    if (resB.err || (resB.shown && resB.src)) break;
  }
  console.log("  结果:", resB.err ? "✗ " + resB.err : "✓ " + resB.meta);
  if (resB.src) {
    const url = resB.src.startsWith("http") ? resB.src : BASE + resB.src;
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    await writeFile(path.join(OUT, "drive-checkin.png"), buf);
    console.log(`  已保存 drive-checkin.png（${(buf.length / 1024).toFixed(0)} KB）`);
  }

  // ---------------------------------------------------------------- 测试 C：手册
  console.log("\n[C] 切到文案手册并生成 PDF ...");
  const clicked = await cdp.evalJs(`(() => {
    const btn = Array.from(document.querySelectorAll('#capMenu button'))
      .find(b => b.textContent.includes('手册'));
    if (!btn) return 'NOT_FOUND';
    btn.click();
    const st = window.posterforge && window.posterforge.state;
    return st ? st.cap : 'NO_STATE';
  })()`);
  console.log("  点击后 state.cap =", clicked);
  if (clicked !== "copybook") {
    console.log("  ✗ 能力切换失败，中止手册测试");
    process.exit(1);
  }

  // 关键：清掉上一次的结果显示，避免读到残留的图片下载链接
  await cdp.evalJs(`(() => {
    document.querySelector('#resultExtra').innerHTML = '';
    document.querySelector('#resultImg').removeAttribute('src');
    document.querySelector('#resultMeta').textContent = '';
    document.querySelector('#resultErr').style.display = 'none';
    return true;
  })()`);

  const btnLabel = await cdp.evalJs("document.querySelector('#genBtn').textContent");
  console.log("  主按钮文案:", btnLabel);
  await cdp.evalJs(`document.querySelector('#genBtn').click(); true`);

  let resC = null;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    resC = JSON.parse(await cdp.evalJs(`(() => {
      const extra = document.querySelector('#resultExtra');
      // 手册的结果特征是「下载 PDF」链接，与图片下载区分开
      const pdfLink = Array.from(extra.querySelectorAll('a')).find(a => a.textContent.includes('PDF'));
      return JSON.stringify({
        meta: document.querySelector('#resultMeta').textContent,
        pdf: pdfLink ? pdfLink.getAttribute('href') : '',
        pageImgs: extra.querySelectorAll('img').length,
        err: document.querySelector('#resultErr').style.display === 'block'
             ? document.querySelector('#resultErr').textContent.slice(0, 400) : ''
      });
    })()`));
    if (resC.err || resC.pdf) break;
  }
  console.log("  结果:", resC.err ? "✗ " + resC.err : `✓ ${resC.meta} · 预览 ${resC.pageImgs} 页`);
  if (resC.pdf) {
    const url = resC.pdf.startsWith("http") ? resC.pdf : BASE + resC.pdf;
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    await writeFile(path.join(OUT, "drive-copybook.pdf"), buf);
    const isPdf = buf.subarray(0, 5).toString() === "%PDF-";
    console.log(`  已保存 drive-copybook.pdf（${(buf.length / 1024).toFixed(0)} KB, PDF 魔数=${isPdf}）`);
    if (!isPdf) console.log("  ✗ 下载到的不是 PDF！");
  }

  // ---------------------------------------------------------------- 测试 D（可选）：AI 背景
  if (WITH_AI_BG) {
    console.log("\n[D] 开启 AI 背景并生成（会真的跑 Qwen-Image-2.1，较慢）...");

    // 必须先切回「海报生成」，否则还在手册模式上，点的是手册按钮
    const capNow = await cdp.evalJs(`(() => {
      const btn = Array.from(document.querySelectorAll('#capMenu button'))
        .find(b => b.textContent.includes('海报'));
      if (!btn) return 'NOT_FOUND';
      btn.click();
      const st = window.posterforge && window.posterforge.state;
      return st ? st.cap : 'NO_STATE';
    })()`);
    console.log("  切换后 state.cap =", capNow);

    // 清空上一次（手册）的结果显示，否则会读到残留
    await cdp.evalJs(`(() => {
      document.querySelector('#resultExtra').innerHTML = '';
      document.querySelector('#resultImg').removeAttribute('src');
      document.querySelector('#resultMeta').textContent = '';
      document.querySelector('#resultErr').style.display = 'none';
      document.querySelector('#aiBg').checked = true;
      return true;
    })()`);
    await sleep(400);
    const labelNow = await cdp.evalJs("document.querySelector('#genBtn').textContent");
    console.log("  主按钮文案:", labelNow);

    await cdp.evalJs(`document.querySelector('#genBtn').click(); true`);

    let resD = null;
    for (let i = 0; i < 900; i++) {
      await sleep(1000);
      resD = JSON.parse(await cdp.evalJs(`(() => {
        const img = document.querySelector('#resultImg');
        return JSON.stringify({
          src: img.getAttribute('src') || '',
          meta: document.querySelector('#resultMeta').textContent,
          btn: document.querySelector('#genBtn').textContent,
          err: document.querySelector('#resultErr').style.display === 'block'
               ? document.querySelector('#resultErr').textContent.slice(0, 400) : ''
        });
      })()`));
      if (i % 30 === 0) console.log(`    ${i}s  ${resD.btn}`);
      // 只有「海报」的结果才带 AI 背景字样，用它判定真正完成
      if (resD.err || (resD.src && resD.meta.includes("AI 背景"))) break;
      if (resD.src && !resD.meta.includes("AI 背景") && i > 30) break;
    }
    console.log("  结果:", resD.err ? "✗ " + resD.err : "✓ " + resD.meta);
    if (resD.src) {
      const url = resD.src.startsWith("http") ? resD.src : BASE + resD.src;
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      await writeFile(path.join(OUT, "drive-ai-bg-poster.png"), buf);
      console.log(`  已保存 drive-ai-bg-poster.png（${(buf.length / 1024).toFixed(0)} KB）`);
    }
  } else {
    console.log("\n[D] 跳过 AI 背景测试（加 --with-ai-bg 启用，会真跑模型）");
  }

  // ---------------------------------------------------------------- 汇总
  console.log("\n" + "=".repeat(56));
  if (pageErrors.length) {
    console.log("⚠ 页面 JS 异常 " + pageErrors.length + " 条:");
    pageErrors.slice(0, 5).forEach((e) => console.log("   " + e));
  } else {
    console.log("✓ 无页面 JS 异常");
  }
  console.log("汇总: 上传 " + (uploadedOk ? "✓" : "✗") +
              " · 打卡卡 " + (resB.src ? "✓" : "✗") +
              " · 手册 " + (resC.pdf ? "✓" : "✗"));

  cdp.ws.close?.();
  proc.kill();
  // Edge 的子进程不一定随主进程退出，WebSocket 也可能吊住事件循环。
  // 测试已经跑完，显式退出，避免调用方一直等。
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => { console.error("测试失败:", e.message); process.exit(1); });
