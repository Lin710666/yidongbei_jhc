/* ============================================================================
 * mobile.js —— 手机端逻辑（豆包式）
 *
 * 只依赖 /js/util.js 的 window.U（api / sse / renderMarkdown / toast）与后端接口。
 * **不依赖桌面那份 app.js** —— 那一份绑着顶栏状态灯、词云、背景视频、
 * 调试分栏等一堆桌面专有元素，手机上都不需要。
 *
 * 三件事：
 *   ① 对话（SSE 流式气泡）
 *   ② 功能展示排：点了之后按预设话术发一条，走同一条对话链路
 *   ③ 左侧设置抽屉：手势从左边缘向右划调出；里面有「开启虚拟形象」开关
 *
 * 关于虚拟形象：需求方要求**一开始纯色、不加载形象**，
 * 所以 PixiJS / Cubism 运行时在这里是**按需动态加载**的 ——
 * 不开形象的用户一个字节都不下。
 * ==========================================================================*/
(function () {
  'use strict';

  const U = window.U || {};
  const $ = (s) => document.querySelector(s);
  const LS = {
    msgs: 'wenlv.m.msgs',
    avatar: 'wenlv.m.avatarOn',
    bg: 'wenlv.m.bg',
  };

  const state = {
    msgs: [],          // [{role:'user'|'assistant', content}]
    busy: false,
    stream: null,
    avatarOn: false,
    stage: null,       // Live2DStage 实例（开启形象后才有）
  };

  /* ------------------------------------------------------------------ 存储 */
  function saveMsgs() {
    try { localStorage.setItem(LS.msgs, JSON.stringify(state.msgs.slice(-60))); } catch { }
  }
  function loadMsgs() {
    try {
      const a = JSON.parse(localStorage.getItem(LS.msgs) || '[]');
      if (Array.isArray(a)) state.msgs = a.filter(m => m && m.role && typeof m.content === 'string');
    } catch { }
  }

  /* ------------------------------------------------------------------ 渲染 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function md(t) {
    try { if (U.renderMarkdown) return U.renderMarkdown(t); } catch { }
    return esc(t).replace(/\n/g, '<br>');
  }
  function agentName() {
    return (state.cardName || '小文');
  }

  function bubble(role, content, { typing = false } = {}) {
    const me = role === 'user';
    const wrap = document.createElement('div');
    wrap.className = 'm-msg ' + (me ? 'me' : 'bot');
    const ava = document.createElement('div');
    ava.className = 'm-ava';
    ava.textContent = me ? '我' : agentName().slice(0, 1);
    const body = document.createElement('div');
    body.className = 'm-body';
    const b = document.createElement('div');
    b.className = 'm-bubble';
    if (typing) b.innerHTML = '<span class="m-typing"><i></i><i></i><i></i></span>';
    else b.innerHTML = md(content);
    body.appendChild(b);
    wrap.appendChild(ava);
    wrap.appendChild(body);
    return { wrap, bubble: b };
  }

  const logEl = () => $('#m-log');
  function scrollEnd(smooth) {
    const L = logEl();
    if (!L) return;
    try { L.scrollTo({ top: L.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); }
    catch { L.scrollTop = L.scrollHeight; }
  }

  function emptyState() {
    const box = document.createElement('div');
    box.className = 'm-empty';
    box.innerHTML =
      '<div class="big">🏔️</div>' +
      '<div class="t">你好，我是你的文旅向导</div>' +
      '<div class="d">可以直接问我任何问题，也可以把想去的地方、天数、预算告诉我。</div>';
    const sg = document.createElement('div');
    sg.className = 'm-suggests';
    ['杭州两天怎么安排？', '带孩子去成都，有什么推荐？', '周末周边游，预算 800', '帮我写一段杭州的营销文案']
      .forEach(t => {
        const b = document.createElement('button');
        b.className = 'm-suggest';
        b.type = 'button';
        b.textContent = t;
        b.addEventListener('click', () => { setInput(t); send(); });
        sg.appendChild(b);
      });
    box.appendChild(sg);
    return box;
  }

  function renderAll() {
    const L = logEl();
    if (!L) return;
    L.innerHTML = '';
    if (!state.msgs.length) { L.appendChild(emptyState()); return; }
    for (const m of state.msgs) L.appendChild(bubble(m.role, m.content).wrap);
    scrollEnd();
  }

  /* ------------------------------------------------------------------ 输入 */
  function setInput(v) {
    const i = $('#m-input');
    if (!i) return;
    i.value = v;
    autoGrow();
    syncSend();
  }
  function autoGrow() {
    const i = $('#m-input');
    if (!i) return;
    i.style.height = 'auto';
    i.style.height = Math.min(i.scrollHeight, 116) + 'px';
  }
  function syncSend() {
    const i = $('#m-input'), b = $('#m-send');
    if (!i || !b) return;
    const has = i.value.trim().length > 0;
    b.disabled = !has && !state.busy;
    b.classList.toggle('stop', state.busy);
  }

  /* ------------------------------------------------------------------ 发消息 */
  async function send(textArg) {
    const i = $('#m-input');
    const text = (textArg != null ? textArg : (i ? i.value : '')).trim();
    if (!text) return;

    // 生成中再点发送 = 停止（手机上等太久很烦，给个出口）
    if (state.busy) { try { state.stream && state.stream.abort(); } catch { } return; }

    if (i) { i.value = ''; autoGrow(); syncSend(); }
    const L = logEl();
    const e = L && L.querySelector('.m-empty');
    if (e) e.remove();

    state.msgs.push({ role: 'user', content: text });
    saveMsgs();
    if (L) { L.appendChild(bubble('user', text).wrap); scrollEnd(); }

    state.busy = true; syncSend();
    const asst = bubble('assistant', '', { typing: true });
    if (L) { L.appendChild(asst.wrap); scrollEnd(); }
    talkStart();

    let acc = '';
    if (!U.sse) {
      asst.bubble.textContent = '（对话组件未加载）';
      state.busy = false; syncSend(); return;
    }
    const stream = U.sse('/api/agent', {
      message: text,
      history: state.msgs.slice(-12),
    }, (ev) => {
      if (!ev || !ev.type) return;
      if (ev.type === 'delta' && ev.text) {
        acc += ev.text;
        asst.bubble.innerHTML = md(acc);
        scrollEnd();
      } else if (ev.type === 'notice' && ev.text) {
        if (!acc) asst.bubble.innerHTML = '<span style="opacity:.6;font-size:13px">' + esc(ev.text) + '</span>';
      } else if (ev.type === 'error') {
        const msg = ev.error || ev.text || '生成失败';
        asst.bubble.innerHTML = md(acc ? (acc + '\n\n⚠️ ' + msg) : ('⚠️ ' + msg));
        scrollEnd();
      }
    });
    state.stream = stream;

    try {
      await stream.promise;
    } catch (err) {
      if (!(err && err.name === 'AbortError')) {
        asst.bubble.innerHTML = md(acc || ('⚠️ ' + (err && err.message ? err.message : '请求失败')));
      }
    } finally {
      state.stream = null;
      state.busy = false;
      syncSend();
      const finalText = acc.trim();
      if (finalText) {
        state.msgs.push({ role: 'assistant', content: finalText });
        saveMsgs();
        talkText(finalText);
      } else {
        asst.wrap.remove();
      }
      scrollEnd();
      try { U.toast && null; } catch { }
    }
  }

  /* ------------------------------------------------------------- 功能展示排 */
  /* 点了之后**不是**在本页出方案，而是按预设话术发一条对话 ——
     需求方要的是"对话栏上一排是有的功能展示"，本质是快捷入口。 */
  const FEATS = {
    fast: '帮我快速排一个两天一夜的行程',
    nearby: '我现在在杭州，附近有什么值得去的景点？',
    weather: '这几天杭州的天气怎么样？适合去哪里玩？',
    food: '帮我推荐几个本地人常去、不踩雷的餐厅',
    hotel: '帮我看看住哪里比较方便，预算中等',
    marketing: '帮我写一段杭州的营销文案',
  };

  /* ------------------------------------------------------------------ 抽屉 */
  let drawerOpen = false;
  function openDrawer() {
    drawerOpen = true;
    const d = $('#m-drawer'), m = $('#m-mask');
    if (m) m.hidden = false;
    requestAnimationFrame(() => {
      if (m) m.classList.add('show');
      if (d) { d.classList.add('show'); d.setAttribute('aria-hidden', 'false'); }
    });
  }
  function closeDrawer() {
    drawerOpen = false;
    const d = $('#m-drawer'), m = $('#m-mask');
    if (d) { d.classList.remove('show'); d.setAttribute('aria-hidden', 'true'); }
    if (m) m.classList.remove('show');
    setTimeout(() => { if (!drawerOpen && m) m.hidden = true; }, 260);
  }

  /* 手势：从左边缘向右划调出；抽屉打开时向左划收回。
     用 touch 事件手写，不引第三方手势库 —— 手机上少一个依赖少一份体积。 */
  function bindGestures() {
    const EDGE = 28;          // 左边缘感应区宽度
    let sx = 0, sy = 0, tracking = false, decided = false, horiz = false;
    const d = $('#m-drawer');

    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY;
      const fromEdge = sx <= EDGE && !drawerOpen;
      tracking = fromEdge || drawerOpen;
      decided = false; horiz = false;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!tracking || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (!decided) {
        // 先判断主方向：竖向滑动是滚动对话，不能被我们抢走
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        decided = true;
        horiz = Math.abs(dx) > Math.abs(dy) * 1.3;
        if (horiz && d) d.classList.add('dragging');
      }
      if (!decided || !horiz) return;
      // 跟随手指：打开中 dx>0 为拉出，已打开时 dx<0 为推回
      const w = d ? d.getBoundingClientRect().width : 300;
      let x = drawerOpen ? Math.min(0, dx) : Math.min(w, Math.max(0, dx));
      if (d) d.style.transform = `translateX(${x - (drawerOpen ? 0 : w)}px)`;
      // 顺手带动遮罩
      const m = $('#m-mask');
      if (m) {
        if (m.hidden) m.hidden = false;
        const p = drawerOpen ? 1 + x / w : x / w;
        m.classList.add('show');
        m.style.opacity = String(Math.max(0, Math.min(1, p)) * 0.42 / 0.42);
      }
      if (e.cancelable) e.preventDefault();
    }, { passive: false });

    document.addEventListener('touchend', (e) => {
      if (!tracking) return;
      const wasTracking = tracking;
      tracking = false;
      if (!horiz) { if (d) d.classList.remove('dragging'); return; }
      const t = (e.changedTouches && e.changedTouches[0]) || {};
      const dx = (t.clientX || sx) - sx;
      const w = d ? d.getBoundingClientRect().width : 300;
      if (d) { d.classList.remove('dragging'); d.style.transform = ''; }
      const m = $('#m-mask');
      if (m) m.style.opacity = '';
      if (!drawerOpen && dx > w * 0.34) openDrawer();
      else if (drawerOpen && dx < -w * 0.28) closeDrawer();
      else if (drawerOpen) openDrawer();
      void wasTracking;
    }, { passive: true });
  }

  /* --------------------------------------------------------------- 虚拟形象 */
  /* 按需加载：只有用户真的打开开关，才去下 PixiJS 与 Cubism 运行时。 */
  const RUNTIME = [
    '/vendor/live2dcubismcore.min.js',
    '/vendor/pixi.min.js',
    '/vendor/pixi-live2d-display-cubism4.min.js',
  ];
  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement('script');
      s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('加载失败: ' + src));
      document.head.appendChild(s);
    });
  }

  async function enableAvatar() {
    const hint = $('#m-avatar-hint');
    if (hint) hint.textContent = '正在加载形象与运行时…';
    try {
      for (const s of RUNTIME) await loadScript(s);
      if (!window.PIXI || !window.PIXI.live2d) throw new Error('运行时没起来');
      await loadScript('/js/live2d.js');
      if (!window.Live2DStage) throw new Error('live2d.js 没加载');
      if (!state.stage) {
        state.stage = new window.Live2DStage($('#live2d-canvas'));
        state.stage.focusFollow = true;      // 手机上跟随手指更有意思
        await state.stage.init();
      }
      // 用清单里的第一个形象（后端 /api/capabilities 的顺序）
      const cap = await U.api('/api/capabilities');
      const list = (cap && cap.live2d) || [];
      const pick = list[0];
      if (!pick) throw new Error('后端没有可用的 Live2D 形象');
      await state.stage.load(pick.entry, { label: pick.label, focusFollow: true });
      // 载入后开始程序化待机（呼吸/微摆/定时小动作）——
      // 不然模型是"死"的，只有一个静止立绘。
      try { state.stage.startIdle({ motionEveryMs: 14000 }); } catch { }
      document.body.classList.add('avatar-on');
      state.avatarOn = true;
      try { localStorage.setItem(LS.avatar, '1'); } catch { }
      if (hint) hint.textContent = `形象已开启：${pick.label}。文字回复时口型会跟着动。`;
    } catch (e) {
      document.body.classList.remove('avatar-on');
      state.avatarOn = false;
      if (hint) hint.textContent = '开启失败：' + (e && e.message ? e.message : e) + '（关掉开关可回到纯色界面）';
      try { U.toast && U.toast('虚拟形象开启失败', 'err'); } catch { }
    }
    const sw = $('#m-avatar');
    if (sw) sw.checked = state.avatarOn;
  }

  function disableAvatar() {
    document.body.classList.remove('avatar-on');
    state.avatarOn = false;
    try { localStorage.setItem(LS.avatar, '0'); } catch { }
    const hint = $('#m-avatar-hint');
    if (hint) hint.textContent = '形象已关闭，回到纯色界面（省电、省流量）。';
    // 不销毁 stage：再打开时不用重新下载与初始化
  }

  function talkStart() { /* 说话状态（有形象时才有效果） */ }
  function talkText(t) {
    try { if (state.stage && state.stage.talkTo) state.stage.talkTo(String(t).slice(0, 200)); } catch { }
  }

  /* ------------------------------------------------------------------ 启动 */
  function bind() {
    $('#m-menu') && $('#m-menu').addEventListener('click', openDrawer);
    $('#m-drawer-close') && $('#m-drawer-close').addEventListener('click', closeDrawer);
    $('#m-mask') && $('#m-mask').addEventListener('click', closeDrawer);

    const i = $('#m-input');
    if (i) {
      i.addEventListener('input', () => { autoGrow(); syncSend(); });
      i.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      });
    }
    $('#m-send') && $('#m-send').addEventListener('click', () => send());
    $('#m-clear') && $('#m-clear').addEventListener('click', () => {
      if (!state.msgs.length) return;
      state.msgs.length = 0; saveMsgs(); renderAll();
    });
    $('#m-new-chat') && $('#m-new-chat').addEventListener('click', () => {
      state.msgs.length = 0; saveMsgs(); renderAll(); closeDrawer();
      const inp = $('#m-input'); if (inp) inp.focus();
    });
    $('#m-plus') && $('#m-plus').addEventListener('click', () => {
      try { U.toast && U.toast('更多功能：用下面那排快捷入口', 'ok', 2200); } catch { }
    });

    // 功能展示排
    const feats = $('#m-feats');
    if (feats) {
      feats.addEventListener('click', (e) => {
        const b = e.target.closest('.m-feat');
        if (!b) return;
        const t = FEATS[b.dataset.feat];
        if (t) send(t);
      });
    }

    // 虚拟形象开关
    const sw = $('#m-avatar');
    if (sw) sw.addEventListener('change', () => {
      if (sw.checked) enableAvatar(); else disableAvatar();
    });

    // 纯色底
    const pal = $('#m-palette');
    if (pal) {
      pal.addEventListener('click', (e) => {
        const b = e.target.closest('.m-swatch');
        if (!b) return;
        applyBg(b.dataset.bg);
        try { localStorage.setItem(LS.bg, b.dataset.bg); } catch { }
      });
    }

    bindGestures();
  }

  function applyBg(hex) {
    if (!hex) return;
    document.documentElement.style.setProperty('--m-bg', hex);
    // 亮色底要换成浅色主题，否则浅底浅字看不清
    const n = parseInt(hex.replace('#', ''), 16);
    const lum = (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114);
    document.body.classList.toggle('light', lum > 165);
    document.querySelectorAll('.m-swatch').forEach(s => s.classList.toggle('on', s.dataset.bg === hex));
  }

  async function refreshAbout() {
    try {
      const st = await U.api('/api/status');
      const m = $('#m-about-model');
      if (m) m.textContent = '模型：' + ((st.ollama && st.ollama.chatModel) || '未检测到') +
        '（' + ((st.ollama && st.ollama.running) ? '已连接' : '未运行') + '）';
    } catch { }
    const n = $('#m-about-net');
    if (n) n.textContent = '地址：' + location.host;
  }

  function init() {
    loadMsgs();
    bind();
    renderAll();
    autoGrow();
    syncSend();
    // 纯色底：读上次选的
    try {
      const bg = localStorage.getItem(LS.bg);
      if (bg) applyBg(bg); else applyBg('#0f1419');
    } catch { applyBg('#0f1419'); }
    // 形象：默认**关闭**（需求方要求一开始纯色）
    try {
      if (localStorage.getItem(LS.avatar) === '1') {
        const sw = $('#m-avatar');
        if (sw) sw.checked = true;
        enableAvatar();
      }
    } catch { }
    refreshAbout();
    window.__m = { state, send, openDrawer, closeDrawer, enableAvatar, disableAvatar, applyBg };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
