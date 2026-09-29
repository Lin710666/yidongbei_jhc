#!/usr/bin/env node
/**
 * verify-vision-parse.mjs —— 视觉模型输出的解析必须扛得住真实脏输出。
 *
 * 用例全部来自实测原始输出（不是我编的）：
 *   3B 视觉模型会把提示词抄回来、把主题并进第一行、两行写成同一句。
 * 这些如果没清理干净，就会当成"画面描述"喂给文案模型，
 * 写出来的文案会带上提示词味（用户看到的就是"我的提示词出现在文案里"）。
 */
import { parseVisionText } from "./brain.mjs";

const CASES = [
  {
    name: "把提示词抄回来（真实输出）",
    raw: "第1行：画面主体 + 氛围，20 字以内：实拍风景，色彩鲜艳，氛围活泼。\n第2行：这张照片适合做成什么主题，12 字以内：旅行风景，色彩搭配。\n第3行：能。",
    wantScene: "实拍风景，色彩鲜艳，氛围活泼。",
    wantTheme: "旅行风景，色彩搭配。",
  },
  {
    name: "带标签的两行（真实输出）",
    raw: "画面主体：汉服博物馆的走廊，氛围：古色古香，红灯笼。  \n这张照片适合做成汉服文化主题。",
    wantScene: "汉服博物馆的走廊，氛围：古色古香，红灯笼。",
    wantTheme: "汉服文化主题。",
  },
  {
    name: "主题并进第一行（真实输出）",
    raw: "彩色方块，氛围：活泼。这张照片适合做成：创意设计。",
    wantScene: "彩色方块，氛围：活泼。",
    wantTheme: "创意设计。",
  },
  {
    name: "两行写成同一句（真实输出）",
    raw: "夕阳下的海面，宁静而美丽。  \n夕阳下的海面，宁静而美丽。",
    wantScene: "夕阳下的海面，宁静而美丽。",
    wantTheme: "",
  },
  {
    name: "新提示词格式（带 主体:/主题:）",
    raw: "主体：夕阳下的海面，波光粼粼，宁静\n主题：海边日落",
    wantScene: "夕阳下的海面，波光粼粼，宁静",
    wantTheme: "海边日落",
  },
  {
    name: "带序号前缀",
    raw: "1) 五色方块，色彩鲜艳\n2) 色彩主题",
    wantScene: "五色方块，色彩鲜艳",
    wantTheme: "色彩主题",
  },
];

let bad = 0;
for (const c of CASES) {
  const r = parseVisionText(c.raw);
  const okScene = r.scene === c.wantScene;
  const okTheme = r.theme === c.wantTheme;
  const ok = okScene && okTheme;
  if (!ok) bad++;
  console.log(`${ok ? "✓" : "✗"} ${c.name}`);
  console.log(`    scene = ${JSON.stringify(r.scene)}`);
  console.log(`    theme = ${JSON.stringify(r.theme)}`);
  if (!ok) {
    console.log(`    期望 scene=${JSON.stringify(c.wantScene)} theme=${JSON.stringify(c.wantTheme)}`);
  }
}

// 关键回归：解析结果里不能再出现提示词自己的字样
const LEAK = /第[一二三四1234]行|画面主体|字以内|这张照片适合做成什么主题|不要序号|例如：/;
for (const c of CASES) {
  const r = parseVisionText(c.raw);
  const blob = r.scene + "|" + r.theme;
  const leaked = LEAK.test(blob);
  if (leaked) {
    bad++;
    console.log(`✗ 提示词残留：${JSON.stringify(blob)}`);
  }
}
console.log(bad === 0 ? "\n全部通过 ✓" : `\n${bad} 项未通过 ✗`);
process.exit(bad === 0 ? 0 : 1);
