#!/usr/bin/env node
/**
 * import-vts-models.js —— 从本机 VTube Studio 安装里导入 Live2D 模型
 *
 * 运行：node tools/import-vts-models.js        （或 npm run import:vts）
 *
 * ## 它做什么
 *
 * VTube Studio 随程序附带了一批 Live2D 官方示例模型（akari / hijiki / tororo / wanko / hiyori…），
 * 每个模型自带若干 `.motion3.json` 动作。把项目里还没有的那几个**复制**进 `public/models/`，
 * 形象数量与动作总数就都上去了 —— 这是"扩运动作"最实在的一条路（动作数据是美术做出来的，
 * 不能靠"训练"生成）。
 *
 * ## 三条硬约束
 *
 * 1. **只读**。对 VTS 安装目录只做列目录与读取，绝不写入、不移动、不删除。
 *    这个脚本会明确打印"未修改 VTS 安装"。
 * 2. **不碰第三方道具**。`StreamingAssets/Items/` 里那些 PNG 是各个作者的作品
 *    （文件名里就带着 `@MoshieStudio`、`@catboymech`、`@7MDigital` 等署名），
 *    复制它们等于替别人分发。本脚本**只导模型，不导道具**。
 * 3. **不进仓库**。产物落在 `public/models/` 下，而该目录在 `.gitignore` 里
 *    （只保留 README）—— 与本项目处理第三方模型的一贯做法一致。
 *
 * ## 幂等
 *
 * 目标目录已存在就跳过。想重来用 `--force`（会先删掉目标目录再复制，
 * 但**只删项目里的副本**，不碰 VTS）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'public', 'models');

/** 只复制 Live2D 需要的文件类型，顺带避开 VTS 自己的私有配置 */
const COPY_EXT = new Set([
  '.json', '.moc3', '.png', '.jpg', '.jpeg', '.webp', '.txt',
]);
/** 文件名里带这些的不要（VTS 私有配置 / 缩略图缓存 / 物品定义） */
const SKIP_NAME = /(vtube|\.vtube|thumbnail|_vtubestudio)/i;

function findVtsRoot() {
  if (process.env.VTS_HOME && fs.existsSync(process.env.VTS_HOME)) return process.env.VTS_HOME;

  const rel = path.join('steamapps', 'common', 'VTube Studio');
  const cands = [
    'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam',
    'D:\\Steam', 'D:\\SteamLibrary', 'E:\\Steam', 'E:\\SteamLibrary',
    'F:\\Steam', 'F:\\SteamLibrary', 'G:\\SteamLibrary',
  ].map(base => path.join(base, rel));

  for (const c of cands) if (fs.existsSync(c)) return c;

  // 兜底：扫各盘根下名字像 Steam 库的目录
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    const base = `${drive}:\\`;
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !/steam/i.test(e.name)) continue;
      const c = path.join(base, e.name, rel);
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

function modelsRoot(vtsRoot) {
  return path.join(vtsRoot, 'VTube Studio_Data', 'StreamingAssets', 'Live2DModels');
}

/** 判断一个目录是不是可用的 Live2D 模型：有且仅有一个 .model3.json，且有 .moc3 */
function inspectModel(dir) {
  let files = [];
  try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }

  const all = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else all.push(p);
    }
  })(dir);

  const model3 = all.filter(f => f.toLowerCase().endsWith('.model3.json'));
  const moc3 = all.filter(f => f.toLowerCase().endsWith('.moc3'));
  const motions = all.filter(f => f.toLowerCase().endsWith('.motion3.json'));
  const textures = all.filter(f => /\.(png|jpe?g|webp)$/i.test(f));

  if (model3.length !== 1 || !moc3.length) return null;
  return { model3: model3[0], moc3, motions, textures, all };
}

/** 递归复制（只读源，只创建目标） */
function copyTree(src, dst) {
  let copied = 0;
  let skippedFiles = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      const sub = copyTree(s, d);
      copied += sub.copied;
      skippedFiles += sub.skippedFiles;
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    if (!COPY_EXT.has(ext) || SKIP_NAME.test(e.name)) { skippedFiles++; continue; }
    fs.copyFileSync(s, d);
    copied++;
  }
  return { copied, skippedFiles };
}

