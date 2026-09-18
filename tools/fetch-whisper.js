#!/usr/bin/env node
/**
 * fetch-whisper.js —— 下载本地语音识别（Whisper）的模型权重
 *
 * 运行：node tools/fetch-whisper.js        （或 npm run fetch:whisper）
 *
 * ## 为什么必须走镜像
 *
 * huggingface.co 在这台机器上**连不通**（被墙），而 hf-mirror.com 可用。
 * 所以这里不用 `huggingface_hub` / `transformers` 自带的下载器（它们会把
 * HF_ENDPOINT 之外的请求都打向 huggingface.co，而且跟随镜像重定向后还会校验
 * "资源是否真的在 huggingface.co 上"，对着一份好文件报
 * `Distant resource does not seem to be on huggingface.co`），
 * 而是复用 tools/download-util.js 里那套自己写的 HTTP 下载：
 * 镜像优先、带重试、已下好的跳过（天然续传）、JSON 下载后验一遍是不是真 JSON。
 *
 * ## 下哪些文件
 *
 * whisper-small 在 HF 上是一堆小配置 + 一个约 1GB 的 model.safetensors。
 * 只下**推理真正要用**的那几个：少了 tokenizer.json 会在分词时才炸，
 * 少了 preprocessor_config.json 会不知道 mel 参数（chunk_length 等）。
 * 明确不下的：flax_model.msgpack / tf_model.h5 / *.ot（另外两个框架的权重，
 * 加起来又是 2GB+，对本项目毫无用处）、README.md（无所谓）。
 *
 * ## 模型选哪个
 *
 *   默认 openai/whisper-small —— 约 1GB，中文识别可用，是"离线 + 中文"的平衡点。
 *   嫌大就用 WHISPER_MODEL=openai/whisper-base（约 150MB）：
 *     中文能认，但明显更容易听错专有名词，适合先跑通链路再换大模型。
 *   想要更准可上 openai/whisper-medium（约 1.5GB），但本机 8GB 显存
 *   被别的程序占着时基本只能跑 CPU，30 秒音频要等半分钟以上。
 *
 * 权重不入库（.gitignore 里 models/ 本来就忽略）：1GB 且授权属于 OpenAI 自己的
 * 仓库，让使用者自己取更清楚 —— 与 TripoSR / Depth 那两份一个道理。
 */

const fs = require('fs');
const path = require('path');
const { fetchModelFiles, fmt } = require('./download-util');

const ROOT = path.join(__dirname, '..');
const REPO = process.env.WHISPER_MODEL || 'openai/whisper-small';
const DEST = process.env.WENLV_WHISPER_MODEL || path.join(ROOT, 'models', 'whisper');

/**
 * 推理必需的文件。顺序有意：小文件在前，大权重最后 ——
 * 镜像中途挂掉时，用户重跑一次就能看到"前面都跳过了，只剩最大的那个"，
 * 而不是从第一个开始重来（虽然实际都会跳过，但输出顺序影响用户对进度的判断）。
 */
const FILES = [
  'config.json',                 // 模型结构（层数/头数/词表大小）
  'generation_config.json',      // 生成参数（max_length、语言 token 等）
  'preprocessor_config.json',    // mel 参数（chunk_length=30s、采样率 16k）
  'tokenizer_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'normalizer.json',             // 英文数字/缩写规范化表
  'vocab.json',
  'merges.txt',                  // BPE 合并规则
  'tokenizer.json',              // 真正的分词器（慢分词器只靠上面两个，快分词器靠这个）
  'model.safetensors',           // 权重本体，约 1GB
];

/** 权重文件的合理性下限：小于这个必然是断了下半截（正常 967MB / 290MB / 145MB）。 */
const MIN_WEIGHTS_BYTES = 50 * 1024 * 1024;

/**
 * 校验一个 safetensors 文件是不是完整的。
 *
 * 为什么值得单独写：download-util 只会校验 JSON，而权重下到一半时
 * **HTTP 可能正常结束**（镜像断流），得到一个能被 rename 成正式文件的小文件。
 * 那之后 transformers 会在加载时报一个又长又难懂的 safetensors 解析错，
 * 用户完全看不出是"下载不完整"。
 *
 * safetensors 的格式：前 8 字节是小端 uint64 的头部长度 N，接着 N 字节 JSON 头。
 * 所以这里检查三件事：文件够大、头部长度合理、头部是合法 JSON。
 * 这也是 transformers 自己会做的第一件事，只是提前到下载脚本里做。
 */
