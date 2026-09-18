#!/usr/bin/env node
/**
 * fetch-bili-video.js —— 把 B 站视频下载到本机，作为开屏/背景视频
 *
 * 运行：node tools/fetch-bili-video.js <BV号或链接> [输出文件名]
 *       npm run fetch:bili -- BV1Uq8y6DEGq 西湖宣传片
 *
 * ## 为什么改成"下载到本机"而不是继续用 iframe 内嵌
 *
 * 一开始开屏背景用的是 B 站官方 iframe 播放器（合规、不下载）。但实际用起来有两个问题：
 *   1. 播放器自带一套界面，压不住；而且必须联网，断网就是一片黑；
 *   2. B 站播放器默认给的是**窄版布局**（竖屏片源在横屏窗口里就是中间一条）。
 * 所以改成把片子下到 `data/videos/`，之后完全走本机文件那条路 ——
 * 离线可用、能铺满、能用 <video> 直接控制声音。
 *
 * ## 关于音视频分开
 *
 * B 站高清是 DASH 格式，音视频是**两条流**，合并需要 ffmpeg。
 * 这台机器没装系统 ffmpeg，所以用 `imageio-ffmpeg` 包里的静态二进制
 * （见 findFfmpeg()）。没装的话脚本会给出安装命令，而不是丢一堆栈。
 *
 * ## 画质说明（实测）
 *
 * 未登录时 B 站只给到 480p。标题写着「4K」也没用 —— 4K/1080P60 需要登录
 * （部分还要大会员）。脚本会**如实打印拿到了什么画质**，不假装。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'videos');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://www.bilibili.com/',
  'Origin': 'https://www.bilibili.com',
};

/** 从任意形态的输入里抠出 BV 号 */
function parseBvid(raw) {
  const m = String(raw || '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : '';
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS, timeout: 20000 }, r => {
      let b = '';
      r.on('data', d => b += d);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`返回不是 JSON（HTTP ${r.statusCode}）`)); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS, timeout: 300000 }, r => {
      if (r.statusCode !== 200 && r.statusCode !== 206) {
        return reject(new Error(`HTTP ${r.statusCode}`));
      }
      const f = fs.createWriteStream(dest);
      r.pipe(f);
      f.on('finish', () => { f.close(); resolve(fs.statSync(dest).size); });
      f.on('error', (e) => { try { fs.unlinkSync(dest); } catch { /* 忽略 */ } reject(e); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
  });
}

/**
 * 找 ffmpeg：先看系统 PATH，再用项目 venv 里 imageio-ffmpeg 自带的静态二进制。
 *
 * 为什么要带这一步：这台机器没装系统 ffmpeg，而 B 站高清是音视频分离的，
 * 不合成就只有画面没声音（或者只有低画质的合一流）。imageio-ffmpeg 是 pip 包，
 * 83MB，装一次就有，比让用户自己去配环境变量省事得多。
 *
 * 实现上**直接去 site-packages 里找那个 exe**，不要 spawn python 去问路径 ——
 * 那一步在这台机器上会失败（项目路径含中文，子进程输出拿不到），
 * 结果就是"明明装了却报找不到"。文件系统查找没有这个问题。
 */
