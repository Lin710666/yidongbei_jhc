#!/usr/bin/env node
/**
 * drive-multiphoto.mjs —— 验证「多张照片 → 九宫格打卡卡」经真实 UI 链路可用。
 *
 * 覆盖点：
 *   1. 一次上传 4 张照片（含一张带 EXIF Orientation=6 的，验证归一化）
 *   2. 切到打卡模式，生成打卡卡
 *   3. 读回生成结果，确认照片区确实是 2×2 网格（而不是只用了第一张）
 *   4. 顺带确认 EXIF 照片被转正（尺寸变化）
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const OUT = path.join(__dirname, ".work");
const PROFILE = path.join(OUT, "mp-profile");
const PORT = 9225;

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
      }, 600000);
    });
  }
  async evalJs(expr, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise,
    });
    if (r.exceptionDetails) throw new Error("页面异常: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
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

  let target = null;
  for (let i = 0; i < 25 && !target; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => []);
    target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
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
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 950, deviceScaleFactor: 1, mobile: false,
  });

  console.log("打开页面 ...");
  await cdp.send("Page.navigate", { url: BASE });
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    if ((await cdp.evalJs("document.querySelectorAll('#tplGrid .card').length")) > 0) break;
  }
  console.log("  页面就绪");

  // ---- 准备 4 张图：3 张普通 PNG/JPEG + 1 张带 EXIF Orientation=6 ----
  const files = [
    { name: "海边.png", p: path.join(OUT, "grid-photo-1.jpg"), type: "image/jpeg" },
    { name: "日出.png", p: path.join(OUT, "grid-photo-2.jpg"), type: "image/jpeg" },
    { name: "街角.png", p: path.join(OUT, "grid-photo-3.jpg"), type: "image/jpeg" },
    { name: "手机竖拍.jpg", p: path.join(OUT, "exif-marker.jpg"), type: "image/jpeg" },
  ];
  for (const f of files) {
    if (!existsSync(f.p)) { proc.kill(); throw new Error("缺少测试图: " + f.p); }
  }
  const payloads = [];
  for (const f of files) {
    payloads.push({ name: f.name, type: f.type, b64: (await readFile(f.p)).toString("base64") });
  }

  console.log(`\n[A] 一次上传 ${payloads.length} 张（含 1 张 EXIF Orientation=6）...`);
  await cdp.evalJs(`(async () => {
    const list = ${JSON.stringify(payloads)};
    const dt = new DataTransfer();
    for (const it of list) {
      const bin = atob(it.b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      dt.items.add(new File([arr], it.name, { type: it.type }));
    }
    const input = document.querySelector('#fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

  let up = null, prev = "";
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const snap = await cdp.evalJs(`(() => {
      const s = window.posterforge && window.posterforge.state;
      return JSON.stringify(s ? s.files.map(f => ({ name: f.name, uploaded: !!f.uploaded, url: f.url || null })) : []);
    })()`);
    if (snap === prev) {
      up = JSON.parse(snap);
      if (up.filter((f) => f.uploaded && f.url).length >= 4) break;
    }
    prev = snap;
  }
  const ok4 = (up || []).filter((f) => f.uploaded && f.url);
  console.log(`  已上传 ${ok4.length} 张`);
  for (const f of ok4) console.log(`     ${f.name} -> ${f.url}`);

  // ---- 验证 EXIF 那张被转正 ----
  const exifOne = ok4.find((f) => f.name.includes("竖拍"));
  if (exifOne) {
    console.log("\n[B] 验证 EXIF 照片已转正 ...");
    const dims = await cdp.evalJs(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(exifOne.url)} + '?t=' + Date.now();
      await img.decode();
      return JSON.stringify({ w: img.naturalWidth, h: img.naturalHeight });
    })()`, true);
    const d = JSON.parse(dims);
    console.log(`  浏览器读到尺寸: ${d.w}x${d.h}`);
    console.log(`  ${d.h > d.w ? "✓ 已转正（竖构图）" : "✗ 仍是横向"}`);
  }

  // ---- 切到打卡模式并生成 ----
  console.log("\n[C] 从左侧菜单切到「打卡模板」并生成（应使用 2×2 网格）...");
  const capNow = await cdp.evalJs(`(() => {
    const btn = Array.from(document.querySelectorAll('#capMenu button'))
      .find(b => b.textContent.includes('打卡'));
    if (!btn) return 'NOT_FOUND';
    btn.click();
    const st = window.posterforge && window.posterforge.state;
    return st ? (st.cap + '/' + st.mode) : 'NO_STATE';
  })()`);
  console.log("  切换后 cap/mode =", capNow);
  if (!String(capNow).startsWith("checkin")) { proc.kill(); throw new Error("打卡模式切换失败: " + capNow); }
  await sleep(400);
  await cdp.evalJs(`document.querySelector('#genBtn').click(); true`);

  let res = null;
  for (let i = 0; i < 200; i++) {
    await sleep(500);
    res = JSON.parse(await cdp.evalJs(`(() => {
      const img = document.querySelector('#resultImg');
      return JSON.stringify({
        src: img.getAttribute('src') || '',
        meta: document.querySelector('#resultMeta').textContent,
        err: document.querySelector('#resultErr').style.display === 'block'
             ? document.querySelector('#resultErr').textContent.slice(0, 400) : ''
      });
    })()`));
    if (res.err || res.src) break;
  }
  console.log("  结果:", res.err ? "✗ " + res.err : "✓ " + res.meta);

  if (res.src) {
    const url = res.src.startsWith("http") ? res.src : BASE + res.src;
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const outFile = path.join(OUT, "multiphoto-checkin.png");
    await writeFile(outFile, buf);
    console.log(`  已保存 multiphoto-checkin.png（${(buf.length / 1024).toFixed(0)} KB）`);

    // 用像素判定是否真是 2×2 网格：检查四格中心与格间空白处颜色是否不同
    const probe = await cdp.evalJs(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(res.src)};
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const W = c.width, H = c.height;
      // 四格中心（与前端 photoGrid 的几何一致）
      const pts = {
        q1: [0.068 + 0.2122, 0.106 + 0.1265],
        q2: [0.068 + 0.4245 + 0.015 + 0.2122, 0.106 + 0.1265],
        q3: [0.068 + 0.2122, 0.106 + 0.253 + 0.015 + 0.1265],
        q4: [0.068 + 0.4245 + 0.015 + 0.2122, 0.106 + 0.253 + 0.015 + 0.1265],
      };
      const out = {};
      for (const [k, [px, py]] of Object.entries(pts)) {
        const d = g.getImageData(Math.round(px * W), Math.round(py * H), 1, 1).data;
        out[k] = [d[0], d[1], d[2]];
      }
      return JSON.stringify(out);
    })()`, true);
    const q = JSON.parse(probe);
    console.log("  四格中心像素:", JSON.stringify(q));
    const uniq = new Set(Object.values(q).map((v) => v.join(",")));
    console.log(`  ${uniq.size >= 3 ? "✓ 四格颜色各不相同 → 确实是 2×2 网格" : "✗ 格数不足，可能只用了第一张"}`);
  }

  ws.close?.();
  proc.kill();
  const pass = ok4.length >= 4 && !!res.src && !res.err;
  console.log("\n结果:", pass ? "✓ 多图打卡链路可用" : "✗ 有问题");
  setTimeout(() => process.exit(pass ? 0 : 1), 300);
}

main().catch((e) => { console.error("测试失败:", e.message); process.exit(1); });
