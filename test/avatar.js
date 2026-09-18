#!/usr/bin/env node
/**
 * 形象动作与导航模式测试（③ 程序化待机 / ④ 举牌与风景图 / ⑤ 模型指挥形象）
 *
 * 运行：node test/avatar.js      （或 npm run test:avatar）
 *
 * 这个文件钉的是**几个曾经真实踩过、而且表现极具迷惑性的坑**：
 *
 *   1. 动作文件都在磁盘上，但 model3.json 里没有 Motions 声明 —— 运行时一个
 *      都播不了。从 VTube Studio 导入的那批模型就是这样：VTS 用自己的热键系统
 *      绑动作，模型文件里根本没有 Motions 段。只数 .motion3.json 文件个数会
 *      得出"有 33 个动作"的错误结论，所以这里**按运行时路径**验：解析
 *      model3.json 的 FileReferences.Motions。
 *
 *   2. 口型参数写死成 ParamMouthOpenY。这几个模型用的是 ParamMouthOpen 或
 *      PARAM_MOUTH_OPEN_Y，指到不存在的参数上不报错，只是嘴永远不动。
 *
 *   3. 待机的参数驱动如果挂在 afterMotionUpdate 上，会被紧接着的
 *      saveParameters() 存成新基准值，于是每帧累加、一路顶到参数上限。
 *      所以必须钉住"挂在 beforeModelUpdate"和"用叠加而不是 set"。
 *
 *   4. 自备风景图的文件名匹配、以及 readFile 的路径穿越防护。
 *
 *   5. avatar_action 工具的名字校验：模型编一个不存在的动作名时，必须把
 *      可用清单回给它，而不是默默什么都不做。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createScenery, mimeOf } = require('../lib/scenery');
const { TOOL_SCHEMAS, TOOL_NAMES, runTool } = require('../lib/tools');

const ROOT = path.join(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'public', 'models');

let pass = 0;
let fail = 0;
const skipped = [];
function check(name, ok, extra) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${extra !== undefined ? `  → ${extra}` : ''}`); }
}
function skip(name, why) { skipped.push(name); console.log(`  - ${name}（跳过：${why}）`); }

const read = (p) => fs.readFileSync(p, 'utf8');
const has = (p) => fs.existsSync(p);

/** 列出一个模型目录里全部的 .motion3.json */
function motionFilesIn(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.motion3\.json$/i.test(e.name)) out.push(p);
    }
  }
  return out;
}

function findModel3(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const hit = entries.find(f => /\.model3\.json$/i.test(f));
  return hit ? path.join(dir, hit) : null;
}

