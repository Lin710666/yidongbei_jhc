#!/usr/bin/env node
/**
 * drive-adlaw.mjs —— 验收广告法预检这条链路。
 *
 * 起因：通用模板里我写了"最佳机位"，而服务端校验器把"最佳"判为广告法禁用词
 * 直接拒绝出图 —— 用户点了模板、等了一轮，才看到一句"命中广告法禁用/高风险词"。
 * 根因有两个：模板自己带禁词；以及预检只在服务端、要等渲染前才做。
 *
 * 验四件事：
 *   1. 六个通用模板本身不含任何禁词（不能自己给自己埋雷）
 *   2. 输入里打禁词 → 输入框下方立刻出现红色警告
 *   3. 「一键改写」能把禁词换掉，且换完警告消失
 *   4. 打卡模板那条真实链路能出图（这是用户实际卡住的操作）
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8800";
const OUT = path.join(__dirname, ".work");
const PROFILE = path.join(OUT, "adlaw-profile");
const PORT = 9233;

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

const BANNED = [
  "国家级", "世界级", "最高级", "最佳", "最好", "最优", "最强", "最便宜", "最低价",
  "第一品牌", "全国第一", "全市第一", "销量第一", "排名第一",
  "绝无仅有", "独一无二", "百分百", "100%", "永久", "根治", "特效",
  "国家免检", "免检产品", "央视上榜",
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
  console.log(`打开页面 ${BASE} ...`);
  await cdp.send("Page.navigate", { url: BASE });
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const ok = await cdp.ev(
      "(document.querySelectorAll('#tplGrid .card').length > 0) && (typeof window.posterforge !== 'undefined')"
    ).catch(() => false);
    if (ok) break;
  }
  await sleep(800);

  const setPrompt = (t) => cdp.ev(`(() => {
    const el = document.querySelector('#promptInput');
    el.value = ${JSON.stringify(t)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  /* ---------------- 0. 改写函数先过一遍（快，失败也能立刻定位） ---------------- */
  console.log("[0] 改写函数必须产出「仍然干净」的结果");
  const fixCases = [
    "最佳机位在观景台",
    "最好的海景房，最低价首发",
    "本公司为国家级示范单位，产品100%有效",
    "独家秘方，老字号，特级食材",
    "观景台机位出片，建议日落前一小时到",   // 本来就干净，必须原样保留
  ];
  for (const t of fixCases) {
    const fixed = await cdp.ev(`window.posterforge.__debug.fixAdLaw(${JSON.stringify(t)})`);
    const left = BANNED.filter((w) => fixed.includes(w));
    check(`「${t.slice(0, 16)}…」→「${fixed.slice(0, 20)}…」`, left.length === 0, left.join(","));
  }

  /* ---------------- 1. 模板自身干净 ---------------- */
  console.log("\n[1] 六个通用模板不能自带禁词");
  // 选择器必须限定在 #promptTips 里。
  // 原来只按 .mini-chip 类名选 —— 那是**样式类**，后来「套用模板」面板
  // 新增的保存/筛选按钮也用了它，于是这里一下变成 9 个、断言全错。
  // 找元素要按容器或 data 属性，不能按样式类名。
  const chips = JSON.parse(await cdp.ev(
    "JSON.stringify(Array.from(document.querySelectorAll('#promptTips .mini-chip')).map(b => b.dataset.tpl))"
  ));
  check("拿到 6 个模板", chips.length === 6, chips.join(","));
  const allTpl = [];
  for (const t of chips) {
    await cdp.ev("document.querySelector('#promptClear').click()");
    await cdp.ev(`document.querySelector('.mini-chip[data-tpl="${t}"]').click()`);
    const v = await cdp.ev("document.querySelector('#promptInput').value");
    allTpl.push(v);
    const hit = BANNED.filter((w) => v.includes(w));
    check(`模板 ${t} 无禁词`, hit.length === 0, hit.join(","));
  }

  /* ---------------- 2. 输入禁词 → 立刻警告 ---------------- */
  console.log("\n[2] 打禁词时是否当场提示（而不是等生成失败）");
  await setPrompt("今日实拍，随手一拍就是大片\n最佳机位在观景台，建议日落前一小时到");
  await sleep(300);
  const note = JSON.parse(await cdp.ev(`JSON.stringify({
    hidden: document.querySelector('#adLawNote').hidden,
    cls: document.querySelector('#adLawNote').className,
    text: document.querySelector('#adLawNote').innerText,
    hasFix: !!document.querySelector('#adLawFix'),
  })`));
  check("警告条出现", note.hidden === false);
  check("标为硬禁（红色）", note.cls.includes("hard"), note.cls);
  check("指出了具体是哪个词", note.text.includes("最佳"), note.text.replace(/\s+/g, " ").slice(0, 60));
  check("提供了一键改写按钮", note.hasFix === true);

  // 出图前的本地预检必须拦住，不能白跑一次渲染。
  // 注意：模型就绪时 doGenerate 会先跑「模型写文案」（15~25 秒），之后才轮到预检 ——
  // 所以必须轮询等。早先固定 sleep 2.5 秒，读到空报错框，误判成"没给拦截说明"。
  const before = await cdp.ev("document.querySelector('#resultImg').getAttribute('src') || ''");
  await cdp.ev("document.querySelector('#genBtn').click()");
  let guard = { errShown: false, errText: "", img: before };
  for (let i = 0; i < 200; i++) {
    await sleep(700);
    guard = JSON.parse(await cdp.ev(`JSON.stringify({
      errShown: document.querySelector('#resultErr').style.display !== 'none',
      errText: document.querySelector('#resultErr').textContent,
      img: document.querySelector('#resultImg').getAttribute('src') || '',
    })`));
    if (guard.errShown && guard.errText) break;
    if (guard.img && guard.img !== before) break;   // 出图了 = 没被拦住
  }
  check("没有把带禁词的文案提交给渲染器", guard.img === before, `img 未变（${guard.img ? "仍是旧图" : "仍为空"}）`);
  check("当场给出了拦截说明", guard.errShown && /禁用词/.test(guard.errText),
    guard.errText.replace(/\s+/g, " ").slice(0, 70));
  check("说明了为什么没提交", /没有浪费一次渲染/.test(guard.errText),
    guard.errText.replace(/\s+/g, " ").slice(-60));

  /* ---------------- 3. 一键改写 ---------------- */
  console.log("\n[3] 一键改写是否真的能过");
  await cdp.ev("document.querySelector('#adLawFix').click()");
  await sleep(1200);
  const after = JSON.parse(await cdp.ev(`JSON.stringify({
    text: document.querySelector('#promptInput').value,
    hidden: document.querySelector('#adLawNote').hidden,
    note: document.querySelector('#adLawNote').innerText,
  })`));
  const stillBanned = BANNED.filter((w) => after.text.includes(w));
  check("禁词已被换掉", stillBanned.length === 0, stillBanned.join(",") || `现在是「${after.text.split("\n")[1] || ""}」`);
  check("改写后警告消失", after.hidden === true, after.note.slice(0, 40));

  /* ---------------- 4. 打卡模板真实链路能出图 ---------------- */
  console.log("\n[4] 用户实际卡住的那条路：打卡模板 → 出图");
  // 关键：先清掉上一步留下的报错与旧图。
  // 否则轮询会在第一圈就读到步骤 2 那条"禁用词"错误，误判成打卡也失败了
  //（这个假失败我自己踩了一次）。
  await cdp.ev(`(() => {
    const err = document.querySelector('#resultErr');
    err.textContent = '';
    err.style.display = 'none';
    const img = document.querySelector('#resultImg');
    img.removeAttribute('src');
    return true;
  })()`);
  await sleep(300);
  // 切到打卡模式
  await cdp.ev(`(() => {
    const btns = Array.from(document.querySelectorAll('#capMenu button'));
    const b = btns.find(x => /打卡/.test(x.textContent));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(600);
  // 用游客打卡模板（已修好的那份）
  await cdp.ev("document.querySelector('#promptClear').click()");
  await cdp.ev(`document.querySelector('.mini-chip[data-tpl="checkin"]').click()`);
  await sleep(300);
  const checkinText = await cdp.ev("document.querySelector('#promptInput').value");
  console.log("  模板内容:", checkinText.replace(/\n/g, " / "));
  check("打卡模板也不含禁词", BANNED.filter((w) => checkinText.includes(w)).length === 0);

  // 传一张照片再出图
  const photo = path.join(OUT, "poster-bg-test.jpg");
  if (existsSync(photo)) {
    const b64 = (await readFile(photo)).toString("base64");
    await cdp.ev(`(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], '打卡照片.jpg', { type: 'image/jpeg' }));
      const input = document.querySelector('#fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`, true);
    for (let i = 0; i < 100; i++) {
      await sleep(300);
      const n = await cdp.ev("window.posterforge.state.files.filter(f => f.uploaded && f.url).length").catch(() => 0);
      if (n > 0) break;
    }
  }

  const imgBefore = await cdp.ev("document.querySelector('#resultImg').getAttribute('src') || ''");
  await cdp.ev("document.querySelector('#genBtn').click()");
  let genOk = false, errText = "";
  for (let i = 0; i < 200; i++) {
    await sleep(700);
    const st = JSON.parse(await cdp.ev(`JSON.stringify({
      img: document.querySelector('#resultImg').getAttribute('src') || '',
      errShown: document.querySelector('#resultErr').style.display !== 'none',
      err: document.querySelector('#resultErr').textContent,
    })`).catch(() => "{}"));
    // 先看有没有出新图 —— 新图优先，报错框可能是上一轮残留
    if (st.img && st.img !== imgBefore) { genOk = true; break; }
    if (st.errShown && st.err) { errText = st.err; break; }
  }
  check("打卡模板出图成功（不再被广告法拦）", genOk, genOk ? "" : errText.replace(/\s+/g, " ").slice(0, 120));

  // 图片真的解码了吗
  if (genOk) {
    const decoded = await cdp.ev(`(async () => {
      const i = document.getElementById('resultImg');
      if (!i.complete) await i.decode().catch(() => {});
      return i.naturalWidth > 0;
    })()`, true);
    check("结果图能正常解码显示", decoded === true);
  }

  await writeFile(
    path.join(OUT, "adlaw-page.png"),
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
