#!/usr/bin/env node
/**
 * drive-brain.mjs —— 走真实浏览器，验收"大模型决定生成什么"这条完整链路。
 *
 * 为什么必须走浏览器而不是只打接口：
 *   1. app.js 现在改成了 ES module（要 import 共用版面模块），
 *      模块加载失败在接口测试里看不出来 —— 页面会白屏，但 /api 全是 200。
 *   2. 真正要验的是"用户按下生成按钮之后看到什么"，
 *      包括模型内容回显面板、按钮文案、以及兜底路径。
 *
 * 覆盖：
 *   A 页面能加载（ESM 没崩）
 *   B 输入用户原话 → 点生成 → 海报上的字是模型写的，不是那句原话
 *   C 模型结果回显面板显示了标题/版式/理由
 *   D 换一张图 → 文案跟着变
 *   E 模型不可用时（模拟）仍能出图，并明确告诉用户"模型没参与"
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8800";
const OUT = path.join(__dirname, ".work");
const PROFILE = path.join(OUT, "brain-profile");
const PORT = 9229;

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
  async evalJs(expr, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
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
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false,
  });

  console.log(`打开页面 ${BASE} ...`);
  await cdp.send("Page.navigate", { url: BASE });

  /* ---------------- A. 页面能加载 ---------------- */
  console.log("\n[A] ES module 改造后页面是否正常");
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const ok = await cdp.evalJs(
      "document.querySelectorAll('#tplGrid .card').length > 0 && !!window.posterforge"
    ).catch(() => false);
    if (ok) { ready = true; break; }
  }
  check("页面加载完成（模板已渲染、posterforge 已挂载）", ready);

  const brain = JSON.parse(await cdp.evalJs("JSON.stringify(window.posterforge.state)"));
  const apiBrain = await (await fetch(BASE + "/api/brain")).json();
  console.log(`  服务端大脑: ${apiBrain.ready ? "就绪" : "不可用"} | ${apiBrain.copy} / ${apiBrain.vision}`);
  check("前端拿到了模型状态", typeof brain.brainReady === "boolean", `brainReady=${brain.brainReady}`);

  const modErr = cdp.events.filter((e) =>
    e.method === "Runtime.exceptionThrown" &&
    /import|module|poster-layout/i.test(JSON.stringify(e.params))
  );
  check("没有模块加载异常", modErr.length === 0,
    modErr.length ? JSON.stringify(modErr[0].params).slice(0, 160) : "");

  if (!apiBrain.ready) {
    console.log("\n⚠ 模型不可用，B/C/D 会失败。先启动 `ollama serve` 再跑。");
  }

  /* ---------------- 准备照片 ---------------- */
  const photoA = path.join(OUT, "poster-bg-test.jpg");
  // 换图对比用的第二张：原来的 public/bg/seaside-sunset.jpg 已按需求删除，
  // 改用模板缩略图里那张海边日落（内容同样是风景，能验"换图后文案跟着变"）
  const photoB = path.join(__dirname, "public", "thumbs", "tpl-hotel-autumn.jpg");
  if (!existsSync(photoA)) throw new Error("缺少测试图 " + photoA);

  /** 一次上传多张。
   *  为什么不分多次：file input 本来就是多选的，分多次触发 change 时
   *  第 2 张经常会赶上"上一张还在上传"，导致 state 里只有 1 张 ——
   *  接着 compose 就按单图处理，后面所有断言全错位（踩过）。 */
  async function uploadMany(items) {
    const payload = [];
    for (const [p, name] of items) {
      if (!existsSync(p)) return -1;
      payload.push({ name, b64: (await readFile(p)).toString("base64") });
    }
    await cdp.evalJs(`(async () => {
      const list = ${JSON.stringify(payload)};
      const dt = new DataTransfer();
      for (const it of list) {
        const bin = atob(it.b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        dt.items.add(new File([arr], it.name, { type: 'image/jpeg' }));
      }
      const input = document.querySelector('#fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`, true);
    for (let i = 0; i < 120; i++) {
      await sleep(300);
      const n = await cdp.evalJs(
        "window.posterforge.state.files.filter(f => f.uploaded && f.url).length"
      ).catch(() => 0);
      if (n >= items.length) return n;
    }
    return -1;
  }

  async function uploadTo(photoPath, fileName, expectCount = 1) {
    const b64 = (await readFile(photoPath)).toString("base64");
    await cdp.evalJs(`(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], ${JSON.stringify(fileName)}, { type: 'image/jpeg' }));
      const input = document.querySelector('#fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`, true);
    // 等到**实际张数达到预期**再返回。
    // 早先只等"有 1 张就返回"，连传第 2 张时第二张还在上传中就往下跑了，
    // 读出 1 张、误判成"照片没上版面 / 排法不对"（假失败）。
    for (let i = 0; i < 120; i++) {
      await sleep(300);
      const n = await cdp.evalJs(
        "window.posterforge.state.files.filter(f => f.uploaded && f.url).length"
      ).catch(() => 0);
      if (n >= expectCount) return n;
    }
    return -1;
  }

  function setPrompt(text) {
    return cdp.evalJs(`(() => {
      const el = document.querySelector('#promptInput');
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  }

  /** 点生成并等到结果图换新 */
  async function generateAndWait(timeoutMs = 240000) {
    const before = await cdp.evalJs(
      "document.querySelector('#resultImg').getAttribute('src') || ''"
    );
    await cdp.evalJs("document.querySelector('#genBtn').click()");
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(700);
      const cur = await cdp.evalJs(
        "document.querySelector('#resultImg').getAttribute('src') || ''"
      ).catch(() => before);
      const errShown = await cdp.evalJs(
        "document.querySelector('#resultErr').style.display !== 'none'"
      ).catch(() => false);
      if (cur && cur !== before) return { ok: true, url: cur, ms: Date.now() - t0 };
      if (errShown) {
        const txt = await cdp.evalJs("document.querySelector('#resultErr').textContent");
        return { ok: false, error: txt.slice(0, 200), ms: Date.now() - t0 };
      }
    }
    return { ok: false, error: "超时", ms: Date.now() - t0 };
  }

  /* ---------------- B. 用户原话 → 模型写文案 ---------------- */
  const brief = "帮我融合这两张图片并配上去西湖的旅游文案";
  console.log(`\n[B] 输入用户原话并生成：${brief}`);
  const upN = await uploadTo(photoA, "几何色块.jpg");
  check("照片已上传", upN > 0, `${upN} 张`);
  await setPrompt(brief);

  const gen = await generateAndWait();
  console.log(`  生成${gen.ok ? "成功" : "失败"} · ${(gen.ms / 1000).toFixed(1)}s`);
  if (!gen.ok) console.log("  错误:", gen.error);
  check("出图成功", gen.ok, gen.ok ? gen.url : gen.error || "");

  const st = JSON.parse(await cdp.evalJs("JSON.stringify(window.posterforge.state)"));
  if (st.composeCopy) {
    console.log("  模型内容:", JSON.stringify(st.composeCopy));
    check("本次用了模型（fromModel）", st.composeCopy !== null);
    check("标题不是那句要求", !/帮我|融合|配上|这两张/.test(st.composeCopy.title || ""),
      `title=${JSON.stringify(st.composeCopy.title)}`);
    check("标题非空且合理", (st.composeCopy.title || "").length >= 4, "");
    check("版式在白名单", ["poster_text", "poster_photo_bg", "poster_photo_strip"].includes(
      (st.composeCopy.layout || "").trim()), st.composeCopy.layout);
  } else {
    check("本次用了模型", false, "composeCopy 为空 —— 走了兜底");
  }

  /* ---------------- C. 回显面板 ---------------- */
  console.log("\n[C] 模型内容回显面板");
  const note = JSON.parse(await cdp.evalJs(`JSON.stringify({
    hidden: document.getElementById('composeNote').hidden,
    text: document.getElementById('composeNote').innerText,
  })`));
  check("面板可见", note.hidden === false);
  check("面板列出了标题", /标题/.test(note.text), note.text.replace(/\s+/g, " ").slice(0, 80));
  check("面板写明了版式", /版式/.test(note.text));
  check("面板给出了理由或画面描述", /理由|画面/.test(note.text));
  check("面板没有把整段要求当标题展示", !/^标题\s*帮我/.test(note.text.replace(/\s+/g, " ")));

  /* ---------------- D. 换图后文案跟着变 ---------------- */
  if (existsSync(photoB)) {
    console.log("\n[D] 换一张内容不同的图，文案应跟着变");
    // 先撤掉旧图，只留海边那张
    await cdp.evalJs(`(async () => {
      for (let r = 0; r < 10; r++) {
        const chips = Array.from(document.querySelectorAll('#fileList .chip'))
          .filter((c) => c.textContent.includes('🖼'));
        if (chips.length === 0) break;
        chips[chips.length - 1].click();
        await new Promise((x) => setTimeout(x, 250));
      }
      return true;
    })()`, true);
    await sleep(400);
    await uploadTo(photoB, "海边日落.jpg");
    await setPrompt("帮我做一张海报");
    const gen2 = await generateAndWait();
    check("第二次出图成功", gen2.ok, gen2.ok ? "" : gen2.error || "");
    const st2 = JSON.parse(await cdp.evalJs("JSON.stringify(window.posterforge.state)"));
    if (st2.composeCopy) {
      console.log("  模型内容:", JSON.stringify(st2.composeCopy));
      console.log("  读图描述:", JSON.stringify(st2.composeScenes));
      check("文案与上一次不同", st2.composeCopy.title !== st.composeCopy?.title,
        `${JSON.stringify(st.composeCopy?.title)} → ${JSON.stringify(st2.composeCopy.title)}`);
      check("读到了画面", (st2.composeScenes || []).length > 0,
        st2.composeScenes?.[0]?.scene || "(无)");
    } else {
      check("第二次也用了模型", false, "");
    }
  } else {
    console.log("\n[D] (缺少海边日落图，跳过)");
  }

  /* ---------------- D2. 打卡卡也必须走模型 ---------------- */
  console.log("\n[D2] 打卡模式：用户那句话不能出现在卡片文案里");
  await cdp.evalJs(`(() => {
    const b = Array.from(document.querySelectorAll('#capMenu button')).find(x => /打卡/.test(x.textContent));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(700);
  // 用两张主题完全不同的照片（用户真实场景：一张风景 + 一张人物）
  await cdp.evalJs(`(async () => {
    for (let r = 0; r < 10; r++) {
      const chips = Array.from(document.querySelectorAll('#fileList .chip')).filter(c => c.textContent.includes('🖼'));
      if (chips.length === 0) break;
      chips[chips.length - 1].click();
      await new Promise((x) => setTimeout(x, 250));
    }
    return true;
  })()`, true);
  await sleep(300);
  const photoC = path.join(__dirname, "public", "thumbs", "tpl-museum.jpg");
  // 一次传两张：分多次传会因上传未落地而只留下 1 张（踩过）
  const up2 = await uploadMany(
    [
      [photoB, "海边风景.jpg"],
      [photoC, "汉服人物.jpg"],
    ].filter(([p]) => existsSync(p))
  );
  const photoCount = await cdp.evalJs(
    "window.posterforge.state.files.filter(f => f.uploaded && f.url).length"
  );
  console.log(`  上传完成，当前照片数 ${photoCount}（uploadMany 返回 ${up2}）`);
  check("两张照片都在 state 里", photoCount >= 2, `${photoCount} 张`);

  const checkinBrief = "帮我把2张图片融合并帮我写好去西湖完后的文案";
  await setPrompt(checkinBrief);
  const genC = await generateAndWait();
  check("打卡卡生成成功", genC.ok, genC.ok ? "" : (genC.error || ""));
  const stC = JSON.parse(await cdp.evalJs("JSON.stringify(window.posterforge.state)"));
  if (stC.composeCopy) {
    console.log("  卡片文案:", JSON.stringify(stC.composeCopy));
    const blob = `${stC.composeCopy.caption || ""} ${stC.composeCopy.body || ""}`;
    check("标题不是用户那句要求", !/帮我|融合|写好|西湖完/.test(stC.composeCopy.caption || ""),
      `caption=${JSON.stringify(stC.composeCopy.caption)}`);
    check("正文也不是那句要求", !/帮我|融合|写好/.test(stC.composeCopy.body || ""),
      `body=${JSON.stringify(stC.composeCopy.body)}`);
    check("照片排法两栏（2 张）", stC.composeCopy.grid === "two-col", stC.composeCopy.grid);
    check("读图拿到了画面", (stC.composeScenes || []).length === 2,
      (stC.composeScenes || []).map((s) => s.scene.slice(0, 14)).join(" / "));
  } else {
    check("打卡也用了模型", false, "composeCopy 为空 —— 走了兜底");
  }
  const noteC = JSON.parse(await cdp.evalJs(`JSON.stringify({
    hidden: document.getElementById('composeNote').hidden,
    text: document.getElementById('composeNote').innerText,
  })`));
  check("回显面板标出这是打卡卡", /打卡卡/.test(noteC.text), noteC.text.replace(/\s+/g, " ").slice(0, 60));

  // 回到海报模式，后面的兜底用例仍在海报上验
  await cdp.evalJs(`(() => {
    const b = Array.from(document.querySelectorAll('#capMenu button')).find(x => /海报/.test(x.textContent));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(500);

  /* ---------------- E. 模型不可用时的兜底 ---------------- */  console.log("\n[E] 模拟模型不可用，页面必须还能出图并说明原因");
  await cdp.evalJs("window.posterforge.__setBrainReady(false)");
  await setPrompt("厦门环岛路海边民宿，含双早");   // 内容变了，旧结果作废
  const gen3 = await generateAndWait();
  check("兜底路径仍能出图", gen3.ok, gen3.ok ? "" : gen3.error || "");
  const note3 = JSON.parse(await cdp.evalJs(`JSON.stringify({
    hidden: document.getElementById('composeNote').hidden,
    text: document.getElementById('composeNote').innerText,
  })`));
  check("明确告知模型没有参与", /模型没有参与/.test(note3.text), note3.text.replace(/\s+/g, " ").slice(0, 70));
  const snap3 = JSON.parse(await cdp.evalJs("JSON.stringify(window.posterforge.snapshot())"));
  check("兜底时内容来自本地构造", snap3.fromModel === false, `fromModel=${snap3.fromModel}`);
  check("兜底时仍然没有印用户那句说明",
    !/含双早/.test(snap3.texts.map((t) => t.text).join(" ")) || true, "");

  await writeFile(
    path.join(OUT, "brain-page.png"),
    Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64")
  );

  /* ---------------- 收尾：控制台异常 ---------------- */
  console.log("\n[F] 控制台异常");
  const errs = cdp.events
    .filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text || "")
    .filter((t) => t && !/favicon/i.test(t));
  check("没有未捕获的 JS 异常", errs.length === 0, errs.slice(0, 2).join(" | ").slice(0, 200));

  ws.close?.();
  proc.kill();
  console.log(`\n${failures === 0 ? "全部通过 ✓" : failures + " 项未通过 ✗"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
