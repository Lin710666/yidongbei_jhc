/* ============================================================================
 * app.js —— 智能文旅辅助系统 主程序
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
    // 听觉（本地 Whisper 语音输入）。enabled 取自服务端偏好，默认关闭。
    stt: { enabled: false, modelPresent: false, language: 'zh' },
    // 导航模式：形象举牌显示目标景点、背景跟着换。
    // 这里给一份默认值是为了让 loadNav() 读到的脏数据不会让后续代码拿到 undefined。
    nav: { on: false, spot: '', city: '', scenery: 'builtin', lastItem: '' },
    // 视频背景（大屏宣传片）。dir/count 由服务端给，recommended 是"名字里带西湖"的那个。
    videos: { items: [], recommended: null, dir: '', count: 0, maxMB: 0 },
    // 联网（工具调用）开关。默认关闭 —— 与后端 prefs 的默认值一致，
    // 页面加载后会从 /api/prefs 同步一次，避免两边说法不一致。
    webEnabled: false,
    // 用户是否亲手动过「游玩天数」控件（拖滑杆或点词云上的箭头）。
    // 只有动过才把天数当"用户明确填过"提交给后端；见 chatBaseFromPicks()。
    daysTouched: false,
    // 位置：status 是"我在哪"，relation 是"到某景点的距离与方位"
    geo: { status: null, relation: null },
    // 景区全景：缓存的等值柱状图列表与深度环境状态
    pano: { items: [], enabled: true, depthModelPresent: false },
    // 当前展示的人物形象。kind 决定用哪套渲染器：
    //   'live2d' -> Live2DStage（PixiJS + Cubism）
    //   '3d'     -> ThreeDStage（three.js + three-vrm，按需懒加载）
    //
    // id 是**兜底默认值**：启动时优先用当前角色卡里记着的形象
    // （见 initStage()），只有卡片没指定时才用这个。
    // 默认给「深闺藏衣袖」—— 国风形象和文旅主题更贴。
    display: { kind: 'live2d', id: 'cangyixiu' },
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
      backgroundId: 'proc-lake',     // 默认就是西湖美景（程序化；有宣传片时会自动换成视频）

      // 程序化待机：不依赖模型自带的 Idle 动作，持续给形象一点细微信号
      // （呼吸、微摆、视线游移，隔一阵自己抽一个小动作）。默认开。
      idleMotion: true,
      idleEveryMs: 14000,            // 每隔多久自动抽一个小动作

      // 开屏背景视频：用 data/videos/ 里的**本机文件**（空则自动挑，见 initBoot 的 getVideo）。
      // 需要新的片子：npm run fetch:bili -- <BV号> 名字
      bootVideo: '',
      bootMuted: false,              // 是否静音。默认**不静音**，但受浏览器自动播放策略限制，
                                     // 实际是"先静音起播、用户点 🔊 后出声"
      bootFit: 'rotate',             // rotate(逆时针90°) | cover(铺满裁剪) | auto(模糊铺底+完整显示)
    },
  };

  // 舞台上的浮动元素高度会作为词云的安全边距，避免互相遮挡。
  // 这里是兜底值，实际高度在 setCloudInsets() 里量出来覆盖。
  S.settings.wcInsets = { top: 58, right: 14, bottom: 58, left: 14 };

  let stage = null;        // Live2DStage 实例（用到才创建）
  let stage3d = null;      // ThreeDStage 实例（选了 3D 形象才懒加载）
  let bootScreen = null;    // 开屏实例（两套模板，见 public/js/boot.js）
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
    loadNav();
    applySettingsToUI();
    bindTabs();
    bindTopbar();
    bindComposer();
    bindWorkbenchToggle();   // 工作台的展开/收起（底部面板里默认折叠）
    bindTools();
    bindPlanner();
    bindMemory();
    bindCards();
    bindVoice();
    bindLook();
    bindVideos();
    bindProviders();
    bindWebPanel();
    bindGeoPanel();
    bindPanoPanel();
    bindI23DPanel();
    bindBlenderPanel();
    bindStage();
    initNavUI();
    bindStt();
    initBoot();

    // ★ 开屏要**立刻**出现，不能等到下面那一串 await 跑完。
    //
    // 原来这一句放在 boot() 的最末尾（等 refreshStatus / loadCapabilities /
    // loadWindows… 全部 await 完才弹），结果是：用户先看到主界面、舞台空空、
    // 过一两秒才"啪"地盖上开屏 —— 既像卡了一下，也不像"开场"。
    //
    // 现在放在所有异步动作之前同步执行：HTML 一解析完就盖上开屏，
    // 底下的主界面在开屏背后慢慢加载。开屏本身的背景（程序化西湖/视频）
    // 不依赖任何网络请求，所以这一步是瞬时且必然成功的。
    if (bootScreen) bootScreen.autoShow();

    cloud = new window.WordCloud($('#wordcloud-layer'), { onAction: handleWordAction, onStep: handleDaysStep });
    cloud.setAnimate(S.settings.wcGlow);
    cloud.setDensity(S.settings.wcDensity);
    cloud.setInsets(S.settings.wcInsets);
    $('#wordcloud-layer').style.display = S.settings.wcEnabled ? '' : 'none';

    // 背景管理器：图片与程序化背景都由它渲染。放在词云之后创建，
    // 这样它就是最早的一层，后面所有东西都叠在背景之上。
    bg = new window.BackgroundManager({ imageEl: $('#bg-image'), canvasEl: $('#bg-canvas'), videoEl: $('#bg-video') });
    bg.resize();

    // ---- 逐项加载，**每一项都自己吞异常** ----
    //
    // 为什么不能像原来那样一串 await 排下去：中间任何一项抛异常，
    // 后面所有 await 就都不执行了 —— 包括最后的 initStage()。
    // 用户看到的是"页面在、界面也在，但舞台上什么都没有"，
    // 而真正的报错发生在几千行之外的一个渲染函数里，极难对上号。
    // （实测踩过：renderLookPreview 读某个形象没有的字段抛 TypeError，
    //   导致 initStage() 被跳过，画布停在 300×150 一个像素都没画。）
    //
    // refreshStatus 不算在内：它是状态灯的数据源，失败时本身就会降级显示。
    await refreshStatus();

    const optionalLoads = [
      ['能力清单', loadCapabilities],
      ['模型接入配置', loadProviderConfig],
      ['对外开放配置', loadOpenAPIConfig],
      ['应用偏好', loadPrefs],
      ['位置', loadGeo],
      ['全景', loadPano],
      ['图片转 3D', loadI23D],
      ['Blender', loadBlender],
      ['听觉', loadStt],
      // 视频清单要给开屏用：模板 A 的第一帧就要决定播视频还是程序化兜底，
      // 拿晚了会先闪一下兜底画面再切到视频。
      ['视频背景', loadVideos],
    ];
    /* ★ 并行加载（原来是 for + await 串行）。
       这些加载之间**没有依赖**，串行等于把各自的往返时间相加 ——
       本机后端每个请求几十到几百毫秒，11 个串起来就是明显的启动延迟。
       改成 allSettled 并行后总耗时约等于最慢的那一个。
       失败仍然只记一条日志、继续往下（少一个面板能用，好过形象不出现）。 */
    await Promise.allSettled(optionalLoads.map(async ([label, fn]) => {
      try {
        await fn();
      } catch (e) {
        console.error(`[boot] ${label} 加载失败（不影响其它功能）：`, e && e.message ? e.message : e);
      }
    }));
    // 供性能测量/自动化测试读取：数据加载阶段结束的时刻
    window.__BOOT_DATA_MS__ = Math.round(performance.now());
    // 启动时**只做轻活**：填好开屏下拉选项即可。
    // 卡片（含 <video preload="metadata"> 缩略图）留到用户真打开「外观」页再建 ——
    // 那一页默认是隐藏的，启动时就建等于让看不见的缩略图去抢宣传片的带宽。
    try { renderVideos({ grid: false }); } catch { /* 外观页还没渲染也没关系 */ }
    // 视频清单到位后通知开屏：模板 A 若是先用了程序化西湖兜底，这时换成真视频
    if (bootScreen) { try { bootScreen.notifyVideosReady(); } catch { /* 忽略 */ } }

    // 背景要在拿到能力清单之后再恢复：那张清单里才有 palette 等信息
    //
    // 西湖优先：用户的诉求是"背景换成杭州文旅展示西湖美景的视频"。
    //   · data/videos/ 里有片子（尤其名字带西湖的）→ 直接用视频
    //   · 没有片子 → 用程序化绘制的西湖动态画面（proc-lake）
    // 只在用户**没有主动选过**别的背景时才自动套用视频，
    // 否则会出现"我明明选了樱花，一刷新又变成西湖"这种抢用户选择的行为。
    // 主界面用哪支片子 —— **优先级必须和"视频卡片高亮"一致**，否则会出现
    // "卡片上明明标着「主界面背景」，舞台上放的却是另一支"。
    //
    // 卡片高亮（renderVideos）读的是 S.settings.videoUrl（点「主界面」时写的，
    // 存在 localStorage），而刷新时这里原来只认服务端偏好 mainVideo ——
    // 这个后端把 /api/prefs 实现成了桩（video.main 恒为 ""），
    // 于是每次刷新都丢掉用户的选择、回落到列表第一支。
    // 现在统一成：本地选过的 videoUrl 优先 → 服务端偏好 → 名字带西湖的 → 列表第一支。
    const items = S.videos.items || [];
    // 用户是否主动选过**非默认**的程序化/图片背景。选过就不用视频去抢他的选择
    // （否则会出现"我明明选了樱花，一刷新又变成西湖"）。
    const userPickedBg = S.settings.backgroundId
      && !['proc-lake', 'proc-aurora'].includes(S.settings.backgroundId)
      && !String(S.settings.backgroundId).startsWith('video-');
    const byUrl = (url) => (url ? items.find(v => v.url === url) : null);
    const pickedVideo = byUrl(S.settings.videoUrl);
    const mainVideo = S.settings.mainVideo;
    const mainHit = mainVideo ? items.find(v => v.name === mainVideo) : null;
    const lakeVideo = S.videos.recommended;
    const chosenVideo = pickedVideo
      || (userPickedBg ? null : (mainHit || lakeVideo || items[0] || null));
    if (chosenVideo) {
      S.settings.backgroundId = `video-${chosenVideo.id}`;
      // 顺手把 videoUrl 对齐，卡片高亮与实际播放的片子从此永远同一支
      if (S.settings.videoUrl !== chosenVideo.url) {
        S.settings.videoUrl = chosenVideo.url;
        saveSettings();
      }
    }
    applyBackground(S.settings.backgroundId, { silent: true });

    /* ---- 断网恢复后自动补数据 ----
     * 启动时如果后端还没起来，上面那串 optionalLoads 会全部失败（各自记一条日志就跳过），
     * 界面看起来正常但功能是残的：没有能力清单、没有视频清单、状态灯不对。
     * 所以网络恢复后把这些重新拉一遍，用户不用手动刷新页面。
     * （重连本身由 public/js/wenlv-net.js 负责，这里只订阅它的恢复事件。） */
    if (window.WenlvNet) {
      window.WenlvNet.onOnline(async () => {
        try { await refreshStatus(); } catch { /* 忽略 */ }
        // 同样并行（理由见上面 optionalLoads 那段）
        await Promise.allSettled(optionalLoads.map(async ([label, fn]) => {
          try { await fn(); } catch (e) {
            console.warn(`[net] 恢复后重载「${label}」失败：`, e && e.message ? e.message : e);
          }
        }));
        try { renderVideos({ grid: false }); } catch { /* 忽略 */ }
        if (bootScreen) { try { bootScreen.notifyVideosReady(); } catch { /* 忽略 */ } }
        if (window.toast) window.toast('后端已恢复连接，数据已自动刷新', 'ok', 3000);
      });
    }

    initStage();
    renderHistory();
    // 形象加载好之后通知开屏：模板 B 下补一个迎宾动作
    // （开屏是页面一加载就盖上的，那时 stage 还没建出来）
    if (bootScreen) { try { bootScreen.notifyStageReady(); } catch { /* 忽略 */ } }

    if (!S.history.length) {
      // 首次进入：让角色主动打个招呼，而不是空白一片
      setTimeout(() => say(S.card ? S.card.greeting : '你好，我是你的文旅向导。', true), 900);

      /* ★ 这里原来还有个 1.8 秒的定时器，作用是"把工作台挂进对话输出区"。
         那条路已经不需要了 —— 工作台本体就在「文旅」页签里（同一页签），
         再挂一份是重复实例（见 startWorkbenchInChat 的说明）。

         而这个定时器**现在只剩副作用**：
           · 它会调 startWorkbenchInChat() → 强行把页签切回「文旅」——
             用户要是在这 1.8 秒里切到「外观」，会被硬拽回来
           · 它还会 expandWorkbench()，把"工作台默认折叠"顶开，
             于是折叠开关看起来像失效的（实测：默认状态根本没折叠）
         所以整段去掉。 */
    }
    // 开屏已经在 boot() 开头就播了（原因见那里的注释），这里不再重复调用。
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
    updateDaysWord();   // 词云建好后，把当前天数写进「游玩天数」那个控件
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

  /**
   * 所有可选形象的统一清单：Live2D 与 3D 混在一起，用 kind 区分。
   *
   * 曾经还有一套程序化绘制的「西湖船娘」排在最前面当默认形象；那套已经删了。
   * 现在的默认形象是 Live2D 的「深闺藏衣袖」（见 S.display 的注释）。
   */
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
   * 把「用户在词云上真的点过的条件」整理成结构化画像，随对话一起提交。
   *
   * 为什么要这个东西：后端的对话规划走 LLM 意图解析，而它对中文数字不敏感
   * （「两天 / 两个人」都解析不出来，会落回默认的 1 天 1 人）。但用户在界面上
   * 点过的条件是**确定**的 —— 后端那边有一套「结构化字段优先、对话补缺」的
   * 合并契约，只要把这些字段送上去，它们就会盖住模糊的解析结果。
   *
   * 为什么不能直接拿表单值：表单里天数默认 2、城市默认杭州，那是默认值、
   * 不是用户填的。全送上去的话，用户在聊天框说「帮我排苏州三天」会被默认值
   * 盖成「杭州 2 天」，比不合并还糟。所以只认 cloud.getSelected() 里点过的词。
   */
  function chatBaseFromPicks() {
    if (!cloud) return undefined;
    const picked = new Set(cloud.getSelected());
    if (!picked.size) return undefined;
    const words = (S.caps && S.caps.wordCloud) || [];
    const base = {};
    for (const w of words) {
      if (!picked.has(w.word)) continue;
      const p = w.payload || {};
      if (p.city !== undefined) base.city = p.city;
      // 天数：点「成都」这类词时 payload 也会带 days，而表单上确实显示了这个值，
      // 所以按「表单已填优先」的契约照收。用户想改就直接拖天数滑杆 / 点箭头。
      if (p.days !== undefined) base.days = p.days;
      if (p.budget !== undefined) base.budget = p.budget;
      if (p.crowd !== undefined) base.crowd = p.crowd;
      if (p.diet !== undefined) base.diet = p.diet;
      if (p.interests) base.interests = [...(base.interests || []), ...p.interests];
    }
    // 滑杆/箭头动过的话，以控件当前值为准（那是最明确的一次表达）
    if (S.daysTouched) {
      const input = $('#plan-days');
      if (input) base.days = Number(input.value) || base.days;
    }
    return Object.keys(base).length ? base : undefined;
  }

  /**
   * 词云上「游玩天数」两侧箭头的回调。
   *
   * 这里只改那个 range 的值、然后派发一个 input 事件 —— 剩下的同步
   * （表单里的数字标签、词云控件上显示的天数）全部交给 range 自己那条 input 链路处理。
   * 一条链路到底，免得两处各写一套、改一处忘一处。
   */
  function handleDaysStep(w, dir) {
    const input = $('#plan-days');
    if (!input) return;
    const min = Number(input.min) || 1;
    const max = Number(input.max) || 7;
    const cur = Number(input.value) || 2;
    const next = Math.min(max, Math.max(min, cur + dir));
    if (next === cur) {
      say(dir > 0 ? `最多 ${max} 天了` : `最少 ${min} 天`, true);
      return;
    }
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    say(`游玩天数：${next} 天`, true);
  }

  /** 把当前天数写到词云上的「游玩天数」控件里（形如「游玩天数 3天」） */
  function updateDaysWord() {
    if (!cloud) return;
    const input = $('#plan-days');
    const days = input ? (Number(input.value) || 2) : 2;
    cloud.setWordLabel('游玩天数', `游玩天数 ${days}天`);
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
    // 这组映射要跟词表（app/data/wordcloud.json）里的组名保持一致，
    // 改词表时这里也要跟着改，否则点完词该亮的红框不会亮。
    const MAP = [
      ['city', '目的地'],
      ['budget', '总预算'],
      ['crowd', '同行人群'],
      ['diet', '饮食禁忌'],
      ['pace', '游玩节奏'],
      ['transportation', '往返交通'],
    ];
    for (const [field, group] of MAP) {
      if (p[field] === undefined) continue;
      // 该组里代表这个值的词；找不到就表示这组不该有红框
      cloud.alignGroup(group, p[field]);
    }
    for (const [field, group] of [['interests', '兴趣导向'], ['avoidances', '讨厌的项目']]) {
      const vals = p[field];
      if (!vals) continue;
      for (const v of (Array.isArray(vals) ? vals : [vals])) cloud.alignGroup(group, v);
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

      // 产物词 / 跳转词：滚到工作台里对应的那一块并高亮一下。
      // 例：点「实时天气」→ 右侧滚到「实时天气预报」；点「景点备选」→
      // 先把第一个「换一个」展开（那块本来不渲染），再滚过去。
      // 这样词云就变成了这个项目产出的"目录"，而不只是一排入口。
      case 'focus': {
        const api = window.WenlvPlanner;
        const target = p.target || w.word;
        if (!api || typeof api.focus !== 'function') {
          say('行程规划工作台没挂上，先看看「文旅」面板里的提示。', true);
          break;
        }
        switchTab('tools');            // 产物在工作台里，得先让它可见
        say(`带你去看「${w.word}」。`, true);
        setTimeout(() => {
          try {
            const ok = api.focus(target);
            if (!ok) {
              // 注意别一律说"请先生成方案"：这次方案里本来就可能没有这一项
              // （比如这几天不下雨，就没有雨天备选），说错了会让人以为坏了。
              say(`「${w.word}」这次方案里还没有内容（没生成方案，或这次确实没这一项）。`, true);
            }
          } catch (e) {
            console.warn('[wenlv] focus 失败：', e);
          }
        }, 140);                        // 等面板切过来、滚动容器尺寸稳定再滚
        break;
      }

      // 条件词（目的地 / 预算 / 同行人群 / 兴趣 / 营销平台 …）：
      // 只把值填进表单并给它打上红框，**不立刻生成**。
      // 原来点一下就跑，根本没法把「杭州 + 舒适 + 亲子」这种组合凑出来。
      // 想跑的时候点「个性化方案」/「营销文案」。
      case 'pick': {
        // 可多选的组：这几组在词表里是"一组内可同时亮多个"
        const MULTI_GROUPS = new Set(['兴趣导向', '讨厌的项目', '饮食禁忌']);
        const on = cloud.toggleSelect(w.word, { multi: MULTI_GROUPS.has(w.group) });
        if (on) {
          // 注意第一个参数传 null（= 不切面板）。
          // 以前传 'tools'，于是每点一个条件词，右侧面板就被强行切走一次；
          // 面板一换会触发重新测量安全边距 → 词云整片重排 ——
          // 用户点完「杭州」想接着点「苏州」，所有词已经跑到别的位置去了，非常难用。
          // 条件填进表单本来就不需要用户盯着看，词云上的红框才是主要反馈；
          // 真要生成时（gen-plan / gen-marketing）再切过去也来得及。
          applyParamsToForm(null, p, { merge: true });
          alignPicksFromPayload(p);
          // 除了填那份（现在藏起来的）旧表单，还要把条件送进「文旅」面板里
          // 看得见的那张表（组员的工作台）。不然用户点完在工作台上看不到任何变化。
          syncPickToWorkbench(p, on);
          const picks = describePicks();
          say(picks ? `记下了：${picks}。都填进右边的工作台了，点「个性化方案」我就开工。` : `记下了：${w.word}`, true);
        } else {
          say(`取消：${w.word}`, true);
        }
        break;
      }

      // 「游玩天数」这个控件：点词本身就加一天，两侧的 ▼ ▲ 用来精细加减。
      // 少了这个 case 的话，点词本身会掉进 default 弹一句"暂未绑定动作" —— 很出戏。
      case 'days-stepper': {
        handleDaysStep(w, 1);
        break;
      }

      // 用词云上已经选好的条件生成
      case 'gen-plan': {
        say(pickLine('plan', {}), true);
        const api = window.WenlvPlanner;
        // 全屏词云下右侧面板整个是藏起来的，工作台根本看不见 ——
        // 那时候交给工作台生成，用户会觉得"点了没反应"。所以分两种情况：
        //   全屏 → 照旧走舞台上的结果卡（大字、两人并排，本来就是给展示用的）
        //   平时 → 交给工作台，结果直接长在表单下面（能改景点、换餐厅、看地图）
        const fullscreen = document.body.classList.contains('wc-full');
        if (api && typeof api.requestGenerate === 'function' && !fullscreen) {
          // 先把词云当前选中的条件补齐一遍（可能有词是在工作台就绪之前点的）
          const picked = new Set(cloud ? cloud.getSelected() : []);
          const words = (S.caps && S.caps.wordCloud) || [];
          for (const w of words) {
            if (picked.has(w.word) && w.payload) syncPickToWorkbench(w.payload, true);
          }
          syncDaysToWorkbench();
          switchTab('tools');
          setTimeout(() => {
            try {
              // 生成前先把折叠的工作台展开 —— 不然用户点完按钮、表单还折着，
              // 看起来像"点了没反应"
              expandWorkbench();
              api.requestGenerate();
            } catch (e) {
              toast(`工作台生成失败：${e && e.message ? e.message : e}`, 'err', 6000);
            }
          }, 120);   // 等一次渲染，确保刚同步进去的值已经落到表单上
          break;
        }
        // 全屏模式下走舞台结果卡；工作台没挂上时也走这条，别让按钮点了没反应
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

      // 产品研发：产出「产品概念卡」。
      // 赛题「4.题目介绍」把「产品研发」列为五大业务场景之一，也点名了
      // 「特色文创与服务产品创新赋能」这项能力，所以给它一条独立链路 ——
      // 原来只在营销主体里间接带一下。参数直接取词云上已经选好的客群与预算档位，
      // 不另开表单：产品概念的字段（组合要素 / 定价区间 / 风险前提）和
      // 方案、营销那两个表单都对不上，硬套只会让人更糊涂。
      case 'gen-product': {
        say(pickLine('product', p), true);
        const onCardP = openStageResult();
        if (!onCardP) switchTab('tools');
        await generate('product', {
          kind: p.kind,
          audience: collectMarketingParams().audience,
          budget: collectPlanParams().budget,
        });
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

      // 词云上的「让 AI 先问我」已去掉：那条走的是仿制的气泡问答。
      // 这个 action 保留成"直接打开文旅工作台本体"，兼容带旧 action 的自定义角色卡。
      case 'intake':
      case 'open-tools':
        await startWorkbenchInChat();
        break;

      case 'audit':
        switchTab('tools');
        toast('输出质检会在每次生成后自动运行，结果以黄色告警条显示', 'ok', 4200);
        say('每次生成完我都会拿本地样本库核对一遍，编造出来的商家名字跑不掉。', true);
        break;

      case 'export':
        if (!S.lastResult) { toast('还没有可导出的内容，先生成一次吧', 'err'); break; }
        // 导出成**带排版的 HTML**（封面抬头 + 正文 + 页脚，双击能看、Ctrl+P 存 PDF）。
        // 原来是把 Markdown 原样甩出去，用户拿到一坨 ## 和 | 管道还得自己再排。
        if (window.WenlvExport) {
          const r = window.WenlvExport.exportHtml(S.lastResult);
          toast(`已导出「${r.title}」（HTML，可直接打印成 PDF）`, 'ok', 4200);
        } else {
          download(`文旅方案_${new Date().toISOString().slice(0, 10)}.md`, S.lastResult);
          toast('已导出为 Markdown', 'ok');
        }
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

      case 'vision': {
        switchTab('tools');
        // 图片上传按钮是底部输入区的一部分，**已随输入区一起移除**了
        // （见 index.html 的说明）。所以这里不能再直接 click 一个不存在的元素
        // —— 那会抛 "Cannot read properties of null (reading 'click')"，
        // 而这是角色卡动作触发的路径，用户会在切卡时莫名看到报错。
        const fileInput = $('#file-input');
        if (fileInput) {
          fileInput.click();
        } else {
          toast('图片入口已随底部输入框一起移除；图片理解能力仍在「设置 → 视觉」里可用', 'warn', 5200);
        }
        break;
      }

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
    if (kind === 'product') {
      const k = (p && p.kind) || '产品';
      return `${k}的概念卡我来出，含卖点、定价区间和风险前提。`;
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

    /* ★ 一边吐字一边让形象动嘴。
     *
     * 这条路径上**没有音频**：TTS 是等整段文字生成完才开始合成的
     * （几秒到几十秒）。而字幕是从第一个字就开始出的 ——
     * 这段时间里如果形象嘴不动，看起来就是"它在念稿但没张嘴"。
     * 所以这里喂文本给舞台，由它按字幕节奏驱动口型。
     * 真音频一旦就绪，speak() 接上分析器会自然接管（舞台内部按优先级分支）。
     */
    const st = activeStage();
    if (st && st.talkTo) { try { st.talkTo(text); } catch { /* 忽略 */ } }
  }

  /**
   * 结束"说话"状态：字幕定稿或出错时调。
   * 不调的话文本驱动口型会停在最后一个字的开口量上（嘴一直张着）。
   */
  function endTalking() {
    const st = activeStage();
    if (st && st.stopTalking) { try { st.stopTalking(); } catch { /* 忽略 */ } }
  }

  function hideSubtitle() {
    setSubtitleVisible(false);
    // 字幕收起来了，形象也该闭嘴 —— 否则文本驱动口型会停在最后一个字的开口量上
    endTalking();
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
   * 结果卡里的排版。按内容结构分三种走法：
   *
   *   · 营销文案：「版本 A / 版本 B」两块 → 并排成两列（纵向高度砍半，一次看全两版）
   *   · 行程方案：「行程总览 + Day 1..N + 费用预估 + 替代方案」→
   *     把 Day 那几块横着排成一行，其余各占一整行
   *   · 其他 → 原样竖向排列
   *
   * 为什么不能"见到多个 h2 就当 A/B 分成两列"：行程方案有 7 个 h2，
   * 那样会把前 4 块塞左列、后 3 块塞右列，而「行程总览」是个 8 列的表格，
   * 挤进半列宽的 600px 里每列只剩 75px，字全被挤成竖着的一条一条 —— 实测就是这样，很难看。
   */
  function layoutResultBlock(node) {
    if (!node) return;
    node.classList.remove('is-columns', 'is-days');

    const blocks = Array.from(node.children);
    const firstH2 = blocks.findIndex((b) => b.tagName === 'H2');
    if (firstH2 < 0) return;

    // 从第一个 h2 开始按 h2 切段
    const groups = [];
    let cur = null;
    for (const b of blocks.slice(firstH2)) {
      if (b.tagName === 'H2') { cur = [b]; groups.push(cur); }
      else if (cur) cur.push(b);
    }
    if (groups.length < 2) return;

    const titleOf = (g) => (g[0].textContent || '').trim();
    const isDay = (t) => /^Day\s*\d+/i.test(t);
    const isVersion = (t) => /版本\s*[AB]|^[AB][版\s]/.test(t);

    const days = groups.filter((g) => isDay(titleOf(g)));
    const vers = groups.filter((g) => isVersion(titleOf(g)));

    const pre = blocks.slice(0, firstH2);
    const frag = document.createDocumentFragment();
    if (pre.length) {
      const preBox = document.createElement('div');
      preBox.className = 'result-pre';
      pre.forEach((b) => preBox.appendChild(b));
      frag.appendChild(preBox);
    }
    const mkCol = (g, cls) => {
      const box = document.createElement('div');
      box.className = cls;
      g.forEach((b) => box.appendChild(b));
      return box;
    };

    // ① 全是「版本 X」→ 两列并排
    if (vers.length >= 2 && vers.length === groups.length) {
      for (const g of groups) frag.appendChild(mkCol(g, 'result-col'));
      node.innerHTML = '';
      node.appendChild(frag);
      node.classList.add('is-columns');
      return;
    }

    // ② 有「Day N」→ 这几块横着排成一行，其余各占一整行
    if (days.length >= 2) {
      const daySet = new Set(days);
      let dayBox = null;
      for (const g of groups) {
        if (daySet.has(g)) {
          if (!dayBox) { dayBox = document.createElement('div'); dayBox.className = 'result-days'; frag.appendChild(dayBox); }
          dayBox.appendChild(mkCol(g, 'result-day'));
        } else {
          dayBox = null;                 // 中间插进别的块时，后面若还有 Day 就另起一行
          frag.appendChild(mkCol(g, 'result-block'));
        }
      }
      node.innerHTML = '';
      node.appendChild(frag);
      node.classList.add('is-days');
      return;
    }
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
        try { d = await res.json(); } catch { /* 服务整个没起来时返回的可能是非 JSON */ }
        // 502/503/504 基本都是"本机语音服务没在跑"。这时候要给一句能照着做的话，
        // 而不是把裸的 HTTP 状态码丢出去（用户看到「语音合成失败（HTTP 502）」只会一脸问号）。
        if (!d.error && (res.status === 502 || res.status === 503 || res.status === 504)) {
          throw new Error('本机语音服务没在运行。双击项目根目录的「start.bat」（或 tools\\start-tts.bat）把它起起来，再点一次朗读。');
        }
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

  /**
   * 把 S.history 铺进聊天记录。
   *
   * ★ 只在**日志还是空的**时候铺。
   *
   * 为什么必须加这个判断：boot() 里这一句排在十几个 await 之后（本机常态约 5 秒，
   * 但只要有一条 /api/chat/stream 在飞、后端串行处理，就会被拖到 30 秒以上）。
   * 用户在这个窗口里发消息，原来的 `log.innerHTML = ''` 就把它整条抹掉 ——
   * 界面上的表现是"我说完话，它忙了一会儿，然后什么都没回"。
   *
   * 实测（MutationObserver，probe-chat-dom.mjs）：
   *     + msg me      你好，你能做什么？
   *     + msg         🤖                    ← 流式气泡（空）
   *     + msg sys     🤖 正在理解需求，并检索真实景点与天气…
   *     - msg me / - msg / - msg sys        ← 三个节点被一起删掉
   *     + msg me      你好，你能做什么？      ← 只按 history 重建，回复没了
   *
   * 判据用"日志非空"而不是 S.busy，因为 S.busy 只覆盖闲聊那条路：
   * 方案那条（runPlanWith）既不设 busy，也不把结果写进 S.history，
   * 同样会被这次重建抹掉。而 renderHistory() 全程只在 boot() 里被调一次，
   * 所以"日志非空"只可能意味着"已经有实时内容了"。
   *
   * 这里宁可**少铺一次历史**（刷新页面就正常了），也不冒抹掉用户内容的风险。
   */
  function renderHistory() {
    const log = $('#chat-log');
    if (!log) return;
    if (log.children.length) {
      // 里面已经有实时内容（用户刚发的消息 / 正在流式的回复 / 方案卡片），
      // 重建只会弄丢它 —— 历史等下次刷新时自然会出现。
      scrollChat();
      return;
    }
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

  /* ========================================================================
   * 十一之二、「猜你想去」与「让 AI 先问我」
   *
   * 两件事放在一起，因为它们是同一个交互：**在对话里给一排可点的选项**，
   * 点一下就等于回答/选定了。
   *
   * 问哪些项不是拍脑袋定的：下面这 6 个键与 collectPlanParams() **一一对应**，
   * 只有能被后端规划链路真正吃掉的项才值得问 —— 问一堆答案用不上的问题，
   * 那不叫功能，那叫填表。
   * ======================================================================*/

  /** 「猜你想去」的随机池：都是样本库里有的城市/景区，点了就能直接出方案 */
  const SUGGEST_SPOTS = [
    '杭州', '苏州', '成都', '丽江', '西安',
    '西湖', '灵隐寺', '拙政园', '宽窄巷子', '丽江古城',
    '雷峰塔', '平江路', '大熊猫基地', '兵马俑', '玉龙雪山',
  ]

  /** 一条条问出来的项目 + 追问状态（ASK_ITEMS / askFlow）已随「让 AI 先问我」
   *  一并删除：那条是照着文旅工作台手搓的仿制问答。现在统一走工作台本体。 */

  /**
   * 跳到文旅展示栏。
   *
   * ★ 必须先切到**调试界面**（原始左右分栏）再切页签 ——
   *   默认形态下侧栏只剩底部那张卡，#pane-tools 是 display:none 的，
   *   直接 switchTab('tools') 等于往一个看不见的地方写，用户点「查看完整方案 ›」
   *   会觉得"点了没反应"。
   */
  function gotoPlanPane() {
    try { if (S && typeof S._debugApply === 'function') S._debugApply(true, { silent: true }); } catch { /* 忽略 */ }
    // 布局切换后 DOM 尺寸要下一帧才稳，延后一点再切页签
    setTimeout(() => {
      try { switchTab('tools'); } catch { /* 忽略 */ }
    }, 180);
  }

  /** 造一排可点词条 */
  function chipRow(items, onPick) {
    const box = el('div', { class: 'chat-suggest' });
    items.forEach((it) => {
      const b = el('button', { class: 'sg', type: 'button', text: it.label });
      if (it.note) b.appendChild(el('span', { class: 'sg-note', text: it.note }));
      b.addEventListener('click', () => onPick(it, b));
      box.appendChild(b);
    });
    return box;
  }

  /**
   * 「猜你想去」：进主界面时给三个随机地名。
   * 为什么是随机的：用户第一次进来不知道能问什么，给几个具体地名比
   * "请描述您的需求"有用得多 —— 点一下就直接出方案。
   */
  function postSuggest() {
    const pool = SUGGEST_SPOTS.slice();
    const pick3 = [];
    while (pick3.length < 3 && pool.length) {
      pick3.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    const bd = appendMsg('assistant', '**猜你想去** —— 点一个我直接给你排：');
    bd.appendChild(chipRow(pick3.map((s) => ({ label: s, value: s })), async (it) => {
      it.el && it.el.setAttribute('disabled', 'disabled');
      await runPlanWith({ city: it.value });
    }));
    // 顺带给一条入口：用户不知道要说什么时可以直接打开文旅工作台本体。
    // （原来这条指向"让 AI 先问我"的逐条追问，已按需求删除。）
    const alt = el('div', { class: 'chat-suggest' });
    const b = el('button', { class: 'sg', type: 'button', text: '不确定？打开文旅工作台 ›' });
    b.addEventListener('click', () => { startWorkbenchInChat(); });
    alt.appendChild(b);
    bd.appendChild(alt);
  }

  /** 用一组覆盖参数去跑文旅规划，并把结果反馈回对话 */
  /**
   * 「输入框里说的话」→ 工作台表单字段。
   *
   * 后端 /api/parse-preference 只返回**用户真说到的**字段（没提到的不出现），
   * 所以这里可以直接拿它盖在气泡答案上 —— 不会因为输入框里有句话，
   * 就把气泡选的城市天数一起冲掉。键名与 UserPreference 一致，这里翻译成表单字段。
   */
  function userPreferenceToForm(f) {
    const out = {};
    if (!f) return out;
    if (f.destination) out.destination = f.destination;
    if (f.duration_days) out.duration_days = Number(f.duration_days) || undefined;
    if (f.budget) out.budget = Number(f.budget) || undefined;
    if (f.travelers && typeof f.travelers === 'object') {
      const t = f.travelers;
      if (t.adults != null) out.adults = t.adults;
      if (t.children != null) out.children = t.children;
      if (t.elderly != null) out.elderly = t.elderly;
    }
    if (f.preferences && f.preferences.length) out.preferences = f.preferences;
    if (f.pace) out.pace = f.pace;
    if (f.transportation) out.transportation = f.transportation;
    if (f.dietary_restrictions && f.dietary_restrictions.length) {
      out.dietary_restrictions = f.dietary_restrictions.map((d) => WC_DIET_ALIAS[d] || d);
    }
    if (f.avoidances && f.avoidances.length) out.avoidances = f.avoidances;
    if (f.must_visit && f.must_visit.length) out.must_visit = f.must_visit;
    if (f.origin) out.origin = f.origin;
    if (f.start_date) out.start_date = f.start_date;
    return out;
  }

  /** 输入框里现在有没有内容（气泡那边要判断"能不能直接出方案"） */
  function chatInputText() {
    const el = $('#chat-input');
    return el ? String(el.value || '').trim() : '';
  }

  /**
   * 出方案（气泡「我选好了」与自由输入都走这里）。
   *
   * 三条规则（按需求定的）：
   *   ① 气泡**不必选完** —— 选了多少用多少；一个都没选、但输入框里有字，也照样出方案
   *   ② 输入框与气泡**冲突时以输入框为准**，但只覆盖输入框里真说到的字段
   *   ③ 生成交给**「文旅」模块**（组员那套工作台），所以结果就是
   *      PlanView 那套视图 —— 导航／点评／美团这些跳转按钮都在，
   *      与切到调试布局后在文旅页生成的完全一致
   */
  async function runPlanWith(overrides, typedText) {
    if (S.busy) { toast('正在生成，请稍等或点停止', 'err'); return; }

    // ① 气泡答案 → 工作台表单字段
    let patch = pickToWorkbench(overrides || {}) || {};

    // ② 输入框优先：只覆盖它真说到的字段。
    //    文字优先用调用方传进来的（sendMessage 会先清空输入框，事后再读就读不到了），
    //    没传才去读输入框当前内容（气泡「我选好了」那条路）。
    const typed = (typedText != null ? String(typedText) : chatInputText()).trim();
    let typedFields = {};
    if (typed) {
      try {
        const r = await fetch('/api/parse-preference', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: typed }),
        }).then((x) => x.json());
        typedFields = userPreferenceToForm(r && r.fields);
      } catch (e) {
        // 解析失败不该把生成卡住 —— 退化成"只按气泡走"
        console.warn('[wenlv] 解析输入框失败，退化为只按气泡：', e);
      }
    }
    patch = Object.assign(patch, typedFields);

    const api = window.WenlvPlanner;
    if (!api || typeof api.setPreference !== 'function' || typeof api.requestGenerate !== 'function') {
      toast('行程规划工作台没挂上，先用「文旅」面板里的表单生成。', 'err', 6000);
      return;
    }

    // 说出去了什么，让用户看得见（也能看出"输入框优先"有没有生效）
    const said = [];
    if (typed) said.push(`「${typed}」`);
    if (Object.keys(typedFields).length) said.push('（按你说的为准）');
    const userLine = typed ? `帮我排一个方案：${typed}` : `帮我排一个方案：${overrides && overrides.city ? overrides.city : ''}${overrides && overrides.days ? ' · ' + overrides.days + ' 天' : ''}`;
    appendMsg('user', userLine);
    // 进历史。原来这条路径从不写历史，方案聊完就没了（见 sendMessage 里的注释）。
    //
    // 去重：从输入框发消息时，sendMessage 已经存过用户原话（「帮我排个杭州两天」），
    // 这里那句是拼出来的（「帮我排一个方案：帮我排个杭州两天」）—— 两句都存会显得啰嗦。
    // 判断依据是"上一句用户消息里已经包含了这次的 typed 文本"，
    // 而工作台按钮 / 词云触发时没有上一条用户消息，照常存。
    const prevUser = [...S.history].reverse().find((m) => m.role === 'user');
    const dupOfPrev = !!(typed && prevUser && String(prevUser.content || '').includes(typed));
    if (!dupOfPrev) {
      S.history.push({ role: 'user', content: userLine });
      saveHistory();
    }
    const bd = appendMsg('assistant', `正在用「文旅」模块生成…${said.join('')}`);

    // ③ 填进工作台表单 → 触发工作台生成 → 跳到文旅页看结果
    try {
      api.setPreference(patch);
    } catch (e) {
      bd.innerHTML = renderMarkdown(`填写工作台表单失败：${e && e.message ? e.message : e}`);
      return;
    }
    // 不再强切布局：方案现在就渲染在这条对话框里，切到分栏反而会把宽洋洋的
    // 底部对话框变成右侧一条窄栏（450px），
    // 想看文旅页那份的话下面给了一个词条。
    setTimeout(() => {
      try {
        /* ★ 方案出来之后，**同一份 plan 也用文旅工作台那套视图渲染进这条对话框**。
           不是在外壳里复刻样式 —— 复刻永远有偏差（表格边框、分档标签、
           换景点/换餐厅的交互、导航·点评·美团跳转按钮），所以让工作台把生成好的
           plan 回传过来，这里用同一个 PlanView 组件挂上去，两处天然一致。 */
        let unsub = null;
        const stop = () => { if (unsub) { unsub(); unsub = null; } };
        if (typeof api.subscribePlan === 'function' && typeof api.renderPlan === 'function') {
          unsub = api.subscribePlan((plan) => {
            stop();
            try {
              const box = el('div', { class: 'plan-view-host' });
              bd.innerHTML = '';
              bd.appendChild(box);
              if (!api.renderPlan(box, plan)) {
                bd.textContent = '（方案渲染失败，可在右侧文旅页查看）';
                return;
              }
              bd.appendChild(chipRow([{ label: '在文旅页打开 ›', value: 'tools' }], () => {
                gotoPlanPane();
              }));
              /* ★ 方案本身也要进历史。
                 方案是**组件渲染出来的**（PlanView），不是一段文本，而历史存的是纯文本，
                 所以这里存一句"生成过什么"的摘要 —— 刷新后至少知道
                 "我问过杭州两天、它给过我一版"，而不是像原来那样整段对话凭空消失。
                 正文看文旅页 / 在文旅页重开那一版。 */
              const title = (plan && (plan.summary || plan.title)) || '旅行方案';
              S.history.push({ role: 'assistant', content: `（已生成方案：${title}）` });
              saveHistory();
              // 方案卡片是一屏高的内容，默认那条 105px 的缝里根本看不成样
              if (window.WenlvChatPane && window.WenlvChatPane.autoExpand) {
                window.WenlvChatPane.autoExpand();
              }
            } catch (e) {
              bd.textContent = `方案渲染出错：${e && e.message ? e.message : e}`;
            }
          });
          setTimeout(stop, 180000);   // 等不到就别一直挂着订阅
        }
        api.requestGenerate();
        if (typed) {
          const input = $('#chat-input');
          if (input) input.value = '';   // 输入框的内容已经被采用，清掉免得再发一次
        }
        bd.innerHTML = renderMarkdown(unsub
          ? '正在生成…方案出来会直接显示在这里。'
          : '已经交给「文旅」模块了，方案和跳转按钮都在文旅页里。');
        if (!unsub) {
          bd.appendChild(chipRow([{ label: '去文旅页看看 ›', value: 'tools' }], () => {
            gotoPlanPane();
          }));
        }
      } catch (e) {
        bd.innerHTML = renderMarkdown(`生成失败：${e && e.message ? e.message : e}`);
      }
    }, 220);
  }

  /**
   * 把文旅工作台调到用户面前。
   *
   * ## 这里原来做的事（以及为什么改了）
   *
   * 原来它会把组员那套 React 工作台**再挂一份**进对话流的消息里：
   * `renderWorkbench(host)` 在 `.workbench-host` 里起第二个 React root。
   * 当时是对的 —— 那会儿「对话」和「文旅」是两个页签，用户点在对话里，
   * 得让他在原地看到工作台。
   *
   * ## 现在为什么只要切页签
   *
   * 「对话」页签已经并进「文旅」了：**工作台本体就在这个页签里**
   * （`#wenlv-planner`，见 index.html）。再往对话流里挂一份就是
   * 同一个页签里出现两张一模一样的表单 —— 实测过两份各 323 个节点，
   * 而且**状态互不相通**：在聊天里换了景点，旁边那份表单完全不知道。
   *
   * 所以现在只做一件事：确保停在「文旅」页签、把工作台滚进视野。
   */
  function startWorkbenchInChat() {
    switchTab('tools');
    expandWorkbench();          // 用户点「开始规划」= 要填表，顺手把折叠展开
    const host = $('#wenlv-planner');
    if (host && host.scrollIntoView) {
      try { host.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* 忽略 */ }
    }
    return true;
  }

  /**
   * 【已不再使用】原来往对话流里挂第二份工作台的那段。
   *
   * 留在这里不删是为了好找 —— 搜索 `renderWorkbench` 会落到这里，
   * 而不是让人以为"工作台怎么没挂进对话"。合并页签之后这条路径
   * 只会造成重复实例，所以整段停用。
   *
   * @deprecated 用 startWorkbenchInChat()（切到「文旅」页签即可）
   */
  function _legacyWorkbenchInChat() {
    switchTab('chat');
    const log = $('#chat-log');
    if (!log) return;
    const api = window.WenlvPlanner || {};

    // 兜底：老 bundle 里没有 renderWorkbench → 直接切到「文旅」页签，
    // 别给用户一个死按钮（原来这里退回到气泡问答，那条链路已按需求删除）。
    if (typeof api.renderWorkbench !== 'function') {
      switchTab('tools');
      toast('工作台在当前页面里挂不上，已切到「文旅」页', 'warn', 4000);
      return;
    }

    // 已经挂过就只滚过去 —— 再挂一份就有两张一模一样的表单，用户分不清哪张算数
    const exist = log.querySelector('.workbench-host');
    if (exist) { scrollChat(); return; }

    const bd = appendMsg('assistant', '');
    bd.innerHTML = '';
    const host = el('div', { class: 'workbench-host' });
    bd.appendChild(host);
    if (!api.renderWorkbench(host)) {
      bd.textContent = '（文旅工作台没挂上，可点右侧「文旅」页查看）';
      return;
    }
    // 这一块是一整张表单，默认那条 105px 的缝里根本看不成样
    //
    // ★ 但"从开屏点对话页进来"这一次要跳过：用户要的正是**面板矮、人物大**
    //   那个布局（见 WenlvChatPane.collapse 的注释）。他要是想看表单，
    //   面板右上角那个 ⤢ 一按就展开，不存在"看不到"。
    const pane = window.WenlvChatPane;
    const skip = pane && pane.entryCompact && pane.entryCompact();
    if (!skip && pane && pane.autoExpand) {
      pane.autoExpand();
    }
  }

  /**
   * 「让 AI 先问我」这一整条链路（分批气泡 + 一问一答）已按需求**删除**，
   * 改为直接调用文旅模块本体 —— 见 startWorkbenchInChat()。
   *
   * 为什么删：气泡与逐条追问都是**照着文旅工作台手搓的仿制问答**，
   * 字段、顺序、候选值都可能跟真表单产生偏差（这正是"点了却对不上"的来源）。
   * 现在只有一条路径：把工作台那棵 React 组件树挂进来，
   * 和「文旅」页签里挂的是同一棵树、同一个 bundle，天然一致。
   */

  async function sendMessage() {
    if (S.busy) { toast('正在生成，请稍等或点停止', 'err'); return; }
    const input = $('#chat-input');
    // 输入区已移除（见 bindComposer 的说明）：这条函数现在没有调用方，
    // 但保留着以便"把输入框放回来"时直接可用。加一句守卫免得将来被误调时崩。
    if (!input) return;
    const text = input.value.trim();
    const image = S.visionImage;
    if (!text && !image) return;

    /* ★ 默认形态下，底部这条对话框就是**文旅入口**：
       打一句话直接出方案，不走闲聊。
       为什么不全走文旅：需求里说"对话所给与的效果就是文旅界面的功能"，
       而文旅那套要的是结构化画像（城市/天数/…）。所以这里从这句话里
       认出城市和天数，认不出来就退回普通对话 —— 宁可退，也别把
       "你好呀"这种话硬塞进规划链路里，那会出一份莫名其妙的方案。 */
    const inDefaultView = !document.body.classList.contains('debug');

    if (inDefaultView && text && !image) {
      const cityHit = SUGGEST_SPOTS.find((s) => text.includes(s));
      const dayHit = /(\d+)\s*天/.exec(text);
      if (cityHit || dayHit) {
        const over = {};
        if (cityHit) over.city = cityHit;
        if (dayHit) over.days = Number(dayHit[1]);
        input.value = '';
        appendMsg('user', text);
        /* ★ 走规划这条路也要进历史。
           原来这里只 appendMsg 画到界面上、然后直接 await runPlanWith 就 return 了 ——
           下面那两行 push/saveHistory 永远走不到，于是**方案对话一条都不进历史**，
           只有"你好"这种不带城市/天数的闲聊才存得下来。
           用户看到的现象就是"对话历史不会被保存"，而方案恰恰是他最想留住的。
           （实测：发「帮我排个杭州两天」→ localStorage 那条键全程 0 次写入。） */
        S.history.push({ role: 'user', content: text });
        saveHistory();
        await runPlanWith(over, text);
        return;
      }
    }

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

    // 走带工具的那条管线，条件是"联网开了 **或** 有形象可以指挥"。
    // 之前只看 S.webEnabled，于是关掉联网时模型根本拿不到 avatar_action，
    // 而形象动作压根不联网 —— 那种"想让它笑一个，它却说做不到"就是这么来的。
    const avatarCaps = currentAvatarCaps();
    const useAgent = S.webEnabled || !!avatarCaps;

    const stream = sse(useAgent ? '/api/agent' : '/api/chat/stream', {
      message: text,
      image,
      cardId: S.card && S.card.id,
      history: S.history.slice(-13, -1).filter(m => !m.image).map(m => ({ role: m.role, content: m.content })),
      // 词云上点过的条件一起送上去，让它们盖住 LLM 意图解析里模糊的部分。
      // 没点过任何条件时是 undefined，提交上去就等于没有——不影响纯对话。
      preference: chatBaseFromPicks(),
      // 把"这只形象会哪些动作"报给服务端，它才能校验名字并写进系统提示
      avatar: avatarCaps || undefined,
    }, (ev) => {
      if (ev.type === 'start') {
        setPill('#pill-model', 'busy', ev.model || '生成中');
        if (ev.agent) {
          const names = (ev.tools || []).join(' / ') || '（无工具）';
          // 别一律写"联网已开启"：现在带了形象控制工具，联网关着也会走这条管线，
          // 那样提示就成了假话（用户明明关了联网，却看到"联网已开启"）。
          const webOn = (ev.tools || []).some(n => n === 'web_search' || n === 'web_fetch' || n === 'find_panorama');
          appendMsg('system', `${webOn ? '🌐 联网已开启' : '🧰 工具模式'}，可用工具：${names}`, { kind: 'sys', raw: true });
        }
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
      } else if (ev.type === 'agent_round') {
        // 只在真的要调工具（轮数 > 1）时才提示轮次，否则每次提问都多一行噪音
        if (ev.round > 1) {
          appendMsg('system', `↻ 第 ${ev.round}/${ev.maxSteps} 轮：把工具结果交给模型继续作答`, { kind: 'sys', raw: true });
        }
        $('#composer-hint').textContent = '模型正在判断要不要联网查证…';
      } else if (ev.type === 'tool_start') {
        const a = ev.args || {};
        const arg = a.query || a.url || a.spot || a.motion || a.placard || '';
        const ico = ev.name === 'avatar_action' ? '🎭' : '🔍';
        appendMsg('system', `${ico} 调用 ${ev.name}${arg ? `：${arg}` : ''}`, { kind: 'sys', raw: true, id: `tool-${ev.name}-${Date.now()}` });
        const doing = ev.name === 'web_search' ? '联网搜索'
          : ev.name === 'web_fetch' ? '读取网页'
            : ev.name === 'find_panorama' ? '查找全景'
              : '安排形象动作';
        $('#composer-hint').textContent = `正在${doing}…`;
      } else if (ev.type === 'tool_result') {
        appendMsg('system', `${ev.ok ? '✅' : '❌'} ${ev.name} ${ev.ok ? '完成' : '失败'}：${ev.summary}${ev.ms ? `（${ev.ms}ms）` : ''}`, { kind: 'sys', raw: true });
        // 形象动作：服务端只负责把"要做什么"传下来，真正的播放只能在浏览器做 ——
        // 模型有哪些动作、表情叫什么，只有这里加载完模型才知道。
        if (ev.ok && ev.data && ev.data.avatar) runAvatarDirective(ev.data.avatar);
      } else if (ev.type === 'round_discard') {
        // 这段文字是模型调工具前的"过程话"，不是答案。已经从 delta 流进气泡里了，
        // 必须把它从答案区撤走，否则用户看到的结论开头会是一句没头没尾的自言自语。
        stopStream();
        acc = '';
        bd.classList.add('typing');
        bd.innerHTML = '';
        if (ev.text && ev.text.trim()) {
          appendMsg('system', `💭 模型的判断过程（非结论）：${ev.text.trim()}`, { kind: 'sys', raw: true });
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
      // 这一轮说完了 → 停掉文本驱动口型。
      // 后面如果 autospeak 开着，speakText 会接上真音频、由频谱驱动嘴型，
      // 两条路不冲突（舞台内部按 analyser > talking 的优先级分支）。
      endTalking();
    }
  }

  function setBusy(b) {
    // 这两个按钮属于**已被移除的底部输入区**（见 index.html 那段说明）。
    // 现在它们不存在了 —— 不判空的话，`null.disabled = ...` 会抛
    // "Cannot set properties of null"，而 setBusy 在每次生成前后都会被调，
    // 一抛就把生成链路整个打断（实测：词云点「个性化方案」直接失败，
    // 结果卡里只剩一句 14 字的错误提示）。
    const send = $('#btn-send');
    const stop = $('#btn-stop');
    if (send) send.disabled = b;
    if (stop) stop.hidden = !b;
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
    // 写右侧面板时，先在「文旅」里把原版工具那块展开 —— 见 revealLegacyTools 的说明
    if (!onStageResult) revealLegacyTools();
    out.textContent = '⏳ 正在调用本机大模型生成…';
    warn.innerHTML = '';
    S.busy = true;
    setBusy(true);

    const t0 = Date.now();
    // 服务端在排队时会发 notice 过来。原来这里只认 delta/done/error，
    // 于是"排了五分钟队"在界面上和"正在生成"长得一模一样 —— 用户只会觉得卡死了。
    let genNotice = '';
    const waitingText = () => `⏳ ${genNotice ? genNotice + ' ' : ''}正在调用本机大模型生成…已等待 ${Math.round((Date.now() - t0) / 1000)} 秒（首次调用需要把模型加载进显存）`;
    const tick = setInterval(() => { out.textContent = waitingText(); }, 1000);

    let acc = '';
    // 和聊天那边同一个道理：每来一条 delta 就把整篇 markdown 重渲一遍是 O(n²)。
    // 实测一次方案生成有 500 多条 delta，主线程被重绘占满后会反压住 fetch 的流，
    // 同一个接口用 node 直连只要 23 秒，在网页里却拖到 101 秒。
    // 这里按时间节流：内容一个字都不丢，只是渲染次数从「等于 delta 数」降到「每秒最多 12 次」。
    const GEN_REDRAW_MS = 80;
    let genTimer = 0;
    let genFirstDone = false;
    const renderGen = () => {
      genTimer = 0;
      out.innerHTML = renderMarkdown(acc);
      out.scrollTop = out.scrollHeight;
    };
    const flushGen = () => {
      if (!genFirstDone) { genFirstDone = true; renderGen(); return; }  // 第一个字立刻出，别让用户干等
      if (genTimer) return;                                             // 已排过一次，这次的 delta 并进 acc 就行
      genTimer = setTimeout(renderGen, GEN_REDRAW_MS);
    };
    const stopGen = () => { if (genTimer) { clearTimeout(genTimer); genTimer = 0; } };

    const stream = sse('/api/wenlv/generate', { type, params }, (ev) => {
      if (ev.type === 'notice') {
        // 排队中：把状态如实显示出来，别让用户以为程序卡死了。
        // 不 clearInterval —— 那一秒一次的 tick 会照着 waitingText() 重画，
        // 里面已经带上了 genNotice，停掉反而就不再刷新等待秒数了。
        genNotice = ev.text || '';
        out.textContent = waitingText();
      } else if (ev.type === 'delta') {
        acc += ev.text;
        clearInterval(tick);
        flushGen();
      } else if (ev.type === 'done') {
        clearInterval(tick);
        stopGen();                    // 别让排队中的那一帧盖掉定稿结果
        acc = ev.content || acc;
        S.lastResult = acc;
        out.innerHTML = renderMarkdown(acc);
        // 只有结果卡才排这个版：右侧面板本来就只有巴掌宽，再分列会挤成一条
        if (out.id === 'result-body') layoutResultBlock(out);

        /* ★ 方案也要进**对话框**，而且要和调试界面里那份**长得一样**。
           原来结果只写进 #result-body（舞台结果卡）或 #tools-output（文旅页），
           用户在底部对话框里问完，对话框里什么都没有 —— 看起来就像"没出方案"。
           现在把正文追加到聊天记录里，并挂上 `output` 类：
           那个类是文旅页方案输出区的样式（表格、标题、引用块），
           挂上它，同一份方案在两处的排版才一致 ——
           不加的话这里走的是聊天气泡样式，两份看着像两个东西。 */
        try {
          const bd = appendMsg('assistant', acc);
          bd.classList.add('plan-body', 'output');
        } catch { /* 忽略：聊天区不可用时不影响主流程 */ }
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
        stopGen();
        out.textContent = `⚠️ 生成失败\n\n${ev.error}`;
        toast(ev.error.split('\n')[0], 'err', 7000);
      }
    });

    S.currentStream = stream;
    try { await stream.promise; } catch (e) {
      if (e.name !== 'AbortError') out.textContent = `⚠️ 生成失败\n\n${e.message}`;
    } finally {
      clearInterval(tick);
      stopGen();
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
   * 十、人物形象（Live2D / 3D 两套渲染器，按所选形象切换）
   *
   * 为什么不把所有东西合到一个类里：Live2D 用 PixiJS + Cubism，
   * 3D 用 three.js + three-vrm，两套依赖完全不同。硬合会变成一个谁都不像
   * 的抽象层，还让"只用其中一套的用户"被迫下载另外一套的运行库
   * （three.js 就有 2.2MB）。
   * 所以：两个类，各自实现同一组方法（init/load/setScale/setPosition/
   * setExpression/playMotion/speak/resize/destroy，外加 startIdle/setPlacard/
   * setScenery），调用方通过 activeStage() 取。
   *
   * **新增一套舞台时最容易漏的是"同名接口"**：少一个方法，用户一切过去就会
   * 报 "xxx is not a function"。所以 test/avatar.js 里专门有一条交叉校验，
   * 逐个确认各套舞台都实现了这组方法。
   *
   * 注：曾经还有第三套 ——程序化绘制的「西湖船娘」（public/js/lake.js 里的
   * LakeAvatar）。那套人物形象已经整个删掉了；lake.js 现在只剩画西湖的景
   * （开屏与背景在用），不再提供形象。
   * ======================================================================*/

  /** 当前生效的渲染器实例 */
  function activeStage() {
    if (S.display.kind === '3d') return stage3d;
    return stage;
  }

  /**
   * 各画布互斥显示：谁来渲染就显示谁，其余藏起来省 GPU。
   *
   * 注意这里必须写**显式的 'block' / 'none'**，不能写空串。
   * CSS 里给 #stage3d-canvas 定了 `display: none` 作为默认值（避免首屏闪一下），
   * 如果这里设成空串，等于把内联样式删掉，CSS 的 none 又赢回来 —— 3D 画布永远不显示。
   * 这个坑实测踩过：画布其实已经渲染好了（能采样到像素），但用户看不到。
   *
   * **Live2D 与 3D 必须各有一块自己的画布**，不能共用 ——
   * 一块 canvas **只能有一种绘图上下文**：PIXI 要 WebGL（`getContext('webgl')`），
   * 谁先拿到另一个就直接返回 null，表现是"切过去一片空白"。
   * （原来还有第三块 #lake-canvas，跟着西湖船娘一起删了。）
   */
  function showCanvas(kind) {
    const l2d = $('#live2d-canvas');
    const c3d = $('#stage3d-canvas');
    if (l2d) l2d.style.display = kind === 'live2d' ? 'block' : 'none';
    if (c3d) c3d.style.display = kind === '3d' ? 'block' : 'none';
  }

  /**
   * 舞台上的提示层（"正在加载…" / "还没有可用的模型，请去下载"）。
   *
   * **必须用 `hidden` 属性，不能用 `classList` 的 `hidden` 类。**
   * 原来这里写的是 `classList.remove('hidden')` / `classList.add('hidden')`，
   * 但项目里压根没有 `.hidden` 这个 CSS 类 —— 显隐是靠 HTML 上的 `hidden` **属性**
   * 和 CSS 的 `.stage-empty[hidden] { display: none }` 控制的。
   * 于是两个函数全是空操作，元素带着初始的 `hidden` 属性一直藏着：
   *   · stageProblem() 设了文案却永远不显示 —— 加载中、加载失败、
   *     "还没有模型请双击获取示例模型.bat"这些提示用户一次都看不到
   *   · 舞台长时间空白，看起来像卡死了
   * 这类 bug 用肉眼极难发现（页面不报错，只是"少了一句话"）。
   */
  function stageProblem(msg) {
    const box = $('#stage-empty-msg');
    if (box) box.textContent = msg;
    const el = $('#stage-empty');
    if (el) el.hidden = false;          // 去掉 hidden 属性 → 显示
  }
  function stageOk() {
    const el = $('#stage-empty');
    if (el) el.hidden = true;           // 加上 hidden 属性 → 隐藏
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
    if (stage3d) return stage3d;    stageProblem('正在加载 3D 渲染器（three.js + three-vrm，约 2.2MB，只需加载一次）…');
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

  /** 点人物：各套渲染器共用的反馈 */
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

  /* ========================================================================
   * 十一、形象能力清单 与 服务端下发的动作指令
   *
   * 大模型看得到"这只形象会哪些动作"，才能真的指挥得动它。可那份清单只在
   * 浏览器里 —— 模型文件是前端加载的，服务端根本没解析过。所以每次提问都把
   * 清单随请求上报，服务端据此校验名字并把它写进系统提示（见 server.js 的
   * runAgentPipeline）。少了这一环，模型只能照训练数据里的 wave、smile 猜，
   * 而真实动作名是 00_idle、tap_body_01 这类，猜不中的表现就是"它说挥手了，
   * 可形象一动不动"。
   * ======================================================================*/

  /** 当前形象的可用动作/表情。拿不到就返回 null（服务端会跳过校验） */
  function currentAvatarCaps() {
    const st = activeStage();
    if (!st || !st.model) return null;
    let motions = [];
    let expressions = [];
    try { motions = (st.listMotions && st.listMotions()) || []; } catch { /* 忽略 */ }
    try {
      expressions = st.expressions && st.expressions.length ? st.expressions : (st.expressionNames ? st.expressionNames() : []);
    } catch { /* 忽略 */ }
    return {
      label: (S.display && S.display.id) || '',
      kind: S.display && S.display.kind,
      motions: motions.map(m => ({ name: m.name, group: m.group })),
      expressions,
    };
  }

  /**
   * 执行服务端下发的形象指令（avatar_action 工具的产物）。
   *
   * 服务端只把意图传下来（"播 tap_body_01""举牌 杭州西湖"），真正的解析与
   * 播放在这里做：动作名允许模糊匹配、找不到就退化，牌子是现画的。
   * 这里任何一步失败都只记一条提示，绝不抛出去打断正在进行的对话流。
   */
  async function runAvatarDirective(d) {
    if (!d || typeof d !== 'object') return;
    const st = activeStage();
    if (!st) return;

    if (d.expression) {
      try { await st.setExpression(d.expression); } catch { /* 忽略 */ }
    }
    if (d.motion) {
      try {
        // 优先按名字精确/模糊匹配；匹配不到再当成组名随机播
        const byName = st.playMotionByName ? await st.playMotionByName(d.motion) : false;
        if (!byName) await st.playMotion(d.motion);
      } catch { /* 忽略 */ }
    }
    if ('placard' in d) {
      try {
        if (d.placard) {
          const ok = await st.setPlacard(d.placard);
          if (ok) {
            S.nav.lastItem = d.placard;
            saveNav();
            // 举牌的内容就是"上次对话里出现的导航项目"，顺手同步到导航条
            const el = $('#nav-spot');
            if (el && !el.value) el.value = d.placard;
          }
        } else {
          st.clearPlacard();
        }
      } catch { /* 忽略 */ }
    }
  }

  /* ========================================================================
   * 十三、听觉（本地 Whisper 语音输入）   *
   * 与"声音"页那套 TTS 是一对：那边让它说，这边让它听。
   *
   * 默认关闭，而且是**服务端偏好**（不是本地 localStorage）—— 因为"载不载那个
   * 1GB 的模型"是服务端的事。开关关着时 /api/stt 会被 lib/stt.js 直接挡回去，
   * 前端连麦克风按钮都不显示，所以用户不会点了才发现没反应。
   *
   * 音频链路：MediaRecorder 录 webm/opus → 前端解码并重采样成 16kHz 单声道
   * 16-bit WAV → base64 交 /api/stt。之所以在前端转格式，是为了让后端不必依赖
   * ffmpeg（这台机器上不一定有），后端只要能读 WAV 就够了。
   * ======================================================================*/

  function sttHint(text, warn) {
    const el = $('#stt-status');
    if (el) { el.textContent = text; el.style.color = warn ? 'var(--tertiary)' : ''; }
  }

  /** 刷新按钮可见性：开关开着 **且** 浏览器支持录音才显示 */
  function syncMicButton() {
    const btn = $('#btn-mic');
    if (!btn) return;
    const supported = !!(window.WenlvVoice && window.WenlvVoice.isSupported());
    btn.hidden = !(S.stt.enabled && supported);
  }

  async function loadStt() {
    if (!$('#stt-enabled')) return;
    try {
      const r = await api('/api/stt');
      const s = r.status || {};
      S.stt.enabled = !!s.enabled;
      // 注意字段名：quickStatus() 给的是 modelPresent（权重在不在磁盘上），
      // 不是 modelReady/available —— 后两个要起 Python 探测才知道，那是「检测环境」
      // 按钮的活儿。这里读错字段会让界面永远显示"环境不完整"。
      S.stt.modelPresent = !!s.modelPresent;
      S.stt.language = s.language || 'zh';
      const cb = $('#stt-enabled');
      if (cb) cb.checked = S.stt.enabled;
      if (S.stt.enabled) {
        sttHint(S.stt.modelPresent
          ? '已启用，权重已就绪（Python 环境可点「检测环境」确认）。'
          : `已启用，但还没有 Whisper 权重：${s.modelDir || ''} —— 先跑 npm run fetch:whisper`, !S.stt.modelPresent);
      } else {
        sttHint('未启用（默认关闭）。');
      }
    } catch (e) {
      sttHint(`读取状态失败：${String(e.message || e).split('\n')[0]}`, true);
    }
    syncMicButton();
  }

  function bindStt() {
    if (!$('#stt-enabled')) return;

    const cb = $('#stt-enabled');
    cb.addEventListener('change', async () => {
      try {
        await api('/api/prefs', { method: 'PUT', body: { stt: { enabled: cb.checked } } });
        S.stt.enabled = cb.checked;
        await loadStt();
        toast(cb.checked ? '听觉已开启。输入框旁边的 🎤 可以录话了。' : '听觉已关闭。', 'ok', 4000);
      } catch (e) {
        cb.checked = !cb.checked;      // 写失败就把勾选状态退回去，别让界面说谎
        toast(`保存失败：${String(e.message || e).split('\n')[0]}`, 'err', 8000);
      }
    });

    const probe = $('#stt-probe');
    if (probe) {
      probe.addEventListener('click', async () => {
        const old = probe.textContent;
        probe.disabled = true;
        probe.textContent = '检测中…';
        sttHint('正在起一次 Python 探测环境（import torch 要十几秒，请稍候）…');
        try {
          // 真探测要起 Python，所以做成显式按钮而不是自动跑
          const r = await api('/api/stt/status', { method: 'POST', body: {} });
          const env = r.env || {};
          S.stt.envReady = !!env.available;
          sttHint(env.available
            ? `环境可用：${env.python}`
            : `环境不完整：${env.reason || '原因未知'}`, !env.available);
        } catch (e) {
          sttHint(`检测失败：${String(e.message || e).split('\n')[0]}`, true);
        } finally {
          probe.disabled = false;
          probe.textContent = old;
          syncMicButton();
        }
      });
    }

    // 麦克风按钮：点一下开始录，再点一下结束并识别（不用"按住说话"，
    // 因为按住这种交互在触屏和键鼠上都不好做无障碍）
    const mic = $('#btn-mic');
    if (mic) {
      mic.addEventListener('click', async () => {
        const V = window.WenlvVoice;
        if (!V) return;
        const state = V.getState();

        if (state === 'recording') {
          mic.classList.remove('rec');
          mic.textContent = '🎤';
          $('#composer-hint').textContent = '正在识别…';
          try {
            const blob = await V.stop();
            const r = await V.transcribe(blob, { language: (S.stt.language || 'zh') });
            const input = $('#chat-input');
            if (input) {
              // 追加而不是覆盖：用户可能已经打了一半字
              input.value = (input.value ? `${input.value} ` : '') + r.text;
              input.focus();
            }
            $('#composer-hint').textContent = r.text ? '识别完成，确认后发送。' : '没听清（可能是静音或太短）。';
          } catch (e) {
            const code = e && e.code;
            $('#composer-hint').textContent = code === 'STT_DISABLED'
              ? '听觉没打开，请到「声音」页启用。'
              : `识别失败：${String((e && e.message) || e).split('\n')[0]}`;
          }
          return;
        }

        try {
          await V.start();
          mic.classList.add('rec');
          mic.textContent = '⏹';
          $('#composer-hint').textContent = '正在录音…再点一下结束。';
        } catch (e) {
          // 最常见的是用户拒绝了麦克风权限，说清楚该去哪改
          const msg = String((e && e.message) || e);
          $('#composer-hint').textContent = /permission|denied|NotAllowed/i.test(msg)
            ? '麦克风权限被拒绝。请在浏览器地址栏的权限设置里允许后重试。'
            : `无法开始录音：${msg.split('\n')[0]}`;
        }
      });

      // Esc 取消录音：录错了不用等它转完
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const V = window.WenlvVoice;
        if (!V || V.getState() !== 'recording') return;
        try { V.cancel(); } catch { /* 忽略 */ }
        mic.classList.remove('rec');
        mic.textContent = '🎤';
        $('#composer-hint').textContent = '已取消录音。';
      });
    }
  }


  /**
   * 拉取视频背景清单。
   *
   * 失败不抛错：视频是**加分项**，没有它照样能用（背景会退回程序化西湖动态画面）。
   * 让它把启动流程搞挂是本末倒置。
   */
  async function loadVideos() {
    try {
      const r = await api('/api/videos');
      S.videos = {
        items: r.items || [],
        recommended: (r.status && r.status.recommended) || null,
        dir: (r.status && r.status.dir) || '',
        count: (r.status && r.status.count) || 0,
        maxMB: (r.status && r.status.maxMB) || 0,
      };
    } catch {
      S.videos = { items: [], recommended: null, dir: '', count: 0, maxMB: 0 };
    }
    return S.videos;
  }


  /* ========================================================================
   * 十五、视频背景与开屏模板的设置面板
   *
   * 两件事放在一起，因为它们都属于"这台机器是拿来做大屏宣传的"这个场景：
   * 换片子、换开屏样式，是展厅现场最常被要求的两个改动。
   * ======================================================================*/

  function videoHint(text, warn) {
    const el = $('#video-hint');
    if (el) { el.textContent = text; el.style.color = warn ? 'var(--tertiary)' : ''; }
  }

  /**
   * 渲染视频卡片区。
   *
   * ★ opts.grid=false：只做"轻活"（目录提示、开屏下拉选项），**不建卡片**。
   *   为什么需要它：卡片里每张都是一个 <video preload="metadata"> 缩略图，
   *   3 支片子就要各拉一次媒体头部 —— 而这些卡片所在的「外观」页签默认是
   *   隐藏的（body:not(.debug) 下整个 .side 只剩对话页）。启动时渲染它们，
   *   等于让用户没机会看到的缩略图去和开屏宣传片抢带宽。
   *   所以启动时只跑轻活，卡片等真正切到「外观」页再建（见 switchTab）。
   */
  function renderVideos(opts) {
    const skipGrid = !!(opts && opts.grid === false);
    const box = $('#video-list');
    const dir = $('#video-dir');
    if (dir) dir.textContent = S.videos.dir || 'data/videos/';
    const maxEl = $('#video-maxmb');
    if (maxEl) maxEl.textContent = `${S.videos.maxMB || 300}MB`;
    // 开屏那个下拉的选项来源就是这个列表：上传/删除之后要跟着刷新，
    // 否则新片子在开屏设置里选不到（要刷新整页才行，很别扭）。
    // 这一步很便宜（只是填 <option>），所以启动时也做。
    if (typeof S._fillBootVideoSel === 'function') { try { S._fillBootVideoSel(); } catch { /* 忽略 */ } }
    if (!box || skipGrid) return;
    box.innerHTML = '';

    const items = S.videos.items || [];
    if (!items.length) {
      box.appendChild(el('div', {
        class: 'pick-hint',
        text: `还没有视频。把宣传片放进 ${S.videos.dir || 'data/videos/'}，或点上面的「上传视频」。`,
      }));
    }
    const current = S.settings.videoUrl || '';
    items.forEach(v => {
      const active = current === v.url || (!current && S.videos.recommended && S.videos.recommended.id === v.id);
      const isBoot = S.settings.bootVideo === v.name;

      // 缩略图：直接拿 <video> 当封面（preload=metadata 只拉头部，不下载整片）。
      // 比放一枚 🎬 图标强得多 —— 用户是在几张宣传片里挑，看不到画面等于盲选。
      const thumb = el('video', {
        class: 'pick-video-thumb',
        src: `${v.url}#t=1.2`,        // 定位到 1.2 秒取一帧，避免首帧黑场
        preload: 'metadata',
        muted: true,
        playsinline: true,
      });
      thumb.addEventListener('loadeddata', () => { try { thumb.currentTime = 1.2; } catch { /* 忽略 */ } });

      const card = el('div', {
        class: `pick-card pick-card-video${active ? ' active' : ''}`,
        title: v.id,
      }, [
        el('div', { class: 'pick-img' }, [thumb]),
        el('div', { class: 'pick-name', text: v.name || v.id }),
        el('div', {
          class: 'pick-note',
          text: `${(v.bytes / 1024 / 1024).toFixed(1)} MB`
            + `${v.recommended ? ' · 名字含西湖' : ''}`
            + `${active ? ' · 主界面背景' : ''}${isBoot ? ' · 开屏背景' : ''}`,
        }),
        el('div', { class: 'pick-video-actions' }, [
          el('button', {
            class: 'mini-btn', type: 'button', text: '🖥 主界面',
            title: '设为主界面舞台的背景',
            onclick: (e) => {
              e.stopPropagation();
              S.settings.videoUrl = v.url;
              saveSettings();
              // 立刻切过去，让用户马上看到效果 —— 大屏场景下"点完没反应"最让人慌
              applyBackground(`video-${v.id}`, { silent: true });
              api('/api/prefs', { method: 'PUT', body: { video: { main: v.name } } }).catch(() => { /* 忽略 */ });
              renderVideos();
              toast(`主界面背景已设为「${v.name || v.id}」`, 'ok');
            },
          }),
          el('button', {
            class: 'mini-btn', type: 'button', text: '🎬 开屏',
            title: '设为开屏背景',
            onclick: (e) => {
              e.stopPropagation();
              S.settings.bootVideo = v.name;
              saveSettings();
              api('/api/prefs', { method: 'PUT', body: { boot: { video: v.name } } }).catch(() => { /* 忽略 */ });
              if (typeof S._fillBootVideoSel === 'function') { try { S._fillBootVideoSel(); } catch { /* 忽略 */ } }
              renderVideos();
              toast(`开屏背景已设为「${v.name || v.id}」`, 'ok');
            },
          }),
          el('button', {
            class: 'mini-btn', type: 'button', text: '✕',
            title: '删除这个视频',
            onclick: async (e) => {
              e.stopPropagation();
              if (!confirm(`删除视频「${v.name || v.id}」？文件会从本机移除。`)) return;
              try {
                await api(`/api/videos/${encodeURIComponent(v.id)}`, { method: 'DELETE' });
                if (S.settings.videoUrl === v.url) { S.settings.videoUrl = ''; saveSettings(); }
                if (S.settings.bootVideo === v.name) { S.settings.bootVideo = ''; saveSettings(); }
                await loadVideos();
                renderVideos();
                toast('已删除', 'ok');
              } catch (err) { toast(err.message, 'err'); }
            },
          }),
        ]),
      ]);
      // 点卡片本身 = 设为主界面背景（和以前一致）
      card.addEventListener('click', () => {
        S.settings.videoUrl = v.url;
        saveSettings();
        applyBackground(`video-${v.id}`, { silent: true });
        api('/api/prefs', { method: 'PUT', body: { video: { main: v.name } } }).catch(() => { /* 忽略 */ });
        renderVideos();
        toast(`已切换为「${v.name || v.id}」`, 'ok');
      });
      box.appendChild(card);
    });

    if (items.length) {
      videoHint(`共 ${items.length} 个视频，单个上限 ${S.videos.maxMB}MB。点一个即可设为背景。`);
    } else {
      videoHint(`目录：${S.videos.dir || 'data/videos/'}（为空时用程序化西湖动态画面兜底）`);
    }
  }

  function bindVideos() {
    if (!$('#video-list')) return;

    const refresh = $('#video-refresh');
    if (refresh) {
      refresh.addEventListener('click', async () => {
        await loadVideos();
        renderVideos();
        toast(`已刷新，共 ${S.videos.count} 个视频`, 'ok');
      });
    }

    const upload = $('#video-upload');
    const fileInput = el('input', { type: 'file', accept: 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v,.ogv', hidden: true });
    document.body.appendChild(fileInput);
    if (upload) {
      upload.addEventListener('click', () => fileInput.click());
    }
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      const limit = (S.videos.maxMB || 300) * 1024 * 1024;
      if (f.size > limit) {
        toast(`视频过大（${(f.size / 1024 / 1024).toFixed(0)}MB，上限 ${S.videos.maxMB}MB），请先压缩`, 'err', 9000);
        return;
      }
      videoHint(`正在上传并保存「${f.name}」（${(f.size / 1024 / 1024).toFixed(1)}MB）…`);
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result || ''));
          fr.onerror = () => reject(new Error('读取文件失败'));
          fr.readAsDataURL(f);
        });
        const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        await api('/api/videos', { method: 'POST', body: { video: base64, name: f.name } });
        await loadVideos();
        renderVideos();
        toast('视频已保存到本机 data/videos/', 'ok', 5000);
      } catch (e) {
        videoHint(`上传失败：${String(e.message || e).split('\n')[0]}`, true);
        toast(String(e.message || e).split('\n')[0], 'err', 9000);
      }
    });

    /* ======================================================================
     * 历史对话
     *
     * 原来只有 S.history —— 一段扁平的当前记录，最多 60 条，刷新后接着用。
     * 问题是**没法回看、也没法删**：聊了几十轮之后想找回上周那份方案，
     * 只能一直往上滚；不想留的也删不掉。
     *
     * 现在的模型：
     *   S.history   = 当前这一段（没变）
     *   S.sessions  = 归档的历史段 [{id,title,time,count,messages}]
     * 点「＋ 新对话」把当前这段归档，开新的一段；列表里每条能打开 / 删除。
     * 存在本机 localStorage，不上传。
     * ====================================================================*/
    const LS_SESSIONS = 'wenlv.sessions';
    if (!Array.isArray(S.sessions)) {
      try { S.sessions = JSON.parse(localStorage.getItem(LS_SESSIONS) || '[]'); } catch { S.sessions = []; }
      if (!Array.isArray(S.sessions)) S.sessions = [];
    }
    const saveSessions = () => {
      try { localStorage.setItem(LS_SESSIONS, JSON.stringify(S.sessions.slice(-50))); } catch { /* 忽略 */ }
    };

    /** 一段对话的标题：取第一条用户消息，压成一行 */
    function sessionTitle(msgs) {
      const first = (msgs || []).find((m) => m.role === 'user' && m.content);
      const t = (first && first.content ? String(first.content) : '（空对话）').replace(/\s+/g, ' ').trim();
      return t.length > 22 ? t.slice(0, 22) + '…' : t;
    }

    function renderHistoryList() {
      const box = $('#hist-list');
      const cnt = $('#hist-count');
      if (cnt) cnt.textContent = String((S.sessions || []).length);
      if (!box) return;
      box.innerHTML = '';
      const list = (S.sessions || []).slice().reverse();   // 新的在上面
      if (!list.length) {
        box.appendChild(el('div', { class: 'hist-empty', text: '还没有历史对话。聊完之后点「＋ 新对话」就会存到这里。' }));
        return;
      }
      for (const s of list) {
        const row = el('div', { class: 'hist-row' }, [
          el('div', { class: 'hist-main', title: '点击打开这段对话' }, [
            el('div', { class: 'hist-name', text: s.title || '（空对话）' }),
            el('div', { class: 'hist-meta', text: `${s.time || ''} · ${s.count || 0} 条` }),
          ]),
          el('button', { class: 'hist-del', type: 'button', title: '删除这段对话', text: '🗑' }),
        ]);
        row.querySelector('.hist-main').addEventListener('click', () => openSession(s.id));
        row.querySelector('.hist-del').addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm(`删除这段历史对话？\n\n${s.title || '（空对话）'}\n\n不可恢复。`)) return;
          const i = S.sessions.findIndex((x) => x.id === s.id);
          if (i >= 0) S.sessions.splice(i, 1);
          saveSessions();
          renderHistoryList();
          toast('已删除该段对话', 'ok');
        });
        box.appendChild(row);
      }
    }

    /** 把当前这段归档（空的不存），然后清空开新的 */
    function newSession() {
      const msgs = (S.history || []).filter((m) => m.content);
      if (msgs.length) {
        S.sessions.push({
          id: 'S' + Date.now().toString(36),
          title: sessionTitle(msgs),
          time: new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
          count: msgs.length,
          messages: msgs.slice(-80),
        });
        saveSessions();
      }
      S.history = [];
      saveHistory();
      const log = $('#chat-log');
      if (log) log.innerHTML = '';
      renderHistoryList();
      toast('已开始新对话（上一段存进历史了）', 'ok');
      say(S.card ? S.card.greeting : '你好，我是你的文旅向导。', true);
    }

    /** 打开一段历史：先把当前这段归档，再把选中的装回来 */
    function openSession(id) {
      const s = (S.sessions || []).find((x) => x.id === id);
      if (!s) return;
      const cur = (S.history || []).filter((m) => m.content);
      if (cur.length) {
        // 当前这段没归档过就先留住，别因为"打开历史"把它弄丢了
        S.sessions.push({
          id: 'S' + Date.now().toString(36),
          title: sessionTitle(cur),
          time: new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
          count: cur.length,
          messages: cur.slice(-80),
        });
        saveSessions();
      }
      const i = S.sessions.findIndex((x) => x.id === id);
      if (i >= 0) S.sessions.splice(i, 1);
      saveSessions();

      S.history = (s.messages || []).slice();
      saveHistory();
      const log = $('#chat-log');
      if (log) log.innerHTML = '';
      for (const m of S.history) appendMsg(m.role, m.content, { raw: true, image: m.image });
      renderHistoryList();
      toast(`已打开「${s.title || '历史对话'}」`, 'ok');
    }

    {
      const bNew = $('#hist-new');
      if (bNew) bNew.addEventListener('click', newSession);
      const bClear = $('#hist-clear');
      if (bClear) bClear.addEventListener('click', () => {
        if (!(S.sessions || []).length) { toast('还没有历史对话', 'err'); return; }
        if (!confirm(`删除全部 ${S.sessions.length} 段历史对话？此操作不可恢复。`)) return;
        S.sessions = [];
        saveSessions();
        renderHistoryList();
        toast('历史对话已清空', 'ok');
      });
      renderHistoryList();
    }

    /* ======================================================================
     * 底部对话框：放大 / 收起
     *
     * 默认那条只有 200~330px 高，方案一长就得一直滚。
     * 放大态最高 62vh —— **最多盖过人物身体**，脑袋还留得出来，
     * 不至于"为了看方案把人整个挡没"。再点一次回到原来的高度。
     *
     * 按钮是运行时插进 .side 的（.side 是 position:fixed，绝对定位的按钮
     * 正好贴在它右上角），这样不用改 HTML 结构，也不影响调试界面的右侧分栏
     * —— 那边的 .side 不参与这套规则（CSS 里带了 :not(.debug)）。
     * ====================================================================*/
    {
      const side = document.querySelector('aside.side');
      if (side && !document.querySelector('#btn-chat-expand')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'btn-chat-expand';
        btn.className = 'chat-expand';
        btn.textContent = '⤢';
        side.appendChild(btn);

        const TALL_KEY = 'wenlv.chatTall';
        const applyTall = (on) => {
          const want = Boolean(on);
          document.body.classList.toggle('chat-tall', want);
          btn.textContent = want ? '⤡' : '⤢';
          btn.title = want ? '收起输出区，回到原来的大小' : '放大输出区（最多盖过人物）';
          try { localStorage.setItem(TALL_KEY, want ? '1' : '0'); } catch { /* 忽略 */ }
          // 尺寸变了，舞台要重算，否则人物还按旧画布摆着
          setTimeout(() => { const st = activeStage(); if (st && st.resize) st.resize(); }, 120);
        };
        let stored = null;
        try { stored = localStorage.getItem(TALL_KEY); } catch { /* 忽略 */ }
        applyTall(stored === '1');
        btn.addEventListener('click', () => {
          // 主人自己动过手了：之后自动放大就不再插手（见下面的 WenlvChatPane）
          btn.dataset.userToggled = '1';
          applyTall(!document.body.classList.contains('chat-tall'));
        });

        /* ------------------------------------------------------------------
         * 给别的模块用的"自动放大一次"。
         *
         * 默认布局下 .chat-log 的可见高度只有 105px（.side 300px 再扣掉
         * 页签行 + composer）。气泡引导一批近 400px、方案卡片更是一屏高 ——
         * 不放大，主人就只能从一道缝里看内容，会以为"你根本没改"。
         *
         * 刻意**不写 localStorage**：这是替内容临时腾地方，不是主人的偏好，
         * 写进去会把他自己设的 ⤢ 状态顶掉。
         * 主人一旦手点过 ⤢（userToggled），这里就完全不再插手。
         * ------------------------------------------------------------------ */
        window.WenlvChatPane = {
          tall: () => document.body.classList.contains('chat-tall'),
          /**
           * 把对话输出区收回默认大小。
           *
           * 谁会调它：从开屏点「对话页」进来时。用户要的"大屏"就是这个 ——
           * **人物占满一屏、底部面板矮矮一条**，而不是输出区铺开半屏把人物挤小。
           * （实测过：chat-tall 时 .side 占 56% 屏高，收起来只占 30%。）
           *
           * 和 autoExpand 相反，这里**写 localStorage** ——
           * 这是用户明确要的默认状态，不是替内容临时腾地方。
           */
          collapse: () => {
            if (!document.body.classList.contains('chat-tall')) {
              btn.dataset.entryCompact = '1';
              return false;
            }
            applyTall(false);
            // ★ 还要拦住"挂工作台时的那次自动放大"。
            //
            // 为什么光 collapse 不够：工作台表单是**进入时默认就挂进输出区**的
            // （见 startWorkbenchInChat），挂完它会 autoExpand() 一次 ——
            // 于是我刚收起来的面板又被顶开，白忙一场（实测：点进对话页后
            // body 从 tools-collapsed 变成 tools-collapsed chat-tall）。
            // 这个标记让那一次自动放大跳过；真出方案时该展开还是会展开
            // （runPlanWith 那条路不看这个标记）。
            btn.dataset.entryCompact = '1';
            return true;
          },
          /** 本次是"从开屏进对话页"进来的吗（用它决定要不要跳过挂表单时的自动放大） */
          entryCompact: () => btn.dataset.entryCompact === '1',
          autoExpand: () => {
            if (btn.dataset.userToggled === '1') return false;
            if (document.body.classList.contains('chat-tall')) return false;
            if (document.body.classList.contains('debug')) return false;  // 调试界面是右侧分栏
            document.body.classList.add('chat-tall');
            btn.textContent = '⤡';
            btn.title = '收起输出区，回到原来的大小';
            setTimeout(() => { const st = activeStage(); if (st && st.resize) st.resize(); }, 120);
            return true;
          },
        };
      }
    }

    // ---- 背景配乐 ----
    // 选了音轨就让 <audio> 跟着背景视频播，视频这边一律静音。
    {
      try {
        if (window.WenlvBgAudio) {
          window.WenlvBgAudio.init('#audio-list').catch(() => { /* 列表拉不到不影响主流程 */ });
        }
      } catch { /* 忽略 */ }
    }

    // ---- 自定义导出模板 ----
    // 用户传一个带占位符的 HTML（{{title}} / {{body}} / {{date}} …），导出时就套它。
    // 模板只存在浏览器本地，不上传服务器。
    {
      const tplFile = $('#export-tpl-file');
      const tplBtn = $('#btn-export-tpl');
      const tplReset = $('#btn-export-tpl-reset');

      const syncTplUI = () => {
        const has = window.WenlvExport && window.WenlvExport.hasTemplate();
        if (tplReset) tplReset.hidden = !has;
        if (tplBtn && window.WenlvExport) {
          const nm = window.WenlvExport.templateName();
          tplBtn.textContent = has ? `🎨 模板：${nm}` : '🎨 导出模板';
          tplBtn.classList.toggle('on', !!has);
        }
      };

      if (tplBtn && tplFile) {
        tplBtn.addEventListener('click', () => tplFile.click());
        tplFile.addEventListener('change', async () => {
          const f = tplFile.files && tplFile.files[0];
          tplFile.value = '';
          if (!f) return;
          if (f.size > 512 * 1024) { toast('模板文件太大（上限 512KB）', 'err'); return; }
          const text = await f.text();
          if (!/\{\{\s*body\s*\}\}/.test(text)) {
            // 没有 {{body}} 就套不进方案正文 —— 与其导出一份空文档，不如当场说清楚
            toast('模板里必须包含 {{body}} 占位符（方案正文放这儿）', 'err', 5200);
            return;
          }
          window.WenlvExport.setTemplate(text, f.name);
          syncTplUI();
          toast(`已启用自定义模板「${f.name}」，下次导出就套它`, 'ok', 4200);
        });
      }
      if (tplReset && window.WenlvExport) {
        tplReset.addEventListener('click', () => {
          window.WenlvExport.clearTemplate();
          syncTplUI();
          toast('已恢复内置模板', 'ok');
        });
      }
      syncTplUI();
    }

    // ---- 开屏模板 ----
    // 现在只剩「视频主页」一套，所以这里不再有切换逻辑；
    // 那个上传入口转给上面那一节既有的 #video-upload，不重复实现上传流程。
    {
      const here = $('#video-upload-here');
      if (here) here.addEventListener('click', () => {
        const up = $('#video-upload');
        if (up) up.click();
      });

      /* 「🎵 上传音频」：自己有一首曲子，直接放进音频库（不经视频）。
         和"上传视频并提取音频"是两个入口、一个音频库。 */
      const abtn = $('#audio-upload-here');
      const afile = $('#audio-file');
      if (abtn && afile) {
        abtn.addEventListener('click', () => afile.click());
        afile.addEventListener('change', async () => {
          const f = afile.files && afile.files[0];
          afile.value = '';
          if (!f) return;
          if (f.size > 60 * 1024 * 1024) { toast('音频文件太大（上限 60MB）', 'err'); return; }
          if (window.WenlvBgAudio) window.WenlvBgAudio.onUploading && window.WenlvBgAudio.onUploading(f.name);
          try {
            // 用和视频上传同一套读法（FileReader → dataURL → 取逗号后面那段）
            const dataUrl = await new Promise((res, rej) => {
              const fr = new FileReader();
              fr.onload = () => res(String(fr.result || ''));
              fr.onerror = () => rej(new Error('读取文件失败'));
              fr.readAsDataURL(f);
            });
            const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
            const r = await api('/api/audio', { method: 'POST', body: { audio: b64, name: f.name } });
            toast(`已上传「${f.name}」到音频库`, 'ok', 4000);
            if (window.WenlvBgAudio) {
              await window.WenlvBgAudio.refresh('#audio-list');
              if (r && r.items) window.WenlvBgAudio.onUploaded && window.WenlvBgAudio.onUploaded({ has_audio: true, extracted: true, track: f.name });
            }
          } catch (e) {
            toast(`上传失败：${e && e.message ? e.message : e}`, 'err', 5000);
          }
        });
      }
    }
    const syncSeg = () => {
      const cur = bootScreen ? bootScreen.template : 'video';
      $$('#boot-tpl-seg .seg-item').forEach(b => b.classList.toggle('on', b.dataset.bootTpl === cur));
      const el2 = $('#boot-tpl-hint');
      if (el2 && window.WenlvBoot) {
        const t = window.WenlvBoot.TEMPLATES.find(x => x.id === cur);
        el2.textContent = t ? `${t.name}：${t.hint}` : '';
      }
    };
    $$('#boot-tpl-seg .seg-item').forEach(b => {
      b.addEventListener('click', () => {
        if (!bootScreen) return;
        bootScreen.setTemplate(b.dataset.bootTpl, { animate: false });
        syncSeg();
        toast(`开屏模板已切换为「${b.textContent.trim()}」`, 'ok');
      });
    });
    const replay = $('#boot-replay');
    if (replay) replay.addEventListener('click', () => { if (bootScreen) bootScreen.show(); });
    syncSeg();

    // ---- 视频画面模式：开屏与主界面**共用** ----
    //
    // 为什么共用一个设置：两处常常播的是同一个片源，画面比例问题一模一样
    // （竖屏进横屏），分别设两个开关只会让人来回切两遍。
    // 主界面那边靠 body 上的 data-vfit 生效（见 airi.css 里 #bg-video 那段）。
    const videoFitSeg = $('#video-fit-seg');
    const applyVideoFit = (mode) => {
      const m = ['auto', 'cover', 'rotate'].includes(mode) ? mode : 'rotate';
      S.settings.bootFit = m;
      document.body.dataset.vfit = m;
      $$('#video-fit-seg .seg-item').forEach(b => b.classList.toggle('on', b.dataset.vfit === m));
      // 开屏那一路要重新走一遍 syncVideos（它还管着模糊底衬要不要加载）
      if (bootScreen && bootScreen.refreshFit) bootScreen.refreshFit();
      return m;
    };
    if (videoFitSeg) {
      applyVideoFit(S.settings.bootFit || 'rotate');
      videoFitSeg.addEventListener('click', (e) => {
        const b = e.target.closest('.seg-item');
        if (!b) return;
        const m = applyVideoFit(b.dataset.vfit);
        saveSettings();
        api('/api/prefs', { method: 'PUT', body: { boot: { fit: m } } }).catch(() => { /* 忽略 */ });
        toast(`视频画面模式：${b.textContent.trim()}（开屏与主界面都已生效）`, 'ok');
      });
    } else {
      // 没有这块 UI（比如老页面缓存）也要让主界面用上模式
      document.body.dataset.vfit = S.settings.bootFit || 'rotate';
    }

    // ---- 开屏背景：本机视频 ----
    // 这里的选项全部来自 data/videos/ 的**本机文件**（离线可用）。
    // 早先支持过"填 B 站链接内嵌官方播放器"，后来去掉了：播放器自带界面压不住、
    // 必须联网、竖屏片源还会被摆成中间一条。现在统一走下载到本机的路子。
    const videoSel = $('#boot-video-sel');
    if (videoSel) {
      const fill = () => {
        const list = (S.videos && (S.videos.items || S.videos.list)) || [];
        const keep = videoSel.value;
        videoSel.innerHTML = '';
        videoSel.appendChild(el('option', { value: '', text: '（自动：优先名字带「西湖」的，否则用第一个）' }));
        for (const v of list) videoSel.appendChild(el('option', { value: v.name, text: v.name }));
        videoSel.value = list.some(v => v.name === S.settings.bootVideo) ? S.settings.bootVideo : (keep || '');
      };
      fill();
      S._fillBootVideoSel = fill;      // 视频列表刷新后要重新填一遍
      videoSel.addEventListener('change', () => {
        S.settings.bootVideo = videoSel.value;
        saveSettings();
        api('/api/prefs', { method: 'PUT', body: { boot: { video: videoSel.value } } }).catch(() => { /* 忽略 */ });
        toast(videoSel.value ? `开屏背景已设为 ${videoSel.value}` : '开屏背景改回自动挑选', 'ok');
      });
    }
  }


  /* ========================================================================
   * 十四、开屏与大屏展示
   *
   * 开屏本身实现在 public/js/boot.js（两套模板：视频主页 / 形象主页），
   * 这里只做三件事：启动时按状态决定要不要弹、把三个入口接到主界面、
   * 以及"重新播放开屏"的按钮。
   *
   * 为什么不把开屏的 DOM 与样式写在这里：它是一整套并列的界面，跟主界面唯一的
   * 耦合就是"选了个入口之后去哪"。放在这个 4700 行的文件里只会更难读。
   * ======================================================================*/

  /**
   * 开屏入口 → 主界面动作。
   *
   * 跳转规则现在是**数据驱动**的（见 boot.js 的 ENTRIES[].target），这里只负责执行，
   * 不再写死三个 if 分支 —— 之前"设置"和"API 接入"都跳到外观页，用户点完设置再点
   * API 接入会以为没跳转。把目标抽成表之后，改跳转只改 boot.js 一行。
   *
   * 为什么不用 `$('#tabs .tab[data-pane=...]').click()` 去间接触发：
   * 点 DOM 会绕开一些状态同步（懒加载、滚动位置），表现是"进了设置页但列表是空的"。
   * 所以直接调 `switchTab`。
   */
  async function onBootEnter(entryId) {
    try {
      const def = (window.WenlvBoot && window.WenlvBoot.ENTRIES || []).find(e => e.id === entryId);
      const t = (def && def.target) || { pane: 'chat' };

      // ★ 从开屏点「对话页」进来，默认要"人物大、面板矮"那个布局。
      //
      // 具体就是：把对话输出区收回到默认大小（`WenlvChatPane.collapse()`）。
      // 不做这一步的话，如果输出区处在放大状态（chat-tall，.side 占 56% 屏高），
      // 人物会被压在屏幕中间一小块 —— 用户说的"小屏"就是这个。
      // 收起来之后 .side 只占 30%，人物才真正铺开。
      //
      // ⚠️ 这里**故意不调 setKiosk()**。
      //    我一度以为"大屏"=kiosk，进来就自动开 —— 结果把顶栏和人物条藏掉了，
      //    而用户要的恰恰是那个样子：**顶栏在、人物条在、底部面板矮**。
      //    「🖥️ 大屏」（kiosk）仍然保留，但要手动点顶栏那个按钮才进。
      //
      // 在切页签之前做，布局只重排一次，不会看到跳。
      if (t.compact && window.WenlvChatPane && window.WenlvChatPane.collapse) {
        try { window.WenlvChatPane.collapse(); } catch { /* 忽略 */ }
      }

      switchTab(t.pane || 'chat');

      // 展开折叠区 / 滚动 / 聚焦都要等面板切完再动，否则量到的位置是旧的
      // （切页签会改布局，元素位置会变）
      setTimeout(() => {
        try {
          for (const sel of (t.folds || [])) {
            const d = $(sel);
            if (d) d.open = true;
          }
          const anchor = t.scrollTo ? $(t.scrollTo) : null;
          if (anchor && anchor.scrollIntoView) {
            anchor.scrollIntoView({ block: anchor.tagName === 'DETAILS' ? 'center' : 'start', behavior: 'smooth' });
          }
          if (t.focus) {
            const f = $(t.focus);
            if (f) f.focus();
          }
        } catch { /* 单个目标元素缺失不该影响已经切好的页签 */ }
      }, 240);
    } catch (e) {
      // 开屏入口出错不该把用户困在开屏里：至少把界面切过去
      console.warn('[boot] 入口处理失败：', e && e.message);
    }
  }

  function initBoot() {
    if (!window.WenlvBoot) return;
    bootScreen = window.WenlvBoot.createBoot({
      onEnter: onBootEnter,
      getStage: () => activeStage(),
      // 模板 A 的背景：优先用用户在外观页选定的那个本机视频；
      // 没选就挑名字里带"西湖"的，再不行用列表第一个。
      // 全部来自 data/videos/ 的**本机文件** —— 离线可用。
      getVideo: () => {
        // 注意字段名是 items（不是 list）—— 写错会静默取不到，开屏就悄悄回落到
        // 程序化画面，看起来像"视频没配好"。这里两种都认，免得以后再踩。
        const list = (S.videos && (S.videos.items || S.videos.list)) || [];
        if (!list.length) return null;
        if (S.settings.bootVideo) {
          const hit = list.find(v => v.name === S.settings.bootVideo || (v.url || '').endsWith(S.settings.bootVideo));
          if (hit) return hit.url;
        }
        const rec = (S.videos && S.videos.recommended) || null;
        return (rec && rec.url) || list[0].url;
      },
      getMuted: () => Boolean(S.settings.bootMuted),
      getFit: () => S.settings.bootFit || 'auto',
      // 用户在开屏上点了静音开关 → 存到服务端偏好（下次进来、换设备都一致）
      onMutedChange: (muted) => {
        S.settings.bootMuted = Boolean(muted);
        saveSettings();
        api('/api/prefs', { method: 'PUT', body: { boot: { muted: Boolean(muted) } } })
          .catch(() => { /* 存不上不影响本次播放 */ });
      },
    });

    const replay = $('#btn-boot');
    if (replay) replay.addEventListener('click', () => bootScreen.show());

    const kiosk = $('#btn-kiosk');
    if (kiosk) {
      kiosk.addEventListener('click', () => setKiosk(!document.body.classList.contains('kiosk')));
    }

    /* ======================================================================
     * 声音总开关：收纳栏一个、调试界面（声音页签）一个，两处 + 开屏的 🔊
     * 共用**同一个状态**（lib 见 js/audio-mute.js）。改任意一处，
     * 背景配乐、朗读、开屏视频一起跟着变。
     * ==================================================================== */
    function wireMuteButtons() {
      const M = window.WenlvMute;
      if (!M) return;
      // 收纳栏那个按钮的文字在 .txt 里，调试区那个是 .mini-btn，刷新时分开处理
      const BTNS = [['#btn-mute', 'tool'], ['#btn-mute-debug', 'mini']];
      BTNS.forEach(([id]) => {
        const b = $(id);
        if (!b) return;
        b.removeAttribute('data-mute-btn');    // 去掉标记，避免被统一初始化二次绑定
        b.addEventListener('click', (e) => { e.stopPropagation(); M.toggle(); });
      });

      // 统一刷新外观
      const paint = (m) => {
        BTNS.forEach(([id, page]) => {
          const b = $(id);
          if (!b) return;
          const label = m ? '静音' : '有声';
          if (page === 'tool') {
            const txt = b.querySelector('.txt');
            const ico = b.querySelector('.ico');
            if (ico) ico.textContent = m ? '🔇' : '🔊';
            if (txt) txt.textContent = label;
          } else {
            b.textContent = (m ? '🔇 ' : '🔊 ') + label;
          }
          b.title = m ? '当前静音，点击开启声音' : '当前有声，点击静音';
          b.setAttribute('aria-pressed', m ? 'false' : 'true');
          b.classList.toggle('on', !m);
        });
        const st = $('#mute-debug-status');
        if (st) st.textContent = m ? '当前：静音（配乐 / 朗读 / 开屏视频都停）' : '当前：有声';
      };
      paint(M.isMuted());
      M.onChange((m) => {
        paint(m);
        // 静音是**显示端偏好**，存在本机 localStorage（audio-mute.js 自己管），
        // 所以这里只同步内存里的设置即可。
        //
        // 注：不再往 /api/prefs 发 PUT —— 这个后端只实现了 GET（读的是写死的默认值），
        // 发 PUT 会稳定拿到 405 并把控制台刷脏，而静音本来也不需要跨设备同步。
        S.settings.bootMuted = Boolean(m);
        saveSettings();
      });
    }
    wireMuteButtons();

    // 把常驻的媒体元素都纳入静音管理。
    // 背景视频必须 keepMuted：它一出声，浏览器的自动播放就会拒绝，背景直接黑掉。
    if (window.WenlvMute) {
      // 常驻媒体元素纳入全局静音。
      // 背景视频 keepMuted：它一出声，浏览器的自动播放就会拒绝，背景直接黑掉，
      // 所以它永远静音 —— 功能页的声音由配乐与朗读负责。
      window.WenlvMute.register($('#bg-video'), { keepMuted: true });
      window.WenlvMute.register($('#bg-audio'));
      // 朗读用的 <audio> 也纳入：静音时点朗读不出声
      $$('#tts-audio').forEach((a) => window.WenlvMute.register(a));
      window.WenlvMute.syncAll();
    }

    // Kiosk 下用 Esc 退出（大屏上操作界面是藏起来的，不给个退路就出不来了）
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('kiosk')) setKiosk(false);
    });

    /* ======================================================================
     * 右上角工具排：收纳成一个按钮
     *
     * 默认是**收起来**的（用户要的就是"那一排收起来，点一下才全部展示"）。
     * 展开状态下点到别处会自动收回去 —— 不然那一排会一直摊着挡住角色。
     * ====================================================================*/
    const TOOLS_KEY = 'wenlv.toolsCollapsed';
    {
      const apply = (on) => {
        document.body.classList.toggle('tools-collapsed', on);
        const b = $('#btn-tools-toggle');
        if (b) b.setAttribute('aria-expanded', on ? 'false' : 'true');
        try { localStorage.setItem(TOOLS_KEY, on ? '1' : '0'); } catch { /* 隐私模式忽略 */ }
      };
      let stored = null;
      try { stored = localStorage.getItem(TOOLS_KEY); } catch { /* 忽略 */ }
      apply(stored === null ? true : stored === '1');      // 没存过 → 默认收起

      const b = $('#btn-tools-toggle');
      if (b) b.addEventListener('click', () => {
        apply(!document.body.classList.contains('tools-collapsed'));
      });
      // 点空白处收起（只处理展开态，收起态什么都不做）
      document.addEventListener('click', (e) => {
        if (document.body.classList.contains('tools-collapsed')) return;
        const t = e.target;
        if (t && t.closest && !t.closest('.stage-tools')) apply(true);
      });
    }

    /* ======================================================================
     * 虚拟形象 显示 / 隐藏（默认**显示**）
     *
     * 用 body 上的类切 opacity，不改 canvas 的 display：
     * Live2D 走 PIXI/WebGL，display:none 之后重新显示时它拿到的还是上一次的尺寸，
     * 可能整块画不出来。
     * ====================================================================*/
    const AVATAR_KEY = 'wenlv.avatarHidden';
    {
      const apply = (on) => {
        document.body.classList.toggle('avatar-hidden', on);
        const b = $('#btn-avatar-hide');
        if (b) {
          b.classList.toggle('on', !on);
          const ico = b.querySelector('.ico');
          if (ico) ico.textContent = on ? '🙈' : '👁️';
        }
        try { localStorage.setItem(AVATAR_KEY, on ? '1' : '0'); } catch { /* 忽略 */ }
      };
      let stored = null;
      try { stored = localStorage.getItem(AVATAR_KEY); } catch { /* 忽略 */ }
      apply(stored === '1');                                // 没存过 → 显示

      const b = $('#btn-avatar-hide');
      if (b) b.addEventListener('click', () => {
        const nowHidden = !document.body.classList.contains('avatar-hidden');
        apply(nowHidden);
        toast(nowHidden ? '已隐藏虚拟形象（再点一次显示）' : '已显示虚拟形象', 'ok', 2500);
      });
    }

    /* ======================================================================
     * 「🐞 调试」= 切回**一开始那一版**的界面
     *
     * 语义：默认形态是"人物居中 + 底部悬浮对话框"；
     * 点调试 → 回到最初的左右分栏（右侧一列：对话/文旅/外观/记忆/角色卡/声音），
     * 在那里才能看到文旅工作台的完整展示栏（"查看完整方案 ›"就是跳过去）。
     *
     * 实现上用的是 **debug 这个类**，不是 dock ——
     * 之前那套 `body.dock ...` 的覆盖规则会把侧栏强制做成底部条，
     * 结果点调试进不去原始界面。改用新类名之后，那些规则不再匹配，
     * 样式自然回落到最初定义的左右分栏。
     * ====================================================================*/
    const DOCK_KEY = 'wenlv.dock';
    {
      const apply = (on, opts) => {
        const want = Boolean(on);
        /* ★ 进调试界面之前，先退出「词云全屏」。
           两条规则会打架：`body.wc-full.debug .side { visibility: hidden }`
           本意是"词云全屏时藏掉右侧操作面板"，可一旦用户是**在词云全屏下**
           点的「🐞 调试」，debug 类和 wc-full 类同时存在，右侧分栏就被这条
           藏掉了 —— 表现就是"点了调试，原来的界面并不跳出来"。
           点调试的意图很明确：我要看操作界面。所以先退出全屏词云。 */
        if (want && document.body.classList.contains('wc-full')) {
          const wf = $('#wc-full');
          if (wf) { try { wf.click(); } catch { /* 忽略 */ } }
        }
        document.body.classList.toggle('debug', want);
        const b = $('#btn-dock');
        if (b) {
          // 只切高亮，**不改文字** —— 这个按钮叫「调试」，名称固定。
          b.classList.toggle('on', want);
        }
        try { localStorage.setItem(DOCK_KEY, want ? '1' : '0'); } catch { /* 忽略 */ }
        // 布局变了要通知舞台重算尺寸，否则角色还按旧画布尺寸摆着
        setTimeout(() => { const st = activeStage(); if (st && st.resize) st.resize(); }, 120);
        if (!(opts && opts.silent)) {
          toast(want ? '已切到调试界面（右侧分栏）' : '已回到主界面', 'ok', 3000);
        }
      };
      let stored = null;
      try { stored = localStorage.getItem(DOCK_KEY); } catch { /* 忽略 */ }
      // 默认关闭：常态是"人物居中 + 底部悬浮对话框"
      apply(stored === '1', { silent: true });

      // 暴露给"查看完整方案 ›"用：跳转前先把调试界面打开，
      // 否则文旅展示栏在一个隐藏的面板里，点了等于没反应。
      S._debugApply = apply;

      const b = $('#btn-dock');
      if (b) b.addEventListener('click', () => {
        apply(!document.body.classList.contains('debug'));
      });
    }

    /* ======================================================================
     * 「💬 对话栏」：显示 / 关闭底部那条对话框
     *
     * 大屏时想只留人物与背景，就把它关掉。
     * 关键：**关掉之后随时能再打开** —— 不管是从调试界面切回来，
     * 还是从主界面切回来，它都必须重新出现（之前切出去就回不来了）。
     * 所以状态只存在 no-chatbar 这个类上，切布局不会把它弄丢。
     * ====================================================================*/
    const CHATBAR_KEY = 'wenlv.chatbar';
    {
      const applyBar = (on) => {
        const want = Boolean(on);
        // 只在非调试布局下才谈得上"底部对话栏"；调试用的是右侧分栏，
        // CSS 里那条规则带了 :not(.debug)，不会连坐藏掉右侧栏
        document.body.classList.toggle('no-chatbar', !want);
        const b = $('#btn-chatbar');
        if (b) b.classList.toggle('on', want);
        try { localStorage.setItem(CHATBAR_KEY, want ? '1' : '0'); } catch { /* 忽略 */ }
        setTimeout(() => { const st = activeStage(); if (st && st.resize) st.resize(); }, 120);
      };
      let barStored = null;
      try { barStored = localStorage.getItem(CHATBAR_KEY); } catch { /* 忽略 */ }
      applyBar(barStored !== '0');            // 默认显示
      S._chatbarApply = applyBar;

      const cb = $('#btn-chatbar');
      if (cb) cb.addEventListener('click', () => {
        applyBar(document.body.classList.contains('no-chatbar'));
      });
    }
  }

  /**
   * 大屏展示模式。
   *
   * ★ **只切布局，绝不请求浏览器全屏。**
   *
   * 这里原来会顺带调 `document.documentElement.requestFullscreen()`，
   * 理由写在注释里（"展厅没人按 F11，投影出去带着地址栏很难看"）。
   * 但用户的反馈很明确，而且反馈了两次：
   *   · 「我要的是这样的大屏不是全屏」
   *   · 「进入之后要 esc 才能退出全屏进入大屏，我不要全屏」
   * 也就是说：点一下「大屏」，先被踢进浏览器全屏，还得按 Esc 退出来，
   * 才看到他真正要的那个"铺满窗口的布局"——**多了一步，而且是让人慌的一步**
   * （地址栏、标签页全没了，不熟的人会以为程序出问题了）。
   *
   * 所以现在：大屏 = 顶栏隐藏 + 舞台撑满 + 底部对话栏保留，
   * 地址栏和标签页该在还在。**要真全屏请自己按 F11**（或 F11 后再点大屏）。
   *
   * 之前我只把"从开屏点对话页进来"那条路的全屏去掉了，按钮那条忘了 —— 
   * 于是"真正的大屏"还是全屏。修的是这里，不是调用点。
   */
  function setKiosk(on) {
    const want = Boolean(on);
    document.body.classList.toggle('kiosk', want);
    const btn = $('#btn-kiosk');
    if (btn) btn.classList.toggle('on', want);
    // 切了布局要通知舞台重算尺寸，否则人物还按旧画布尺寸摆着
    setTimeout(() => { const st = activeStage(); if (st && st.resize) st.resize(); }, 120);
    // 提示语只说 Esc —— 顶栏在大屏下是 display:none 的，
    // 那个「大屏」按钮点不到，写"再点一次退出"会让人到处找按钮。
    toast(want ? '已进入大屏展示模式（按 Esc 退出）' : '已退出大屏展示模式', 'ok', 4000);
  }


  /* ========================================================================
   * 十二、导航模式
   *
   * 用户要的是："导航模式下形象举一块牌子，牌上是上次对话里的导航项目，
   * 背景按所在景点自动换成对应的风景图。"
   *
   * 项目里原本**没有任何导航功能**，所以这一块是全新加的，定位是：
   * 把已有的景点资料（lib/wenlv 的实体库）与位置信息，收束成"我要去哪儿"
   * 这一个当前目标，并让形象与舞台把它表达出来。
   *
   * 风景图三种来源（对应设置里的三档）：
   *   builtin —— 内置程序化，现画一张，完全离线
   *   folder  —— 用户自己放进 data/scenery/ 的图
   *   web     —— 联网搜图，**默认关闭**，必须手动点「应用」才真的去搜
   * ======================================================================*/

  function saveNav() {
    try { localStorage.setItem('wenlv.nav', JSON.stringify(S.nav)); } catch { /* 隐私模式下写不了，忽略 */ }
  }

  function loadNav() {
    S.nav = { on: false, spot: '', city: '', scenery: 'builtin', lastItem: '' };
    try {
      const raw = localStorage.getItem('wenlv.nav');
      if (raw) Object.assign(S.nav, JSON.parse(raw) || {});
    } catch { /* 坏了就用默认值，不要让一条脏数据挡住启动 */ }
  }

  function navHint(text, warn) {
    const el = $('#nav-hint');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('warn', !!warn);
  }

  /** 打开/关闭导航模式 */
  /**
   * 舞台右下角的**小**导航卡片。
   *
   * 取代原来"让形象举一块大木牌"的做法：那块牌子比人物还显眼，还挡住风景，
   * 用户明确说太突兀。改成一张角落小卡片，只留"去哪、多远、往哪走"，
   * 想看细节就点开整页导航。
   */
  let navPage = null;

  function initNavPage() {
    if (!window.WenlvNav || navPage) return navPage;
    navPage = window.WenlvNav.createNavPage({
      cities: (S.geoCities && Object.keys(S.geoCities).length) ? S.geoCities : null,
      onToast: (msg) => toast(msg, 'ok'),
    });
    return navPage;
  }

  function updateNavMini(spot) {
    const box = $('#nav-mini');
    if (!box) return;
    if (!spot) { box.hidden = true; return; }
    box.hidden = false;
    const nameEl = $('#nav-mini-name');
    const metaEl = $('#nav-mini-meta');
    const dirEl = $('#nav-mini-dir');
    if (nameEl) nameEl.textContent = spot;
    // 已经定位过就能直接给出距离和方位；没定位就如实说"点开看距离"
    const page = navPage || initNavPage();
    const info = page && page.infoForSpot ? page.infoForSpot(spot) : null;
    if (info) {
      if (metaEl) metaEl.textContent = `${info.distance} · 正${info.compass}方向 · 步行约 ${info.walk} 分`;
      if (dirEl) dirEl.style.transform = `rotate(${info.bearing}deg)`;
    } else {
      if (metaEl) metaEl.textContent = '点开看它离你多远、在哪个方向';
      if (dirEl) dirEl.style.transform = '';
    }
  }

  function bindNavMini() {
    const open = $('#nav-mini-open');
    if (open) open.addEventListener('click', () => { const p = initNavPage(); if (p) p.show(); });
    const x = $('#nav-mini-close');
    if (x) x.addEventListener('click', () => { const b = $('#nav-mini'); if (b) b.hidden = true; });
  }

  async function setNavMode(on) {
    S.nav.on = !!on;
    saveNav();
    const bar = $('#nav-bar');
    if (bar) bar.hidden = !S.nav.on;
    // 注意：#btn-nav（顶栏那个）现在负责**打开整页导航**，不再兼任"导航模式开关"。
    // 导航模式本身（风景图来源那一组设置）从「文旅」页里进。

    if (!S.nav.on) {
      // 退出导航模式要把牌子收掉、背景交还给原来的背景设置，
      // 否则用户会看到"关了导航，风景图还赖在那儿"
      const st = activeStage();
      if (st && st.clearPlacard) { try { st.clearPlacard(); } catch { /* 忽略 */ } }
      if (st && st.setScenery) { try { await st.setScenery(null); } catch { /* 忽略 */ } }
      navHint('选一个景点，形象会举牌显示它，背景也会换成它的风景。');
      return;
    }
    const el = $('#nav-spot');
    if (el && !el.value) el.value = S.nav.spot || S.nav.lastItem || '';
    navHint(S.nav.spot
      ? `当前目标：${S.nav.spot}。形象举的牌子上就是它。`
      : '先设一个目标景点，形象就会举牌显示它，背景也跟着换。');
  }

  /**
   * 设定导航目标：形象举牌 + 背景按该景点更换。
   *
   * 牌子上的字取景点名本身 —— 用户要的是"上次对话的导航项目"，
   * 一个名字比一句话更适合写在牌子上。
   */
  async function setNavTarget(spotRaw, city) {
    const spot = String(spotRaw || '').trim();
    if (!spot) { navHint('景点名不能为空。', true); return false; }
    S.nav.spot = spot;
    if (city) S.nav.city = String(city).trim();
    S.nav.lastItem = spot;
    saveNav();

    const st = activeStage();
    if (!st) { navHint('还没有加载形象，先选一个形象再开导航。', true); return false; }

    // 牌子
    if (st.setPlacard) { try { await st.setPlacard(spot); } catch { /* 忽略 */ } }

    // 风景图
    const ok = await applyNavScenery(spot);
    // 舞台角落的小卡片（替代原来让形象举的大木牌）
    updateNavMini(spot);
    navHint(ok
      ? `当前目标：${spot}。背景已换成对应的风景，右下角卡片可以打开导航页。`
      : `当前目标：${spot}。风景图没取到（详见提示），但导航卡片仍然可用。`, !ok);
    return true;
  }

  /**
   * 按当前选择的来源给舞台换背景。
   *
   * 三种来源的处理刻意不一样：内置是即时且必然成功的；自备目录要问服务端
   * 有没有这张图；联网必须**手动触发**，不在这里偷偷发请求 —— 项目的一条
   * 基本原则是"不联网也能用，联网要用户自己点"。
   */
  async function applyNavScenery(spot) {
    const st = activeStage();
    if (!st || !st.setScenery) return false;
    const name = spot || S.nav.spot;
    if (!name) return false;
    const src = S.nav.scenery || 'builtin';

    try {
      if (src === 'builtin') {
        await st.setScenery({ kind: 'procedural', spot: name, city: S.nav.city });
        return true;
      }
      if (src === 'folder') {
        const r = await fetch(`/api/scenery/local?spot=${encodeURIComponent(name)}`);
        const j = await r.json().catch(() => ({}));
        if (j && j.ok && j.url) { await st.setScenery({ kind: 'url', url: j.url, spot: name, city: S.nav.city }); return true; }
        // 目录里没有就退回程序化，别让用户对着一片空白
        navHint(`自备目录里没有「${name}」的图（${(j && j.error) || '未找到'}），已改用内置程序化风景。`, true);
        await st.setScenery({ kind: 'procedural', spot: name, city: S.nav.city });
        return false;
      }
      if (src === 'web') {
        navHint(`正在联网搜索「${name}」的风景图…`);
        const r = await fetch(`/api/scenery/search?spot=${encodeURIComponent(name)}${S.nav.city ? `&city=${encodeURIComponent(S.nav.city)}` : ''}`);
        const j = await r.json().catch(() => ({}));
        if (j && j.ok && j.url) { await st.setScenery({ kind: 'url', url: j.url, spot: name, city: S.nav.city }); return true; }
        navHint(`联网没取到「${name}」的风景图（${(j && j.error) || '未知原因'}），已改用内置程序化风景。`, true);
        await st.setScenery({ kind: 'procedural', spot: name, city: S.nav.city });
        return false;
      }
    } catch (e) {
      navHint(`换背景失败：${String(e.message || e).split('\n')[0]}。已改用内置程序化风景。`, true);
      try { await st.setScenery({ kind: 'procedural', spot: name, city: S.nav.city }); } catch { /* 忽略 */ }
      return false;
    }
    return false;
  }

  /** 待机开关（默认开）。读设置，写到当前舞台 */
  function applyIdleSetting() {
    const st = activeStage();
    if (!st) return;
    const on = S.settings.idleMotion !== false;      // 默认开
    try {
      if (on) st.startIdle({ motionEveryMs: Number(S.settings.idleEveryMs) || 14000 });
      else st.stopIdle();
    } catch { /* 老渲染器没有这套接口，忽略 */ }
  }

  function initNavUI() {
    // 顶栏「🧭 导航」= 打开**整页定位导航**（看我在哪、附近景点、怎么过去）。
    // 原来的"导航模式开关"（风景图来源那一组设置）改由下面的按钮进入，
    // 因为用户要的是一个"页面"，而不是在顶栏上切一个模式。
    const nav = $('#btn-nav');
    if (nav) nav.addEventListener('click', () => { const p = initNavPage(); if (p) p.toggle(); });

    // 导航页入口（也放在导航设置条里，方便从"风景图"那边顺手打开）
    const openPage = $('#nav-open-page');
    if (openPage) openPage.addEventListener('click', () => { const p = initNavPage(); if (p) p.show(); });

    // 导航模式的开关保留在「文旅」页 —— 它是设置，不是主功能
    const modeBtn = $('#nav-mode-toggle');
    if (modeBtn) modeBtn.addEventListener('click', () => setNavMode(!S.nav.on));

    bindNavMini();

    const go = $('#nav-go');
    if (go) {
      go.addEventListener('click', () => {
        const v = ($('#nav-spot') || {}).value || '';
        setNavTarget(v);
      });
    }
    const spotInput = $('#nav-spot');
    if (spotInput) {
      spotInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); setNavTarget(spotInput.value); }
      });
    }

    const sel = $('#nav-scenery-source');
    if (sel) {
      sel.value = S.nav.scenery || 'builtin';
      sel.addEventListener('change', () => {
        S.nav.scenery = sel.value;
        saveNav();
        if (S.nav.scenery === 'web') {
          navHint('联网搜图默认关闭。选好景点后点「应用」才会真的联网搜索；搜不到会退回内置风景。', true);
        } else if (S.nav.scenery === 'folder') {
          navHint('自备图片放在项目根目录的 data/scenery/ 下，文件名里带上景点名即可被匹配到。');
        } else {
          navHint('使用内置程序化风景：按景点名现画一张，完全离线、不需要素材。');
        }
      });
    }

    const apply = $('#nav-scenery-apply');
    if (apply) apply.addEventListener('click', () => { if (S.nav.spot) applyNavScenery(S.nav.spot); else navHint('先设一个目标景点。', true); });

    // 「放下牌子」那个按钮已经删掉了 —— 形象不再举牌，
    // 目标景点改由舞台右下角的小卡片呈现（见 updateNavMini / bindNavMini）。

    // 初始状态：开关关着，条子藏着
    const bar = $('#nav-bar');
    if (bar) bar.hidden = !S.nav.on;
    if (nav) nav.classList.toggle('on', !!S.nav.on);
  }

  /**
   * 切换当前展示的形象。
   * @param {'live2d'|'3d'} kind
   * @param {string} id
   */
  /**
   * 关掉「视角跟随」的模型。
   *
   * 视角跟随 = 鼠标/手指移到哪，人物的头与眼睛就看向哪。多数模型这么用没问题，
   * 但对用**九轴经纬网面部变形器**（perspective-parallelogram-nine-pose-v2）的
   * 模型会崩坏：库的 `updateFocus()` 是**叠加**写 ParamAngleX/Y/Z 的，角度一大
   * 就把面部网格撕开 —— 表现是"鼠标一从人物身上扫过，脸就散了"。
   *
   * 自建的 hanfu 就是这个毛病，所以列在这里。
   * 以后新加的模型若也崩，把它的 id 加进来即可。
   */
  const NO_FOCUS_FOLLOW = new Set(['hanfu']);

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
        // 舞台是新建的，之前画在地面上的方位标记要重新贴上去，
        // 否则"切一下形象，箭头就没了"（而 HUD 还在，看起来像功能坏了）
        applyGeoMarkerToStage(S.geo.relation);
      } catch (e) {
        stageProblem(e.message);
        toast(String(e.message).split('\n')[0], 'err', 9000);
      }
    } else {      stageProblem(`正在加载 ${item.label}…`);
      try {
        const st = await ensureLive2D();
        await st.load(item.entry, { label: item.label, focusFollow: !NO_FOCUS_FOLLOW.has(item.id) });
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

    // 换完形象要把两件"跟着形象走"的状态重新贴上去：
    //   ① 程序化待机 —— 新渲染器实例默认没开，不重开会莫名其妙不动了
    //   ② 导航模式的牌子与风景 —— 牌子挂在旧模型的舞台上，换形象就没了
    applyIdleSetting();
    if (S.nav.on && S.nav.spot) {
      const st = activeStage();
      if (st && st.setPlacard) { try { await st.setPlacard(S.nav.spot); } catch { /* 忽略 */ } }
      await applyNavScenery(S.nav.spot);
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
   * 十一、模型接入与对外开放（外部 API 双向）
   *
   * 出向：配置一个 OpenAI 兼容的云端端点，让对话/视觉/向量可以走外部。
   * 入向：把本项目按 OpenAI 兼容接口开放出去，供 AIRI 等外部 Agent 调用。
   *
   * 两块的共同原则是"默认不出网、默认不开放"，界面上必须一眼看出当前状态，
   * 而不是让人猜自己现在到底在用本地还是云端。
   * ======================================================================*/
  let providerPresets = [];
  let providerCfg = null;
  let openapiCfg = null;

  // 对外开放的能力清单：value 与服务端 lib/openapi.js 的 expose 键一一对应
  const EXPOSE_LABELS = {
    chat: '对话 · /v1/chat/completions',
    models: '模型列表 · /v1/models',
    embeddings: '向量 · /v1/embeddings',
    speech: '语音 · /v1/audio/speech（走本机 Qwen TTS）',
    wenlv: '文旅生成 · /wenlv/generate（方案 / 文案）',
    memory: '记忆 · /memory/*（含你的对话记录，谨慎勾选）',
    cards: '角色卡 · /cards/*',
  };

  function renderProviderBadges() {
    const box = $('#provider-badges');
    if (!box || !providerCfg) return;
    box.innerHTML = '';
    const e = providerCfg.external || {};
    if (providerCfg.active) {
      box.appendChild(el('span', { class: 'mini', html: `<i class="dot ok"></i> 外部：${escapeHtml((providerCfg.preset && providerCfg.preset.label) || '自定义')}` }));
      if (e.chatModel) box.appendChild(el('span', { class: 'mini', text: `对话 ${e.chatModel}` }));
      if (e.hasApiKey) box.appendChild(el('span', { class: 'mini', text: `Key ${e.apiKeyMasked}` }));
      else box.appendChild(el('span', { class: 'mini', html: '<i class="dot warn"></i> 未填 Key' }));
      if (e.visionModel && providerCfg.useFor.vision) box.appendChild(el('span', { class: 'mini', text: `视觉 ${e.visionModel}` }));
      if (e.embedModel && providerCfg.useFor.embed) box.appendChild(el('span', { class: 'mini', text: `向量 ${e.embedModel}` }));
    } else {
      box.appendChild(el('span', { class: 'mini', html: '<i class="dot ok"></i> 本机 Ollama（不出网）' }));
    }
    // 勾了外部却没填模型名：服务端会安全回落本地，但必须在这里说清楚，
    // 否则用户以为在用云端、实际在用本机，排查起来毫无头绪。
    const st = S.status && S.status.ollama;
    if (st && st.misconfigured) {
      const bad = Object.keys(st.misconfigured).filter(k => st.misconfigured[k]);
      for (const k of bad) {
        box.appendChild(el('span', { class: 'mini', html: `<i class="dot warn"></i> ${k === 'vision' ? '视觉' : '向量'}选了外部但没填模型名，暂用本机` }));
      }
    }
  }

  function fillProviderForm() {
    if (!providerCfg) return;
    const e = providerCfg.external || {};
    const sel = $('#provider-preset');
    if (sel && sel.options.length === 0) {
      for (const p of providerPresets) sel.appendChild(el('option', { value: p.id, text: p.label }));
    }
    if (sel) sel.value = e.presetId || 'custom';
    $('#provider-baseurl').value = e.baseUrl || '';
    $('#provider-chatmodel').value = e.chatModel || '';
    $('#provider-visionmodel').value = e.visionModel || '';
    $('#provider-embedmodel').value = e.embedModel || '';
    $('#provider-use-vision').checked = Boolean(providerCfg.useFor && providerCfg.useFor.vision);
    $('#provider-use-embed').checked = Boolean(providerCfg.useFor && providerCfg.useFor.embed);
    // 明文密钥拿不回来（服务端只回打码版），所以这里只提示"已存了一个"
    $('#provider-apikey').value = '';
    $('#provider-key-hint').textContent = e.hasApiKey ? `已保存 ${e.apiKeyMasked}，留空表示不修改` : '尚未保存密钥';
    renderProviderNote();
    renderProviderBadges();
  }

  function renderProviderNote() {
    const note = $('#provider-note');
    if (!note) return;
    const id = $('#provider-preset').value;
    const p = providerPresets.find(x => x.id === id);
    if (!p) { note.textContent = ''; return; }
    const bits = [];
    if (p.note) bits.push(p.note);
    if (p.keyUrl) bits.push(`申请密钥：${p.keyUrl}`);
    if (p.caps && !p.caps.vision) bits.push('这家没有视觉接口');
    if (p.caps && !p.caps.embed) bits.push('这家没有向量接口');
    if (p.local) bits.push('本机服务，通常不需要密钥');
    note.textContent = bits.join(' · ');
  }

  function showProviderResult(lines) {
    const box = $('#provider-result');
    if (!box) return;
    box.innerHTML = '';
    for (const [okState, name, detail] of lines) {
      const icon = okState === 'ok' ? '✅' : okState === 'warn' ? '⚠️' : '❌';
      box.appendChild(el('div', { class: 'mem-item' }, [
        el('div', { class: 'txt' }, [
          el('div', { text: `${icon} ${name}`, style: { fontWeight: '600' } }),
          detail ? el('div', { class: 'meta', text: String(detail) }) : null,
        ]),
      ]));
    }
  }

  /** 把表单里当前填的东西读出来，供"测试连接"和"保存"共用 */
  function readProviderForm() {
    return {
      presetId: $('#provider-preset').value,
      baseUrl: $('#provider-baseurl').value.trim(),
      apiKey: $('#provider-apikey').value.trim(),
      chatModel: $('#provider-chatmodel').value.trim(),
      visionModel: $('#provider-visionmodel').value.trim(),
      embedModel: $('#provider-embedmodel').value.trim(),
      useFor: {
        vision: $('#provider-use-vision').checked,
        embed: $('#provider-use-embed').checked,
      },
    };
  }

  async function loadProviderConfig() {
    if (!$('#fold-provider')) return;
    try {
      const r = await api('/api/providers');
      providerPresets = r.presets || [];
      providerCfg = r.config;
      fillProviderForm();
    } catch (e) {
      toast(`读取模型接入配置失败：${e.message}`, 'err', 5000);
    }
  }

  async function loadOpenAPIConfig() {
    if (!$('#fold-openapi')) return;
    try {
      const r = await api('/api/openapi');
      openapiCfg = r.config;
      renderOpenAPI();
    } catch (e) {
      toast(`读取对外开放配置失败：${e.message}`, 'err', 5000);
    }
  }

  function renderOpenAPI() {
    if (!openapiCfg) return;
    $('#openapi-enabled').checked = Boolean(openapiCfg.enabled);
    $('#openapi-require-token').checked = Boolean(openapiCfg.requireToken);

    const tok = $('#openapi-token');
    // 明文只有"刚生成"那一次在手上；刷新页面后只能显示打码版
    if (!tok.dataset.plain) tok.value = openapiCfg.tokenMasked || '';

    const box = $('#openapi-expose');
    box.innerHTML = '';
    for (const [key, label] of Object.entries(EXPOSE_LABELS)) {
      const id = `openapi-expose-${key}`;
      const cb = el('input', { type: 'checkbox', id });
      cb.checked = Boolean(openapiCfg.expose && openapiCfg.expose[key]);
      cb.dataset.key = key;
      // 记忆与角色卡属于个人数据，单独标红提醒
      const sensitive = key === 'memory' || key === 'cards';
      box.appendChild(el('label', { class: 'check', style: sensitive ? { color: 'var(--warn, #ffcf70)' } : null }, [cb, ' ' + label]));
    }

    const base = `${location.origin}`;
    const eps = [
      `POST ${base}/v1/chat/completions　（stream 支持流式，也支持传图片）`,
      `GET  ${base}/v1/models`,
      `POST ${base}/v1/embeddings`,
      `POST ${base}/v1/audio/speech　（返回 audio/wav）`,
      `POST ${base}/wenlv/generate　（SSE，方案 / 文案 / 追问）`,
      `GET/POST ${base}/memory　${base}/cards　（需在下面勾选）`,
    ];
    $('#openapi-endpoints').innerHTML = eps.map(x => `<code>${escapeHtml(x)}</code>`).join('<br>');

    $('#openapi-token-hint').textContent = openapiCfg.requireToken
      ? '外部程序需要带 Authorization: Bearer <令牌>。明文只在生成的那一刻显示一次。'
      : '⚠️ 已关闭令牌校验：局域网内任何人都能调用（服务默认只监听 127.0.0.1，风险相对可控）。';
  }

  function bindProviders() {
    const sel = $('#provider-preset');
    if (!sel) return;

    sel.addEventListener('change', () => {
      const p = providerPresets.find(x => x.id === sel.value);
      if (p) {
        // 切预设就把该家的端点与默认模型带出来，省得手抄
        if (p.baseUrl) $('#provider-baseurl').value = p.baseUrl;
        if (p.chatModel) $('#provider-chatmodel').value = p.chatModel;
        // 默认模型是免费/通用档，勾选框不自动开：向量和视觉要用户自己想清楚再切
        if (p.models && p.models.length) fillModelOptions(p.models);
      }
      renderProviderNote();
    });

    $('#provider-fetch-models').addEventListener('click', async () => {
      const f = readProviderForm();
      const btn = $('#provider-fetch-models');
      btn.disabled = true;
      try {
        const r = await api('/api/providers/models', { method: 'POST', body: { baseUrl: f.baseUrl, apiKey: f.apiKey } });
        fillModelOptions(r.models || []);
        showProviderResult([['ok', '模型列表', `拉到 ${(r.models || []).length} 个，已填入下拉候选`]]);
        toast(`拉到 ${(r.models || []).length} 个模型`, 'ok');
      } catch (e) {
        showProviderResult([['err', '模型列表', e.message]]);
      } finally {
        btn.disabled = false;
      }
    });

    $('#provider-test').addEventListener('click', async () => {
      const f = readProviderForm();
      const btn = $('#provider-test');
      btn.disabled = true;
      showProviderResult([['warn', '测试连接', '正在请求…']]);
      try {
        const r = await api('/api/providers/test', {
          method: 'POST',
          body: { baseUrl: f.baseUrl, apiKey: f.apiKey, chatModel: f.chatModel },
        });
        showProviderResult((r.steps || []).map(s => [s.ok ? (s.warn ? 'warn' : 'ok') : 'err', s.name, s.detail]));
      } catch (e) {
        showProviderResult([['err', '测试连接', e.message]]);
      } finally {
        btn.disabled = false;
      }
    });

    $('#provider-save').addEventListener('click', async () => {
      const f = readProviderForm();
      if (!f.baseUrl) { toast('请先填 Base URL', 'err'); return; }
      if (!f.chatModel) { toast('请先填对话模型名', 'err'); return; }
      try {
        const r = await api('/api/providers', {
          method: 'PUT',
          body: { mode: 'external', external: f, useFor: f.useFor },
        });
        providerCfg = r.config;
        fillProviderForm();
        await refreshStatus();
        toast('已启用外部模型接入', 'ok');
      } catch (e) {
        toast(`保存失败：${e.message}`, 'err', 5000);
      }
    });

    $('#provider-local').addEventListener('click', async () => {
      try {
        const r = await api('/api/providers', { method: 'PUT', body: { mode: 'local' } });
        providerCfg = r.config;
        fillProviderForm();
        await refreshStatus();
        toast('已切回本机 Ollama', 'ok');
      } catch (e) {
        toast(`切换失败：${e.message}`, 'err', 5000);
      }
    });

    // ---- 对外开放 ----
    $('#openapi-enabled').addEventListener('change', async (ev) => {
      try {
        const r = await api('/api/openapi', { method: 'PUT', body: { enabled: ev.target.checked } });
        openapiCfg = r.config;
        if (r.tokenPlain) {
          $('#openapi-token').dataset.plain = '1';
          $('#openapi-token').value = r.tokenPlain;
          toast('已开启，令牌已生成（请立刻复制保存）', 'ok', 6000);
        }
        renderOpenAPI();
        await refreshStatus();
      } catch (e) {
        ev.target.checked = !ev.target.checked;
        toast(`操作失败：${e.message}`, 'err', 5000);
      }
    });

    $('#openapi-require-token').addEventListener('change', async (ev) => {
      try {
        const r = await api('/api/openapi', { method: 'PUT', body: { requireToken: ev.target.checked } });
        openapiCfg = r.config;
        renderOpenAPI();
      } catch (e) {
        ev.target.checked = !ev.target.checked;
        toast(`操作失败：${e.message}`, 'err', 5000);
      }
    });

    $('#openapi-token-regen').addEventListener('click', async () => {
      try {
        const r = await api('/api/openapi', { method: 'PUT', body: { enabled: true, regenerateToken: true } });
        openapiCfg = r.config;
        // 明文只在这一次回传里出现，标个记号避免被后续 renderOpenAPI 覆盖成打码版
        const tok = $('#openapi-token');
        tok.dataset.plain = '1';
        tok.value = r.tokenPlain || '';
        toast('已生成新令牌，旧令牌立即失效', 'ok', 5000);
      } catch (e) {
        toast(`生成失败：${e.message}`, 'err', 5000);
      }
    });

    // 能力勾选框是动态生成的，用事件委托省得逐个绑
    $('#openapi-expose').addEventListener('change', async (ev) => {
      const cb = ev.target;
      if (!cb || cb.type !== 'checkbox' || !cb.dataset.key) return;
      const expose = {};
      $$('#openapi-expose input[type=checkbox]').forEach(x => { expose[x.dataset.key] = x.checked; });
      try {
        const r = await api('/api/openapi', { method: 'PUT', body: { expose } });
        openapiCfg = r.config;
        await refreshStatus();
      } catch (e) {
        cb.checked = !cb.checked;
        toast(`操作失败：${e.message}`, 'err', 5000);
      }
    });
  }

  /** 把模型名塞进 datalist：既是候选，也不阻止手输 */
  function fillModelOptions(models) {
    const dl = $('#provider-model-list');
    if (!dl) return;
    dl.innerHTML = '';
    for (const m of models) dl.appendChild(el('option', { value: m }));
  }

  /* ---------- 联网（工具调用）---------- */

  function applyWebUI() {
    const b = $('#btn-web');
    if (!b) return;
    b.classList.toggle('on', S.webEnabled);
    b.title = S.webEnabled
      ? '联网已开启：模型遇到"最新"类问题会主动搜索网页核实（点击关闭）'
      : '联网已关闭：模型只凭本地知识回答（点击开启）';
  }

  async function loadPrefs() {
    if (!$('#btn-web')) return;
    try {
      const r = await api('/api/prefs');
      const w = (r.config && r.config.web) || {};
      S.webEnabled = Boolean(w.enabled);
      S.webPrefs = {
        enabled: Boolean(w.enabled),
        maxSteps: Number(w.maxSteps) || 4,
        allowFetch: w.allowFetch !== false,
        allowPanorama: w.allowPanorama !== false,
      };
      S.webTools = r.tools || [];

      // 开屏背景视频：本地选过就听本地的。
      //
      // 原来这里无条件 `S.settings.bootVideo = String(b.video || '')` —— 而这个
      // 后端把 /api/prefs 实现成了桩（boot.video 恒为 ""），于是**每次刷新都把
      // 用户选的片子抹掉**，表现就是"选了片源，一刷新又没了"。
      const b = (r.config && r.config.boot) || {};
      if (b.video) S.settings.bootVideo = String(b.video);
      // 静音以**全局静音中枢**为准（localStorage），**完全不采纳服务端偏好**。
      //
      // 这个后端把 /api/prefs 实现成了桩：它不光不落盘，还恒返回 muted:false。
      // 只要它参与，用户就会看到"每刷新一次又变成有声"，
      // 连"默认静音"都保不住。所以这里直接不理它 —— 静音是纯显示端偏好。
      if (window.WenlvMute) {
        S.settings.bootMuted = window.WenlvMute.isMuted();
      } else {
        S.settings.bootMuted = Boolean(b.muted);
      }
      // 画面模式同理：**只在服务端真的给了合法值时才采纳**。
      //
      // 原来无条件写 `['auto','cover','rotate'].includes(b.fit) ? b.fit : 'rotate'`
      // —— 而这个后端的桩永远返回 fit:'rotate' 且从不落盘，于是用户在外观页
      // 选了「铺满裁剪 / 完整显示」，**一刷新就被打回「旋转」**，看起来就像
      // "视频没和选的模式适配"。本地选择优先。
      if (['auto', 'cover', 'rotate'].includes(b.fit) && b.fit !== 'rotate') {
        S.settings.bootFit = b.fit;
        saveSettings();
      }
      // 立刻把模式刷到 UI 与主界面（这一步以前没有，导致采纳后的值要等下次渲染）
      document.body.dataset.vfit = S.settings.bootFit || 'rotate';
      $$('#video-fit-seg .seg-item').forEach((el) => {
        el.classList.toggle('on', el.dataset.vfit === (S.settings.bootFit || 'rotate'));
      });
      if (bootScreen && bootScreen.refreshFit) bootScreen.refreshFit();

      // 主界面背景视频：与开屏共用片源与画面模式，但选择分开存
      // （有时开屏想用一段 30 秒短loop，主界面想用长片）。
      const vd = (r.config && r.config.video) || {};
      S.settings.mainVideo = String(vd.main || '');
    } catch {
      // 读不到就按"关闭"处理。宁可不联网，也不能在状态不明时擅自出网。
      S.webEnabled = false;
    }
    applyWebUI();
    renderWebPanel();
  }

  function renderWebPanel() {
    if (!$('#fold-web')) return;
    const w = S.webPrefs || { enabled: false, maxSteps: 4, allowFetch: true, allowPanorama: true };
    $('#web-enabled').checked = w.enabled;
    $('#web-allow-fetch').checked = w.allowFetch;
    $('#web-allow-panorama').checked = w.allowPanorama;
    $('#web-steps').value = w.maxSteps;
    $('#web-steps-label').textContent = w.maxSteps;

    const box = $('#web-badges');
    box.innerHTML = '';
    box.appendChild(el('span', {
      class: 'mini',
      html: `<i class="dot ${w.enabled ? 'ok' : 'warn'}"></i> ${w.enabled ? '联网已开启' : '联网已关闭（不出网）'}`,
    }));
    if (w.enabled) box.appendChild(el('span', { class: 'mini', text: `最多 ${w.maxSteps} 轮查证` }));

    const tools = (S.webTools || []).map(n => ({
      web_search: '联网搜索',
      web_fetch: '读取网页正文',
      find_panorama: '检索 360° 全景图',
    }[n] || n));
    $('#web-tools').textContent = tools.length ? tools.join(' · ') : '—';
  }

  /** 统一的保存入口：改完任一项就回写 /api/prefs 并同步界面 */
  async function saveWebPrefs(patch) {
    try {
      const r = await api('/api/prefs', { method: 'PUT', body: { web: patch } });
      const w = r.config.web;
      S.webEnabled = Boolean(w.enabled);
      S.webPrefs = {
        enabled: Boolean(w.enabled),
        maxSteps: Number(w.maxSteps) || 4,
        allowFetch: w.allowFetch !== false,
        allowPanorama: w.allowPanorama !== false,
      };
      applyWebUI();
      renderWebPanel();
      return true;
    } catch (e) {
      toast(`保存失败：${e.message}`, 'err', 5000);
      renderWebPanel();   // 回滚界面上的勾选状态
      return false;
    }
  }

  function bindWebPanel() {
    if (!$('#fold-web')) return;
    $('#web-enabled').addEventListener('change', (e) => saveWebPrefs({ enabled: e.target.checked }));
    $('#web-allow-fetch').addEventListener('change', (e) => saveWebPrefs({ allowFetch: e.target.checked }));
    $('#web-allow-panorama').addEventListener('change', (e) => saveWebPrefs({ allowPanorama: e.target.checked }));
    $('#web-steps').addEventListener('input', (e) => { $('#web-steps-label').textContent = e.target.value; });
    $('#web-steps').addEventListener('change', (e) => saveWebPrefs({ maxSteps: Number(e.target.value) }));
  }

  /* ========================================================================
   * 十二、位置（浏览器定位 / 手填 / IP 估算 + 舞台上标记方位）
   * ======================================================================*/

  /**
   * 取浏览器定位。
   *
   * 注意 `127.0.0.1` 与 `localhost` 属于"安全上下文"，浏览器会放行定位 API；
   * 但如果把服务挂到局域网 IP（改 HOST=0.0.0.0）用 http 访问，浏览器会直接
   * 拒绝定位 —— 这时错误码是 1，容易被误读成"用户点了拒绝"。所以下面按
   * 错误码给出不同的话，而不是笼统一句"定位失败"。
   */
  function getBrowserLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('这个浏览器不支持定位 API'));
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        (err) => {
          const map = {
            1: '定位被拒绝。如果你确实点了"允许"，检查一下浏览器是否把这个站点设为禁止定位；用局域网 IP（非 127.0.0.1/localhost）以 http 访问时，浏览器也会直接拒绝。',
            2: '定位不可用（可能没有 GPS，网络定位也失败了）。可以改用下面的手填坐标。',
            3: '定位超时（12 秒）。换个地方或改用手填坐标再试。',
          };
          reject(new Error(map[err.code] || `定位失败：${err.message}`));
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
      );
    });
  }

  async function loadGeo() {
    if (!$('#fold-geo')) return;
    try {
      const r = await api('/api/location');
      S.geo.status = r.status;
    } catch { /* 读不到就按"没有位置"处理 */ }
    renderGeoPanel();
  }

  function renderGeoPanel() {
    if (!$('#fold-geo')) return;
    const st = S.geo.status || { hasLocation: false };

    const box = $('#geo-badges');
    box.innerHTML = '';
    if (st.hasLocation) {
      box.appendChild(el('span', { class: 'mini', html: `<i class="dot ${st.fresh ? 'ok' : 'warn'}"></i> ${escapeHtml(st.label || '已定位')}` }));
      box.appendChild(el('span', { class: 'mini', text: `${Number(st.lat).toFixed(4)}, ${Number(st.lng).toFixed(4)}` }));
      box.appendChild(el('span', { class: 'mini', text: st.accuracyNote }));
      // 时效一定要显示：半小时前的定位对"我现在在哪"没有意义
      if (!st.fresh) box.appendChild(el('span', { class: 'mini', html: `<i class="dot warn"></i> ${escapeHtml(st.ageText)}取的，可能已不准` }));
    } else {
      box.appendChild(el('span', { class: 'mini', html: '<i class="dot warn"></i> 还没有位置' }));
    }

    if (st.lat != null) { $('#geo-lat').value = Number(st.lat).toFixed(4); $('#geo-lng').value = Number(st.lng).toFixed(4); }
    $('#geo-label').value = st.label || '';

    const ipAllowed = Boolean(S.status && S.status.location && S.status.location.ipFallbackAllowed);
    $('#geo-allow-ip').checked = ipAllowed;
    $('#geo-ip').disabled = !ipAllowed;
    $('#geo-ip').title = ipAllowed ? '向第三方定位服务查询你的大致位置' : '需要先勾选下面的「允许 IP 估算」';

    $('#geo-mcp').innerHTML = '外部 Agent 可通过 MCP 调用 <code>get_location</code> 与 <code>distance_to_spot</code>：'
      + '<br><code>node mcp/location-server.js</code>（stdio），注册配置见 <code>mcp/README.md</code>。';
  }

  /** 把"距离 + 方位"画到 HUD 与 3D 舞台上 */
  function applyGeoHud(rel) {
    S.geo.relation = rel;
    const hud = $('#geo-hud');
    if (!hud) return;

    if (!rel) { hud.hidden = true; applyGeoMarkerToStage(null); return; }

    hud.hidden = false;
    $('#geo-title').textContent = `${rel.target.name}　${rel.distanceText}`;
    // 罗盘箭头：0° 正北 → 0deg，顺时针 → 正好和 CSS rotate 的正方向一致
    $('#geo-arrow').style.setProperty('--bearing', `${Number(rel.bearing).toFixed(1)}deg`);
    const extras = [rel.bearingText ? `方向 ${rel.bearingText}` : '',
      rel.fromAccuracyNote || '',
      rel.note || ''].filter(Boolean);
    $('#geo-sub').textContent = extras.join(' · ');

    applyGeoMarkerToStage(rel);
  }

  /** 3D 舞台支持在角色脚下画指北环与方位箭头；Live2D 舞台没有这个方法，静默跳过 */
  function applyGeoMarkerToStage(rel) {
    const st = activeStage();
    if (st && typeof st.setGeoMarker === 'function') {
      try { st.setGeoMarker(rel ? { bearingDeg: rel.bearing } : null); } catch { /* 标记出错不该影响舞台 */ }
    }
  }

  async function setLocationFromBrowser() {
    const btn = $('#geo-acquire');
    btn.disabled = true;
    try {
      const pos = await getBrowserLocation();
      const r = await api('/api/location', { method: 'POST', body: pos });
      S.geo.status = r.status;
      renderGeoPanel();
      toast(`已定位：${r.status.accuracyNote}`, 'ok', 3500);
    } catch (e) {
      toast(e.message, 'err', 7000);
    } finally {
      btn.disabled = false;
    }
  }

  function bindGeoPanel() {
    if (!$('#fold-geo')) return;

    $('#geo-acquire').addEventListener('click', setLocationFromBrowser);

    $('#geo-ip').addEventListener('click', async () => {
      const btn = $('#geo-ip');
      btn.disabled = true;
      try {
        const r = await api('/api/location/ip', { method: 'POST' });
        S.geo.status = r.status;
        renderGeoPanel();
        toast('已按 IP 估算位置（仅城市级精度）', 'ok', 4000);
      } catch (e) {
        toast(e.message, 'err', 7000);
      } finally {
        btn.disabled = false;
      }
    });

    $('#geo-save-manual').addEventListener('click', async () => {
      const lat = Number($('#geo-lat').value);
      const lng = Number($('#geo-lng').value);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return toast('请填写合法的经纬度数字', 'err');
      try {
        const r = await api('/api/location/manual', { method: 'POST', body: { lat, lng, label: $('#geo-label').value.trim() } });
        S.geo.status = r.status;
        renderGeoPanel();
        toast('坐标已保存', 'ok');
      } catch (e) {
        toast(e.message, 'err', 6000);
      }
    });

    $('#geo-clear').addEventListener('click', async () => {
      try {
        await api('/api/location', { method: 'DELETE' });
        S.geo.status = { hasLocation: false };
        renderGeoPanel();
        applyGeoHud(null);
        toast('已清除位置', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });

    $('#geo-allow-ip').addEventListener('change', async (e) => {
      try {
        await api('/api/prefs', { method: 'PUT', body: { location: { allowIpFallback: e.target.checked } } });
        await refreshStatus();
        renderGeoPanel();
      } catch (err) {
        e.target.checked = !e.target.checked;
        toast(`保存失败：${err.message}`, 'err');
      }
    });

    $('#geo-relation').addEventListener('click', async () => {
      const spot = $('#geo-spot').value.trim();
      if (!spot) return toast('请填写景点名', 'err');
      if (!S.geo.status || !S.geo.status.hasLocation) return toast('还不知道你在哪，先点「获取我的位置」或手填坐标', 'err', 5000);
      const btn = $('#geo-relation');
      btn.disabled = true;
      try {
        const q = new URLSearchParams({ spot, city: $('#geo-city').value.trim() });
        const rel = await api(`/api/location/relation?${q}`);
        applyGeoHud(rel);
        toast(`${rel.target.name}：${rel.distanceText}，在${rel.bearingText}方向`, 'ok', 5000);
      } catch (e) {
        toast(e.message, 'err', 7000);
      } finally {
        btn.disabled = false;
      }
    });

    $('#geo-close').addEventListener('click', () => applyGeoHud(null));
  }

  /* ========================================================================
   * 十三、景区全景（检索 / 上传 / 程序化 → 环视场景）
   *
   * 三种来源对应三种现实情况，界面要如实区分，不能混着说：
   *   联网检索  —— 只有在那个景点真的有公开等距柱状图时才成功（多数中文景点没有）
   *   上传      —— 最可靠，演示时首选
   *   程序化生成 —— 离线兜底，是画出来的，会明确标注"非实拍"
   * ======================================================================*/

  let panoBuiltFrom = null;    // 当前场景来自哪条来源，用于界面标注

  async function loadPano() {
    if (!$('#fold-pano')) return;
    try {
      const r = await api('/api/pano');
      S.pano = {
        items: r.items || [],
        enabled: r.enabled,
        depthModelPresent: r.depthModelPresent,
        depthModelDir: r.depthModelDir,
        maxMB: r.maxMB,
      };
    } catch {
      S.pano = { items: [], enabled: false, depthModelPresent: false };
    }
    renderPanoPanel();
  }

  function renderPanoPanel() {
    if (!$('#fold-pano')) return;
    const p = S.pano || { items: [], enabled: false, depthModelPresent: false };

    const box = $('#pano-badges');
    box.innerHTML = '';
    box.appendChild(el('span', {
      class: 'mini',
      html: `<i class="dot ${p.enabled ? 'ok' : 'warn'}"></i> ${p.enabled ? '已启用' : '功能已关闭'}`,
    }));
    box.appendChild(el('span', { class: 'mini', text: `已缓存 ${p.items.length} 张` }));
    if (S.webEnabled) box.appendChild(el('span', { class: 'mini', html: '<i class="dot ok"></i> 联网已开，可检索' }));
    else box.appendChild(el('span', { class: 'mini', html: '<i class="dot warn"></i> 联网未开，检索不可用' }));

    const db = $('#pano-depth-badges');
    db.innerHTML = '';
    db.appendChild(el('span', {
      class: 'mini',
      html: `<i class="dot ${p.depthModelPresent ? 'ok' : 'warn'}"></i> 深度模型${p.depthModelPresent ? '已就位' : '未下载'}`,
    }));

    // 缓存列表：点一下就用它建场景
    const list = $('#pano-list');
    list.innerHTML = '';
    if (!p.items.length) {
      list.appendChild(el('div', { class: 'hintline', text: '还没有缓存的全景图。' }));
    } else {
      for (const it of p.items) {
        list.appendChild(el('div', { class: 'mem-item' }, [
          el('div', { class: 'txt' }, [
            el('div', { text: `${it.width}×${it.height}（${it.ratio}:1）`, style: { fontWeight: '600' } }),
            el('div', { class: 'meta', text: `${it.spot || '未标注'} · ${it.source} · ${(it.bytes / 1024 / 1024).toFixed(1)}MB` }),
          ]),
          el('div', { class: 'row' }, [
            el('button', {
              class: 'mini-btn',
              text: '环视',
              onclick: () => enterPanoramaFromRecord(it),
            }),
            el('button', {
              class: 'mini-btn',
              text: '删除',
              onclick: async () => {
                try {
                  await api(`/api/pano/${encodeURIComponent(it.id)}`, { method: 'DELETE' });
                  await loadPano();
                } catch (e) { toast(e.message, 'err'); }
              },
            }),
          ]),
        ]));
      }
    }
  }

  function showPanoResult(lines) {
    const box = $('#pano-result');
    box.innerHTML = '';
    for (const [state, name, detail] of lines) {
      const icon = state === 'ok' ? '✅' : state === 'warn' ? '⚠️' : '❌';
      box.appendChild(el('div', { class: 'mem-item' }, [
        el('div', { class: 'txt' }, [
          el('div', { text: `${icon} ${name}`, style: { fontWeight: '600' } }),
          detail ? el('div', { class: 'meta', text: String(detail).slice(0, 600) }) : null,
        ]),
      ]));
    }
  }

  /** 进入全景模式前先把 3D 舞台准备好（只有它有 three.js） */
  async function with3DStage(fn) {
    const st = await ensure3D();
    showCanvas('3d');
    return fn(st);
  }

  async function enterPanoramaFromRecord(rec) {
    try {
      showPanoResult([['warn', '正在构建场景', `${rec.width}×${rec.height}，深度计算可能要几秒…`]]);
      const depthUrl = prefsDepthRelief() ? `/api/pano/depth/${encodeURIComponent(rec.id)}` : null;
      const info = await with3DStage(st => st.buildPanorama({
        url: `/api/pano/image/${encodeURIComponent(rec.id)}`,
        depthUrl,
        label: rec.spot || '全景',
        sourceKind: 'downloaded',
      }));
      panoBuiltFrom = { kind: 'downloaded', label: rec.spot || '' };
      afterPanoramaBuilt(info, `来源：${rec.source}（${rec.width}×${rec.height}）`);
    } catch (e) {
      // 深度接口 503 时给出的是"深度不可用"，但那不该挡住环视 ——
      // 重新用不带深度的方式再建一次，并把原因说出来
      if (/深度|DEPTH|503/i.test(String(e.message))) {
        try {
          const info = await with3DStage(st => st.buildPanorama({
            url: `/api/pano/image/${encodeURIComponent(rec.id)}`,
            label: rec.spot || '全景',
            sourceKind: 'downloaded',
          }));
          panoBuiltFrom = { kind: 'downloaded', label: rec.spot || '' };
          afterPanoramaBuilt(info, `深度不可用，已退化为普通环境球：${e.message.split('\n')[0]}`);
          return;
        } catch (e2) { /* 落到下面统一报错 */ }
      }
      showPanoResult([['err', '构建失败', e.message]]);
      toast(String(e.message).split('\n')[0], 'err', 7000);
    }
  }

  const prefsDepthRelief = () => !(S.pano && S.pano.depthRelief === false);

  function afterPanoramaBuilt(info, extra) {
    const bits = [extra];
    if (info && info.relief) bits.push(`立体浮雕已启用（半径 ${info.minRadius.toFixed(1)}~${info.maxRadius.toFixed(1)}）`);
    else bits.push('未使用深度，当前是普通环境球');
    if (info && info.depthError) bits.push(`深度失败：${info.depthError}`);
    showPanoResult([['ok', '场景已就绪', bits.filter(Boolean).join(' · ')]]);
    toast('已进入全景环视：拖动鼠标就能环顾四周', 'ok', 4500);
    $('#pano-stage-hint').hidden = false;
  }

  async function enterProceduralPanorama() {
    try {
      showPanoResult([['warn', '正在生成程序化全景', '离线合成，不依赖网络…']]);
      const mod = await import('/js/pano.js');
      const canvas = mod.makeProceduralPanorama();
      const info = await with3DStage(st => st.buildPanorama({
        canvas,
        // 程序化全景也能走真深度：它本身有明确的地平线与远近结构，深度模型判得出来
        label: '程序化生成',
        sourceKind: 'procedural',
      }));
      panoBuiltFrom = { kind: 'procedural', label: '程序化生成' };
      // 深度要按图片算，而程序化全景没有缓存记录 —— 先存成一张再算不值得，
      // 所以这里直接用不带深度的环境球，并在提示里说明。
      afterPanoramaBuilt({ ...info, relief: false }, '程序化生成（非实拍）· 未做深度浮雕');
    } catch (e) {
      showPanoResult([['err', '生成失败', e.message]]);
      toast(String(e.message).split('\n')[0], 'err', 7000);
    }
  }

  async function uploadPanorama(file) {
    try {
      showPanoResult([['warn', '正在读取', file.name]]);
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('读取文件失败'));
        r.readAsDataURL(file);
      });
      // 先在本地量宽高比，不合格就不必传给服务端了
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('不是有效的图片'));
        i.src = dataUrl;
      });
      const ratio = img.naturalWidth / img.naturalHeight;
      const ok = ratio >= 1.9 && ratio <= 2.12;
      showPanoResult([[
        ok ? 'ok' : 'warn',
        `宽高比 ${ratio.toFixed(2)}:1`,
        ok ? '符合等距柱状全景，可以直接环视' : '不是 2:1 左右，贴到球面上会明显变形（仍会尝试渲染）',
      ]]);
      const info = await with3DStage(st => st.buildPanorama({
        canvas: (() => {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          return c;
        })(),
        label: file.name,
        sourceKind: 'upload',
      }));
      panoBuiltFrom = { kind: 'upload', label: file.name };
      afterPanoramaBuilt({ ...info, relief: false }, `上传：${file.name}`);
    } catch (e) {
      showPanoResult([['err', '上传失败', e.message]]);
    }
  }

  function exitPanoramaMode() {
    if (stage3d) stage3d.exitPanorama();
    panoBuiltFrom = null;
    $('#pano-stage-hint').hidden = true;
    toast('已返回人物模式', 'ok');
  }

  function bindPanoPanel() {
    if (!$('#fold-pano')) return;

    $('#pano-acquire').addEventListener('click', async () => {
      const spot = $('#pano-spot').value.trim();
      if (!spot) return toast('请填写景点名', 'err');
      const btn = $('#pano-acquire');
      btn.disabled = true;
      showPanoResult([['warn', '正在检索', '图片搜索 + 逐个下载校验（只接受 2:1 等值柱状）…']]);
      try {
        const r = await api('/api/pano/acquire', {
          method: 'POST',
          body: { spot, city: $('#pano-city').value.trim() },
          timeout: 300000,
        });
        await loadPano();
        showPanoResult([
          ['ok', '已获取全景图', `${r.record.width}×${r.record.height}（${r.record.ratio}:1）来自 ${r.record.source}；跳过了 ${(r.tried || []).length} 个不合格候选`],
        ]);
        await enterPanoramaFromRecord(r.record);
      } catch (e) {
        showPanoResult([['err', '没能获取可用全景图', e.message]]);
      } finally {
        btn.disabled = false;
      }
    });

    $('#pano-upload').addEventListener('click', () => $('#pano-file').click());
    $('#pano-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) uploadPanorama(f);
      e.target.value = '';
    });

    $('#pano-procedural').addEventListener('click', enterProceduralPanorama);

    $('#pano-depth-check').addEventListener('click', async () => {
      const btn = $('#pano-depth-check');
      btn.disabled = true;
      $('#pano-depth-hint').textContent = '正在起一次 Python 探测环境（约几秒）…';
      try {
        const r = await api('/api/pano/depth-check', { method: 'POST' });
        const d = r.depth;
        $('#pano-depth-hint').textContent = d.available
          ? `深度环境可用。Python：${d.python}`
          : `深度不可用：${d.reason}`;
        showPanoResult([[d.available ? 'ok' : 'err', '深度环境', d.available ? `Python：${d.python}` : d.reason]]);
      } catch (e) {
        $('#pano-depth-hint').textContent = `探测失败：${e.message}`;
      } finally {
        btn.disabled = false;
      }
    });

    $('#pano-relief').addEventListener('click', async () => {
      if (!panoBuiltFrom) return toast('还没有全景场景，先检索/上传/生成一个', 'err');
      if (panoBuiltFrom.kind !== 'downloaded') {
        return toast('程序化与上传的来源暂不支持重建深度（需要服务端有对应的缓存记录）', 'err', 6000);
      }
      const it = (S.pano.items || []).find(x => x.spot === panoBuiltFrom.label) || (S.pano.items || [])[0];
      if (it) await enterPanoramaFromRecord(it);
    });

    $('#pano-enter').addEventListener('click', () => {
      const it = (S.pano.items || [])[0];
      if (!it) return toast('还没有已缓存的全景图。可以检索、上传，或直接程序化生成。', 'err', 5000);
      enterPanoramaFromRecord(it);
    });

    $('#pano-exit').addEventListener('click', exitPanoramaMode);
    $('#pano-stage-hint').addEventListener('click', exitPanoramaMode);
  }

  /* ========================================================================
   * 十四、图片转 3D（TripoSR）
   *
   * 产物会登记进项目已有的模型库，所以生成完可以直接在「外观」里选到 ——
   * 不需要为"生成的模型"另造一套浏览界面。
   * ======================================================================*/

  let i23dImage = null;        // 待转换的图片 dataURL

  async function loadI23D() {
    if (!$('#fold-i23d')) return;
    try {
      const r = await api('/api/img23d');
      S.i23d = { jobs: r.jobs || [], modelPresent: r.modelPresent, modelDir: r.modelDir };
    } catch {
      S.i23d = { jobs: [], modelPresent: false };
    }
    renderI23DPanel();
  }

  function renderI23DPanel() {
    if (!$('#fold-i23d')) return;
    const p = S.i23d || { jobs: [], modelPresent: false };

    const box = $('#i23d-badges');
    box.innerHTML = '';
    box.appendChild(el('span', {
      class: 'mini',
      html: `<i class="dot ${p.modelPresent ? 'ok' : 'warn'}"></i> 权重${p.modelPresent ? '已就位' : '未下载（npm run fetch:triposr）'}`,
    }));
    box.appendChild(el('span', { class: 'mini', text: `已生成 ${p.jobs.length} 个` }));
    box.appendChild(el('span', { class: 'mini', text: `网格分辨率 ${$('#i23d-res').value}` }));

    const list = $('#i23d-list');
    list.innerHTML = '';
    if (!p.jobs.length) {
      list.appendChild(el('div', { class: 'hintline', text: '还没有生成过模型。' }));
    } else {
      for (const j of p.jobs) {
        list.appendChild(el('div', { class: 'mem-item' }, [
          el('div', { class: 'txt' }, [
            el('div', { text: j.id, style: { fontWeight: '600' } }),
            el('div', { class: 'meta', text: `${(j.bytes / 1024).toFixed(0)} KB · ${fmtTime(j.at)}` }),
          ]),
          el('div', { class: 'row' }, [
            el('button', {
              class: 'mini-btn',
              text: '设为形象',
              onclick: () => {
                const it = (S.models3d.custom || []).find(m => String(m.url || '').includes(j.id));
                if (!it) return toast('这个模型还没有登记进模型库，重新生成一次即可', 'err', 5000);
                switchDisplay('3d', it.id);
              },
            }),
          ]),
        ]));
      }
    }
  }

  function showI23DResult(lines) {
    const box = $('#i23d-result');
    box.innerHTML = '';
    for (const [state, name, detail] of lines) {
      const icon = state === 'ok' ? '✅' : state === 'warn' ? '⚠️' : '❌';
      box.appendChild(el('div', { class: 'mem-item' }, [
        el('div', { class: 'txt' }, [
          el('div', { text: `${icon} ${name}`, style: { fontWeight: '600' } }),
          detail ? el('div', { class: 'meta', text: String(detail).slice(0, 800) }) : null,
        ]),
      ]));
    }
  }

  async function generate3D() {
    if (!i23dImage) return toast('请先选择一张图片', 'err');
    const btn = $('#i23d-generate');
    btn.disabled = true;
    const res = Number($('#i23d-res').value);
    showI23DResult([['warn', '正在生成', `分辨率 ${res}，本机推理通常 1~3 分钟（显存被别的程序占着会更慢）…`]]);
    try {
      const r = await api('/api/img23d/generate', {
        method: 'POST',
        timeout: 900000,
        body: {
          image: i23dImage,
          resolution: res,
          chunkSize: Number($('#i23d-chunk').value),
          removeBg: $('#i23d-remove-bg').checked,
          bakeTexture: $('#i23d-bake-texture').checked,
        },
      });
      const lines = [['ok', '生成完成',
        `${r.vertices} 顶点 / ${r.faces} 面 · ${(r.bytes / 1024).toFixed(0)}KB · 用时 ${r.seconds}s · 分辨率 ${r.resolution} · ${r.textured ? '带贴图' : '顶点色'}`]];
      if (r.removeBgFailed) lines.push(['warn', '去背景失败，已用原图推理', r.removeBgFailed]);
      if (r.registerError) lines.push(['warn', '登记到模型库失败', r.registerError]);
      else lines.push(['ok', '已加入模型库', r.note]);
      showI23DResult(lines);

      // 刷新模型列表，让它在「外观」里立刻可选
      const d = await api('/api/models3d');
      S.models3d = { ...S.models3d, bundled: d.bundled, custom: d.custom, formats: d.formats };
      renderLookPreview();
      await loadI23D();
      toast('三维模型已生成，可在「外观 → 更换形象」里选中', 'ok', 6000);
    } catch (e) {
      showI23DResult([['err', '生成失败', e.message]]);
      toast(String(e.message).split('\n')[0], 'err', 9000);
    } finally {
      btn.disabled = false;
    }
  }

  function bindI23DPanel() {
    if (!$('#fold-i23d')) return;

    $('#i23d-pick').addEventListener('click', () => $('#i23d-file').click());
    $('#i23d-file').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type)) return toast('请选择图片文件', 'err');
      try {
        const raw = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(new Error('读取文件失败'));
          r.readAsDataURL(f);
        });
        // 先降采样：原图动辄几 MB，而 TripoSR 内部本来也会缩到 512 左右
        i23dImage = await downscaleImage(raw, 1024);
        $('#i23d-preview-hint').textContent = `已选择：${f.name}（${(f.size / 1024).toFixed(0)} KB）`;
        showI23DResult([]);
      } catch (err) {
        toast(err.message, 'err');
      }
    });

    $('#i23d-res').addEventListener('input', (e) => {
      $('#i23d-res-label').textContent = e.target.value;
      renderI23DPanel();
    });
    $('#i23d-chunk').addEventListener('input', (e) => { $('#i23d-chunk-label').textContent = e.target.value; });
    $('#i23d-generate').addEventListener('click', generate3D);

    $('#i23d-detect').addEventListener('click', async () => {
      const btn = $('#i23d-detect');
      btn.disabled = true;
      $('#i23d-env-hint').textContent = '正在起一次 Python 探测（import torch 不快，约十几秒）…';
      try {
        const r = await api('/api/img23d/detect', { method: 'POST', timeout: 180000 });
        const env = r.env;
        $('#i23d-env-hint').textContent = env.available
          ? `环境可用。Python：${env.python}`
          : `环境不完整：${env.reason}`;
        showI23DResult([[env.available ? 'ok' : 'err', '运行环境', env.available ? `Python：${env.python}` : env.reason]]);
      } catch (e) {
        $('#i23d-env-hint').textContent = `探测失败：${e.message}`;
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* ========================================================================
   * 十五、Blender 动画（通过 MCP 驱动 Blender）
   * ======================================================================*/

  async function loadBlender() {
    if (!$('#fold-blender')) return;
    try {
      const r = await api('/api/blender');
      S.blender = { status: r.status, jobs: r.jobs || [], host: r.host, port: r.port };
    } catch {
      S.blender = { status: { available: false, reason: '读取状态失败' }, jobs: [] };
    }
    renderBlenderPanel();
  }

  function renderBlenderPanel() {
    if (!$('#fold-blender')) return;
    const b = S.blender || { status: {}, jobs: [] };
    const st = b.status || {};

    const box = $('#blender-badges');
    box.innerHTML = '';
    box.appendChild(el('span', {
      class: 'mini',
      html: `<i class="dot ${st.available ? 'ok' : 'warn'}"></i> ${st.available ? 'Blender 服务已连接' : 'Blender 服务未连接'}`,
    }));
    if (st.available && st.scene && st.scene.blender_version) {
      box.appendChild(el('span', { class: 'mini', text: `Blender ${st.scene.blender_version}` }));
    }
    box.appendChild(el('span', { class: 'mini', text: `${b.host || '127.0.0.1'}:${b.port || 9876}` }));
    box.appendChild(el('span', { class: 'mini', text: `已生成 ${(b.jobs || []).length} 个` }));

    const list = $('#blender-list');
    list.innerHTML = '';
    if (!(b.jobs || []).length) {
      list.appendChild(el('div', { class: 'hintline', text: '还没有生成过动画。' }));
    } else {
      for (const j of b.jobs) {
        list.appendChild(el('div', { class: 'mem-item' }, [
          el('div', { class: 'txt' }, [
            el('div', { text: j.file, style: { fontWeight: '600' } }),
            el('div', { class: 'meta', text: `${(j.bytes / 1024).toFixed(0)} KB · ${fmtTime(j.at)}` }),
          ]),
          el('div', { class: 'row' }, [
            el('button', {
              class: 'mini-btn',
              text: '播放',
              onclick: () => {
                const it = (S.models3d.custom || []).find(m => String(m.url || '').includes(j.file));
                if (!it) return toast('这个动画还没登记进模型库，重新生成一次即可', 'err', 5000);
                switchDisplay('3d', it.id);
                toast('已切到该模型；网页端会自动循环播放它自带的动画', 'ok', 4000);
              },
            }),
          ]),
        ]));
      }
    }
  }

  function showBlenderResult(lines) {
    const box = $('#blender-result');
    box.innerHTML = '';
    for (const [state, name, detail] of lines) {
      const icon = state === 'ok' ? '✅' : state === 'warn' ? '⚠️' : '❌';
      box.appendChild(el('div', { class: 'mem-item' }, [
        el('div', { class: 'txt' }, [
          el('div', { text: `${icon} ${name}`, style: { fontWeight: '600' } }),
          detail ? el('div', { class: 'meta', text: String(detail).slice(0, 800) }) : null,
        ]),
      ]));
    }
  }

  async function generateBlenderAnim() {
    const btn = $('#blender-generate');
    btn.disabled = true;
    showBlenderResult([['warn', '正在驱动 Blender', '建模型 → 打关键帧 → 导出 glTF，通常几秒…']]);
    try {
      const r = await api('/api/blender/anim', {
        method: 'POST',
        timeout: 300000,
        body: {
          name: 'tour-guide',
          frames: Number($('#blender-frames').value),
          // 滑块是 5~60（避免小数），这里除以 10 变成 0.5~6.0 米
          radius: Number($('#blender-radius').value) / 10,
        },
      });
      const lines = [['ok', '动画已生成',
        `${r.fileName} · ${(r.bytes / 1024).toFixed(0)}KB · ${r.frames} 帧 @${r.fps}fps（${r.durationSeconds}s） · Blender ${r.blenderVersion}`]];
      lines.push(['ok', 'Blender 里的对象', (r.objects || []).join(', ')]);
      if (r.registerError) lines.push(['warn', '登记到模型库失败', r.registerError]);
      else lines.push(['ok', '已加入模型库', r.note]);
      showBlenderResult(lines);

      // 刷新模型列表让它立刻可选
      const d = await api('/api/models3d');
      S.models3d = { ...S.models3d, bundled: d.bundled, custom: d.custom, formats: d.formats };
      renderLookPreview();
      await loadBlender();
      toast('动画已生成，可在「外观 → 更换形象」里选中播放', 'ok', 6000);
    } catch (e) {
      showBlenderResult([['err', '生成失败', e.message]]);
      toast(String(e.message).split('\n')[0], 'err', 9000);
    } finally {
      btn.disabled = false;
    }
  }

  function bindBlenderPanel() {
    if (!$('#fold-blender')) return;

    $('#blender-frames').addEventListener('input', (e) => { $('#blender-frames-label').textContent = e.target.value; });
    $('#blender-radius').addEventListener('input', (e) => { $('#blender-radius-label').textContent = (Number(e.target.value) / 10).toFixed(1); });
    $('#blender-generate').addEventListener('click', generateBlenderAnim);

    $('#blender-check').addEventListener('click', async () => {
      const btn = $('#blender-check');
      btn.disabled = true;
      try {
        const r = await api('/api/blender/ping');
        $('#blender-hint').textContent = r.available
          ? `已连接 ${r.host}:${r.port}。可以生成动画了。`
          : `未连接 ${r.host}:${r.port}。运行 npm run blender:start 会弹出 Blender 窗口并自动开启服务。`;
        showBlenderResult([[r.available ? 'ok' : 'err', 'Blender 服务', r.available ? '已连接' : '未连接（需要 Blender 开着）']]);
        await loadBlender();
      } catch (e) {
        showBlenderResult([['err', '检测失败', e.message]]);
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* ========================================================================
   * 十六、界面绑定
   * ======================================================================*/
  function switchTab(name) {
    // ★ 'chat' 别名到 'tools'。
    //
    // 「对话」页签已经并进「文旅」（两个本来就是一件事的两半，而且聊天流里
    // 还默认嵌了第二份一模一样的工作台）。但全站还有几十处 `switchTab('chat')`
    // 和 `#pane-chat` 的引用，一次全改容易漏。留个别名在这里兜底：
    // 就算有漏网的调用点，也只是切到「文旅」，不会切到一个不存在的页签上
    // （那会让整个侧栏变成空白）。
    if (name === 'chat') name = 'tools';
    $$('#tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.pane === name));
    $$('.pane').forEach(p => p.classList.toggle('active', p.id === `pane-${name}`));
    if (name === 'memory') renderMemoryList();
    if (name === 'cards') renderCards();
    if (name === 'look') {
      renderLookPreview(); renderExpressions(); refreshStatus();
      // 外观页的视频卡片在这里才建：卡片带 <video preload="metadata"> 缩略图，
      // 提前建会让用户看不见的缩略图去抢带宽（见 renderVideos 的说明）。
      try { renderVideos(); } catch { /* 忽略 */ }
      // 配乐列表同理：隐藏着就没必要画
      try { if (window.WenlvBgAudio) window.WenlvBgAudio.renderList('#audio-list'); } catch { /* 忽略 */ }
    }
    if (name === 'voice') renderVoices();
  }

  function bindTabs() {
    $$('#tabs .tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.pane)));
  }

  /* ------------------------------------------------------------------------
   * 工作台的展开 / 收起。
   *
   * 为什么默认收起：底部那个面板只有 300px 高（用户明确要的"人物占满一屏、
   * 面板矮矮一条"），而完整工作台排下来要 700px 左右 —— 直接铺开会把字段切掉，
   * 也会把方案结果区挤得看不见。所以默认只留一行「填写旅行偏好」，
   * 点一下才铺开。
   *
   * 联动：
   *   · 生成方案前（runPlanWith）会自动展开 —— 否则用户看不见表单在动
   *   · 点「开始规划」（startWorkbenchInChat）也会展开
   *   · 分栏布局（.debug）下 CSS 不折叠：那里 520px 宽、纵向宽松，没必要收
   *   · 状态存 localStorage，用户手动展开过就记住
   * ---------------------------------------------------------------------- */
  const WB_KEY = 'wenlv.wbCollapsed';

  function setWorkbenchCollapsed(on) {
    const want = Boolean(on);
    document.body.classList.toggle('wb-collapsed', want);
    const btn = $('#btn-wb-toggle');
    if (btn) {
      btn.classList.toggle('open', !want);
      const arrow = btn.querySelector('.wb-toggle-arrow');
      const txt = btn.querySelector('.wb-toggle-txt');
      if (arrow) arrow.textContent = want ? '▸' : '▾';
      if (txt) txt.textContent = want ? '填写旅行偏好' : '收起偏好表单';
      btn.title = want ? '展开旅行偏好表单' : '收起旅行偏好表单';
    }
    try { localStorage.setItem(WB_KEY, want ? '1' : '0'); } catch { /* 忽略 */ }
    // 展开/收起会改布局，舞台要重算，否则人物还按旧画布摆着
    setTimeout(() => { const st = activeStage(); if (st && st.resize) st.resize(); }, 120);
  }

  /** 展开（生成方案前 / 点「开始规划」时用）。已经展开就不做事。 */
  function expandWorkbench() {
    if (!document.body.classList.contains('wb-collapsed')) return false;
    setWorkbenchCollapsed(false);
    return true;
  }

  function bindWorkbenchToggle() {
    const btn = $('#btn-wb-toggle');
    if (btn) btn.addEventListener('click', () => setWorkbenchCollapsed(!document.body.classList.contains('wb-collapsed')));
    let stored = null;
    try { stored = localStorage.getItem(WB_KEY); } catch { /* 忽略 */ }
    // 没存过就默认收起（这是需求：底部面板里工作台默认折叠）
    setWorkbenchCollapsed(stored === null ? true : stored === '1');
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
    /* 顶栏那排状态药丸（模型 / 记忆 / 语音 / 视觉）**只做状态显示，不可点击**。
       原来它们绑了页签跳转（switchTab('look'/'memory'/'voice')），
       用户点一下就被切走 —— 在底部对话框形态下，看起来就是"聊天突然消失了"，
       而且很容易误触（那排就在右上角、紧挨着工具排）。
       要进那些设置页面，走 ⚙️ 设置 → 🐞 调试 → 右侧页签，路径明确得多。 */
    ['#pill-model', '#pill-memory', '#pill-voice', '#pill-vision'].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      el.disabled = true;                    // 真按钮禁用：不触发点击，但 title 提示还在
      el.style.cursor = 'default';
      el.removeAttribute('role');
    });

    // 舞台工具条
    $('#open-bg').addEventListener('click', openBackgroundPicker);
    $('#open-model').addEventListener('click', openModelPicker);
    // 「⤢ 词云全屏」按钮已移除（用户说没用）。这里必须加 null 守卫 ——
    // 直接 $('#wc-full').addEventListener 会 TypeError，把后面所有绑定一起搞挂。
    const wcFullBtn = $('#wc-full');
    if (wcFullBtn) wcFullBtn.addEventListener('click', () => {
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
    /* ★ 输入区已经按需求整个移除（"旅游辅助项目，闲聊输入框没必要留"）——
       `#chat-input`、发送/停止/图片/摄像头/联网/语音这一排按钮都不在了。

       所以这里**直接整段跳过**。不跳过的话，下面每一句
       `$('#btn-send').addEventListener(...)` 都会在 null 上抛 TypeError，
       而 boot() 里 bindComposer 之后还有一大串初始化（舞台、开屏、词云…），
       一抛就全都不执行 —— 表现是"页面出来了但什么都不动"。

       想让输入框回来：把 index.html 里那段注释掉的 composer 放出来即可，
       这段绑定不用改。 */
    if (!input) return;

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
    });
    $('#btn-send').addEventListener('click', sendMessage);

    // 「让 AI 先问我」保持**分批气泡**（和进不进来看无关）：
    // 这个按钮的字面意思就是"让 AI 来问我"，出表单是另一回事。
    // 工作台本体是**进入时默认就挂在输出区**里的（见 startWorkbenchInChat）——
    // 两者并存：想要一张能直接填的表单就看输出区，想要被一条条问就点这里。
    const askBtn = $('#btn-ask-me');
    // 直接调文旅模块本体：把工作台那棵组件树挂进对话，
    // 和右侧「文旅」页签是同一棵树、同一个 bundle。
    if (askBtn) askBtn.addEventListener('click', () => { startWorkbenchInChat(); });
    $('#btn-web').addEventListener('click', async () => {
      const next = !S.webEnabled;
      try {
        const r = await api('/api/prefs', { method: 'PUT', body: { web: { enabled: next } } });
        S.webEnabled = Boolean(r.config && r.config.web && r.config.web.enabled);
        applyWebUI();
        toast(S.webEnabled
          ? '已开启联网：模型遇到"最新"类问题会主动搜索核实'
          : '已关闭联网：模型只凭本地知识回答', 'ok', 3500);
      } catch (e) {
        toast(`切换联网失败：${e.message}`, 'err', 5000);
      }
    });
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

  /**
   * 行程规划工作台（组员做的 React 版界面）。
   *
   * 挂载方式：planner-embed.js 是组员那套工程用 vite 的 lib 模式打出来的 IIFE，
   * 只导出一个 mount(container)。这里把它挂进 #wenlv-planner —— **同一个文档**，
   * 不是 iframe。这样工作台直接继承外壳的字体、背景与配色，
   * 它那边再用 antd 的 darkAlgorithm + 外壳的 --wenlv 青绿做主色，两边就是一套。
   *
   * 这里最重要的一条是**不许静默失败**：
   * 面板空白而且不说原因，是最糟的失败形态 —— 分不清是在加载、是脚本没到、
   * 还是 React 渲染崩了。所以下面每条失败路径都会把原因写进面板：
   *   · 脚本没加载成功 → 读 script 标签 onerror 记下的 __plannerScriptError
   *   · mount() 抛错       → 直接显示异常信息
   *   · 等不到 mount()     → 显示超时说明
   * 另外 window.onerror 也接一下：React 渲染期抛的错不会走上面的分支，
   * 但会冒泡到 window，正好接住。
   */
  function bindPlanner() {
    const host = $('#wenlv-planner');
    if (!host) return;

    const fail = (title, detail) => {
      if (host.dataset.wenlvMounted === '1') return;   // 已经挂上了就别覆盖
      host.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'planner-state err';
      box.textContent = title + (detail ? '：' + detail : '');
      host.appendChild(box);
    };

    // React 渲染期抛错会冒泡到这里（上面的 try/catch 接不到）
    window.addEventListener('error', (e) => {
      const msg = (e && e.message) || '';
      if (!msg) return;
      if (/antd|react|planner-embed/i.test(msg) || /planner-embed\.js/.test((e.filename || ''))) {
        fail('工作台渲染出错', msg);
      }
    });

    const tryMount = (attempt) => {
      const api = window.WenlvPlanner;
      if (api && typeof api.mount === 'function') {
        try {
          if (!api.mount(host)) fail('工作台挂载失败', '没找到挂载容器');
        } catch (err) {
          fail('工作台挂载时抛错', (err && err.message) || String(err));
        }
        return;
      }
      if (attempt >= 25) {   // 约 5 秒还没等到就放弃并说明
        fail('行程规划工作台没有加载成功',
          window.__plannerScriptError
          || '拿不到 /planner-embed.js 里的 WenlvPlanner（文件缺失、或加载被拦截）');
        return;
      }
      setTimeout(() => tryMount(attempt + 1), 200);
    };
    tryMount(0);
  }

  /**
   * 「生成结果」那个区块默认是收起的（它是外壳原版的展示位，平时不占地方）。
   * 词云点「个性化方案 / 营销文案」时结果会写进它里面的 #tools-output ——
   * 要是还收着，用户就对着空面板等半天，以为没生成出来。所以写结果前先展开。
   */
  function revealLegacyTools() {
    const box = $('#tools-result');
    if (box && box.hidden) box.hidden = false;
  }

  /**
   * 词云的「目的地 / 预算 / 同行人群 / 兴趣 / 饮食禁忌」→ 组员工作台表单的字段。
   *
   * 两边的词表是两套：
   *   词云   ：杭州 / 舒适 / 亲子 / 美食 / 忌辣 …
   *   工作台 ：destination / budget(元) / adults+children+elderly / preferences / dietary_restrictions
   * 语义基本一一对应，这里做翻译。换算口径与后端 ui_cmpat 的 _to_partial_base 保持一致，
   * 免得"词云点舒适"和"工作台填 3000"生成出两份不一样的预算尺度。
   */
  const WC_BUDGET_YUAN = { 经济: 800, 舒适: 3000, 高端: 8000 };
  const WC_TRAVELERS = {
    单人: [1, 0, 0],
    情侣: [2, 0, 0],
    朋友: [3, 0, 0],
    亲子: [2, 1, 0],
    带老人: [2, 0, 1],
    团建: [8, 0, 0],
  };
  // 同义不同写法的，映射到工作台里已有的选项，而不是再加一个重复项
  const WC_DIET_ALIAS = { 忌辣: '无辣' };

  function pickToWorkbench(p) {
    if (!p) return null;
    const out = {};
    if (p.city) out.destination = p.city;
    if (p.days != null) out.duration_days = Number(p.days) || undefined;
    if (p.budget && WC_BUDGET_YUAN[p.budget]) out.budget = WC_BUDGET_YUAN[p.budget];
    if (p.crowd && WC_TRAVELERS[p.crowd]) {
      const [adults, children, elderly] = WC_TRAVELERS[p.crowd];
      out.adults = adults;
      out.children = children;
      out.elderly = elderly;
    }
    if (p.interests) {
      const list = Array.isArray(p.interests) ? p.interests : [p.interests];
      if (list.length) out.preferences = list;
    }
    if (p.diet && p.diet !== '无') {
      out.dietary_restrictions = [WC_DIET_ALIAS[p.diet] || p.diet];
    }
    // 下面这三项是当前项目的工作台才有的字段（原来那份词表里没有对应概念）
    if (p.pace) out.pace = p.pace;
    if (p.transportation) out.transportation = p.transportation;
    if (p.avoidances) {
      const list = Array.isArray(p.avoidances) ? p.avoidances : [p.avoidances];
      if (list.length) out.avoidances = list;
    }
    return Object.keys(out).length ? out : null;
  }

  /**
   * 把词云上点到的条件同步进工作台表单。
   *
   * 为什么要「只增不减」：词云的「兴趣 / 饮食禁忌」是多选，每一组各自单选互斥。
   * 点「人文历史」再点「美食」，payload 里只有当前这一个词，直接覆盖的话
   * 前一个就没了 —— 而用户在词云上明明两个都亮着（见 cloud.getSelected()）。
   * 所以多选字段按词云上"这一组当前选中了什么"整体算，单选字段用点到的那个。
   */
  function syncPickToWorkbench(p, isOn) {
    const api = window.WenlvPlanner;
    if (!api || typeof api.setPreference !== 'function') return;   // 工作台没挂上就静默跳过
    const patch = pickToWorkbench(p);
    if (!patch) return;

    // 多选字段：以词云上当前选中的整组为准
    const groupPicked = (group) => {
      const picked = new Set(cloud ? cloud.getSelected() : []);
      return ((S.caps && S.caps.wordCloud) || [])
        .filter((x) => x.group === group && picked.has(x.word))
        .map((x) => x.word);
    };
    if (p.interests) {
      const list = groupPicked('兴趣导向');
      patch.preferences = list.length ? list : (isOn ? undefined : []);
    }
    if (p.avoidances) {
      const list = groupPicked('讨厌的项目');
      patch.avoidances = list.length ? list : [];
    }
    if (p.diet) {
      const list = groupPicked('饮食禁忌');
      patch.dietary_restrictions = list.length ? [WC_DIET_ALIAS[list[0]] || list[0]] : [];
    }
    try {
      api.setPreference(patch);
    } catch (e) {
      // 同步失败不该把词云这条链路带崩，只在控制台留个痕
      console.warn('[wenlv] 同步词云条件到工作台失败：', e);
    }
  }

  /**
   * 把词云的「游玩天数」± 也同步到工作台。
   * 天数是个数值控件，独立于上面那套条件词的 payload。
   */
  function syncDaysToWorkbench() {
    const api = window.WenlvPlanner;
    if (!api || typeof api.setPreference !== 'function') return;
    const days = Number($('#plan-days') && $('#plan-days').value) || 2;
    try {
      api.setPreference({ duration_days: days });
    } catch { /* 同上，静默 */ }
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
    $('#plan-days').addEventListener('input', (e) => {
      S.daysTouched = true;   // 亲手动过天数：之后提交画像时它算"用户填过"（见 chatBaseFromPicks）
      $('#days-label').textContent = e.target.value;
      updateDaysWord();   // 天数变了，词云上那个带箭头的控件也要跟着显示新值
      syncDaysToWorkbench();   // 并且同步给工作台表单
    });
    $('#btn-generate').addEventListener('click', () => {
      const isPlan = !$('#form-plan').hidden;
      generate(isPlan ? 'plan' : 'marketing', isPlan ? collectPlanParams() : collectMarketingParams());
    });
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
          onclick: (e) => {
            e.stopPropagation();
            // 试听也要服从全局静音，否则"静音了却还有声音"会让人以为键坏了
            const a = new Audio(v.url);
            if (window.WenlvMute) {
              a.muted = window.WenlvMute.isMuted();
              window.WenlvMute.register(a);
            }
            a.play().catch(() => toast('试听失败', 'err'));
          },
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
    // 视频背景用 `video-<文件名>` 这个前缀寻址。它不在 /api/backgrounds 的清单里
    // （视频是另一套接口，见 lib/videos.js），所以在这里现拼一条出来 ——
    // 这样视频就能和图片/程序化背景走完全相同的 applyBackground 通路，
    // 不必为"视频"再写一条平行的切换逻辑。
    if (id.startsWith('video-')) {
      const vid = String(id).slice('video-'.length);
      const hit = (S.videos.items || []).find(v => v.id === vid);
      if (hit) return { id, kind: 'video', url: hit.url, label: hit.name || hit.id };
      return null;
    }
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
        // Live2D：老模型可能没有这些字段（第三方模型的 model3.json 千奇百怪），
        // 兜一层默认值，别让"少一个字段"升级成"整个界面起不来"。
        const groups = Array.isArray(m.motionGroups) ? m.motionGroups.length : 0;
        const cnt = Number(m.motionCount) || 0;
        const exprs = Array.isArray(m.expressions) ? m.expressions.length : 0;
        mNote.textContent = `${groups} 组动作 / ${cnt} 个 · ${exprs} 个表情 · 口型同步${m.hasLipSync ? '支持' : '不支持'}`;
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
      const tags = (m.tags && m.tags.length) ? m.tags : [];
      const note = is3d
        ? `3D · ${(m.format || 'glb').toUpperCase()}${m.bytes ? ` · ${(m.bytes / 1024 / 1024).toFixed(1)} MB` : ''}${m.format === 'vrm' ? ' · 支持口型与眨眼' : ''}`
        : `${(m.motionGroups || []).length} 组动作 / ${m.motionCount || 0} 个${(m.expressions || []).length ? ` · ${(m.expressions || []).length} 个表情` : ''}${m.hasLipSync ? ' · 支持口型同步' : ''}`;

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
        (tags.length || is3d)
          ? el('div', { class: 'pick-tags' }, [
            ...tags.map(t => el('span', { class: 'pick-tag', text: t })),
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
    // 结果卡的排版函数。验收脚本可以直接塞一段假 HTML 进来验证排版规则，
    // 不用每次都真跑一遍模型（跑一次要几十秒，定位排版问题太慢）。
    layoutResultBlock,
  };
})();

// 版本号自检用的临时注释