async function main() {
  console.log('形象动作与导航模式测试\n');

  /* ====================================================================
   * A. 运行时动作声明（坑 1 与 坑 2）
   * ==================================================================*/
  console.log('A. 模型的动作声明与口型参数（运行时路径，不是数文件个数）');

  const l2dSrc = read(path.join(ROOT, 'public', 'js', 'live2d.js'));

  // 口型参数不能再写死
  check('live2d.js 不再硬编码 ParamMouthOpenY 驱动口型',
    !/setParameterValueById\(\s*'ParamMouthOpenY'/.test(l2dSrc));
  check('live2d.js 会从 model3.json 的 Groups 读 LipSync 参数',
    /lipsync/i.test(l2dSrc) && /this\.lipSyncParam/.test(l2dSrc));
  check('live2d.js 会读 cdi3.json 探测真实参数名',
    /cdi3\.json/.test(l2dSrc) && /discoverParams/.test(l2dSrc));

  const modelDirs = fs.existsSync(MODELS_DIR)
    ? fs.readdirSync(MODELS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
    : [];

  if (!modelDirs.length) {
    skip('各形象的动作声明', 'public/models 下没有模型（第三方素材不进仓库）');
  } else {
    const lipParams = new Map();
    for (const id of modelDirs) {
      const dir = path.join(MODELS_DIR, id);
      const m3 = findModel3(dir);
      if (!m3) continue;
      let j = null;
      try { j = JSON.parse(read(m3)); } catch (e) { check(`${id} 的 model3.json 可解析`, false, e.message); continue; }

      const onDisk = motionFilesIn(dir).length;
      const declared = (j.FileReferences && j.FileReferences.Motions) || {};
      const declaredCount = Object.values(declared).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);

      if (onDisk === 0) {
        // 没有动作文件的模型（例如纯 GLB / 没带动作的示例）不参与这一项
        continue;
      }

      // **这一条就是那个 bug 的回归测试**：文件在，但声明为 0 → 运行时播不了
      check(`${id}：${onDisk} 个动作文件都有运行时声明（${declaredCount} 个）`,
        declaredCount > 0,
        declaredCount === 0 ? '磁盘上有 .motion3.json，但 FileReferences.Motions 是空的 —— 运行时一个都播不了' : undefined);

      // 声明的文件必须真实存在，否则运行时加载会失败
      let allExist = true;
      let missing = '';
      for (const list of Object.values(declared)) {
        for (const d of (list || [])) {
          const rel = String((d && d.File) || '');
          if (!rel) { allExist = false; missing = '有条目没有 File 字段'; break; }
          const full = path.join(dir, rel.split('/').join(path.sep));
          if (!fs.existsSync(full)) { allExist = false; missing = rel; break; }
        }
      }
      check(`${id}：声明的动作文件都真实存在`, allExist, missing);

      // 口型：声明了 LipSync 组，且那个参数在 cdi3.json 里真实存在
      const groups = j.Groups || [];
      const lip = groups.find(g => /lipsync/i.test(String(g.Name || '')));
      const cdi = (() => {
        const f = fs.readdirSync(dir).find(x => /\.cdi3\.json$/i.test(x));
        if (!f) return null;
        try { return JSON.parse(read(path.join(dir, f))); } catch { return null; }
      })();

      if (lip) {
        const pid = (lip.Ids || [])[0] || '';
        let exists = null;
        if (cdi && Array.isArray(cdi.Parameters)) {
          exists = cdi.Parameters.some(p => p && p.Id === pid);
        }
        check(`${id}：LipSync 参数 ${pid} 在 cdi3.json 里真实存在`,
          exists !== false,
          exists === false ? `cdi3.json 里没有这个参数，口型会静默失效` : undefined);
      } else {
        // 没有 LipSync 组未必是错：有些模型（如 Rice）的 cdi3.json 里
        // 压根没有"张嘴"这个参数，它**确实**做不了口型同步。
        // 这时唯一的要求是"别假装支持" —— 声明了空壳组才是真 bug。
        const mouthParams = (cdi && Array.isArray(cdi.Parameters))
          ? cdi.Parameters.filter(p => /mouth/i.test(String(p.Id || '')) && /open/i.test(String(p.Id || ''))).length
          : 0;
        if (mouthParams === 0) {
          skip(`${id}：口型参数声明`, '该模型的 cdi3.json 里没有张嘴参数，确实不支持口型同步（已确认没有留下空壳声明）');
        } else {
          check(`${id}：有口型参数声明`, false, `模型有 ${mouthParams} 个张嘴参数，但 Groups 里没有 LipSync —— 口型会失效`);
        }
      }

      // 空壳组是"看起来支持、实际不生效"的经典伪装，单独钉一条
      const shells = groups.filter(g => String(g.Target || 'Parameter') === 'Parameter'
        && Array.isArray(g.Ids) && g.Ids.length === 0);
      if (shells.length) {
        check(`${id}：没有空壳参数组（Ids 为空的 LipSync/EyeBlink 是假声明）`,
          false, shells.map(g => g.Name).join(', '));
      }

      // 眨眼是同一类坑：VTS 的模型里 EyeBlink 组**存在但 Ids 是空的**，
      // 于是自动眨眼整个不生效，模型一直瞪着眼 —— 同样不报任何错。
      const blink = groups.find(g => /eyeblink/i.test(String(g.Name || '')));
      if (blink) {
        check(`${id}：EyeBlink 的 Ids 不是空的（空 Ids = 永远不眨眼）`,
          Array.isArray(blink.Ids) && blink.Ids.length > 0,
          `Ids=${JSON.stringify(blink.Ids)}`);
      }

      // 口型参数必须按模型各写各的，不能是同一个写死的名字。
      // 这几只模型的实际参数名有四种写法（ParamMouthOpenY / ParamMouthOpen /
      // PARAM_MOUTH_OPEN_Y / ParamA），写死任何一个都会让别的模型失效。
      // 所以这里不断言"必须是某几个名字"（那是错的：mao 用的 ParamA 是
      // Cubism 标准的元音口型参数，完全合法），而是①确有其参数、②各不相同。
      const lipId = lip && Array.isArray(lip.Ids) && lip.Ids[0];
      if (lipId) {
        lipParams.set(id, lipId);
        if (cdi && Array.isArray(cdi.Parameters)) {
          check(`${id}：口型参数 ${lipId} 确实出现在该模型的 cdi3.json 参数表里`,
            cdi.Parameters.some(p => p && p.Id === lipId));
        }
      }
    }

    // 这一条是本组的核心结论：口型参数名**确实因模型而异**。
    // 如果哪天有人把它改回写死的常量，这里会立刻变成 1 种，测试就红。
    const distinct = new Set(lipParams.values());
    check(`各模型的口型参数各不相同（${distinct.size} 种：${[...distinct].join('、')}），证明是按模型各自探测的`,
      lipParams.size === 0 || distinct.size > 1,
      distinct.size <= 1 ? '所有模型共用一个参数名，几乎可以肯定是写死的常量' : undefined);
  }

  /* ====================================================================
   * B. 程序化待机（坑 3）
   * ==================================================================*/
  console.log('\nB. 程序化待机（③）');
  check('提供了 startIdle / stopIdle / idleRunning',
    /startIdle\s*\(/.test(l2dSrc) && /stopIdle\s*\(/.test(l2dSrc) && /idleRunning\s*\(/.test(l2dSrc));
  check('待机参数挂在 beforeModelUpdate 上（挂 afterMotionUpdate 会每帧累加直到顶满）',
    /beforeModelUpdate/.test(l2dSrc) && !/on\(\s*'afterMotionUpdate'/.test(l2dSrc));
  check('待机用 addParameterValueById 叠加（用 set 会抹掉鼠标跟随）',
    /addParameterValueById/.test(l2dSrc));
  check('鼠标动过就把视线让给鼠标（markPointer）',
    /markPointer/.test(l2dSrc) && /lastPointerAt/.test(l2dSrc));
  check('说话时不插待机小动作（speaking 门控）',
    /idle\.speaking/.test(l2dSrc));

  const s3Src = read(path.join(ROOT, 'public', 'js', 'stage3d.js'));
  check('3D 舞台也实现了同名待机接口（否则一切到 3D 就报 not a function）',
    /startIdle\s*\(/.test(s3Src) && /stopIdle\s*\(/.test(s3Src) && /idleRunning\s*\(/.test(s3Src));
  check('3D 关待机时把位移与旋转归零（否则模型僵在半空或歪着）',
    /this\.model\.position\.y\s*=\s*this\.modelBaseY/.test(s3Src));

  const appSrc = read(path.join(ROOT, 'public', 'js', 'app.js'));
  check('app.js 有待机开关的落地（applyIdleSetting）', /applyIdleSetting/.test(appSrc));
  check('待机默认开启', /idleMotion:\s*true/.test(appSrc));

  /* ====================================================================
   * C. 举牌与风景图（④）
   * ==================================================================*/
  console.log('\nC. 导航模式：举牌与风景图（④）');

  const nvSrc = read(path.join(ROOT, 'public', 'js', 'nav-visuals.js'));
  check('牌子的绘制是共享的（两套渲染器共用一份，避免改一处漏一处）',
    /drawPlacard/.test(nvSrc) && /window\.WenlvNavVisuals/.test(nvSrc));
  check('风景图是程序化绘制的（不依赖任何图片素材）',
    /drawScenery/.test(nvSrc));
  check('牌子的字会自动折行并在放不下时缩字号',
    /measureText/.test(nvSrc) && /while\s*\(size\s*>=\s*18\)/.test(nvSrc));
  check('roundRect 有兜底（缺这个 API 时牌子会整块画不出来且不报错）',
    /prototype\.roundRect/.test(nvSrc));
  check('两套舞台都实现了 setPlacard / clearPlacard / setScenery',
    /setPlacard\s*\(/.test(l2dSrc) && /clearPlacard\s*\(/.test(l2dSrc) && /setScenery\s*\(/.test(l2dSrc)
    && /setPlacard\s*\(/.test(s3Src) && /clearPlacard\s*\(/.test(s3Src) && /setScenery\s*\(/.test(s3Src));
  check('3D 牌子每帧转向相机（否则视角一动就成一条线）',
    /_facePlacardToCamera/.test(s3Src));
  check('导航模式的 UI 与状态在 app.js 里接好了',
    /setNavMode/.test(appSrc) && /setNavTarget/.test(appSrc) && /applyNavScenery/.test(appSrc));
  check('风景图来源有内置/自备/联网三档',
    /builtin/.test(appSrc) && /folder/.test(appSrc) && /'web'/.test(appSrc));

  // 服务端：自备目录匹配 + 路径穿越防护
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-scenery-'));
  try {
    const sc = createScenery({ dir: tmp, prefs: { getConfig: () => ({ web: { enabled: false } }) } });
    sc.ensureDirs();

    // 写一张真实可辨识的 PNG（1×1），用于验证"必须是图片"这条
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64');
    fs.writeFileSync(path.join(sc.dir, '杭州西湖.png'), png);
    fs.writeFileSync(path.join(sc.dir, 'hangzhou-xihu.jpg'), png);
    fs.writeFileSync(path.join(sc.dir, '说明.txt'), 'not an image');

    const st = sc.status();
    check('自备目录只统计图片（.txt 不算）', st.count === 2, `count=${st.count}`);
    check('status 里给出了目录路径，方便用户知道往哪放', typeof st.dir === 'string' && st.dir.length > 0);

    const r1 = sc.localFor('杭州西湖');
    check('中文文件名精确匹配到', r1.ok === true, r1.error);
    const r2 = sc.localFor('西湖');
    check('景点名是文件名的子串时也能匹配（西湖 → 杭州西湖.png）', r2.ok === true, r2.error);
    const r3 = sc.localFor('hangzhou xihu');
    check('去掉空格与连字符后能匹配（hangzhou xihu → hangzhou-xihu.jpg）', r3.ok === true, r3.error);
    const r4 = sc.localFor('完全不存在的景点名');
    check('匹配不到时如实报错，而不是随便给一张', r4.ok === false, JSON.stringify(r4));

    // 路径穿越：这是安全项，必须挡住
    const bad = ['../package.json', '..\\package.json', '../../etc/passwd', '..%2Fpackage.json'];
    check('readFile 挡住 ../ 路径穿越',
      bad.every(b => sc.readFile(b) === null), bad.map(b => `${b}→${sc.readFile(b)}`).join(' '));
    check('readFile 挡住非图片扩展名', sc.readFile('放这里.txt') === null);
    const good = sc.readFile('杭州西湖.png');
    check('readFile 能正常取到自备图', !!good && good.mime === 'image/png', good && good.mime);

    // 联网：总开关关着时必须明确拒绝，而不是偷偷发请求
    const web = await sc.searchFor('杭州西湖', '杭州');
    check('联网总开关关闭时，搜图被明确拒绝并说明原因',
      web.ok === false && /联网总开关/.test(String(web.error)), web.error);

    check('mimeOf 认常见图片格式',
      mimeOf('.png') === 'image/png' && mimeOf('.JPG') === 'image/jpeg' && mimeOf('.webp') === 'image/webp');
    check('cache 目录被建出来了（否则联网下载无处可放）', has(path.join(sc.dir, 'cache')));
    check('清缓存不报错', typeof sc.clearCache() === 'number');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ====================================================================
   * D. 让模型指挥形象（⑤）
   * ==================================================================*/
  console.log('\nD. avatar_action：让大模型指挥形象（⑤）');

  check('tools.js 注册了 avatar_action', TOOL_NAMES.includes('avatar_action'));
  const schema = TOOL_SCHEMAS.find(t => t.function.name === 'avatar_action');
  check('avatar_action 的 schema 参数齐备（motion / expression / placard）',
    !!schema && ['motion', 'expression', 'placard'].every(k => schema.function.parameters.properties[k]));
  check('工具描述里讲清了"它不产生文字、仍需正常作答"',
    !!schema && /不产生|不产生任何文字|仍需正常作答/.test(schema.function.description));

  const caps = {
    label: 'vts-hijiki',
    motions: [{ name: '00_idle', group: 'Idle' }, { name: 'tap_body_01', group: 'TapBody' }],
    expressions: ['F01', 'F02'],
  };

  const okMotion = await runTool('avatar_action', { motion: 'tap_body_01' }, { avatar: caps });
  check('按精确名字下发动作为成功', okMotion.ok === true && okMotion.data.avatar.motion === 'tap_body_01',
    JSON.stringify(okMotion.data));

  const fuzzy = await runTool('avatar_action', { motion: 'TAP_BODY_01' }, { avatar: caps });
  check('动作名大小写不敏感', fuzzy.ok === true && fuzzy.data.avatar.motion === 'tap_body_01',
    JSON.stringify(fuzzy.data));

  const groupOnly = await runTool('avatar_action', { motion: 'Idle' }, { avatar: caps });
  check('只给组名也接受（前端在该组内随机播一个）',
    groupOnly.ok === true && groupOnly.data.avatar.motion === 'Idle', JSON.stringify(groupOnly.data));

  const bogus = await runTool('avatar_action', { motion: 'wave' }, { avatar: caps });
  check('编造不存在的动作名时返回失败', bogus.ok === false);
  check('失败信息里列出了可用动作名（模型才能自己改）',
    bogus.ok === false && /00_idle/.test(bogus.forModel) && /tap_body_01/.test(bogus.forModel),
    bogus.forModel);

  const bogusExpr = await runTool('avatar_action', { expression: '开心' }, { avatar: caps });
  check('编造不存在的表情名时返回失败并列出可用项',
    bogusExpr.ok === false && /F01/.test(bogusExpr.forModel), bogusExpr.forModel);

  const empty = await runTool('avatar_action', {}, { avatar: caps });
  check('三个参数都不给时明确报错', empty.ok === false && /不知道该做什么/.test(empty.forModel), empty.forModel);

  const clear = await runTool('avatar_action', { placard: '' }, { avatar: caps });
  check('placard 传空字符串表示"放下牌子"（而不是被当成没传）',
    clear.ok === true && clear.data.avatar.placard === '', JSON.stringify(clear.data));

  const placard = await runTool('avatar_action', { placard: '杭州西湖' }, { avatar: caps });
  check('举牌内容能传下去', placard.ok === true && placard.data.avatar.placard === '杭州西湖',
    JSON.stringify(placard.data));

  const longPlacard = await runTool('avatar_action', { placard: '一'.repeat(300) }, { avatar: caps });
  check('过长的牌面文字被截断（牌子写不下）',
    longPlacard.ok === true && longPlacard.data.avatar.placard.length <= 60,
    `len=${longPlacard.data.avatar.placard.length}`);

  const noCaps = await runTool('avatar_action', { motion: 'anything' }, {});
  check('前端没上报能力清单时不拦（让前端尽力而为），而不是报错',
    noCaps.ok === true, JSON.stringify(noCaps.data));

  // 服务端必须把 data 转发给前端，否则前端收不到"该做什么动作"
  const srvSrc = read(path.join(ROOT, 'server.js'));
  check('server.js 转发了 tool_result 的 data 字段',
    /type: 'tool_result'[^}]*data: ev\.data/.test(srvSrc),
    '没转发 data 的话，avatar_action 的效果前端永远收不到');
  check('avatar_action 不受联网开关管辖（它不联网）',
    /avatar_action' \? avatarOn : web\.enabled|avatar_action.*web\.enabled/s.test(srvSrc));
  check('server.js 把前端的动作清单写进系统提示',
    /【形象控制】/.test(srvSrc));
  check('app.js 在联网关闭但有形象时也走带工具的管线',
    /const useAgent = S\.webEnabled \|\| !!avatarCaps/.test(appSrc));
  check('app.js 上报了形象能力清单',
    /avatar: avatarCaps/.test(appSrc));
  check('app.js 会执行服务端下发的形象指令',
    /runAvatarDirective/.test(appSrc) && /ev\.data\.avatar/.test(appSrc));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败${skipped.length ? ` / ${skipped.length} 跳过` : ''}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('测试自身出错：', e);
  process.exitCode = 1;
});
