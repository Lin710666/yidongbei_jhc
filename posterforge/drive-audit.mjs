#!/usr/bin/env node
/**
 * drive-audit.mjs —— 把「哪种功能出哪种效果」整张矩阵跑一遍。
 *
 * 起因：用户要做打卡卡，结果拿到一张带「限时特惠价 ￥299」的海报。
 * 一次踩中两个问题：① 打卡场景不该出现价格；② 没人提供的价格是模板默认值，
 * 属于编造事实 —— 既然在事实校验上投了那么多，就不能留着这个后门。
 *
 * 于是这里做穷尽式核对：功能 × 照片数量的每一种组合，
 *   1. 实际交给渲染器的 spec 是不是「该有的那种」（海报版式 / 打卡版式）
 *   2. 里面有没有**没人给过**的价格、电话、地址
 *   3. 打卡卡绝不该出现价格层
 *
 * 只看代码判断不算数 —— 这里读的是 window.posterforge 暴露的真实 spec。
 */

import { spawn } from "node:child_process";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8800";
const OUT = path.join(__dirname, ".work");
const PROFILE = path.join(OUT, "audit-profile");
const PORT = 9242;

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) throw new Error("找不到 Edge");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
};

/** 没人给过的事实：出现任何一个都算编造 */
const FABRICATED = [
  /￥\s*299/, /¥\s*299/, /限时特惠价/,
  /0592-8888-6666/, /0592-8888/, /环岛南路/, /福建省厦门/,
  /000-0000-0000/, /○○○-○○○○/,
];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) this.events.push(m);
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
  async ev(expr, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) {
      throw new Error(
        "页面异常: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || "?") +
        "\n  表达式: " + String(expr).slice(0, 160)
      );
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
    "--hide-scrollbars", "--window-size=1440,1200", "about:blank",
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
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false,
  });
  console.log(`打开页面 ${BASE} ...`);
  await cdp.send("Page.navigate", { url: BASE });
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const ok = await cdp.ev("(document.querySelectorAll('#tplGrid .card').length > 0) && !!window.posterforge").catch(() => false);
    if (ok) break;
  }
  await sleep(1000);

  const brainReady = (await cdp.ev("!!(window.posterforge && window.posterforge.state.brainReady)")) === true;
  console.log(`模型就绪（第 4 节要用）: ${brainReady}`);

  const photo1 = path.join(OUT, "poster-bg-test.jpg");
  const photo2 = path.join(__dirname, "public", "bg", "seaside-sunset.jpg");
  const photo3 = path.join(__dirname, "public", "thumbs", "tpl-museum.jpg");
  const photoFiles = [photo1, photo2, photo3].filter((p) => existsSync(p));

  async function setCap(which) {
    // 走 __setCap 而不是点按钮：按钮的 onclick 里也调了 setMode，
    // 但用调试出口能确保 mode 一定同步（只点按钮时 cap 变了、mode 没变，
    // 会让「打卡」页面下读到的版式还是海报的，报假失败）
    const id = which === "打卡" ? "checkin" : "poster";
    await cdp.ev(`window.posterforge.__setCap(${JSON.stringify(id)})`);
    await sleep(400);
  }
  async function clearPhotos() {
    await cdp.ev(`(async () => {
      for (let r = 0; r < 12; r++) {
        const chips = Array.from(document.querySelectorAll('#fileList .chip')).filter(c => c.textContent.includes('🖼'));
        if (!chips.length) break;
        chips[chips.length - 1].click();
        await new Promise((x) => setTimeout(x, 250));
      }
      return true;
    })()`, true);
    await sleep(300);
  }
  async function addPhoto(p, expectCount = 1) {
    const b64 = (await readFile(p)).toString("base64");
    await cdp.ev(`(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], '照片.jpg', { type: 'image/jpeg' }));
      const input = document.querySelector('#fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`, true);
    // 必须等**实际张数达到预期**再返回。
    // 早先只等"有 1 张就返回"，连传 2 张时第二张还在路上就往下跑了，
    // 于是读出 1 张、误判成"照片没上版面"（假失败）。
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      const n = await cdp.ev("window.posterforge.state.files.filter(f => f.uploaded && f.url).length").catch(() => 0);
      if (n >= expectCount) return n;
    }
    return -1;
  }
  const setPrompt = (t) => cdp.ev(`(() => {
    const el = document.querySelector('#promptInput');
    el.value = ${JSON.stringify(t)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  /* ------------------------------------------------ 1. 无模型：本地构造的矩阵 */
  console.log("\n[1] 本地构造（模拟模型不可用）：功能 × 照片数量");
  await cdp.ev("window.posterforge.__setBrainReady(false)");

  const MATRIX = [
    { cap: "海报", mode: "poster", photos: [], label: "海报 · 无图" },
    { cap: "海报", mode: "poster", photos: [0], label: "海报 · 1 图" },
    { cap: "海报", mode: "poster", photos: [0, 1], label: "海报 · 2 图" },
    { cap: "打卡", mode: "checkin", photos: [], label: "打卡 · 无图" },
    { cap: "打卡", mode: "checkin", photos: [0], label: "打卡 · 1 图" },
    { cap: "打卡", mode: "checkin", photos: [0, 1], label: "打卡 · 2 图" },
    { cap: "打卡", mode: "checkin", photos: [0, 1, 2], label: "打卡 · 3 图" },
  ];

  for (const row of MATRIX) {
    await clearPhotos();
    await setCap(row.cap);
    for (let i = 0; i < row.photos.length; i++) {
      await addPhoto(photoFiles[row.photos[i] % photoFiles.length], i + 1);
    }
    await setPrompt("今日实拍，随手一拍就是大片");   // 故意不带任何数字，才能验"没给就不印"

    const snap = JSON.parse(await cdp.ev("JSON.stringify(window.posterforge.snapshot())"));
    const layout = await cdp.ev("window.posterforge.currentLayout()");
    const wantLayout = row.mode === "checkin"
      ? "@layout:checkin-photo-card"
      : "@layout:poster-vertical-gold";
    const allText = snap.texts.map((t) => t.text).join("\n");

    check(`${row.label} · 版式对应功能`, layout === wantLayout, `实际 ${layout}`);

    const leaks = FABRICATED.filter((re) => re.test(allText)).map((re) => re.source);
    check(`${row.label} · 无编造的事实`, leaks.length === 0, leaks.join(" ") || "");

    const priceLayers = snap.texts.filter((t) => /price|限时特惠价|￥/.test(t.name + t.text));
    if (row.mode === "checkin") {
      check(`${row.label} · 没有价格层`, priceLayers.length === 0,
        priceLayers.map((t) => t.name + "=" + t.text).join(" / "));
    } else {
      // 海报：用户没给价格时也不该印价格（这条就是本次报错的正面回归）
      check(`${row.label} · 没给价格就不印价格`, priceLayers.length === 0,
        priceLayers.map((t) => t.name + "=" + t.text).join(" / "));
    }

    if (row.mode === "checkin" && row.photos.length) {
      check(`${row.label} · 版面里 ${row.photos.length} 张图都上了`,
        snap.images.length === row.photos.length, `实际 ${snap.images.length} 张`);
    }
  }

  /* ------------------------------------------------ 2. 用户给了价格就必须印 */
  console.log("\n[2] 用户明确给了价格/电话：必须印出来");
  await setCap("海报");
  await clearPhotos();
  await setPrompt("连住两晚立减 300 元，含双早，价格 ￥599，电话 13900001111");
  const s2 = JSON.parse(await cdp.ev("JSON.stringify(window.posterforge.snapshot())"));
  const t2 = s2.texts.map((t) => t.text).join("\n");
  check("印出了用户给的价格", /￥599/.test(t2), t2.replace(/\n/g, " / ").slice(0, 70));
  check("印出了用户给的电话", /13900001111/.test(t2), "");

  /* ------------------------------------------------ 3. 打卡卡的版式细节 */
  console.log("\n[3] 打卡卡：照片张数 → 版面张数");
  for (const n of [1, 2, 3]) {
    await clearPhotos();
    await setCap("打卡");
    for (let i = 0; i < n; i++) await addPhoto(photoFiles[i % photoFiles.length], i + 1);
    const s = JSON.parse(await cdp.ev("JSON.stringify(window.posterforge.snapshot())"));
    check(`打卡 ${n} 张 → 版面 ${n} 张图`, s.images.length === n, `实际 ${s.images.length}`);
    check(`打卡 ${n} 张 · 标签层在位`, s.texts.some((t) => t.name === "tag1"), "");
  }

  /* ------------------------------------------------ 4. 有模型：功能仍对应正确 */
  if (brainReady) {
    console.log("\n[4] 模型参与时，功能与产出仍然对应");
    for (const which of ["海报", "打卡"]) {
      await cdp.ev("window.posterforge.__setBrainReady(true)");
      await clearPhotos();
      await setCap(which);
      await addPhoto(photoFiles[0], 1);
      await setPrompt("帮我把这张图做成去西湖的旅游文案");
      const before = await cdp.ev("document.querySelector('#resultImg').getAttribute('src') || ''");
      await cdp.ev("document.querySelector('#genBtn').click()");
      let done = null;
      for (let i = 0; i < 240; i++) {
        await sleep(700);
        const st = JSON.parse(await cdp.ev(`JSON.stringify({
          img: document.querySelector('#resultImg').getAttribute('src') || '',
          err: document.querySelector('#resultErr').style.display !== 'none' ? document.querySelector('#resultErr').textContent : '',
        })`).catch(() => "{}"));
        if (st.img && st.img !== before) { done = { ok: true }; break; }
        if (st.err) { done = { ok: false, err: st.err }; break; }
      }
      check(`${which} 能出图`, done?.ok === true, done?.err ? done.err.replace(/\s+/g, " ").slice(0, 90) : "");
      const layout = await cdp.ev("window.posterforge.currentLayout()");
      const want = which === "打卡" ? "@layout:checkin-photo-card" : "@layout:poster-vertical-gold";
      check(`${which} · 模型参与后版式仍正确`, layout === want, `实际 ${layout}`);
      const s4 = JSON.parse(await cdp.ev("JSON.stringify(window.posterforge.snapshot())"));
      const t4 = s4.texts.map((t) => t.text).join("\n");
      const leaks4 = FABRICATED.filter((re) => re.test(t4)).map((re) => re.source);
      check(`${which} · 模型参与后也无编造事实`, leaks4.length === 0, leaks4.join(" "));
    }
  } else {
    console.log("\n[4] (模型未就绪，跳过)");
  }

  await writeFile(
    path.join(OUT, "audit-page.png"),
    Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64")
  );

  const errs = cdp.events
    .filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => e.params.exceptionDetails.exception?.description || "")
    .filter(Boolean);
  check("无 JS 异常", errs.length === 0, errs.slice(0, 1).join("").slice(0, 150));

  ws.close?.();
  proc.kill();
  console.log(`\n${failures === 0 ? "全部通过 ✓" : failures + " 项未通过 ✗"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
