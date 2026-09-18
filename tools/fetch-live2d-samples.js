#!/usr/bin/env node
/**
 * fetch-live2d-samples.js —— 补齐 Live2D 官方示例模型
 *
 * 运行：npm run fetch:live2d       （加 --force 重新下载已存在的）
 *
 * ## 为什么要补
 *
 * `Live2D/CubismWebSamples` 里一共有 **8 个**官方示例模型，而项目原来只取了 3 个
 * （haru / hiyori / mao）。剩下的 Mark / Natori / Ren / Rice 同样是 Live2D Inc.
 * 官方绘制、同一份授权（Live2D Free Material License Agreement），
 * 但风格差别很大 —— 对"换个好看点的形象"这件事来说，多几个选择很实用。
 *
 * ## 与 tools/获取示例模型.ps1 的关系
 *
 * 那个脚本是最早写的，用 jsDelivr 下载 haru/hiyori/mao 和两个 VRM。
 * 这个工具**只补**它没取的那些，两边不重复：已存在的模型直接跳过。
 * 独立成一个 Node 脚本而不是改那个 .ps1，有两个原因：
 *   1. .ps1 是 GBK 编码的中文脚本，用别的工具改容易把它写坏（本项目踩过）；
 *   2. 新工具（fetch-triposr / fetch-whisper / fetch-depth-model）都是 Node 的，
 *      保持一致更好维护。
 *
 * ## 授权
 *
 * 模型版权归 Live2D Inc.，适用 Live2D Free Material License Agreement：
 *   https://www.live2d.com/eula/live2d-free-material-license-agreement_cn.html
 * 与项目里已有的三套示例模型完全一致，**没有引入新的授权风险**。
 * 按项目惯例，public/models 不进版本库，只在本机下载。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'public', 'models');

const REPO = 'Live2D/CubismWebSamples';
const REF = 'develop';

/**
 * 要补的模型。src 是仓库里的目录名，id 是项目里的目录名。
 *
 * **为什么没有 Ren**：Ren 是用 moc3 版本 6 导出的，而本项目内置的 Cubism Core
 * 来自 AIRI 构建的 Cubism SDK for Web 5-r.3，只支持到 moc3 v5，加载时会报
 *   csmReviveMocInPlace is failed. The Core unsupport later than moc3 ver:[5]. This moc3 ver is [6].
 * 而更新版 Core 拿不到：官方 CDN cubism.live2d.com 在这台机器上不可达，
 * npm 上的 live2dcubismcore 包停在 2022 年（比现有这份还旧）。
 * 与其放一个必然报错、还白白占 2.4MB 的模型，不如不收。
 * 以后若换上更新的 Core，把 ren 加回来即可（其余代码不用动）。
 */
const MODELS = [
  { id: 'natori', src: 'Natori', label: '名取', note: '和风少女，8 个动作、11 种表情，是这批里表现力最强的' },
  { id: 'rice', src: 'Rice', label: 'Rice', note: '贝雷帽与藏青外套，手拿书本，气质偏文静' },
  { id: 'mark', src: 'Mark', label: 'Mark', note: '男性角色，适合做讲解员' },
];

/** 只拷这些扩展名：模型本体 + 纹理 + 动作/表情/物理配置 + 动作音效 */
const COPY_EXT = new Set(['.json', '.moc3', '.png', '.jpg', '.jpeg', '.webp', '.wav', '.mp3', '.txt']);

