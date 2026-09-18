#!/usr/bin/env node
/**
 * fetch-triposr.js —— 下载图片转 3D 的模型权重（TripoSR，约 1.6GB）
 *
 * 运行：node tools/fetch-triposr.js        （或 npm run fetch:triposr）
 *
 * 只需要两个文件：config.yaml（模型结构）与 model.ckpt（权重）。
 * 下载细节（镜像、重试、续传、JSON 校验）在 tools/download-util.js 里，
 * 与深度模型那条共用同一份实现。
 *
 * 为什么权重不入库：1.6GB，而且 TripoSR 的授权属于它自己的项目（MIT），
 * 让使用者自己去官方仓库取更清楚。
 */

const fs = require('fs');
const path = require('path');
const { fetchModelFiles, fmt } = require('./download-util');

const REPO = process.env.TRIPOSR_REPO || 'stabilityai/TripoSR';
const FILES = ['config.yaml', 'model.ckpt'];
const ROOT = path.join(__dirname, '..');
const DEST = process.env.WENLV_TRIPOSR_MODEL || path.join(ROOT, 'models', 'triposr');

async function main() {
  console.log('TripoSR 权重下载（图片转 3D）\n');

  const failed = await fetchModelFiles({
    repo: REPO,
    dest: DEST,
    files: FILES,
    label: 'Depth 之外的另一份权重：TripoSR 是单图生成三维网格的模型',
  });

  const ckpt = path.join(DEST, 'model.ckpt');
  if (failed.length || !fs.existsSync(ckpt)) {
    console.log(`\n下载未完成，缺：${failed.join('、') || 'model.ckpt'}`);
    console.log('可以重新运行本脚本续传（已下好的文件会跳过）。');
    console.log('镜像全不通时，可以把 MODEL_MIRRORS 设成你自己的镜像。');
    process.exitCode = 1;
    return;
  }

  const total = FILES.reduce((s, f) => s + fs.statSync(path.join(DEST, f)).size, 0);
  console.log(`\n全部就绪，共 ${fmt(total)}`);

  const vendored = path.join(ROOT, 'tools', 'TripoSR', 'tsr', 'system.py');
  console.log(fs.existsSync(vendored)
    ? '  源码已就位（tools/TripoSR/tsr）'
    : '  [注意] 没找到 tools/TripoSR/tsr —— 图生 3D 还需要 TripoSR 源码');

  console.log('\n还需要一个带 torch + trimesh + omegaconf + PyMCubes 的 Python 环境。');
  console.log('建法见 models/README.md；页面上「设置 → 图片转 3D → 检测环境」也能告诉你缺什么。');
}

main().catch((e) => {
  console.error('\n下载脚本自身出错：', e.message);
  process.exitCode = 1;
});
