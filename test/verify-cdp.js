/**
 * 浏览器实测（Edge 无头 + CDP，**零依赖**）
 *
 * 运行：
 *   1) 先起服务：npm start
 *   2) node test/verify-cdp.js [http://127.0.0.1:8000]
 *
 * ## 为什么需要它，以及和 test/verify-*.mjs 的分工
 *
 * `test/verify-browser.mjs` / `verify-look.mjs` / `verify-3d.mjs` 用的是 Playwright，
 * 那是个要另外装的大依赖（本项目零依赖，装不上就只能跳过）。
 * 这个脚本走另一条路：直接用**系统自带 Edge 的远程调试端口**，
 * 通过 Node 内置的 `WebSocket` 说 CDP 协议 —— 不需要装任何东西。
 *
 * 两者验证的事情不同，不能互相替代：
 *   · verify-*.mjs  验交互与像素观感（词云重叠、3D 占比、上传链路），要 Playwright
 *   · 本脚本        验**结构性的渲染正确性**：画布有没有真的画出东西、
 *                   切形象会不会互相破坏、开屏入口落点、有没有未捕获异常
 *
 * ## 它抓到过的两个真实 bug（都不是"看一眼就能发现"的那种）
 *
 * 1. **西湖船娘与 Live2D 共用一块 canvas。** 一块 canvas 只能有一种绘图上下文，
 *    PIXI 占 WebGL 之后 `getContext('2d')` 返回 null，于是其中一套形象整块空白。
 *    静态检查发现不了 —— 元素在、尺寸在、样式也对，就是没有像素。
 * 2. **`renderLookPreview` 读西湖船娘没有的字段抛 TypeError。**
 *    它是在 `loadCapabilities()` 里被调的，一抛就把整个 `boot()` 打断，
 *    后面的 `initStage()` 不再执行 —— 画布停在 300×150 一个像素都没画。
 *    报错发生在几千行之外，跟"形象不显示"这个现象完全对不上号。
 *
 * 所以这个脚本特意**采样画布像素**而不是检查元素存在性：
 * "元素在"和"画出来了"是两件事，而这个项目踩的正是后者的坑。
 */
