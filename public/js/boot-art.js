/* ============================================================================
 * boot-art.js —— 开屏「形象主页」的 2D 立绘场景
 *
 * ## 为什么换成 2D
 *
 * 之前用的是三维模型。问题不在"三维不行"，而在于：这只是一张立绘就能表达的
 * 展示页，硬上三维反而处处受制 —— 灯光、蒙皮、长袖形变，每一样都要调，
 * 调完还是不如原画好看。**用立绘就回到了画师已经画好的那个效果上。**
 *
 * 而且这一换还有个实惠：模板 B 不再需要 three.js（1.3 MB），
 * 开屏的下载量直接少一大截。
 *
 * ## 一张静态图怎么"活"起来
 *
 * 单张平图没有骨骼，不能真做动作。所以走的是这类开场界面的通用做法 ——
 * **用分层和微动做出纵深与呼吸感**：
 *
 *   · 四层视差：背景浮尘 → 光晕 → 立绘 → 前景浮尘（鼠标一动就分得开）
 *   · 呼吸：极轻的上下浮动 + 缩放（5 秒一轮，看不出来但完全静止会像图片）
 *   · 摇曳：非常小的旋转摆动（8 秒一轮）
 *   · 落地：脚下一块软阴影 + 一圈地光，人是站着的
 *   · 入场：从下方升起 + 淡入 + 轻微推近
 *   · 悬停入口时的反应：**一道光扫过** + 光晕脉冲 + 整体微微前倾放大
 *
 * ## 版权
 *
 * 立绘是你提供的素材，代码是本项目自己的。想换图只要替换
 * `public/avatars/hanfu-girl.png` 这一个文件，尺寸比例保持一致即可。
 * ==========================================================================*/

/** 悬停入口 → 反应文案里用的短名（和 boot.js 的 ENTRIES 对应） */
const REACT_CLASS = 'art-reacting'

/**
 * 创建 2D 立绘开屏场景。
 *
 * @param {Object}      o
 * @param {HTMLElement} o.mount   挂载容器（一般是 .boot-media）
 * @param {string}      o.url     立绘地址（必须已经抠好透明底）
 * @param {Function}    [o.onReady]
 */
