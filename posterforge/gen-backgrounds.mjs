#!/usr/bin/env node
/**
 * gen-backgrounds.mjs —— 用 Qwen-Image-2.1 给模板生成真实照片背景
 *
 * 为什么需要：原来的 8 张模板是纯色渐变 + 文字，没有真实照片，
 * 看起来空、假。给每个模板配一张实拍感背景，观感提升最明显。
 *
 * 关键设计：
 *   • 尺寸用 **3:4 竖版（832×1120）**，与海报 1080×1440 同比例。
 *     之前生成 1024×1024 方图再裁成竖版，会丢掉构图与"文字留白区"，
 *     导致提示词里辛苦设计的下半部留白白做。
 *   • 提示词统一要求"下半部留白 + 无文字" —— 文字一律由引擎叠加，
 *     扩散模型画不准中文（这是整个项目的核心立场）。
 *   • 逐张生成、每张落盘、失败不中断，可重复运行（已有则跳过）。
 *
 * 用法：
 *   node gen-backgrounds.mjs                # 生成全部缺失的
 *   node gen-backgrounds.mjs seaside tea   # 只生成指定的
 *   node gen-backgrounds.mjs --force        # 已有也重做
 */

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateImage, isUp, systemStats } from "./comfy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "public", "bg");

// 832×1120 = 3:4 竖版（与 1080×1440 同比例），8 GB 显存下比 1024×1024 更省
const WIDTH = 832;
const HEIGHT = 1120;

/**
 * 把 ComfyUI 返回的图片统一转成真正的 JPEG。
 * 实测 ComfyUI 的 SaveImage 输出是 PNG（带 RGBA），
 * 如果直接按 .jpg 存，文件内容与扩展名不符 —— 浏览器能靠嗅探显示，
 * 但"用扩展名判断格式"的工具（含本项目的图片校验）会认为文件损坏。
 */
async function saveAsJpeg(buffer, file) {
  const { spawn } = await import("node:child_process");
  const helper = path.join(__dirname, ".work", "to-jpeg.py");
  await mkdir(path.dirname(helper), { recursive: true });
  await writeFile(
    helper,
    [
      "import sys",
      "from PIL import Image",
      "src, dst = sys.argv[1], sys.argv[2]",
      "Image.open(src).convert('RGB').save(dst, 'JPEG', quality=90, optimize=True)",
    ].join("\n"),
    "utf8"
  );
  const tmp = file + ".tmp";
  await writeFile(tmp, buffer);
  const py = process.env.PF_PYTHON || "E:\\devenv\\Scripts\\python.exe";
  await new Promise((res, rej) => {
    const p = spawn(py, [helper, tmp, file], { windowsHide: true, stdio: "ignore" });
    p.on("close", (code) => (code === 0 ? res() : rej(new Error("转 JPEG 失败，退出码 " + code))));
    p.on("error", rej);
  });
  const { unlink } = await import("node:fs/promises");
  await unlink(tmp).catch(() => {});
}

const NEGATIVE = "文字, 水印, logo, 中文, 英文, 人物特写, 杂乱, 过曝, 变形";

/**
 * 每个模板一张背景。
 * 提示词写法：场景 + 光线 + 构图 + "下半部留白" + "无文字"。
 * 最后两项不是客套 —— 留白是为了压文字，无文字是因为模型写不对中文。
 */
