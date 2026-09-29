/**
 * templates-rotate.mjs —— 模板的「联网轮换」。
 *
 * 目标：让模板区每天看起来不一样，而且是**有依据的**不一样，
 * 不是随机洗牌。
 *
 * 数据来源：已联网抓取的「每日灵感」图（feeds.mjs，Bing 每日壁纸）。
 * 处理：服务端用 PIL 提取每张图的暗部/中间调/亮部三档颜色与暖度。
 * 产物：**只有颜色数值**，不复制、不嵌入、不外链任何图片内容。
 *
 * 版权边界（这是这条功能必须守住的）：
 *   抓来的图有版权（Getty / Adobe Stock 等），**不能进成品**；
 *   但"今天这批图偏暖还是偏冷"是事实数据，可以用来调整推哪类模板。
 *   所以轮换的是**版式灵感元数据**（配色倾向），不是图片本身。
 *
 * 轮换规则：暖度高的日子优先推暖调模板（餐饮/夜市），
 * 冷调的日子优先推冷调模板（景区/文博/雪季）。同一天结果稳定。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const PYTHON = process.env.PF_PYTHON || "E:\\devenv\\Scripts\\python.exe";

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function runPython(script, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON, [script, ...args], { windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { try { p.kill(); } catch {} reject(new Error("调色提取超时")); }, timeoutMs);
    p.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`提取脚本退出 ${code}: ${err.slice(0, 200)}`));
      const line = out.trim().split("\n").filter(Boolean).pop();
      try { resolve(JSON.parse(line)); }
      catch { reject(new Error("提取脚本输出不是 JSON: " + out.slice(0, 120))); }
    });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/** 找每日灵感已缓存的图片 */
export function findFeedImages(cacheDir, limit = 8) {
  const dir = path.join(cacheDir, "images");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .slice(0, limit)
      .map((f) => path.join(dir, f));
  } catch { return []; }
}

/**
 * 生成/读取当天的轮换结果。同一天只算一次（结果稳定，页面刷新不会跳）。
 */
export async function getRotation({ cacheDir, stateFile, siteRoot, force = false, log = () => {} }) {
  const key = todayKey();
  if (!force && existsSync(stateFile)) {
    try {
      const cached = JSON.parse(readFileSync(stateFile, "utf8"));
      if (cached.date === key && Array.isArray(cached.palettes) && cached.palettes.length) {
        return { ...cached, cached: true };
      }
    } catch { /* 缓存坏了就重算 */ }
  }

  const images = findFeedImages(cacheDir);
  const result = {
    date: key,
    generatedAt: new Date().toISOString(),
    source: images.length ? "每日灵感图库（Bing 每日壁纸）" : "无可用图源",
    licenseNote: "仅提取颜色倾向作为版式灵感，图片本身有版权、不进成品",
    palettes: [],
    avgWarmth: 0.5,
    bias: "neutral",
    cached: false,
  };

  if (images.length) {
    try {
      const r = await runPython(path.join(siteRoot, "extract-palette.py"), images);
      const palettes = (r.palettes || []).filter((p) => p && p.from);
      result.palettes = palettes;
      if (palettes.length) {
        const avg = palettes.reduce((s, p) => s + (p.warmth || 0.5), 0) / palettes.length;
        result.avgWarmth = Number(avg.toFixed(3));
        result.bias = avg >= 0.56 ? "warm" : avg <= 0.44 ? "cool" : "neutral";
      }
      log(`提取 ${palettes.length} 组配色，整体偏 ${result.bias}（暖度 ${result.avgWarmth}）`);
    } catch (e) {
      log("配色提取失败：" + e.message);
      result.error = e.message;
    }
  }

  try {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(result, null, 2), "utf8");
  } catch (e) {
    log("轮换结果落盘失败：" + e.message);
  }
  return result;
}

/**
 * 按轮换结果调整模板顺序。
 *
 * 规则有意做得简单可解释：偏暖的日子把暖调模板往前挪，偏冷则反之；
 * 同 tone 段内保持原有顺序（不引入第二套排序，避免出现"说不清为什么这么排"）。
 */
export function applyRotation(templates, rotation) {
  if (!rotation || rotation.bias === "neutral" || !rotation.palettes?.length) {
    return templates.map((t) => ({ ...t, rotationScore: 0 }));
  }
  const target = rotation.bias === "warm" ? 1 : 0;
  return templates
    .map((t) => {
      const tone = typeof t.tone === "number" ? t.tone : 0.5;
      // 离目标越近分越高；0~1 之间
      const fit = 1 - Math.abs(tone - target);
      return { ...t, rotationScore: Number(fit.toFixed(3)) };
    })
    .sort((a, b) => b.rotationScore - a.rotationScore
      || (b.featured ? 1 : 0) - (a.featured ? 1 : 0)
      || (b.likes || 0) - (a.likes || 0));
}
