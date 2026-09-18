#!/usr/bin/env node
/**
 * fetch-depth-model.js —— 下载深度模型（Depth-Anything-V2-Small，约 95MB）
 *
 * 运行：node tools/fetch-depth-model.js        （或 npm run fetch:depth）
 *
 * ## 为什么要自己下，不用 huggingface_hub
 *
 * HuggingFace 直连在国内基本不可用，而镜像 hf-mirror.com 是可用的。
 * 但 `huggingface_hub` 在跟随镜像的重定向之后，会校验"最终资源是否真的在
 * huggingface.co 上"，于是报一句莫名其妙的
 * `Distant resource does not seem to be on huggingface.co`，
 * 实际上文件是好的。所以这里绕开它，直接用 HTTP 拉三个文件到本地目录 ——
 * transformers 完全支持从本地目录加载，不需要任何联网。
 *
 * ## 失败要能说清原因
 *
 * 三个文件分别报告，失败的允许重试。下到一半失败是最常见的（镜像偶发 502），
 * 所以带重试，并且已存在的文件默认跳过。
 */

const fs = require('fs');
const path = require('path');

const REPO = process.env.DEPTH_MODEL_REPO || 'depth-anything/Depth-Anything-V2-Small-hf';
const MIRRORS = (process.env.DEPTH_MODEL_MIRRORS || 'https://hf-mirror.com,https://huggingface.co')
  .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
const FILES = ['config.json', 'preprocessor_config.json', 'model.safetensors'];
const ROOT = path.join(__dirname, '..');
const DEST = process.env.WENLV_DEPTH_MODEL || path.join(ROOT, 'models', 'depth-anything-v2-small');

const RETRIES = 3;

function fmt(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** 带进度地把一个 URL 流式写进文件 */
async function download(url, dest, { expectText = false } = {}) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get('content-length') || 0);
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);

  let got = 0;
  let lastPrint = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      out.write(Buffer.from(value));
      // 里程碑式打印，避免刷屏（也避免在一些终端里拖慢下载）
      if (total && Date.now() - lastPrint > 700) {
        lastPrint = Date.now();
        const pct = ((got / total) * 100).toFixed(0);
        process.stdout.write(`\r    进度 ${pct}%  ${fmt(got)} / ${fmt(total)}   `);
      }
    }
  } finally {
    await new Promise(r => out.end(r));
  }
  if (total) process.stdout.write('\r' + ' '.repeat(60) + '\r');

  // 文本文件顺手校验一下是不是真的 JSON —— 镜像出错时常常回一个 HTML 错误页，
  // 直接当模型配置存下来会在加载时才炸，那时已经很难定位了
  if (expectText) {
    const txt = fs.readFileSync(tmp, 'utf8');
    try { JSON.parse(txt); } catch {
      fs.unlinkSync(tmp);
      throw new Error('下载到的不是合法 JSON（镜像可能返回了错误页）');
    }
  }
  fs.renameSync(tmp, dest);
  return got;
}

async function main() {
  console.log('深度模型下载（单目深度估计，用于全景景区建模）');
  console.log(`仓库：${REPO}`);
  console.log(`目标：${DEST}`);
  console.log(`镜像：${MIRRORS.join(' → ')}\n`);

  fs.mkdirSync(DEST, { recursive: true });

  const failed = [];
  for (const f of FILES) {
    const dest = path.join(DEST, f);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`  ✓ ${f}  已存在（${fmt(fs.statSync(dest).size)}），跳过`);
      continue;
    }
    console.log(`  · ${f}`);
    let done = false;
    for (const mirror of MIRRORS) {
      for (let attempt = 1; attempt <= RETRIES && !done; attempt++) {
        const url = `${mirror}/${REPO}/resolve/main/${f}`;
        try {
          const n = await download(url, dest, { expectText: f.endsWith('.json') });
          console.log(`    ✓ 完成（${fmt(n)}，来自 ${new URL(mirror).host}${attempt > 1 ? `，第 ${attempt} 次尝试` : ''}）`);
          done = true;
        } catch (e) {
          console.log(`    ✗ ${new URL(mirror).host} 第 ${attempt} 次失败：${e.message}`);
          await new Promise(r => setTimeout(r, 800 * attempt));
        }
      }
      if (done) break;
    }
    if (!done) failed.push(f);
  }

  const weights = path.join(DEST, 'model.safetensors');
  if (failed.length || !fs.existsSync(weights)) {
    console.log(`\n下载未完成，缺：${failed.join('、') || 'model.safetensors'}`);
    console.log('可以重新运行本脚本续传（已下好的文件会跳过）。');
    console.log('如果镜像全都不通，可以把 DEPTH_MODEL_MIRRORS 设成你自己的镜像。');
    process.exitCode = 1;
    return;
  }

  const total = FILES.reduce((s, f) => s + fs.statSync(path.join(DEST, f)).size, 0);
  console.log(`\n全部就绪，共 ${fmt(total)}`);
  console.log('现在可以在页面上的「景区全景」里生成地形了。');
}

main().catch((e) => {
  console.error('\n下载脚本自身出错：', e.message);
  process.exitCode = 1;
});
