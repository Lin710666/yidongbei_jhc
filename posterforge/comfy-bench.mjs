#!/usr/bin/env node
/**
 * comfy-bench.mjs —— 实测 ComfyUI 能不能按 Qwen-Image-2.1 出图，以及要多久。
 *
 * 为什么要实测：启动脚本里写的是 MiniMax-H3，磁盘上放的是 Qwen-Image-2.1，
 * 两套说法对不上；而且这是 8 GB 显存的 RTX 5060，能不能跑、跑多快只能试。
 * 站点要"没图时自己生成一张底图"，这个能力必须先证明可用。
 *
 * 用法：node comfy-bench.mjs [宽度] [高度] [步数]
 */

import { isUp, systemStats, checkModels, buildQwenT2IWorkflow, generateImage, DEFAULT_MODELS } from "./comfy.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, ".work");
const W = Number(process.argv[2] || 768);
const H = Number(process.argv[3] || 1024);
const STEPS = Number(process.argv[4] || 8);

const PROMPT =
  "西湖清晨薄雾，湖面平静，远处雷峰塔剪影，垂柳枝条，水墨画风格，柔和自然光，" +
  "no text, no watermark, clean composition, empty space at the bottom for typography";

async function main() {
  console.log("检查 ComfyUI ...");
  if (!(await isUp())) {
    console.error("ComfyUI 未运行（8188 不可达）");
    process.exit(1);
  }
  const st = await systemStats();
  const dev = st.devices?.[0] || {};
  console.log(`  版本 ${st.system?.comfyui_version} · ${dev.name}`);
  console.log(`  显存 总 ${(dev.vram_total / 1e9).toFixed(2)} GB / 空闲 ${(dev.vram_free / 1e9).toFixed(2)} GB`);

  const models = await checkModels();
  console.log("  模型:", JSON.stringify(models));
  const miss = Object.entries(models).filter(([, v]) => v === false || v?.ok === false);
  if (miss.length) {
    console.error("  缺模型:", miss.map(([k]) => k).join(","));
    process.exit(1);
  }

  console.log(`\n出图 ${W}x${H} · ${STEPS} 步 · Qwen-Image-2.1 INT8`);
  console.log("  （首次要换入权重，可能几分钟）");
  await mkdir(OUT, { recursive: true });
  const t0 = Date.now();
  let lastTick = 0;
  try {
    const res = await generateImage(
      { prompt: PROMPT, width: W, height: H, steps: STEPS, seed: 12345, filenamePrefix: "bench" },
      {
        timeoutMs: 1800000,
        onTick: (ms) => {
          // 每 20 秒报一次进度，别让它看起来像卡死
          if (ms - lastTick > 20000) { lastTick = ms; console.log(`  ... ${(ms / 1000).toFixed(0)}s`); }
        },
      }
    );
    const ms = Date.now() - t0;
    const buf = Buffer.isBuffer(res?.buffer) ? res.buffer : Buffer.isBuffer(res) ? res : null;
    if (!buf) {
      console.log("  返回值结构:", JSON.stringify(res).slice(0, 300));
    } else {
      const f = path.join(OUT, `bench-${W}x${H}-${STEPS}step.png`);
      await writeFile(f, buf);
      console.log(`\n  ✓ 成功 · ${(ms / 1000).toFixed(1)}s · ${(buf.length / 1024).toFixed(0)} KB`);
      console.log(`    已存 ${f}`);
    }
    const st2 = await systemStats();
    console.log(`  出图后显存空闲 ${(st2.devices?.[0]?.vram_free / 1e9).toFixed(2)} GB`);
  } catch (e) {
    console.error(`\n  ✗ 失败（${((Date.now() - t0) / 1000).toFixed(1)}s）: ${e.stage || ""} ${e.message}`);
    if (e.detail) console.error("  详情:", String(e.detail).slice(0, 800));
    process.exit(1);
  }
}
main().catch((e) => { console.error("异常:", e.message); process.exit(1); });