function findFfmpeg() {
  // 1) 系统 PATH 里的
  const which = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (which.status === 0) return 'ffmpeg';

  // 2) venv 里 imageio-ffmpeg 自带的
  const dir = path.join(ROOT, 'tools', 'py', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
  try {
    const hit = fs.readdirSync(dir).find(f => /^ffmpeg.*\.exe$/i.test(f));
    if (hit) return path.join(dir, hit);
  } catch { /* 没装这个包 */ }

  // 3) 常见的包目录（非 Windows 或不同 venv 布局）
  const alt = path.join(ROOT, 'tools', 'py', 'lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
  try {
    const hit = fs.readdirSync(alt).find(f => /^ffmpeg/i.test(f));
    if (hit) return path.join(alt, hit);
  } catch { /* 忽略 */ }

  return null;
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error('用法：node tools/fetch-bili-video.js <BV号或链接> [输出文件名]');
    console.error('例如：node tools/fetch-bili-video.js BV1Uq8y6DEGq 西湖宣传片');
    process.exitCode = 1;
    return;
  }
  const bvid = parseBvid(raw);
  if (!bvid) { console.error('没认出 BV 号。请给完整链接或 BV 号。'); process.exitCode = 1; return; }
  const title = (process.argv[3] || `bili-${bvid}`).replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 40);

  console.log(`B 站视频下载：${bvid}\n`);
  const info = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  if (info.code !== 0) { console.error(`取视频信息失败：${info.message}`); process.exitCode = 1; return; }
  const cid = info.data.cid;
  console.log(`  标题：${info.data.title}`);
  console.log(`  UP主：${info.data.owner && info.data.owner.name}`);
  console.log(`  时长：${info.data.duration} 秒`);

  const pu = await getJson(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=120&fnval=16&fourk=1`);
  if (pu.code !== 0 || !pu.data || !pu.data.dash) {
    console.error(`取播放地址失败：${pu.message || '没有 DASH 流'}`);
    console.error('（有些视频需要登录才能取流，这种情况脚本无法处理，需要带 Cookie）');
    process.exitCode = 1;
    return;
  }
  const dash = pu.data.dash;
  const vids = (dash.video || []).slice().sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const auds = (dash.audio || []).slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  if (!vids.length) { console.error('没有可用的视频流'); process.exitCode = 1; return; }
  const V = vids[0];
  const A = auds[0];
  console.log(`  取到的画质：${V.width}x${V.height} ${V.codecs}（共 ${vids.length} 档可选）`);
  if (V.height < 1080) {
    console.log('  ⚠ 未登录时 B 站只给到 480P；标题里的 4K 需要登录（部分还要大会员）');
  }
  if (!A) console.log('  ⚠ 没有音频流，输出将没有声音');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmpV = path.join(OUT_DIR, `.tmp-${bvid}-v.m4s`);
  const tmpA = path.join(OUT_DIR, `.tmp-${bvid}-a.m4s`);
  const finalName = `${title}.mp4`;
  const finalPath = path.join(OUT_DIR, finalName);

  try {
    process.stdout.write('  下载视频流… ');
    console.log(`${(await download(V.baseUrl, tmpV) / 1048576).toFixed(1)}MB`);
    if (A) {
      process.stdout.write('  下载音频流… ');
      console.log(`${(await download(A.baseUrl, tmpA) / 1048576).toFixed(1)}MB`);
    }

    const ff = findFfmpeg();
    if (!ff) {
      console.error('\n  ✗ 找不到 ffmpeg，无法把音视频合成一个文件。');
      console.error('    安装（一次性）：');
      console.error(`      "${path.join(ROOT, 'tools', 'py', 'Scripts', 'python.exe')}" -m pip install imageio-ffmpeg`);
      console.error('    两个流已下载到 data/videos/ 下的 .tmp-*.m4s，装完重跑本脚本即可。');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('  合成（保留原音轨，不重编码）… ');
    const args = ['-y', '-i', tmpV];
    if (A) args.push('-i', tmpA);
    args.push('-c', 'copy', '-movflags', '+faststart', finalPath);
    const r = spawnSync(ff, args, { encoding: 'utf8' });
    if (r.status !== 0) {
      console.log('失败');
      console.error(String(r.stderr || '').trim().split('\n').slice(-6).join('\n'));
      process.exitCode = 1;
      return;
    }
    console.log(`${(fs.statSync(finalPath).size / 1048576).toFixed(1)}MB`);
    console.log(`\n  ✓ 已保存：data/videos/${finalName}`);
    console.log('    刷新页面即可在「外观 → 视频背景」里看到它（作为本机文件，离线可用）。');
  } finally {
    for (const p of [tmpV, tmpA]) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* 忽略 */ } }
  }
}

main().catch((e) => {
  console.error('出错：', e.message);
  process.exitCode = 1;
});