export function createArtSplash({ mount, url, onReady } = {}) {
  if (!mount) throw new Error('缺少挂载容器')

  const root = document.createElement('div')
  root.className = 'boot-art'
  // 五层容器是刻意的：视差 / 悬停反应 / 入场 / 摇曳 / 呼吸 各自占一层 transform。
  // 挤在同一个元素上的话，CSS 动画的 transform 会被 JS 每帧写的 transform 覆盖，
  // 表现就是"呼吸和视差只剩一个生效"。
  root.innerHTML = `
    <canvas class="art-motes art-motes-back" aria-hidden="true"></canvas>
    <div class="art-beam" aria-hidden="true"></div>
    <div class="art-figure">
      <div class="art-react">
        <div class="art-enter">
          <div class="art-sway">
            <div class="art-breathe">
              <div class="art-glow" aria-hidden="true"></div>
              <div class="art-pool" aria-hidden="true"></div>
              <img class="art-img" alt="" draggable="false">
              <div class="art-sweep" aria-hidden="true"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <canvas class="art-motes art-motes-front" aria-hidden="true"></canvas>
  `
  mount.appendChild(root)

  const img = root.querySelector('.art-img')
  const figure = root.querySelector('.art-figure')
  const glow = root.querySelector('.art-glow')
  const pool = root.querySelector('.art-pool')
  const back = root.querySelector('.art-motes-back')
  const front = root.querySelector('.art-motes-front')

  // 先把图挂上：onload 之后才知道实际渲染尺寸，才能算阴影和光晕的大小
  let ready = false
  const p = new Promise((resolve, reject) => {
    img.addEventListener('load', () => resolve(), { once: true })
    img.addEventListener('error', () => reject(new Error('立绘加载失败: ' + url)), { once: true })
  })
  img.src = url

  /* ---------------- 浮尘 ---------------- */

  /** 一层粒子：back 层小而暗、front 层大而亮，两层一起才有纵深 */
  function makeMotes(canvas, { count, minR, maxR, alpha, rise, parallax }) {
    const ctx = canvas.getContext('2d')
    let W = 1, H = 1, dpr = 1
    const ps = []
    const seed = () => {
      ps.length = 0
      for (let i = 0; i < count; i++) {
        const r = minR + Math.random() * (maxR - minR)
        ps.push({
          x: Math.random() * W,
          y: Math.random() * H,
          r,
          a: alpha * (0.35 + Math.random() * 0.65),
          v: rise * (0.4 + Math.random() * 1.2),
          dx: (Math.random() - 0.5) * 6,
        })
      }
    }
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      W = Math.max(1, mount.clientWidth)
      H = Math.max(1, mount.clientHeight)
      canvas.width = Math.floor(W * dpr)
      canvas.height = Math.floor(H * dpr)
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      seed()
    }
    return {
      canvas, parallax, resize,
      draw(t, dt, px, py) {
        ctx.clearRect(0, 0, W, H)
        for (const s of ps) {
          s.y -= s.v * dt
          s.x += Math.sin(t * 0.4 + s.r * 30) * s.dx * dt
          if (s.y < -s.r * 2) { s.y = H + s.r * 2; s.x = Math.random() * W }
          const x = s.x + px * parallax
          const y = s.y + py * parallax
          const grd = ctx.createRadialGradient(x, y, 0, x, y, s.r)
          grd.addColorStop(0, `rgba(214,236,255,${s.a})`)
          grd.addColorStop(0.55, `rgba(190,220,250,${s.a * 0.35})`)
          grd.addColorStop(1, 'rgba(190,220,250,0)')
          ctx.fillStyle = grd
          ctx.beginPath()
          ctx.arc(x, y, s.r, 0, Math.PI * 2)
          ctx.fill()
        }
      },
    }
  }

  const backLayer = makeMotes(back, { count: 110, minR: 0.7, maxR: 1.9, alpha: 0.55, rise: 11, parallax: -0.012 })
  const frontLayer = makeMotes(front, { count: 16, minR: 4, maxR: 11, alpha: 0.30, rise: 22, parallax: -0.055 })

  /* ---------------- 构图 ---------------- */

  function layout() {
    backLayer.resize()
    frontLayer.resize()
    // 立绘高度按视口给，但不小于一个可读的下限；宽度由图片比例决定
    const h = Math.min(mount.clientHeight * 0.94, mount.clientHeight - 24)
    img.style.height = h + 'px'
    // 光晕和脚下光影跟着立绘尺寸走
    const w = img.clientWidth || h * (1024 / 1536)
    glow.style.width = w * 1.5 + 'px'
    glow.style.height = h * 1.02 + 'px'
    pool.style.width = w * 0.92 + 'px'
    pool.style.height = h * 0.16 + 'px'
  }

  /* ---------------- 鼠标视差 ---------------- */

  const mouse = { x: 0, y: 0 }
  const smooth = { x: 0, y: 0 }
  const onMove = (ev) => {
    const r = mount.getBoundingClientRect()
    mouse.x = ((ev.clientX - r.left) / Math.max(1, r.width)) * 2 - 1
    mouse.y = ((ev.clientY - r.top) / Math.max(1, r.height)) * 2 - 1
  }
  // 挂 window 而不是 mount：.boot-body（菜单那层）是 .boot-media 的兄弟节点，
  // 划到菜单上的鼠标事件不会冒泡到 mount，挂 mount 会导致视差完全不生效。
  window.addEventListener('pointermove', onMove)

  /* ---------------- 悬停反应 ---------------- */

  let reactTimer = 0
  function react(entryId) {
    if (!entryId) return false
    root.classList.remove(REACT_CLASS)
    void root.offsetWidth            // 强制回流，动画才会重播
    root.classList.add(REACT_CLASS)
    root.dataset.react = entryId     // 验证脚本靠它确认"悬停真的触发了反应"
    clearTimeout(reactTimer)
    reactTimer = setTimeout(() => root.classList.remove(REACT_CLASS), 1100)
    return true
  }

  /** 迎宾：进来先亮一下光晕，表示"她在" */
  function greet() {
    root.classList.add('art-greeting')
    setTimeout(() => root.classList.remove('art-greeting'), 1600)
    return true
  }

  /* ---------------- 渲染循环 ---------------- */

  const clock = { last: performance.now(), t: 0 }
  let raf = 0
  let running = false

  function tick(now) {
    raf = requestAnimationFrame(tick)
    const dt = Math.min((now - clock.last) / 1000, 0.1)
    clock.last = now
    clock.t += dt
    const t = clock.t

    smooth.x += (mouse.x - smooth.x) * Math.min(1, dt * 3.2)
    smooth.y += (mouse.y - smooth.y) * Math.min(1, dt * 3.2)

    // 四层视差：立绘、光晕、两层浮尘各自不同的位移量。
    // 光晕的 transform 必须把 CSS 里那句 translate(-50%,-50%) 一起写上 ——
    // 内联样式会整个覆盖掉 CSS 的 transform，漏了居中它就偏到右下角去。
    figure.style.transform = `translate3d(${-smooth.x * 16}px, ${-smooth.y * 10}px, 0)`
    glow.style.transform = `translate(-50%, -50%) translate3d(${-smooth.x * 9}px, ${-smooth.y * 6}px, 0)`
    front.style.transform = `translate3d(${-smooth.x * 26}px, ${-smooth.y * 16}px, 0)`
    back.style.transform = `translate3d(${-smooth.x * 6}px, ${-smooth.y * 4}px, 0)`

    backLayer.draw(t, dt, 0, 0)
    frontLayer.draw(t, dt, 0, 0)
  }

  function start() {
    if (running) return
    running = true
    clock.last = performance.now()
    raf = requestAnimationFrame(tick)
  }
  function stop() {
    running = false
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  const onResize = () => layout()

  // 等图真的解码完再量尺寸，否则 clientWidth 是 0，光晕和阴影会算错
  p.then(() => {
    layout()
    window.addEventListener('resize', onResize)
    // 立绘是本地小图，量完尺寸就可以标就绪
    root.dataset.ready = '1'
    if (onReady) onReady()
  })

  return {
    react,
    greet,
    setVisible(v) {
      if (v) {
        root.classList.remove('art-out')
        start()
      } else {
        root.classList.add('art-out')
        stop()
      }
    },
    resize: layout,
    get imageUrl() { return url },
    dispose() {
      stop()
      clearTimeout(reactTimer)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onMove)
      root.remove()
    },
  }
}
