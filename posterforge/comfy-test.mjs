#!/usr/bin/env node
/**
 * comfy-test.mjs —— 验证 ComfyUI 客户端与真实 Qwen-Image-2.1 工作流。
 *
 * 分级测试，便于定位问题出在哪一层：
 *   1. 探活 + 环境
 *   2. 模型文件可见性（"文件放错目录"最常见）
 *   3. 真实生成（最重：要加载 15 GB 权重，8 GB 显存有 OOM 风险）
 *
 * 用法：
 *   node comfy-test.mjs              # 默认 512x512 快速试
 *   node comfy-test.mjs --size 1024  # 官方推荐尺寸
 *   node comfy-test.mjs --skip-gen   # 只测 1、2 层
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  systemStats, checkModels, generateImage, isUp,
  buildQwenT2IWorkflow, DEFAULT_MODELS, LIGHT_CLIP, ComfyError,
} from "./comfy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, ".work");

const args = process.argv.slice(2);
const argOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SIZE = Number(argOf("--size", 512));
const SKIP_GEN = args.includes("--skip-gen");
const TIMEOUT_MS = Number(argOf("--timeout", 900)) * 1000;

console.log("=".repeat(62));
console.log("  ComfyUI 客户端测试");
console.log("=".repeat(62));

// ---- 1. 探活 ----
console.log("\n[1/3] 探活 ...");
if (!(await isUp())) {
  console.error("  ✗ ComfyUI 未运行。请先启动：");
  console.error("      E:\\ComfyUI_windows_portable\\启动ComfyUI-低显存.bat");
  process.exit(1);
}
const st = await systemStats();
console.log(`  ✓ ComfyUI ${st.version} · Python ${st.python}`);
console.log(`  ✓ 设备 ${st.device} · 显存 ${st.vramTotalGB} GB（空闲 ${st.vramFreeGB} GB）`);
if (st.vramTotalGB && st.vramTotalGB < 10) {
  console.log(`  ⚠ 显存 < 10 GB：Qwen-Image-2.1 三件套约 16 GB，必须靠 --lowvram 换入换出`);
}

// ---- 2. 模型可见性 ----
console.log("\n[2/3] 模型文件可见性 ...");
const cm = await checkModels();
const show = (label, r) => {
  console.log(`  ${r.found ? "✓" : "✗"} ${label}: ${r.want}`);
  if (!r.found) {
    console.log(`      但 ComfyUI 可见的是: ${r.available.join(", ") || "(空)"}`);
    console.log(`      → 检查 extra_model_paths.yaml 与文件是否真在 D:\\ComfyUI-models`);
  }
};
show("UNET  主干", cm.unet);
show("CLIP  文本编码器", cm.clip);
show("VAE", cm.vae);
console.log(`  ${cm.hasTextEncode ? "✓" : "✗"} TextEncodeQwenImage21 节点存在`);
if (!cm.unet.found || !cm.clip.found || !cm.vae.found) {
  console.error("\n  ✗ 模型不全，无法生成。先修好文件放置再跑。");
  process.exit(1);
}

// 打印将要提交的工作流结构（便于人工核对拓扑）
console.log("\n  将要提交的工作流（官方模板拓扑）:");
const wf = buildQwenT2IWorkflow({ prompt: "test", width: SIZE, height: SIZE });
for (const [id, node] of Object.entries(wf)) {
  const ins = Object.entries(node.inputs)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? `←#${v[0]}[${v[1]}]` : JSON.stringify(v).slice(0, 26)}`)
    .join(" ");
  console.log(`    #${id} ${node.class_type}  ${ins}`);
}

if (SKIP_GEN) {
  console.log("\n  （--skip-gen：跳过真实生成）");
  process.exit(0);
}

// ---- 3. 真实生成 ----
console.log(`\n[3/3] 真实生成 ${SIZE}x${SIZE}（首次要加载 ~15 GB 权重，可能较慢）...`);
console.log(`  超时上限 ${TIMEOUT_MS / 1000} 秒`);

const prompt = [
  "海边日落背景，暖橙与深青渐变，柔焦虚化远景，",
  "画面下半部留出大面积干净区域以便叠加文字，",
  "柔和光线，电影感，无文字，无 logo，无水印",
].join("");

const t0 = Date.now();
try {
  const r = await generateImage(
    {
      prompt,
      negativePrompt: "文字, 水印, logo, 人物, 杂乱",
      width: SIZE,
      height: SIZE,
      steps: 25,
      cfg: 1,
      seed: 42,
      filenamePrefix: "posterforge_test",
    },
    {
      timeoutMs: TIMEOUT_MS,
      onTick: ({ note, elapsedMs }) =>
        console.log(`    ${(elapsedMs / 1000).toFixed(0)}s  ${note}`),
    }
  );

  await mkdir(OUT, { recursive: true });
  const file = path.join(OUT, `comfy-qwen-${SIZE}.png`);
  await writeFile(file, r.buffer);
  console.log("\n  ✓ 生成成功");
  console.log(`    耗时     ${(r.elapsedMs / 1000).toFixed(1)} 秒`);
  console.log(`    文件     ${r.filename}（共 ${r.imageCount} 张，取第 1 张）`);
  console.log(`    大小     ${(r.buffer.length / 1024).toFixed(0)} KB`);
  console.log(`    PNG 魔数 ${r.buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"}`);
  console.log(`    已存     ${file}`);
} catch (e) {
  const stage = e instanceof ComfyError ? e.stage : "unknown";
  console.error(`\n  ✗ 生成失败（阶段：${stage}，耗时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  console.error(`    ${e.message}`);
  if (e.detail) console.error(`    详情: ${e.detail}`);
  console.error("\n  可能原因：");
  console.error("    · 显存不足（8 GB 跑 7B 主干 + 8B 编码器本就紧张）");
  console.error("      → 换小编码器：" + LIGHT_CLIP + "（省 2.8 GB）");
  console.error("      → 或降低分辨率，并确保用低显存启动参数");
  console.error("    · 权重加载超时 → 增大 --timeout");
  process.exit(1);
}
