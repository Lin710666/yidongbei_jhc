/* ============================================================================
 * wordcloud.js —— 交互词云
 *
 * 需求：把项目里"能做的事"全部变成可见、可点的词；点一下就直接触发对应效果。
 *
 * 实现要点：
 *   1. 布局用**阿基米德螺线 + 矩形碰撞检测**，把词排在一个"圆环"里 —— 环心留空，
 *      正好让 Live2D 人物站在中间不被遮住。这比随机撒点稳定得多，也不会叠字。
 *   2. 字号由权重线性映射（11~25px），权重高的更亮更大，形成天然的视觉层次。
 *   3. 每个词都有独立的悬浮动画参数（时长/延迟/振幅），整体是"呼吸感"而不是整齐划一。
 *   4. 词太多放不下时，多余的直接隐藏而不是压成一团 —— 密度滑块可以调节显示上限。
 *   5. 零依赖，纯 DOM 绝对定位；改词只改服务端 lib/wenlv.js 的 WORD_CLOUD。
 * ==========================================================================*/
(function () {
  'use strict';

  const { el } = window.U;

  // 每档最多显示多少词。
  // 默认档（2）改成全放：词库一共 64 个词（53 个功能词 + 11 个分组标签），
  // 以前默认只放 38 个，剩下的 15 个词用户永远看不到。改成全放之后并不显乱——
  // 因为分组标签机制会把成员词压淡，见 focusGroup()。
  // 1 档保留成"简洁模式"，给想要极简的人用。
  const DENSITY_LIMIT = { 1: 22, 2: 999, 3: 999 };

  /**
   * 碰撞矩形相对词本身外扩的间隙（唯一的真值来源，别在别处手写这几个数）。
   *
   * 垂直方向必须大于词的浮动幅度上限（layout 里 --float-amp 最大 5px），
   * 否则两个相邻的词会随着浮动晃到一起。实测上下各 6px 才稳。
   *
   * 血泪教训：螺线路径、兜底行排、以及 push 进 placed 的矩形**必须用同一套值**。
   * 之前改间隙时漏改了其中一处（兜底那处的写法带了 placed.push 前缀，替换没命中），
   * 结果螺线放下的词和兜底放下的词之间只剩 8px 余量，64 个词时出现了 28~55 对重叠。
   * 所以这里提成函数，所有地方都调它。
   */
  const PAD_X = 5;
  const PAD_Y = 6;
  const rectOf = (x, y, w, h) => ({ x: x - PAD_X, y: y - PAD_Y, w: w + PAD_X * 2, h: h + PAD_Y * 2 });

  class WordCloud {
    constructor(container, { onAction, onStep } = {}) {
      this.container = container;
      this.onAction = onAction || (() => {});
      this.onStep = onStep || null;   // 带箭头控件（游玩天数）加减时的回调
      this.words = [];
      this.nodes = new Map();      // word -> node
      this.density = 2;
      this.groupFilter = null;
      this.focusOn = null;         // 当前聚焦的分组名（null = 没聚焦）
      this.selected = new Set();   // 已选中的词（红框），由 setSelected() 更新
      this.hoverGroup = null;      // 鼠标正悬停的分组标签（该组成员词会露出来预览）
      this.animate = true;
      this._resizeTimer = null;
      this._ro = null;
      // 安全边距：上下要避开顶部工具栏与底部字幕条，左右要留边。
      // 之前这些浮动元素和词云互相叠，是界面显得乱的主要原因之一。
      this.insets = { top: 58, right: 14, bottom: 56, left: 14 };

      window.addEventListener('resize', () => {
        clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(() => this.layout(), 180);
      });
      // 容器尺寸变化（比如全屏切换）也要重排
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => {
          clearTimeout(this._resizeTimer);
          this._resizeTimer = setTimeout(() => this.layout(), 180);
        });
        this._ro.observe(container);
      }
    }

    /** 设置安全边距（由界面按实际工具栏 / 字幕条高度传入） */
    setInsets(insets) {
      const next = { ...this.insets, ...(insets || {}) };
      // 值没变就**不要重排**。重排会让所有词换位置，而用户很可能正打算点下一个词 ——
      // 词一跳位，那一指头就点到别处去了。这条保护很便宜，但能挡掉一大类"点不中"的怪问题。
      const same = ['top', 'right', 'bottom', 'left'].every((k) => next[k] === this.insets[k]);
      this.insets = next;
      if (!same) this.layout();
    }

    setWords(words) {
      this.words = (words || []).slice();
      this.render();
    }

    setDensity(level) { this.density = Number(level) || 2; this.render(); }
    setGroup(group) { this.groupFilter = group; this.render(); }

    /**
     * 聚焦某个分组：把该组点亮、其余压暗。再调一次同一个组名则取消。
     * 只改透明度、不重新布局，所以点下去词不会乱跳。
     * 返回聚焦后的组名（null 表示已取消），方便调用方同步 UI 状态。
     */
    focusGroup(group) {
      this.focusOn = (this.focusOn === group) ? null : (group || null);
      this._applyFocus();
      return this.focusOn;
    }

    clearFocus() { this.focusOn = null; this._applyFocus(); }

    /**
     * 设置哪些词处于「已选中」状态（红框高亮）。
     *
     * 这一层只负责画高亮，不管业务规则 —— 选中的依据是右侧表单里的实际值，
     * 由 app.js 的 syncCloudSelection() 反推出来传进来。
     * 这么做的好处是词云和表单永远一致：在表单里点掉一个 chip，词云上的框也会灭。
     */
    setSelected(words) {
      const next = new Set(words || []);
      // 没变化就别碰 DOM，否则每次点击都要刷 64 个节点
      if (next.size === this.selected.size && [...next].every((w) => this.selected.has(w))) return;
      this.selected = next;
      this._applySelection();
    }

    _applySelection() {
      for (const [word, node] of this.nodes) {
        node.classList.toggle('is-sel', this.selected.has(word));
      }
    }

    /**
     * 切换某个词的选中态，返回切换后是否处于选中。
     *
     * 同组互斥：点「苏州」会把同组的「杭州」取消掉 —— 因为一个行程只有一个目的地、
     * 一个预算档位，同时亮着两个反而让人以为能一起用。
     * 「兴趣」组例外（可以多选，和右侧表单里的兴趣 chip 一致），由调用方传 multi。
     */
    toggleSelect(word, { multi = false } = {}) {
      const item = this.words.find((w) => w.word === word);
      if (!item) return false;
      if (this.selected.has(word)) {
        this.selected.delete(word);
        this._applySelection();
        return false;
      }
      if (!multi && item.group) {
        for (const other of this.words) {
          if (other.group === item.group) this.selected.delete(other.word);
        }
      }
      this.selected.add(word);
      this._applySelection();
      return true;
    }

    isSelected(word) { return this.selected.has(word); }
    getSelected() { return [...this.selected]; }

    /**
     * 造一个带箭头的数值控件（目前给「游玩天数」用）。结构是：
     *      ▼  游玩天数 3天  ▲
     * 两个箭头各自 stopPropagation —— 不然点箭头会把整个词的 click action 一起触发，
     * 变成"调了天数又顺手执行了一次生成"。
     */
    _buildStepper(w) {
      const node = el('div', { class: 'wc-word wc-stepper' });
      const mkStep = (dir, glyph, title) => {
        const b = el('span', { class: 'wc-step', text: glyph });
        b.title = title;
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (this.onStep) this.onStep(w, dir);
        });
        return b;
      };
      node.appendChild(mkStep(-1, '▼', '少一天'));
      node.appendChild(el('span', { class: 'wc-step-label', text: w.word }));
      node.appendChild(mkStep(1, '▲', '多一天'));
      return node;
    }

    /** 更新某个词的显示文字（带箭头的那种只改中间那截标签，不碰箭头） */
    setWordLabel(word, text) {
      const node = this.nodes.get(word);
      if (!node) return;
      const label = node.querySelector('.wc-step-label');
      if (label) label.textContent = text;
      else node.textContent = text;
    }

    /**
     * 鼠标是不是还"在这一组的活动范围里"（该组的标签 / 成员词，或者整个舞台）。
     * 用来决定"离开标签之后要不要把预览收回去"。
     *
     * 这里刻意放宽到"只要鼠标还在舞台上就先不收"，而不是只认"鼠标正停在某个成员词上"：
     * 杭州和苏州之间是有空隙的，鼠标从杭州滑向苏州的途中会短暂落在空隙上，
     * 按"是否停在词上"判定会失败 → 该组被收回 → 苏州在鼠标到达之前就消失了，
     * 表现就是"点掉杭州、想改点苏州，却怎么都点不到"。
     */
    _peekStillNeeded(group) {
      const stageEl = this.container.parentElement;
      if (stageEl && stageEl.matches(':hover')) return true;
      const el = document.querySelector('#wordcloud-layer .wc-word:hover');
      return !!(el && el.dataset.group === group);
    }

    /** 把"悬停预览"的状态刷到 DOM：只有该组的成员词加了 is-peek */
    _applyHoverGroup() {
      for (const [word, node] of this.nodes) {
        node.classList.toggle('is-peek', !!this.hoverGroup
          && node.dataset.group === this.hoverGroup
          && node.dataset.role === 'member');
      }
    }

    /**
     * 把某一组的红框**对齐成实际生效的那个词**（word 传 null 表示这组不选任何词）。
     *
     * 为什么需要它：词条自带的 payload 可能顺带设了别的字段 —— 比如「避坑提示」的 payload 是
     * { city:'杭州', days:2, crowd:'带老人' }，点它会把"同行人群"也设成带老人。
     * 那这一组之前选过的「情侣」实际上已经失效了，红框却还亮着，屏幕上显示的条件
     * 和真正拿去生成的条件就对不上了。对齐之后红框永远等于实际值。
     */
    alignGroup(group, word) {
      let changed = false;
      for (const w of this.words) {
        if (w.group !== group) continue;
        const should = (w.word === word);
        const has = this.selected.has(w.word);
        if (should && !has) { this.selected.add(w.word); changed = true; }
        else if (!should && has) { this.selected.delete(w.word); changed = true; }
      }
      if (changed) this._applySelection();
    }


    /** 把聚焦状态刷到 DOM 上（render() 重建节点后也要补一次） */
    _applyFocus() {
      this.container.classList.toggle('wc-focus', !!this.focusOn);
      for (const node of this.nodes.values()) {
        node.classList.toggle('is-open', !!this.focusOn && node.dataset.group === this.focusOn);
      }
    }

    setAnimate(on) {
      this.animate = on;
      for (const node of this.nodes.values()) {
        node.style.animationPlayState = on ? 'running' : 'paused';
        node.style.animation = on ? '' : 'none';
      }
      if (on) this.layout();
    }

    /**
     * 字号量程说明（渲染和"换一批"两处都用这套规则，改的时候两边要一起改）：
     *
     * 原来是 Math.min(...weights, 0) / Math.max(...weights, 100)，等于拿 0~100 当量程。
     * 但实际显示的词权重都挤在 44~100 之间，算出来的 ratio 只在 0.44~1.0 徘徊，
     * 字号被压成 19~25px —— 公式名义上有 2.27 倍跨度，实际只用了 1.3 倍。
     * 结果就是所有词看起来一样大，眼睛没有落点，用户会觉得"词云很杂乱"。
     *
     * 改成按「当前实际显示的这些词」归一化后，字号能铺满 11~25px，
     * tier 分层也从「tier2 一个都没有」变成正常的三档。
     */
    get visibleWords() {
      let list = this.words.filter(w => !this.groupFilter || w.group === this.groupFilter);
      list = list.slice().sort((a, b) => (b.weight || 0) - (a.weight || 0));
      const limit = DENSITY_LIMIT[this.density] || 999;
      return list.slice(0, limit);
    }

    /** 重建 DOM（词集合变化时调用） */
    render() {
      const list = this.visibleWords;
      const keep = new Set(list.map(w => w.word));
      // 移除不再需要的节点
      for (const [word, node] of this.nodes) {
        if (!keep.has(word)) { node.remove(); this.nodes.delete(word); }
      }

      const weights = list.map(w => w.weight || 50);
      const minW = Math.min(...weights);
      const maxW = Math.max(...weights);

      for (const w of list) {
        let node = this.nodes.get(w.word);
        if (!node) {
          // 「游玩天数」这类带箭头的控件走单独一套结构：词本身带两个可点的箭头，
          // 直接在词云上就能调数值，不用为了改一天跑去右侧表单。
          node = w.action === 'days-stepper'
            ? this._buildStepper(w)
            : el('div', { class: 'wc-word', text: w.word });
          // 这两个属性是「分组渐进披露」的钩子：
          //   data-group 给聚焦用（点标签时知道该点亮哪些）
          //   data-role  给 CSS 用（label/core 常亮，member 默认压淡）
          node.dataset.group = w.group || '';
          node.dataset.role = w.role || 'member';
          // 分组标签：鼠标悬停时把**这一组**的成员词露出来预览。
          // 成员词默认是藏着的，只有悬停/点击具体的标签才出来 ——
          // 这样"平时干净"和"想看细节随时能看"两件事不冲突。
          if ((w.role || 'member') === 'label') {
            let peekTimer = null;
            node.addEventListener('mouseenter', () => {
              clearTimeout(peekTimer);
              this.hoverGroup = w.group;
              this._applyHoverGroup();
            });
            node.addEventListener('mouseleave', () => {
              clearTimeout(peekTimer);
              // 延迟一点再收：鼠标很可能是从标签移到该组的某个成员词上去了，
              // 立刻收的话那批词会在鼠标到达之前消失，根本点不到。
              peekTimer = setTimeout(() => {
                if (this._peekStillNeeded(w.group)) return;
                this.hoverGroup = null;
                this._applyHoverGroup();
              }, 180);
            });
          }
          node.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.flash(w.word);
            this.onAction(w);
          });
          node.title = w.hint ? `${w.word} —— ${w.hint}` : w.word;
          this.container.appendChild(node);
          this.nodes.set(w.word, node);
        }
        const ratio = maxW === minW ? 0.5 : ((w.weight || 50) - minW) / (maxW - minW);
        // 字号量程 10~21px。原本是 11~25px，但实测 64 个词（11 标签 + 4 核心 + 49 成员）
        // 在 936×798 的舞台上放不下：螺线环可覆盖面积约 347,900 px²，
        // 11~25px 需要约 329,664 px²（占用率 95%），结果有 20 对词重叠。
        // 收敛到 10~21px 后占用率降到 80%，重叠 0 对，最大词宽只从 153px 变成 133px。
        let size = 10 + ratio * 11;                   // 10px ~ 21px
        // 分组标签是词云的"骨架"，太小的标签就不像标签了。
        // 实测按权重算下来，「形象」只有 13px，和成员词一样大，看不出它是个能点开的入口。
        if (w.role === 'label') size = Math.max(size, 16);
        node.style.fontSize = `${size.toFixed(1)}px`;
        node.dataset.tier = ratio > 0.72 ? '0' : ratio > 0.42 ? '1' : '2';
        node.dataset.fontSize = size.toFixed(1);
        node.hidden = false;
      }
      this._applyFocus();   // 节点是重建的，聚焦状态会丢，这里补回来
      this._applySelection();   // 选中态同理
      this._applyHoverGroup();  // 悬停预览也同理
      this.layout();
    }

    /**
     * 螺线布局：从环心开始向外绕，第一个不碰撞的位置就放下。
     *
     * 人物的排除区用**椭圆**而不是圆：Live2D 角色是"竖长条"的站姿
     * （本机实测约 0.42 : 0.94 的宽高比），用圆会让词压在她身上。
     * 椭圆横向窄、纵向高，词自然落到左右两侧与上下方，中间完整留给她。
     */
    layout() {
      const W = this.container.clientWidth;
      const H = this.container.clientHeight;
      if (!W || !H) return;

      // 可用区域 = 容器减去安全边距（顶部工具栏、底部字幕条）
      const ins = this.insets;
      const availL = ins.left;
      const availT = ins.top;
      const availR = W - ins.right;
      const availB = H - ins.bottom;
      const availW = Math.max(1, availR - availL);
      const availH = Math.max(1, availB - availT);
      if (availW < 120 || availH < 120) return;      // 太小就别排了，免得叠成一团

      const cx = availL + availW / 2;                    // 螺线中心：可用区中心（排布用）
      const cy = availT + availH / 2;

      // 人物排除椭圆的圆心必须用**舞台中心**，而不是可用区中心。
      // 原因：Live2D 人物是站在舞台正中的（与字幕条无关），而"可用区"会被
      // 顶部工具栏和底部字幕条挤压、整体上移。两者一旦用同一个圆心，
      // 字幕条一出现，排除区就跟着往上跑，人物的下半身就漏出来被词压住了。
      const charCx = W / 2;
      const charCy = H / 2;

      const minDim = Math.min(availW, availH);
      const exRx = minDim * 0.22;                        // 椭圆横半轴：人物的"肩宽"再加一点余量
      const exRy = minDim * 0.47;                        // 椭圆纵半轴：人物的"身高"
      const rMin = minDim * 0.16;
      const rMax = minDim * 0.53;
      const placed = [];                                 // 已占用的矩形（含内边距）

      // 矩形是否侵入人物排除椭圆：取矩形上离椭圆中心最近的点来判定
      const hitsCharacter = (rect) => {
        const nearestX = Math.max(rect.x, Math.min(charCx, rect.x + rect.w));
        const nearestY = Math.max(rect.y, Math.min(charCy, rect.y + rect.h));
        const dx = (nearestX - charCx) / exRx;
        const dy = (nearestY - charCy) / exRy;
        return dx * dx + dy * dy < 1;
      };

      const list = this.visibleWords;
      const nodes = list.map(w => this.nodes.get(w.word)).filter(Boolean);

      // 可用区太小的时候（窄屏）螺线放不下，退化为"底部横排"
      const tooSmall = availW < 420 || availH < 300;

      for (const node of nodes) {
        const w = node.offsetWidth || 60;
        const h = node.offsetHeight || 24;
        let x = null;
        let y = null;

        if (!tooSmall) {
          // 阿基米德螺线：theta 走一圈，r 线性增长
          const step = 0.30;
          const dr = 3.2;
          let theta = 0;
          for (let i = 0; i < 2600; i++) {
            const r = rMin + (i * dr) / 40;
            if (r > rMax) break;
            theta += step;
            const px = cx + Math.cos(theta) * r - w / 2;
            const py = cy + Math.sin(theta) * r * 0.92 - h / 2;   // 纵向略压，更像"环绕"
            // 碰撞矩形比词本身大一圈（间隙统一由 rectOf 决定，见文件顶部说明）
            const rect = rectOf(px, py, w, h);
            // 边界用的是"可用区"，不是容器 —— 这样词不会被工具栏或字幕条压住
            if (px < availL || py < availT || px + w > availR || py + h > availB) continue;
            if (hitsCharacter(rect)) continue;
            if (placed.some(q => !(rect.x + rect.w < q.x || q.x + q.w < rect.x || rect.y + rect.h < q.y || q.y + q.h < rect.y))) continue;
            x = px; y = py;
            placed.push(rect);
            break;
          }
        }

        if (x === null) {
          // 兜底：底部一行行排（窄屏 / 词太多）。这里同样要避开人物，
          // 否则螺线放不下的词会直接堆到人物身上。
          const rect = this._packRow(placed, availL, availT, availR, availB, w, h, hitsCharacter);
          x = rect.x; y = rect.y;
          placed.push(rectOf(x, y, w, h));   // ← 这里曾经漏改过，间隙必须和螺线路径一致
        }

        node.hidden = false;
        node.style.left = `${Math.round(x)}px`;
        node.style.top = `${Math.round(y)}px`;
        if (this.animate) {
          // 每个词一套独立的浮动参数，避免整体像一块板在动
          const dur = 7 + Math.random() * 5;
          const delay = -Math.random() * 6;
          // 浮动幅度上限 5px，和上面碰撞矩形的垂直余量（上下各 6px）配套。
          // 原来是 3~8px，超过了余量，两个相邻的词会在浮动中晃到一起（实测会重叠）。
          const amp = 2 + Math.random() * 3;
          node.style.setProperty('--float-dur', `${dur.toFixed(1)}s`);
          node.style.setProperty('--float-delay', `${delay.toFixed(1)}s`);
          node.style.setProperty('--float-amp', `${amp.toFixed(1)}px`);
        }
      }
    }

    /**
     * 底部行式排布：在可用区里从下往上找空位（同时避开人物排除区）。
     * 参数是"可用区"而不是容器，这样工具栏与字幕条所在的位置天然不会被占用。
     */
    _packRow(placed, availL, availT, availR, availB, w, h, hitsCharacter) {
      const pad = 4;
      const gapY = 7;
      const blocks = (rect) => {
        if (hitsCharacter && hitsCharacter(rect)) return true;
        return placed.some(q => !(rect.x + rect.w < q.x || q.x + q.w < rect.x || rect.y + rect.h < q.y || q.y + q.h < rect.y));
      };
      let y = availB - h - pad;
      for (let guard = 0; guard < 80; guard++) {
        let x = availL + pad;
        while (x + w <= availR - pad) {
          const rect = rectOf(x, y, w, h);
          if (!blocks(rect)) return { x, y };
          x += 12;                              // 每次右移一点再试，尽量塞满这一行
        }
        y -= h + gapY;
        if (y < availT + pad) break;
      }
      // 兜底：螺线没找到位置时，在整片可用区里按网格逐格找。
      // 关键是不能像原来那样直接返回同一个坐标 —— 那样所有放不下的词会完全叠在一起，
      // 而且 placed 里一旦堆进重叠矩形，后面的词就更找不到位置，形成恶性循环。
      // （实测 64 个词时，左下角一个点上叠了 20 多个词。）
      const stepX = 14;
      const stepY = 10;
      for (let yy = availB - h - pad; yy >= availT + pad; yy -= stepY) {
        for (let xx = availL + pad; xx + w <= availR - pad; xx += stepX) {
          const rect = rectOf(xx, yy, w, h);
          if (!blocks(rect)) return { x: xx, y: yy };
        }
      }
      // 整片可用区真的一点空位都没有了（词太多 / 舞台太小）：回到最高处，
      // 并且按调用次序横向错开，至少不要叠在同一个像素上。
      const spill = (this._spill = (this._spill || 0) + 1);
      return {
        x: availL + pad + ((spill - 1) % 8) * 12,
        y: Math.max(availT + pad, availB - h - pad - Math.floor((spill - 1) / 8) * (h + gapY)),
      };
    }

    /** 点击时的高亮脉冲 */
    flash(word) {
      const node = this.nodes.get(word);
      if (!node) return;
      node.classList.remove('flash');
      void node.offsetWidth;                    // 强制回流，让动画能重播
      node.classList.add('flash');
      setTimeout(() => node.classList.remove('flash'), 720);
    }

    /** 重新随机排布（"换一批"按钮） */
    shuffle() {
      const list = this.visibleWords;
      // 打乱顺序即改变放置先后，观感上就是重排
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      const order = new Map(list.map((w, i) => [w.word, i]));
      const weights = list.map(w => w.weight || 50);
      const minW = Math.min(...weights);
      const maxW = Math.max(...weights);
      // 通过对调权重制造新的字号层次，再按新顺序放置
      for (const w of list) {
        const ratio = maxW === minW ? 0.5 : ((w.weight || 50) - minW) / (maxW - minW);
        let size = 10 + ratio * 11;                          // 量程同 render()，见那里的说明
        if (w.role === 'label') size = Math.max(size, 16);    // 标签字号下限，规则同 render()
        const node = this.nodes.get(w.word);
        if (node) node.style.fontSize = `${size.toFixed(1)}px`;
      }
      this._order = order;
      this.layout();
    }

    destroy() {
      if (this._ro) this._ro.disconnect();
      for (const node of this.nodes.values()) node.remove();
      this.nodes.clear();
    }
  }

  window.WordCloud = WordCloud;
})();
