/* ============================================================================
 * mobile.js —— 手机端逻辑（四 Tab App 式布局）
 *
 * 只依赖 /js/util.js 的 window.U（api / sse / renderMarkdown / toast）与后端接口。
 * **不依赖桌面那份 app.js** —— 那一份绑着顶栏状态灯、词云、背景视频、
 * 调试分栏等一堆桌面专有元素，手机上都不需要。
 *
 * 四个 Tab（App 式信息架构，不是"桌面缩小版"）：
 *   ① 陪伴 智能体对话（原样保留）+ 场景 chips
 *   ② 规划 16 字段表单，分组手风琴 + 吸底 CTA → POST /api/plan
 *   ③ 方案 时间轴 / 预算 / 备用选项（读 /api/plan 的返回）
 *   ④ 我的 设置列表（原来那个左侧抽屉的内容整体搬到这里）
 *
 * 关于虚拟形象：默认**纯色、不加载形象**，
 * 所以 PixiJS / Cubism 运行时是**按需动态加载**的 —— 不开形象一个字节都不下。
 * ==========================================================================*/
(function () {
  'use strict';

  const U = window.U || {};
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  const LS = {
    msgs: 'wenlv.m.msgs',
    avatar: 'wenlv.m.avatarOn',
    bg: 'wenlv.m.bg',
    form: 'wenlv.m.form',
    plan: 'wenlv.m.plan',
    speak: 'wenlv.m.speak',
  };

  const state = {
    page: 'companion',
    msgs: [],          // [{role:'user'|'assistant', content}]
    busy: false,
    stream: null,
    avatarOn: false,
    stage: null,       // Live2DStage 实例（开启形象后才有）
    plan: null,        // 最近一次生成的方案（/api/plan 的返回）
    speaking: false,
  };

  /* ------------------------------------------------------------------ 存储 */
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { } }
  function load(key, dflt) {
    try { const v = localStorage.getItem(key); return v == null ? dflt : JSON.parse(v); }
    catch { return dflt; }
  }
  function saveMsgs() { save(LS.msgs, state.msgs.slice(-60)); }
  function loadMsgs() {
    const a = load(LS.msgs, []);
    if (Array.isArray(a)) state.msgs = a.filter(m => m && m.role && typeof m.content === 'string');
  }

  /* ------------------------------------------------------------------ 渲染工具 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function md(t) {
    try { if (U.renderMarkdown) return U.renderMarkdown(t); } catch { }
    return esc(t).replace(/\n/g, '<br>');
  }
  function toast(msg, kind, ms) {
    try { U.toast && U.toast(msg, kind, ms); } catch { }
  }
  function agentName() { return state.cardName || '小文'; }

  /* ================================================================== Tab 切换 */
  const TITLES = { companion: '小文', plan: '旅行规划', result: '出行方案', me: '我的' };

  function switchPage(name, opts) {
    if (!TITLES[name]) name = 'companion';
    state.page = name;
    $$('.m-page').forEach(p => p.classList.toggle('active', p.dataset.page === name));
    $$('.m-tabbar .m-tab').forEach(t => t.classList.toggle('active', t.dataset.page === name));
    // 悬浮球只在「有内容余量」的页显示。
    // ★ 硬性条件：**页面上不能有可见的吸底 CTA**。
    //   实测「规划」页的 CTA 栏与悬浮球重叠 53px、压住按钮 42px ——
    //   主操作优先，所以那一页把球收起来（陪伴/方案/我的三页正常显示）。
    //   判断"可见"而不是只判断 data-page，是为了以后加吸底栏时不用改这里。
    const orb = $('#m-orb');
    if (orb) {
      let ctaVisible = false;
      try {
        const bar = document.querySelector('.m-page.active .m-cta-bar');
        if (bar) {
          const r = bar.getBoundingClientRect();
          ctaVisible = r.height > 4 && getComputedStyle(bar).display !== 'none';
        }
      } catch { /* 忽略 */ }
      orb.hidden = (name === 'companion') || ctaVisible;
    }
    // 顶栏只在陪伴页（其它页有各自的页头）
    const top = $('.m-top');
    if (top) top.style.display = (name === 'companion') ? '' : 'none';
    document.body.classList.toggle('m-on-companion', name === 'companion');
    try { save('wenlv.m.page', name); } catch { }
    if (name === 'companion') setTimeout(() => scrollEnd(false), 40);
    void opts;
  }

  /* ================================================================== 对话 */
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
    b.disabled = !i.value.trim() && !state.busy;
  }

  async function send(textArg) {
    const i = $('#m-input');
    const text = (textArg != null ? textArg : (i ? i.value : '')).trim();
    if (!text) return;
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
    if (!U.sse) { asst.bubble.textContent = '（对话组件未加载）'; state.busy = false; syncSend(); return; }
    const stream = U.sse('/api/agent', { message: text, history: state.msgs.slice(-12) }, (ev) => {
      if (!ev || !ev.type) return;
      if (ev.type === 'delta' && ev.text) {
        acc += ev.text;
        asst.bubble.innerHTML = md(acc);
        scrollEnd();
      } else if (ev.type === 'notice' && ev.text) {
        if (!acc) asst.bubble.innerHTML = '<span style="opacity:.6;font-size:13px">' + esc(ev.text) + '</span>';
      } else if (ev.type === 'error') {
        const m = ev.error || ev.text || '生成失败';
        asst.bubble.innerHTML = md(acc ? (acc + '\n\n⚠️ ' + m) : ('⚠️ ' + m));
        scrollEnd();
      }
    });
    state.stream = stream;

    try { await stream.promise; }
    catch (err) {
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
        // 规划模式下后端会返回结构化方案；这里只在"确实像方案"时才抓，避免误判
        if (/Day\s*\d|行程总览|预算：约|个性化方案/.test(finalText)) {
          fetchLatestPlan();
        }
      } else {
        asst.wrap.remove();
      }
      scrollEnd();
    }
  }

  /* ================================================================== 表单 */
  /* 字段与 backend/app/models/preference.py 的 UserPreference 一一对应（16 个）。 */
  const chipSel = new Set();
  const formState = { pace: '悠闲', priority: '玩', transportation: '高铁', prefs: [], diet: [] };

  function readForm() {
    const num = (id, d) => {
      const v = parseInt(($(id) || {}).value, 10);
      return Number.isFinite(v) ? v : d;
    };
    const txt = (id) => (($(id) || {}).value || '').trim();
    return {
      destination: txt('#pf-destination'),
      origin: txt('#pf-origin'),
      duration_days: num('#pf-days', 2),
      start_date: txt('#pf-date'),
      departure_time: txt('#pf-depart'),
      return_hotel_time: txt('#pf-return'),
      travelers: {
        adults: num('#pf-adults', 1),
        children: num('#pf-children', 0),
        elderly: num('#pf-elderly', 0),
      },
      has_pet: !!($('#pf-pet') || {}).checked,
      preferences: [...formState.prefs],
      must_visit: txt('#pf-must').split(/[,，、\s]+/).filter(Boolean),
      pace: formState.pace,
      priority: formState.priority,
      budget: num('#pf-budget', 3000),
      transportation: formState.transportation,
      dietary_restrictions: [...formState.diet],
      avoidances: txt('#pf-avoid').split(/[,，、\s]+/).filter(Boolean),
    };
  }

  function updateSums() {
    const f = readForm();
    const set = (k, t) => { const el = document.querySelector(`.m-g-sum[data-sum="${k}"]`); if (el) el.textContent = t; };
    const basic = [];
    if (f.destination) basic.push(f.destination);
    if (f.duration_days) basic.push(`${f.duration_days}天`);
    if (f.start_date) basic.push(f.start_date.slice(5));
    set('basic', basic.length ? basic.join(' · ') : '待填写');

    const people = [];
    if (f.travelers.adults) people.push(`${f.travelers.adults}成人`);
    if (f.travelers.children) people.push(`${f.travelers.children}儿童`);
    if (f.travelers.elderly) people.push(`${f.travelers.elderly}老人`);
    if (f.has_pet) people.push('带宠物');
    set('people', people.length ? people.join(' · ') : '待填写');

    const it = [];
    if (f.preferences.length) it.push(f.preferences.slice(0, 2).join('/'));
    it.push(f.pace);
    set('interest', it.join(' · '));

    set('budget', `¥${f.budget} · ${f.transportation}`);

    const av = [];
    if (f.dietary_restrictions.length) av.push(f.dietary_restrictions.join('/'));
    if (f.avoidances.length) av.push(`避雷${f.avoidances.length}项`);
    set('avoid', av.length ? av.join(' · ') : '可留空');
  }

  function saveForm() { save(LS.form, readForm()); }
  function restoreForm() {
    const f = load(LS.form, null);
    if (!f) return;
    const setv = (id, v) => { const el = $(id); if (el && v != null && v !== '') el.value = v; };
    setv('#pf-destination', f.destination); setv('#pf-origin', f.origin);
    setv('#pf-days', f.duration_days); setv('#pf-date', f.start_date);
    setv('#pf-depart', f.departure_time); setv('#pf-return', f.return_hotel_time);
    setv('#pf-budget', f.budget); setv('#pf-must', (f.must_visit || []).join(', '));
    setv('#pf-avoid', (f.avoidances || []).join(', '));
    const t = f.travelers || {};
    setv('#pf-adults', t.adults); setv('#pf-children', t.children); setv('#pf-elderly', t.elderly);
    const pet = $('#pf-pet'); if (pet) pet.checked = !!f.has_pet;
    formState.pace = f.pace || '悠闲';
    formState.priority = f.priority || '玩';
    formState.transportation = f.transportation || '高铁';
    formState.prefs = f.preferences || [];
    formState.diet = f.dietary_restrictions || [];
    syncSegs();
  }

  function syncSegs() {
    $$('#pf-pace .m-seg-b').forEach(b => b.classList.toggle('active', b.dataset.v === formState.pace));
    $$('#pf-priority .m-seg-b').forEach(b => b.classList.toggle('active', b.dataset.v === formState.priority));
    $$('#pf-trans .m-seg-b').forEach(b => b.classList.toggle('active', b.dataset.v === formState.transportation));
    $$('#pf-prefs .m-chip').forEach(b => b.classList.toggle('on', formState.prefs.indexOf(b.dataset.v) >= 0));
    $$('#pf-diet .m-chip').forEach(b => b.classList.toggle('on', formState.diet.indexOf(b.dataset.v) >= 0));
  }

  async function generate() {
    const f = readForm();
    if (!f.destination) {
      toast('先告诉我目的地吧', 'err');
      const d = $('#pf-destination'); if (d) d.focus();
      return;
    }
    const btn = $('#m-generate');
    if (btn) { btn.disabled = true; btn.textContent = '正在生成…'; }
    try {
      const res = await fetch('/api/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preference: f }),
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(txt.slice(0, 160) || `HTTP ${res.status}`);
      state.plan = JSON.parse(txt);
      save(LS.plan, state.plan);
      renderPlan();
      switchPage('result');
      const dot = $('#m-tab-dot'); if (dot) dot.hidden = true;
      toast('方案已生成', 'ok');
    } catch (e) {
      toast('生成失败：' + (e && e.message ? e.message : e), 'err', 5000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '生成我的旅行规划'; }
    }
  }

  /** 对话模式生成了方案时，把最近一条方案取回来渲染到「方案」页 */
  async function fetchLatestPlan() {
    try {
      const r = await fetch('/api/plans');
      if (!r.ok) return;
      const list = await r.json();
      if (!Array.isArray(list) || !list.length) return;
      const id = list[0].plan_id;
      const r2 = await fetch('/api/plans/' + encodeURIComponent(id));
      if (!r2.ok) return;
      state.plan = await r2.json();
      save(LS.plan, state.plan);
      renderPlan();
      const dot = $('#m-tab-dot'); if (dot) dot.hidden = false;
    } catch { /* 取不到就算了，不影响对话 */ }
  }

  /* ================================================================== 方案渲染 */
  function renderPlan() {
    const body = $('#m-result-body');
    const empty = $('#m-result-empty');
    const p = state.plan;
    if (!body) return;
    if (!p) { if (empty) empty.style.display = ''; body.innerHTML = ''; return; }
    if (empty) empty.style.display = 'none';

    const bb = p.budget_breakdown || {};
    const money = (n) => (Number(n) || 0).toFixed(0);

    let h = '<div class="m-plan-head">';
    h += `<div class="m-plan-sum">${esc(p.summary || '出行方案')}</div>`;
    h += '<div class="m-plan-meta">';
    h += `<span class="m-pill">总预算 <b>¥${money(p.total_budget_estimate)}</b></span>`;
    if (p.user_budget) h += `<span class="m-pill">你的预算 <b>¥${money(p.user_budget)}</b></span>`;
    if (p.travelers) h += `<span class="m-pill">${p.travelers} 人</span>`;
    h += `<span class="m-pill">交通 <b>¥${money(bb.transport)}</b></span>`;
    h += `<span class="m-pill">餐饮 <b>¥${money(bb.dining)}</b></span>`;
    h += `<span class="m-pill">住宿 <b>¥${money(bb.hotel)}</b></span>`;
    h += '</div></div>';

    for (const w of (p.warnings || [])) {
      h += `<div class="m-warn">⚠️ ${esc(w)}</div>`;
    }

    const days = p.daily_plans || [];
    days.forEach((d, di) => {
      const w = d.weather || {};
      const wtxt = [w.condition, w.temp].filter(Boolean).join(' ');
      h += '<div class="m-day">';
      h += `<div class="m-day-h"><span class="d">Day ${di + 1}</span>` +
        `<span class="w">${esc(d.date || '')}${wtxt ? ' · ' + esc(wtxt) : ''}</span></div>`;
      h += '<div class="m-tl">';
      for (const it of (d.timeline || [])) {
        const poi = it.poi || {};
        h += '<div class="m-item"><div class="m-card">';
        h += `<div class="m-card-time">${esc(it.time || '')}</div>`;
        h += `<div class="m-card-name">${esc(poi.name || '')}</div>`;
        if (poi.description) h += `<div class="m-card-desc">${esc(poi.description)}</div>`;
        if (poi.price != null && poi.price !== '') h += `<div class="m-card-tips">参考价 ¥${esc(String(poi.price))}</div>`;
        if (it.tips) h += `<div class="m-card-tips">${esc(it.tips)}</div>`;
        const t = it.transport_to_next;
        if (t && t.mode) {
          h += `<div class="m-trans">↳ ${esc(t.mode)} ${esc(t.duration || '')}` +
            (t.cost ? ` · ¥${esc(String(t.cost))}` : '') + '</div>';
        }
        h += '<div class="m-card-row">';
        if (poi.location) {
          h += `<button class="m-mini" data-map="${poi.location.lat},${poi.location.lng}" ` +
            `data-name="${esc(poi.name || '')}">🗺️ 地图</button>`;
        }
        h += `<button class="m-mini" data-say="介绍一下${esc(poi.name || '')}">💬 问问小文</button>`;
        h += '</div></div></div>';
      }
      h += '</div>';   // .m-tl
      if (d.hotel && d.hotel.name) {
        h += `<div class="m-card" style="margin-top:8px"><div class="m-card-time">当晚住宿</div>` +
          `<div class="m-card-name">${esc(d.hotel.name)}</div>` +
          (d.hotel.description ? `<div class="m-card-desc">${esc(d.hotel.description)}</div>` : '') +
          '</div>';
      }
      for (const t of (d.tips || []).slice(0, 3)) {
        h += `<div class="m-card-tips">· ${esc(t)}</div>`;
      }
      h += '</div>';
    });

    // 备用选项：换景点 / 换餐厅 / 换住处的候选池
    const opt = (title, arr, n) => {
      if (!Array.isArray(arr) || !arr.length) return '';
      let s = `<details class="m-group" style="margin-top:12px"><summary>` +
        `<span class="m-g-ico">🔁</span><span class="m-g-t">${title}</span>` +
        `<span class="m-g-sum">${arr.length} 个备选</span><span class="m-g-arrow">▾</span></summary>` +
        '<div class="m-g-body">';
      for (const o of arr.slice(0, n)) {
        s += `<div class="m-card"><div class="m-card-name">${esc(o.name || '')}</div>` +
          (o.tips || o.description ? `<div class="m-card-desc">${esc(o.tips || o.description)}</div>` : '') +
          (o.price != null && o.price !== '' ? `<div class="m-card-tips">参考价 ¥${esc(String(o.price))}</div>` : '') +
          '</div>';
      }
      return s + '</div></details>';
    };
    h += opt('换个景点', p.attraction_options, 12);
    h += opt('换个餐厅', p.dining_options, 10);
    h += opt('换个住处', p.hotel_options, 10);

    body.innerHTML = h;
  }

  /* ================================================================== 虚拟形象 */
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
      const cap = await U.api('/api/capabilities');
      const list = (cap && cap.live2d) || [];
      const pick = list[0];
      if (!pick) throw new Error('后端没有可用的 Live2D 形象');
      await state.stage.load(pick.entry, { label: pick.label, focusFollow: true });
      // 载入后开始程序化待机（呼吸/微摆/定时小动作），不然模型是"死"的
      try { state.stage.startIdle({ motionEveryMs: 14000 }); } catch { }
      document.body.classList.add('avatar-on');
      state.avatarOn = true;
      try { localStorage.setItem(LS.avatar, '1'); } catch { }
      if (hint) hint.textContent = `形象已开启：${pick.label}。文字回复时口型会跟着动。`;
    } catch (e) {
      document.body.classList.remove('avatar-on');
      state.avatarOn = false;
      if (hint) hint.textContent = '开启失败：' + (e && e.message ? e.message : e) + '（关掉开关可回到纯色界面）';
      toast('虚拟形象开启失败', 'err');
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
    if (state.speaking) speakText(t);
  }

  /* ------------------------------------------------------------------ 朗读 */
  async function speakText(text) {
    try {
      const r = await fetch('/api/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: String(text).slice(0, 400) }),
      });
      if (!r.ok) return;
      const blob = await r.blob();
      const a = new Audio(URL.createObjectURL(blob));
      a.play().catch(() => { });
    } catch { /* 没配 TTS 就静默跳过 */ }
  }

  /* ------------------------------------------------------------------ 纯色底 */
  function applyBg(hex) {
    if (!hex) return;
    document.documentElement.style.setProperty('--m-bg', hex);
    const n = parseInt(hex.replace('#', ''), 16);
    const lum = (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114);
    document.body.classList.toggle('light', lum > 165);
    $$('.m-swatch').forEach(s => s.classList.toggle('on', s.dataset.bg === hex));
  }

  async function refreshAbout() {
    try {
      const st = await U.api('/api/status');
      const o = (st && st.ollama) || {};
      const m = $('#m-about-model');
      if (m) m.textContent = '模型：' + (o.chatModel || '未检测到') + '（' + (o.running ? '已连接' : '未运行') + '）';
    } catch { }
    const n = $('#m-about-net');
    if (n) n.textContent = '地址：' + location.host;
    const h = $('#m-me-host');
    if (h) h.textContent = '已连接 ' + location.host + ' · 本机推理';
  }

  /* ================================================================== 悬浮球 */
  function openSheet() {
    let mask = $('#m-sheet-mask'), sheet = $('#m-sheet');
    if (!sheet) {
      mask = document.createElement('div');
      mask.className = 'm-sheet-mask'; mask.id = 'm-sheet-mask';
      sheet = document.createElement('div');
      sheet.className = 'm-sheet'; sheet.id = 'm-sheet';
      sheet.innerHTML =
        '<div class="m-sheet-h"><span>快捷对话</span>' +
        '<button class="m-icon" id="m-sheet-close" aria-label="关闭">✕</button></div>' +
        '<div class="m-sheet-body" id="m-sheet-body">' +
        '<div class="m-empty" style="padding:8px 0"><div class="t">问一句就走</div>' +
        '<div class="d">不用切回「陪伴」页，这里直接跟小文说话。</div></div></div>' +
        '<div class="m-sheet-foot"><div class="m-composer">' +
        '<div class="m-input-wrap"><textarea id="m-sheet-input" rows="1" ' +
        'placeholder="想说点什么…" enterkeyhint="send"></textarea></div>' +
        '<button class="m-send" id="m-sheet-send" title="发送">↑</button></div></div>';
      document.body.appendChild(mask);
      document.body.appendChild(sheet);
      mask.addEventListener('click', closeSheet);
      sheet.querySelector('#m-sheet-close').addEventListener('click', closeSheet);
      const inp = sheet.querySelector('#m-sheet-input');
      const go = async () => {
        const v = inp.value.trim();
        if (!v) return;
        inp.value = '';
        const b = sheet.querySelector('#m-sheet-body');
        const q = document.createElement('div');
        q.className = 'm-msg me';
        q.innerHTML = `<div class="m-ava">我</div><div class="m-body"><div class="m-bubble">${esc(v)}</div></div>`;
        b.appendChild(q);
        const a = bubble('assistant', '', { typing: true });
        b.appendChild(a.wrap);
        b.scrollTop = b.scrollHeight;
        let acc = '';
        try {
          const st = U.sse('/api/agent', { message: v, history: state.msgs.slice(-8) }, (ev) => {
            if (ev && ev.type === 'delta' && ev.text) { acc += ev.text; a.bubble.innerHTML = md(acc); b.scrollTop = b.scrollHeight; }
            else if (ev && ev.type === 'error') { a.bubble.innerHTML = md('⚠️ ' + (ev.error || '失败')); }
          });
          await st.promise;
        } catch { }
        if (!acc.trim()) a.wrap.remove();
        state.msgs.push({ role: 'user', content: v });
        if (acc.trim()) state.msgs.push({ role: 'assistant', content: acc.trim() });
        saveMsgs();
      };
      sheet.querySelector('#m-sheet-send').addEventListener('click', go);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); }
      });
    }
    mask.hidden = false;
    requestAnimationFrame(() => { sheet.classList.add('show'); });
  }
  function closeSheet() {
    const sheet = $('#m-sheet'), mask = $('#m-sheet-mask');
    if (sheet) sheet.classList.remove('show');
    if (mask) mask.hidden = true;
  }

  /* ================================================================== 手势 */
  /* 从左边缘向右滑 = 切到「我的」页（原「设置抽屉」的手势，交互直觉不变）。
     抽屉已经删掉 —— 设置项搬进了 Tab ④，两份 DOM 装同一批 id 是踩过的坑。 */
  function bindGestures() {
    const EDGE = 28;
    let sx = 0, sy = 0, tracking = false, decided = false, horiz = false;
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY;
      tracking = sx <= EDGE;      // 只有从左边缘起手才算
      decided = false; horiz = false;
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!tracking || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (!decided) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        decided = true;
        // 竖向滑动是滚动，不能被我们抢走
        horiz = Math.abs(dx) > Math.abs(dy) * 1.3 && dx > 0;
      }
      if (decided && horiz && e.cancelable) e.preventDefault();
    }, { passive: false });
    document.addEventListener('touchend', (e) => {
      if (!tracking) return;
      tracking = false;
      if (!decided || !horiz) return;
      const t = (e.changedTouches && e.changedTouches[0]) || {};
      if ((t.clientX || sx) - sx > 60) switchPage('me');
    }, { passive: true });
  }

  /* ================================================================== 绑定 */
  function bind() {
    // Tab 栏
    const tb = $('#m-tabbar');
    if (tb) tb.addEventListener('click', (e) => {
      const b = e.target.closest('.m-tab');
      if (b) switchPage(b.dataset.page);
    });

    // 顶栏
    $('#m-menu') && $('#m-menu').addEventListener('click', () => switchPage('me'));
    $('#m-clear') && $('#m-clear').addEventListener('click', () => {
      if (!state.msgs.length) return;
      state.msgs.length = 0; saveMsgs(); renderAll();
    });

    // 对话输入
    const i = $('#m-input');
    if (i) {
      i.addEventListener('input', () => { autoGrow(); syncSend(); });
      i.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      });
    }
    $('#m-send') && $('#m-send').addEventListener('click', () => send());
    $('#m-plus') && $('#m-plus').addEventListener('click', () => toast('用下面那排快捷入口，或直接说一句', 'ok', 2200));

    // 功能展示排 / 场景 chips
    const feats = $('#m-feats');
    if (feats) feats.addEventListener('click', (e) => {
      const b = e.target.closest('.m-feat');
      if (!b) return;
      const t = FEATS[b.dataset.feat];
      if (t) send(t);
    });

    // 表单：单选段 + 多选胶囊 + 输入变化
    const seg = (sel, key) => {
      const box = $(sel);
      if (!box) return;
      box.addEventListener('click', (e) => {
        const b = e.target.closest('.m-seg-b');
        if (!b) return;
        formState[key] = b.dataset.v;
        syncSegs(); updateSums(); saveForm();
      });
    };
    seg('#pf-pace', 'pace'); seg('#pf-priority', 'priority'); seg('#pf-trans', 'transportation');

    const chips = (sel, key) => {
      const box = $(sel);
      if (!box) return;
      box.addEventListener('click', (e) => {
        const b = e.target.closest('.m-chip');
        if (!b) return;
        const v = b.dataset.v;
        const arr = formState[key];
        const k = arr.indexOf(v);
        if (k >= 0) arr.splice(k, 1); else arr.push(v);
        syncSegs(); updateSums(); saveForm();
      });
    };
    chips('#pf-prefs', 'prefs'); chips('#pf-diet', 'diet');

    ['#pf-destination', '#pf-origin', '#pf-days', '#pf-date', '#pf-depart', '#pf-return',
      '#pf-budget', '#pf-must', '#pf-avoid', '#pf-adults', '#pf-children', '#pf-elderly']
      .forEach(sel => {
        const el = $(sel);
        if (el) el.addEventListener('input', () => { updateSums(); saveForm(); });
      });
    const pet = $('#pf-pet');
    if (pet) pet.addEventListener('change', () => { updateSums(); saveForm(); });

    // 吸底生成
    $('#m-generate') && $('#m-generate').addEventListener('click', generate);
    $('#m-goto-plan') && $('#m-goto-plan').addEventListener('click', () => switchPage('plan'));

    // 方案页里的「地图 / 问问小文」按钮（事件委托）
    const rb = $('#m-result-body');
    if (rb) rb.addEventListener('click', (e) => {
      const m = e.target.closest('[data-map]');
      if (m) {
        const [lat, lng] = String(m.dataset.map).split(',');
        const nm = m.dataset.name || '目的地';
        window.open(`https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(nm)}`, '_blank');
        return;
      }
      const s = e.target.closest('[data-say]');
      if (s) { switchPage('companion'); send(s.dataset.say); }
    });

    // 我的页
    $('#m-me-newchat') && $('#m-me-newchat').addEventListener('click', () => {
      state.msgs.length = 0; saveMsgs(); renderAll(); switchPage('companion');
      const inp = $('#m-input'); if (inp) inp.focus();
    });
    const sw = $('#m-avatar');
    if (sw) sw.addEventListener('change', () => { if (sw.checked) enableAvatar(); else disableAvatar(); });

    const pal = $('#m-palette');
    if (pal) pal.addEventListener('click', (e) => {
      const b = e.target.closest('.m-swatch');
      if (!b) return;
      applyBg(b.dataset.bg);
      try { localStorage.setItem(LS.bg, b.dataset.bg); } catch { }
    });

    const sp = $('#m-speak');
    if (sp) sp.addEventListener('change', () => {
      state.speaking = sp.checked;
      try { localStorage.setItem(LS.speak, sp.checked ? '1' : '0'); } catch { }
    });

    // 悬浮球
    const orb = $('#m-orb');
    if (orb) {
      let dragged = false, ox = 0, oy = 0, moved = false;
      orb.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        ox = t.clientX; oy = t.clientY; moved = false; dragged = true;
      }, { passive: true });
      orb.addEventListener('touchmove', (e) => {
        if (!dragged) return;
        const t = e.touches[0];
        if (Math.abs(t.clientX - ox) > 8 || Math.abs(t.clientY - oy) > 8) moved = true;
      }, { passive: true });
      orb.addEventListener('touchend', () => { dragged = false; });
      orb.addEventListener('click', () => { if (!moved) openSheet(); });
    }

    bindGestures();
    bindScrollHideOrb();
  }

  /**
   * 滚动时把悬浮球淡出。
   *
   * 为什么需要：球固定在右下角，而「方案」页的时间轴卡片正好铺到那里 ——
   * 实测盖住了卡片标题。停 450ms 后再淡回来，既保留入口又不挡内容。
   * 用**事件委托**挂在 document 上（capture），这样三个可滚动区
   * （.m-scroll 与 .m-log）都不用各自绑一遍。
   */
  function bindScrollHideOrb() {
    let timer = 0;
    document.addEventListener('scroll', (e) => {
      const t = e.target;
      if (!t || !t.classList) return;
      if (!t.classList.contains('m-scroll') && !t.classList.contains('m-log')) return;
      document.body.classList.add('m-scrolling');
      clearTimeout(timer);
      timer = setTimeout(() => document.body.classList.remove('m-scrolling'), 450);
    }, true);
  }

  const FEATS = {
    fast: '帮我快速排一个两天一夜的行程',
    nearby: '我现在在杭州，附近有什么值得去的景点？',
    weather: '这几天杭州的天气怎么样？适合去哪里玩？',
    food: '帮我推荐几个本地人常去、不踩雷的餐厅',
    hotel: '帮我看看住哪里比较方便，预算中等',
    marketing: '帮我写一段杭州的营销文案',
  };

  /* ================================================================== 启动 */
  function init() {
    loadMsgs();
    bind();
    renderAll();
    autoGrow();
    syncSend();

    // 纯色底：读上次选的
    const bg = (() => { try { return localStorage.getItem(LS.bg); } catch { return null; } })();
    applyBg(bg || '#0f1419');

    restoreForm();
    updateSums();

    // 恢复上次的方案
    const p = load(LS.plan, null);
    if (p && p.daily_plans) { state.plan = p; renderPlan(); }
    else renderPlan();

    // 朗读开关
    const sp = $('#m-speak');
    if (sp) { sp.checked = (localStorage.getItem(LS.speak) === '1'); state.speaking = sp.checked; }

    // 形象：默认**关闭**
    try {
      if (localStorage.getItem(LS.avatar) === '1') {
        const s = $('#m-avatar'); if (s) s.checked = true;
        enableAvatar();
      }
    } catch { }

    // 回到上次的 Tab（默认陪伴页）
    const last = (() => { try { return localStorage.getItem('wenlv.m.page'); } catch { return null; } })();
    switchPage(TITLES[last] ? last : 'companion');

    refreshAbout();
    window.__m = {
      state, send, generate, switchPage, renderPlan, openSheet, closeSheet,
      enableAvatar, disableAvatar, applyBg, readForm, updateSums,
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
