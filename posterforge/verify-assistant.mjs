#!/usr/bin/env node
/**
 * verify-assistant.mjs -- 验证助手两条能力线：
 *   A. 走 HikiTravel 的 /api/chat/stream（人设 + 记忆）
 *   B. 走 PosterForge 的 /api/templates/search（模板检索）
 *
 * 为什么要单独验 A：本机模型首次调用要 ~100 秒（它自己 README 里写的），
 * 浏览器测试里等不起，所以放在这里单独跑、给足超时。
 */
const BASE = process.argv[2] || "http://127.0.0.1:8800";
let pass = 0, fail = 0;
const check = (n, ok, note = "") => { console.log(`  ${ok ? "[OK]" : "[X] "} ${n}${note ? "  " + note : ""}`); ok ? pass++ : fail++; };

console.log("[A] HikiTravel 助手（SSE 流式）");
const t0 = Date.now();
let text = "", events = 0, err = null;
try {
  const r = await fetch(BASE + "/wenlv/api/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "你好，用一句话介绍你自己" }),
    signal: AbortSignal.timeout(300000),
  });
  check("HTTP 200", r.ok, "status=" + r.status);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        events++;
        try {
          const ev = JSON.parse(raw);
          text += ev.delta ?? ev.text ?? ev.content ?? ev.message ?? "";
        } catch { /* 非 JSON 的 data 行忽略 */ }
      }
    }
  }
} catch (e) { err = e; }

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`   SSE 事件 ${events} 个，收到正文 ${text.length} 字，耗时 ${secs}s`);
if (err) console.log("   错误:", String(err.message).slice(0, 140));
if (text) console.log("   回复节选:", text.replace(/\s+/g, " ").slice(0, 150));
check("流里有事件", events > 0, `${events} 个`);
check("拿到了回复正文", text.trim().length > 4, `${text.trim().length} 字`);

console.log("\n[B] PosterForge 模板检索（助手的另一半能力）");
for (const q of ["海边日出的民宿", "夜市小吃街开街", "博物馆汉服体验"]) {
  try {
    const j = await (await fetch(BASE + "/api/templates/search?q=" + encodeURIComponent(q) + "&k=2")).json();
    const top = (j.results || [])[0];
    check(`「${q}」命中`, !!top, top ? `${top.title} (${top.score})` : "无结果");
  } catch (e) {
    check(`「${q}」`, false, String(e.message).slice(0, 60));
  }
}

console.log("\n[C] 两个系统的接口是否都能从门户这一个源访问到");
for (const [name, url] of [
  ["海报工坊健康检查", "/api/health"],
  ["模板库", "/api/templates"],
  ["智慧旅游健康检查", "/wenlv/api/health"],
  ["智慧旅游角色卡", "/wenlv/api/cards"],
]) {
  try {
    const r = await fetch(BASE + url);
    check(`${name} ${url}`, r.ok, "HTTP " + r.status);
  } catch (e) { check(`${name} ${url}`, false, String(e.message).slice(0, 50)); }
}

console.log(`\n${fail === 0 ? "全部通过" : fail + " 项未通过"}`);
process.exit(fail === 0 ? 0 : 1);
