#!/usr/bin/env node
/**
 * verify-compose.mjs —— 验收"大模型决定生成什么"这条链路。
 *
 * 要证的事：
 *   1. 用户那句"要求"不会被原样印上海报（旧 bug 的正面回归）
 *   2. 文案确实来自模型，而不是站内模板库 —— 用"换个输入文案就变"来证
 *   3. 模型真的看了图 —— 换一张内容不同的图，文案跟着变
 *   4. 模型输出违规时（超长/带指令词/挑不存在的 layout）系统能挡住或收敛
 *   5. 全链路出图成功，且版面几何来自共用模块（服务端/浏览器同源）
 *
 * 用法：node verify-compose.mjs [baseUrl]
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8800";
const OUT = path.join(__dirname, ".work");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
};

async function upload(name, buf) {
  const r = await fetch(BASE + "/api/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: [{ name, dataUrl: `data:application/octet-stream;base64,${buf.toString("base64")}` }] }),
  });
  const j = await r.json();
  return j.files?.[0]?.url || null;
}

async function compose(body) {
  const t0 = Date.now();
  const r = await fetch(BASE + "/api/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ms: Date.now() - t0, ...j };
}

const REQUEST_WORDS = /帮我|请(你|帮)?|麻烦|生成|制作|设计|排版|融合|合成|拼接|配上|做一张|做张|出一张|给我/;

async function main() {
  console.log(`大模型生成链路: ${BASE}\n`);

  const brain = await (await fetch(BASE + "/api/brain")).json();
  console.log(`大脑状态: ${brain.ready ? "就绪" : "不可用"} | 读图 ${brain.vision} | 文案 ${brain.copy}`);
  console.log(`模型清单: ${(brain.models || []).join(", ")}\n`);
  if (!brain.ready) {
    console.log("模型不可用，后续测试会失败。先确认 `ollama serve` 在跑。");
  }

  /* ---------------- 1. 用户原话不进海报 ---------------- */
  console.log("[1] 「要求」不会被印上海报");
  const photoA = path.join(OUT, "poster-bg-test.jpg");
  const photoB = path.join(__dirname, "public", "bg", "seaside-sunset.jpg");
  if (!existsSync(photoA)) { console.log("缺少测试图 " + photoA); process.exit(1); }

  const urlA = await upload("几何色块.jpg", await readFile(photoA));
  const urlB = existsSync(photoB) ? await upload("海边日落.jpg", await readFile(photoB)) : null;
  check("测试图已上传", !!urlA, urlA || "");

  const brief1 = "帮我融合这两张图片并配上去西湖的旅游文案";
  const r1 = await compose({ brief: brief1, photos: [urlA].filter(Boolean), facts: {} });
  console.log(`  ${(r1.ms / 1000).toFixed(1)}s  status=${r1.status}`);
  if (r1.ok) {
    console.log("  模型产出:", JSON.stringify(r1.modelCopy));
    check("标题不是用户那句要求", !REQUEST_WORDS.test(r1.copy.title || ""), `title=${JSON.stringify(r1.copy.title)}`);
    check("标题与要求不重合", !brief1.includes(r1.copy.title || "@@"), `title=${r1.copy.title}`);
    check("标题长度合理（4-20）", (r1.copy.title || "").length >= 4 && (r1.copy.title || "").length <= 20,
      `${(r1.copy.title || "").length} 字`);
    check("layout 在白名单内", ["poster_text", "poster_photo_bg", "poster_photo_strip"].includes((r1.copy.layout || "").trim()),
      JSON.stringify(r1.copy.layout));
    check("渲染成功", !!r1.url, r1.url || r1.error || "");
    check("服务端校验通过", !r1.validation || /通过/.test(r1.validation), "");
    check("模型给出了理由", !!r1.modelCopy?.reason, (r1.modelCopy?.reason || "").slice(0, 50));
  } else {
    check("第一次生成", false, JSON.stringify(r1).slice(0, 200));
  }

  /* ---------------- 2. 文案确实来自模型（换输入就变） ---------------- */
  console.log("\n[2] 换一个输入，文案必须跟着变（证明不是模板库）");
  const r2 = await compose({ brief: "厦门环岛路的海边民宿，只有 6 间房，含双早，电话 13900001111", photos: [urlA] });
  console.log(`  ${(r2.ms / 1000).toFixed(1)}s`);
  if (r2.ok) {
    console.log("  模型产出:", JSON.stringify(r2.modelCopy));
    check("与上一次文案不同", r2.copy.title !== r1.copy.title,
      `${JSON.stringify(r1.copy.title)} → ${JSON.stringify(r2.copy.title)}`);
    check("硬事实电话被采纳", (r2.copy.phone || "").includes("13900001111"), r2.copy.phone || "(空)");
    check("没编造价格（用户没给）", !r2.copy.price || /^\s*$/.test(r2.copy.price), r2.copy.price || "null");
  } else {
    check("第二次生成", false, JSON.stringify(r2).slice(0, 200));
  }

  /* ---------------- 3. 模型真的看了图 ---------------- */
  if (urlB) {
    console.log("\n[3] 换一张内容完全不同的图，文案应跟着变（证明真的读图了）");
    const r3 = await compose({ brief: "帮我做一张海报", photos: [urlB] });
    console.log(`  ${(r3.ms / 1000).toFixed(1)}s`);
    if (r3.ok) {
      console.log("  读图描述:", JSON.stringify(r3.scenes));
      console.log("  模型产出:", JSON.stringify(r3.modelCopy));
      check("给出了画面描述", (r3.scenes || []).length > 0 && !!r3.scenes[0].scene,
        r3.scenes?.[0]?.scene || "(无)");
      check("文案与只给色块时不同", r3.copy.title !== r1.copy.title,
        `${JSON.stringify(r1.copy.title)} → ${JSON.stringify(r3.copy.title)}`);
      // 海边日落那张，文案里出现与画面相关的字眼才算真读了图
      const blob = `${r3.copy.title} ${r3.copy.sub}`;
      check("文案用到了画面里的元素（海/日落/夕阳/光 之一）",
        /海|日落|夕阳|光|岛|浪|天/.test(blob), blob.slice(0, 40));
    } else {
      check("第三", false, JSON.stringify(r3).slice(0, 200));
    }
  } else {
    console.log("\n[3] (缺少海边日落图，跳过读图对比)");
  }

  /* ---------------- 4. 校验器能拦住坏输出 ---------------- */
  console.log("\n[4] 校验器对坏输出的处理");
  const mod = await import("./brain.mjs");
  const cases = [
    { name: "标题里带指令词", raw: JSON.stringify({ title: "帮我生成一张海报", sub: "x", layout: "poster_text" }) },
    { name: "layout 不在白名单", raw: JSON.stringify({ title: "正常标题在此", sub: "x", layout: "poster_evil" }) },
    { name: "缺 title", raw: JSON.stringify({ sub: "x", layout: "poster_text" }) },
    { name: "不是 JSON", raw: "抱歉，我不能这样做。" },
    { name: "价格写「面议」", raw: JSON.stringify({ title: "秋季上新活动", sub: "x", price: "面议", layout: "poster_text" }) },
    { name: "正常输出", raw: JSON.stringify({ title: "西湖今日实拍", sub: "风大记得带外套", tags: ["西湖"], layout: "poster_photo_bg", kind: "tourism", tone: 0.4 }) },
  ];
  for (const c of cases) {
    const v = mod.validateCopy(c.raw, { hasPhotos: 1, brief: c.brief || "" });
    if (c.name === "layout 不在白名单") {
      check(`${c.name} → 回落但记 error`, v.errors.length > 0 && ["poster_photo_bg"].includes(v.copy.layout),
        `errors=${v.errors.length} layout=${v.copy.layout}`);
    } else if (c.name === "标题里带指令词" || c.name === "缺 title" || c.name === "不是 JSON") {
      check(`${c.name} → 判为不合格`, v.ok === false, v.errors.join("；").slice(0, 60));
    } else if (c.name === "价格写「面议」") {
      check(`${c.name} → 价格被丢弃`, v.copy.price === null, `price=${JSON.stringify(v.copy.price)}`);
    } else {
      check(`${c.name} → 通过`, v.ok === true, `title=${v.copy.title}`);
    }
  }

  /* ---------------- 4b. 脏输出必须被洗干净 ---------------- */
  console.log("\n[4b] 模型常见的脏输出（都真的出现过）");
  const dirty = [
    { name: "layout 带空格", raw: { title: "厦门环岛路海边民宿", sub: "含双早", layout: "poster_photo_strip " }, want: "poster_photo_strip" },
    { name: "HTML 实体当换行", raw: { title: "多彩生活&nbsp;西湖之旅", sub: "漫步苏堤<br>赏湖光山色", layout: "poster_text" }, wantTitle: /^多彩生活 西湖之旅$/, wantSub: /漫步苏堤\n赏湖光山色/ },
    { name: "字面量 \\n 当换行", raw: { title: "夕阳海景", sub: "静享海风\\n品味宁静", layout: "poster_photo_bg" }, wantSub: /静享海风\n品味宁静/ },
    { name: "把 null 写进句子里", raw: { title: "日落海景", sub: "静享黄昏美景\n联系电话：null", layout: "poster_photo_bg" }, wantSubNot: /null/ },
    { name: "多图却选只显示一张的版式", photos: 2, raw: { title: "海边两张照片", sub: "看海", layout: "poster_text" }, want: "poster_photo_strip", wantErr: true },
    { name: "没图却选底图版式", photos: 0, raw: { title: "纯文字海报", sub: "无图", layout: "poster_photo_bg" }, want: "poster_text", wantErr: true },
  ];
  for (const d of dirty) {
    const photos = d.photos === undefined ? 1 : d.photos;
    const v = mod.validateCopy(JSON.stringify(d.raw), { hasPhotos: photos });
    if (d.want) {
      check(`${d.name} → layout=${d.want}`, v.copy.layout === d.want, `实际 ${v.copy.layout}`);
    } else if (d.wantTitle) {
      const okT = d.wantTitle.test(v.copy.title);
      const okS = !d.wantSub || d.wantSub.test(v.copy.sub);
      check(`${d.name} → 已修正`, okT && okS, `title=${JSON.stringify(v.copy.title)} sub=${JSON.stringify(v.copy.sub)}`);
    } else if (d.wantSub) {
      check(`${d.name} → 已修正`, d.wantSub.test(v.copy.sub || ""), `sub=${JSON.stringify(v.copy.sub)}`);
    } else if (d.wantSubNot) {
      check(`${d.name} → 字面 null 被清掉`, !d.wantSubNot.test(v.copy.sub || ""), `sub=${JSON.stringify(v.copy.sub)}`);
    }
    if (d.wantErr) {
      check(`${d.name} → 记了 error 供重试`, v.errors.length > 0, (v.errors[0] || "").slice(0, 60));
    }
  }

  /* ---------------- 4c. 编造事实必须被拦住 ---------------- */
  console.log("\n[4c] 编造价格/电话/地址（这是给用户埋雷，最严重）");
  const fabricate = [
    {
      name: "用户没给价格，模型编了 ￥599",
      brief: "厦门环岛路海边民宿，含双早",
      raw: { title: "环岛路海边6间房·双早特惠", sub: "海边独栋民宿", price: "￥599", layout: "poster_photo_bg" },
      wantOk: false, wantPrice: null,
    },
    {
      name: "用户给了价格，模型照用",
      brief: "厦门环岛路海边民宿，含双早，￥599 一晚",
      raw: { title: "环岛路海边民宿", sub: "含双早", price: "￥599", layout: "poster_photo_bg" },
      wantOk: true, wantPrice: "￥599",
    },
    {
      name: "用户没给电话，模型编了一个",
      brief: "西湖旅游海报",
      raw: { title: "西湖今日实拍", sub: "最美西湖", phone: "0571-88886666", layout: "poster_text" },
      wantOk: false, wantPhone: null,
    },
    {
      name: "用户给了电话，模型照用",
      brief: "西湖旅游海报，电话 13900001111",
      raw: { title: "西湖今日实拍", sub: "最美西湖", phone: "13900001111", layout: "poster_text" },
      wantOk: true, wantPhone: "13900001111",
    },
    {
      name: "用户没给地址，模型编了一个",
      brief: "西湖旅游海报",
      raw: { title: "西湖今日实拍", sub: "最美西湖", address: "杭州市西湖区文三路 100 号", layout: "poster_text" },
      wantOk: true, wantAddress: null,
    },
  ];
  for (const f of fabricate) {
    const v = mod.validateCopy(JSON.stringify(f.raw), { hasPhotos: 1, brief: f.brief });
    const parts = [];
    if (f.wantPrice !== undefined) parts.push(`price=${JSON.stringify(v.copy.price)}`);
    if (f.wantPhone !== undefined) parts.push(`phone=${JSON.stringify(v.copy.phone)}`);
    if (f.wantAddress !== undefined) parts.push(`address=${JSON.stringify(v.copy.address)}`);
    const okPrice = f.wantPrice === undefined || v.copy.price === f.wantPrice;
    const okPhone = f.wantPhone === undefined || v.copy.phone === f.wantPhone;
    const okAddr = f.wantAddress === undefined || v.copy.address === f.wantAddress;
    const okOk = f.wantOk === undefined || v.ok === f.wantOk;
    check(`${f.name} → ${f.wantOk === false ? "判不合格并丢弃" : "正常通过"}`,
      okPrice && okPhone && okAddr && okOk,
      `${parts.join(" ")} ok=${v.ok} ${v.fatal?.length ? "致命:" + v.fatal[0].slice(0, 40) : ""}`);
  }

  /* ---------------- 5. 版面几何来自共用模块 ---------------- */
  console.log("\n[5] 版面几何与浏览器同源");
  const L = await import("./public/poster-layout.mjs");
  const specText = L.buildPosterSpecFrom({ title: "T", sub: "S" }, { photoUrls: [], layout: "poster_text" });
  const specStrip = L.buildPosterSpecFrom({ title: "T", sub: "S" }, {
    photoUrls: ["/uploads/a.jpg", "/uploads/b.jpg"], layout: "poster_photo_strip",
  });
  const titleOf = (s) => s.layers.find((l) => l.name === "title");
  // 注意：无价格时用的是 plainNoPrice 那套版面（尾部上移、填住下半页），
  // 所以标题 y 不等于 POSTER_LAYOUT.plain.title。这里按"实际选中的表"来断言。
  const plainNoPrice = L.POSTER_LAYOUT.plainNoPrice || L.POSTER_LAYOUT.plain;
  check("无图时用 plain 系版面", titleOf(specText).y === plainNoPrice.title,
    `y=${titleOf(specText).y}（期望 ${plainNoPrice.title}）`);
  check("多图时用 strip 版面", titleOf(specStrip).y === L.POSTER_LAYOUT.strip.title, `y=${titleOf(specStrip).y}`);
  const stripImg = specStrip.layers.filter((l) => l.type === "image");
  check("strip 版面两张图都上版面", stripImg.length === 2, `${stripImg.length} 张`);
  const stripBottom = stripImg[0].box.box[1] + stripImg[0].box.size[1];
  check("标题不与图带重叠", titleOf(specStrip).y >= stripBottom,
    `标题 y=${titleOf(specStrip).y} 图带底=${stripBottom.toFixed(3)}`);
  check("tone 能切换调色板", L.toneFor(0.9).name === "热闹" && L.toneFor(0.1).name === "清冷");

  // 服务端返回的 spec 与模块算出来的一致
  if (r1.ok && r1.spec) {
    const sameTitleY = titleOf(r1.spec).y === titleOf(L.buildPosterSpecFrom(
      { title: r1.copy.title, sub: r1.copy.sub }, { photoUrls: [urlA], layout: r1.copy.layout, tone: r1.modelCopy?.tone }
    )).y;
    check("服务端 spec 与共用模块一致", sameTitleY, "");
  }

  console.log(`\n${failures === 0 ? "全部通过 ✓" : failures + " 项未通过 ✗"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
