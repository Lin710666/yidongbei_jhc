/* ============================================================================
 * app.js —— 文旅智能辅助 · AIRI 网页版 主程序
 *
 * 职责：把「Live2D 舞台 + 交互词云 + 右侧面板」和「本地服务」接起来。
 * 所有数据来自本机：/api/status、/api/capabilities、/api/chat(SSE)、
 * /api/wenlv/generate(SSE)、/api/memory*、/api/cards*、/api/tts、/api/vision。
 * ==========================================================================*/
(function () {
  'use strict';

  const { $, $$, el, toast, renderMarkdown, api, sse, download, fmtTime, escapeHtml, downscaleImage } = window.U;

  const LS_SETTINGS = 'wenlv-airi/settings';
  const LS_HISTORY = 'wenlv-airi/history';

  // ===== 全局状态 =====
  const S = {
    caps: null,
    status: null,
    cards: [],
    card: null,
    voices: [],
    speakers: [],
    myVoices: [],
    l2dModels: [],
    models3d: { bundled: [], custom: [], formats: {} },
    backgrounds: { bundled: [], procedural: [], custom: [] },
    history: [],
    visionImage: null,           // 当前附带的图片（dataURL）
    cameraStream: null,
    busy: false,
    currentStream: null,
    lastResult: '',
    // 当前展示的人物形象。kind 决定用哪套渲染器：
    //   'live2d' -> Live2DStage（PixiJS + Cubism）
    //   '3d'     -> ThreeDStage（three.js + three-vrm，按需懒加载）
    display: { kind: 'live2d', id: 'nahida' },
    settings: {
      autospeak: false,
      memory: true,
      vision: true,
      wcEnabled: true,
      wcGlow: true,
      wcDensity: 2,
      // 词云字色：auto=按背景亮度自动切，light=浅色字（深背景），dark=深色字（浅背景）。
      // 背景是可换的，其中「浅色纸张」那类亮背景如果还配浅色字，词就直接看不见了。
      wcInk: 'auto',
      l2dScale: 1,
      l2dX: 0,
      l2dY: 0,
      expression: '',
      backgroundId: 'proc-aurora',   // 默认跟随主题的极光渐变
    },
  };

  // 舞台上的浮动元素高度会作为词云的安全边距，避免互相遮挡。
  // 这里是兜底值，实际高度在 setCloudInsets() 里量出来覆盖。
  S.settings.wcInsets = { top: 58, right: 14, bottom: 58, left: 14 };

  let stage = null;        // Live2DStage 实例（用到才创建）
  let stage3d = null;      // ThreeDStage 实例（选了 3D 形象才懒加载）
  let cloud = null;
  let bg = null;

  // ===== 设置持久化 =====
  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
      Object.assign(S.settings, raw || {});
    } catch { /* 坏数据就用默认值 */ }
  }
  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(S.settings)); } catch { /* 配额满了就放弃 */ }
  }
  function loadHistory() {
    try {
      S.history = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]');
      if (!Array.isArray(S.history)) S.history = [];
    } catch { S.history = []; }
  }
  function saveHistory() {
    // 只留最近 60 条，避免 localStorage 无限膨胀
    S.history = S.history.slice(-60);
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(S.history)); } catch { /* 忽略 */ }
  }

  /* ========================================================================
   * 一、启动
   * ======================================================================*/
  async function boot() {
    loadSettings();
    loadHistory();
    applySettingsToUI();
    bindTabs();
    bindTopbar();
    bindComposer();
    bindTools();
    bindMemory();
    bindCards();
    bindVoice();
    bindLook();
    bindStage();

    cloud = new window.WordCloud($('#wordcloud-layer'), { onAction: handleWordAction });
    cloud.setAnimate(S.settings.wcGlow);
    cloud.setDensity(S.settings.wcDensity);
    cloud.setInsets(S.settings.wcInsets);
    $('#wordcloud-layer').style.display = S.settings.wcEnabled ? '' : 'none';

    // 背景管理器：图片与程序化背景都由它渲染。放在词云之后创建，
    // 这样它就是最早的一层，后面所有东西都叠在背景之上。
    bg = new window.BackgroundManager({ imageEl: $('#bg-image'), canvasEl: $('#bg-canvas') });
    bg.resize();

    await refreshStatus();
    await loadCapabilities();

    // 背景要在拿到能力清单之后再恢复：那张清单里才有 palette 等信息
    applyBackground(S.settings.backgroundId, { silent: true });

    initStage();
    renderHistory();
    if (!S.history.length) {
      // 首次进入：让角色主动打个招呼，而不是空白一片
      setTimeout(() => say(S.card ? S.card.greeting : '你好，我是你的文旅向导。', true), 900);
    }
  }

  /* ========================================================================
   * 二、服务状态
   * ======================================================================*/
  function setPill(sel, kind, text) {
    const pill = $(sel);
    if (!pill) return;
    const dot = pill.querySelector('.dot');
    dot.className = `dot ${kind}`;
    pill.querySelector('.lbl').textContent = text;
  }

  async function refreshStatus() {
    try {
      const st = await api('/api/status');
      S.status = st;
      applyStatusToUI();
      return st;
    } catch (e) {
      setPill('#pill-model', 'err', '服务未启动');
      toast(`无法连接本地服务：${e.message}`, 'err', 5000);
      return null;
    }
  }

  function applyStatusToUI() {
    const st = S.status;
    if (!st) return;
    const o = st.ollama || {};
    if (!o.running) setPill('#pill-model', 'err', 'Ollama 未运行');
    else if (!o.chatModel) setPill('#pill-model', 'warn', '无对话模型');
    else setPill('#pill-model', 'ok', o.chatModel);

    const mem = st.memory || {};
    setPill('#pill-memory', mem.total ? 'ok' : 'warn', `记忆 ${mem.total || 0}`);

    const t = st.tts || {};
    setPill('#pill-voice', t.running ? 'ok' : 'warn', t.running ? '语音就绪' : '语音未连');

    setPill('#pill-vision', o.visionModel ? 'ok' : 'warn', o.visionModel || '无视觉模型');

    // 设置页的服务明细
    const box = $('#settings-services');
    if (box) {
      box.innerHTML = '';
      const rows = [
        ['对话模型', o.chatModel || '未检测到', o.chatModel ? 'ok' : 'err'],
        ['视觉模型', o.visionModel || '未安装（ollama pull qwen2.5vl:7b）', o.visionModel ? 'ok' : 'warn'],
        ['向量模型', o.embedModel || '未安装（记忆将用纯词法检索）', o.embedModel ? 'ok' : 'warn'],
        ['Ollama 地址', o.url || '—', o.running ? 'ok' : 'err'],
        ['语音合成', t.running ? `${t.url}（${(t.models || []).length} 个模型）` : '未连接 Qwen TTS', t.running ? 'ok' : 'warn'],
        ['记忆模式', mem.mode || '—', 'ok'],
        ['记忆条数', `${mem.total || 0} 条（含向量 ${mem.withEmbedding || 0} 条）`, 'ok'],
        ['样本库实体', `${(st.wenlv && st.wenlv.entityCount) || 0} 条`, 'ok'],
        ['数据目录', st.dataDir || '—', 'ok'],
      ];
      for (const [k, v, k2] of rows) {
        box.appendChild(el('div', { class: 'mem-item' }, [
          el('div', { class: 'txt' }, [
            el('div', { text: k, style: { fontWeight: '600' } }),
            el('div', { class: 'meta', text: String(v) }),
          ]),
          el('i', { class: `dot ${k2}`, style: { marginTop: '6px' } }),
        ]));
      }
    }

    // 语音面板徽标
    const vb = $('#voice-badges');
    if (vb) {
      vb.innerHTML = '';
      vb.appendChild(el('span', { class: 'mini', html: `<i class="dot ${t.running ? 'ok' : 'err'}"></i> ${t.running ? 'Qwen TTS 已连接' : 'Qwen TTS 未连接'}` }));
      if (t.running) vb.appendChild(el('span', { class: 'mini', text: `${(t.models || []).length} 个可用模型` }));
      if (t.url) vb.appendChild(el('span', { class: 'mini', text: t.url }));
    }

    // 记忆面板徽标
    const mb = $('#memory-badges');
    if (mb) {
      mb.innerHTML = '';
      mb.appendChild(el('span', { class: 'mini', text: `共 ${mem.total || 0} 条` }));
      mb.appendChild(el('span', { class: 'mini', text: `检索：${mem.mode || '—'}` }));
    }

    // 对话页徽标
    const cb = $('#chat-badges');
    if (cb) {
      cb.innerHTML = '';
      cb.appendChild(el('span', { class: 'mini', html: '<i class="dot ok"></i> 本地推理' }));
      cb.appendChild(el('span', { class: 'mini', text: o.chatModel || '—' }));
      if (o.visionModel) cb.appendChild(el('span', { class: 'mini', text: `视觉 ${o.visionModel}` }));
      if (mem.enabled) cb.appendChild(el('span', { class: 'mini', text: `记忆 ${mem.total || 0}` }));
    }
  }

  /* ========================================================================
   * 三、能力 / 词云 / 表单选项
   * ======================================================================*/
  async function loadCapabilities() {
    const caps = await api('/api/capabilities');
    S.caps = caps;
    S.voices = caps.voices || [];
    S.myVoices = caps.myVoices || [];
    S.l2dModels = caps.live2d || [];
    S.models3d = caps.models3d || { bundled: [], custom: [], formats: {} };
    S.cards = caps.cards || [];
    S.backgrounds = caps.backgrounds || { bundled: [], procedural: [], custom: [] };
    setActiveCard(caps.activeCardId || (S.cards[0] && S.cards[0].id), { silent: true });

    // 内置说话人单独取：它依赖 Qwen TTS 服务在线，失败不影响其它能力加载
    try {
      S.speakers = (await api('/api/tts/speakers')).speakers || [];
    } catch {
      S.speakers = [];
    }

    cloud.setWords(caps.wordCloud || []);
    fillOptions(caps.options);
    $('#city-list-inline').textContent = (caps.cities || []).join('、') || '—';
    renderCityChips(caps.cities || []);
    renderLive2DModels();
    renderVoices();
    renderSpeakers();
    renderMyVoices();
    renderCards();
    renderLookPreview();
  }

  /** 所有可选形象的统一清单：Live2D 与 3D 混在一起，用 kind 区分 */
  function allDisplayModels() {
    return [
      ...(S.l2dModels || []).map(m => ({ ...m, kind: 'live2d' })),
      ...((S.models3d && S.models3d.bundled) || []),
      ...((S.models3d && S.models3d.custom) || []),
    ];
  }

  function findDisplayModel(kind, id) {
    return allDisplayModels().find(m => m.kind === kind && m.id === id) || null;
  }

  /** 用 OPTIONS 渲染 chip 组：词云和表单共用同一份常量，永远对得上 */
  function fillOptions(options) {
    const defaults = (S.caps && S.caps.defaults) || {};
    $$('.row[data-name]').forEach((row) => {
      const name = row.dataset.name;
      const multi = row.dataset.multi === '1';
      const list = (options && options[name]) || [];
      const preset = [].concat(defaults[name] || []);
      row.innerHTML = '';
      list.forEach((v) => {
        const on = multi ? preset.includes(v) : preset[0] === v;
        const chip = el('button', { class: `chip${on ? ' on' : ''}`, text: v, type: 'button' });
        chip.addEventListener('click', () => {
          if (multi) chip.classList.toggle('on');
          else {
            $$('.chip', row).forEach(c => c.classList.remove('on'));
            chip.classList.add('on');
          }
        });
        row.appendChild(chip);
      });
    });
  }

  function renderCityChips(cities) {
    const box = $('#city-chips');
    if (!box) return;
    box.innerHTML = '';
    cities.forEach((c, i) => {
      const chip = el('button', { class: `chip${i === 0 ? ' on' : ''}`, text: c, type: 'button' });
      chip.addEventListener('click', () => {
        $$('.chip', box).forEach(x => x.classList.remove('on'));
        chip.classList.add('on');
        $('#plan-city').value = c;
      });
      box.appendChild(chip);
    });
  }

  const chipVal = (name) => {
    const on = $(`.row[data-name="${name}"] .chip.on`);
    return on ? on.textContent.trim() : '';
  };
  const chipVals = (name) => $$(`.row[data-name="${name}"] .chip.on`).map(c => c.textContent.trim());

  function collectPlanParams(overrides) {
    return Object.assign({
      city: $('#plan-city').value.trim() || '杭州',
      days: Number($('#plan-days').value) || 2,
      budget: chipVal('budget') || '舒适',
      crowd: chipVal('crowd') || '朋友',
      interests: chipVals('interests').length ? chipVals('interests') : ['自然风光'],
      diet: chipVal('diet') || '无',
    }, overrides || {});
  }
  function collectMarketingParams(overrides) {
    return Object.assign({
      product: chipVal('product') || '景区',
      platform: chipVal('platform') || '小红书',
      audience: chipVal('audience') || '年轻情侣',
      style: chipVal('style') || '种草',
    }, overrides || {});
  }

  /**
   * 让词云上每一组的红框对齐成"实际生效的值"。
   *
   * 一个词条的 payload 可能顺带设了别的字段 —— 例如「避坑提示」带 city:'杭州'、crowd:'带老人'，
   * 点它之后"同行人群"实际变成了带老人，"情侣"就失效了，但它的红框还亮着。
   * 不修的话，屏幕上显示的条件和真正拿去生成的条件会是两回事。
   */
  function alignPicksFromPayload(p) {
    if (!cloud || !p) return;
    const MAP = [
      ['city', '目的地'],
      ['budget', '预算'],
      ['crowd', '同行人群'],
      ['diet', '饮食禁忌'],
      ['product', '营销产品'],
      ['platform', '营销平台'],
      ['style', '文案风格'],
    ];
    for (const [field, group] of MAP) {
      if (p[field] === undefined) continue;
      // 该组里代表这个值的词；找不到就表示这组不该有红框（比如 crowd='朋友' 没有对应词）
      cloud.alignGroup(group, p[field]);
    }
  }

  /**
   * 把词云上已经选中的条件拼成一句话，用于字幕反馈（"杭州 · 舒适 · 亲子"）。
   * 直接从词云的选中集合取，而不是从表单反读 —— 表单里带着一堆默认值（舒适/朋友/自然风光），
   * 反读出来会把用户根本没点过的词也报进去。
   */
  function describePicks() {
    return cloud ? cloud.getSelected().join(' · ') : '';
  }

  /**
   * 把词云点到的参数回填进表单，让用户看到"点了什么、现在是什么状态"。
   *
   * merge=true 时兴趣是**并集**而不是覆盖 —— 点词云是一个个加条件，
   * 如果覆盖，先点「美食」再点「亲子」（它的 payload 顺带带了个 interests:['亲子']），
   * 美食就没了。表单内部的兴趣 chip 本来就是多选，这里保持一致。
   */
  function applyParamsToForm(tab, params, { merge = false } = {}) {
    if (!params) return;
    if (params.city !== undefined) {
      $('#plan-city').value = params.city;
      $$('#city-chips .chip').forEach(c => c.classList.toggle('on', c.textContent.trim() === params.city));
    }
    if (params.days !== undefined) { $('#plan-days').value = params.days; $('#days-label').textContent = params.days; }
    const setChip = (name, value) => {
      if (value === undefined) return;
      $$(`.row[data-name="${name}"] .chip`).forEach(c => c.classList.toggle('on', c.textContent.trim() === value));
    };
    setChip('budget', params.budget);
    setChip('crowd', params.crowd);
    setChip('diet', params.diet);
    if (params.interests) {
      const next = merge ? [...new Set([...chipVals('interests'), ...params.interests])] : params.interests;
      $$('.row[data-name="interests"] .chip').forEach(c => c.classList.toggle('on', next.includes(c.textContent.trim())));
    }
    setChip('product', params.product);
    setChip('platform', params.platform);
    setChip('audience', params.audience);
    setChip('style', params.style);
    if (tab) switchTab(tab);
  }

  /* ========================================================================
   * 四、词云动作分发 —— 点一下真的触发对应效果
   * ======================================================================*/
  async function handleWordAction(w) {
    const a = w.action;
    const p = w.payload || {};
    switch (a) {
      // 点分组标签（目的地 / 行程 / 兴趣 …）：把该组点亮、其余压暗，再点一次取消。
      // 只改透明度、不重排布局，所以词不会乱跳；也不切换面板，演示时可以连点看。
      case 'focus-group': {
        const now = cloud.focusGroup(p.group);
        // 注意用 S.caps 而不是局部变量 caps —— loadCapabilities() 里的 caps 是函数内的局部量，
        // 在这个作用域拿不到（写成 caps 会直接 ReferenceError）。
        const g = ((S.caps && S.caps.wordCloudGroups) || []).find(x => x.name === p.group);
        if (now) {
          say(`${now} —— ${(g && g.desc) || '这一组'}。再点一次「${now}」就收起来。`, true);
        } else {
          say('好，收起来了。', true);
        }
        break;
      }

      case 'panel':
        switchTab(p.tab || 'tools');
        break;

      // 条件词（目的地 / 预算 / 同行人群 / 兴趣 / 营销平台 …）：
      // 只把值填进表单并给它打上红框，**不立刻生成**。
      // 原来点一下就跑，根本没法把「杭州 + 舒适 + 亲子」这种组合凑出来。
      // 想跑的时候点「个性化方案」/「营销文案」。
      case 'pick': {
        // 「兴趣」可以多选（和右侧表单里的兴趣 chip 一致），其余组单选互斥
        const on = cloud.toggleSelect(w.word, { multi: w.group === '兴趣' });
        if (on) {
          // 注意第一个参数传 null（= 不切面板）。
          // 以前传 'tools'，于是每点一个条件词，右侧面板就被强行切走一次；
          // 面板一换会触发重新测量安全边距 → 词云整片重排 ——
          // 用户点完「杭州」想接着点「苏州」，所有词已经跑到别的位置去了，非常难用。
          // 条件填进表单本来就不需要用户盯着看，词云上的红框才是主要反馈；
          // 真要生成时（gen-plan / gen-marketing）再切过去也来得及。
          applyParamsToForm(null, p, { merge: true });
          alignPicksFromPayload(p);
          const picks = describePicks();
          say(picks ? `记下了：${picks}。凑齐了点「个性化方案」我就开工。` : `记下了：${w.word}`, true);
        } else {
          say(`取消：${w.word}`, true);
        }
        break;
      }

      // 用词云上已经选好的条件生成
      case 'gen-plan': {
        say(pickLine('plan', {}), true);
        // 全屏词云模式下走舞台上的结果卡（右栏这时看不见）；非全屏才切到文旅页看结果
        const onCard = openStageResult();
        if (!onCard) switchTab('tools');
        $('#form-plan').hidden = false;
        $('#form-marketing').hidden = true;
        $$('#pane-tools [data-tool]').forEach(c => c.classList.toggle('on', c.dataset.tool === 'plan'));
        // 不传 overrides：参数全部取自表单，也就是词云上点出来的那些条件
        await generate('plan', collectPlanParams());
        break;
      }

      case 'gen-marketing': {
        say(pickLine('marketing', {}), true);
        const onCardM = openStageResult();
        if (!onCardM) switchTab('tools');
        $('#form-plan').hidden = true;
        $('#form-marketing').hidden = false;
        $$('#pane-tools [data-tool]').forEach(c => c.classList.toggle('on', c.dataset.tool === 'marketing'));
        await generate('marketing', collectMarketingParams());
        break;
      }

      // 兼容老词条（词表已经全部换成 pick / gen-*，这里留着以防有自定义角色卡带旧 action）
      case 'plan': {
        applyParamsToForm('tools', p);
        $('#form-plan').hidden = false;
        $('#form-marketing').hidden = true;
        $$('#pane-tools [data-tool]').forEach(c => c.classList.toggle('on', c.dataset.tool === 'plan'));
        say(pickLine('plan', p), true);
        await generate('plan', collectPlanParams(p));
        break;
      }

      case 'marketing': {
        applyParamsToForm('tools', p);
        $('#form-plan').hidden = true;
        $('#form-marketing').hidden = false;
        $$('#pane-tools [data-tool]').forEach(c => c.classList.toggle('on', c.dataset.tool === 'marketing'));
        say(pickLine('marketing', p), true);
        await generate('marketing', collectMarketingParams(p));
        break;
      }

      case 'intake':
        switchTab('tools');
        say('你还没告诉我需求，我先问几个问题吧。', true);
        await generate('intake', {});
        break;

      case 'audit':
        switchTab('tools');
        toast('输出质检会在每次生成后自动运行，结果以黄色告警条显示', 'ok', 4200);
        say('每次生成完我都会拿本地样本库核对一遍，编造出来的商家名字跑不掉。', true);
        break;

      case 'export':
        if (!S.lastResult) { toast('还没有可导出的内容，先生成一次吧', 'err'); break; }
        download(`文旅方案_${new Date().toISOString().slice(0, 10)}.md`, S.lastResult);
        toast('已导出为 Markdown（数据不出本机）', 'ok');
        break;

      case 'focus': {
        switchTab('tools');
        const target = $('#' + p.field);
        if (target) { target.focus(); target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        break;
      }

      case 'remember': {
        const text = await askText('记一条长期记忆', '把要记住的内容写下来，之后对话会自动召回。');
        if (text) {
          try {
            await api('/api/memory', { method: 'POST', body: { text, kind: 'fact' } });
            toast('已存入机体记忆', 'ok');
            await refreshStatus();
            renderMemoryList();
          } catch (e) { toast(`存入失败：${e.message}`, 'err'); }
        }
        break;
      }

      case 'vision':
        switchTab('chat');
        $('#file-input').click();
        break;

      case 'speak': {
        switchTab('chat');
        const last = [...S.history].reverse().find(m => m.role === 'assistant');
        if (!last) { toast('还没有可朗读的内容', 'err'); break; }
        speakText(last.content);
        break;
      }

      case 'expression-cycle': {
        if (!stage || !stage.expressions.length) { toast('当前模型没有表情文件', 'err'); break; }
        const idx = stage.expressions.indexOf(S.settings.expression);
        const next = stage.expressions[(idx + 1) % stage.expressions.length];
        S.settings.expression = next;
        saveSettings();
        await stage.setExpression(next);
        renderExpressions();
        toast(`表情：${next}`, 'ok');
        break;
      }

      case 'greet':
        say(S.card ? S.card.greeting : '你好呀！', true);
        if (stage) stage.playMotion();
        break;

      default:
        toast(`词条「${w.word}」暂未绑定动作`, 'err');
    }
  }

  /** 点词云时角色随口说一句，让"点击"有即时反馈 */
  function pickLine(kind, p) {
    if (kind === 'plan') {
      const city = (p && p.city) || $('#plan-city').value.trim() || '杭州';
      return `${city}的安排交给我，正在翻本地样本库…`;
    }
    if (kind === 'marketing') {
      const plat = (p && p.platform) || chipVal('platform') || '小红书';
      return `${plat}的文案我来写，马上给你两个版本。`;
    }
    return '好，我来处理。';
  }

  /* ========================================================================
   * 五、字幕条与语音
   *
   * 原来角色说话是一个浮在左下角的对话气泡，问题有两个：
   *   ① 它压住词云，点击时经常点不到；
   *   ② 位置不固定，视线要来回找。
   * 现在改成舞台底部的**字幕条**：位置固定、单行、超长省略，
   * 并且它的高度会作为安全边距传给词云，两者永远不重叠。
   * ======================================================================*/
  let subtitleTimer = null;

  /**
   * 字幕的显示/隐藏会改变"底部安全边距"，所以只在**可见性发生变化**时重排词云，
   * 而不是每来一个流式片段就重排一次（那会把布局计算变成每帧都在跑）。
   */
  function setSubtitleVisible(visible) {
    const node = $('#subtitle');
    if (!node) return;
    const was = !node.hidden && node.classList.contains('show');
    if (visible === was) return;
    node.hidden = !visible;
    if (visible) requestAnimationFrame(() => node.classList.add('show'));
    else node.classList.remove('show');
    setTimeout(syncCloudInsets, 380);      // 等过渡结束再量高度，否则量到的是动画中间值
  }

  /** 字幕文本规范化：压平空白，不在 JS 里砍字数——显示几行由 CSS 决定 */
  const subtitleText = (text) => String(text).replace(/\s+/g, ' ').trim();

  /** 内容超过两行时给字幕加"可展开"标记（读 scrollHeight 会触发重排，只在定稿时调一次） */
  function markSubtitleExpandable() {
    const box = $('#subtitle'), t = $('#subtitle-text');
    if (!box || !t) return;
    const over = t.scrollHeight > t.clientHeight + 2;
    t.classList.toggle('can-expand', over);
    t.title = over ? '点一下看完整回复' : '';
    if (!over) box.classList.remove('expanded');
  }

  function say(text, autoHide) {
    if (!text) return;
    const box = $('#subtitle');
    if (box) box.classList.remove('expanded');
    $('#subtitle-who').textContent = S.card ? S.card.name : 'AIRI';
    $('#subtitle-text').classList.remove('typing');
    // 原来这里 slice(0, 400)；字幕条只有两个行位，完整文本交给 CSS 省略，
    // 点一下能展开看全，所以不必在 JS 里先砍一刀。
    $('#subtitle-text').textContent = subtitleText(text);
    setSubtitleVisible(true);
    markSubtitleExpandable();
    clearTimeout(subtitleTimer);
    if (autoHide) subtitleTimer = setTimeout(hideSubtitle, 7000);
  }

  /** 流式说话：字幕随内容增长，末尾带打字光标 */
  function sayStreaming(text) {
    $('#subtitle-who').textContent = S.card ? S.card.name : 'AIRI';
    // 和 say() 用同一份文本、同一套 CSS 规则。
    // 原来是 slice(-200)（显示尾巴），say() 是 slice(0,400)（显示开头），
    // 于是流式一结束字幕会"闪"一下跳回开头——现在两边一致，不会跳了。
    $('#subtitle-text').textContent = subtitleText(text);
    $('#subtitle-text').classList.add('typing');
    setSubtitleVisible(true);
    clearTimeout(subtitleTimer);
  }

  function hideSubtitle() {
    setSubtitleVisible(false);
  }

  /**
   * 全屏词云模式下，把生成结果显示到舞台上的结果卡里。
   *
   * 为什么需要：进了全屏（body.wc-full）之后右侧面板是藏起来的 ——
   * 生成结果再写到 #tools-output 就等于写进了看不见的地方，用户点完「个性化方案」
   * 会觉得"什么都没发生"。这里让词云收起、结果卡浮上来，
   * 左上角挂虚拟导游的名字、右上角放朗读按钮，看起来像一个播报面板。
   *
   * 返回 false 表示当前不是全屏模式，调用方应该走原来的路径（写到右侧面板）。
   */
  function openStageResult() {
    if (!document.body.classList.contains('wc-full')) return false;
    const card = $('#result-card');
    if (!card) return false;
    const who = $('#result-who');
    if (who) who.textContent = (S.card && S.card.name) || 'AI 导览';
    const body = $('#result-body');
    if (body) body.innerHTML = '';
    setResultSpeakState(false);
    card.hidden = false;
    requestAnimationFrame(() => card.classList.add('show'));
    document.body.classList.add('wc-result');
    return true;
  }

  /** 收起结果卡，回到词云 */
  function closeStageResult() {
    document.body.classList.remove('wc-result');
    const audio = $('#tts-audio');
    if (audio) { try { audio.pause(); } catch { /* 没在放就别管 */ } }
    const card = $('#result-card');
    if (!card) return;
    card.classList.remove('show');
    setTimeout(() => { card.hidden = true; }, 300);
    setResultSpeakState(false);
  }

  /** 结果卡右上角那个朗读按钮的状态（合成中禁用 + 点亮 + 换 ⏳） */
  function setResultSpeakState(busy) {
    const btn = $('#result-speak');
    if (!btn) return;
    btn.disabled = !!busy;
    btn.classList.toggle('on', !!busy);
    const ico = btn.querySelector('.ico');
    if (ico) ico.textContent = busy ? '⏳' : '🔊';
  }

  /**
   * 把工具栏与字幕条的尺寸算成词云的安全边距。
   *
   * 字幕条这里**按固定值预留**，而不是去量它当前的实际高度 ——
   * 量实际高度的话，每次说话（字幕条出现 / 消失 / 从一行变两行）都会改 insets，
   * 进而让词云**整片重排、所有词跳位**。用户点完「杭州」正打算点「苏州」，
   * 一说话词就全跑别处去了，那一指头必然点空 —— 这个"点不中"的怪问题就是这么来的。
   * 宁可偶尔让字幕条遮住底部一两个词，也不要让整片词云跳来跳去。
   */
  function syncCloudInsets() {
    if (!cloud) return;
    const st = $('.stage');
    const top = $('.stage-top');
    if (!st) return;
    const topH = top ? top.offsetHeight : 44;
    const insets = {
      top: Math.round(topH + 34),                 // 工具条高度 + 顶部留白
      bottom: 72,                                 // 字幕条常用高度 + 底部留白（固定值，见上面的说明）
      left: 16,
      right: 16,
    };
    cloud.setInsets(insets);
    // 把实际用到的边距同步到 DOM 上：验收脚本据此按**同一套几何**判断遮挡，
    // 否则脚本自己猜一套边距，很容易把"实现对了"判成"错了"。
    const layer = $('#wordcloud-layer');
    if (layer) layer.dataset.insets = JSON.stringify(insets);
  }

  /**
   * 语音合成进度浮层。
   *
   * 本机 TTS 的实时率只有 0.45x 左右（跑出 1 秒音频要 2.2 秒），一段几百字的回复
   * 要花好几分钟。之前界面上只有输入框旁边一句静态的"正在本地合成语音…"，
   * 用户看不出它到底在跑还是卡死了。这里做成一个常驻浮层，
   * 把"已经等了多久"一直显示出来，并对还要多久给个粗略预期。
   */
  function speakProgress(label) {
    const wrap = $('#toasts');
    const node = wrap ? el('div', { class: 'toast speak-progress' }) : null;
    const txt = el('span', {});
    let timer = null;
    let t0 = Date.now();
    if (node) { node.appendChild(txt); wrap.appendChild(node); }

    const paint = (msg) => { if (txt) txt.textContent = msg; };
    const close = (delay) => {
      if (!node) return;
      setTimeout(() => {
        node.style.transition = 'opacity .3s, transform .3s';
        node.style.opacity = '0';
        node.style.transform = 'translateY(10px)';
        setTimeout(() => node.remove(), 320);
      }, delay);
    };

    return {
      /** 开始计时；hint 说明这段文本大概要跑多久，让用户心里有数 */
      start(hint) {
        t0 = Date.now();
        const tick = () => {
          const s = Math.round((Date.now() - t0) / 1000);
          paint(`${label}…已等待 ${s} 秒${hint ? `（${hint}）` : ''}`);
        };
        tick();
        timer = setInterval(tick, 1000);
      },
      /** 改文案但继续计时（例如音频已拿到、正在交给播放器） */
      note(msg) { clearInterval(timer); timer = null; paint(msg); },
      /** 结束：显示结果，停留一会儿再淡出 */
      finish(msg, keepMs) {
        clearInterval(timer);
        timer = null;
        paint(msg);
        close(keepMs === undefined ? 2600 : keepMs);
      },
    };
  }

  /** 调本地 Qwen TTS 出声，并驱动 Live2D 嘴型 */
  async function speakText(text) {
    if (!text || !String(text).trim()) return;
    const audio = $('#tts-audio');
    // 前端与后端都按 600 字封顶：再长会显著拖慢合成，也可能把显存顶爆
    const clipped = String(text).slice(0, 600);
    const truncated = String(text).length > clipped.length;
    const prog = speakProgress('语音正在生成本地音频');
    try {
      // 本地实测大约每字 0.48~0.61 秒（越长越接近上限），取 0.55 做粗略预期即可，
      // 目的只是让用户知道"要等一会儿"而不是以为卡死，不追求精确。
      prog.start(`长文本更慢，预计 ${Math.round(clipped.length * 0.55) + 5} 秒左右`);
      $('#composer-hint').textContent = '正在本地合成语音…';
      const t0 = Date.now();
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clipped, cardId: S.card && S.card.id }),
      });
      if (!res.ok) {
        let d = {};
        try { d = await res.json(); } catch { /* 非 JSON */ }
        throw new Error(d.error || `语音合成失败（HTTP ${res.status}）`);
      }
      const blob = await res.blob();
      const secs = Math.round((Date.now() - t0) / 1000);
      const url = URL.createObjectURL(blob);
      const cached = res.headers.get('X-TTS-Cached') === '1';
      prog.note(`${cached ? '▶ 命中语音缓存' : '✅ 语音已生成'}（${secs} 秒），正在播放…`);
      $('#composer-hint').textContent = cached ? '播放缓存语音' : '播放本地合成语音';
      const st = activeStage();
      if (st && st.speak) await st.speak(url, audio);
      else { audio.src = url; await audio.play().catch(() => {}); }
      setTimeout(() => URL.revokeObjectURL(url), 8000);
      prog.finish(`${cached ? '▶ 播放缓存语音' : '✅ 语音已生成'}（${secs} 秒）`
        + (truncated ? '，仅朗读前 600 字' : ''));
      $('#composer-hint').textContent = '';
    } catch (e) {
      $('#composer-hint').textContent = '';
      prog.finish(`⚠️ 语音生成失败：${e.message}`, 7000);
      toast(e.message, 'err', 6000);
    }
  }

  /* ========================================================================
   * 六、对话
   * ======================================================================*/
  function renderHistory() {
    const log = $('#chat-log');
    log.innerHTML = '';
    for (const m of S.history) appendMsg(m.role, m.content, { raw: true, image: m.image });
    scrollChat();
  }

  function appendMsg(role, content, { typing = false, raw = false, image = null, kind = '' } = {}) {
    const log = $('#chat-log');
    const isMe = role === 'user';
    const who = isMe ? '我' : (S.card ? S.card.name : 'AIRI');
    const av = isMe ? '🧑' : (S.card ? S.card.avatar : '🤖');
    const bd = el('div', { class: `bd${typing ? ' typing' : ''}` });
    if (raw || isMe || kind === 'sys' || kind === 'err') bd.textContent = content || '';
    else bd.innerHTML = renderMarkdown(content || '');
    const node = el('div', { class: `msg ${isMe ? 'me' : ''} ${kind}` }, [
      el('div', { class: 'av', text: av, title: who }),
      bd,
    ]);
    if (image) {
      node.appendChild(el('img', { src: image, style: { maxWidth: '90px', borderRadius: '8px', marginLeft: '8px', alignSelf: 'center' } }));
    }
    log.appendChild(node);
    scrollChat();
    return bd;
  }

  const scrollChat = () => { const l = $('#chat-log'); l.scrollTop = l.scrollHeight; };

  async function sendMessage() {
    if (S.busy) { toast('正在生成，请稍等或点停止', 'err'); return; }
    const input = $('#chat-input');
    const text = input.value.trim();
    const image = S.visionImage;
    if (!text && !image) return;

    input.value = '';
    clearAttach();
    hideSubtitle();
    appendMsg('user', text || '（看图）', { image });
    S.history.push({ role: 'user', content: text || '（看图）', image: image || undefined });
    saveHistory();

    const bd = appendMsg('assistant', '', { typing: true });
    S.busy = true;
    setBusy(true);
    let acc = '';

    // 流式重绘按时间节流。
    // 原来是每个 delta 都执行 bd.innerHTML = renderMarkdown(acc)，也就是把「已生成的全部文本」
    // 反复重新解析并重建整棵 DOM。一条 1000 字的回复会来 600 多个 delta，
    // 每次都重解析当前全部内容，累计重复解析几万字（O(n²)），长方案越写越卡。
    // 这里合并成"最快 80ms 重绘一次"：delta 照收不误（acc 一直是最新的），
    // 只是渲染次数从「等于 delta 数」降到「每秒最多 12 次」。
    // 也试过用 requestAnimationFrame 合并，但实测 delta 只有 43 个/秒、比 60fps 还慢，
    // 按帧合并等于没合并——瓶颈是重绘次数，不是帧。所以这里用时间节流。
    const STREAM_REDRAW_MS = 80;
    let streamTimer = 0;
    let streamFirstDone = false;
    const renderStream = () => {
      streamTimer = 0;
      bd.classList.remove('typing');
      bd.innerHTML = renderMarkdown(acc);
      scrollChat();
      sayStreaming(acc);
    };
    const flushStream = () => {
      if (!streamFirstDone) { streamFirstDone = true; renderStream(); return; }  // 第一个字立刻出，别让用户等
      if (streamTimer) return;                                                   // 已排过一次，这次的 delta 并进 acc 就行
      streamTimer = setTimeout(renderStream, STREAM_REDRAW_MS);
    };
    const stopStream = () => { if (streamTimer) { clearTimeout(streamTimer); streamTimer = 0; } };

    const stream = sse('/api/chat', {
      message: text,
      image,
      cardId: S.card && S.card.id,
      history: S.history.slice(-13, -1).filter(m => !m.image).map(m => ({ role: m.role, content: m.content })),
    }, (ev) => {
      if (ev.type === 'start') {
        setPill('#pill-model', 'busy', ev.model || '生成中');
      } else if (ev.type === 'stage') {
        $('#composer-hint').textContent = ev.text || '';
      } else if (ev.type === 'vision') {
        appendMsg('system', `👁 视觉理解（${ev.model}）：${ev.text}`, { kind: 'sys', raw: true });
      } else if (ev.type === 'notice') {
        appendMsg('system', ev.text, { kind: 'sys', raw: true });
      } else if (ev.type === 'memory') {
        if (ev.hits && ev.hits.length) {
          appendMsg('system', `🧠 召回了 ${ev.hits.length} 条相关记忆（最高相关度 ${ev.hits[0].score}）`, { kind: 'sys', raw: true });
        }
      } else if (ev.type === 'delta') {
        acc += ev.text;
        flushStream();
      } else if (ev.type === 'done') {
        stopStream();                 // 别让排队中的那一帧覆盖掉定稿结果
        acc = ev.content || acc;
        bd.classList.remove('typing');
        bd.innerHTML = renderMarkdown(acc);
        scrollChat();
        S.history.push({ role: 'assistant', content: acc });
        saveHistory();
        say(acc, false);
        if (S.settings.autospeak) speakText(acc);
        setPill('#pill-model', 'ok', (S.status && S.status.ollama && S.status.ollama.chatModel) || '就绪');
        refreshStatus();
      } else if (ev.type === 'error') {
        stopStream();
        bd.classList.remove('typing');
        bd.parentElement.classList.add('err');
        bd.textContent = `⚠️ ${ev.error}`;
        setPill('#pill-model', 'err', '生成失败');
        toast(ev.error.split('\n')[0], 'err', 7000);
      }
    });

    S.currentStream = stream;
    try { await stream.promise; } catch (e) {
      if (e.name !== 'AbortError') {
        bd.classList.remove('typing');
        bd.parentElement.classList.add('err');
        bd.textContent = `⚠️ ${e.message}`;
      }
    } finally {
      S.busy = false;
      S.currentStream = null;
      setBusy(false);
      $('#composer-hint').textContent = '';
      bd.classList.remove('typing');
    }
  }

  function setBusy(b) {
    $('#btn-send').disabled = b;
    $('#btn-stop').hidden = !b;
  }

  /* ========================================================================
   * 七、文旅功能生成
   * ======================================================================*/
  async function generate(type, params) {
    if (S.busy) { toast('正在生成中…', 'err'); return; }
    // 全屏结果模式下右侧面板本来就看不见，切过去没有意义，还会白白触发一次布局重算
    const onStageResult = document.body.classList.contains('wc-result');
    if ((type === 'plan' || type === 'marketing') && !onStageResult) switchTab('tools');

    // 输出目标：全屏结果模式下写进舞台上的结果卡，否则写右侧面板
    const out = onStageResult ? $('#result-body') : $('#tools-output');
    const warn = $('#tools-warn');
    out.textContent = '⏳ 正在调用本机大模型生成…';
    warn.innerHTML = '';
    S.busy = true;
    setBusy(true);

    const t0 = Date.now();
    const tick = setInterval(() => {
      out.textContent = `⏳ 正在调用本机大模型生成…已等待 ${Math.round((Date.now() - t0) / 1000)} 秒（首次调用需要把模型加载进显存）`;
    }, 1000);

    let acc = '';
    const stream = sse('/api/wenlv/generate', { type, params }, (ev) => {
      if (ev.type === 'delta') {
        acc += ev.text;
        clearInterval(tick);
        out.innerHTML = renderMarkdown(acc);
        out.scrollTop = out.scrollHeight;
      } else if (ev.type === 'done') {
        clearInterval(tick);
        acc = ev.content || acc;
        S.lastResult = acc;
        out.innerHTML = renderMarkdown(acc);
        renderWarnings(warn, ev.warnings || []);
        const secs = Math.round((Date.now() - t0) / 1000);
        toast((ev.warnings && ev.warnings.length)
          ? `✅ 已生成（${secs}s），有 ${ev.warnings.length} 处质检提示`
          : `✅ 已由本地大模型生成（${secs}s）`, 'ok');
        say(ev.type === 'marketing' ? '文案写好了，两版都在右边，可以直接拿去用。' : '方案出好了，右边可以看细节，也能导出。', true);
        refreshStatus();
        renderMemoryList();
      } else if (ev.type === 'error') {
        clearInterval(tick);
        out.textContent = `⚠️ 生成失败\n\n${ev.error}`;
        toast(ev.error.split('\n')[0], 'err', 7000);
      }
    });

    S.currentStream = stream;
    try { await stream.promise; } catch (e) {
      if (e.name !== 'AbortError') out.textContent = `⚠️ 生成失败\n\n${e.message}`;
    } finally {
      clearInterval(tick);
      S.busy = false;
      S.currentStream = null;
      setBusy(false);
    }
  }

  /** 输出质检告警：用 DOM 构建，杜绝 XSS */
  function renderWarnings(box, list) {
    box.innerHTML = '';
    if (!list || !list.length) return;
    const w = el('div', { class: 'warn-box' }, [
      el('h4', { text: `⚠️ 输出质检发现 ${list.length} 处需要注意（已与本地样本库核对）` }),
      el('ul', {}, list.map(t => el('li', { text: t }))),
    ]);
    box.appendChild(w);
  }

  /* ========================================================================
   * 八、机体记忆
   * ======================================================================*/
  async function renderMemoryList() {
    const box = $('#mem-list');
    if (!box) return;
    try {
      const d = await api('/api/memory?limit=60');
      box.innerHTML = '';
      if (!d.items.length) {
        box.appendChild(el('div', { class: 'info-box', text: '记忆库还是空的。聊几句，或点词云里的「记住这个」试试。' }));
        return;
      }
      for (const it of d.items) {
        const node = el('div', { class: 'mem-item' }, [
          el('div', { class: 'txt' }, [
            el('div', { text: it.text.slice(0, 260) }),
            el('div', { class: 'meta', text: `${fmtTime(it.ts)} · ${it.kind} · ${it.role}${it.tags && it.tags.length ? ` · ${it.tags.join('/')}` : ''}${Array.isArray(it.embedding) ? ' · 已向量化' : ''}` }),
          ]),
          el('span', { class: 'del', text: '✕', title: '删除这条记忆', onclick: async () => {
            await api(`/api/memory/${encodeURIComponent(it.id)}`, { method: 'DELETE' }).catch(() => {});
            renderMemoryList(); refreshStatus();
          } }),
        ]);
        box.appendChild(node);
      }
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'warn-box', text: `读取记忆失败：${e.message}` }));
    }
  }

  /* ========================================================================
   * 九、角色卡
   * ======================================================================*/
  function setActiveCard(id, { silent } = {}) {
    const card = S.cards.find(c => c.id === id) || S.cards[0] || null;
    S.card = card;
    if (!card) return;
    // 角色卡里存了形象与开关，切卡就跟着切
    S.settings.memory = !(card.memory && card.memory.enabled === false);
    S.settings.vision = !(card.vision && card.vision.enabled === false);
    if (card.live2d) {
      S.settings.l2dScale = card.live2d.scale || 1;
      S.settings.l2dX = card.live2d.x || 0;
      S.settings.l2dY = card.live2d.y || 0;
      S.settings.expression = card.live2d.expression || '';
    }
    const instruct = (card.voice && card.voice.instruct) || '';
    const vi = $('#voice-instruct');
    if (vi) vi.value = instruct;

    $('#char-name').textContent = card.name;
    $('#char-tag').textContent = card.tagline || '';
    $('#char-avatar').textContent = card.avatar || '🙂';
    $('#chat-char-name').textContent = card.name;
    document.documentElement.style.setProperty('--primary', `color-mix(in srgb, oklch(78% 0.14 ${hexToHue(card.accent)}) 100%, transparent)`);

    applySettingsToUI();
    // 角色卡主色会同时影响两处：CSS 变量（整站主色）与背景调色板（极光背景跟着变色）。
    // 所以换角色卡时"整站一起变"，这是刻意的联动。
    if (bg) {
      const item = findBackground(S.settings.backgroundId);
      bg.setPalette(tintPalette(item));
    }
    renderLookPreview();
    if (!silent) {
      // 角色卡里同时记着"用哪个形象、哪套渲染器"，换卡就整套一起换
      if (card.live2d && card.live2d.model) {
        switchDisplay(card.live2d.kind || 'live2d', card.live2d.model, { silent: true });
      }
      renderCards();
      if (card.greeting) say(card.greeting, true);
    }
  }

  /** 把 #rrggbb 粗算成 oklch 的色相角，让角色卡主色能和 airi 的色相机制接上 */
  function hexToHue(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 220.44;
    const n = parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (!d) return 220.44;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return h.toFixed(2);
  }

  function renderCards() {
    const box = $('#card-list');
    if (!box) return;
    box.innerHTML = '';
    for (const c of S.cards) {
      const active = S.card && c.id === S.card.id;
      const node = el('div', { class: `char-card${active ? ' active' : ''}` }, [
        el('div', { class: 'av', text: c.avatar || '🙂' }),
        el('div', { style: { flex: '1', minWidth: '0' } }, [
          el('div', { class: 'nm' }, [
            document.createTextNode(c.name),
            c.builtin ? el('span', { class: 'badge builtin', text: '内置' }) : null,
            active ? el('span', { class: 'badge', text: '当前' }) : null,
          ]),
          el('div', { class: 'tg', text: `${c.tagline || ''} · ${(c.tags || []).join('/') || '无标签'}` }),
        ]),
        el('div', { style: { display: 'flex', gap: '5px' } }, [
          el('button', { class: 'icon-btn', style: { width: '28px', height: '28px', fontSize: '12px' }, text: '✎', title: '编辑', onclick: (e) => { e.stopPropagation(); openCardEditor(c); } }),
          el('button', { class: 'icon-btn', style: { width: '28px', height: '28px', fontSize: '12px' }, text: '⧉', title: '复制一份', onclick: async (e) => {
            e.stopPropagation();
            await api(`/api/cards/${c.id}/duplicate`, { method: 'POST' });
            await reloadCards(); toast('已复制角色卡', 'ok');
          } }),
          c.builtin ? null : el('button', { class: 'icon-btn', style: { width: '28px', height: '28px', fontSize: '12px' }, text: '🗑', title: '删除', onclick: async (e) => {
            e.stopPropagation();
            const r = await api(`/api/cards/${c.id}`, { method: 'DELETE' }).catch(err => ({ ok: false, error: err.message }));
            if (!r.ok) return toast(r.error, 'err');
            await reloadCards(); toast('已删除', 'ok');
          } }),
        ]),
      ]);
      node.addEventListener('click', async () => {
        await api(`/api/cards/${c.id}/activate`, { method: 'POST' });
        S.cards = (await api('/api/cards')).cards;
        setActiveCard(c.id);
        toast(`已切换到「${c.name}」`, 'ok');
      });
      box.appendChild(node);
    }
  }

  async function reloadCards() {
    const d = await api('/api/cards');
    S.cards = d.cards;
    renderCards();
  }

  /** 角色卡编辑器：一个弹层解决"虚拟人格自定义"的全部字段 */
  function openCardEditor(card) {
    const isNew = !card;
    const c = card || {
      name: '新角色', avatar: '🙂', accent: '#a78bfa', tagline: '', persona: '', speakingStyle: '',
      greeting: '', voice: { presetId: 'wenlv-guide-female', mode: 'custom-voice', instruct: '', language: 'Chinese' },
      model: { temperature: 0.7, numCtx: 16384, numPredict: 1024 },
      live2d: { model: (S.l2dModels[0] && S.l2dModels[0].id) || 'nahida', scale: 1, x: 0, y: 0, expression: '' },
      memory: { enabled: true, topK: 5 }, vision: { enabled: true }, tags: [],
    };
    const f = {};
    const field = (label, key, type, extra) => {
      const input = type === 'textarea'
        ? el('textarea', { placeholder: extra || '' })
        : el('input', { type: type || 'text', placeholder: extra || '' });
      input.value = (key.split('.').reduce((o, k) => (o ? o[k] : ''), c)) ?? '';
      f[key] = input;
      return el('div', { class: 'field' }, [el('label', { text: label }), input]);
    };

    const body = el('div', { class: 'body' }, [
      el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' } }, [
        field('名字', 'name', 'text'),
        field('头像 emoji', 'avatar', 'text'),
        field('主题色 #rrggbb', 'accent', 'text'),
      ]),
      field('一句话定位', 'tagline', 'text', '例如：浙江文旅向导，陪你玩得明白'),
      field('人设（system prompt 的主体）', 'persona', 'textarea', '你是谁、擅长什么、怎么做事…'),
      field('说话风格', 'speakingStyle', 'textarea', '语气、口头禅、句式偏好…'),
      field('开场白', 'greeting', 'textarea'),
      field('语气指令 instruct（只管语气节奏；「是谁在说话」由声音页签的内置音色决定）', 'voice.instruct', 'textarea'),
      el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' } }, [
        field('温度 temperature', 'model.temperature', 'number'),
        field('上下文 numCtx', 'model.numCtx', 'number'),
        field('最大输出 numPredict', 'model.numPredict', 'number'),
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Live2D 形象' }),
        (() => {
          const sel = el('select');
          for (const m of S.l2dModels) sel.appendChild(el('option', { value: m.id, text: `${m.label}（${m.id}）`, selected: (c.live2d && c.live2d.model) === m.id }));
          f['live2d.model'] = sel;
          return sel;
        })(),
      ]),
      field('标签（逗号分隔）', 'tags', 'text'),
      el('div', { class: 'field' }, [
        el('label', { text: '开关' }),
        (() => {
          const mk = (key, label, val) => {
            const cb = el('input', { type: 'checkbox' });
            cb.checked = val;
            f[key] = cb;
            return el('label', { class: 'check' }, [cb, document.createTextNode(label)]);
          };
          return el('div', {}, [
            mk('memory.enabled', '启用机体记忆', !(c.memory && c.memory.enabled === false)),
            mk('vision.enabled', '允许视觉理解', !(c.vision && c.vision.enabled === false)),
          ]);
        })(),
      ]),
    ]);

    const readBack = () => {
      const out = { id: c.id, tags: String(f['tags'].value || '').split(/[,，\s]+/).filter(Boolean) };
      for (const [key, input] of Object.entries(f)) {
        if (key === 'tags') continue;
        const val = input.type === 'checkbox' ? input.checked : input.value;
        const parts = key.split('.');
        let o = out;
        for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]]; }
        o[parts[parts.length - 1]] = val;
      }
      out.model.temperature = Number(out.model.temperature) || 0.7;
      out.model.numCtx = Number(out.model.numCtx) || 16384;
      out.model.numPredict = Number(out.model.numPredict) || 1024;
      out.memory.topK = 5;
      return out;
    };

    const modal = el('div', { class: 'modal' }, [
      el('header', {}, [el('h3', { text: isNew ? '新建角色卡' : `编辑角色卡 · ${c.name}` })]),
      body,
      el('footer', {}, [
        !isNew ? el('button', { class: 'btn ghost sm', text: '📤 导出这张卡', onclick: () => { location.href = `/api/cards/${c.id}/export`; } }) : null,
        el('button', { class: 'btn ghost sm', text: '取消', onclick: close }),
        el('button', { class: 'btn sm', text: '保存', onclick: async () => {
          try {
            const payload = readBack();
            if (isNew) await api('/api/cards', { method: 'POST', body: payload });
            else await api(`/api/cards/${c.id}`, { method: 'PUT', body: payload });
            await reloadCards();
            toast('角色卡已保存（仅存在本机）', 'ok');
            close();
          } catch (e) { toast(e.message, 'err'); }
        } }),
      ]),
    ]);

    const mask = el('div', { class: 'modal-mask', onclick: (e) => { if (e.target === mask) close(); } }, [modal]);
    function close() { mask.remove(); }
    $('#modal-root').appendChild(mask);
  }

  /* ========================================================================
   * 十、人物形象（Live2D 与 3D 两套渲染器，按所选形象切换）
   *
   * 为什么不把所有东西合到一个类里：Live2D 用 PixiJS + Cubism、3D 用 three.js +
   * three-vrm，两套依赖完全不同。硬合会变成一个谁都不像的抽象层，还让
   * "只用 Live2D 的用户"被迫下载 2.2MB 的 three.js。
   * 所以：两个类，各自实现同一组方法（init/load/setScale/setPosition/
   * setExpression/playMotion/speak/resize/destroy），调用方通过 activeStage() 取。
   * ======================================================================*/

  /** 当前生效的渲染器实例 */
  function activeStage() {
    return S.display.kind === '3d' ? stage3d : stage;
  }

  /**
   * 两个画布互斥显示：谁来渲染就显示谁，另一个藏起来省 GPU。
   *
   * 注意这里必须写**显式的 'block' / 'none'**，不能写空串。
   * CSS 里给 #stage3d-canvas 定了 `display: none` 作为默认值（避免首屏闪一下），
   * 如果这里设成空串，等于把内联样式删掉，CSS 的 none 又赢回来 —— 3D 画布永远不显示。
   * 这个坑实测踩过：画布其实已经渲染好了（能采样到像素），但用户看不到。
   */
  function showCanvas(kind) {
    const l2d = $('#live2d-canvas');
    const c3d = $('#stage3d-canvas');
    if (l2d) l2d.style.display = kind === '3d' ? 'none' : 'block';
    if (c3d) c3d.style.display = kind === '3d' ? 'block' : 'none';
  }

  function stageProblem(msg) {
    $('#stage-empty-msg').textContent = msg;
    $('#stage-empty').classList.remove('hidden');
  }
  function stageOk() {
    $('#stage-empty').classList.add('hidden');
  }

  /** 创建 Live2D 渲染器（只在真的要用时才建） */
  async function ensureLive2D() {
    if (stage) return stage;
    const problem = window.Live2DStage.runtimeAvailable();
    if (problem) throw new Error(`${problem}\n请确认 public/vendor/ 下的三个运行时文件都存在。`);
    stage = new window.Live2DStage($('#live2d-canvas'));
    stage.onTapCb = onCharacterTap;
    await stage.init();
    return stage;
  }

  /**
   * 创建 3D 渲染器。three.js + three-vrm 共 2.2MB，**按需动态 import**，
   * 这样默认用 Live2D 的用户根本不会下这两个包。
   */
  async function ensure3D() {
    if (stage3d) return stage3d;
    stageProblem('正在加载 3D 渲染器（three.js + three-vrm，约 2.2MB，只需加载一次）…');
    let mod;
    try {
      mod = await import('/js/stage3d.js');
    } catch (e) {
      throw new Error(
        `3D 渲染器加载失败：${e && e.message ? e.message : e}\n`
        + '请确认 public/vendor/three/ 下有 three.module.js、three-vrm.module.js 与 addons/ 目录，'
        + '并且 index.html 里的 importmap 没有被改动。',
      );
    }
    stage3d = new mod.ThreeDStage($('#stage3d-canvas'));
    stage3d.onTapCb = onCharacterTap;
    await stage3d.init();
    return stage3d;
  }

  /** 点人物：两套渲染器共用的反馈 */
  function onCharacterTap() {
    hideSubtitle();
    const st = activeStage();
    if (st) st.playMotion();
    say(pickRandom([
      '嗯？点我做什么～',
      '想好去哪儿玩了吗？',
      '点词云试试，那边什么都能点。',
      '我在这儿呢。',
    ]), true);
  }

  /**
   * 切换当前展示的形象。
   * @param {'live2d'|'3d'} kind
   * @param {string} id
   */
  async function switchDisplay(kind, id, { silent } = {}) {
    const item = findDisplayModel(kind, id)
      || (kind === '3d' ? allDisplayModels().find(m => m.kind === '3d') : S.l2dModels[0]);
    if (!item) {
      stageProblem(kind === '3d'
        ? '还没有可用的 3D 形象。\n\n两种办法：\n1. 双击仓库根目录的「获取示例模型.bat」下载内置的 VRM 示例模型\n2. 点外观页的「更换形象」→「上传 VRM / GLB」，用你自己的模型'
        : '还没有可用的 Live2D 模型。\n\n模型是第三方素材，没有随仓库分发。\n双击仓库根目录的「获取示例模型.bat」即可下载并安装。\n也可以把自己的模型文件夹（需含 .model3.json）放进 public/models/ 下。');
      return;
    }
    S.display = { kind: item.kind, id: item.id };
    showCanvas(item.kind);

    if (item.kind === '3d') {
      stageProblem(`正在加载 3D 形象 ${item.label}…`);
      try {
        const st = await ensure3D();
        await st.load(item.url);
        st.setScale(S.settings.l2dScale);
        st.setPosition(S.settings.l2dX, S.settings.l2dY);
        stageOk();
        // 没有预览图的模型，等它站稳之后自动截一帧存下来（只截一次）
        if (!item.preview) captureModelPreview(item);
      } catch (e) {
        stageProblem(e.message);
        toast(String(e.message).split('\n')[0], 'err', 9000);
      }
    } else {
      stageProblem(`正在加载 ${item.label}…`);
      try {
        const st = await ensureLive2D();
        await st.load(item.entry, { label: item.label });
        st.setScale(S.settings.l2dScale);
        st.setPosition(S.settings.l2dX, S.settings.l2dY);
        if (S.settings.expression && (st.expressions || []).includes(S.settings.expression)) {
          await st.setExpression(S.settings.expression);
        }
        stageOk();
      } catch (e) {
        stageProblem(e.message);
        toast(String(e.message).split('\n')[0], 'err', 9000);
      }
    }

    renderExpressions();
    renderLookPreview();
    cloud.layout();
    void silent;
  }

  /** 启动时按角色卡决定用哪套渲染器 */
  async function initStage() {
    const kind = (S.card && S.card.live2d && S.card.live2d.kind) || S.display.kind;
    const id = (S.card && S.card.live2d && S.card.live2d.model) || S.display.id;
    await switchDisplay(kind, id, { silent: true });
  }

  /**
   * 给 3D 模型自动生成一张预览图。
   *
   * 为什么不离线生成：用户上传的模型只在用户机器上，服务端没有渲染器。
   * 但前端此刻**已经把它渲染出来了** —— 直接截当前这一帧回传落盘，
   * 比再跑一遍离屏渲染省事得多，而且截到的就是用户真实看到的样子。
   * 只在模型还没有预览图时截一次，不重复做。
   */
  async function captureModelPreview(item) {
    try {
      await new Promise(r => setTimeout(r, 1600));       // 等首帧、物理与相机稳定
      if (S.display.kind !== '3d' || S.display.id !== item.id) return;   // 用户已经切走了
      const src = $('#stage3d-canvas');
      if (!src || !src.width) return;

      // 缩到 480 宽再存：预览图只是缩略图，没必要存整屏
      const W = 480;
      const H = Math.max(1, Math.round(src.height * (W / src.width)));
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(src, 0, 0, W, H);
      const dataUrl = c.toDataURL('image/png');
      if (dataUrl.length < 2000) return;                 // 基本是空图，别存

      await api('/api/models3d/preview', { method: 'POST', body: { url: item.url, image: dataUrl } });
      // 刷新列表，让预览图立刻在选择器/外观页里生效
      const d = await api('/api/models3d');
      S.models3d = { ...S.models3d, bundled: d.bundled, custom: d.custom, formats: d.formats };
      renderLookPreview();
    } catch {
      // 截图失败不影响使用，静默跳过（下次切到这个模型还会再试）
    }
  }

  /** 手动点人物时用（保留旧名字，别的地方还有调用） */
  async function loadModel(id) {
    await switchDisplay('live2d', id);
  }

  function renderLive2DModels() {
    renderLookPreview();
  }

  /** 列出当前渲染器支持的表情（两套渲染器的取法不同，这里抹平） */
  function currentExpressions() {
    if (S.display.kind === '3d') {
      return stage3d && stage3d.expressionNames ? stage3d.expressionNames() : [];
    }
    return (stage && stage.expressions) || [];
  }

  function renderExpressions() {
    const box = $('#l2d-expressions');
    const hint = $('#expr-hint');
    if (!box) return;
    box.innerHTML = '';
    const names = currentExpressions();

    if (hint) {
      hint.textContent = S.display.kind === '3d'
        ? '3D 形象的表情由 VRM 定义，不同模型差别很大'
        : '来自模型的 .exp3.json';
    }

    if (!names.length) {
      box.appendChild(el('span', {
        class: 'mini',
        text: S.display.kind === '3d'
          ? (stage3d ? '该 3D 模型没有可切换的表情（或不是 VRM）' : '3D 渲染器还没加载')
          : '该模型没有表情文件（.exp3.json）',
      }));
      return;
    }

    const none = el('button', { class: `chip${!S.settings.expression ? ' on' : ''}`, text: '默认', type: 'button' });
    none.addEventListener('click', async () => {
      S.settings.expression = '';
      saveSettings();
      if (S.display.kind !== '3d' && stage) {
        try { stage.model.internalModel.motionManager.expressionManager?.resetExpression(); } catch { /* 忽略 */ }
      }
      renderExpressions();
    });
    box.appendChild(none);

    for (const name of names) {
      const chip = el('button', { class: `chip${S.settings.expression === name ? ' on' : ''}`, text: name, type: 'button' });
      chip.addEventListener('click', async () => {
        S.settings.expression = name;
        saveSettings();
        const st = activeStage();
        if (st) await st.setExpression(name);
        renderExpressions();
      });
      box.appendChild(chip);
    }
  }

  const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

  /* ========================================================================
   * 十一、界面绑定
   * ======================================================================*/
  function switchTab(name) {
    $$('#tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.pane === name));
    $$('.pane').forEach(p => p.classList.toggle('active', p.id === `pane-${name}`));
    if (name === 'memory') renderMemoryList();
    if (name === 'cards') renderCards();
    if (name === 'look') { renderLookPreview(); renderExpressions(); refreshStatus(); }
    if (name === 'voice') renderVoices();
  }

  function bindTabs() {
    $$('#tabs .tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.pane)));
  }

  function bindTopbar() {
    $('#btn-refresh').addEventListener('click', async () => {
      await refreshStatus();
      await loadCapabilities();
      if (stage && S.card && S.card.live2d) await loadModel(S.card.live2d.model);
      toast('已刷新本地服务状态', 'ok');
    });
    $('#btn-speak-toggle').addEventListener('click', (e) => {
      S.settings.autospeak = !S.settings.autospeak;
      saveSettings();
      e.currentTarget.classList.toggle('on', S.settings.autospeak);
      toast(S.settings.autospeak ? '已开启自动朗读' : '已关闭自动朗读', 'ok');
    });
    $('#btn-wc-toggle').addEventListener('click', (e) => {
      S.settings.wcEnabled = !S.settings.wcEnabled;
      saveSettings();
      $('#wordcloud-layer').style.display = S.settings.wcEnabled ? '' : 'none';
      e.currentTarget.classList.toggle('on', S.settings.wcEnabled);
      $('#wc-enabled').checked = S.settings.wcEnabled;
      if (S.settings.wcEnabled) cloud.layout();
    });
    $('#pill-model').addEventListener('click', () => switchTab('look'));
    $('#pill-memory').addEventListener('click', () => switchTab('memory'));
    $('#pill-voice').addEventListener('click', () => switchTab('voice'));
    $('#pill-vision').addEventListener('click', () => { switchTab('chat'); $('#file-input').click(); });

    // 舞台工具条
    $('#open-bg').addEventListener('click', openBackgroundPicker);
    $('#open-model').addEventListener('click', openModelPicker);
    $('#wc-full').addEventListener('click', () => {
      document.body.classList.toggle('wc-full');
      // 退出全屏时顺手收起结果卡：右栏这会儿又露出来了，结果看那边那份就行
      if (!document.body.classList.contains('wc-full')) closeStageResult();
      setTimeout(() => { syncCloudInsets(); cloud.layout(); }, 80);
    });

    // 结果卡右上角：喇叭 = 用本机 TTS 把这段内容读出来；✕ = 收起，回到词云
    const resultSpeak = $('#result-speak');
    if (resultSpeak) {
      resultSpeak.addEventListener('click', async () => {
        const body = $('#result-body');
        const text = body ? body.textContent.trim() : '';
        if (!text) { toast('还没有内容可以朗读', 'err'); return; }
        setResultSpeakState(true);
        try { await speakText(text); } finally { setResultSpeakState(false); }
      });
    }
    const resultClose = $('#result-close');
    if (resultClose) resultClose.addEventListener('click', closeStageResult);
    $('#wc-shuffle').addEventListener('click', () => cloud.shuffle());

    // 状态灯：按初始设置点亮
    $('#btn-speak-toggle').classList.toggle('on', S.settings.autospeak);
    $('#btn-wc-toggle').classList.toggle('on', S.settings.wcEnabled);
    $('#subtitle-close').addEventListener('click', hideSubtitle);
    // 字幕条只显示两行，点它可以把整条回复展开/收起。
    // 只有确实超长（markSubtitleExpandable 加了 can-expand）才响应，
    // 免得短句子点一下也弹开、看着莫名其妙。
    $('#subtitle').addEventListener('click', (e) => {
      if (e.target.closest('.subtitle-close')) return;
      const t = $('#subtitle-text');
      if (!t || !t.classList.contains('can-expand')) return;
      $('#subtitle').classList.toggle('expanded');
      clearTimeout(subtitleTimer);
      subtitleTimer = setTimeout(hideSubtitle, 12000);
    });
  }

  function bindStage() {
    // 点空白处收起字幕
    $('#stage').addEventListener('click', (e) => {
      if (e.target.id === 'stage' || e.target.id === 'live2d-canvas' || e.target.id === 'bg-canvas') hideSubtitle();
    });
    // 窗口尺寸变化时安全边距可能变（比如窄屏工具栏换行），重新量一次
    let rzTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(syncCloudInsets, 220);
    });
    // 初始量一次：等首屏布局稳定
    setTimeout(syncCloudInsets, 300);
  }

  function bindComposer() {
    const input = $('#chat-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
    });
    $('#btn-send').addEventListener('click', sendMessage);
    $('#btn-stop').addEventListener('click', () => {
      if (S.currentStream) S.currentStream.abort();
      toast('已请求停止', 'ok');
    });
    $('#btn-image').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!/^image\//.test(file.type)) return toast('请选择图片文件', 'err');
      const reader = new FileReader();
      reader.onload = async () => {
        const small = await downscaleImage(String(reader.result));
        S.visionImage = small;
        renderAttach();
        switchTab('chat');
        say('图我看到了，让我先用视觉模型看仔细点。', true);
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    });
    $('#btn-camera').addEventListener('click', toggleCamera);
  }

  function renderAttach() {
    const slot = $('#attach-slot');
    slot.innerHTML = '';
    if (!S.visionImage) return;
    slot.appendChild(el('div', { class: 'attach' }, [
      el('img', { src: S.visionImage, alt: '待识别图片' }),
      el('span', { text: '图片已附加，发送后会先用本机视觉模型识别' }),
      el('span', { style: { flex: '1' } }),
      el('button', { class: 'btn ghost sm', text: '移除', onclick: () => { clearAttach(); } }),
    ]));
  }
  function clearAttach() { S.visionImage = null; renderAttach(); }

  async function toggleCamera() {
    const slot = $('#attach-slot');
    if (S.cameraStream) {
      S.cameraStream.getTracks().forEach(t => t.stop());
      S.cameraStream = null;
      renderAttach();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      S.cameraStream = stream;
      const video = el('video', { autoplay: true, playsinline: true, style: { width: '100%', borderRadius: '10px', maxHeight: '180px', objectFit: 'cover' } });
      video.srcObject = stream;
      slot.innerHTML = '';
      slot.appendChild(el('div', { class: 'attach', style: { flexDirection: 'column', alignItems: 'stretch' } }, [
        video,
        el('div', { class: 'actions' }, [
          el('button', { class: 'btn sm', text: '📸 拍下并识别', onclick: () => captureFromVideo(video) }),
          el('button', { class: 'btn ghost sm', text: '取消', onclick: toggleCamera }),
        ]),
      ]));
    } catch (e) {
      toast(`无法打开摄像头：${e.message}（可改用「上传图片」）`, 'err', 6000);
    }
  }

  function captureFromVideo(video) {
    const c = document.createElement('canvas');
    c.width = video.videoWidth || 640;
    c.height = video.videoHeight || 480;
    c.getContext('2d').drawImage(video, 0, 0);
    S.visionImage = c.toDataURL('image/jpeg', 0.85);
    if (S.cameraStream) { S.cameraStream.getTracks().forEach(t => t.stop()); S.cameraStream = null; }
    renderAttach();
    toast('已拍照，发送后交给本机视觉模型', 'ok');
  }

  function bindTools() {
    $$('#pane-tools [data-tool]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const tool = chip.dataset.tool;
        $$('#pane-tools [data-tool]').forEach(c => c.classList.toggle('on', c === chip));
        $('#form-plan').hidden = tool !== 'plan';
        $('#form-marketing').hidden = tool !== 'marketing';
      });
    });
    $('#plan-days').addEventListener('input', (e) => { $('#days-label').textContent = e.target.value; });
    $('#btn-generate').addEventListener('click', () => {
      const isPlan = !$('#form-plan').hidden;
      generate(isPlan ? 'plan' : 'marketing', isPlan ? collectPlanParams() : collectMarketingParams());
    });
    $('#btn-intake').addEventListener('click', () => generate('intake', {}));
    $('#btn-export').addEventListener('click', () => {
      if (!S.lastResult) return toast('还没有可导出的内容', 'err');
      download(`文旅结果_${new Date().toISOString().slice(0, 10)}.md`, S.lastResult);
      toast('已导出为 Markdown', 'ok');
    });
    $('#btn-speak-result').addEventListener('click', () => {
      if (!S.lastResult) return toast('还没有可朗读的内容', 'err');
      speakText(S.lastResult);
    });
  }

  function bindMemory() {
    $('#mem-reload').addEventListener('click', renderMemoryList);
    $('#mem-add').addEventListener('click', async () => {
      const text = $('#mem-add-text').value.trim();
      if (!text) return toast('先写点内容', 'err');
      try {
        await api('/api/memory', { method: 'POST', body: { text, kind: 'fact' } });
        $('#mem-add-text').value = '';
        toast('已存入机体记忆', 'ok');
        renderMemoryList(); refreshStatus();
      } catch (e) { toast(e.message, 'err'); }
    });
    $('#mem-clear').addEventListener('click', async () => {
      if (!confirm('确定清空全部机体记忆？此操作不可恢复（记忆文件在本机 data/ 下）。')) return;
      await api('/api/memory/clear', { method: 'POST' });
      renderMemoryList(); refreshStatus();
      toast('记忆已清空', 'ok');
    });
    $('#mem-search').addEventListener('click', doMemSearch);
    $('#mem-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') doMemSearch(); });
  }

  async function doMemSearch() {
    const q = $('#mem-query').value.trim();
    if (!q) return;
    const box = $('#mem-search-result');
    box.innerHTML = '<div class="info-box">检索中…</div>';
    try {
      const d = await api('/api/memory/search', { method: 'POST', body: { query: q, limit: 8 } });
      box.innerHTML = '';
      if (!d.hits.length) {
        box.appendChild(el('div', { class: 'info-box', text: '没有召回相关记忆。多聊几句或手动记几条再试。' }));
        return;
      }
      for (const h of d.hits) {
        box.appendChild(el('div', { class: 'mem-item' }, [
          el('div', { class: 'txt' }, [
            el('div', { text: h.text.slice(0, 240) }),
            el('div', { class: 'meta', text: `${fmtTime(h.ts)} · ${h.kind}` }),
          ]),
          el('span', { class: 'mem-score', text: h.score.toFixed(3) }),
        ]));
      }
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'warn-box', text: `检索失败：${e.message}` }));
    }
  }

  function bindCards() {
    $('#card-new').addEventListener('click', () => openCardEditor(null));
    $('#card-export-all').addEventListener('click', () => { location.href = '/api/cards/export-all'; });
    $('#card-import').addEventListener('click', () => {
      const input = el('input', { type: 'file', accept: '.json,application/json' });
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const text = await file.text();
        try {
          const r = await api('/api/cards/import', { method: 'POST', body: { card: text } });
          await reloadCards();
          toast(`已导入角色卡「${r.card.name}」`, 'ok');
        } catch (e) { toast(`导入失败：${e.message}`, 'err', 6000); }
      });
      input.click();
    });
  }

  function renderVoices() {
    const box = $('#voice-list');
    if (!box) return;
    box.innerHTML = '';
    const cur = S.card && S.card.voice ? S.card.voice.presetId : null;
    for (const v of S.voices) {
      const node = el('div', { class: `voice-item${v.id === cur ? ' active' : ''}` }, [
        el('div', { style: { flex: '1', minWidth: '0' } }, [
          el('div', { class: 'nm', text: v.name }),
          el('div', { class: 'ds', text: `${v.desc}（语速${v.speedHint || '中等'}）` }),
        ]),
        el('span', { class: 'badge', text: v.speaker || v.mode }),
      ]);
      node.addEventListener('click', async () => {
        if (!S.card) return;
        // speaker 必须一起存 —— CustomVoice 模型下"是谁在说话"由它决定，
        // 只存 instruct 的话换预设也不会换声音（会一直用后端默认的男声）。
        await api(`/api/cards/${S.card.id}`, {
          method: 'PUT',
          body: {
            voice: {
              presetId: v.id,
              mode: v.mode,
              speaker: v.speaker || null,
              instruct: v.instruct,
              language: v.language || 'Chinese',
            },
          },
        });
        await reloadCards();
        S.card = S.cards.find(c => c.id === S.card.id);
        $('#voice-instruct').value = v.instruct;
        renderVoices();
        renderSpeakers();
        toast(`音色已切换为「${v.name}」`, 'ok');
        speakText('你好，我是你的文旅向导，现在用的是' + v.name + '。');
      });
      box.appendChild(node);
    }
    if (!S.voices.length) box.appendChild(el('div', { class: 'info-box', text: '没有取到音色库，请点右上角刷新。' }));
  }

  /**
   * 内置说话人选择器。
   *
   * 为什么非要有这一栏：Qwen3-TTS 的 CustomVoice 模型自带 9 个音色，
   * 其中 5 个男声 4 个女声；而后端的默认值是列表第一个 —— **aiden，男声**。
   * 项目原来 5 个预设全都把 speaker 留空，于是不管选哪个、instruct 写"年轻女声"
   * 还是"元气少女"，出来的都是同一个男声。把音色直接摊在界面上，
   * 用户才能自己挑，而不是被迫用那个默认值。
   */
  function renderSpeakers() {
    const box = $('#speaker-list');
    if (!box) return;
    box.innerHTML = '';
    const cur = S.card && S.card.voice ? S.card.voice.speaker : null;
    if (!S.speakers.length) {
      box.appendChild(el('div', {
        class: 'info-box',
        text: '没取到音色列表 —— 多半是 Qwen TTS 服务没在跑。启动后点右上角「⟳ 刷新」。',
      }));
      return;
    }
    const grid = el('div', { class: 'speaker-grid' });
    for (const sp of S.speakers) {
      const isCur = sp.id === cur;
      const node = el('div', { class: `speaker-item${isCur ? ' active' : ''}` }, [
        el('div', { class: 'nm', text: sp.name || sp.id }),
        el('div', { class: 'ds', text: `${sp.gender === 'female' ? '女声' : sp.gender === 'male' ? '男声' : '—'}${sp.freq ? ` · ${sp.freq}Hz` : ''}` }),
        el('div', { class: 'ds2', text: sp.desc || '' }),
      ]);
      node.title = `speaker id: ${sp.id}`;
      node.addEventListener('click', async () => {
        if (!S.card) return;
        await api(`/api/cards/${S.card.id}`, { method: 'PUT', body: { voice: { speaker: sp.id } } });
        await reloadCards();
        S.card = S.cards.find(c => c.id === S.card.id);
        renderSpeakers();
        renderVoices();
        toast(`说话人已切换为「${sp.name || sp.id}」`, 'ok');
        speakText('你好，我现在是这个音色。');
      });
      grid.appendChild(node);
    }
    box.appendChild(grid);
    box.appendChild(el('div', {
      class: 'ds',
      style: { marginTop: '6px' },
      text: '这一栏决定「是谁在说话」，上面的音色库是预设好的组合（含语气描述）。点一下即可试听。',
    }));
  }

  /**
   * 「我的音色」：用户自己上传参考音频克隆出来的嗓子。
   *
   * 和上面两组音色的区别：
   *   内置音色 —— 后端自带的 9 个 id，挑一个就行
   *   音色库   —— 内置音色 + 语气描述的预设组合
   *   我的音色 —— 用户的一段录音，合成时走 voice-clone（更慢，但声音是"自己人"的）
   */
  function renderMyVoices() {
    const box = $('#my-voices');
    if (!box) return;
    box.innerHTML = '';
    const cur = S.card && S.card.voice ? S.card.voice.refVoiceId : null;

    if (!S.myVoices.length) {
      box.appendChild(el('div', {
        class: 'info-box',
        text: '还没有自己的音色。点下面「＋ 添加音色」，选一段 5~15 秒、干净的单人录音（必须是真 WAV）即可。',
      }));
      return;
    }

    for (const v of S.myVoices) {
      const btns = el('span', { class: 'lbl-actions' }, [
        el('button', {
          class: 'mini-btn',
          text: '↺',
          title: '试听这段参考音频',
          onclick: (e) => { e.stopPropagation(); new Audio(v.url).play().catch(() => toast('试听失败', 'err')); },
        }),
        el('button', {
          class: 'mini-btn',
          text: '✕',
          title: '删除这个音色',
          onclick: async (e) => {
            e.stopPropagation();
            try {
              await api(`/api/voices/${v.id}`, { method: 'DELETE' });
              // 如果正用着它，把卡片上的引用清掉，免得下次朗读报"音色找不到"
              if (S.card && S.card.voice && S.card.voice.refVoiceId === v.id) {
                await api(`/api/cards/${S.card.id}`, {
                  method: 'PUT',
                  body: { voice: { presetId: VOICE_RESET_PRESET, mode: 'custom-voice', speaker: null, refVoiceId: null, instruct: '' } },
                });
                await reloadCards();
                S.card = S.cards.find(c => c.id === S.card.id);
              }
              await reloadMyVoices();
              renderVoices();
              renderSpeakers();
              toast(`已删除「${v.name}」`, 'ok');
            } catch (err) { toast(err.message, 'err'); }
          },
        }),
      ]);
      const node = el('div', { class: `voice-item${v.id === cur ? ' active' : ''}` }, [
        el('div', { style: { flex: '1', minWidth: '0' } }, [
          el('div', { class: 'nm', text: v.name }),
          el('div', { class: 'ds', text: `${v.seconds} 秒 · ${v.sampleRate}Hz · 参考音频克隆` }),
        ]),
        btns,
      ]);
      node.addEventListener('click', () => useMyVoice(v));
      box.appendChild(node);
    }
  }

  /** 切到某个自定义音色：写进角色卡，之后朗读就走 voice-clone */
  async function useMyVoice(v) {
    if (!S.card) return;
    await api(`/api/cards/${S.card.id}`, {
      method: 'PUT',
      body: {
        voice: {
          presetId: `custom-${v.id}`,
          mode: 'voice-clone',
          speaker: null,
          instruct: '',
          refVoiceId: v.id,
          language: 'Chinese',
        },
      },
    });
    await reloadCards();
    S.card = S.cards.find(c => c.id === S.card.id);
    renderVoices();
    renderSpeakers();
    renderMyVoices();
    toast(`音色已切换为「${v.name}」（克隆音色，第一次合成会慢几秒）`, 'ok');
    speakText('你好，我现在用的是' + v.name + '。');
  }

  async function reloadMyVoices() {
    try {
      S.myVoices = (await api('/api/voices')).voices || [];
    } catch { S.myVoices = []; }
    renderMyVoices();
  }

  /** 添加音色的弹窗：选文件 → 起名 → （可选）填参考文本 → 上传 */
  function openVoiceAdder() {
    let picked = null;

    const fileLabel = el('div', { class: 'ds', text: '还没选文件' });
    const fileInput = el('input', {
      type: 'file',
      accept: '.wav,audio/wav,audio/x-wav',
      style: { display: 'none' },
    });
    fileInput.addEventListener('change', () => {
      picked = (fileInput.files && fileInput.files[0]) || null;
      fileLabel.textContent = picked
        ? `${picked.name}（${(picked.size / 1024 / 1024).toFixed(2)} MB）`
        : '还没选文件';
    });

    const nameInput = el('input', { class: 'inp', type: 'text', placeholder: '例如：我的声音 / 讲解员小王', maxLength: 24 });
    const refTextInput = el('textarea', {
      placeholder: '这段录音里说的原话（可不填；填了音色更准，尤其是语气）',
      rows: 2,
    });

    const tip = el('div', { class: 'ds', style: { marginTop: '4px' }, text: '' });
    const okBtn = el('button', { class: 'btn sm', text: '确认添加' });

    const modal = el('div', { class: 'modal' }, [
      el('header', {}, [
        el('h3', { text: '添加我的音色' }),
        el('button', { class: 'icon-btn', style: { marginLeft: 'auto', width: '28px', height: '28px' }, text: '✕', onclick: () => close() }),
      ]),
      el('div', { class: 'modal-body' }, [
        el('div', { class: 'lbl', text: '① 参考音频（必须是真 WAV，5~15 秒最好）' }),
        el('div', { class: 'actions', style: { marginTop: '6px' } }, [
          el('button', { class: 'btn ghost sm', text: '选择 WAV 文件…', onclick: () => fileInput.click() }),
        ]),
        fileLabel,
        fileInput,
        el('div', { class: 'lbl', style: { marginTop: '14px' }, text: '② 给这个音色起个名字' }),
        nameInput,
        el('div', { class: 'lbl', style: { marginTop: '12px' }, text: '③ 这段录音里说的原话（可不填）' }),
        refTextInput,
        tip,
      ]),
      el('footer', {}, [
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn ghost sm', text: '取消', onclick: () => close() }),
        okBtn,
      ]),
    ]);

    const mask = el('div', { class: 'modal-mask', onclick: (e) => { if (e.target === mask) close(); } }, [modal]);
    function close() { mask.remove(); }
    $('#modal-root').appendChild(mask);

    okBtn.addEventListener('click', async () => {
      if (!picked) { tip.textContent = '先选一个 WAV 文件吧。'; tip.style.color = 'var(--warn)'; return; }
      if (!nameInput.value.trim()) { tip.textContent = '给它起个名字吧，不然列表里分不清。'; tip.style.color = 'var(--warn)'; return; }

      okBtn.disabled = true;
      okBtn.textContent = '上传中…';
      tip.textContent = '';
      try {
        const dataUrl = await readAsDataURL(picked);
        await api('/api/voices', {
          method: 'POST',
          body: {
            name: nameInput.value.trim(),
            refText: refTextInput.value.trim(),
            audio: dataUrl,
            originalName: picked.name,
          },
        });
        await reloadMyVoices();
        close();
        toast('音色已添加，点它一下就能用', 'ok');
      } catch (e) {
        tip.textContent = e.message;
        tip.style.color = 'var(--err)';
        okBtn.disabled = false;
        okBtn.textContent = '确认添加';
      }
    });
  }

  /** 删除自定义音色后回落到的默认预设 */
  const VOICE_RESET_PRESET = 'wenlv-guide-female';

  function bindVoice() {
    $('#voice-test').addEventListener('click', () => speakText($('#voice-test-text').value));
    const addBtn = $('#voice-add');
    if (addBtn) addBtn.addEventListener('click', openVoiceAdder);
    $('#voice-refresh').addEventListener('click', async () => {
      await refreshStatus();
      try {
        S.speakers = (await api('/api/tts/speakers')).speakers || [];
      } catch { S.speakers = []; }
      await reloadMyVoices();
      renderSpeakers();
      renderVoices();
      toast('已刷新语音服务状态', 'ok');
    });
    $('#voice-save').addEventListener('click', async () => {
      if (!S.card) return;
      try {
        await api(`/api/cards/${S.card.id}`, { method: 'PUT', body: { voice: { instruct: $('#voice-instruct').value } } });
        S.card = (await api('/api/cards')).cards.find(c => c.id === S.card.id);
        toast('语气指令已保存到角色卡', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  /* ========================================================================
   * 十二、外观：背景与形象
   * ======================================================================*/

  /** 把"当前背景"的完整对象找出来（内置 / 程序化 / 自定义三类里查） */
  function findBackground(id) {
    if (!id) return null;
    const all = [
      ...(S.backgrounds.procedural || []),
      ...(S.backgrounds.bundled || []),
      ...(S.backgrounds.custom || []),
    ];
    return all.find(b => b.id === id) || null;
  }

  /**
   * 应用背景。
   * 程序化背景会把角色卡主色当成调色板，所以换角色卡时整站（含背景）一起变色。
   */
  /**
   * 采样背景亮度（0~1）。
   *
   * 把背景画面画成 64×40 的缩略图再取像素，用的是人眼感受的亮度公式
   * （0.2126R + 0.7152G + 0.0722B），不是简单把 RGB 平均 —— 否则一张纯蓝背景
   * 会被误判成"亮"。
   * 优先取 #bg-canvas（程序化背景），其次 #bg-image（图片背景）。
   * 返回 null 表示暂时采不到：图片还没加载完，或者画布被跨域图片污染。
   */
  function sampleBgLuminance() {
    const W = 64;
    const H = 40;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    const cv = $('#bg-canvas');
    const img = $('#bg-image');
    try {
      if (cv && cv.width && cv.height) g.drawImage(cv, 0, 0, W, H);
      else if (img && img.naturalWidth) g.drawImage(img, 0, 0, W, H);
      else return null;
      const d = g.getImageData(0, 0, W, H).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      }
      return sum / (d.length / 4);
    } catch {
      return null;   // 画布被跨域图片污染时 getImageData 会抛错，交给调用方兜底
    }
  }

  /**
   * 把词云配色切到该有的档位。
   *
   * S.settings.wcInk 有四种取值：
   *   'auto'    按背景亮度自动决定（> 0.58 认为是亮背景 → 深色字）
   *   'light'   固定浅色字（深色背景用）
   *   'dark'    固定深色字（亮背景用）
   *   '#rrggbb' 主人自己在色板/取色器里挑的颜色
   *
   * 前三种只挂 data-wc-ink，颜色写在 CSS 里；第四种把 --wc-ink 直接写成内联样式
   * （内联优先级更高，会盖住 CSS 里的那两套预设）。
   * CSS 里所有词云颜色都是由 --wc-ink 推导的，所以这里只要给一个颜色就够了。
   *
   * 自动模式的阈值 0.58 是实测调的：极光那类深背景在 0.10~0.41，纸张类亮背景 0.95，
   * 中间空着一大片，免得背景稍微一变就来回切字色。
   */
  function applyCloudInk({ retry = 0 } = {}) {
    const layer = $('#wordcloud-layer');
    if (!layer) return;
    let ink = S.settings.wcInk || 'auto';
    const auto = ink === 'auto';
    if (auto) {
      const lum = sampleBgLuminance();
      if (lum === null) {
        // 图片背景还在加载 / 采样失败：短暂重试，再不行就按深色背景处理
        if (retry < 4) { setTimeout(() => applyCloudInk({ retry: retry + 1 }), 220); return; }
        S.bgLuminance = null;
        ink = 'light';
      } else {
        S.bgLuminance = +lum.toFixed(3);
        ink = lum > 0.58 ? 'dark' : 'light';
      }
    } else {
      S.bgLuminance = null;
    }

    const isHex = /^#[0-9a-f]{6}$/i.test(ink);
    if (isHex) {
      layer.dataset.wcInk = 'custom';
      layer.style.setProperty('--wc-ink', ink);
    } else {
      layer.style.removeProperty('--wc-ink');   // 清掉自定义色，回到 CSS 里的预设
      if (ink === 'dark') layer.dataset.wcInk = 'dark';
      else delete layer.dataset.wcInk;          // 浅色字是默认值，不用挂属性
    }
    syncInkControls();
    updateInkHint(ink, auto);
  }

  /** 把当前设置同步到界面：下拉框选项 + 色板高亮 + 取色器当前色 */
  function syncInkControls() {
    // 注意这里是按「设置里选的是什么」同步，而不是按自动判定出来的结果。
    // 自动模式下判定结果可能是"浅色字"，但下拉框必须显示"自动" ——
    // 否则用户一看下拉框是"浅色字"，会以为自己手动选了，然后再也回不到自动。
    const setting = S.settings.wcInk || 'auto';
    const isHex = /^#[0-9a-f]{6}$/i.test(setting);
    const sel = $('#wc-ink');
    if (sel) sel.value = isHex ? 'custom' : setting;
    if (isHex) {
      const picker = $('#wc-ink-custom');
      if (picker) picker.value = setting;
    }
    $$('#wc-ink-swatches .ink-sw').forEach((b) => {
      b.classList.toggle('on', String(b.dataset.ink).toLowerCase() === String(setting).toLowerCase());
    });
  }

  /** 把判定结果写到设置项下面那行小字，让人知道现在到底是什么颜色、为什么 */
  function updateInkHint(ink, auto) {
    const el = $('#wc-ink-hint');
    if (!el) return;
    const isHex = /^#[0-9a-f]{6}$/i.test(ink);
    if (!auto) {
      if (isHex) el.textContent = `固定用自定义色 ${ink.toUpperCase()}。想跟着背景走就选「自动」。`;
      else el.textContent = ink === 'dark' ? '固定用深色字（适合浅色背景）。' : '固定用浅色字（适合深色背景）。';
      return;
    }
    if (S.bgLuminance === null) {
      el.textContent = '自动：背景亮度测不准，暂按深色背景处理。';
      return;
    }
    el.textContent = `自动：实测背景亮度 ${Math.round(S.bgLuminance * 100)}% → 已切到${ink === 'dark' ? '深色字' : '浅色字'}。`;
  }

  function applyBackground(id, { silent } = {}) {
    if (!bg) return;
    let item = findBackground(id);
    // 找不到（比如自定义背景被删了）就退回默认的极光
    if (!item) {
      item = findBackground('proc-aurora') || { id: 'proc-plain', kind: 'procedural', renderer: 'plain', palette: [], label: '纯色' };
    }
    S.settings.backgroundId = item.id;
    bg.setPalette(tintPalette(item));
    bg.set(item);
    saveSettings();
    renderLookPreview();
    // 背景换了，词云字色要重新判定。
    // 延迟一点再采样：程序化背景是画布动画、图片背景要等 img 加载出像素
    // （applyCloudInk 内部还有几次重试兜底）。
    setTimeout(() => applyCloudInk(), 160);
    if (!silent && item.id !== 'proc-plain') toast(`背景已切换为「${item.label}」`, 'ok');
  }

  /**
   * 让 Aurora 这类背景跟随角色卡主色。
   * 只改 aurora（它本来就是"跟随主色的色相流动"），其余背景保留自己的配色 —— 
   * 樱花被染成绿色、山水被染成粉色都不好看。
   */
  function tintPalette(item) {
    if (!item || item.kind !== 'procedural') return null;
    if (item.renderer !== 'aurora') return item.palette;
    const accent = S.card && S.card.accent;
    if (!accent) return item.palette;
    // 以角色卡主色为起点，沿色相转两圈取三个点，得到同色系的渐层
    const hue = Number(hexToHue(accent));
    const mk = (dh, s, l) => hslToHex((hue + dh + 360) % 360, s, l);
    return [mk(0, 62, 68), mk(52, 58, 70), mk(-48, 60, 72)];
  }

  function hslToHex(h, s, l) {
    const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const c = l / 100 - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  /** 外观页里的两张预览：背景缩略图 + 形象立绘 */
  function renderLookPreview() {
    const item = findBackground(S.settings.backgroundId);
    const nameEl = $('#look-bg-name');
    const noteEl = $('#look-bg-note');
    const thumb = $('#look-bg-thumb');
    if (nameEl) nameEl.textContent = item ? item.label : '跟随主题';
    if (noteEl) noteEl.textContent = item ? (item.note || '') : '—';
    if (thumb && item) {
      const w = thumb.parentElement ? thumb.parentElement.clientWidth - 34 : 132;
      if (item.kind === 'image') {
        // 图片背景：直接把图铺到 canvas 上（等比裁切），省一个 <img> 节点
        const img = new Image();
        img.onload = () => {
          const c = thumb.getContext('2d');
          const cw = thumb.width; const ch = thumb.height;
          c.clearRect(0, 0, cw, ch);
          const scale = Math.max(cw / img.width, ch / img.height);
          const dw = img.width * scale; const dh = img.height * scale;
          c.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
        };
        img.src = item.url;
      } else {
        window.BackgroundManager.renderStatic(thumb, tintPalette(item) ? { ...item, palette: tintPalette(item) } : item, 132, 92);
      }
      void w;
    }

    const m = findDisplayModel(S.display.kind, S.display.id);
    const mName = $('#look-model-name');
    const mNote = $('#look-model-note');
    const mImg = $('#look-model-img');
    if (mName) mName.textContent = m ? m.label : '—';
    if (mNote) {
      if (!m) {
        mNote.textContent = '—';
      } else if (m.kind === '3d') {
        const size = m.bytes ? `${(m.bytes / 1024 / 1024).toFixed(1)} MB` : '';
        mNote.textContent = `3D · ${(m.format || 'glb').toUpperCase()}${size ? ` · ${size}` : ''} · three.js + three-vrm 渲染`;
      } else {
        mNote.textContent = `${m.motionGroups.length} 组动作 / ${m.motionCount} 个 · ${m.expressions.length} 个表情 · 口型同步${m.hasLipSync ? '支持' : '不支持'}`;
      }
    }
    if (mImg) {
      if (m && m.preview) { mImg.src = m.preview; mImg.style.display = ''; }
      else if (m && m.kind === '3d') {
        // 3D 模型暂时没有预览图时，用一枚图标占位（预览图生成脚本会补上）
        mImg.removeAttribute('src');
        mImg.style.display = 'none';
        const holder = mImg.parentElement;
        if (holder && !holder.querySelector('.look-3d-badge')) {
          holder.appendChild(el('div', { class: 'look-3d-badge', text: '3D' }));
        }
      } else {
        mImg.removeAttribute('src');
        mImg.style.display = 'none';
      }
    }
  }

  function bindLook() {
    $('#look-bg-pick').addEventListener('click', openBackgroundPicker);
    $('#look-model-pick').addEventListener('click', openModelPicker);
    $('#open-bg').addEventListener('click', openBackgroundPicker);
    $('#open-model').addEventListener('click', openModelPicker);

    $('#l2d-scale').addEventListener('input', (e) => {
      const v = Number(e.target.value) / 100;
      S.settings.l2dScale = v;
      $('#l2d-scale-label').textContent = `${e.target.value}%`;
      const st = activeStage();
      if (st) st.setScale(v);
    });
    $('#l2d-x').addEventListener('input', (e) => {
      S.settings.l2dX = Number(e.target.value);
      $('#l2d-x-label').textContent = e.target.value;
      const st = activeStage();
      if (st) st.setPosition(S.settings.l2dX, S.settings.l2dY);
    });
    $('#l2d-y').addEventListener('input', (e) => {
      S.settings.l2dY = Number(e.target.value);
      $('#l2d-y-label').textContent = e.target.value;
      const st = activeStage();
      if (st) st.setPosition(S.settings.l2dX, S.settings.l2dY);
    });
    $('#l2d-reset').addEventListener('click', () => {
      S.settings.l2dScale = 1; S.settings.l2dX = 0; S.settings.l2dY = 0;
      applySettingsToUI(); saveSettings();
      const st = activeStage();
      if (st) { st.setScale(1); st.setPosition(0, 0); }
      syncCloudInsets(); cloud.layout();
    });
    $('#l2d-save').addEventListener('click', async () => {
      if (!S.card) return;
      await api(`/api/cards/${S.card.id}`, {
        method: 'PUT',
        body: {
          live2d: {
            ...(S.card.live2d || {}),
            // kind 一定要一起存：不然下次进来不知道该用 Live2D 还是 3D 渲染器
            kind: S.display.kind,
            model: S.display.id,
            scale: S.settings.l2dScale,
            x: S.settings.l2dX,
            y: S.settings.l2dY,
            expression: S.settings.expression,
          },
        },
      });
      await reloadCards();
      toast('形象设置已保存到角色卡', 'ok');
    });

    $('#wc-enabled').addEventListener('change', (e) => {
      S.settings.wcEnabled = e.target.checked; saveSettings();
      $('#wordcloud-layer').style.display = e.target.checked ? '' : 'none';
      $('#btn-wc-toggle').classList.toggle('on', e.target.checked);
      if (e.target.checked) cloud.layout();
    });
    $('#wc-glow').addEventListener('change', (e) => { S.settings.wcGlow = e.target.checked; saveSettings(); cloud.setAnimate(e.target.checked); });
    $('#wc-density').addEventListener('input', (e) => {
      S.settings.wcDensity = Number(e.target.value);
      $('#wc-density-label').textContent = ['精简', '标准', '全部'][S.settings.wcDensity - 1] || '标准';
      saveSettings(); cloud.setDensity(S.settings.wcDensity);
    });
    // 词云字色：自动 / 浅色字 / 深色字 / 自定义
    $('#wc-ink').addEventListener('change', (e) => {
      const v = e.target.value;
      // 选「自定义」时用取色器里当前的颜色（取色器没动过就用它默认的那个青）
      const picker = $('#wc-ink-custom');
      S.settings.wcInk = (v === 'custom') ? ((picker && picker.value) || '#7fd4e8') : v;
      saveSettings();
      applyCloudInk();
    });
    // 色板：点一下就换成这个颜色，顺手把下拉框切到「自定义」
    $$('#wc-ink-swatches .ink-sw').forEach((btn) => {
      btn.addEventListener('click', () => {
        S.settings.wcInk = btn.dataset.ink;
        saveSettings();
        applyCloudInk();
      });
    });
    // 取色器：拖动时实时预览（不落盘），松手才存 —— 免得拖一下就写几十次设置
    const pickerEl = $('#wc-ink-custom');
    if (pickerEl) {
      pickerEl.addEventListener('input', (e) => {
        S.settings.wcInk = e.target.value;
        applyCloudInk();
      });
      pickerEl.addEventListener('change', (e) => {
        S.settings.wcInk = e.target.value;
        saveSettings();
        applyCloudInk();
      });
    }
  }

  /** 背景选择器：内置图片 + 程序化 + 自定义，三组一起给 */
  function openBackgroundPicker() {
    // 注意：这里必须是**普通容器**而不是 .pick-grid。
    // 分组标题和每组子网格都往它里面塞；如果它本身也是网格，
    // 标题就会变成网格的格子，整个布局会塌成两列 —— 这是实测踩过的坑。
    const grid = el('div', { class: 'pick-sections' });

    const makeCard = (item) => {
      const active = S.settings.backgroundId === item.id;
      const card = el('button', {
        class: `pick-card${active ? ' active' : ''}`,
        type: 'button',
        title: item.note || item.label,
      }, [
        document.createElement('canvas'),
        el('div', { class: 'pick-name', text: item.label }),
        el('div', { class: 'pick-note', text: item.kind === 'image' ? (item.bundled ? '内置图片' : '我的图片') : '程序化生成' }),
      ]);
      const canvas = card.querySelector('canvas');
      // 缩略图：图片用 drawImage，程序化用 renderStatic（只画一帧，不起动画）
      if (item.kind === 'image') {
        const img = new Image();
        img.onload = () => {
          const c = canvas.getContext('2d');
          canvas.width = 300; canvas.height = 192;
          const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
          c.drawImage(img, (canvas.width - img.width * scale) / 2, (canvas.height - img.height * scale) / 2, img.width * scale, img.height * scale);
        };
        img.onerror = () => { canvas.getContext('2d').fillText('图片加载失败', 8, 20); };
        img.src = item.url;
      } else {
        window.BackgroundManager.renderStatic(canvas, tintPalette(item) ? { ...item, palette: tintPalette(item) } : item, 150, 96);
      }

      if (!item.bundled && item.kind === 'image') {
        card.appendChild(el('button', {
          class: 'pick-del', text: '✕', title: '删除这张背景', type: 'button',
          onclick: async (e) => {
            e.stopPropagation();
            if (!confirm(`删除背景「${item.label}」？文件会从本机 data/backgrounds/ 移除。`)) return;
            try {
              await api(`/api/backgrounds/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
              S.backgrounds.custom = (S.backgrounds.custom || []).filter(x => x.id !== item.id);
              if (S.settings.backgroundId === item.id) applyBackground('proc-aurora', { silent: true });
              renderPickerGrid(grid);
              toast('已删除', 'ok');
            } catch (err) { toast(err.message, 'err'); }
          },
        }));
      }

      card.addEventListener('click', () => {
        applyBackground(item.id);
        grid.querySelectorAll('.pick-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
      });
      return card;
    };

    const renderPickerGrid = (host) => {
      host.innerHTML = '';
      const sec = (title, items) => {
        if (!items || !items.length) return;
        host.appendChild(el('div', { class: 'lbl', style: { marginTop: '4px' }, text: title }));
        const g = el('div', { class: 'pick-grid' });
        items.forEach(it => g.appendChild(makeCard(it)));
        host.appendChild(g);
      };
      sec('程序化背景（零素材体积，任意分辨率都清晰）', S.backgrounds.procedural);
      sec('内置图片（来自 Project AIRI）', S.backgrounds.bundled);
      sec('我上传的', S.backgrounds.custom);
      if (!(S.backgrounds.custom || []).length) {
        host.appendChild(el('div', { class: 'pick-hint', text: '还没有上传过背景。点上面的「上传图片」，选一张你自己的图即可——文件存在本机 data/backgrounds/，不会上传到任何地方。' }));
      }
    };

    const fileInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (!/^image\//.test(file.type)) return toast('请选择图片文件', 'err');
      try {
        toast('正在保存到本机…', 'ok');
        const dataUrl = await downscaleImage(await readAsDataURL(file), 1920, 0.9);
        const r = await api('/api/backgrounds', { method: 'POST', body: { image: dataUrl, name: file.name } });
        S.backgrounds.custom = (await api('/api/backgrounds')).custom;
        renderPickerGrid(grid);
        if (r.item) applyBackground(r.item.id);
        toast('背景已保存并应用', 'ok');
      } catch (err) { toast(`上传失败：${err.message}`, 'err', 5000); }
      fileInput.value = '';
    });

    const body = el('div', { class: 'body' }, [
      el('div', { class: 'pick-toolbar' }, [
        el('button', { class: 'btn sm', text: '📤 上传图片', onclick: () => fileInput.click() }),
        el('button', {
          class: 'btn ghost sm', text: '⟳ 重新读取',
          onclick: async () => {
            try {
              const d = await api('/api/backgrounds');
              S.backgrounds = { bundled: d.bundled, procedural: d.procedural, custom: d.custom };
              renderPickerGrid(grid);
              toast('已重新读取背景列表', 'ok');
            } catch (e) { toast(e.message, 'err'); }
          },
        }),
        fileInput,
      ]),
      el('div', { class: 'pick-hint', text: '内置图片与程序化背景都不需要联网；上传的图片保存在本机 data/backgrounds/。程序化背景是实时用 Canvas 画的，换成任意分辨率都不会糊。' }),
      grid,
    ]);

    renderPickerGrid(grid);

    const modal = el('div', { class: 'modal modal-wide' }, [
      el('header', {}, [
        el('h3', { text: '更换背景' }),
        el('button', { class: 'icon-btn', style: { marginLeft: 'auto', width: '28px', height: '28px' }, text: '✕', onclick: () => close() }),
      ]),
      body,
    ]);
    const mask = el('div', { class: 'modal-mask', onclick: (e) => { if (e.target === mask) close(); } }, [modal]);
    function close() { mask.remove(); }
    $('#modal-root').appendChild(mask);
  }

  /**
   * 形象选择器：Live2D（2D）与 3D（VRM / GLB）混在一个弹层里，
   * 用分组隔开。点一下立刻换上，并写进当前角色卡。
   */
  function openModelPicker() {
    // 普通容器，不是 .pick-grid —— 分组标题和每组子网格都往里塞，
    // 否则标题会变成网格的格子（这个坑在背景选择器那里踩过一次）
    const host = el('div', { class: 'pick-sections' });

    const makeCard = (m) => {
      const active = S.display.kind === m.kind && S.display.id === m.id;
      const is3d = m.kind === '3d';
      const note = is3d
        ? `3D · ${(m.format || 'glb').toUpperCase()}${m.bytes ? ` · ${(m.bytes / 1024 / 1024).toFixed(1)} MB` : ''}${m.format === 'vrm' ? ' · 支持口型与眨眼' : ''}`
        : `${m.motionGroups.length} 组动作 / ${m.motionCount} 个${m.expressions.length ? ` · ${m.expressions.length} 个表情` : ''}${m.hasLipSync ? ' · 支持口型同步' : ''}`;

      const card = el('button', {
        class: `pick-card${active ? ' active' : ''}`,
        type: 'button',
        title: m.note || m.label,
      }, [
        m.preview
          ? el('img', { class: 'pick-img pick-model-img', src: m.preview, alt: m.label })
          : el('div', { class: 'pick-img', style: { display: 'grid', placeItems: 'center', fontSize: '28px' }, text: is3d ? '🧊' : '🧍' }),
        el('div', { class: 'pick-name', text: m.label }),
        el('div', { class: 'pick-note', text: note }),
        ((m.tags && m.tags.length) || is3d)
          ? el('div', { class: 'pick-tags' }, [
            ...(m.tags || []).map(t => el('span', { class: 'pick-tag', text: t })),
            el('span', { class: 'pick-tag', text: is3d ? '3D' : '2D / Live2D' }),
          ])
          : null,
      ]);

      if (is3d && !m.bundled) {
        card.appendChild(el('button', {
          class: 'pick-del', text: '✕', title: '删除这个模型', type: 'button',
          onclick: async (e) => {
            e.stopPropagation();
            if (!confirm(`删除模型「${m.label}」？文件会从本机 data/models3d/ 移除。`)) return;
            try {
              await api(`/api/models3d/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
              const d = await api('/api/models3d');
              S.models3d = { ...S.models3d, bundled: d.bundled, custom: d.custom, formats: d.formats };
              if (S.display.kind === '3d' && S.display.id === m.id) {
                await switchDisplay('live2d', (S.l2dModels[0] && S.l2dModels[0].id) || '');
              }
              render(null);
              toast('已删除', 'ok');
            } catch (err) { toast(err.message, 'err'); }
          },
        }));
      }

      card.addEventListener('click', async () => {
        host.querySelectorAll('.pick-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        await switchDisplay(m.kind, m.id, { silent: true });
        // 写进角色卡：下次进来自动就是这个形象（kind 一起存，才知道用哪套渲染器）
        if (S.card) {
          await api(`/api/cards/${S.card.id}`, {
            method: 'PUT',
            body: { live2d: { ...(S.card.live2d || {}), kind: m.kind, model: m.id } },
          }).catch(() => { /* 存不上不影响这次切换 */ });
          await reloadCards();
          S.card = S.cards.find(c => c.id === S.card.id) || S.card;
        }
        renderLookPreview();
        renderExpressions();
        toast(`形象已切换为「${m.label}」`, 'ok');
      });
      return card;
    };

    const render = () => {
      host.innerHTML = '';
      const sec = (title, items) => {
        if (!items || !items.length) return;
        host.appendChild(el('div', { class: 'lbl', text: title }));
        const g = el('div', { class: 'pick-grid' });
        items.forEach(m => g.appendChild(makeCard(m)));
        host.appendChild(g);
      };
      sec('Live2D 形象（2D，PixiJS + Cubism）', S.l2dModels.map(m => ({ ...m, kind: 'live2d' })));
      sec('3D 形象（VRM / GLB，three.js）', (S.models3d.bundled || []));
      sec('我上传的 3D 模型', (S.models3d.custom || []));
      if (!(S.models3d.custom || []).length) {
        host.appendChild(el('div', {
          class: 'pick-hint',
          text: '还没有上传过 3D 模型。点上面的「📤 上传 VRM / GLB」，选一个你自己的 .vrm 或 .glb 文件即可——'
            + '文件存在本机 data/models3d/，不会上传到任何地方。',
        }));
      }
    };

    const fileInput = el('input', { type: 'file', accept: '.vrm,.glb,.gltf,model/gltf-binary,model/gltf+json', hidden: true });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      if (!['.vrm', '.glb', '.gltf'].includes(ext)) {
        return toast('请选择 .vrm / .glb / .gltf 文件', 'err', 5000);
      }
      if (file.size > 100 * 1024 * 1024) {
        return toast(`文件 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 100MB 上限`, 'err', 6000);
      }
      try {
        toast(`正在读取并保存到本机（${(file.size / 1024 / 1024).toFixed(1)}MB）…`, 'ok', 8000);
        const dataUrl = await readAsDataURL(file);   // 已经是 base64，不需要再走图片降采样
        const r = await api('/api/models3d', { method: 'POST', body: { model: dataUrl, name: file.name }, timeout: 600000 });
        const d = await api('/api/models3d');
        S.models3d = { ...S.models3d, bundled: d.bundled, custom: d.custom, formats: d.formats };
        render();
        if (r.item) {
          await switchDisplay('3d', r.item.id, { silent: true });
          if (S.card) {
            await api(`/api/cards/${S.card.id}`, {
              method: 'PUT',
              body: { live2d: { ...(S.card.live2d || {}), kind: '3d', model: r.item.id } },
            }).catch(() => { /* 忽略 */ });
            await reloadCards();
          }
          renderLookPreview();
          toast(`已保存并切换为「${r.item.label}」`, 'ok', 5000);
        }
      } catch (err) {
        // 后端会把"这文件不是 glTF"这类原因说清楚，原样透出给用户
        toast(String(err.message).split('\n')[0], 'err', 9000);
      }
    });

    const body = el('div', { class: 'body' }, [
      el('div', { class: 'pick-toolbar' }, [
        el('button', { class: 'btn sm', text: '📤 上传 VRM / GLB', onclick: () => fileInput.click() }),
        el('button', {
          class: 'btn ghost sm', text: '⟳ 重新读取',
          onclick: async () => {
            try {
              const d = await api('/api/models3d');
              S.models3d = { ...S.models3d, bundled: d.bundled, custom: d.custom, formats: d.formats };
              render();
              toast('已重新读取模型列表', 'ok');
            } catch (e) { toast(e.message, 'err'); }
          },
        }),
        fileInput,
      ]),
      el('div', {
        class: 'pick-hint',
        html: '**Live2D** 从 <code>public/models/</code> 读取，一套模型一个文件夹（需含 <code>.model3.json</code>）。'
          + '<br>**3D 形象**支持 <b>.vrm</b>（VRoid 虚拟形象，带骨骼与表情，能做眨眼与口型同步）与 <b>.glb</b>（glTF 二进制单文件）。'
          + '仓库不附带模型（版权原因），首次使用先跑一次根目录的「获取示例模型.bat」，或者在下面直接上传你自己的模型，文件只存在本机 <code>data/models3d/</code>。'
          + '<br>为什么不支持 .gltf：那个格式通常还要带一堆散装 .bin 与贴图，网页上"上传一个文件"没法把整包带上来，所以请导出成 .glb 或 .vrm。'
          + '<br>预览图是用真实渲染器离线生成的一帧；选中的形象会写进当前角色卡。',
      }),
      host,
    ]);

    render();

    const modal = el('div', { class: 'modal modal-wide' }, [
      el('header', {}, [
        el('h3', { text: '更换人物形象' }),
        el('button', { class: 'icon-btn', style: { marginLeft: 'auto', width: '28px', height: '28px' }, text: '✕', onclick: () => close() }),
      ]),
      body,
    ]);
    const mask = el('div', { class: 'modal-mask', onclick: (e) => { if (e.target === mask) close(); } }, [modal]);
    function close() { mask.remove(); }
    $('#modal-root').appendChild(mask);
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('读取文件失败'));
      r.readAsDataURL(file);
    });
  }

  function applySettingsToUI() {
    const s = S.settings;
    // 注意：自动朗读、记忆、视觉三个开关现在分别挂在顶栏按钮与角色卡编辑器里，
    // 不再有全局复选框，所以这里只需要同步"外观"页的控件。
    const set = (sel, val) => { const n = $(sel); if (n) n.checked = val; };
    set('#wc-enabled', s.wcEnabled);
    set('#wc-glow', s.wcGlow);
    const sc = $('#l2d-scale'); if (sc) { sc.value = Math.round((s.l2dScale || 1) * 100); $('#l2d-scale-label').textContent = `${sc.value}%`; }
    const sx = $('#l2d-x'); if (sx) { sx.value = s.l2dX || 0; $('#l2d-x-label').textContent = String(s.l2dX || 0); }
    const sy = $('#l2d-y'); if (sy) { sy.value = s.l2dY || 0; $('#l2d-y-label').textContent = String(s.l2dY || 0); }
    const wd = $('#wc-density'); if (wd) { wd.value = s.wcDensity || 2; $('#wc-density-label').textContent = ['精简', '标准', '全部'][(s.wcDensity || 2) - 1]; }
    const wk = $('#wc-ink');
    if (wk) wk.value = /^#[0-9a-f]{6}$/i.test(s.wcInk || '') ? 'custom' : (s.wcInk || 'auto');
    // 设置恢复完（可能刚从本地存储读回来）重判一次字色，保证界面显示的选项和实际生效的一致
    applyCloudInk();
    const wt = $('#btn-wc-toggle'); if (wt) wt.classList.toggle('on', s.wcEnabled);
    const st2 = $('#btn-speak-toggle'); if (st2) st2.classList.toggle('on', s.autospeak);
  }

  /** 简单的文本输入弹层（给"记住这个"用，避免 window.prompt 的样式割裂） */
  function askText(title, placeholder) {
    return new Promise((resolve) => {
      const input = el('textarea', { placeholder: placeholder || '' });
      const modal = el('div', { class: 'modal' }, [
        el('header', {}, [el('h3', { text: title })]),
        el('div', { class: 'body' }, [el('div', { class: 'field' }, [input])]),
        el('footer', {}, [
          el('button', { class: 'btn ghost sm', text: '取消', onclick: () => { mask.remove(); resolve(''); } }),
          el('button', { class: 'btn sm', text: '保存', onclick: () => { const v = input.value.trim(); mask.remove(); resolve(v); } }),
        ]),
      ]);
      const mask = el('div', { class: 'modal-mask' }, [modal]);
      $('#modal-root').appendChild(mask);
      input.focus();
    });
  }

  window.addEventListener('beforeunload', () => {
    saveHistory();
    if (S.cameraStream) S.cameraStream.getTracks().forEach(t => t.stop());
  });

  document.addEventListener('DOMContentLoaded', boot);

  /**
   * 测试钩子。
   *
   * 为什么需要：验收脚本要"切到第 N 个 3D 模型"时，如果只能靠模拟点击选择器里的卡片，
   * 就得去匹配卡片文案，一改文案脚本就碎。这里把几个稳定入口挂到 window 上，
   * 脚本调用它们走的是**和用户点选完全相同的代码路径**（不是绕过逻辑的后门），
   * 只是省掉了"找到那个按钮"的脆弱环节。
   */
  window.__wenlv = {
    get state() { return S; },
    switchDisplay,
    applyBackground,
    openBackgroundPicker,
    openModelPicker,
    activeStage,
    // 背景管理器实例。验收脚本要用它读实际生成出来的粒子数，
    // 验证"大屏上密度和小屏一致"（原来大屏会被数量上限截顶）。
    background: () => bg,
  };
})();