/**
 * 按 Live2D 惯例给动作文件分组：名字里带 idle 的进 Idle，其余进 TapBody。
 *
 * `srcDir` 是**源模型目录**（VTS 安装里那个），路径相对它算。
 *
 * 这里踩过两个坑，都跟路径有关：
 *
 *   1. 用 `path.relative(process.cwd(), f)` 算 → `f` 在 VTS 安装目录里，
 *      结果 model3.json 里被写成 `D:/SteamLibrary/.../animations/x.motion3.json`，
 *      指回了 VTS 安装。本机因为 VTS 还在，看起来完全正常；换台机器、
 *      或用户卸载了 VTS，动作就全部加载失败，而复制过来的文件压根没被用上。
 *   2. 改成相对**目标目录**算也不行：源在 D:、项目在 E:，
 *      Windows 上 `path.relative` 跨盘符时会直接返回目标的绝对路径。
 *
 * 正确做法是相对源模型目录算 —— copyTree 保留目录结构，所以源里的相对路径
 * 在副本里是同一个相对路径。
 */
function groupMotions(motionFiles, srcDir) {
  const rel = f => path.relative(srcDir, f).split(path.sep).join('/');
  const idle = [];
  const rest = [];
  for (const f of motionFiles) {
    const base = path.basename(f).toLowerCase();
    (base.includes('idle') ? idle : rest).push({ File: rel(f) });
  }
  const motions = {};
  if (idle.length) motions.Idle = idle;
  if (rest.length) motions.TapBody = rest;
  return motions;
}

/**
 * 读 cdi3.json 取参数清单，挑出口型与眨眼要用的参数名。
 *
 * 为什么不能写死 `ParamMouthOpenY`：实测这几个 VTS 模型用的是
 * `ParamMouthOpen`（Param 风格命名）或 `PARAM_MOUTH_OPEN_Y`（大写风格），
 * 都不是 Live2D 官方示例里那个 `ParamMouthOpenY`。
 * 指到不存在的参数上，口型同步会**静默失效** —— 模型照样显示，只是不张嘴。
 */
function pickParams(dir) {
  const cdi = findFirst(dir, f => f.toLowerCase().endsWith('.cdi3.json'));
  if (!cdi) return { lipSync: null, eyeBlink: [] };
  let ids = [];
  try {
    const j = JSON.parse(fs.readFileSync(cdi, 'utf8'));
    ids = (j.Parameters || []).map(p => p.Id).filter(Boolean);
  } catch { return { lipSync: null, eyeBlink: [] }; }

  const firstOf = (cands) => cands.find(c => ids.includes(c)) || null;

  const lipSync = firstOf(['ParamMouthOpenY', 'PARAM_MOUTH_OPEN_Y', 'ParamMouthOpen', 'PARAM_MOUTH_OPEN'])
    // 兜底：任一含 mouth 且含 open 的参数
    || ids.find(id => /mouth/i.test(id) && /open/i.test(id)) || null;

  // 眨眼：和口型是同一类问题。VTS 的模型里 EyeBlink 组存在但 Ids 是空的，
  // 于是 autoInteract / 引擎的自动眨眼整个不生效 —— 模型一直瞪着眼。
  const lOpen = firstOf(['ParamEyeLOpen', 'PARAM_EYE_L_OPEN']);
  const rOpen = firstOf(['ParamEyeROpen', 'PARAM_EYE_R_OPEN']);
  const eyeBlink = [lOpen, rOpen].filter(Boolean);

  return { lipSync, eyeBlink };
}

function findFirst(dir, pred) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (pred(e.name)) return p;
    }
  }
  return null;
}

