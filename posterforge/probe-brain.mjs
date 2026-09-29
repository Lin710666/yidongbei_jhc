#!/usr/bin/env node
/**
 * probe-brain.mjs —— 先摸清本机可用的"文案大脑"到底能不能干活，再决定架构。
 *
 * 实测三件事：
 *   1. 纯文本模型（qwen2.5:7b / qwen3:8b）读用户的"要求"，能不能吐出结构化 JSON
 *   2. 视觉模型（qwen2.5vl:3b）看图后能不能说出"这张图是什么"，并据此写文案
 *   3. 响应时间 —— 决定这条链路能不能放在"点生成"的同步流程里
 *
 * 不猜、不假设：每个模型都真跑一遍，把原始输出打出来。
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OLLAMA = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

const SYS = `你是一个中文海报文案策划。用户会给你一句"要求"，你要输出海报上真正要印的字。
必须只输出 JSON，不要输出任何解释、不要用 markdown 代码块。字段：
{"title":"主标题，8-14个字，要具体到地点或卖点，不要写"限时特惠"这类空话","sub":"副标题，1-2行，每行不超过16字，用\\n分隔","tags":["2-4个短标签"],"tone":"热度 0-1 的小数","kind":"tourism|food|stay|event|sale 之一"}
禁止把用户的要求原样当作标题（例如"帮我生成…"这类话不能出现在标题里）。
禁止编造具体数字（价格、电话、销量），除非用户给了。`;

const cases = [
  {
    name: "纯文本 · 用户原话（要求式）",
    model: "qwen2.5:7b",
    prompt: "用户要求：帮我融合这两张图片并配上去西湖的旅游文案",
  },
  {
    name: "纯文本 · 实情式",
    model: "qwen2.5:7b",
    prompt: "用户要求：山海楼酒店秋季促销，住三晚送一晚，全海景房含双早，电话 0592-8888-6666",
  },
  {
    name: "纯文本 · qwen3 8b 要求式",
    model: "qwen3:8b",
    prompt: "用户要求：帮我做一张本周末开市的市集活动海报，有 20 个摊位",
  },
];

async function chat(model, messages, { json = true, numPredict = 400 } = {}) {
  const t0 = Date.now();
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      format: json ? "json" : undefined,
      options: { temperature: 0.7, num_predict: numPredict },
    }),
  });
  const j = await r.json().catch(() => ({}));
  return { ms: Date.now() - t0, content: j.message?.content || "", err: j.error || null };
}

async function main() {
  for (const c of cases) {
    console.log(`\n=== ${c.name} (${c.model}) ===`);
    try {
      const out = await chat(c.model, [
        { role: "system", content: SYS },
        { role: "user", content: c.prompt },
      ]);
      console.log(`  ${(out.ms / 1000).toFixed(1)}s`);
      if (out.err) { console.log("  错误:", out.err); continue; }
      console.log("  原始输出:", out.content.slice(0, 400).replace(/\n/g, " "));
      try {
        const j = JSON.parse(out.content);
        console.log("  ✓ JSON 可解析");
        console.log("    title:", JSON.stringify(j.title));
        console.log("    sub:", JSON.stringify(j.sub));
        console.log("    tags:", JSON.stringify(j.tags), " kind:", j.kind, " tone:", j.tone);
      } catch (e) {
        console.log("  ✗ JSON 解析失败:", e.message);
      }
    } catch (e) {
      console.log("  请求失败:", e.message);
    }
  }

  /* ---------------- 视觉模型：看图 ---------------- */
  const photo = path.join(__dirname, ".work", "poster-bg-test.jpg");
  if (existsSync(photo)) {
    console.log(`\n=== 视觉 · qwen2.5vl:3b 读图 ===`);
    const b64 = (await readFile(photo)).toString("base64");
    try {
      const out = await chat("qwen2.5vl:3b", [
        {
          role: "user",
          content:
            "这张图片里有什么？用一句中文说清主体、颜色和氛围（不超过 30 字）。然后另起一行写一个适合它的海报标题（不超过 14 字）。",
          images: [b64],
        },
      ], { json: false, numPredict: 200 });
      console.log(`  ${(out.ms / 1000).toFixed(1)}s`);
      console.log("  输出:", out.content.trim().slice(0, 300));
    } catch (e) {
      console.log("  请求失败:", e.message);
    }
  } else {
    console.log("\n(缺少测试图，跳过视觉检查)");
  }

  console.log("\n=== 已安装模型 ===");
  const tags = await (await fetch(`${OLLAMA}/api/tags`)).json();
  for (const m of tags.models || []) {
    console.log(`  ${m.name.padEnd(24)} ${(m.size / 1e9).toFixed(1)} GB`);
  }
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