/** 下载候选：jsDelivr 国内可直连，失败依次退到镜像 */
const MIRRORS = [
  (repo, ref, p) => `https://cdn.jsdelivr.net/gh/${repo}@${ref}/${p}`,
  (repo, ref, p) => `https://gh-proxy.com/https://raw.githubusercontent.com/${repo}/${ref}/${p}`,
  (repo, ref, p) => `https://raw.githubusercontent.com/${repo}/${ref}/${p}`,
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getBuffer(url, { timeout = 60000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function getJson(url, { timeout = 45000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 依次试各个镜像，成功即返回 */
async function download(repo, ref, p) {
  const errors = [];
  for (const mk of MIRRORS) {
    const url = mk(repo, ref, p);
    try {
      return { buf: await getBuffer(url), url };
    } catch (e) {
      errors.push(`${new URL(url).hostname}: ${e.message}`);
    }
  }
  throw new Error(`所有镜像都失败 → ${errors.join('；')}`);
}

/**
 * 补全 model3.json 里的 Groups 声明。
 *
 * 官方示例里有**空壳**声明：`{"Name":"LipSync","Ids":[]}`（实测 mark 和 rice 就是），
 * 意思是"这个组存在，但没绑任何参数"。引擎看到空 Ids 就不会做口型同步，
 * 而界面上如果只查"有没有 LipSync 组"会报"支持口型" —— 实际嘴一动不动。
 * 与 tools/import-vts-models.js 里处理 VTS 模型的是同一类问题（那边也有两个空壳组）。
 *
 * 做法：从同目录的 cdi3.json（模型自己声明的参数表）里挑一个真实存在的口型参数补进去。
 * **参数名必须按模型各自探测**：这批模型用的是 ParamMouthOpenY，而 VTS 那批用的是
 * ParamMouthOpen / PARAM_MOUTH_OPEN_Y，写死任何一个都会让别的模型静默失效。
 *
 * @returns {{lipSync:string|null, eyeBlink:string[]}}
 */
function completeGroups(model3Path, dir) {
  let j;
  try { j = JSON.parse(fs.readFileSync(model3Path, 'utf8')); } catch { return { lipSync: null, eyeBlink: [] }; }

  const cdiFile = fs.readdirSync(dir).find(x => x.toLowerCase().endsWith('.cdi3.json'));
  let paramIds = [];
  if (cdiFile) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, cdiFile), 'utf8'));
      paramIds = (c.Parameters || []).map(p => p.Id).filter(Boolean);
    } catch { /* 读不到就当没有参数表，后面会如实返回 null */ }
  }
  const firstOf = (cands) => cands.find(c => paramIds.includes(c)) || null;

  const lipSync = firstOf(['ParamMouthOpenY', 'PARAM_MOUTH_OPEN_Y', 'ParamMouthOpen', 'PARAM_MOUTH_OPEN'])
    || paramIds.find(id => /mouth/i.test(id) && /open/i.test(id)) || null;
  const lOpen = firstOf(['ParamEyeLOpen', 'PARAM_EYE_L_OPEN']);
  const rOpen = firstOf(['ParamEyeROpen', 'PARAM_EYE_R_OPEN']);
  const eyeBlink = [lOpen, rOpen].filter(Boolean);

  j.Groups = Array.isArray(j.Groups) ? j.Groups : [];
  const put = (name, ids) => {
    const cur = j.Groups.find(g => String(g.Name || '').toLowerCase() === name.toLowerCase());
    if (ids.length) {
      // 组已存在但 Ids 为空时也要**补上**，不能因为"组在"就跳过
      if (cur) { if (!Array.isArray(cur.Ids) || !cur.Ids.length) cur.Ids = ids; }
      else j.Groups.push({ Target: 'Parameter', Name: name, Ids: ids });
      return;
    }
    // 补不出 Ids 时，把**空壳组删掉**。
    // 留着 `{"Name":"LipSync","Ids":[]}` 是一句谎话：引擎不会做口型，
    // 而任何"查有没有 LipSync 组"的代码都会以为支持（项目里就有这种检查，
    // 已经因此误报过一次）。没有参数就干脆别声明。
    if (cur) j.Groups.splice(j.Groups.indexOf(cur), 1);
  };
  put('LipSync', lipSync ? [lipSync] : []);
  put('EyeBlink', eyeBlink);

  // 最后再扫一遍：任何剩下的空壳参数组都删掉，避免以后又踩同一个坑
  j.Groups = j.Groups.filter(g => !(String(g.Target || 'Parameter') === 'Parameter'
    && (!Array.isArray(g.Ids) || !g.Ids.length)));

  const changed = lipSync || eyeBlink.length || true;   // 上面可能删了空组，一律回写
  if (changed) fs.writeFileSync(model3Path, JSON.stringify(j, null, 2), 'utf8');
  return { lipSync, eyeBlink };
}