/**
 * 修补项目副本里的 model3.json。
 *
 * **这一步是必须的**：VTube Studio 的模型用自家的热键系统绑动作，
 * `model3.json` 里**根本没有 Motions 段**（只有 Moc / Textures / DisplayInfo）。
 * 只把 .motion3.json 文件复制过来，运行时一个都播不了 —— 33 个动作会变成死数据，
 * 而界面上看起来"文件都在"，非常容易误判成功能正常。
 *
 * 只改**项目里的副本**，VTS 安装目录全程只读。
 */
function patchModel3(targetDir, motionFiles, srcDir) {
  const m3 = findFirst(targetDir, f => f.toLowerCase().endsWith('.model3.json'));
  if (!m3) return { ok: false, why: '找不到 model3.json' };

  let j;
  try { j = JSON.parse(fs.readFileSync(m3, 'utf8')); } catch (e) { return { ok: false, why: `model3.json 解析失败：${e.message}` }; }

  j.FileReferences = j.FileReferences || {};
  const motions = groupMotions(motionFiles, srcDir);
  if (Object.keys(motions).length) j.FileReferences.Motions = motions;

  const { lipSync, eyeBlink } = pickParams(targetDir);
  j.Groups = Array.isArray(j.Groups) ? j.Groups : [];

  /**
   * 写入或**补全**一个参数组。
   *
   * 关键是"补全"这半句：VTS 的模型里 `LipSync` / `EyeBlink` 这两个组**是存在的**，
   * 但 `Ids` 是空数组（VTS 靠自己的热键系统绑，不往模型文件里写）。
   * 如果只判断"有没有这个组"，就会以为已经配好了而跳过 —— 结果是口型不动、
   * 眼睛不眨，且**不报任何错**。
   */
  const putGroup = (name, ids) => {
    if (!ids.length) return;
    const cur = j.Groups.find(g => String(g.Name || '').toLowerCase() === name.toLowerCase());
    if (cur) {
      if (!Array.isArray(cur.Ids) || !cur.Ids.length) cur.Ids = ids;
    } else {
      j.Groups.push({ Target: 'Parameter', Name: name, Ids: ids });
    }
  };

  putGroup('LipSync', lipSync ? [lipSync] : []);
  putGroup('EyeBlink', eyeBlink);

  fs.writeFileSync(m3, JSON.stringify(j, null, 2), 'utf8');
  return {
    ok: true,
    groups: Object.fromEntries(Object.entries(motions).map(([k, v]) => [k, v.length])),
    lipSync,
    eyeBlink,
  };
}

