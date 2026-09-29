#!/usr/bin/env node
/**
 * verify-formats.mjs —— 端到端验格式：上传 → 转正/转码 → 渲染。
 *
 * 为什么不能只验上传：上传收下了但渲染器打不开，等于把坏文件骗进系统，
 * 用户会在"生成"那一步才炸，而且报错跟他上传的图对不上。
 * 所以每种格式都真的走一次 /api/generate，用上传结果当背景图。
 *
 * 覆盖：PNG / JPEG / WebP / GIF / BMP / TIFF / AVIF(PIL) / HEIC(PyAV 转码)
 * 另外验：伪装文件（文本改名 .png）必须被拒，不能只是收下了事。
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8800";
const PY = "E:\\devenv\\Scripts\\python.exe";
const COMFY_PY = "E:\\ComfyUI_windows_portable\\python_embeded\\python.exe";
const FMT = path.join(__dirname, ".work", "fmt");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); }
};

function buildSamples() {
  execFileSync(PY, ["-c", `
import os
from PIL import Image
d = r"${FMT}"
os.makedirs(d, exist_ok=True)
im = Image.new("RGB", (640, 480), (200, 40, 90))
for fmt, ext in [("PNG",".png"),("WEBP",".webp"),("BMP",".bmp"),("TIFF",".tiff"),("GIF",".gif"),("JPEG",".jpg"),("AVIF",".avif")]:
    try: im.save(os.path.join(d, "v"+ext), fmt)
    except Exception: pass
print("ok")
`], { encoding: "utf8" });
}

async function upload(name, buf) {
  const r = await fetch(BASE + "/api/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: [{ name, dataUrl: `data:application/octet-stream;base64,${buf.toString("base64")}` }] }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: j.ok === true, file: j.files?.[0] || null, errors: j.errors || [] };
}

async function renderWith(bgRelPath, label) {
  const spec = {
    meta: { id: "fmt-test", facts_source: "自动化测试" },
    canvas: { width: 540, height: 720 },
    theme: { palette: { bgFrom: "#0b2a30", bgTo: "#1d5f66", ink: "#ffffff", gold: "#e8c37a" } },
    background: { type: "image", image: bgRelPath, blobs: [] },
    layers: [
      { type: "text", name: "t", text: label, x: 0.08, y: 0.10, font: "bold", size: 34, color: "ink" },
    ],
  };
  const r = await fetch(BASE + "/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: j.ok === true, url: j.url || null, error: j.error || j.message || null };
}

async function main() {
  buildSamples();
  console.log(`上传+渲染端到端: ${BASE}\n`);

  const cases = [
    ["PNG", "v.png"],
    ["JPEG", "v.jpg"],
    ["WebP", "v.webp"],
    ["GIF", "v.gif"],
    ["BMP", "v.bmp"],
    ["TIFF", "v.tiff"],
    ["AVIF", "v.avif"],
  ];

  for (const [label, file] of cases) {
    const p = path.join(FMT, file);
    if (!existsSync(p)) { console.log(`  — ${label}: 本机生成不出样本，跳过`); continue; }
    const buf = await readFile(p);
    const up = await upload(`测试.${file.split(".").pop()}`, buf);
    if (!up.ok) { check(`${label} 上传`, false, up.errors.map((e) => e.reason).join("；")); continue; }
    const rel = up.file.url.replace(/^\//, "");
    const g = await renderWith(rel, `${label} 渲染`);
    check(`${label} 全链路`, g.ok, g.ok ? rel : (g.error || "").slice(0, 120));
  }

  // HEIC：用合成样本（真 iPhone HEIC 本机没有，样本是 HEVC 编码 + heic 品牌头）
  const heic = path.join(FMT, "synth-heic.heic");
  if (existsSync(heic)) {
    const up = await upload("手机照片.heic", await readFile(heic));
    if (up.ok) {
      check("HEIC 被转码成 JPEG", up.file.url.endsWith(".jpg"),
        `${up.file.url}（原始 mime ${up.file.convertedFrom || "-"}，归一化 ${up.file.normalized}）`);
      const g = await renderWith(up.file.url.replace(/^\//, ""), "HEIC 渲染");
      check("HEIC 转码后能渲染", g.ok, g.ok ? up.file.url : (g.error || "").slice(0, 120));
    } else {
      check("HEIC 上传", false, up.errors.map((e) => e.reason).join("；"));
    }
  }

  // 伪装文件必须拒（不能只收下不验）
  const fake = Buffer.from("这不是图片，只是一段文字。".repeat(30), "utf8");
  const fp = await upload("假的.png", fake);
  check("伪装成 PNG 的文本被拒", fp.ok === false, fp.errors.map((e) => e.reason).join("；").slice(0, 80));

  // 有头但解不开的文件也必须拒
  const brokenHeic = Buffer.alloc(64);
  brokenHeic.writeUInt32BE(64, 0);
  brokenHeic.write("ftyp", 4, "ascii");
  brokenHeic.write("heic", 8, "ascii");
  const bh = await upload("坏.heic", brokenHeic);
  check("有 HEIC 头但解不开的文件被拒", bh.ok === false,
    bh.ok ? "⚠ 被收下了 —— 会在生成阶段才炸" : bh.errors.map((e) => e.reason).join("；").slice(0, 80));

  console.log(`\n${failures === 0 ? "全部通过 ✓" : failures + " 项未通过 ✗"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
