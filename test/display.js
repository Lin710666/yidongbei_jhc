#!/usr/bin/env node
/**
 * 大屏适配 / 西湖形象 / 视频背景 / 开屏 测试（③④⑤⑥）
 *
 * 运行：node test/display.js      （或 npm run test:display）
 *
 * 这一组功能有个共同点：**它们全是"看不出来坏没坏"的那类**。
 *   · 大屏断点写错了，只有真的在 4K 上打开才发现字小得像蚂蚁
 *   · 形象少实现一个方法，用户一切过去就 "xxx is not a function"
 *   · 视频接口不做 Range 支持，浏览器拖进度条就废（甚至直接拒绝播）
 *   · 开屏状态没持久化，每次刷新都弹一次 —— 用户三分钟内就会去关掉它
 *
 * 所以下面钉的是这些"静默失败"的具体判据，而不是"文件存在"这种没营养的检查。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createVideos } = require('../lib/videos');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const has = (p) => fs.existsSync(path.join(ROOT, p));

let pass = 0;
let fail = 0;
const skipped = [];
function check(name, ok, extra) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${extra !== undefined ? `  → ${extra}` : ''}`); }
}
function skip(name, why) { skipped.push(name); console.log(`  - ${name}（跳过：${why}）`); }

async function main() {
  console.log('大屏适配 / 西湖形象 / 视频背景 / 开屏 测试\n');

  /* ====================================================================
   * ③ 大屏适配
   * ==================================================================*/
  console.log('③ 大屏适配');
  const css = read('public/css/airi.css');

  // 原来的响应式只有 max-width（窄屏），大屏那半边是空的 —— 这正是"大屏不支持"的根因
  check('CSS 有 min-width 方向的断点（原来只有 max-width，大屏那半边是空的）',
    /@media\s*\(min-width:\s*\d+px\)/.test(css));
  for (const [label, px] of [['宽屏', 1600], ['2K', 2200], ['4K', 3200]]) {
    check(`有 ${label}（${px}px）断点`, new RegExp(`min-width:\\s*${px}px`).test(css));
  }
  check('大屏断点里抬了基准字号（否则 4K 上 14px 根本看不清）',
    /min-width:\s*1600px[\s\S]{0,200}body\s*\{[^}]*font-size/.test(css));
  check('Kiosk 全屏展示模式：藏掉侧栏，只留舞台',
    /body\.kiosk\s+\.side\s*\{\s*display:\s*none/.test(css));
  check('Kiosk 下顶栏默认隐藏、鼠标移上去才浮出（给了退出的路）',
    /body\.kiosk[^{]*\.topbar[^{]*\{[^}]*opacity:\s*0/.test(css)
    && /body\.kiosk:hover\s+\.topbar[^{]*\{[^}]*opacity:\s*1/.test(css));
  check('CSS 里没有 JS 风格的 // 注释（那是无效语法，会让后面的规则整段失效）',
    !/^\s*\/\//m.test(css));
  {
    const o = (css.match(/\{/g) || []).length;
    const c = (css.match(/\}/g) || []).length;
    check('CSS 花括号配平', o === c, `{ ${o} 个 / } ${c} 个`);
  }

  const app = read('public/js/app.js');
  check('app.js 有大屏模式开关（含请求浏览器全屏）', /function setKiosk/.test(app) && /requestFullscreen/.test(app));
  check('切大屏后通知舞台重算尺寸（否则人物还按旧画布尺寸摆着）',
    /setKiosk[\s\S]{0,900}st\.resize/.test(app));

  /* ====================================================================
   * ④ 西湖形象
   * ==================================================================*/
  console.log('\n④ 西湖形象（程序化绘制）');
  check('public/js/lake.js 存在', has('public/js/lake.js'));
  const lake = read('public/js/lake.js');
  check('导出 LakeAvatar 与 LAKE_AVATAR', /LakeAvatar/.test(lake) && /LAKE_AVATAR/.test(lake));
  check('形象是原创程序化绘制（不依赖任何模型文件或纹理）', (() => {
    // 注意要排除 preview(预览图) 与 note 里的说明文字 —— 它们提到 .png 是正常的，
    // 真正的判据是：绘制过程不加载任何模型/纹理/骨骼文件。
    const drawSrc = lake.replace(/preview:\s*'[^']*'/g, '').replace(/note:\s*'[^']*'/gs, '');
    return !/\.model3\.json|\.moc3|\.vrm|\.glb|\.exp3\.json/.test(drawSrc)
      && /createLinearGradient|createRadialGradient/.test(drawSrc);
  })());
  check('形象主题明确是西湖（船娘 + 油纸伞 + 青绿配色）',
    /西湖船娘/.test(lake) && /umbrella/.test(lake) && /robe/.test(lake));
  check('index.html 引用了 lake.js', read('public/index.html').includes('/js/lake.js'));

  // 三套舞台必须实现同一组方法 —— 少一个，用户切过去就 "xxx is not a function"
  const l2d = read('public/js/live2d.js');
  const s3d = read('public/js/stage3d.js');
  const REQUIRED = ['init', 'load', 'setScale', 'setPosition', 'setExpression', 'playMotion',
    'playMotionByName', 'listMotions', 'speak', 'resize', 'destroy',
    'startIdle', 'stopIdle', 'idleRunning', 'setPlacard', 'clearPlacard', 'setScenery'];
  const missing = [];
  for (const m of REQUIRED) {
    for (const [name, src] of [['live2d', l2d], ['stage3d', s3d], ['lake', lake]]) {
      if (!new RegExp(`(^|[^\\w])${m}\\s*\\(`).test(src)) missing.push(`${name}.${m}`);
    }
  }
  check('三套舞台（西湖/Live2D/3D）都实现了同一组方法',
    missing.length === 0, missing.join(', '));

  check('app.js 的 activeStage() 认识 lake 这一套',
    /S\.display\.kind === 'lake'/.test(app) || /kind === 'lake'\)\s*return lake/.test(app));
  check('app.js 有 ensureLake 工厂', /function ensureLake/.test(app));
  check('西湖船娘排在形象清单最前（它是默认形象）',
    /LAKE_AVATAR[\s\S]{0,200}l2dModels/.test(app));
  const cards = read('lib/cards.js');
  check('内置角色卡的默认形象是内置的「江南古风少女」（原来是根本不存在的 nahida）',
    /model: 'lake-boatwoman'/.test(cards) && !/model: 'nahida'/.test(cards));
  check('西湖船娘改名为「江南古风少女」并带预览图',
    /label: '江南古风少女'/.test(read('public/js/lake.js')) && /preview: '\/avatars\//.test(read('public/js/lake.js')));
  check('角色卡带 kind 字段（否则前端只能靠猜该用哪套渲染器）',
    /kind: \(c\.live2d && c\.live2d\.kind\) \|\| 'lake'/.test(cards));

  /* ====================================================================
   * ⑤ 视频背景
   * ==================================================================*/
  console.log('\n⑤ 视频背景');
  check('lib/videos.js 存在', has('lib/videos.js'));
  check('backgrounds.js 支持 video 类型', /kind === 'video'/.test(read('public/js/backgrounds.js')));
  check('index.html 有 <video id="bg-video">（并带 muted —— 自动播放的硬性前提）',
    /<video[^>]*id="bg-video"[^>]*muted/.test(read('public/index.html')));
  check('视频切走时会停掉播放（只把 opacity 设 0 的话它还在后台解码烧 GPU）',
    /_stopVideo/.test(read('public/js/backgrounds.js')));
  check('内置程序化西湖背景兜底（data/videos 为空时不会是黑屏）',
    /id:\s*'proc-lake'/.test(read('lib/backgrounds.js')) && /renderer:\s*'lake'/.test(read('lib/backgrounds.js')));
  check('西湖背景排在程序化清单第一位', /PROCEDURAL = \[\s*\{[\s\S]{0,300}proc-lake/.test(read('lib/backgrounds.js')));

  const srv = read('server.js');
  check('server.js 注册了 /api/videos 系列接口', /'\/api\/videos'/.test(srv));
  check('视频接口支持 Range 请求（不做的话浏览器拖进度条会废）',
    /Content-Range/.test(srv) && /206/.test(srv) && /Accept-Ranges/.test(srv));

  // 真跑一遍 videos 模块
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-vid-'));
  try {
    const v = createVideos({ dir: tmp });
    v.ensureDir();
    check('空目录时 status.hasAny 为 false（前端据此决定要不要兜底）', v.status().hasAny === false);
    check('目录里会自动生成一份说明（省得用户猜该往哪放）',
      fs.existsSync(path.join(v.dir, '放这里.txt')));

    const buf = Buffer.alloc(4096, 7);
    const r = v.save(buf.toString('base64'), '西湖宣传片.mp4');
    check('能保存视频', r.ok === true, r.error);
    const list = v.list().items;
    check('保存后能列出', list.length === 1, JSON.stringify(list.map(i => i.id)));
    check('文件名含"西湖"的被标为推荐', list[0].recommended === true);
    check('推荐项会出现在 status 里（前端直接用它）', v.status().recommended && v.status().recommended.id === list[0].id);

    const bad = v.save(null, 'x.mp4');
    check('空数据被拒', bad.ok === false, JSON.stringify(bad));

    // 路径穿越：只读接口的安全底线
    const evil = ['../package.json', '..\\server.js', '/etc/passwd', '../../x.mp4'];
    check('readFile 挡住 ../ 路径穿越', evil.every(e => v.readFile(e) === null),
      evil.map(e => `${e}→${v.readFile(e)}`).join(' '));
    check('readFile 拒绝非视频扩展名', v.readFile('放这里.txt') === null);
    check('readFile 能正常取到视频（并带上 mime 与字节数）',
      (() => { const h = v.readFile(list[0].id); return h && h.mime === 'video/mp4' && h.bytes === 4096; })());

    check('删除能生效', v.remove(list[0].id).ok === true && v.status().count === 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ====================================================================
   * ⑥ 开屏（两套模板）
   * ==================================================================*/
  console.log('\n⑥ 开屏（两套可互相切换的模板）');
  check('public/js/boot.js 存在', has('public/js/boot.js'));
  const boot = read('public/js/boot.js');
  const html = read('public/index.html');
  check('index.html 在 app.js 之前引用 boot.js（app.js 启动时要挂它）',
    html.indexOf('/js/boot.js') > -1 && html.indexOf('/js/boot.js') < html.indexOf('/js/app.js'));

  check('模板 A：视频主页', /id:\s*'video'/.test(boot) && /视频主页/.test(boot));
  check('模板 B：形象主页', /id:\s*'character'/.test(boot) && /形象主页/.test(boot));
  check('正好两套模板（多一套少一套都不符合需求）',
    (boot.match(/\{\s*id:\s*'(video|character)'/g) || []).length === 2);

  check('三个功能入口：对话 / 设置 / API 接入',
    /id:\s*'chat'/.test(boot) && /id:\s*'settings'/.test(boot) && /id:\s*'api'/.test(boot));
  check('每个入口都绑了**不同**的形象动作（这是模板 B 的核心交互）', (() => {
    const names = [...boot.matchAll(/motion:\s*\{\s*name:\s*'([^']+)'/g)].map(m => m[1]);
    return names.length === 3 && new Set(names).size === 3;
  })(), [...boot.matchAll(/motion:\s*\{\s*name:\s*'([^']+)'/g)].map(m => m[1]).join(','));
  check('悬停入口时真的会让形象做动作',
    /playMotionByName/.test(boot) && /mouseenter/.test(boot));

  check('模板选择会持久化（否则每次刷新都要重选）',
    /localStorage/.test(boot) && /saveState/.test(boot));
  check('"已进入"标记也持久化：一次会话只自动弹一次（每次都弹会被用户关掉）',
    /entered/.test(boot) && /autoShow/.test(boot));
  check('提供切换模板的方法，且切完重播入场动画（否则用户以为没生效）',
    /function setTemplate/.test(boot) && /boot-in/.test(boot) && /offsetWidth/.test(boot));
  check('Esc 能直接进入主界面（别让用户被开屏困住）', /Escape/.test(boot));

  check('CSS 有模板 B 的专用布局（左侧竖排菜单、背景透明露出真实舞台）',
    /data-tpl="character"/.test(css));
  check('CSS 有开屏入场动画', /@keyframes bootFadeUp|@keyframes bootSlideIn/.test(css));
  check('开屏也尊重"减少动态效果"', /prefers-reduced-motion[\s\S]{0,300}\.boot/.test(css));

  // --- `[hidden]` 必须压得住作者样式（这个坑项目里踩了四次）---
  // 给元素写了 display: grid/flex 之后，UA 的 [hidden]{display:none} 就被顶掉了，
  // 于是 el.hidden = true 只改属性、元素照样显示 —— 开屏关不掉、结果卡浮着。
  // 用 el.hidden 去断言还测不出来（属性确实是 true），必须查计算样式。
  check('CSS 有全局 `[hidden] { display: none !important }`（一次性堵住这类坑）',
    /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css));
  check('.boot 自己也有 [hidden] 规则',
    /\.boot\[hidden\]\s*\{\s*display:\s*none/.test(css));
  check('其它浮层也有各自的 [hidden] 规则（对照）',
    /\.stage-empty\[hidden\]/.test(css) && /\.result-card\[hidden\]/.test(css));

  // --- stageProblem / stageOk 必须用 hidden 属性，不能用不存在的 .hidden 类 ---
  {
    const sp = /function stageProblem[\s\S]*?\n  \}/.exec(app);
    const so = /function stageOk[\s\S]*?\n  \}/.exec(app);
    check('stageProblem 用 hidden 属性显示提示（原来操作的是不存在的 .hidden 类，等于空操作）',
      !!sp && /\.hidden\s*=\s*false/.test(sp[0]), sp && sp[0].slice(0, 80));
    check('stageOk 用 hidden 属性隐藏', !!so && /\.hidden\s*=\s*true/.test(so[0]));
    check('没有再拿 classList 操作 hidden 类（项目里根本没有这个类）', (() => {
      // 先剥掉注释再查：代码注释里正解释着这个坑，别把注释里的示例当成真代码
      const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
      const all = strip(l2d) + strip(s3d) + strip(app);
      return !/classList\.(add|remove|toggle)\('hidden'\)/.test(all);
    })());
    check('"还没有模型，请去下载"这类提示确实存在（修好之后用户才看得到）',
      /获取示例模型\.bat/.test(app) && /模型是第三方素材/.test(app));
  }

  // 关键设计：模板 B 不复制任何第三方游戏素材。
  // 注意 boot.js 里现在**有**一个外部地址（B 站播放器），那是用户可选的背景视频，
  // 不是界面素材 —— 所以判据要写成"除 B 站播放器外没有别外链"，而不是"完全没有外链"。
  // 之前那条写成 !/https?:\/\// 的断言，在加了 B 站功能之后就成了误报。
  {
    const externals = [...new Set([...boot.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(m => m[1]))];
    const nonBili = externals.filter(h => !/bilibili\.com$/.test(h));
    check('模板 B 不含任何第三方游戏素材（除可选的 B 站播放器外没有任何外链）',
      nonBili.length === 0 && !/miside|米塔/i.test(boot), externals.join(', '));
    check('boot.js 自身不加载任何外部脚本/样式/图片（外链只有 B 站播放器这一处 iframe）',
      !/(src|href)\s*=\s*["']https?:/i.test(boot.replace(/f\.src = url;?/g, ''))
      && !/<script|<link/i.test(boot));
    check('没有视频时仍用程序化西湖画面兜底（首次打开 data/videos/ 是空的）',
      /没有视频 → 用程序化绘制的西湖动态画面兜底/.test(boot) && /startCanvas\(\)/.test(boot));
  }

  // --- 开屏背景视频：**本机文件** + 声音 + 静音开关 ---
  //
  // 演进过程值得记一笔：最早用 B 站官方 iframe 播放器内嵌（合规、不下载），
  // 但实际用起来有三个硬伤：播放器自带界面压不住、必须联网（断网黑屏）、
  // 竖屏片源在横屏窗口里只剩中间一条。现在统一改成"下载到 data/videos/ 再播"。
  // 下载用 `npm run fetch:bili`（走 B 站 API 取流 + ffmpeg 合并音轨）。
  check('开屏用的是本机 <video>，不再内嵌任何 iframe 播放器',
    /class="boot-video"/.test(boot) && !/boot-embed/.test(boot) && !/player\.bilibili\.com/.test(boot));
  check('模板 B 下不再需要处理内嵌播放器', !/hideEmbed|showEmbed/.test(boot));
  check('开屏视频有两路（前景完整显示 + 模糊铺底），竖屏进横屏也不留黑边',
    /class="boot-video-bg"/.test(boot) && /\.boot-video-bg[\s\S]{0,200}blur\(/.test(css));
  check('画面模式三选一（cover / auto / rotate）都有对应样式',
    /data-fit="cover"\]\s+\.boot-video\s*\{\s*object-fit:\s*cover/.test(css)
    && /data-fit="rotate"\]\s+\.boot-video/.test(css) && /rotate\(90deg\)/.test(css));
  check('覆盖 object-fit 时带上了 .boot-media 层（旧规则 (0,1,1) 优先级更高，不带就写不生效）',
    /\.boot-media\s+\.boot-video\s*\{\s*object-fit:\s*contain/.test(css));
  check('界面提供画面模式切换与视频选择下拉',
    html.includes('video-fit-seg') && html.includes('boot-video-sel'));
  check('画面模式是**开屏与主界面共用**的一个设置（两处常播同一个片源，分两个开关只会来回切两遍）',
    /#video-fit-seg/.test(app) && /body\.dataset\.vfit/.test(app)
    && /body\[data-vfit="rotate"\]\s+#bg-video/.test(css));
  check('主界面背景视频也支持三种画面模式（不只是开屏）',
    /body\[data-vfit="auto"\]\s+#bg-video/.test(css) && /#bg-video\s*\{[^}]*object-fit:\s*cover/.test(css));
  check('主界面背景来自服务端偏好 video.main（配置一次、多屏共用）',
    /config\.video/.test(app) && /mainHit/.test(app) && /'video:'?\s*\[/.test(srv + read('lib/prefs.js')) === false
    || /video: \['main'\]/.test(read('lib/prefs.js')));
  check('视频卡片有真缩略图（不是一枚 🎬 图标 —— 用户是在几张片子里挑，看不到画面等于盲选）',
    /pick-video-thumb/.test(app) && /preload: 'metadata'/.test(app));
  check('每张视频卡有「主界面 / 开屏 / 删除」三个动作',
    /'🖥 主界面'/.test(app) && /'🎬 开屏'/.test(app) && /删除这个视频/.test(app));
  check('视频卡不再是 <button>（里面还有按钮，按钮套按钮在 HTML 里非法）', (() => {
    // 只查 renderVideos 这一段：背景/形象选择器的卡片仍是 <button>，那没问题
    // （它们里面没有按钮）。视频卡里放了三个操作按钮，就必须换成 div。
    const seg = /function renderVideos\(\)[\s\S]*?\n  \}/.exec(app);
    if (!seg) return false;
    return /el\('div',\s*\{\s*\n\s*class: `pick-card pick-card-video/.test(seg[0])
      && !/el\('button',\s*\{\s*\n\s*class: `pick-card pick-card-video/.test(seg[0]);
  })());
  check('界面上写明了视频来自本机、离线可用', /本机文件、离线可用/.test(html));

  // 声音：浏览器自动播放策略下必须先静音起播，再由用户点击开声
  check('永远先静音起播（带声音的自动播放会被浏览器拦掉，连画面都出不来）',
    /v\.muted = true;[\s\S]{0,900}?const p = v\.play\(\)/.test(boot));
  check('绝不按偏好直接解除静音（那正是"视频不动"的根因）',
    !/applyMute\(wantSound\)|v\.muted = false;[\s\S]{0,80}v\.play\(\);\s*\}\s*\n\s*\/\/ 模糊底衬/.test(boot));
  check('偏好"有声"时挂到**第一次真实用户交互**上去开声（唯一被放行的时机）',
    /function armFirstGestureUnmute/.test(boot) && /pointerdown[\s\S]{0,200}once: true/.test(boot));
  check('开屏上有静音开关按钮',
    /id="boot-mute"/.test(boot) && /muteBtn\.addEventListener\('click'/.test(boot));
  check('开关按**视频实际静音状态**翻转，不是按偏好（否则会"点了没反应"）',
    /const next = !\(videoEl && videoEl\.muted\)/.test(boot));
  check('切到"有声"时把音量也设回 1（只改 muted 有时会留下极小音量）',
    /if \(!muted\) \{[\s\S]{0,90}v\.volume = 1/.test(boot));
  check('静音选择会存到服务端偏好（换设备/换浏览器一致）',
    /onMutedChange[\s\S]{0,220}\/api\/prefs/.test(app));
  check('按钮文案区分三种情况：有声 / 点击开启声音 / 静音中',
    /'🔊 有声'/.test(boot) && /'🔇 点击开启声音'/.test(boot) && /'🔇 静音中'/.test(boot));
  check('不再有 B 站元数据接口（开屏改用本机文件后就成死代码，已删）',
    !/\/api\/bili\/meta/.test(srv));

  check('app.js 接好了开屏（入口回调 + 重新播放按钮 + 模板切换段）',
    /function initBoot/.test(app) && /onBootEnter/.test(app) && /boot-tpl-seg/.test(app));

  // --- 模板 B：与主界面形象同步（真实翻车点）---
  // 踩过的坑：模板 B 的设计是"透明层露出主界面真实舞台"，但开屏自己也有一张
  // 兜底画布，只停了它的 rAF、没把 opacity 归零 —— 上一帧的程序化西湖图还留在上面，
  // 把真实形象整个盖住。表现就是"第 2 套里看到的不是主界面的形象"。
  check('模板 B 会把开屏自己的兜底画布让开（停动画 ≠ 让开，必须 opacity 归零）',
    /if \(canvasEl\) canvasEl\.style\.opacity = '0'/.test(boot));
  check('模板 B 会收起主界面的操作界面（词云/顶栏/侧栏），只留角色',
    /body\.boot-character\s+\.side/.test(css) && /body\.boot-character\s+#wordcloud-layer/.test(css)
    && /body\.boot-character\s+\.topbar/.test(css));
  check('收起/放回是成对的（用 body 上的类，不是逐元素改 style）',
    /classList\.toggle\('boot-character'/.test(boot) && /classList\.remove\('boot-character'\)/.test(boot));

  // --- 动作：随机取；一个都没有就不播 ---
  check('动作先是"偏好的"，失败后随机取一个它能播的',
    /m\.name && await tryOne/.test(boot) && /Math\.random\(\) \* available\.length/.test(boot));
  check('形象一个动作都没有时**什么都不做**（不再无条件兜底成"点头"假反应）',
    /const hasNone = Array\.isArray\(available\) && available\.length === 0/.test(boot)
    && /if \(hasNone\) return false/.test(boot));
  check('不再有"无条件兜底随机播一个"（那会让没动作的形象也抖一下）',
    !/return tryOne\(\(\) => stage\.playMotion && stage\.playMotion\(\)\);/.test(boot));
  check('开屏入口用的是既有的页签切换函数（不是去点 DOM）',
    /onBootEnter[\s\S]{0,900}switchTab\(/.test(app) && !/onBootEnter[\s\S]{0,900}\.click\(\)/.test(app));
  check('外观页有视频面板与开屏模板切换的 UI',
    html.includes('video-list') && html.includes('boot-tpl-seg') && html.includes('video-dir'));

  // --- 定位导航：小卡片取代举牌 + 整页导航 ---
  //
  // 用户反馈原来让形象举的大木牌"太突兀"（比人物还显眼、还挡风景）。
  // 改成两层：舞台角落的小卡片 + 点开之后的整页导航。
  check('形象不再画举牌（用户反馈太突兀）',
    !/^\s+this\._drawPlacard\(g, w, h/m.test(lake) && /不再画举牌/.test(lake));
  check('举牌方法本身保留着（以后想做成可选展示还能用）', /_drawPlacard\(g, w, h, cx, baseY, s\) \{/.test(lake));
  check('舞台上有导航小卡片（去哪 / 多远 / 往哪走）',
    html.includes('nav-mini') && /class="nav-mini"/.test(html)
    && /id="nav-mini-name"/.test(html) && /id="nav-mini-dir"/.test(html));
  check('小卡片点击可打开整页导航', /id="nav-mini-open"/.test(html) && /function bindNavMini/.test(app));
  check('顶栏有「导航」入口，且是打开整页而不是切模式',
    /id="btn-nav"/.test(html) && /#btn-nav'\)[\s\S]{0,120}initNavPage\(\)/.test(app));
  check('导航模式（换风景图）挪到「文旅」页，不再占顶栏',
    /id="nav-mode-toggle"/.test(html) && /#nav-mode-toggle/.test(app));
  check('导航页脚本已引入', /src="\/js\/nav\.js"/.test(html));
  check('导航页有地图画布与附近景点列表',
    /id="np-map"/.test(html) || /id="np-map"/.test(read('public/js/nav.js')));
  check('地图瓦片走本机代理（顺带解决防盗链与缓存）',
    /'\/api\/tile'/.test(srv) && /\/api\/tile\?z=/.test(read('public/js/nav.js')));

  /* ====================================================================
   * ⑥b 开屏的三个修复（真实翻车点）
   * ==================================================================*/
  console.log('\n⑥b 开屏：一开始就播 / 入口落到对应页 / 动作适配所有形象');

  // --- 修复 1：每块舞台画布必须独立 ---
  // 一块 canvas 只能有一种绘图上下文：PIXI 占 WebGL 之后 getContext('2d') 返回 null。
  // 共用会让其中一套形象整块画不出来（"新加的虚拟形象不显示"就是这个）。
  const canvases = [...html.matchAll(/<canvas[^>]*id="([\w-]+)"/g)].map(m => m[1]);
  check('index.html 里三套舞台各有独立画布',
    canvases.includes('live2d-canvas') && canvases.includes('lake-canvas') && canvases.includes('stage3d-canvas'),
    canvases.join(', '));

  const lakeCanvasUse = /ensureLake[\s\S]{0,600}?\$\('#([\w-]+)'\)/.exec(app);
  const l2dCanvasUse = /ensureLive2D[\s\S]{0,600}?\$\('#([\w-]+)'\)/.exec(app);
  check('西湖船娘用 #lake-canvas，不与 Live2D 共用',
    lakeCanvasUse && lakeCanvasUse[1] === 'lake-canvas', lakeCanvasUse && lakeCanvasUse[1]);
  check('Live2D 用 #live2d-canvas',
    l2dCanvasUse && l2dCanvasUse[1] === 'live2d-canvas', l2dCanvasUse && l2dCanvasUse[1]);
  check('showCanvas() 三块画布都切（漏一块就会两块同时显示）',
    /kind === 'live2d' \? 'block'/.test(app) && /kind === 'lake' \? 'block'/.test(app) && /kind === '3d' \? 'block'/.test(app));
  check('CSS 里 #lake-canvas 默认可见（默认形象就是它）',
    /#lake-canvas[^{]*\{[^}]*display:\s*block/.test(css));
  check('CSS 里 #live2d-canvas 默认隐藏（否则会盖在西湖船娘上面）',
    /#live2d-canvas[^{]*\{[^}]*display:\s*none/.test(css));

  // --- 修复 2：开屏要在第一个 await 之前同步播 ---
  {
    const lines = app.split(/\r?\n/);
    const start = lines.findIndex(l => l.includes('async function boot()'));
    let end = start;
    for (let i = start; i < lines.length; i++) { if (lines[i] === '  }') { end = i; break; } }
    const seg = lines.slice(start, end + 1).map(l => l.replace(/\/\/.*$/, ''));   // 去注释，免得被注释里的"await"误导
    const autoLine = seg.findIndex(l => l.includes('autoShow()'));
    const firstAwait = seg.findIndex(l => /\bawait\b/.test(l));
    check('开屏在 boot() 里**同步**播（在第一个 await 之前）',
      autoLine > 0 && firstAwait > 0 && autoLine < firstAwait,
      `autoShow 第 ${autoLine + 1} 行 / 首个 await 第 ${firstAwait + 1} 行`);
  }
  check('boot.js 默认每次打开都播（宣传门面，不是"只弹一次"）',
    /autoShow: raw\.autoShow !== false/.test(boot));
  check('给了「不再自动播放」的勾选（觉得烦的用户能自己关）',
    /boot-auto/.test(boot) && /setAutoShow/.test(boot));
  check('形象就绪后会通知开屏补迎宾动作（开屏盖上时 stage 还没建）',
    /notifyStageReady/.test(boot) && /notifyStageReady\(\)/.test(app));
  check('视频清单就绪后会通知开屏换成真视频（否则一直停在兜底画面）',
    /notifyVideosReady/.test(boot) && /notifyVideosReady\(\)/.test(app));

  // --- 修复 3：三个入口要落到**各自**的页面 ---
  {
    const seg = /async function onBootEnter[\s\S]*?\n  \}/.exec(app);
    const body = seg ? seg[0] : '';
    check('onBootEnter 从数据表读目标（不再写死 if 分支）',
      /WenlvBoot\.ENTRIES/.test(body) && /def\.target/.test(body));
    check('onBootEnter 会执行 切页签 / 展开折叠 / 滚动 / 聚焦',
      /switchTab\(t\.pane/.test(body) && /t\.folds/.test(body) && /scrollIntoView/.test(body) && /t\.focus/.test(body));

    // 三个入口的落地页必须**互不相同** —— 之前"设置"和"API 接入"都跳外观页，
    // 用户点完设置再点 API 接入会以为没跳转。
    const targets = [...boot.matchAll(/id: '(\w+)'[\s\S]{0,400}?target: \{([^}]*)\}/g)]
      .map(m => ({ id: m[1], pane: (/pane:\s*'(\w+)'/.exec(m[2]) || [])[1] }));
    check('三个入口都声明了跳转目标', targets.length === 3, JSON.stringify(targets));
    check('三个入口的落地页互不相同（否则看起来像没跳转）',
      new Set(targets.map(t => t.pane)).size === 3, JSON.stringify(targets));
    const byId = Object.fromEntries(targets.map(t => [t.id, t.pane]));
    check('「对话」→ 对话页', byId.chat === 'chat', byId.chat);
    check('「设置」→ 角色卡页（人物设定/音色/形象都在这张卡上）', byId.settings === 'cards', byId.settings);
    check('「API 接入」→ 外观页（模型接入 + 对外开放都在那里）', byId.api === 'look', byId.api);
    check('「API 接入」顺带展开两个 API 折叠区',
      /id: 'api'[\s\S]{0,400}fold-provider[\s\S]{0,120}fold-openapi/.test(boot));
    check('入口按钮上标出了落地页（点之前就知道会去哪）',
      /PANE_LABEL/.test(boot) && /boot-entry-go/.test(boot) && /\.boot-entry-go/.test(css));
  }

  // --- 修复 4：动作要适配**所有**形象（真实跑一遍降级链）---
  {
    // 在 Node 里加载 boot.js：它只在函数体内用 document/localStorage，
    // 加载本身只需要一个 window。
    const g = { window: {}, localStorage: { getItem: () => null, setItem: () => {} } };
    const mod = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function('window', 'localStorage', 'document', 'performance', boot)(
      g.window, g.localStorage, { addEventListener() {}, createElement: () => ({ style: {}, appendChild() {} }), body: { appendChild() {} } },
      { now: () => Date.now() },
    );
    const WB = g.window.WenlvBoot;
    check('boot.js 导出了 playEntryMotion（便于单独验证降级逻辑）', typeof WB.playEntryMotion === 'function');

    const entry = (WB.ENTRIES || []).find(e => e.id === 'chat') || {};
    check('入口的动作写成了「名字 + 一组降级动作组」',
      entry.motion && entry.motion.name && Array.isArray(entry.motion.groups) && entry.motion.groups.length > 0,
      JSON.stringify(entry.motion));

    // 场景一：西湖船娘 —— 有中文动作名，第一级就该命中
    {
      const calls = [];
      const stage = {
        async playMotionByName(n) { calls.push('name:' + n); return n === '招手' ? { name: n } : false; },
        async playMotion(g) { calls.push('group:' + g); return { name: g }; },
      };
      const ok = await WB.playEntryMotion(stage, entry);
      check('西湖船娘：按名字直接命中（不会多播一个组动作）',
        ok === true && calls.length === 1 && calls[0] === 'name:招手', calls.join(' → '));
    }
    // 场景二：Live2D —— 没有"招手"这个名字，必须降级到动作组
    {
      const calls = [];
      const stage = {
        async playMotionByName(n) { calls.push('name:' + n); return false; },
        async playMotion(g) { calls.push('group:' + g); return g === 'TapBody' ? { name: g } : false; },
      };
      const ok = await WB.playEntryMotion(stage, entry);
      check('Live2D：名字落空后降级到动作组（这才是"适配所有形象"）',
        ok === true && calls.includes('name:招手') && calls.some(c => c.startsWith('group:')), calls.join(' → '));
    }
    // 场景三：形象**一个动作都没有** —— 按需求：什么都不做。
    // 以前这里会无条件兜底调一次 playMotion()，于是没动作的形象也会抖一下，
    // 看起来像有功能、其实是假的。宁可毫无反应，也不要假反应。
    {
      const calls = [];
      const stage = {
        listMotions() { return []; },
        async playMotionByName() { calls.push('name'); return false; },
        async playMotion(g) { calls.push(g === undefined ? 'random' : 'group:' + g); return { name: 'nod' }; },
      };
      const ok = await WB.playEntryMotion(stage, entry);
      check('形象没有任何动作时不播（不再假装有反应）',
        ok === false && calls.length === 0, `ok=${ok} calls=${calls.join(' → ') || '(无)'}`);
    }
    // 场景三之二：有动作、但偏好名字与组都不匹配 —— 随机取一个它能播的
    {
      const calls = [];
      const stage = {
        listMotions() { return [{ group: 'Idle', index: 0, name: 'idle_00' }, { group: 'TapBody', index: 1, name: 'tap_01' }]; },
        async playMotionByName(n) { calls.push('name:' + n); return false; },
        // 只认"组 + 序号"（也就是从 listMotions 里随机挑出来的那一项）；
        // 只给组名的一律失败，这样才能真的走到随机分支
        async playMotion(g, i) {
          calls.push(i === undefined ? `grouponly:${g}` : `picked:${g}#${i}`);
          return i !== undefined;
        },
      };
      const ok = await WB.playEntryMotion(stage, entry);
      check('偏好动作不存在时随机取一个它有的（从 listMotions 随机挑，带组+序号）',
        ok === true && calls.some(c => /^picked:(Idle|TapBody)#[01]$/.test(c)), calls.join(' → '));
    }
    // 场景四：async 返回 Promise<false> 的坑 —— 不 await 就会误判成成功
    {
      const calls = [];
      const stage = {
        async playMotionByName() { return false; },      // Promise<false>，它本身是真值！
        async playMotion(g) { calls.push('group:' + g); return g === 'TapBody'; },
      };
      await WB.playEntryMotion(stage, entry);
      check('不会把 Promise<false> 误判成"播成功了"（必须 await 再判真假）',
        calls.length > 0, calls.join(' → '));
    }
    // 场景五：舞台方法抛异常不能把开屏搞崩
    {
      const stage = {
        async playMotionByName() { throw new Error('boom'); },
        async playMotion() { throw new Error('boom'); },
      };
      let threw = false;
      try { await WB.playEntryMotion(stage, entry); } catch { threw = true; }
      check('舞台抛异常时开屏不受影响', threw === false);
    }
    check('没有形象时不报错（开屏早期 stage 可能还没建）',
      (await WB.playEntryMotion(null, entry)) === false);
  }

  // --- 修复 5：一个渲染函数抛异常不能把整个启动流程打断 ---
  // 实测踩过：renderLookPreview 读西湖船娘没有的字段抛 TypeError，
  // 它是被 loadCapabilities() 调的，一抛就把 boot() 打断，
  // 后面的 initStage() 不再执行 —— 画布停在 300×150 一个像素都没画。
  check('renderLookPreview 对 lake 形象有专门分支（不读它没有的字段）',
    /m\.kind === 'lake'[\s\S]{0,400}内置 · 程序化绘制/.test(app));
  check('renderLookPreview 对缺失字段兜了默认值（老模型字段千奇百怪）',
    /Array\.isArray\(m\.motionGroups\)/.test(app) && /Array\.isArray\(m\.expressions\)/.test(app));
  check('boot() 逐项加载且各自吞异常（少一个面板好过整个形象不出现）',
    /optionalLoads[\s\S]{0,900}catch\s*\{/.test(app) && /\[boot\] \$\{label\} 加载失败/.test(app));
  {
    // 关键：initStage 必须排在 optionalLoads 循环**之后**，且循环本身不会中断它
    const iLoop = app.indexOf('optionalLoads');
    const iStage = app.indexOf('initStage();', iLoop);
    check('initStage() 在可选加载之后一定会被执行到', iLoop > 0 && iStage > iLoop);
  }

  /* ====================================================================
   * ① 显存仲裁的接线（与 test/gpu.js 互补：那边测语义，这边测"接上了没"）
   * ==================================================================*/
  console.log('\n① 显存仲裁接线（补充）');
  check('server.js 创建了 gpu 并注入五个吃显存的地方',
    /createGpu\(\{ ollama, prefs \}\)/.test(srv)
    && /createInference\(\{ ollama, providers, gpu \}\)/.test(srv)
    && /createImg23D\(\{ dir: DATA_DIR, gpu \}\)/.test(srv)
    && /createDepth\(\{ dir: DATA_DIR, gpu \}\)/.test(srv)
    && /createSTT\(\{ dir: DATA_DIR, prefs, gpu \}\)/.test(srv)
    && /createTTS\(\{ cacheDir: TTS_CACHE, gpu \}\)/.test(srv));
  check('/api/status 暴露 gpu 状态（界面才能显示"在排队"而不是像卡死）',
    /gpu:\s*gpu\.status\(\)/.test(srv));

  /* ====================================================================
   * ② 本地优先
   * ==================================================================*/
  console.log('\n② 本地优先（本地与外部不冲突）');
  const inf = read('lib/inference.js');
  check('/api/status 给出 localFirst 结论（前端不必自己复刻一遍判断逻辑）',
    /localFirst:/.test(inf) && /policy:/.test(inf));
  check('外部 API 调用不经过本地显存闸门（两条路资源不在一池，互不阻塞）',
    /localShared/.test(inf) && !/providersLib\.chat\(\{[\s\S]{0,400}localShared/.test(inf));
  check('三项能力都切外部时释放本地显存（否则白占 5GB 显存）',
    /releaseLocalIfUnused/.test(read('lib/gpu.js')) && /allExternal/.test(inf));
  check('释放的判据是"三项全外部"而不是"对话是外部"（视觉/向量多数仍走本地）',
    /routes\('chat'\) && providers\.routes\('vision'\) && providers\.routes\('embed'\)/.test(inf));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败${skipped.length ? ` / ${skipped.length} 跳过` : ''}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('测试自身出错：', e);
  process.exitCode = 1;
});