const BACKGROUNDS = [
  {
    id: "tpl-hotel-autumn",
    slug: "seaside-sunset",
    prompt:
      "中国东南沿海悬崖海景，黄昏时分，暖橙与深青渐变天空，平静海面反射霞光，远处礁石剪影，" +
      "低角度广角摄影，柔和电影感光线，画面下半部大面积干净留白（深色海面，适合叠加白色文字），" +
      "无文字，无水印，无logo，无人物",
  },
  {
    id: "tpl-rest-lunch",
    slug: "wok-fire",
    prompt:
      "中式餐馆后厨猛火快炒特写，铁锅腾起火焰与蒸汽，暖橙色调，食材飞溅动感，" +
      "浅景深，暗背景，画面下半部干净暗色留白（适合叠加文字），无文字，无水印，无人物",
  },
  {
    id: "tpl-scenic",
    slug: "bamboo-mist",
    prompt:
      "浙江安吉竹林清晨，薄雾弥漫，阳光穿透竹叶形成丁达尔光束，青绿色调，纵深构图，" +
      "画面下半部干净留白（暗色林间地面，适合叠加文字），无文字，无水印，无人物",
  },
  {
    id: "tpl-hotel-snow",
    slug: "snow-mountain",
    prompt:
      "长白山雪季景观，覆盖白雪的山峦与雾凇林，清晨蓝调时刻，远处温泉升起白色蒸汽，" +
      "冷冽通透，画面下半部大面积雪地留白（适合叠加文字），无文字，无水印，无人物",
  },
  {
    id: "tpl-night-market",
    slug: "night-market",
    prompt:
      "中国江畔夜市夜景，成排摊位暖色灯笼与霓虹招牌，江面倒影，紫红色调，" +
      "人群虚化成光斑（不辨面容），画面下半部干净暗色留白（适合叠加文字），无文字，无水印",
  },
  {
    id: "tpl-tea",
    slug: "tea-hillside",
    prompt:
      "杭州西湖龙井茶山春景，层叠茶树顺着山坡起伏，晨雾缭绕，嫩绿与深绿层次，" +
      "柔和侧光，画面下半部干净留白（暗绿茶园，适合叠加文字），无文字，无水印，无人物",
  },
  {
    id: "tpl-museum",
    slug: "hanfu-lantern",
    prompt:
      "中国传统建筑的深色木质回廊，悬挂红色宫灯，暖光笼罩，地面有柔和反光，古雅肃穆，" +
      "画面下半部干净留白（深色石板地，适合叠加文字），无文字，无水印，无人物",
  },
  {
    id: "tpl-seaside",
    slug: "island-dawn",
    prompt:
      "东海海岛日出，海平线初升暖光，层叠海浪拍打礁石，深蓝到橙红渐变天空，云层透光，" +
      "辽阔宁静，画面下半部干净留白（深色海面，适合叠加白色文字），无文字，无水印，无人物",
  },
];

const args = process.argv.slice(2);
const force = args.includes("--force");
const only = args.filter((a) => !a.startsWith("--"));

async function main() {
  if (!(await isUp())) {
    console.error("ComfyUI 未运行。先启动：E:\\ComfyUI_windows_portable\\启动ComfyUI-低显存.bat");
    process.exit(1);
  }
  const st = await systemStats();
  console.log(`ComfyUI ${st.version} · ${st.device} · 显存 ${st.totalGB ?? st.vramTotalGB} GB`);
  console.log(`尺寸 ${WIDTH}×${HEIGHT}（3:4 竖版）· 共 ${BACKGROUNDS.length} 个模板背景\n`);

  await mkdir(OUT_DIR, { recursive: true });

  const todo = BACKGROUNDS.filter((b) => (only.length ? only.includes(b.slug) || only.includes(b.id) : true));
  if (!todo.length) {
    console.error("没有匹配的背景。可用 slug：" + BACKGROUNDS.map((b) => b.slug).join(", "));
    process.exit(1);
  }

  const results = [];
  for (let i = 0; i < todo.length; i++) {
    const b = todo[i];
    const file = path.join(OUT_DIR, `${b.slug}.jpg`);

    if (existsSync(file) && !force) {
      console.log(`[${i + 1}/${todo.length}] ${b.slug} —— 已存在，跳过（--force 可重做）`);
      results.push({ slug: b.slug, ok: true, skipped: true });
      continue;
    }

    console.log(`[${i + 1}/${todo.length}] ${b.slug}  (${b.id})`);
    try {
      const r = await generateImage(
        {
          prompt: b.prompt,
          negativePrompt: NEGATIVE,
          width: WIDTH,
          height: HEIGHT,
          steps: 25,
          cfg: 1,
          seed: 42,
          filenamePrefix: `pf_bg_${b.slug}`,
        },
        {
          timeoutMs: 900000,
          onTick: ({ note, elapsedMs }) => {
            // 覆盖同一行，避免刷屏
            process.stdout.write(`\r    ${(elapsedMs / 1000).toFixed(0)}s  ${note}          `);
          },
        }
      );
      await saveAsJpeg(r.buffer, file);
      process.stdout.write("\r");
      console.log(`    ✓ ${(r.elapsedMs / 1000).toFixed(1)}s → ${b.slug}.jpg`);
      results.push({ slug: b.slug, ok: true, ms: r.elapsedMs });
    } catch (e) {
      process.stdout.write("\r");
      console.log(`    ✗ 失败（阶段 ${e.stage || "?"}）：${e.message}`);
      if (e.detail) console.log(`      ${String(e.detail).slice(0, 200)}`);
      results.push({ slug: b.slug, ok: false, error: e.message });
    }
  }

  const ok = results.filter((r) => r.ok && !r.skipped);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n完成：成功 ${ok.length} · 跳过 ${results.filter((r) => r.skipped).length} · 失败 ${failed.length}`);
  if (ok.length) {
    const avg = ok.reduce((a, r) => a + r.ms, 0) / ok.length / 1000;
    console.log(`平均单张 ${avg.toFixed(1)} 秒`);
  }
  if (failed.length) {
    console.log("失败项：" + failed.map((f) => f.slug).join(", "));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("出错：", e.message);
  process.exit(1);
});
