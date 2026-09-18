/* ============================================================================
 * boot.js —— 开屏（两套可互相切换的模板）
 *
 * ## 两套模板分别是什么
 *
 *   **模板 A · 视频主页**
 *     整屏播一段视频（西湖美景宣传片；视频可更换，没有视频时用程序化绘制的
 *     西湖动态画面兜底），中间是标题，下面是三个入口：对话 / 设置 / API 接入。
 *     定位是**大屏宣传**：往展厅屏幕上一放，先让人看到西湖。
 *
 *   **模板 B · 形象主页**
 *     以展示虚拟形象为主。这里是暗色氛围 + 角色站在画面里，左侧竖排菜单。
 *     鼠标移到/点到不同入口时，**虚拟形象会做出不同的动作**（招手 / 作揖 / 撑伞），
 *     用户还没进主界面就先感受到"这个形象是活的"。
 *
 *     > 说明：这一套的布局思路参考了同类"角色展示型"游戏开始界面的常见做法
 *     > （暗色环境、角色居侧、竖排菜单、悬停有反馈）。**没有使用任何第三方游戏的
 *     > 素材、字体或界面元素**，全部是本项目自己的 HTML/CSS 与程序化绘制的形象。
 *     > 直接照搬商业游戏的界面素材会有版权问题，那是不能做的。
 *
 * ## 为什么放在独立文件而不是塞进 app.js
 *
 * app.js 已经 4700 多行。开屏是**一整套并列的界面**（两套模板各自的 DOM、样式、
 * 动画、状态机），和主界面的耦合只有三个回调（进入某个功能、取当前舞台、取视频地址）。
 * 放进来只会让那个文件更难读；独立成文件之后，它的状态（用哪套模板、进没进过）
 * 也能自己管，app.js 只需要在启动时挂一下。
 *
 * ## 状态持久化
 *
 * 用哪套模板、以及"用户是不是已经进过主界面"，都存在 localStorage。
 * 后者很重要：如果每次刷新都弹一次开屏，用户会很快烦到去关掉它 ——
 * 所以**一次会话只自动弹一次**，之后刷新直接进主界面（除非用户手动点「开屏」）。
 * ==========================================================================*/
