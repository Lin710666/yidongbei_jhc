#!/usr/bin/env node
/**
 * drive-chips.mjs —— 验证「通用关键词模板 + 图片当底图」这条新链路。
 *
 * 验的是四件事，每一件都必须有实证，不能靠读代码下结论：
 *   1. 六个 chip 填入的文案是**通用的**（不含任何示例店名/编造数据）
 *   2. 点 chip 后输入框真的拿到结构化多行文案，且解析器能取出标题/卖点/价格/电话
 *   3. 上传照片后提示语变成「照片当底图」
 *   4. 生成出来的海报**像素上确实用了那张照片**（不是渐变）
 *      —— 做法：先把同一张图铺满画布，取几个采样点跟生成图比色差，
 *         渐变背景的色差会非常大，照片背景会很小。
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8800";
const OUT = path.join(__dirname, ".work");
const PROFILE = path.join(OUT, "chip-profile");
const PORT = 9227;

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
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false,
  });

  console.log("打开页面 ...");
  await cdp.send("Page.navigate", { url: BASE });
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const n = await cdp.evalJs("document.querySelectorAll('#tplGrid .card').length").catch(() => 0);
    if (n > 0) break;
  }
  console.log("  页面就绪\n");

  /* ------------------------------------------------ 1. chip 本身是否通用 */
  console.log("[1] 六个通用模板是否干净（不许出现示例店名/编造数据）");
  // 选择器限定在 #promptTips：.mini-chip 是样式类，
  // 「套用模板」面板的保存/筛选按钮也用这个类，不限定就会把它们算进来。
  const chips = JSON.parse(await cdp.evalJs(`JSON.stringify(
    Array.from(document.querySelectorAll('#promptTips .mini-chip')).map(b => ({ label: b.textContent.trim(), tpl: b.dataset.tpl || null }))
  )`));
  check("chip 数量 = 6", chips.length === 6, `实际 ${chips.length}`);
  check("每个 chip 都带 data-tpl", chips.every((c) => c.tpl));

  const BANNED = ["山海楼", "灶王爷", "云栖", "大鹏所城", "东极岛", "半山茶事", "长白", "2.7k", "240 万", "3.2 万"];
  // 正文在 JS 里，读它：点开每个 chip 看填入内容
  const filled = {};
  for (const c of chips) {
    await cdp.evalJs(`document.querySelector('#promptClear').click()`);
    await cdp.evalJs(`document.querySelector('.mini-chip[data-tpl="${c.tpl}"]').click()`);
    filled[c.tpl] = await cdp.evalJs("document.querySelector('#promptInput').value");
  }
  const allText = Object.values(filled).join("\n");
  const hit = BANNED.filter((b) => allText.includes(b));
  check("不含任何示例店名/编造数据", hit.length === 0, hit.length ? "命中: " + hit.join(",") : "");
  check("每个模板都是多行结构", Object.values(filled).every((t) => t.split("\n").length >= 3));

  /* ------------------------------------------------ 2. 解析结果是否合理 */
  console.log("\n[2] 点「住宿优惠」后，解析器取到的东西");
  await cdp.evalJs(`document.querySelector('#promptClear').click()`);
  await cdp.evalJs(`document.querySelector('.mini-chip[data-tpl="stay"]').click()`);
  const stay = await cdp.evalJs("document.querySelector('#promptInput').value");
  console.log("  填入内容:\n" + stay.split("\n").map((l) => "    " + l).join("\n"));
  const parsed = JSON.parse(await cdp.evalJs(`(() => {
    const p = window.posterforge.__debug.parsePrompt(document.querySelector('#promptInput').value);
    return JSON.stringify({ titleLine: p.titleLine, points: p.points, price: p.price || null, phone: p.phone || null, brand: p.brand || null });
  })()`));
  check("标题行取到优惠句", /减 300|立减/.test(parsed.titleLine || ""), `实际「${parsed.titleLine}」`);
  check("价格解析正确", parsed.price === "￥300", `实际 ${parsed.price}`);
  check("电话解析正确", (parsed.phone || "").replace(/\s/g, "") === "000-0000-0000", `实际 ${parsed.phone}`);
  check("卖点行非空", (parsed.points || []).length > 0, JSON.stringify(parsed.points));
  check("卖点里没有「填写说明」混进来", !/改成|换成|替换/.test((parsed.points || []).join("")),
    JSON.stringify(parsed.points));
  check("品牌没被误认作「酒店」", parsed.brand === null, `实际 ${parsed.brand}`);
  const hint0 = await cdp.evalJs("document.querySelector('#promptHint').textContent");
  console.log("  提示语:", hint0);

  /* ------------------------------------------------ 2b. 六个模板逐个过解析器 */
  console.log("\n[2b] 六个模板逐个喂给解析器（标题必须取到卖点行，且无残留说明词）");
  for (const c of chips) {
    await cdp.evalJs(`document.querySelector('#promptClear').click()`);
    await cdp.evalJs(`document.querySelector('.mini-chip[data-tpl="${c.tpl}"]').click()`);
    const p = JSON.parse(await cdp.evalJs(`(() => {
      const p = window.posterforge.__debug.parsePrompt(document.querySelector('#promptInput').value);
      return JSON.stringify({ title: p.titleLine, points: p.points, price: p.price || null, phone: p.phone || null, brand: p.brand || null });
    })()`));
    const shown = JSON.stringify(p);
    const dirty = /改成|换成|替换|改成你/.test(shown);
    const ok = !!p.title && !dirty;
    check(`${c.label}`, ok, `标题「${p.title}」价格 ${p.price || "—"} 电话 ${p.phone || "—"}${dirty ? "  ⚠含说明词" : ""}`);
  }

  /* ------------------------------------------------ 2c. 不许印编造的事实信息 */
  console.log("\n[2c] 海报上不许出现编造的店名/地址/电话");
  const DEMO_FACTS = ["山海楼", "灶王爷", "云栖", "大鹏所城", "福建省厦门", "环岛南路", "0592-8888-6666"];
  // 用通用模板 + 不写地址的情况
  await cdp.evalJs("document.querySelector('#promptClear').click()");
  await cdp.evalJs(`document.querySelector('.mini-chip[data-tpl="stay"]').click()`);
  const snapNoAddr = JSON.parse(await cdp.evalJs("JSON.stringify(window.posterforge.snapshot())"));
  const noAddrText = snapNoAddr.texts.map((t) => t.text).join("\n");
  const leaked = DEMO_FACTS.filter((d) => noAddrText.includes(d));
  check("未写地址时没有编造事实漏出", leaked.length === 0, leaked.length ? "漏出: " + leaked.join(",") : "");
  // 地址位现在**不画那一层**（不再印"地址 ○○"这种占位），版面留白由底部一行
  // contactHint 填住。所以这里断言的是"没有把地址印出去"，而不是"有占位提示"。
  check("未写地址时不印地址", !/地址/.test(noAddrText), noAddrText.match(/地址[^\n]*/)?.[0] || "");
  check("店名位显示为占位提示", /○○（填你的店名）/.test(noAddrText), "");

  // 写了地址就必须印用户写的那个
  await cdp.evalJs(`(() => {
    const el = document.querySelector('#promptInput');
    el.value = el.value + '\\n地址：某某路 88 号';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const snapAddr = JSON.parse(await cdp.evalJs("JSON.stringify(window.posterforge.snapshot())"));
  const addrLine = snapAddr.texts.find((t) => t.name === "address");
  check("写了「地址：…」就印用户写的", (addrLine?.text || "").includes("某某路 88 号"),
    addrLine ? addrLine.text : "(无 address 层)");
  // 地址只能出现一次：早先它既进了副标题（卖点）又占着 address 版位，海报上重复两遍
  const addrHits = snapAddr.texts.filter((t) => (t.text || "").includes("某某路 88 号"));
  check("地址只印一次（不在副标题里重复）", addrHits.length === 1,
    addrHits.map((t) => t.name + "=" + t.text).join(" | "));


  console.log("\n[3] 上传照片后提示语应变成「照片当底图」");
  const photo = path.join(OUT, "poster-bg-test.jpg");
  if (!existsSync(photo)) { proc.kill(); throw new Error("缺少测试图 " + photo); }
  const b64 = (await readFile(photo)).toString("base64");
  await cdp.evalJs(`(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([arr], '测试照片.jpg', { type: 'image/jpeg' }));
    const input = document.querySelector('#fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`, true);

  let up = null, prev = "";
  for (let i = 0; i < 120; i++) {
    await sleep(400);
    const snap = await cdp.evalJs(`(() => {
      const s = window.posterforge && window.posterforge.state;
      return JSON.stringify(s ? s.files.map(f => ({ uploaded: !!f.uploaded, url: f.url || null })) : []);
    })()`).catch(() => "");
    if (snap === prev) { up = JSON.parse(snap || "[]"); if (up.some((f) => f.uploaded && f.url)) break; }
    prev = snap;
  }
  const photoUrl = (up || []).find((f) => f.uploaded && f.url)?.url;
  check("照片已上传", !!photoUrl, photoUrl || "");
  const hint1 = await cdp.evalJs("document.querySelector('#promptHint').textContent");
  console.log("  提示语:", hint1);
  check("提示语提到照片当底图", /底图/.test(hint1) && /1 张/.test(hint1));

  const bg = JSON.parse(await cdp.evalJs("JSON.stringify(window.posterforge.__debug.buildPosterSpec().background)"));
  check("海报 background.type = image", bg.type === "image", JSON.stringify(bg));
  check("海报底图 = 上传的照片", (bg.image || "").startsWith("uploads/"), bg.image || "");

  /* ------------------------------------------------ 4. 真的生成一张，验像素 */
  /* ------------------------------------------------ 3b. 要求 vs 文案 + 多图 */
  console.log("\n[3b] 「要我干活」的话不能当文案印上去");
  const briefCases = [
    { text: "帮我融合这两张图片并配上去西湖的旅游文案", wantSubject: "西湖" },
    { text: "请生成一张杭州西湖的旅游海报", wantSubject: "杭州西湖" },
    { text: "帮我做一张海报", wantSubject: null },
    { text: "帮我配一句「风大记得带外套」", wantQuoted: "风大记得带外套" },
    { text: "大鹏所城海边日出打卡，五点半的海值得早起一次", wantBrief: false },
  ];
  for (const c of briefCases) {
    const r = JSON.parse(await cdp.evalJs(`(() => {
      const b = window.posterforge.__debug.detectBrief(${JSON.stringify(c.text)});
      return JSON.stringify({ isBrief: b.isBrief, subject: b.subject, kind: b.kind, quoted: b.quoted });
    })()`));
    const ok = c.wantBrief === false ? r.isBrief === false
      : c.wantSubject !== undefined ? r.subject === c.wantSubject
      : c.wantQuoted !== undefined ? (r.quoted || []).includes(c.wantQuoted)
      : r.isBrief === true;
    check(`「${c.text.slice(0, 16)}…」`, ok, `要求=${r.isBrief} 主题=${JSON.stringify(r.subject)}`);
  }

  // 真正的验收：输入用户原话，看海报上到底印什么
  await cdp.evalJs("document.querySelector('#promptClear').click()");
  await cdp.evalJs(`(() => {
    const el = document.querySelector('#promptInput');
    el.value = '帮我融合这两张图片并配上去西湖的旅游文案';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const briefSnap = JSON.parse(await cdp.evalJs("JSON.stringify(window.posterforge.snapshot())"));
  const printed = briefSnap.texts.map((t) => t.text).join("\n");
  check("海报上没印「帮我融合…」这句要求",
    !/帮我融合|这两张|配上去/.test(printed), printed.slice(0, 50).replace(/\n/g, " / "));
  const titleLayer = briefSnap.texts.find((t) => t.name === "title");
  check("标题是按要求生成的文案（含西湖）", /西湖/.test(titleLayer?.text || ""), titleLayer?.text);

  // 两张图 → 顶部拼图带，两张都上版面
  const photo2 = path.join(OUT, "grid-photo-2.jpg");
  if (existsSync(photo2)) {
    const b2 = (await readFile(photo2)).toString("base64");
    await cdp.evalJs(`(async () => {
      const bin = atob(${JSON.stringify(b2)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], '第二张.jpg', { type: 'image/jpeg' }));
      const input = document.querySelector('#fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`, true);
    let up2 = null, prev2 = "";
    for (let i = 0; i < 120; i++) {
      await sleep(400);
      const snap = await cdp.evalJs(`(() => {
        const s = window.posterforge && window.posterforge.state;
        return JSON.stringify(s ? s.files.filter(f => f.uploaded && f.url).map(f => f.url) : []);
      })()`).catch(() => "");
      if (snap === prev2) { up2 = JSON.parse(snap || "[]"); if (up2.length >= 2) break; }
      prev2 = snap;
    }
    check("两张照片都已上传", (up2 || []).length >= 2, `${(up2 || []).length} 张`);

    const spec2 = JSON.parse(await cdp.evalJs("JSON.stringify(window.posterforge.__debug.buildPosterSpec())"));
    const imgLayers = (spec2.layers || []).filter((l) => l.type === "image");
    check("两张图都进了海报图层", imgLayers.length === 2, `${imgLayers.length} 个 image 层`);
    check("多图时不再拿第一张铺满底图", spec2.background.type === "gradient",
      `background.type=${spec2.background.type}`);
    const xs = imgLayers.map((l) => l.box.box[0].toFixed(3));
    check("两张图横向分列（起点不同）", new Set(xs).size === 2, xs.join(" / "));
    const hint2 = await cdp.evalJs("document.querySelector('#promptHint').textContent");
    check("提示语说明多图会拼成图带", /图带/.test(hint2), hint2.slice(0, 60));

    // 版面重叠检查：这次真实踩过 —— 标题压在照片上、价格块被顶出画布。
    // 两件都要盯住：文字与拼图带不重叠，且所有元素留在 0~1 之内。
    const titleL = (spec2.layers || []).find((l) => l.name === "title");
    const stripImg = (spec2.layers || []).find((l) => l.name === "photo");
    const stripBox = stripImg?.box?.box || [0, 0];
    const stripBottom = stripBox[1] + (stripImg?.box?.size?.[1] || 0);
    const titleTop = titleL.y;
    const titleMaxH = titleL.fit?.maxHeight || 0;
    check("标题不在拼图带里面（不与照片重叠）",
      titleTop >= stripBottom,
      `标题 y=${titleTop.toFixed(3)}，拼图带底 ${stripBottom.toFixed(3)}`);
    check("标题自身不越出画布",
      titleTop + titleMaxH <= 1.0,
      `标题底 ${(titleTop + titleMaxH).toFixed(3)}`);

    const outOfCanvas = (spec2.layers || []).filter((l) => {
      const b = l.box;
      if (!b) return false;
      const [x, y] = Array.isArray(b) ? b : (b.box || []);
      if (y === undefined) return false;
      const h = Array.isArray(b) ? (b[3] - b[1]) : (b.size?.[1] || 0);
      if (typeof x !== "number" || typeof y !== "number") return false;
      return y < 0 || y + h > 1.0001;
    }).map((l) => l.name);
    check("没有元素被顶出画布", outOfCanvas.length === 0, outOfCanvas.join(", "));

    const footer = (spec2.layers || []).find((l) => l.name === "footerNote");
    check("页脚仍在画布内", (footer?.y || 0) <= 0.97, `footer y=${footer?.y}`);

    // 真出一张双图海报，存下来给人看（也是"两张都在版面上"的像素证据）
    const gen2 = JSON.parse(await cdp.evalJs(`(async () => {
      const r = await fetch('/api/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: window.posterforge.__debug.buildPosterSpec() }),
      });
      const j = await r.json();
      return JSON.stringify({ ok: r.ok, url: j.url || null, error: j.error || j.message || null });
    })()`, true));
    check("双图海报生成成功", gen2.ok === true && !!gen2.url, gen2.error || "");
    if (gen2.url) {
      const b64 = await cdp.evalJs(`(async () => {
        const i = new Image(); i.crossOrigin = 'anonymous';
        i.src = ${JSON.stringify(gen2.url)} + '?t=' + Date.now();
        await i.decode();
        const c = document.createElement('canvas');
        c.width = i.naturalWidth; c.height = i.naturalHeight;
        c.getContext('2d').drawImage(i, 0, 0);
        return c.toDataURL('image/png').split(',')[1];
      })()`, true);
      await writeFile(path.join(OUT, "chip-poster-2photos.png"), Buffer.from(b64, "base64"));
      console.log("  双图海报已存 → .work/chip-poster-2photos.png");
    }
  } else {
    console.log("  (缺少 grid-photo-2.jpg，跳过双图检查)");
  }

  // 第 4 节验的是"单张照片铺满底图"，而第一张（带品红指纹的那张）必须留在列表首位。
  // 注意要撤**后面那张**：早先误删了第一张，第 4 节拿第二张当底图，
  // 指纹自然量不到，白白报了一次假失败。
  console.log("  撤掉后加的那张，只留第一张（第 4 节要验单图铺底）");
  await cdp.evalJs(`(async () => {
    for (let round = 0; round < 12; round++) {
      const chips = Array.from(document.querySelectorAll('#fileList .chip'))
        .filter((c) => c.textContent.includes('🖼'));
      if (chips.length <= 1) break;
      chips[chips.length - 1].click();   // 删最后一张
      await new Promise((r) => setTimeout(r, 250));
    }
    return true;
  })()`, true);
  for (let i = 0; i < 40; i++) {
    const n = await cdp.evalJs(
      "window.posterforge.state.files.filter(f => f.uploaded && f.url).length"
    ).catch(() => 0);
    if (n === 1) break;
    await sleep(250);
  }
  const leftCount = await cdp.evalJs(
    "window.posterforge.state.files.filter(f => f.uploaded && f.url).length"
  );
  check("已回到只剩 1 张照片", leftCount === 1, `剩 ${leftCount} 张`);
  // 留下的必须是带品红指纹的那张。
  // 注意：不能拿"字节数等于源文件"来判 —— 上传后服务端会重新编码（转正 + 去 EXIF），
  // 尺寸会变（39 KB → 26 KB）。判据用尺寸比例 + 指纹像素，别用字节数。
  const leftFiles = JSON.parse(await cdp.evalJs(
    "JSON.stringify(window.posterforge.state.files.filter(f => f.uploaded && f.url))"
  ));
  const leftDims = JSON.parse(await cdp.evalJs(`(async () => {
    const i = new Image();
    i.src = ${JSON.stringify(leftFiles[0]?.url || "")} + '?t=' + Date.now();
    await i.decode();
    return JSON.stringify({ w: i.naturalWidth, h: i.naturalHeight });
  })()`, true));
  check("留下的是那张 900x1200 的测试图（比例 0.75）",
    Math.abs(leftDims.w / leftDims.h - 0.75) < 0.02 && leftDims.w >= 800,
    `${leftDims.w}x${leftDims.h}`);

  console.log("\n[4] 走真实接口生成海报，并在像素上验证照片被用上了");
  const t0 = Date.now();
  const gen = JSON.parse(await cdp.evalJs(`(async () => {
    const spec = window.posterforge.__debug.buildPosterSpec();
    const r = await fetch('/api/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec }),
    });
    const j = await r.json();
    return JSON.stringify({ ok: r.ok, url: j.url || null, error: j.error || j.message || null,
      validation: j.validation || null });
  })()`, true));
  console.log(`  接口返回 (${((Date.now() - t0) / 1000).toFixed(1)}s):`, JSON.stringify(gen).slice(0, 300));
  check("生成成功", gen.ok === true && !!gen.url, gen.error || "");

  if (gen.url) {
    // 指纹判定：测试图右下角有一块**纯品红 (255,0,255)** 矩形。
    // 渐变底图不可能凭空造出这种颜色，所以只要海报对应位置出现品红，
    // 就能证明"这张照片确实被当作底图铺上去了"，而不是换个渐变糊过去。
    //
    // 位置换算（cover 居中裁剪 900x1200 → 1080x1440）：
    //   照片 x∈[560,899] → 画布 x∈[672,1080]，即 0.622~1.0
    //   照片 y∈[900,975] → 画布 y∈[1200,1300]，即 0.833~0.903
    // 遮罩最重的一档是 opacity 0.74，所以品红会被压到约 (66,0,66)，
    // 判定按"品红相"来判：R 与 B 都明显高于 G，且两者接近。

    // 先把照片底图那张量出来。
    // 用**区域内计数**而不是单点取色：单点要求指纹块的像素坐标算得刚好，
    // 一旦算偏一格就误报（第一次就踩了，取到隔壁的紫色块）。
    const PROBE = (url) => `(async () => {
      const W = 1080, H = 1440;
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.src = ${JSON.stringify(url)} + '?t=' + Date.now();
      await img.decode();
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      c.getContext('2d').drawImage(img, 0, 0, W, H);
      const g = c.getContext('2d').getImageData(0, 0, W, H).data;
      // 统计"品红相"像素：R 与 B 都明显高于 G。
      // 底图渐变的蓝/青都满足 R 低，所以不会误计。
      let mag = 0, strong = 0;
      for (let i = 0; i < g.length; i += 4) {
        const r = g[i], gg = g[i + 1], b = g[i + 2];
        if (r - gg > 40 && b - gg > 40) { mag++; if (Math.abs(r - b) < 80) strong++; }
      }
      return JSON.stringify({ mag, strong, total: g.length / 4 });
    })()`;

    const fpA = JSON.parse(await cdp.evalJs(PROBE(gen.url), true));
    console.log(`  照片底图海报里「品红相」像素: ${fpA.mag} / ${fpA.total}（其中 R≈B 的强品红 ${fpA.strong}）`);
    check("海报上出现测试图的品红指纹块（证明照片当了底图）", fpA.strong > 5000,
      `强品红像素 ${fpA.strong}`);

    // 采样比对：把原照片按同样的 cover 逻辑铺满 1080x1440，再和生成图比色差。
    // 注意：文字会盖住一部分区域，所以采样点选在**文字之外**的位置。
    const cmp = JSON.parse(await cdp.evalJs(`(async () => {
      const W = 1080, H = 1440;
      const load = async (src) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.src = src; await i.decode(); return i; };
      const photo = await load(${JSON.stringify(photoUrl)} + '?t=' + Date.now());
      const out = await load(${JSON.stringify(gen.url)} + '?t=' + Date.now());

      // cover 裁剪：与渲染器保持一致
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      const sc = Math.max(W / photo.naturalWidth, H / photo.naturalHeight);
      const dw = photo.naturalWidth * sc, dh = photo.naturalHeight * sc;
      ctx.drawImage(photo, (W - dw) / 2, (H - dh) / 2, dw, dh);
      const src = ctx.getImageData(0, 0, W, H).data;

      const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
      const ctx2 = c2.getContext('2d');
      ctx2.drawImage(out, 0, 0, W, H);
      const got = ctx2.getImageData(0, 0, W, H).data;
      // 采样点：避开文字（左侧 x<0.07 是留白，右上角是空照片区）
      const pts = [[0.04,0.30],[0.04,0.50],[0.96,0.30],[0.96,0.50],[0.50,0.10],[0.90,0.12]];
      const rows = pts.map(([fx, fy]) => {
        const x = Math.round(fx * (W - 1)), y = Math.round(fy * (H - 1));
        const i = (y * W + x) * 4;
        const d = Math.abs(src[i] - got[i]) + Math.abs(src[i+1] - got[i+1]) + Math.abs(src[i+2] - got[i+2]);
        return { at: fx + ',' + fy, photo: [src[i], src[i+1], src[i+2]], poster: [got[i], got[i+1], got[i+2]], diff: d };
      });
      return JSON.stringify(rows);
    })()`, true));

    console.log("  采样比对（照片原色 vs 海报同位置；遮罩会整体压暗，所以看的是是否同色系）:");
    for (const r of cmp) console.log(`    ${r.at.padEnd(9)} 照片 ${JSON.stringify(r.photo)} → 海报 ${JSON.stringify(r.poster)}  Δ=${r.diff}`);

    const ratios = cmp.map((r) => {
      const a = (r.photo[0] + r.photo[1] + r.photo[2]) / 3;
      const b = (r.poster[0] + r.poster[1] + r.poster[2]) / 3;
      return a > 0 ? b / a : 1;
    });
    const inRange = ratios.every((x) => x > 0.25 && x < 1.15);
    console.log("  亮度比例:", ratios.map((x) => x.toFixed(2)).join(" "));
    check("每个采样点都与照片同色系（被遮罩压暗）", inRange);
    check("整体确实被压暗了（遮罩生效）", ratios.reduce((a, b) => a + b, 0) / ratios.length < 1.0);

    // 对照组：同样构图但底图换成渐变。
    // 这一组必须**量不到品红**，否则说明上面的指纹判定本身不成立（假阳性）。
    const plain = JSON.parse(await cdp.evalJs(`(async () => {
      const spec = window.posterforge.__debug.buildPosterSpec();
      spec.background = { type: 'gradient', from: '#0b2a30', to: '#1d5f66', angle: 130 };
      const r = await fetch('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec }) });
      const j = await r.json();
      return JSON.stringify({ url: j.url || null });
    })()`, true));
    if (plain.url) {
      const fpB = JSON.parse(await cdp.evalJs(PROBE(plain.url), true));
      console.log(`  对照（渐变底图）「品红相」像素: ${fpB.mag} / ${fpB.total}（强品红 ${fpB.strong}）`);
      check("对照组量不到品红（证明指纹判定不是假阳性）", fpB.strong < 500,
        `强品红 ${fpB.strong}`);
    } else {
      console.log("  (对照生成失败，跳过)");
    }

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(OUT, "chip-poster-page.png"), Buffer.from(shot.data, "base64"));
    const imgB64 = await cdp.evalJs(`(async () => {
      const i = new Image(); i.crossOrigin='anonymous';
      i.src = ${JSON.stringify(gen.url)} + '?t=' + Date.now();
      await i.decode();
      const c = document.createElement('canvas');
      c.width = i.naturalWidth; c.height = i.naturalHeight;
      c.getContext('2d').drawImage(i, 0, 0);
      return c.toDataURL('image/png').split(',')[1];
    })()`, true);
    await writeFile(path.join(OUT, "chip-poster-with-photo.png"), Buffer.from(imgB64, "base64"));
    console.log("  产物已存 → .work/chip-poster-with-photo.png");
  }

  ws.close?.();
  proc.kill();
  console.log(`\n${failures === 0 ? "全部通过 ✓" : failures + " 项未通过 ✗"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