function checkSafetensors(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { ok: false, why: '文件读不到' }; }
  if (size < MIN_WEIGHTS_BYTES) {
    return { ok: false, why: `只有 ${fmt(size)}，明显没下完（正常约 1GB）` };
  }
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    const n = Number(head.readBigUInt64LE(0));
    if (!Number.isFinite(n) || n <= 2 || n > 100 * 1024 * 1024 || 8 + n > size) {
      return { ok: false, why: `头部长度字段不合理（${n}），文件不是完整的 safetensors` };
    }
    const json = Buffer.alloc(n);
    fs.readSync(fd, json, 0, n, 8);
    try { JSON.parse(json.toString('utf8')); } catch { return { ok: false, why: '头部不是合法 JSON' }; }
  } finally {
    fs.closeSync(fd);
  }
  return { ok: true, size };
}

async function main() {
  console.log('Whisper 语音识别权重下载（本地离线识别，默认关闭，可在「设置 → 听觉」里打开）\n');

  if (REPO.includes('large') || REPO.includes('medium')) {
    console.log(`[提示] 你选的是 ${REPO}：中文更准，但显存/内存吃得更多，`
      + '8GB 显存被别的程序占着时基本只能跑 CPU。\n');
  }
  if (REPO.endsWith('whisper-base') || REPO.endsWith('whisper-tiny')) {
    console.log(`[提示] 你选的是 ${REPO}：小、快，但中文更容易听错专有名词。\n`);
  }

  const failed = await fetchModelFiles({
    repo: REPO,
    dest: DEST,
    files: FILES,
    label: 'Whisper 是 OpenAI 的语音识别模型，本项目只做「语音 → 文字」，不做翻译',
  });

  // ---- 校验 ----
  console.log('\n校验下载结果');
  let bad = null;
  const weights = path.join(DEST, 'model.safetensors');
  if (fs.existsSync(weights)) {
    const c = checkSafetensors(weights);
    if (c.ok) console.log(`  ✓ model.safetensors 完整（${fmt(c.size)}）`);
    else { bad = `model.safetensors 校验失败：${c.why}`; console.log(`  ✗ ${bad}`); }
  } else {
    bad = 'model.safetensors 不存在';
    console.log(`  ✗ ${bad}`);
  }

  // 缺任何一个配置文件，transformers 都会在加载时报错，所以这里逐一点名
  const missingCfg = FILES.filter(f => f !== 'model.safetensors' && !fs.existsSync(path.join(DEST, f)));
  if (missingCfg.length) {
    bad = bad || `缺少配置文件：${missingCfg.join('、')}`;
    console.log(`  ✗ ${bad}`);
  } else {
    console.log('  ✓ 配置文件齐全（' + (FILES.length - 1) + ' 个）');
  }

  if (failed.length || bad) {
    console.log(`\n下载未完成：${failed.length ? '失败 ' + failed.join('、') : bad}`);
    console.log('可以重新运行本脚本续传（已下好且非空的文件会跳过）。');
    console.log('镜像全不通时，可以把 MODEL_MIRRORS 设成你自己的镜像；');
    console.log('想换更小的模型就设 WHISPER_MODEL=openai/whisper-base（约 150MB）。');
    console.log('若 model.safetensors 校验失败，请先删掉它再重跑本脚本（否则会被当成"已下好"跳过）。');
    process.exitCode = 1;
    return;
  }

  let total = 0;
  for (const f of FILES) { try { total += fs.statSync(path.join(DEST, f)).size; } catch { /* 忽略 */ } }
  console.log(`\n全部就绪：${REPO} → ${DEST}（共 ${fmt(total)}）`);
  console.log('\n接下来：');
  console.log('  1. 打开页面「设置 → 听觉（语音识别）」，把开关打开（默认关闭）；');
  console.log('  2. 点「检测环境」确认 Python 侧 torch + transformers 就绪；');
  console.log('  3. 也可以先用命令行自检：');
  console.log(`     node -e "const{createSTT}=require('./lib/stt');createSTT({dir:'./data'}).status().then(s=>console.log(s))"`);
  console.log('\n说明：识别完全在本机完成，音频不会发到任何服务器。');
}

main().catch((e) => {
  console.error('\n下载脚本自身出错：', e.message);
  process.exitCode = 1;
});