async function main() {
  const force = process.argv.includes('--force');
  console.log('补齐 Live2D 官方示例模型\n');
  console.log('  来源：', `${REPO}@${REF}`);
  console.log('  授权：Live2D Free Material License Agreement（与项目已有示例模型相同）\n');

  fs.mkdirSync(MODELS_DIR, { recursive: true });

  // 先问 jsDelivr 要一份完整文件清单（含大小），免得逐个去猜路径
  let files = [];
  try {
    const api = `https://data.jsdelivr.com/v1/packages/gh/${REPO}@${REF}?structure=flat`;
    const j = await getJson(api);
    files = (j.files || []).map(f => ({ p: f.name, s: f.size || 0 }));
    if (!files.length) throw new Error('清单为空');
    console.log(`  文件清单：${files.length} 个（来自 jsDelivr API）\n`);
  } catch (e) {
    console.error(`  ✗ 取不到文件清单：${e.message}`);
    console.error('    请检查网络（jsDelivr 国内一般可直连）。');
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const m of MODELS) {
    // 注意 jsDelivr 的清单里路径**带前导斜杠**（/Samples/Resources/...）。
    // 少写这个斜杠会让四个模型全部"找不到目录" —— 我第一版就是这么错的。
    const prefix = `/Samples/Resources/${m.src}/`;
    const wanted = files.filter(f => f.p.startsWith(prefix) && f.s > 0);
    if (!wanted.length) {
      results.push({ ...m, skipped: true, why: '仓库里没有这个模型的目录' });
      continue;
    }

    const dst = path.join(MODELS_DIR, m.id);
    if (fs.existsSync(dst) && !force) {
      results.push({ ...m, skipped: true, why: '已经下载过了（要重来加 --force）' });
      continue;
    }
    if (fs.existsSync(dst) && force) fs.rmSync(dst, { recursive: true, force: true });

    const totalBytes = wanted.reduce((n, f) => n + f.s, 0);
    let copied = 0;
    let skippedFiles = 0;
    let failed = 0;
    process.stdout.write(`  ${m.label.padEnd(6)} ${(totalBytes / 1024 / 1024).toFixed(1)}MB  `);

    for (const f of wanted) {
      const rel = f.p.slice(prefix.length);
      const ext = path.extname(rel).toLowerCase();
      if (!COPY_EXT.has(ext)) { skippedFiles++; continue; }
      const out = path.join(dst, rel.split('/').join(path.sep));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      try {
        const { buf } = await download(REPO, REF, f.p);
        fs.writeFileSync(out, buf);
        copied++;
        process.stdout.write('.');
      } catch (e) {
        failed++;
        process.stdout.write('x');
        if (failed === 1) results.push({ ...m, firstError: e.message });
      }
      // 稍微让一下，别把 jsDelivr 打得太急
      await sleep(30);
    }
    process.stdout.write('\n');

    if (failed && !copied) {
      results.push({ ...m, skipped: true, why: `全部文件下载失败（${results.find(r => r.firstError) ? '' : e => e}）` });
      continue;
    }

    // 写清单：界面上的名字与出处从这里读（沿用项目现有的 manifest.json 约定）
    fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify({
      label: m.label,
      note: `Live2D Inc. 官方示例模型 ${m.label}。${m.note}。`
        + '模型版权归 Live2D Inc.，适用 Live2D Free Material License Agreement；'
        + '本仓库不包含该模型（public/models 不进版本库）。',
      tags: ['Live2D 官方示例', '第三方素材'],
      source: REPO,
      license: 'Live2D Free Material License Agreement',
    }, null, 2), 'utf8');

    // 补全空壳的 Groups 声明（否则口型/眨眼会静默失效）
    let groups = { lipSync: null, eyeBlink: [] };
    try {
      const m3 = fs.readdirSync(dst).find(x => x.toLowerCase().endsWith('.model3.json'));
      if (m3) groups = completeGroups(path.join(dst, m3), dst);
    } catch { /* 补全失败不影响模型本身能用 */ }

    results.push({ ...m, copied, skippedFiles, failed, bytes: totalBytes, groups });
  }

  console.log('\n  结果：');
  let ok = 0;
  for (const r of results) {
    if (r.skipped) { console.log(`    - ${r.id}：跳过（${r.why}）`); continue; }
    ok++;
    const warn = r.failed ? ` ⚠ ${r.failed} 个文件失败` : '';
    const g = r.groups || {};
    const lip = g.lipSync ? `口型 ${g.lipSync}` : '该模型没有口型参数（不支持口型同步）';
    const blink = g.eyeBlink && g.eyeBlink.length ? '眨眼已配' : '眨眼未配';
    console.log(`    ✓ ${r.id}（${r.label}）：${r.copied} 个文件，${(r.bytes / 1024 / 1024).toFixed(1)}MB${warn}`);
    console.log(`        ${lip}；${blink}`);
  }
  console.log(`\n  共就位 ${ok} 个模型。`);
  console.log('  刷新页面后，在「外观 → 更换形象」里就能选到它们。');
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error('下载出错：', e.message);
  process.exitCode = 1;
});
