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

  const DENSITY_LIMIT = { 1: 22, 2: 38, 3: 999 };

  class WordCloud {
    constructor(container, { onAction } = {}) {
      this.container = container;
      this.onAction = onAction || (() => {});
      this.words = [];
      this.nodes = new Map();      // word -> node
      this.density = 2;
      this.groupFilter = null;
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
      this.insets = { ...this.insets, ...(insets || {}) };
      this.layout();
    }

    setWords(words) {
      this.words = (words || []).slice();
      this.render();
    }

    setDensity(level) { this.density = Number(level) || 2; this.render(); }
    setGroup(group) { this.groupFilter = group; this.render(); }
    setAnimate(on) {
      this.animate = on;
      for (const node of this.nodes.values()) {
        node.style.animationPlayState = on ? 'running' : 'paused';
        node.style.animation = on ? '' : 'none';
      }
      if (on) this.layout();
    }

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
      const minW = Math.min(...weights, 0);
      const maxW = Math.max(...weights, 100);

      for (const w of list) {
        let node = this.nodes.get(w.word);
        if (!node) {
          node = el('div', { class: 'wc-word', text: w.word });
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
        const size = 11 + ratio * 14;                   // 11px ~ 25px
        node.style.fontSize = `${size.toFixed(1)}px`;
        node.dataset.tier = ratio > 0.72 ? '0' : ratio > 0.42 ? '1' : '2';
        node.dataset.fontSize = size.toFixed(1);
        node.hidden = false;
      }
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
            const rect = { x: px - 5, y: py - 4, w: w + 10, h: h + 8 };
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
          placed.push({ x: x - 5, y: y - 4, w: w + 10, h: h + 8 });
        }

        node.hidden = false;
        node.style.left = `${Math.round(x)}px`;
        node.style.top = `${Math.round(y)}px`;
        if (this.animate) {
          // 每个词一套独立的浮动参数，避免整体像一块板在动
          const dur = 7 + Math.random() * 5;
          const delay = -Math.random() * 6;
          const amp = 3 + Math.random() * 5;
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
          const rect = { x: x - 5, y: y - 4, w: w + 10, h: h + 8 };
          if (!blocks(rect)) return { x, y };
          x += 12;                              // 每次右移一点再试，尽量塞满这一行
        }
        y -= h + gapY;
        if (y < availT + pad) break;
      }
      // 实在没地方了（词太多 / 舞台太小）才允许压人物：可见性优先于完全不遮挡
      return { x: availL + pad, y: Math.max(availT + pad, availB - h - pad) };
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
      const minW = Math.min(...weights, 0);
      const maxW = Math.max(...weights, 100);
      // 通过对调权重制造新的字号层次，再按新顺序放置
      for (const w of list) {
        const ratio = maxW === minW ? 0.5 : ((w.weight || 50) - minW) / (maxW - minW);
        const size = 11 + ratio * 14;
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
