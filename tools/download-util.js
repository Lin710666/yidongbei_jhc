/**
 * download-util.js —— 模型权重下载的公用逻辑（被 fetch-depth-model / fetch-triposr 共用）
 *
 * 两个脚本面对的是同一类问题，所以只写一份：
 *   · HuggingFace 直连在国内不可用，必须走镜像；而 `huggingface_hub` 在跟随镜像
 *     重定向后会校验"资源是否真的在 huggingface.co 上"，对着一份好文件报
 *     `Distant resource does not seem to be on huggingface.co`。所以自己用 HTTP 拉。
 *   · 镜像会偶发 502，断在半路是常态 —— 必须带重试，且已下好的文件要跳过（可续传）。
 *   · 下到的 JSON 要验一下是不是真 JSON：镜像出错时常常回一个 HTML 错误页，
 *     存下来会在加载模型时才炸，那时已经很难定位。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MIRRORS = 'https://hf-mirror.com,https://huggingface.co';
const RETRIES = 3;

function fmt(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** 带进度地把一个 URL 流式写进文件 */
async function downloadFile(url, dest, { expectText = false } = {}) {
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
      if (total && Date.now() - lastPrint > 700) {
        lastPrint = Date.now();
        process.stdout.write(`\r    进度 ${((got / total) * 100).toFixed(0)}%  ${fmt(got)} / ${fmt(total)}   `);
      }
    }
  } finally {
    await new Promise(r => out.end(r));
  }
  if (total) process.stdout.write('\r' + ' '.repeat(60) + '\r');

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

/**
 * 依次下载一组文件。已存在且非空的跳过（天然支持续传）。
 *
 * @param {object} o
 * @param {string} o.repo    形如 stabilityai/TripoSR
 * @param {string} o.dest    本地目录
 * @param {string[]} o.files 文件名列表
 * @param {string} [o.mirrors]
 * @returns {Promise<string[]>} 失败的文件名
 */
async function fetchModelFiles({ repo, dest, files, mirrors, label }) {
  const list = (mirrors || process.env.MODEL_MIRRORS || DEFAULT_MIRRORS)
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);

  console.log(`${label || repo}`);
  console.log(`仓库：${repo}`);
  console.log(`目标：${dest}`);
  console.log(`镜像：${list.join(' → ')}\n`);

  fs.mkdirSync(dest, { recursive: true });
  const failed = [];

  for (const f of files) {
    const target = path.join(dest, f);
    if (fs.existsSync(target) && fs.statSync(target).size > 0) {
      console.log(`  ✓ ${f}  已存在（${fmt(fs.statSync(target).size)}），跳过`);
      continue;
    }
    console.log(`  · ${f}`);
    let done = false;
    for (const mirror of list) {
      for (let attempt = 1; attempt <= RETRIES && !done; attempt++) {
        const url = `${mirror}/${repo}/resolve/main/${f}`;
        try {
          const n = await downloadFile(url, target, { expectText: f.endsWith('.json') || f.endsWith('.yaml') });
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
  return failed;
}

module.exports = { downloadFile, fetchModelFiles, fmt, DEFAULT_MIRRORS, RETRIES };