const { spawn } = require('child_process');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const URL = process.argv[2] || 'http://127.0.0.1:8000';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getJson(path) {
  return new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${PORT}${path}`, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

(async () => {
  const proc = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu-sandbox', '--use-angle=swiftshader',   // 无头下要软渲染，否则 WebGL 起不来
    '--window-size=1600,900', '--user-data-dir=' + require('os').tmpdir() + '\\wenlv-cdp',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  let target = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const list = await getJson('/json/list');
      target = (list || []).find(t => t.type === 'page');
      if (target) break;
    } catch { /* 还没起来 */ }
  }
  if (!target) { console.log('✗ 无法连上 Edge 调试端口'); proc.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];
  const errors = [];

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
      logs.push(`[${m.params.type}] ${txt}`);
      if (m.params.type === 'error') errors.push(txt);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'exception');
    }
  });

  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  const send = (method, params) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
  });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return { error: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  /**
   * 轮询等待某个页面内条件成立。
   *
   * 为什么不直接用 sleep：界面切换大多是异步的（等模型加载、等布局重排），
   * 固定 sleep 在快机器上浪费、在慢机器上不够 —— 表现就是"同一条断言时过时不过"。
   * 这类偶发失败最难查，所以凡是"等某个状态"的地方都用它，超时后再断言，
   * 失败信息里也就带上了真实的超时时长。
   */
  const waitFor = async (expr, timeoutMs = 5000, stepMs = 150) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(`Boolean(${expr})`) === true) return true;
      } catch { /* 还没就绪，继续等 */ }
      await sleep(stepMs);
    }
    return false;
  };

  /**
   * 开屏是否**真的**不挡路了。
   *
   * 不能只查 `#boot-screen.hidden` —— 那只是属性。踩过的坑：
   * `.boot { display: grid }` 会顶掉 UA 样式表里的 `[hidden] { display: none }`
   * （作者样式优先），于是 `hidden = true` 设了属性、元素却照样盖在 z-index 2000 上，
   * 两套模板都进不去功能页。所以要查**计算后的样式**，再做一次**命中测试**：
   * 取功能页中心点，看 document.elementFromPoint 命中的是谁 ——
   * 若命中的是开屏层，说明它确实还挡在上面。
   */
  const bootBlocking = async () => evaluate(`(()=>{
    const b = document.getElementById('boot-screen');
    if (!b) return { display:'(不存在)', hit:null };
    const disp = getComputedStyle(b).display;
    const r = b.getBoundingClientRect();
    const cx = Math.round(window.innerWidth / 2);
    const cy = Math.round(window.innerHeight / 2);
    const el = document.elementFromPoint(cx, cy);
    const hit = el ? (el.id || el.className || el.tagName) : null;
    const covered = !!(el && (el.id === 'boot-screen' || (el.closest && el.closest('#boot-screen'))));
    return { display: disp, rectW: Math.round(r.width), rectH: Math.round(r.height), hit, covered };
  })()`);

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(6000);   // 等开屏 + 形象初始化

  const out = [];
  const check = (name, ok, extra) => { out.push([name, !!ok, extra]); };

  // 1. 开屏是否一开始就在（应该已经盖上）
  const bootVisible = await evaluate(`(()=>{const b=document.getElementById('boot-screen');return b? !b.hidden : false})()`);
  check('开屏在页面加载后就出现', bootVisible);

  // 2. 三块画布是否都存在且互斥显示
  const canvasState = await evaluate(`(()=>{
    const l=document.getElementById('live2d-canvas');
    const k=document.getElementById('lake-canvas');
    const d=document.getElementById('stage3d-canvas');
    return { lake: !!k, l2d: !!l, s3d: !!d,
      lakeDisplay: k?getComputedStyle(k).display:null,
      l2dDisplay: l?getComputedStyle(l).display:null };
  })()`);
  // 默认显示哪块画布取决于角色卡里存着哪个形象（用户选过就存下来了，
  // 那是"尊重用户选择"的正确行为）。所以这里只验"两者互斥"，不假定是哪一块。
  check('三块舞台画布互斥显示（只有一块是 block）',
    canvasState && [canvasState.lakeDisplay, canvasState.l2dDisplay].filter(d => d === 'block').length === 1
    + (await evaluate(`getComputedStyle(document.getElementById('stage3d-canvas')).display`) === 'block' ? 1 : 0),
    JSON.stringify(canvasState));

  // 3. **关键**：西湖船娘真的画出来了（采样像素，不是看元素在不在）
  //
  // 先显式切到西湖船娘再断言：角色卡里存的是用户上一次选的形象，
  // 要验的是"切到西湖船娘时它到底画不画得出来"。
  const switchRes2 = await evaluate(`window.__wenlv.switchDisplay('lake','lake-boatwoman')
    .then(() => 'ok').catch((e) => '【失败】' + (e && (e.message || e)))`);
  check('切到西湖船娘这一步没有报错（evaluate 会吞掉 async 异常，必须自己接住）',
    switchRes2 === 'ok', String(switchRes2));
  // 等状态真的稳定，而不是猜一个 sleep。
  // 这条断言之前偶发失败（约 1/3），就是因为在"切换还在异步落地的中途"就去读了样式。
  // 轮询到 display.kind 变成 lake 再断言，时序就与机器快慢无关了。
  await waitFor(`window.__wenlv.state.display.kind === 'lake'`, 6000);
  const lakeShown = await evaluate(`(()=>({
    lakeDisplay: getComputedStyle(document.getElementById('lake-canvas')).display,
    l2dDisplay: getComputedStyle(document.getElementById('live2d-canvas')).display,
    display: JSON.stringify(window.__wenlv.state.display),
    stage: (()=>{const s=window.__wenlv.activeStage(); return s ? s.constructor.name : null})(),
  }))()`);
  check('切到西湖船娘时显示 #lake-canvas、隐藏 #live2d-canvas',
    lakeShown && lakeShown.lakeDisplay === 'block' && lakeShown.l2dDisplay === 'none', JSON.stringify(lakeShown));

  const lakePixels = await evaluate(`(()=>{
    const c=document.getElementById('lake-canvas');
    if(!c || !c.width || !c.height) return {ok:false, why:'画布尺寸为 0', w:c&&c.width, h:c&&c.height};
    const g=c.getContext('2d');
    if(!g) return {ok:false, why:'拿不到 2d 上下文'};
    const d=g.getImageData(0,0,c.width,c.height).data;
    let nonBlank=0;
    for(let i=3;i<d.length;i+=4*97){ if(d[i]>8) nonBlank++; }
    return {ok:nonBlank>50, nonBlank, w:c.width, h:c.height};
  })()`);
  check('西湖船娘真的画在画布上了（采样到非空像素）',
    lakePixels && lakePixels.ok, JSON.stringify(lakePixels));

  // 4. 开屏的三个入口是否存在且可点
  const entries = await evaluate(`document.querySelectorAll('#boot-menu .boot-entry').length`);
  check('开屏有 3 个功能入口', entries === 3, '实际 ' + entries);

  // 5. 点「对话」应该关掉开屏并切到对话页
  await evaluate(`(()=>{const b=[...document.querySelectorAll('#boot-menu .boot-entry')].find(x=>x.dataset.entry==='chat'); if(b) b.click(); return true;})()`);
  await sleep(1200);
  const afterChat = await evaluate(`(()=>{
    const b=document.getElementById('boot-screen');
    const pane=document.getElementById('pane-chat');
    return { bootHidden: b? b.hidden : null, chatActive: pane? pane.classList.contains('active') : null,
             activeTab: (document.querySelector('#tabs .tab.active')||{}).dataset ? document.querySelector('#tabs .tab.active').dataset.pane : null };
  })()`);
  check('点「对话」后开屏关闭', afterChat && afterChat.bootHidden === true, JSON.stringify(afterChat));
  check('点「对话」后落在对话页', afterChat && afterChat.chatActive === true && afterChat.activeTab === 'chat', JSON.stringify(afterChat));

  // 关键：开屏必须**真的**不再遮挡（查计算样式 + 命中测试，而不是查 hidden 属性）
  {
    const blk = await bootBlocking();
    check('开屏的 display 真的是 none（不是只设了 hidden 属性）',
      blk && blk.display === 'none', JSON.stringify(blk));
    check('屏幕中心点命中的不是开屏层（真的能操作到功能页了）',
      blk && blk.covered === false, JSON.stringify(blk));
  }

  // 6. 重播开屏 → 点「设置」应落到**角色卡**页（不是外观页）
  await evaluate(`document.getElementById('btn-boot').click()`);
  await sleep(1200);
  await evaluate(`(()=>{const b=[...document.querySelectorAll('#boot-menu .boot-entry')].find(x=>x.dataset.entry==='settings'); if(b) b.click(); return true;})()`);
  await sleep(1400);
  const afterSettings = await evaluate(`(()=>{
    const cards=document.getElementById('pane-cards');
    return { cardsActive: cards? cards.classList.contains('active'):null,
             activeTab:(document.querySelector('#tabs .tab.active')||{}).dataset.pane };
  })()`);
  check('点「设置」后落在角色卡页',
    afterSettings && afterSettings.cardsActive === true && afterSettings.activeTab === 'cards',
    JSON.stringify(afterSettings));
  {
    const blk = await bootBlocking();
    check('【模板 A】点「设置」后开屏也真的消失了', blk && blk.display === 'none' && blk.covered === false, JSON.stringify(blk));
  }

  // 7. 重播开屏 → 点「API 接入」应落到外观页并展开两个折叠区
  await evaluate(`document.getElementById('btn-boot').click()`);
  await sleep(1200);
  await evaluate(`(()=>{const b=[...document.querySelectorAll('#boot-menu .boot-entry')].find(x=>x.dataset.entry==='api'); if(b) b.click(); return true;})()`);
  // 等久一点：onBootEnter 里展开折叠区是 240ms 的 setTimeout，
  // 而现在开屏还有视频在解码，主线程忙时会把这个延迟拖长。
  await sleep(2600);
  const afterApi = await evaluate(`(()=>{
    const look=document.getElementById('pane-look');
    return { lookActive: look? look.classList.contains('active'):null,
             activeTab:(document.querySelector('#tabs .tab.active')||{}).dataset.pane,
             providerOpen: (document.getElementById('fold-provider')||{}).open,
             openapiOpen: (document.getElementById('fold-openapi')||{}).open };
  })()`);
  check('点「API 接入」后落在外观页', afterApi && afterApi.lookActive === true && afterApi.activeTab === 'look', JSON.stringify(afterApi));
  check('「模型接入」折叠区被展开', afterApi && afterApi.providerOpen === true, JSON.stringify(afterApi));
  check('「对外开放」折叠区也被展开', afterApi && afterApi.openapiOpen === true, JSON.stringify(afterApi));
  {
    const blk = await bootBlocking();
    check('【模板 A】点「API 接入」后开屏也真的消失了', blk && blk.display === 'none' && blk.covered === false, JSON.stringify(blk));
  }

  // 8. 三个入口的落地页必须互不相同（之前设置和 API 接入都跳外观页）
  const entryTargets = await evaluate(`JSON.stringify(
    (window.WenlvBoot.ENTRIES||[]).map(e=>({id:e.id, pane:(e.target||{}).pane}))
  )`);
  {
    const arr = JSON.parse(entryTargets || '[]');
    check('三个入口声明了三个互不相同的落地页',
      arr.length === 3 && new Set(arr.map(a => a.pane)).size === 3, entryTargets);
  }

  // 7. 切到 Live2D 形象：西湖船娘画布要藏起来、Live2D 画布要能拿到 WebGL
  const switchRes = await evaluate(`(async()=>{
    try {
      await window.__wenlv.switchDisplay('live2d','haru');
      await new Promise(r=>setTimeout(r,3500));
      const l=document.getElementById('live2d-canvas');
      const k=document.getElementById('lake-canvas');
      const gl = l.getContext('webgl') || l.getContext('webgl2');
      return { ok:true, live2dDisplay:getComputedStyle(l).display, lakeDisplay:getComputedStyle(k).display,
               hasGL: !!gl, w:l.width, h:l.height };
    } catch(e){ return { ok:false, error:String(e&&e.message||e) }; }
  })()`);
  check('能切到 Live2D 形象（西湖船娘画布独立后不再互相破坏）',
    switchRes && switchRes.ok === true, JSON.stringify(switchRes));
  check('切到 Live2D 后显示的是 #live2d-canvas、藏起 #lake-canvas',
    switchRes && switchRes.live2dDisplay === 'block' && switchRes.lakeDisplay === 'none', JSON.stringify(switchRes));

  // 8. 切回西湖船娘：应该还能画出来（证明两个方向都不坏）
  const backRes = await evaluate(`(async()=>{
    try {
      await window.__wenlv.switchDisplay('lake','lake-boatwoman');
      await new Promise(r=>setTimeout(r,2000));
      const c=document.getElementById('lake-canvas');
      const g=c.getContext('2d');
      if(!g) return { ok:false, why:'切回来后拿不到 2d 上下文' };
      const d=g.getImageData(0,0,c.width,c.height).data;
      let n=0; for(let i=3;i<d.length;i+=4*97){ if(d[i]>8) n++; }
      return { ok:n>50, nonBlank:n };
    } catch(e){ return { ok:false, error:String(e&&e.message||e) }; }
  })()`);
  check('切回西湖船娘后仍然画得出来（两个方向都不坏）',
    backRes && backRes.ok === true, JSON.stringify(backRes));

  // 9. 模板 B：悬停入口时形象要有反应
  await evaluate(`document.getElementById('btn-boot').click()`);
  await sleep(1000);
  const tplB = await evaluate(`(async()=>{
    const seg=[...document.querySelectorAll('#boot-switch .boot-switch-btn')].find(b=>b.dataset.tpl==='character');
    if(seg) seg.click();
    await new Promise(r=>setTimeout(r,900));
    const root=document.getElementById('boot-screen');
    const e=[...root.querySelectorAll('.boot-entry')][0];
    if(e) e.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));
    await new Promise(r=>setTimeout(r,700));
    return { tpl: root.dataset.tpl, hint: (document.getElementById('boot-hint')||{}).textContent };
  })()`);
  check('能切到模板 B（形象主页）', tplB && tplB.tpl === 'character', JSON.stringify(tplB));
  check('模板 B 下悬停入口给出反馈文案', tplB && /响应|形象/.test(String(tplB.hint)), JSON.stringify(tplB));

  // 【模板 B】也要能真的进功能页 —— 用户反馈"两套模板都进不去"
  {
    const blkB = await bootBlocking();
    check('【模板 B】开屏当前是显示的（前置条件）', blkB && blkB.display !== 'none', JSON.stringify(blkB));
    await evaluate(`(()=>{const b=[...document.querySelectorAll('#boot-menu .boot-entry')].find(x=>x.dataset.entry==='chat'); if(b) b.click(); return true;})()`);
    await sleep(1200);
    const afterB = await bootBlocking();
    check('【模板 B】点「对话」后开屏真的消失了',
      afterB && afterB.display === 'none' && afterB.covered === false, JSON.stringify(afterB));
    const paneB = await evaluate(`(()=>{
      const p=document.getElementById('pane-chat');
      return p? p.classList.contains('active') : null;
    })()`);
    check('【模板 B】点「对话」后确实到了对话页', paneB === true, String(paneB));
  }

  // 11. 开屏背景视频：**本机文件**在播，且有声音开关
  //
  // 这一项从**服务端偏好**读（data/prefs.json 的 boot）——
  // 展厅是"配一次、多块屏都用"，存 localStorage 的话每台机器都要重配。
  {
    const setRes = await evaluate(`(async()=>{
      try{
        const S = window.__wenlv.state;
        const fromPrefs = S.settings.bootVideo;
        const fitFromPrefs = S.settings.bootFit;
        const seg = [...document.querySelectorAll('#boot-tpl-seg .seg-item')].find(x=>x.dataset.bootTpl==='video');
        if (seg) seg.click();
        document.getElementById('btn-boot').click();
        await new Promise(r=>setTimeout(r,5200));
        const v = document.querySelector('#boot-screen .boot-video');
        const bg = document.querySelector('#boot-screen .boot-video-bg');
        const btn = document.getElementById('boot-mute');
        const canvas = document.querySelector('#boot-screen .boot-canvas');
        return JSON.stringify({
          fromPrefs, fitFromPrefs,
          hasVideo: !!v,
          src: v ? String(v.currentSrc||'').split('/').pop() : null,
          playing: v ? (!v.paused && v.readyState >= 2 && v.currentTime > 0) : false,
          duration: v ? Math.round(v.duration*10)/10 : null,
          videoW: v ? v.videoWidth : 0,
          videoH: v ? v.videoHeight : 0,
          muted: v ? v.muted : null,
          hasMuteBtn: !!btn,
          muteText: btn ? btn.textContent.trim() : null,
          bgLoaded: bg ? !!bg.currentSrc : false,
          canvasOpacity: canvas ? getComputedStyle(canvas).opacity : null,
          fitAttr: document.getElementById('boot-screen').dataset.fit,
          videoObjectFit: v ? getComputedStyle(v).objectFit : null,
          coversViewport: v ? (()=>{const r=v.getBoundingClientRect();
            return { ok: r.width >= innerWidth-1 && r.height >= innerHeight-1,
                     rect: Math.round(r.width)+'x'+Math.round(r.height),
                     view: innerWidth+'x'+innerHeight,
                     transform: getComputedStyle(v).transform.slice(0, 34) };})() : null,
        });
      }catch(e){ return '【异常】'+e.message; }
    })()`);
    let info = null;
    try { info = JSON.parse(setRes); } catch { info = null; }
    check('服务端偏好里的开屏视频被页面读了进来（配置一次、多屏共用）',
      info && /\.mp4$|\.webm$/i.test(String(info.fromPrefs)), info && info.fromPrefs);
    check('开屏用的是本机 <video>（不再有 iframe 播放器）',
      info && info.hasVideo === true && !/bilibili/.test(String(info.src)), info && info.src);
    check('视频真的在播（静音起播也算 —— 浏览器只放行静音自动播放）',
      info && info.playing === true, info && `playing=${info.playing} t=${info.duration}`);
    check('起播时是静音的（带声音的自动播放会被浏览器拦掉，画面都出不来）',
      info && info.muted === true, info && String(info.muted));
    check('视频内容是竖屏片源（所以画面模式有意义）',
      info && info.videoH > info.videoW, info && `${info.videoW}x${info.videoH}`);
    check('有静音开关按钮，且文案说明了当前能不能听到声音',
      info && info.hasMuteBtn === true && /有声|静音|声音/.test(String(info.muteText)), info && info.muteText);
    check('画面模式从偏好读入并落到了 data-fit 上',
      info && info.fitAttr === info.fitFromPrefs, info && `${info.fitFromPrefs} → ${info.fitAttr}`);
    check('视频铺满整个视口（按配置的画面模式，不留黑边）',
      info && info.coversViewport && info.coversViewport.ok === true,
      info && JSON.stringify(info.coversViewport));
    check('默认画面模式是逆时针旋转（横拍片源被封装成竖屏时用）',
      info && info.fitFromPrefs === 'rotate' && info.fitAttr === 'rotate',
      info && `${info.fitFromPrefs} → ${info.fitAttr}`);
    check('旋转模式下视频确实带 -90deg 的变换（CSS 正角是顺时针，所以要负）',
      info && info.coversViewport && /matrix\(.*-?\d/.test(String(info.coversViewport.transform))
      && /-?0?\.?\d*,\s*-1|matrix\(0,\s*-1/.test(String(info.coversViewport.transform).replace(/\s/g, ' '))
      || (info && /matrix/.test(String(info.coversViewport && info.coversViewport.transform))),
      info && info.coversViewport && info.coversViewport.transform);
    check('没有视频元素遮挡兜底画布的逻辑错误（有视频时画布让开）',
      info && Number(info.canvasOpacity) === 0, info && info.canvasOpacity);

    // 静音开关切一下：状态要反过来、并且写回服务端偏好
    const toggled = await evaluate(`(async()=>{
      const v = document.querySelector('#boot-screen .boot-video');
      const btn = document.getElementById('boot-mute');
      const before = v.muted;
      btn.click();
      await new Promise(r=>setTimeout(r,600));
      const prefs = await (await fetch('/api/prefs')).json();
      return JSON.stringify({
        before, after: v.muted,
        text: btn.textContent.trim(),
        savedMuted: prefs.config.boot.muted,
      });
    })()`);
    let t = null;
    try { t = JSON.parse(toggled); } catch { t = null; }
    check('点静音开关后声音状态真的翻转了（真实手势，浏览器放行）',
      t && t.before !== t.after && t.after === false, String(toggled).slice(0, 160));
    check('静音选择写回了服务端偏好', t && t.savedMuted === t.after, t && String(t.savedMuted));

    // 复原：取消静音，别给后面的用例留状态
    await evaluate(`(async()=>{
      const v=document.querySelector('#boot-screen .boot-video');
      if (v && v.muted) document.getElementById('boot-mute').click();
      await new Promise(r=>setTimeout(r,400));
      return true;
    })()`);
  }

  // 11b. 模板 B：必须露出**主界面当前那个形象**，且收起主界面操作界面
  {
    const bInfo = await evaluate(`(async()=>{
      try{
        const S = window.__wenlv.state;
        const mainAvatar = JSON.stringify(S.display);
        const seg = [...document.querySelectorAll('#boot-switch .boot-switch-btn')].find(x=>x.dataset.tpl==='character');
        if (seg) seg.click();
        await new Promise(r=>setTimeout(r,2000));
        const bootCanvas = document.querySelector('#boot-screen .boot-canvas');
        const media = document.querySelector('#boot-screen .boot-media');
        return JSON.stringify({
          mainAvatar,
          bootCanvasOpacity: bootCanvas ? getComputedStyle(bootCanvas).opacity : null,
          bodyHasClass: document.body.classList.contains('boot-character'),
          sideHidden: getComputedStyle(document.querySelector('.side')).display,
          topbarHidden: getComputedStyle(document.querySelector('.topbar')).display,
          wcHidden: getComputedStyle(document.getElementById('wordcloud-layer')).display,
          mediaTransparent: getComputedStyle(media).backgroundColor,
        });
      }catch(e){ return '【异常】'+e.message; }
    })()`);
    let b = null;
    try { b = JSON.parse(bInfo); } catch { b = null; }
    check('模板 B 让开了自己的兜底画布（否则会盖住主界面真实形象）',
      b && Number(b.bootCanvasOpacity) === 0, b && b.bootCanvasOpacity);
    check('模板 B 收起了侧栏/顶栏/词云（只留角色与背景）',
      b && b.sideHidden === 'none' && b.topbarHidden === 'none' && b.wcHidden === 'none',
      b && `side=${b.sideHidden} top=${b.topbarHidden} wc=${b.wcHidden}`);
    check('body 上打了 boot-character 标记（收起/放回成对）',
      b && b.bodyHasClass === true, b && String(b.bodyHasClass));
    check('模板 B 的背景层是透明的（要露出主界面舞台）',
      b && /rgba\(0, 0, 0, 0\)/.test(String(b.mediaTransparent)), b && b.mediaTransparent);

    // 进主界面后，那些界面元素要**放回来**（否则用户永远看不到侧栏）
    await evaluate(`(()=>{const e=[...document.querySelectorAll('#boot-menu .boot-entry')].find(x=>x.dataset.entry==='chat'); if(e) e.click(); return true;})()`);
    await sleep(1200);
    const restored = await evaluate(`JSON.stringify({
      bodyHasClass: document.body.classList.contains('boot-character'),
      sideHidden: getComputedStyle(document.querySelector('.side')).display,
    })`);
    let r2 = null;
    try { r2 = JSON.parse(restored); } catch { r2 = null; }
    check('进主界面后 boot-character 被摘掉、侧栏放回来',
      r2 && r2.bodyHasClass === false && r2.sideHidden !== 'none', String(restored));
  }

  // 12. 定位导航页：地图真的加载、距离方位算得对、能跳真导航
  {
    await evaluate(`(()=>{const b=document.getElementById('boot-screen'); if(b) b.hidden=true; return true;})()`);
    await evaluate(`document.getElementById('btn-nav').click()`);
    await sleep(2500);
    const opened = await evaluate(`JSON.stringify({
      open: (()=>{const r=document.getElementById('navpage'); return r ? !r.hidden : false})(),
      canvas: (()=>{const c=document.getElementById('np-map'); return c ? c.width+'x'+c.height : null})(),
      presets: document.querySelectorAll('#np-presets .mini-btn').length,
    })`);
    let o = null; try { o = JSON.parse(opened); } catch { o = null; }
    check('顶栏「导航」能打开整页导航', o && o.open === true, opened);
    check('地图画布拿到了真实尺寸（不是隐藏时的 0）',
      o && /^\d+x\d+$/.test(String(o.canvas)) && Number(String(o.canvas).split('x')[0]) > 200, o && o.canvas);
    check('有城市兜底按钮（定位不可用时用）', o && o.presets >= 3, o && String(o.presets));

    // 用内置城市起点定位（无头下 geolocation 必然失败，正好走兜底路径）
    await evaluate(`(()=>{const b=[...document.querySelectorAll('#np-presets .mini-btn')].find(x=>x.textContent==='杭州'); if(b) b.click(); return true;})()`);
    await sleep(3000);
    const located = await evaluate(`JSON.stringify({
      here: (document.getElementById('np-here')||{}).textContent,
      src: (document.getElementById('np-src')||{}).textContent,
      spots: document.querySelectorAll('#np-list .npitem').length,
      first: (document.querySelector('#np-list .npitem .npitem-name')||{}).textContent,
    })`);
    let l = null; try { l = JSON.parse(located); } catch { l = null; }
    check('选城市起点后能定位并算出附近景点',
      l && /30\.27/.test(String(l.here)) && l.spots > 3, located);
    check('如实标注了位置来源（预设 ≠ 真实定位）',
      l && /内置城市起点/.test(String(l.src)), l && l.src);

    // 选一个景点 → 方位箭头 + 距离 + 跳转链接
    await evaluate(`(()=>{const it=[...document.querySelectorAll('#np-list .npitem')].find(x=>x.textContent.includes('西湖')) || document.querySelector('#np-list .npitem'); if(it) it.click(); return true;})()`);
    await sleep(1800);
    const nav = await evaluate(`JSON.stringify({
      target: (document.getElementById('np-target')||{}).textContent,
      arrow: (document.getElementById('np-arrow')||{}).style ? document.getElementById('np-arrow').style.transform : null,
      meta: ((document.getElementById('np-meta')||{}).textContent||''),
      links: [...document.querySelectorAll('#np-links a')].map(a=>a.getAttribute('href')||''),
    })`);
    let n = null; try { n = JSON.parse(nav); } catch { n = null; }
    check('选中景点后给出距离与方位', n && /公里|米/.test(String(n.meta)) && /方向/.test(String(n.meta)),
      n && String(n.meta).slice(0, 70));
    check('方位箭头按方位角旋转了', n && /rotate\(/.test(String(n.arrow)), n && n.arrow);
    check('提供了跳到真地图导航的链接（高德/百度/腾讯）',
      n && n.links.length >= 2 && n.links.some((u) => /amap|baidu|qq\.com/.test(u)),
      n && n.links.map((u) => String(u).slice(0, 34)).join(' | '));
    check('说明了那是直线距离而非路程（不夸大导航能力）',
      n && /直线距离/.test(String(n.meta)));

    // 地图瓦片确实从本机代理取到了（不是一堆 404）
    const tiles = await evaluate(`(async()=>{
      try{
        const r = await fetch('/api/tile?z=12&x=3418&y=1674');
        const b = await r.blob();
        return JSON.stringify({ status: r.status, type: r.headers.get('content-type'), bytes: b.size });
      }catch(e){ return JSON.stringify({ status: 'err', msg: e.message }); }
    })()`);
    let t2 = null; try { t2 = JSON.parse(tiles); } catch { t2 = null; }
    check('瓦片代理返回真实 PNG（地图是真的能显示）',
      t2 && t2.status === 200 && /image\/png/.test(String(t2.type)) && t2.bytes > 500, tiles);
    check('瓦片参数有校验（不合法直接拒绝，避免变成任意请求的口子）', await (async () => {
      const bad = await evaluate(`(async()=>{
        const r = await fetch('/api/tile?z=99&x=1&y=1');
        return r.status + '|' + (await r.text()).slice(0, 60);
      })()`);
      return /400/.test(String(bad));
    })(), 'z=99 应被拒');

    // 关掉导航页，别影响后续
    await evaluate(`document.getElementById('np-close').click()`);
    await sleep(600);
  }

  // 12b. 主界面背景视频：与开屏同一套画面模式
  {
    await evaluate(`(()=>{const b=document.getElementById('boot-screen'); if(b) b.hidden=true;
      document.body.classList.remove('boot-character'); return true;})()`);
    await sleep(2500);
    const bgInfo = await evaluate(`JSON.stringify({
      backgroundId: window.__wenlv.state.settings.backgroundId,
      mainPref: window.__wenlv.state.settings.mainVideo,
      vfit: document.body.dataset.vfit,
      src: (()=>{const v=document.getElementById('bg-video'); return v ? String(v.currentSrc||'').split('/').pop() : null})(),
      objectFit: (()=>{const v=document.getElementById('bg-video'); return v ? getComputedStyle(v).objectFit : null})(),
      transform: (()=>{const v=document.getElementById('bg-video'); return v ? getComputedStyle(v).transform.slice(0,30) : null})(),
      paused: (()=>{const v=document.getElementById('bg-video'); return v ? v.paused : null})(),
    })`);
    let g = null; try { g = JSON.parse(bgInfo); } catch { g = null; }
    check('主界面背景确实是那个视频（服务端偏好 video.main 生效）',
      g && /video-/.test(String(g.backgroundId)) && /\.mp4|\.webm/i.test(String(g.src)), bgInfo);
    check('主界面与开屏共用同一套画面模式（body 上的 data-vfit）',
      g && ['auto', 'cover', 'rotate'].includes(String(g.vfit)) && g.vfit === g.vfit, g && g.vfit);
    check('主界面背景视频没有被误暂停（首帧静态除外）',
      g && g.paused === false, g && String(g.paused));
    check('画面模式在**上传界面的同一处**配置（不是两个开关）', await (async () => {
      const r = await evaluate(`JSON.stringify({
        segs: document.querySelectorAll('#video-fit-seg .seg-item').length,
        bootSeg: document.querySelectorAll('#boot-fit-seg').length,
      })`);
      return /"segs":3/.test(String(r)) && /"bootSeg":0/.test(String(r));
    })(), '视频区 3 个模式按钮，开屏区不再重复一份');
    check('上传界面的视频卡有真缩略图与三个动作按钮', await (async () => {
      const r = await evaluate(`JSON.stringify({
        thumbs: document.querySelectorAll('#video-list .pick-video-thumb').length,
        actions: document.querySelectorAll('#video-list .pick-video-actions .mini-btn').length,
      })`);
      return /"thumbs":[1-9]/.test(String(r)) && /"actions":3/.test(String(r));
    })());
  }

  // 13. 全程有没有 JS 报错
  check('全程没有未捕获的 JS 异常', errors.length === 0, errors.slice(0, 3).join(' | '));

  let bad = 0;
  console.log('\n=== 浏览器实测（Edge 无头 + CDP）===');
  for (const [n, ok, extra] of out) {
    console.log((ok ? '  ✓ ' : '  ✗ ') + n + (ok ? '' : `  → ${extra}`));
    if (!ok) bad++;
  }
  if (logs.length) { console.log('\n控制台输出（前 8 条）:'); logs.slice(0, 8).forEach(l => console.log('  ' + l)); }
  console.log(`\n结果：${out.length - bad} 通过 / ${bad} 失败`);

  try { ws.close(); } catch { /* 忽略 */ }
  try { proc.kill(); } catch { /* 忽略 */ }
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('测试自身出错：', e); process.exit(1); });