function main() {
  const force = process.argv.includes('--force');
  console.log('从本机 VTube Studio 导入 Live2D 模型\n');
  console.log('（只读复制；不导入第三方道具 PNG；产物在 public/models/ 下，不进仓库）\n');

  const vts = findVtsRoot();
  if (!vts) {
    console.log('  ✗ 没找到 VTube Studio 安装目录。');
    console.log('    可以在 Steam 库里确认它装在哪，然后用环境变量指定：');
    console.log('      set VTS_HOME=D:\\SteamLibrary\\steamapps\\common\\VTube Studio');
    process.exitCode = 1;
    return;
  }
  console.log(`  VTS 安装：${vts}`);

  const src = modelsRoot(vts);
  if (!fs.existsSync(src)) {
    console.log(`  ✗ 没找到模型目录：${src}`);
    process.exitCode = 1;
    return;
  }

  const existing = new Set(
    fs.existsSync(MODELS_DIR)
      ? fs.readdirSync(MODELS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
      : [],
  );
  console.log(`  项目现有形象：${[...existing].join(', ') || '（无）'}\n`);

  const entries = fs.readdirSync(src, { withFileTypes: true }).filter(e => e.isDirectory());
  const results = [];

  for (const e of entries) {
    const dir = path.join(src, e.name);
    const info = inspectModel(dir);
    if (!info) {
      results.push({ name: e.name, skipped: true, why: '不是完整的 Live2D 模型（缺 model3.json 或 moc3）' });
      continue;
    }

    // 去掉 VTS 后缀当项目里的 id：hiyori_vts → vts-hiyori（加前缀避免与已有模型重名）
    const baseName = e.name.replace(/_vts$/i, '').replace(/[^\w-]/g, '');
    const id = `vts-${baseName}`;
    const dst = path.join(MODELS_DIR, id);

    // 项目里已经有同名模型（例如本来就有的 hiyori）时的取舍：
    // VTS 那份往往就是同一个官方示例的另一版构建，盲目导入只会多一份重复形象。
    // 所以只在「VTS 那份的动作确实更多」时才导 —— 那样才真的多做得出动作。
    // 这条**不受 --force 影响**：--force 是"把这个模型重新导一遍"，
    // 不是"允许导入一份重复的形象"。
    if (existing.has(baseName)) {
      const mine = inspectModel(path.join(MODELS_DIR, baseName));
      const mineMotions = mine ? mine.motions.length : 0;
      if (info.motions.length <= mineMotions) {
        results.push({
          name: id, skipped: true,
          why: `项目里已有同名形象 ${baseName}（${mineMotions} 个动作），VTS 这份 ${info.motions.length} 个，没有多出来的`,
        });
        continue;
      }
      // 动作更多，值得导入，继续往下走
    }
    if (existing.has(id) && !force) {
      results.push({ name: id, skipped: true, why: '项目里已经有了（要重来加 --force）', motions: info.motions.length });
      continue;
    }
    if (fs.existsSync(dst) && force) fs.rmSync(dst, { recursive: true, force: true });

    const { copied, skippedFiles } = copyTree(dir, dst);

    // 补写 Motions / Groups 声明，否则复制过来的动作一个也播不了
    const patched = patchModel3(dst, info.motions, dir);

    // 写清单：界面上的名字与出处都从这里读（沿用项目现有的 manifest.json 约定）
    const label = baseName;
    fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify({
      label,
      note: `从本机 VTube Studio 安装导入的 Live2D 官方示例模型 ${label}。`
        + '模型版权归 Live2D Inc.，适用 Live2D Free Material License Agreement；'
        + '本仓库不包含该模型（public/models 不进版本库）。',
      tags: ['Live2D 官方示例', '第三方素材', '来自本机 VTube Studio'],
      source: 'VTube Studio (本机安装)',
      // 每个模型的口型参数名都不一样，实测后写进来，别写死
      lipSyncParam: patched.lipSync || null,
      motionGroups: patched.groups || null,
    }, null, 2), 'utf8');

    results.push({
      name: id, copied, skippedFiles,
      motions: info.motions.length, textures: info.textures.length,
      entry: path.basename(info.model3),
      patch: patched,
    });
  }

  console.log('  导入结果：');
  let imported = 0;
  let totalMotions = 0;
  const missingLipSync = [];
  for (const r of results) {
    if (r.skipped) {
      console.log(`    - ${r.name}：跳过（${r.why}）`);
      continue;
    }
    imported++;
    totalMotions += r.motions;
    console.log(`    ✓ ${r.name}：${r.copied} 个文件（含 ${r.motions} 个动作、${r.textures} 张纹理），入口 ${r.entry}`);
    if (r.patch?.ok) {
      const g = Object.entries(r.patch.groups || {}).map(([k, v]) => `${k}×${v}`).join('、') || '无';
      console.log(`        动作已登记：${g}；口型参数 ${r.patch.lipSync || '未找到（该模型不会随声音张嘴）'}`);
      if (!r.patch.lipSync) missingLipSync.push(r.name);
    } else if (r.patch) {
      console.log(`        ⚠ 动作登记失败：${r.patch.why}（动作文件已复制但播不出来）`);
    }
  }

  console.log(`\n  共导入 ${imported} 个形象、${totalMotions} 个动作。`);
  console.log('  ✓ 未修改 VTube Studio 安装（全程只读）。');
  console.log('  ✓ 未导入 Items 里的第三方道具 PNG。');

  if (imported) {
    console.log('\n  重启服务（或刷新页面）后，在「外观 → 更换形象」里就能选到它们。');
  }
}

main();
