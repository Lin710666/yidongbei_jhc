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

  /**
   * 开屏模板清单。
   *
   * 目前**只保留「视频主页」一套** —— 形象主页已按要求砍掉。
   * 相关代码文件都还在（js/boot-puppet.js、boot-art.js、boot-hanfu.js），
   * 想把形象主页加回来，只要把下面注释掉的那一行放出来：
   *
   *   { id: 'character', name: '形象主页', hint: '…' },
   *
   * 加回来之后：
   *   · 模板切换器会自动出现（只有一套时它是隐藏的，见 build()）
   *   · 存量用户 localStorage 里如果存着 'character'，loadState() 会校验并回落到 video，
   *     所以不会出现"界面上没有这一套、却停在这一套"的情况
   */
  const TEMPLATES = [
    { id: 'video', name: '视频主页', hint: '整屏播西湖宣传片，三个功能入口' },
    // { id: 'character', name: '形象主页', hint: '立绘站在暗场里，鼠标划过菜单就换动作' },
  ];

  /**
   * 模板 B 专用的汉服模型（减面版）地址。
   *
   * 为什么是"减面版"：原始工程导出的 glb 有 64MB（50 万顶点）。
   * 开屏是**页面一打开就盖上**的东西，让首屏等 64MB 下载完是不可接受的。
   * 这一版减到 12% 的面（6 万顶点）→ 16MB，权重的形状看不出差别，
   * 而 10 段动作一个不少（动作存在 NLA 轨道上，与顶点数无关）。
   * 生成脚本见 out/blender-hanfu/rig/make-web-glb.py。
   */
  /**
   * 形象主页用哪种形象。
   *
   *   'puppet' —— 2D 立绘 + **网格形变木偶**（默认）。整张立绘贴到细分网格上，
   *               在顶点着色器里按部位做权重形变 —— 头会跟着鼠标转、会呼吸、
   *               悬停菜单会作揖/侧身。参数名沿用 Cubism 标准命名，见 js/boot-puppet.js。
   *   'art'    —— 2D 立绘 + 分层视差（不动骨骼，只有呼吸/摇曳/光扫）。
   *   '3d'     —— 汉服 glb 三维场景（js/boot-hanfu.js）。
   *
   * 三套控制器对外接口一致（react / greet / setVisible / resize / dispose），
   * 所以这里改一个词就够了。
   */
  const CHARACTER_STYLE = 'puppet'

  /** 形象主页的 2D 立绘（已经抠好透明底，见 out/blender-hanfu/rig/cutout-avatar.mjs） */
  const ART_URL = '/avatars/hanfu-girl.png'

  const HANFU_URL = '/models3d/hanfu/hanfu.glb';

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
    let loadingEl = null;    // 载入遮罩（宣传片还没能播时盖住那几秒）
    let loadingTimer = 0;    // 兜底：卡住也要把遮罩撤掉，不能永远挡着
    let stageInUse = false;  // 模板 B 期间形象正在被开屏驱动
    let hoverTimer = null;
    /* ---------------- 模板 B 专属的汉服三维场景 ----------------
     * 见 js/boot-hanfu.js。这是一块**独立于主舞台**的画布：
     * 开屏固定展示汉服模型 + 它自带的那 10 段动作，
     * 和"主界面当前选了哪个形象"无关（换 Live2D 也不会影响开屏）。
     */
    let hanfu = null;          // 场景控制器
    let hanfuLoading = null;   // 加载中的 Promise（防止并发重复加载）
    let hanfuFailed = false;   // 加载失败 → 退回"露出主舞台形象"的老行为

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

          <!-- 载入遮罩：宣传片是本机文件，取片、解码、等 canplay 加起来有几秒。
               这几秒里如果直接露底，用户看到的是"先闪一下程序化西湖、再切成视频"，
               像卡了一下。所以拿一层带进度条的载入动画把这段时间盖住，
               视频真的能播了再淡出。 -->
          <div class="boot-loading" id="boot-loading" hidden>
            <div class="bl-mark" aria-hidden="true"><i></i><i></i><i></i><b></b></div>
            <div class="bl-title" id="boot-loading-title">正在载入宣传片…</div>
            <div class="bl-bar" aria-hidden="true"><i></i></div>
          </div>
        </div>
        <div class="boot-body">
          <div class="boot-head">
            <div class="boot-mark">HikiTravel · 文旅智能辅助</div>
            <h1 class="boot-title">智能文旅辅助系统</h1>
            <p class="boot-sub">本机大模型驱动 · 一句话生成可执行行程</p>
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
      // 交给全局静音中枢：开屏视频、功能页配乐、朗读共用一个状态。
      //
      // ★ 开屏视频**不能**标 keepMuted。
      //   标了就等于"它永远静音、谁都开不了声"：全局状态切到有声时
      //   sync() 仍会把它按回 muted=true —— 表现就是"点声音键没反应、
      //   这个界面一直没有声音"（实测调用栈 syncAll→sync 把 muted 写成 true）。
      //   它的初始静音由 syncVideos() 负责（自动播放的硬前提），
      //   用户点一次之后由全局状态接管。
      //   真正需要 keepMuted 的只有下面那路**模糊铺底**视频 —— 它是纯装饰，
      //   出声只会和主视频叠成两重音。
      if (window.WenlvMute) {
        window.WenlvMute.apply(videoEl);
        window.WenlvMute.apply(bgEl, { keepMuted: true });
      }
      muteBtn = root.querySelector('#boot-mute');
      // 静音开关。这一次点击是**真实用户手势**，浏览器到这时才允许出声 ——
      // 所以自动播放策略下，"先静音起播、让用户自己点开声音"是唯一稳的做法。
      if (muteBtn) {
        /**
         * 开屏这个键的语义：**它说的是"这个视频现在有没有声音"**。
         *
         * 为什么不能直接看全局状态：开屏起播出于自动播放策略一定是静音的，
         * 而全局状态默认是"有声" —— 两者天然错位。若按全局态渲染文案，
         * 就会显示「有声」但实际没声音；点一下反而先把它**静音**（用户体感：
         * 点了没反应，或多点一次才有声）。所以按钮文案跟 videoEl.muted 走。
         */
        const reconcileMuteBtn = () => {
          const audiblyMuted = videoEl ? videoEl.muted : Boolean(window.WenlvMute && window.WenlvMute.isMuted());
          updateMuteBtn(audiblyMuted, !audiblyMuted);
        };

        muteBtn.addEventListener('click', () => {
          // 点击意图由**当前听感**决定：现在没声 → 这次要开声。
          const wantSound = Boolean(videoEl && videoEl.muted);
          const v = videoEl;
          if (window.WenlvMute) {
            // 把"要听到的结果"写进全局状态；真实手势已经拿到，所以能开得起来
            window.WenlvMute.set(!wantSound);
            if (v && wantSound) {
              v.volume = 1;
              const p = v.play();
              if (p && p.catch) p.catch(() => { /* 仍被拒就保持静音 */ });
            }
          } else if (v) {
            v.muted = !wantSound;
            if (wantSound) {
              v.volume = 1;
              const p = v.play();
              if (p && p.catch) p.catch(() => { /* 忽略 */ });
            }
          }
          reconcileMuteBtn();
          if (onMutedChange) onMutedChange(!wantSound);
        });

        // 右上角悬浮键（或别处）改了全局状态时，这里跟着重算，文案与听感始终一致
        if (window.WenlvMute) {
          window.WenlvMute.onChange(() => reconcileMuteBtn());
        }
      }
      canvasEl = root.querySelector('.boot-canvas');
      loadingEl = root.querySelector('#boot-loading');

      // "不再自动播放"勾选：让觉得开屏烦的用户自己关掉，而不是我替所有人做决定
      const autoCb = root.querySelector('#boot-auto');
      if (autoCb) {
        autoCb.checked = state.autoShow;
        autoCb.addEventListener('change', () => setAutoShow(autoCb.checked));
      }

      // 模板切换按钮。
      // 只剩一套模板时把整个切换器收起来 —— 留一个"只有一项的下拉/按钮组"
      // 既占地方又让人以为还有别的可选。
      const sw = root.querySelector('#boot-switch');
      const swWrap = root.querySelector('.boot-switch');
      if (TEMPLATES.length < 2) {
        if (swWrap) swWrap.hidden = true;
      } else {
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
      }

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
          // 模板 B 优先走汉服场景 —— 它才是开屏上**实际显示**的那个形象。
          // 不先问它而去驱动主舞台的话，用户看到的是"划过菜单，画面里的人没反应"
          // （因为主舞台上那个形象根本没显示出来）。
          if (state.template === 'character' && hanfu) {
            if (hanfu.react(e.id)) { hint(`${e.title} · 形象正在响应`); return; }
          }
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

    /* ---------------- 载入遮罩 ----------------
     * 宣传片是本机文件，但从"决定要播"到"真的能播"中间隔着：
     * 取片 → 解码 → canplay。实测有几秒。这几秒如果直接露底，
     * 用户看到的是"先闪一下程序化西湖、再硬切成视频"，像卡了一下。
     * 用一层带进度条的动画盖住，视频能播了再淡出。
     */

    function showLoading(text) {
      if (!loadingEl) return;
      clearTimeout(loadingTimer);
      loadingEl.hidden = false;
      loadingEl.classList.remove('bl-out');
      const t = loadingEl.querySelector('#boot-loading-title');
      if (t && text) t.textContent = text;
      setLoadingProgress(0);
      // 兜底：真卡住了（文件损坏、浏览器不给播）也要撤遮罩，
      // 底下还有程序化西湖兜着，不能让用户对着动画干等。
      loadingTimer = setTimeout(hideLoading, 12000);
    }

    function setLoadingProgress(p) {
      if (!loadingEl) return;
      const bar = loadingEl.querySelector('.bl-bar i');
      if (bar) bar.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
    }

    function hideLoading() {
      clearTimeout(loadingTimer);
      if (!loadingEl || loadingEl.hidden) return;
      loadingEl.classList.add('bl-out');
      setTimeout(() => { if (loadingEl) loadingEl.hidden = true; }, 460);
    }

    /* ---------------- 模板 B：汉服三维场景 ---------------- */

    /**
     * 确保汉服开屏场景已就绪。
     *
     * 三个设计决定：
     *   1. **按需动态 import**。three.js 1.3MB + GLTFLoader，模板 A 的用户
     *      不该为它们付下载代价。这和 stage3d.js 的做法一致。
     *   2. **失败不抛给调用方**。glb 缺失 / WebGL 被禁 / 离线，任何一个都可能发生；
     *      退回到原来的"露出主舞台形象"行为就行，开屏不能因为一个模型挂了就整块黑掉。
     *   3. **同一个 Promise 复用**。show() 和 startMedia() 都会调它，
     *      不做去重就会出现两个场景叠在一起（画面闪烁、显存翻倍）。
     */
    function ensureHanfu() {
      if (hanfu || hanfuFailed) return hanfuLoading;
      if (hanfuLoading) return hanfuLoading;
      const media = root && root.querySelector('.boot-media');
      if (!media) return null;

      hint('形象加载中…');
      const load = {
        puppet: () => import('/js/boot-puppet.js').then(mod => mod.createPuppetSplash({ mount: media, url: ART_URL })),
        art: () => import('/js/boot-art.js').then(mod => mod.createArtSplash({ mount: media, url: ART_URL })),
        '3d': () => import('/js/boot-hanfu.js').then(mod => mod.createHanfuSplash({
          mount: media,
          url: HANFU_URL,
          onProgress: (p) => {
            hint(p == null ? '形象加载中…' : `形象加载中… ${Math.round(p * 100)}%`);
          },
        })),
      }[CHARACTER_STYLE] || (() => import('/js/boot-art.js').then(mod => mod.createArtSplash({ mount: media, url: ART_URL })));

      hanfuLoading = load()
        .then((ctrl) => {
          hanfu = ctrl;
          // 加载完时开屏可能已经被用户关掉了，那就别亮出来
          const live = root && !root.hidden && state.template === 'character';
          ctrl.setVisible(live);
          if (live) ctrl.greet();
          if (live) hint(TEMPLATES.find(t => t.id === 'character').hint);
          return ctrl;
        })
        .catch((err) => {
          hanfuFailed = true;
          console.warn('[开屏] 汉服形象没能加载，退回主舞台形象：', err);
          // 退回老路径：让 .boot-media 保持透明，露出主舞台上当前的形象
          root && root.classList.add('boot-hanfu-fallback');
          hint('形象加载失败，已改用主界面形象');
          return null;
        });
      return hanfuLoading;
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
      // 切到模板 A 时把汉服场景停掉：它虽然被视频盖住了，
      // 但不停的话 WebGL 会一直在后台空转（白烧电、笔记本风扇会响）。
      if (hanfu) hanfu.setVisible(id === 'character' && !root.hidden);
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
        // 程序化西湖图那张画布只是停了 rAF，上一帧还留在上面、opacity 也还是 1，
        // 不显式归零的话它会盖住整个模板 B。停动画 ≠ 让开。
        if (canvasEl) canvasEl.style.opacity = '0';
        // 模板 B 现在有自己的汉服三维场景（画在 .boot-hanfu 上），
        // 所以"露出主舞台"只是**加载失败时**的退路，不再是主路径。
        hideLoading();
        ensureHanfu();
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
      // 全局静音中枢优先：它同时管着开屏视频、功能页配乐与朗读
      const wantSound = window.WenlvMute
        ? !window.WenlvMute.isMuted()
        : !Boolean(getMuted && getMuted());

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

      // ---- 载入遮罩接线（每个 video 只接一次，避免反复 syncVideos 时监听器堆积）----
      if (v.dataset.lwired !== '1') {
        v.dataset.lwired = '1';
        v.addEventListener('progress', () => {
          try {
            if (v.buffered.length && v.duration) {
              setLoadingProgress(v.buffered.end(v.buffered.length - 1) / v.duration);
            }
          } catch { /* 时长还没解析出来时读 buffered 会抛，忽略 */ }
        });
        // 能播了就撤遮罩。**故意的分界**：
        //   canplay 只把进度条推到 100%，不撤遮罩 —— 实测 canplay 之后到真的出画面
        //   还有约 2 秒，那 2 秒撤了遮罩就是"露底"（用户看到的就是先闪画布再切视频）。
        //   只有 playing（确实开始播了）才撤。
        v.addEventListener('loadeddata', () => setLoadingProgress(1));
        v.addEventListener('canplay', () => setLoadingProgress(1));
        v.addEventListener('playing', () => { setLoadingProgress(1); hideLoading(); });
        v.addEventListener('error', () => {
          hint('宣传片没能加载，先用程序化西湖兜底');
          hideLoading();
        });
      }

      // 已经在播就别再闪遮罩（例如换了背景又切回来）
      if (!v.paused && v.readyState >= 3) hideLoading();
      else showLoading('正在载入宣传片…');

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
        if (window.WenlvMute) {
          // "开声"是用户的意图，所以写进**全局**状态 —— 否则会出现
          // 开屏有声音、进了功能页配乐却是静音的割裂。
          window.WenlvMute.set(false);
          const v0 = videoEl;
          if (v0) {
            const p0 = v0.play();
            if (p0 && p0.catch) p0.catch(() => { /* 仍被拒就保持静音 */ });
          }
          updateMuteBtn(false, true);
          return;
        }
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
      if (window.WenlvMute) {
        // 全局状态说了算；它会把状态刷到开屏视频、配乐、朗读所有元素上
        window.WenlvMute.set(Boolean(muted));
        const m = Boolean(window.WenlvMute.isMuted());
        // 第二个参数只影响"偏好有声但暂时静音"那句提示文案；
        // 这里已经明确设成 muted 了，所以两处同值即可，避免参数错位。
        updateMuteBtn(m, m);
        return;
      }
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
      // 开屏出现时，把**全局静音状态对齐到"用户将听到的实际情况"**：
      // 出于自动播放策略，开屏视频一定是静音起播的；而此时全局状态可能仍是
      // 上次留下的"有声"。两者不统一的话，右上角悬浮键会显示「有声」而
      // 开屏自带的键显示「点击开启声音」—— 同一屏两个说法互相矛盾。
      // 这里以开屏视频的实际 muted 为准回写全局，两边就一致了。
      if (window.WenlvMute && videoEl) {
        const wantSound = !videoEl.muted;
        if (window.WenlvMute.isMuted() === wantSound) window.WenlvMute.set(!wantSound);
      }
      if (window.WenlvMute && window.WenlvMute.setScene) {
        window.WenlvMute.setScene('boot');
      }
      t0 = performance.now();
      applyTemplate(state.template);
      // ★ 遮罩要在**开屏一出现**就亮，不能等 syncVideos ——
      //   从"页面加载"到"拿到视频清单"中间还隔着一次 /api/videos 往返，
      //   那一秒多里如果不盖，用户先看到的是程序化西湖，然后才被视频顶掉。
      if (state.template === 'video') showLoading('正在载入宣传片…');
      startMedia();      // 重播入场动画
      root.classList.remove('boot-in');
      void root.offsetWidth;
      root.classList.add('boot-in');
      // 模板 B：让形象切到"迎宾"状态，动作由悬停驱动
      if (state.template === 'character') {
        // 自己的汉服场景：亮出来并做一次迎宾动作。
        // setVisible(true) 会重置 clock，避免"隐藏期间积攒的 delta"让模型闪跳一下。
        if (hanfu) {
          hanfu.setVisible(true);
          hanfu.resize();
          hanfu.greet();
        } else {
          const p = ensureHanfu();
          if (p && p.then) {
            p.then((ctrl) => {
              if (ctrl && root && !root.hidden && state.template === 'character') {
                ctrl.setVisible(true);
                ctrl.resize();
                ctrl.greet();
              }
            });
          }
        }
        // 退路：万一汉服场景没起来，仍然按老办法驱动主舞台上的形象
        const st = getStage && getStage();
        if (st && st.playMotionByName) { try { st.playMotionByName('作揖'); } catch { /* 忽略 */ } }
        stageInUse = true;
      }
      void replay;
    }

    function hide() {
      if (!root) return;
      root.hidden = true;
      // 回到功能页：这时候才允许配乐出声（开屏期间它是暂停的，见 audio-mute 的 setScene）
      if (window.WenlvMute && window.WenlvMute.setScene) {
        window.WenlvMute.setScene('main');
      }
      root.classList.remove('boot-in');
      stopCanvas();
      if (videoEl) { try { videoEl.pause(); } catch { /* 忽略 */ } }
      pauseBg();
      // 汉服场景停渲染（不是销毁）：用户很可能还会点「🎬 开屏」再看一次，
      // 销毁了就得重新下载 16MB。setVisible(false) 只是停 rAF。
      if (hanfu) hanfu.setVisible(false);
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
      // 真正销毁（页面级清理）：停 rAF、释放几何/材质/贴图、摘掉画布
      if (hanfu) { try { hanfu.dispose(); } catch { /* 忽略 */ } hanfu = null; }
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