(function () {
  'use strict';

  const LS_KEY = 'wenlv-airi/boot';

  const TEMPLATES = [
    { id: 'video', name: '视频主页', hint: '整屏播西湖宣传片，三个功能入口' },
    { id: 'character', name: '形象主页', hint: '以展示虚拟形象为主，点功能看动作' },
  ];

  /** 页签 id → 中文名。用在入口按钮上标出"点了会去哪" */
  const PANE_LABEL = {
    chat: '对话页',
    tools: '文旅页',
    look: '外观页',
    memory: '记忆页',
    cards: '角色卡页',
    voice: '声音页',
  };

  /**
   * 三个功能入口。
   *
   * `motion` 写成"名字 + 一组降级动作组"而不是一个字符串，是因为
   * **只有西湖船娘有「招手」这种中文动作名**：
   *   · Live2D 模型的动作名是 `00_idle`、`tap_body_01` 这种
   *   · 3D 模型是 Blender 导出的 clip 名
   * 直接按名字找在它们身上必然落空，表现就是"鼠标划过菜单、形象毫无反应"。
   * 所以按「名字 → 动作组 → 随机」逐级降级，保证**任何形象都会有反应**。
   *
   * `target` 是**跳转目标**，写成数据而不是散在 if 分支里：
   * 三个入口原来有两个都跳到外观页，用户点完"设置"再点"API 接入"会以为没反应。
   * 抽成一张表之后，改跳转只要改这里一行，也便于测试逐条核对。
   *   pane     要切到哪个页签（chat / look / memory / cards / voice / tools）
   *   folds    顺带展开哪些折叠区（details 的 id）
   *   scrollTo 滚到哪个元素（可选）
   *   focus    要聚焦的输入框（可选）
   */
  const ENTRIES = [
    {
      id: 'chat', icon: '💬', title: '对话', desc: '问行程、问景点、问天气',
      motion: { name: '招手', groups: ['TapBody', 'Idle', 'Greet'] },
      target: { pane: 'chat', focus: '#chat-input' },
    },
    {
      id: 'settings', icon: '⚙️', title: '设置', desc: '人物设定、音色、形象与背景',
      motion: { name: '作揖', groups: ['TapBody', 'Idle', 'Greet'] },
      // 角色卡是「这台机器上这个人物是谁」的总设置：人设、问候语、音色、
      // 用哪个形象、记不记记忆，全在一张卡上。
      target: { pane: 'cards', scrollTo: '#pane-cards' },
    },
    {
      id: 'api', icon: '🔌', title: 'API 接入', desc: '接外部大模型，或对外开放本项目',
      motion: { name: '撑伞', groups: ['TapBody', 'Idle', 'Prop'] },
      // 外部 API 的配置就在外观页里：模型接入（出向）+ 对外开放（入向）。
      // 两个折叠区一起展开，否则用户会以为"API 设置只有一半"。
      target: { pane: 'look', folds: ['#fold-provider', '#fold-openapi'], scrollTo: '#fold-provider' },
    },
  ];

  /**
   * 让当前形象为某个入口做一个动作。
   *
   * 行为按需求定成三段：
   *   1. 先试这条入口**偏好的**动作（对话=招手 / 设置=作揖 / API=撑伞）；
   *   2. 偏好动作在这个形象上不存在时，**随机**挑一个它能播的；
   *   3. 这个形象**一个动作都没有**时，**什么都不做** —— 不要硬凑一个
   *      "点头 + 换表情"出来假装有反应（3D 舞台的 playMotion() 在没 clip 时会那样兜底）。
   *
   * 第 3 条是关键：以前的实现最后一定会调一次 `playMotion()`，于是"没有动作"的
   * 形象也会抖一下，看起来像有功能、其实是假的。宁可毫无反应，也不要假反应。
   *
   * 另外注意返回值：三套舞台的 `playMotionByName` 都是 **async**，
   * "没找到"返回的是 `Promise<false>` —— 它本身是个真值！不 await 就判断真假
   * 会以为"播成功了"，降级链根本不会走。
   */
  async function playEntryMotion(stage, entry) {
    if (!stage) return false;

    // 先问清楚这个形象到底有哪几个动作。拿不到（老渲染器没实现 listMotions）就当作"未知"，
    // 这时仍然允许试一次偏好的动作 —— 但不再做无条件兜底。
    let available = null;
    try {
      if (typeof stage.listMotions === 'function') available = stage.listMotions() || [];
    } catch { available = null; }

    const hasNone = Array.isArray(available) && available.length === 0;
    if (hasNone) return false;          // 一个动作都没有 → 不播

    const m = (entry && entry.motion) || {};
    const tryOne = async (fn) => {
      if (typeof fn !== 'function') return false;
      try { return Boolean(await fn()); } catch { return false; }
    };

    // 1) 偏好动作
    if (m.name && await tryOne(() => stage.playMotionByName && stage.playMotionByName(m.name))) return true;
    for (const g of (m.groups || [])) {
      if (await tryOne(() => stage.playMotion && stage.playMotion(g))) return true;
    }

    // 2) 随机一个它能播的
    if (Array.isArray(available) && available.length) {
      const pick = available[Math.floor(Math.random() * available.length)];
      if (pick && pick.group !== undefined && pick.index !== undefined) {
        if (await tryOne(() => stage.playMotion(pick.group, pick.index))) return true;
      }
      if (pick && pick.name) {
        if (await tryOne(() => stage.playMotionByName(pick.name))) return true;
      }
    }

    // 3) 到这里说明偏好和随机都没成功。**不再做无条件兜底**（除非确实有动作）。
    return false;
  }

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      return {
        template: TEMPLATES.some(t => t.id === raw.template) ? raw.template : 'video',
        /**
         * 每次打开页面都自动播开屏 —— 默认 **true**。
         *
         * 一开始我写的是"一次会话只弹一次"，理由是"每次都弹用户会烦"。
         * 但这个项目的开屏是**对外宣传用的门面**（大屏上放给游客看的），
         * 每次打开都要有那一下开场，否则"开屏"这件事就失去意义了。
         * 所以默认改成每次都播，同时在开屏上给出「不再自动播放」的勾选 ——
         * 觉得烦的用户自己可以关掉，而不是我替所有人做决定。
         */
        autoShow: raw.autoShow !== false,
        entered: Boolean(raw.entered),
      };
    } catch {
      return { template: 'video', autoShow: true, entered: false };
    }
  }
  function saveState(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* 隐私模式忽略 */ }
  }

  /**
   * 创建开屏。
   *
   * @param {object} o
   * @param {Function} o.onEnter   (entryId) => void，用户选了某个功能入口
   * @param {Function} o.getStage  () => 当前舞台实例（模板 B 要让形象做动作）
   * @param {Function} o.getVideo  () => 本机视频地址或 null（模板 A 的背景）
   * @param {Function} o.getMuted  () => 是否静音
   * @param {Function} o.getFit    () => 画面模式：'auto'（模糊铺底+完整显示）/ 'cover' / 'rotate'
   * @param {Function} o.onMutedChange (muted) => void  用户切换静音后回调（用于持久化）
   */
  function createBoot({ onEnter, getStage, getVideo, getMuted, getFit, onMutedChange } = {}) {
    const state = loadState();
    let root = null;         // 整个开屏层
    let raf = 0;
    let t0 = 0;
    let videoEl = null;
    let bgEl = null;
    let muteBtn = null;
    let canvasEl = null;
    let stageInUse = false;  // 模板 B 期间形象正在被开屏驱动
    let hoverTimer = null;

    /* ---------------- DOM ---------------- */

    function build() {
      root = document.createElement('div');
      root.className = 'boot';
      root.id = 'boot-screen';
      root.hidden = true;
      root.innerHTML = `
        <div class="boot-media">
          <!-- 模糊铺底：竖屏片源放进横屏窗口时，两侧会空出很大一块。
               业界通行做法是拿同一段视频放大模糊之后垫在后面，
               比留黑边好看得多（见 boot.js 的 syncVideos）。 -->
          <video class="boot-video-bg" playsinline muted loop preload="auto" aria-hidden="true"></video>
          <video class="boot-video" playsinline loop preload="auto"></video>
          <canvas class="boot-canvas"></canvas>
          <div class="boot-scrim"></div>
        </div>
        <div class="boot-body">
          <div class="boot-head">
            <div class="boot-mark">西湖文旅 · AI 导览</div>
            <h1 class="boot-title">杭州西湖</h1>
            <p class="boot-sub">世界文化遗产 · 一湖两塔三岛三堤</p>
          </div>
          <nav class="boot-menu" id="boot-menu"></nav>
          <div class="boot-foot">
            <div class="boot-hint" id="boot-hint"></div>
            <div class="boot-foot-row">
              <button class="boot-mute" id="boot-mute" type="button" aria-pressed="false"
                      title="点击静音 / 开启声音">🔊 有声</button>
              <label class="boot-auto">
                <input type="checkbox" id="boot-auto">
                <span>不再自动播放（顶栏「🎬 开屏」仍可手动重播）</span>
              </label>
              <div class="boot-switch">
                <span class="boot-switch-label">开屏模板</span>
                <div class="boot-switch-btns" id="boot-switch"></div>
              </div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(root);
      videoEl = root.querySelector('.boot-video');
      bgEl = root.querySelector('.boot-video-bg');
      muteBtn = root.querySelector('#boot-mute');
      // 静音开关。这一次点击是**真实用户手势**，浏览器到这时才允许出声 ——
      // 所以自动播放策略下，"先静音起播、让用户自己点开声音"是唯一稳的做法。
      if (muteBtn) {
        muteBtn.addEventListener('click', () => {
          // ★ 依据**视频当前实际的静音状态**来翻转，而不是依据偏好。
          //
          // 踩过的坑：原来用偏好判断，而开屏起播时出于自动播放策略一定是静音的，
          // 于是偏好说"有声"、实际是静音，按钮显示"点击开启声音"，
          // 点下去却把它**静音**了 —— 用户看到的是"点了没反应"。
          // 按钮的语义必须跟着听感走：现在没声 → 点一下有声。
          const next = !(videoEl && videoEl.muted);
          applyMute(next);
          // 用户手动做了选择之后，就别再让"首次手势自动开声"插手 ——
          // 否则他刚点了静音，下一次点击又给开回来。
          if (root) root.dataset.soundArmed = '1';
          if (onMutedChange) onMutedChange(next);
        });
      }
      canvasEl = root.querySelector('.boot-canvas');

      // "不再自动播放"勾选：让觉得开屏烦的用户自己关掉，而不是我替所有人做决定
      const autoCb = root.querySelector('#boot-auto');
      if (autoCb) {
        autoCb.checked = state.autoShow;
        autoCb.addEventListener('change', () => setAutoShow(autoCb.checked));
      }

      // 模板切换按钮
      const sw = root.querySelector('#boot-switch');
      TEMPLATES.forEach(t => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'boot-switch-btn';
        b.textContent = t.name;
        b.title = t.hint;
        b.dataset.tpl = t.id;
        b.addEventListener('click', () => setTemplate(t.id, { animate: true }));
        sw.appendChild(b);
      });

      // 入口
      const menu = root.querySelector('#boot-menu');
      ENTRIES.forEach((e, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'boot-entry';
        b.dataset.entry = e.id;
        b.style.setProperty('--i', String(i));
        b.innerHTML = `<span class="boot-entry-ico">${e.icon}</span>`
          + `<span class="boot-entry-txt"><b>${e.title}</b><i>${e.desc}</i></span>`
          // 直接把落地页写在按钮上：用户点之前就知道会去哪，
          // 也省得"点了之后发现不是我想要的那个页面"再来回找。
          + `<span class="boot-entry-go">${(PANE_LABEL[(e.target || {}).pane] || '')} ›</span>`;
        // 悬停/聚焦 → 让形象做对应动作。用户还没进主界面就先看到"形象是活的"。
        const react = () => {
          const st = getStage && getStage();
          if (!st) { hint(`${e.title} · 当前还没有加载形象`); return; }
          hint(`${e.title} · 形象正在响应`);
          // 不 await：悬停要高响应，动作慢慢播没关系。
          // 但必须 catch —— playEntryMotion 内部已经吞了异常，这里只防"没返回 Promise"。
          Promise.resolve(playEntryMotion(st, e)).catch(() => { /* 忽略 */ });
        };
        b.addEventListener('mouseenter', () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(react, 90); });
        b.addEventListener('focus', react);
        b.addEventListener('click', () => choose(e.id));
        menu.appendChild(b);
      });

      // Esc 直接进对话（别让用户被开屏困住）
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && !root.hidden) choose('chat');
      });
    }

    function hint(text) {
      const h = root && root.querySelector('#boot-hint');
      if (h) h.textContent = text || '';
    }

    /* ---------------- 模板切换 ---------------- */

    function applyTemplate(id) {
      state.template = id;
      saveState(state);
      root.dataset.tpl = id;
      root.querySelectorAll('.boot-switch-btn').forEach(b => {
        b.classList.toggle('on', b.dataset.tpl === id);
      });
      // 给 body 打标记：模板 B 是"露出主界面真实舞台"的，
      // 而主界面上还叠着词云、顶栏、侧栏这些操作界面 —— 不藏起来的话，
      // 开屏就成了"角色 + 一堆控件"糊在一起，完全不是"角色展示页"该有的样子。
      // 用 body 上的类而不是改那些元素的 style，是为了"收起来/放回去"永远成对，
      // 不会因为某条分支漏了还原而让界面缺一块。
      document.body.classList.toggle('boot-character', id === 'character' && !root.hidden);
      const t = TEMPLATES.find(x => x.id === id);
      hint(t ? t.hint : '');
    }

    function setTemplate(id, { animate } = {}) {
      if (!root || !TEMPLATES.some(t => t.id === id)) return;
      applyTemplate(id);
      if (animate) {
        // 重播一遍入场动画：模板换了却没有任何反馈，用户会以为没生效
        root.classList.remove('boot-in');
        void root.offsetWidth;      // 强制回流，否则加回 class 不会重新触发动画
        root.classList.add('boot-in');
        startMedia();
      }
    }

    /* ---------------- 背景媒体 ---------------- */

    function startMedia() {
      const isVideo = state.template === 'video';
      // 只有模板 A 需要整屏视频；模板 B 要让用户看见**真实舞台上的形象**，
      // 所以底层留给主界面，开屏只压一层暗色渐变。
      if (!isVideo) {
        if (videoEl) { try { videoEl.pause(); } catch { /* 忽略 */ } }
        pauseBg();
        stopCanvas();
        // ★ 关键：把开屏自己的兜底画布**让开**。
        //
        // 模板 B 的设计是"透明层 + 露出主界面真实舞台上的形象"，
        // 但画布只是停了 rAF，上一帧画的程序化西湖图还留在上面、opacity 也还是 1，
        // 于是它把真实形象整个盖住了 —— 表现就是"第 2 套里看到的不是主界面的形象"。
        // 停动画 ≠ 让开，必须显式把不透明度归零。
        if (canvasEl) canvasEl.style.opacity = '0';
        return;
      }

      // 模板 A：只能播**本机文件**。
      //
      // 早先这里还支持内嵌 B 站官方播放器，后来去掉了：播放器自带一套界面压不住，
      // 必须联网（断网就是黑屏），而且默认给窄版布局、竖屏片源在横屏窗口里只剩中间一条。
      // 现在统一走本地文件 —— 离线可用、能铺满、能用 <video> 直接控制声音。
      // 需要新的片子就用 `npm run fetch:bili -- <BV号> 名字` 下到 data/videos/。
      const url = getVideo && getVideo();
      if (url) {
        if (canvasEl) canvasEl.style.opacity = '0';
        stopCanvas();
        syncVideos(url);
      } else {
        // 没有视频 → 用程序化绘制的西湖动态画面兜底。
        // 这一段很重要：用户初次打开时 data/videos/ 必然是空的，
        // 没有它就只剩一块黑底，"视频主页"这个名字就成了笑话。
        if (videoEl) { try { videoEl.pause(); } catch { /* 忽略 */ } }
        pauseBg();
        if (canvasEl) canvasEl.style.opacity = '1';
        startCanvas();
      }
    }

    /* ---------------- 本地背景视频（含声音） ---------------- */

    /**
     * 把两路 <video> 都指向同一个本地文件并播放。
     *
     * 两路的原因：片源是竖屏（比如 B 站下的 9:16 片子），横屏窗口里两侧会空很多。
     * 所以一路 `boot-video-bg` 放大模糊铺底、一路 `boot-video` 原比例完整显示，
     * 叠起来就是常见的"模糊背景 + 居中主体"，比留黑边好看，也不用裁剪内容。
     *
     * **声音**：自动播放带声音会被浏览器拦（要等用户交互），所以统一**先静音起播**，
     * 保证画面一定出得来；用户点开屏上的 🔊 按钮时再解除静音 —— 那次点击是真实手势，
     * 浏览器就允许出声了。这是自动播放策略下唯一稳的做法。
     */
    function syncVideos(url) {
      const v = videoEl;
      if (!v) return;
      const fit = (getFit && getFit()) || 'cover';
      root.dataset.fit = fit;
      const wantSound = !Boolean(getMuted && getMuted());

      // ★ 永远先静音起播。
      //
      // 这里踩过一个坑：先前读到偏好是"有声"就立刻 `muted = false`，
      // 结果浏览器判定"带声音的自动播放"直接**把视频暂停**了 ——
      // 表现是开屏一片静止（甚至是黑的），而且只在"用户想要声音"时才会发生。
      // 静音自动播放是各浏览器都放行的，所以画面优先：先静音播起来。
      v.muted = true;
      v.loop = true;

      if (v.dataset.src !== url) {
        v.dataset.src = url;
        v.src = url;
        try { v.load(); } catch { /* 忽略 */ }
      }
      const p = v.play();
      if (p && p.catch) p.catch(() => { /* 真被拒了也没关系，底下还有程序化兜底 */ });

      // 偏好是"有声"时，按钮文案要引导用户点一下（那一次点击才是真实手势）
      updateMuteBtn(true, wantSound);
      if (wantSound) armFirstGestureUnmute();

      // 模糊底衬只在 auto 模式才加载，省一次解码
      if (fit === 'auto') {
        const bg = bgEl;
        if (bg) {
          bg.dataset.src = url;
          bg.src = url;
          bg.muted = true;
          try { bg.load(); } catch { /* 忽略 */ }
          const q = bg.play();
          if (q && q.catch) q.catch(() => { /* 忽略 */ });
        }
      } else {
        pauseBg();
      }
    }

    /**
     * 等第一次真实用户交互（点击/按键/触摸）再把声音放出来。
     *
     * 为什么必须这样做：浏览器只允许"静音"自动播放，或者"用户交互之后"有声播放。
     * 开屏是全屏自动出现的，我们拿不到用户手势，所以唯一能做的就是把声音
     * 挂到用户的第一个动作上 —— 他一碰页面，声音就来了。
     * 只挂一次（once），避免以后每次点击都去 play() 一下。
     */
    function armFirstGestureUnmute() {
      if (!root || root.dataset.soundArmed === '1') return;
      root.dataset.soundArmed = '1';
      const go = () => {
        if (getMuted && getMuted()) return;         // 用户选了静音就别开
        const v = videoEl;
        if (!v) return;
        v.muted = false;
        v.volume = 1;
        const p = v.play();
        if (p && p.catch) p.catch(() => { /* 仍被拒就保持静音 */ });
        updateMuteBtn(false, true);
      };
      // 用 once + 三种事件：任一先到就开声
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
        root.addEventListener(ev, go, { once: true, passive: true });
      }
    }

    function pauseBg() {
      const bg = bgEl;
      if (!bg) return;
      try { bg.pause(); } catch { /* 忽略 */ }
    }

    /** 只管按钮的样子（不碰 video 的声音状态，避免和自动播放策略打架） */
    function updateMuteBtn(muted, wantSound) {
      if (!muteBtn) return;
      if (!muted) {
        muteBtn.textContent = '🔊 有声';
        muteBtn.title = '点击静音';
      } else if (wantSound) {
        // 偏好是有声、但受自动播放限制暂时静音 —— 说清楚"点一下就响"
        muteBtn.textContent = '🔇 点击开启声音';
        muteBtn.title = '点一下就有声音';
      } else {
        muteBtn.textContent = '🔇 静音中';
        muteBtn.title = '点击开启声音';
      }
      muteBtn.classList.toggle('on', !muted);
      muteBtn.setAttribute('aria-pressed', muted ? 'false' : 'true');
    }

    /**
     * 用户在开屏上主动点静音开关。
     * 这是真实手势，所以"开声"这条路径一定能成。
     */
    function applyMute(muted) {
      const v = videoEl;
      if (!v) return;
      v.muted = muted;
      if (!muted) {
        v.volume = 1;                       // 只改 muted 有时会留下极小音量
        const p = v.play();
        if (p && p.catch) p.catch(() => { /* 忽略 */ });
      }
      updateMuteBtn(muted, !muted);
    }

    function startCanvas() {
      stopCanvas();
      const NV = window.WenlvLake;
      if (!NV || !canvasEl) return;
      const ctx = canvasEl.getContext('2d');
      const t0c = performance.now();
      const step = () => {
        raf = requestAnimationFrame(step);
        const host = canvasEl.parentElement;
        if (!host) return;
        const r = host.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.floor(r.width));
        const h = Math.max(1, Math.floor(r.height));
        if (canvasEl.width !== Math.floor(w * dpr) || canvasEl.height !== Math.floor(h * dpr)) {
          canvasEl.width = Math.floor(w * dpr);
          canvasEl.height = Math.floor(h * dpr);
          canvasEl.style.width = `${w}px`;
          canvasEl.style.height = `${h}px`;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        NV.drawLakeScene(ctx, w, h, (performance.now() - t0c) / 1000, '西湖');
      };
      step();
    }
    function stopCanvas() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    /* ---------------- 显示 / 隐藏 ---------------- */

    function choose(entryId) {
      hide();
      if (onEnter) onEnter(entryId);
    }

    function show({ replay } = {}) {
      if (!root) build();
      root.hidden = false;
      t0 = performance.now();
      applyTemplate(state.template);
      startMedia();      // 重播入场动画
      root.classList.remove('boot-in');
      void root.offsetWidth;
      root.classList.add('boot-in');
      // 模板 B：让形象切到"迎宾"状态，动作由悬停驱动
      if (state.template === 'character') {
        const st = getStage && getStage();
        if (st && st.playMotionByName) { try { st.playMotionByName('作揖'); } catch { /* 忽略 */ } }
        stageInUse = true;
      }
      void replay;
    }

    function hide() {
      if (!root) return;
      root.hidden = true;
      root.classList.remove('boot-in');
      stopCanvas();
      if (videoEl) { try { videoEl.pause(); } catch { /* 忽略 */ } }
      pauseBg();
      stageInUse = false;
      // 主界面的操作界面放回去（与 applyTemplate 里的 classList.toggle 成对）
      document.body.classList.remove('boot-character');
      state.entered = true;
      saveState(state);
    }

    /** 切换"下次打开是否自动播开屏" */
    function setAutoShow(on) {
      state.autoShow = Boolean(on);
      saveState(state);
      const cb = root && root.querySelector('#boot-auto');
      if (cb) cb.checked = state.autoShow;
    }

    function destroy() {
      hide();
      clearTimeout(hoverTimer);
      if (root && root.parentElement) root.parentElement.removeChild(root);
      root = null;
    }

    /* ======================================================================
     * 资源就绪通知
     *
     * 开屏现在是**页面一加载就盖上**的（不能等主界面加载完再弹，那样像卡了一下）。
     * 代价是它弹出来的那一刻：
     *   · 形象还没加载好（模板 B 想让形象做迎宾动作，会拿不到 stage）
     *   · 视频清单还没拿到（模板 A 会先走程序化西湖兜底）
     * 这两个都不是错误，只是"晚一点才对"。所以给两个显式通知，
     * 让 app.js 在相应资源到位后叫一声，开屏自己补上。
     * ====================================================================*/

    /** 形象加载好了：模板 B 下补一个迎宾动作 */
    function notifyStageReady() {
      if (!root || root.hidden) return;
      if (state.template !== 'character') return;
      const st = getStage && getStage();
      if (!st) return;
      const greet = ENTRIES[1];      // 「设置」那条用的是作揖，作为迎宾动作最合适
      Promise.resolve(playEntryMotion(st, greet)).catch(() => { /* 忽略 */ });
    }

    /** 视频清单就绪：模板 A 下若还没用上视频，重新决策一次 */
    function notifyVideosReady() {
      if (!root || root.hidden) return;
      if (state.template !== 'video') return;
      const url = getVideo && getVideo();
      // 只有确实有视频、且当前用的还是 canvas 兜底时才重来一遍，
      // 免得本来就在播视频却被无谓地重置（会闪一下黑）
      if (url && !(videoEl && videoEl.dataset.src === url)) startMedia();
    }

    return {
      /**
       * 启动时调用：默认**每次打开页面都播**（见 loadState 里关于 autoShow 的说明）。
       * 用户勾掉「不再自动播放」之后就不再自动弹，但顶栏的「🎬 开屏」仍能手动重播。
       */
      autoShow() {
        if (state.autoShow) show();
      },
      show: () => show({ replay: true }),
      hide,
      setAutoShow,
      notifyStageReady,
      notifyVideosReady,
      /**
       * 外观页改了「画面模式」或换了视频之后即时生效，不用重播开屏。
       * 只改 data-fit 的话，模糊底衬那一路视频的加载状态会跟模式对不上，
       * 所以重新走一遍 syncVideos（它会按当前模式决定要不要加载底衬）。
       */
      refreshFit() {
        if (!root) return;
        const url = videoEl && videoEl.dataset.src;
        if (url) syncVideos(url);
        else root.dataset.fit = (getFit && getFit()) || 'auto';
      },
      /** 让外部（外观页/测试）读到当前静音状态 */
      muted: () => Boolean(getMuted && getMuted()),
      destroy,
      setTemplate,
      get template() { return state.template; },
      get visible() { return Boolean(root && !root.hidden); },
      get entered() { return state.entered; },
      get autoShowOn() { return state.autoShow; },
      /** 测试用：重置状态 */
      _reset() { state.entered = false; state.autoShow = true; saveState(state); },
      _state: state,
      TEMPLATES,
      ENTRIES,
      playEntryMotion,
      _stageInUse: () => stageInUse,
    };
  }

  window.WenlvBoot = { createBoot, playEntryMotion, TEMPLATES, ENTRIES, LS_KEY };
})();
