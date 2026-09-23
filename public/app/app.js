/* ============================================================================
 * app.js —— 网页端 / 软件端（重写版）控制器
 *
 * 只依赖 /js/util.js 的 window.U（api / sse / renderMarkdown / toast）。
 * **不依赖旧 app.js** —— 那是旧信息架构（底部横栏 + 抽屉 + 调试分栏）的实现，
 * 正是这次要按新图纸换掉的东西。
 *
 * 结构对应图纸四区：
 *   顶栏    状态灯 + 工具
 *   舞台    词云胶囊 / 人物 / 结果卡浮层 / 浮动输入条
 *   Dock    工作台 / 对话 / 结果 / 设置（折叠 360 → 48 → 0）
 * ==========================================================================*/
(function () {
  'use strict';

  const U = window.U || {};
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  const LS = {
    cols: 'wenlv.app.cols',
    avatar: 'wenlv.app.avatar',
    speak: 'wenlv.app.speak',
    bg: 'wenlv.app.bg',
    scale: 'wenlv.app.scale',
    form: 'wenlv.app.form',
    chat: 'wenlv.app.chat',
    plan: 'wenlv.app.plan',
  };

  const state = {
    pane: 'work',
    cols: 'open',            // open | fold | shut
    avatarOn: false,
    stage: null,
    busy: false,
    stream: null,
    chat: [],
    plan: null,
    wcSel: new Set(),
    wcWords: [],
    speaking: false,
  };

  /* ------------------------------------------------------------------ 工具 */
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } }
  function load(k, d) {
    try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }
    catch { return d; }
  }
  function toast(m, k, ms) { try { U.toast && U.toast(m, k, ms); } catch { } }
  function md(t) {
    try { if (U.renderMarkdown) return U.renderMarkdown(t); } catch { }
    return String(t == null ? '' : t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
  function agentName() { return state.cardName || '小文'; }

  /* ================================================================ Dock 折叠 */
  function setCols(mode) {
    if (['open', 'fold', 'shut'].indexOf(mode) < 0) mode = 'open';
    state.cols = mode;
    document.body.dataset.cols = mode;
    const ico = $('#fold-ico');
    if (ico) ico.textContent = (mode === 'shut') ? '❮' : '❯';
    save(LS.cols, mode);
    resizeStage();
  }
  $('#dock-fold') && $('#dock-fold').addEventListener('click', () => {
    // 三档循环：open → fold → shut → open
    setCols(state.cols === 'open' ? 'fold' : (state.cols === 'fold' ? 'shut' : 'open'));
  });

  /* ================================================================ 页签 */
  function switchPane(name) {
    if (['work', 'chat', 'result', 'setting'].indexOf(name) < 0) name = 'work';
    state.pane = name;
    $$('.dt').forEach(b => b.classList.toggle('active', b.dataset.pane === name));
    $$('.pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + name));
    if (state.cols === 'shut') setCols('open');   // 切页签时把 Dock 叫回来
    save('wenlv.app.pane', name);
  }
  $('#dock-tabs') && $('#dock-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.dt');
    if (b) switchPane(b.dataset.pane);
  });

  /* ================================================================ 状态灯 */
  async function refreshStatus() {
    try {
      const st = await U.api('/api/status');
      const o = (st && st.ollama) || {};
      mark('#st-ollama', o.running !== false, o.chatModel || 'Ollama');
      mark('#st-tts', !!(st && (st.tts && st.tts.ready || st.ttsReady)), 'TTS');
      const amap = (st && (st.amapConfigured !== undefined ? st.amapConfigured : (st.amap && st.amap.configured)));
      mark('#st-amap', amap !== false, '高德');
      const m = $('#s-about-model');
      if (m) m.textContent = '模型：' + (o.chatModel || '未检测到') + '（' + (o.running ? '已连接' : '未运行') + '）';
    } catch {
      mark('#st-ollama', false, 'Ollama');
      mark('#st-tts', false, 'TTS');
      mark('#st-amap', false, '高德');
    }
    const n = $('#s-about-net');
    if (n) n.textContent = '地址：' + location.host;
  }
  function mark(sel, ok, label) {
    const el = $(sel);
    if (!el) return;
    el.classList.toggle('ok', !!ok);
    el.classList.toggle('bad', !ok);
    // 保留原来的文字（Ollama/TTS/高德），状态只用圆点表达
    void label;
  }

  /* ================================================================ 词云 */
  async function loadWordCloud() {
    try {
      const cap = await U.api('/api/capabilities');
      state.cardName = (cap && cap.cards && cap.cards[0] && cap.cards[0].name) || '小文';
      state.wcWords = (cap && cap.wordCloud) || [];
      renderWordCloud();
      const nm = $('#tb-agent'); if (nm) nm.textContent = agentName();
      const ca = $('#chat-agent'); if (ca) ca.textContent = agentName();
    } catch { /* 词云拿不到不影响其它功能 */ }
  }

  function renderWordCloud() {
    const box = $('#wc-words');
    if (!box) return;
    if (!state.wcWords.length) {
      box.innerHTML = '<div class="hint">词云没加载出来（后端 /api/capabilities 没返回内容）。直接在下面对话框说一句也行。</div>';
      return;
    }
    box.innerHTML = '';
    for (const w of state.wcWords) {
      const label = typeof w === 'string' ? w : (w.word || '');
      if (!label) continue;
      const b = document.createElement('button');
      b.className = 'wc-w';
      b.type = 'button';
      b.textContent = label;
      b.dataset.word = label;
      b.dataset.payload = JSON.stringify((w && w.payload) || null);
      if (state.wcSel.has(label)) b.classList.add('on');
      box.appendChild(b);
    }
  }

  function openWc(on) {
    document.body.classList.toggle('wc-open', on !== false);
    const l = $('#wc-layer');
    if (l) l.setAttribute('aria-hidden', on === false ? 'true' : 'false');
  }
  $('#wc-pill') && $('#wc-pill').addEventListener('click', () => openWc(!document.body.classList.contains('wc-open')));
  $('#wc-close') && $('#wc-close').addEventListener('click', () => openWc(false));
  $('#wc-words') && $('#wc-words').addEventListener('click', (e) => {
    const b = e.target.closest('.wc-w');
    if (!b) return;
    const w = b.dataset.word;
    if (state.wcSel.has(w)) state.wcSel.delete(w); else state.wcSel.add(w);
    b.classList.toggle('on', state.wcSel.has(w));
    applyWcToForm();
  });
  $('#wc-clear') && $('#wc-clear').addEventListener('click', () => {
    state.wcSel.clear();
    $$('.wc-w').forEach(b => b.classList.remove('on'));
    applyWcToForm();
  });
  $('#wc-go') && $('#wc-go').addEventListener('click', () => {
    openWc(false);
    switchPane('work');
    generate();
  });

  /** 把词云点选映射到表单字段（点选是"条件"，最终仍走同一套 /api/plan）。 */
  function applyWcToForm() {
    const map = {
      '游玩天数': '#f-days', '目的地': '#f-destination', '出发地': '#f-origin',
      '总预算': '#f-budget', '同行人数': '#f-adults',
    };
    for (const w of state.wcSel) {
      // 形如「游玩天数 2天」的，取数字填进去
      const m = w.match(/^(游玩天数|同行人数)\s*(\d+)/);
      if (m && map[m[1]]) { const el = $(map[m[1]]); if (el) el.value = m[2]; continue; }
      for (const k of Object.keys(map)) {
        if (w.indexOf(k) === 0 && w.length > k.length) {
          const el = $(map[k]);
          if (el) el.value = w.slice(k.length).trim();
        }
      }
    }
    saveForm();
  }

  /* ================================================================ 表单 */
  const seg = { pace: '悠闲', priority: '玩', transportation: '高铁', prefs: [], diet: [] };

  function readForm() {
    const num = (id, d) => { const v = parseInt(($(id) || {}).value, 10); return Number.isFinite(v) ? v : d; };
    const txt = (id) => (($(id) || {}).value || '').trim();
    return {
      destination: txt('#f-destination'),
      origin: txt('#f-origin'),
      duration_days: num('#f-days', 2),
      start_date: txt('#f-date'),
      departure_time: txt('#f-depart'),
      return_hotel_time: txt('#f-return'),
      travelers: { adults: num('#f-adults', 1), children: num('#f-children', 0), elderly: num('#f-elderly', 0) },
      has_pet: !!($('#f-pet') || {}).checked,
      preferences: seg.prefs.slice(),
      must_visit: txt('#f-must').split(/[,，、\s]+/).filter(Boolean),
      pace: seg.pace,
      priority: seg.priority,
      budget: num('#f-budget', 3000),
      transportation: seg.transportation,
      dietary_restrictions: seg.diet.slice(),
      avoidances: txt('#f-avoid').split(/[,，、\s]+/).filter(Boolean),
    };
  }
  function saveForm() { save(LS.form, readForm()); }
  function restoreForm() {
    const f = load(LS.form, null);
    if (!f) return;
    const setv = (id, v) => { const el = $(id); if (el && v != null && v !== '') el.value = v; };
    setv('#f-destination', f.destination); setv('#f-origin', f.origin);
    setv('#f-days', f.duration_days); setv('#f-date', f.start_date);
    setv('#f-depart', f.departure_time); setv('#f-return', f.return_hotel_time);
    setv('#f-budget', f.budget); setv('#f-must', (f.must_visit || []).join(', '));
    setv('#f-avoid', (f.avoidances || []).join(', '));
    const t = f.travelers || {};
    setv('#f-adults', t.adults); setv('#f-children', t.children); setv('#f-elderly', t.elderly);
    const pet = $('#f-pet'); if (pet) pet.checked = !!f.has_pet;
    seg.pace = f.pace || '悠闲'; seg.priority = f.priority || '玩';
    seg.transportation = f.transportation || '高铁';
    seg.prefs = f.preferences || []; seg.diet = f.dietary_restrictions || [];
    syncSeg();
  }
  function syncSeg() {
    $$('#f-pace .seg-b').forEach(b => b.classList.toggle('active', b.dataset.v === seg.pace));
    $$('#f-priority .seg-b').forEach(b => b.classList.toggle('active', b.dataset.v === seg.priority));
    $$('#f-trans .seg-b').forEach(b => b.classList.toggle('active', b.dataset.v === seg.transportation));
    $$('#f-prefs .chip').forEach(b => b.classList.toggle('on', seg.prefs.indexOf(b.dataset.v) >= 0));
    $$('#f-diet .chip').forEach(b => b.classList.toggle('on', seg.diet.indexOf(b.dataset.v) >= 0));
  }

  async function generate() {
    const f = readForm();
    if (!f.destination) {
      toast('先填目的地', 'err');
      switchPane('work');
      const d = $('#f-destination'); if (d) d.focus();
      return;
    }
    const btn = $('#btn-generate');
    if (btn) { btn.disabled = true; btn.textContent = '正在生成…'; }
    try {
      const res = await fetch('/api/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preference: f }),
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(txt.slice(0, 160) || ('HTTP ' + res.status));
      state.plan = JSON.parse(txt);
      save(LS.plan, state.plan);
      renderPlan();
      // 生成完 → 舞台浮层先给一眼，Dock 也切到「结果」
      showResultCard();
      switchPane('result');
      toast('方案已生成', 'ok');
    } catch (e) {
      toast('生成失败：' + (e && e.message ? e.message : e), 'err', 5000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '生成我的旅行规划'; }
    }
  }

  /* ================================================================ 方案渲染 */
  function planToHtml(p) {
    if (!p) return '';
    const bb = p.budget_breakdown || {};
    const money = (n) => (Number(n) || 0).toFixed(0);
    let h = '<h2>' + (p.summary || '出行方案') + '</h2>';
    h += '<p>总预算 <b>¥' + money(p.total_budget_estimate) + '</b>'
      + (p.user_budget ? '　你的预算 ¥' + money(p.user_budget) : '')
      + (p.travelers ? '　' + p.travelers + ' 人' : '') + '</p>';
    h += '<p>交通 ¥' + money(bb.transport) + '　餐饮 ¥' + money(bb.dining)
      + '　住宿 ¥' + money(bb.hotel) + '　门票 ¥' + money(bb.tickets) + '</p>';

    for (const w of (p.warnings || [])) h += '<p>⚠️ ' + w + '</p>';

    (p.daily_plans || []).forEach((d, i) => {
      const w = d.weather || {};
      const wt = [w.condition, w.temp].filter(Boolean).join(' ');
      h += '<h3>Day ' + (i + 1) + '　' + (d.date || '') + (wt ? '　' + wt : '') + '</h3>';
      h += '<table><thead><tr><th>时间</th><th>安排</th><th>交通接驳</th></tr></thead><tbody>';
      for (const it of (d.timeline || [])) {
        const poi = it.poi || {};
        const t = it.transport_to_next;
        h += '<tr><td>' + (it.time || '') + '</td><td>' + (poi.name || '')
          + (poi.description ? '<br><small>' + poi.description + '</small>' : '')
          + (it.tips ? '<br><small>' + it.tips + '</small>' : '') + '</td>'
          + '<td>' + (t && t.mode ? t.mode + ' ' + (t.duration || '') + (t.cost ? ' ¥' + t.cost : '') : '—') + '</td></tr>';
      }
      h += '</tbody></table>';
      if (d.hotel && d.hotel.name) h += '<p>当晚住宿：<b>' + d.hotel.name + '</b>'
        + (d.hotel.description ? '　' + d.hotel.description : '') + '</p>';
    });

    const opt = (title, arr, n) => {
      if (!Array.isArray(arr) || !arr.length) return '';
      let s = '<h3>' + title + '（' + arr.length + ' 个备选）</h3><ul>';
      for (const o of arr.slice(0, n)) {
        s += '<li>' + (o.name || '') + (o.price ? '　¥' + o.price : '')
          + (o.tips ? '　<small>' + o.tips + '</small>' : '') + '</li>';
      }
      return s + '</ul>';
    };
    h += opt('换个景点', p.attraction_options, 10);
    h += opt('换个餐厅', p.dining_options, 8);
    h += opt('换个住处', p.hotel_options, 8);
    return h;
  }

  function renderPlan() {
    const html = state.plan ? planToHtml(state.plan) : '<div class="empty">还没有方案</div>';
    const dockBody = $('#result-body');
    if (dockBody) dockBody.innerHTML = html;
    const rcBody = $('#rc-body');
    if (rcBody) rcBody.innerHTML = html;
    const sub = $('#result-sub');
    if (sub) sub.textContent = state.plan ? (state.plan.summary || '方案已生成') : '还没有方案 —— 去「工作台」填一下偏好。';
    const rcTitle = $('#rc-title');
    if (rcTitle && state.plan) rcTitle.textContent = state.plan.summary || '方案';
  }

  /* 结果卡浮层：图纸「舞台中央 720px，可关闭、可移入 Dock」 */
  function showResultCard() {
    const c = $('#result-card');
    if (c) c.hidden = false;
  }
  function hideResultCard() {
    const c = $('#result-card');
    if (c) c.hidden = true;
  }
  $('#rc-close') && $('#rc-close').addEventListener('click', hideResultCard);
  $('#rc-to-dock') && $('#rc-to-dock').addEventListener('click', () => {
    hideResultCard();
    switchPane('result');
  });

  /* ================================================================ 对话 */
  function bubble(role, content, typing) {
    const me = role === 'user';
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (me ? 'me' : 'bot');
    wrap.innerHTML = '<div class="ava">' + (me ? '我' : agentName().slice(0, 1)) + '</div>'
      + '<div class="bub">' + (typing ? '<span class="typing"><i></i><i></i><i></i></span>' : md(content)) + '</div>';
    return { wrap, bub: wrap.querySelector('.bub') };
  }
  function renderChat() {
    const log = $('#chat-log');
    if (!log) return;
    log.innerHTML = '';
    if (!state.chat.length) {
      log.innerHTML = '<div class="hint">可以直接问我：杭州有什么好玩的？带孩子去成都怎么安排？'
        + '<br>也可以去「工作台」填偏好，或在下面输入框说一句。</div>';
      return;
    }
    for (const m of state.chat) log.appendChild(bubble(m.role, m.content).wrap);
    log.scrollTop = log.scrollHeight;
  }

  async function send(text) {
    const inp = $('#c-input');
    const v = (text != null ? text : (inp ? inp.value : '')).trim();
    if (!v) return;
    if (state.busy) { try { state.stream && state.stream.abort(); } catch { } return; }
    if (inp) { inp.value = ''; autoGrow(); syncSend(); }

    state.chat.push({ role: 'user', content: v });
    save(LS.chat, state.chat.slice(-60));
    switchPane('chat');
    const log = $('#chat-log');
    if (log && log.querySelector('.hint')) log.innerHTML = '';
    if (log) { log.appendChild(bubble('user', v).wrap); log.scrollTop = log.scrollHeight; }

    state.busy = true; syncSend();
    const a = bubble('assistant', '', true);
    if (log) { log.appendChild(a.wrap); log.scrollTop = log.scrollHeight; }

    let acc = '';
    if (!U.sse) { a.bub.textContent = '（对话组件未加载）'; state.busy = false; syncSend(); return; }
    const st = U.sse('/api/agent', { message: v, history: state.chat.slice(-12) }, (ev) => {
      if (!ev || !ev.type) return;
      if (ev.type === 'delta' && ev.text) {
        acc += ev.text; a.bub.innerHTML = md(acc);
        if (log) log.scrollTop = log.scrollHeight;
      } else if (ev.type === 'notice' && ev.text) {
        if (!acc) a.bub.innerHTML = '<span style="opacity:.6">' + ev.text + '</span>';
      } else if (ev.type === 'error') {
        a.bub.innerHTML = md(acc ? acc + '\n\n⚠️ ' + (ev.error || '失败') : '⚠️ ' + (ev.error || '失败'));
      }
    });
    state.stream = st;
    try { await st.promise; }
    catch (e) { if (!(e && e.name === 'AbortError')) a.bub.innerHTML = md(acc || '⚠️ 请求失败'); }
    finally {
      state.stream = null; state.busy = false; syncSend();
      const t = acc.trim();
      if (t) {
        state.chat.push({ role: 'assistant', content: t });
        save(LS.chat, state.chat.slice(-60));
        if (state.speaking) speak(t);
        // 后端在"规划模式"下会返回结构化方案 —— 这时把它抓回来渲染
        if (/Day\s*\d|行程总览|预算：约|个性化方案/.test(t)) fetchLatestPlan();
      } else a.wrap.remove();
    }
  }

  async function fetchLatestPlan() {
    try {
      const list = await U.api('/api/plans');
      if (!Array.isArray(list) || !list.length) return;
      const p = await U.api('/api/plans/' + encodeURIComponent(list[0].plan_id));
      state.plan = p; save(LS.plan, p);
      renderPlan(); showResultCard();
      const dot = $('#fold-ico');
      void dot;
    } catch { /* 取不到就算了，不影响对话 */ }
  }

  function autoGrow() {
    const i = $('#c-input');
    if (!i) return;
    i.style.height = 'auto';
    i.style.height = Math.min(i.scrollHeight, 108) + 'px';
  }
  function syncSend() {
    const i = $('#c-input'), b = $('#c-send');
    if (!i || !b) return;
    b.disabled = !i.value.trim() && !state.busy;
  }

  /* ================================================================ 朗读 */
  async function speak(text) {
    try {
      const r = await fetch('/api/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: String(text).slice(0, 400) }),
      });
      if (!r.ok) return;
      const blob = await r.blob();
      new Audio(URL.createObjectURL(blob)).play().catch(() => { });
    } catch { /* 没配 TTS 就静默跳过 */ }
  }

  /* ================================================================ 人物 */
  const RUNTIME = [
    '/vendor/live2dcubismcore.min.js',
    '/vendor/pixi.min.js',
    '/vendor/pixi-live2d-display-cubism4.min.js',
    '/js/live2d.js',
  ];
  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector('script[src="' + src + '"]')) return res();
      const s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = () => res(); s.onerror = () => rej(new Error('加载失败: ' + src));
      document.head.appendChild(s);
    });
  }
  async function enableAvatar() {
    const hint = $('#avatar-hint');
    if (hint) hint.textContent = '正在加载运行时与形象…';
    try {
      for (const s of RUNTIME) await loadScript(s);
      if (!window.Live2DStage) throw new Error('运行时没起来');
      if (!state.stage) {
        state.stage = new window.Live2DStage($('#live2d-canvas'));
        await state.stage.init();
      }
      const cap = await U.api('/api/capabilities');
      const list = (cap && cap.live2d) || [];
      const pick = list[0];
      if (!pick) throw new Error('后端没有可用的 Live2D 形象');
      await state.stage.load(pick.entry, { label: pick.label, focusFollow: true });
      try { state.stage.startIdle({ motionEveryMs: 14000 }); } catch { }
      state.stage.setScale(Number($('#s-scale') ? $('#s-scale').value : 100) / 100);
      document.body.classList.add('avatar-on');
      state.avatarOn = true;
      save(LS.avatar, true);
      if (hint) hint.textContent = '形象已开启：' + pick.label;
    } catch (e) {
      document.body.classList.remove('avatar-on');
      state.avatarOn = false;
      if (hint) hint.textContent = '开启失败：' + (e && e.message ? e.message : e);
      toast('人物开启失败', 'err');
    }
    const sw = $('#s-avatar'); if (sw) sw.checked = state.avatarOn;
    const tb = $('#btn-avatar'); if (tb) tb.classList.toggle('on', state.avatarOn);
    resizeStage();
  }
  function disableAvatar() {
    document.body.classList.remove('avatar-on');
    state.avatarOn = false;
    save(LS.avatar, false);
    const hint = $('#avatar-hint'); if (hint) hint.textContent = '已关闭，回到纯色界面。';
    const sw = $('#s-avatar'); if (sw) sw.checked = false;
    const tb = $('#btn-avatar'); if (tb) tb.classList.remove('on');
  }

  /* ================================================================ 舞台背景 */
  /* 纯色底 + 极轻的程序化光斑：不加载任何外部素材（图纸不要求背景图）。 */
  function drawBg() {
    const cv = $('#bg-canvas');
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (w < 2 || h < 2) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    // 两团很淡的青绿光斑，给舞台一点纵深（纯装饰）
    const blob = (x, y, r, a) => {
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, 'rgba(84,200,177,' + a + ')');
      rg.addColorStop(1, 'rgba(84,200,177,0)');
      g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    };
    blob(w * 0.28, h * 0.30, Math.min(w, h) * 0.52, 0.10);
    blob(w * 0.78, h * 0.68, Math.min(w, h) * 0.44, 0.07);
  }
  function resizeStage() {
    drawBg();
    try { if (state.stage && state.stage.resize) state.stage.resize(); } catch { }
  }

  /* ================================================================ 设置 */
  function applyBg(hex) {
    if (!hex) return;
    document.documentElement.style.setProperty('--bg', hex);
    const n = parseInt(hex.replace('#', ''), 16);
    const lum = ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
    document.body.classList.toggle('light', lum > 165);
    $$('.sw-c').forEach(b => b.classList.toggle('on', b.dataset.bg === hex));
    save(LS.bg, hex);
    drawBg();
  }
  $('#s-palette') && $('#s-palette').addEventListener('click', (e) => {
    const b = e.target.closest('.sw-c');
    if (b) applyBg(b.dataset.bg);
  });

  /* ================================================================ 绑定 */
  function bind() {
    // 工具
    const kb = $('#btn-kiosk');
    if (kb) kb.addEventListener('click', () => {
      document.body.classList.toggle('kiosk');
      kb.classList.toggle('on', document.body.classList.contains('kiosk'));
      setTimeout(resizeStage, 260);
    });
    const sb = $('#btn-settings');
    if (sb) sb.addEventListener('click', () => switchPane('setting'));
    const ab = $('#btn-avatar');
    if (ab) ab.addEventListener('click', () => { if (state.avatarOn) disableAvatar(); else enableAvatar(); });
    $$('[data-tool="cloud"]').forEach(b => b.addEventListener('click', () => openWc(!document.body.classList.contains('wc-open'))));

    // 静音：只用 <audio>/<video> 的 muted 属性表达，不引入额外状态
    const mb = $('#btn-mute');
    if (mb) mb.addEventListener('click', () => {
      state.muted = !state.muted;
      $$('audio, video').forEach(el => { el.muted = state.muted; });
      const t = $('#mute-txt'); if (t) t.textContent = state.muted ? '静音' : '有声';
      mb.classList.toggle('on', !state.muted);
      save('wenlv.app.muted', state.muted);
    });

    // 表单
    const segBind = (sel, key) => {
      const box = $(sel);
      if (!box) return;
      box.addEventListener('click', (e) => {
        const b = e.target.closest('.seg-b');
        if (!b) return;
        seg[key] = b.dataset.v; syncSeg(); saveForm();
      });
    };
    segBind('#f-pace', 'pace'); segBind('#f-priority', 'priority'); segBind('#f-trans', 'transportation');
    const chipBind = (sel, key) => {
      const box = $(sel);
      if (!box) return;
      box.addEventListener('click', (e) => {
        const b = e.target.closest('.chip');
        if (!b) return;
        const v = b.dataset.v, arr = seg[key];
        const i = arr.indexOf(v);
        if (i >= 0) arr.splice(i, 1); else arr.push(v);
        syncSeg(); saveForm();
      });
    };
    chipBind('#f-prefs', 'prefs'); chipBind('#f-diet', 'diet');
    ['#f-destination', '#f-origin', '#f-days', '#f-date', '#f-depart', '#f-return',
      '#f-budget', '#f-must', '#f-avoid', '#f-adults', '#f-children', '#f-elderly']
      .forEach(s => { const el = $(s); if (el) el.addEventListener('input', saveForm); });
    const pet = $('#f-pet'); if (pet) pet.addEventListener('change', saveForm);
    $('#btn-generate') && $('#btn-generate').addEventListener('click', generate);

    // 输入条
    const ci = $('#c-input');
    if (ci) {
      ci.addEventListener('input', () => { autoGrow(); syncSend(); });
      ci.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      });
    }
    $('#c-send') && $('#c-send').addEventListener('click', () => send());
    $('#chat-clear') && $('#chat-clear').addEventListener('click', () => {
      state.chat.length = 0; save(LS.chat, []); renderChat();
    });

    // 设置页开关
    const av = $('#s-avatar');
    if (av) av.addEventListener('change', () => { if (av.checked) enableAvatar(); else disableAvatar(); });
    const sp = $('#s-speak');
    if (sp) sp.addEventListener('change', () => {
      state.speaking = sp.checked; save(LS.speak, sp.checked);
    });
    const sc = $('#s-scale');
    if (sc) sc.addEventListener('input', () => {
      const v = Number(sc.value) / 100;
      const lab = $('#scale-val'); if (lab) lab.textContent = sc.value + '%';
      save(LS.scale, Number(sc.value));
      try { if (state.stage && state.stage.setScale) state.stage.setScale(v); } catch { }
    });

    // 快捷键：Esc 关词云 / 结果卡；⌘/Ctrl+Enter 发送
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (document.body.classList.contains('wc-open')) { openWc(false); return; }
        if ($('#result-card') && !$('#result-card').hidden) { hideResultCard(); return; }
        if (document.body.classList.contains('kiosk')) document.body.classList.remove('kiosk');
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send();
    });

    window.addEventListener('resize', () => {
      clearTimeout(bind._t);
      bind._t = setTimeout(resizeStage, 180);
    });
  }

  /* ================================================================ 启动 */
  function init() {
    state.chat = load(LS.chat, []) || [];
    state.speaking = load(LS.speak, false) === true;
    state.muted = load('wenlv.app.muted', true) === true;

    bind();
    setCols(load(LS.cols, 'open'));
    switchPane(load('wenlv.app.pane', 'work'));
    restoreForm();
    syncSeg();
    renderChat();
    renderPlan();
    autoGrow();
    syncSend();

    applyBg(load(LS.bg, '#0f1419'));
    const sc = $('#s-scale');
    if (sc) { const v = load(LS.scale, 100); sc.value = v; const lab = $('#scale-val'); if (lab) lab.textContent = v + '%'; }
    const sp = $('#s-speak'); if (sp) sp.checked = state.speaking;
    const mb = $('#btn-mute');
    if (mb) { mb.classList.toggle('on', !state.muted); const t = $('#mute-txt'); if (t) t.textContent = state.muted ? '静音' : '有声'; }

    // 人物：默认**关闭**（图纸「是否启用人物」的默认态）
    if (load(LS.avatar, false) === true) enableAvatar();

    resizeStage();
    refreshStatus();
    loadWordCloud();
    setInterval(refreshStatus, 30000);

    window.__app = { state, send, generate, switchPane, setCols, openWc, enableAvatar, disableAvatar, applyBg, renderPlan };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
