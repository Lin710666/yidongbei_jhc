/* ============================================================================
 * boot-puppet.js —— 开屏「形象主页」：立绘的木偶形变（伪 Live2D）
 *
 * ## 为什么不是真的 Live2D
 *
 * Live2D 的 `.moc3` 需要**分层 PSD**：后发/前发/脸/眼白/瞳孔/眼睑/睫毛/眉/嘴/
 * 身体/每层衣服……每层单独画，而且**必须画出被上层挡住的像素**（"补完"）。
 * 任何一层一动，原来被挡住的区域就会露出来 —— 平面图里那些像素不存在，一动就是一个洞。
 * 而且 `.moc3` 是私有编译格式、绑定要在 Cubism Editor 里手工拉变形器，没有可编程接口。
 *
 * 项目里那个 `live2dcubismcore` 也帮不上忙：它只对**真实的 .moc3 模型**求值，
 * 所以现成的那 45 个 `.motion3` 模板没法直接播在别的形状上。
 *
 * ## 这一套是怎么做的
 *
 * **不切图**，整张立绘贴到一个细分网格上，在顶点着色器里做**分区域形变**：
 * 每个顶点按它所在的部位（头 / 身 / 裙 / 发）拿到一个权重，再按参数做旋转或平移，
 * 权重是平滑过渡的 —— 所以脖子不会撕开、裙摆不会裂，也就**不可能出现洞**。
 *
 * 参数名沿用 Cubism 的标准命名（ParamAngleX/Y/Z、ParamBodyAngleZ、ParamBreath、
 * ParamHairFront…），这样动作数据是按"Live2D 的语义"写的，将来真拿到分层 PSD
 * 换成真模型时，这套参数和动作可以直接搬过去。
 *
 * ## 动作是作者写的，不是播放现有模板
 *
 * 下面 MOTIONS 里那几段（迎宾作揖 / 挥手 / 侧身 / 掐诀）是我按参数曲线编的。
 * 之所以不直接播项目里那 45 个 `.motion3`：官方规范里 `Segments` 只写了
 * "Flattened segments"，没有公开编码规则，而这批文件的段长还有奇数长度，
 * 硬解容易在某个文件上悄悄错位。**与其猜，不如把动作用可读的参数曲线写清楚。**
 * ==========================================================================*/

import * as THREE from 'three'

/* ------------------------------------------------------------------ 可调参数 */

/** 网格细分。横向太少 → 头会显得方；纵向太少 → 腰身会折。 */
const SEG_X = 64
const SEG_Y = 96

/** 头 / 颈 / 胯 的枢轴位置（uv 坐标，v=0 是脚、v=1 是头顶）。按这张立绘量的。 */
const NECK_UV = [0.5, 0.795]
const HIP_UV = [0.5, 0.40]

/** 鼠标带动头部转动的幅度（度）。太小看不出"头在跟着你"，太大就假了。 */
const MOUSE_YAW = 19
const MOUSE_PITCH = 10

/**
 * 动作库：每段是一串关键帧，键名就是 Cubism 的参数名（去掉 Param 前缀）。
 * 数值单位：角度类为「度」，Breath 为 0..1。
 */
const MOTIONS = {
  // 迎宾：轻微躬身 + 低头，然后起来
  greet: {
    dur: 2.4,
    kf: [
      { t: 0.0, BodyZ: 0, AngleY: 0, Breath: 0.15, Hair: 0 },
      { t: 0.7, BodyZ: 5.5, AngleY: 11, Breath: 0.55, Hair: -0.5 },
      { t: 1.5, BodyZ: 4.0, AngleY: 8, Breath: 0.35, Hair: -0.2 },
      { t: 2.4, BodyZ: 0, AngleY: 0, Breath: 0.15, Hair: 0 },
    ],
  },
  // 对话：侧头 + 头发甩一下，像在听你说话
  chat: {
    dur: 1.9,
    kf: [
      { t: 0.0, AngleX: 0, AngleZ: 0, Hair: 0, Breath: 0.15 },
      { t: 0.5, AngleX: 13, AngleZ: -7, Hair: 1.0, Breath: 0.45 },
      { t: 1.2, AngleX: 6, AngleZ: -3, Hair: 0.4, Breath: 0.3 },
      { t: 1.9, AngleX: 0, AngleZ: 0, Hair: 0, Breath: 0.15 },
    ],
  },
  // 设置：正式作揖，比迎宾更深、更慢
  settings: {
    dur: 2.8,
    kf: [
      { t: 0.0, BodyZ: 0, AngleY: 0, Breath: 0.15 },
      { t: 0.9, BodyZ: 9, AngleY: 17, Breath: 0.7 },
      { t: 1.9, BodyZ: 7, AngleY: 13, Breath: 0.5 },
      { t: 2.8, BodyZ: 0, AngleY: 0, Breath: 0.15 },
    ],
  },
  // API 接入：掐诀 —— 头微微一偏 + 侧身，有"起手"的感觉
  api: {
    dur: 2.2,
    kf: [
      { t: 0.0, AngleX: 0, BodyZ: 0, Hair: 0 },
      { t: 0.6, AngleX: -11, BodyZ: -4, Hair: -0.8 },
      { t: 1.4, AngleX: -5, BodyZ: -6, Hair: -0.3 },
      { t: 2.2, AngleX: 0, BodyZ: 0, Hair: 0 },
    ],
  },
}

/* ------------------------------------------------------------------ 着色器 */

const VERT = /* glsl */`
  uniform float uAngleX;    // 头：左右转
  uniform float uAngleY;    // 头：低头/抬头
  uniform float uAngleZ;    // 头：歪头
  uniform float uBodyZ;     // 身体：前倾
  uniform float uBreath;    // 呼吸 0..1
  uniform float uHair;      // 头发甩动
  uniform float uSway;      // 整体摇摆（待机）
  uniform float uTime;
  uniform vec2  uSize;      // 平面实际尺寸（宽, 高）
  uniform vec2  uNeck;      // 颈部枢轴（uv）
  uniform vec2  uHip;       // 胯部枢轴（uv）

  varying vec2 vUv;

  const float PI = 3.14159265;

  // 把一个 uv 坐标转到平面局部坐标（中心为原点）
  vec2 toLocal(vec2 uv) { return (uv - 0.5) * uSize; }
  vec2 toUv(vec2 p) { return p / uSize + 0.5; }

  mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

  void main() {
    vUv = uv;
    vec2 uv0 = uv;

    // ---------- 部位权重：全是平滑过渡，所以不会撕开 ----------
    // 头：v 越高权重越大；颈线附近 0
    float wHead  = smoothstep(uNeck.y - 0.055, uNeck.y + 0.075, uv0.y);
    // 身体：从裙摆上方到颈部
    float wBody  = smoothstep(0.26, 0.52, uv0.y) * (1.0 - smoothstep(0.74, 0.86, uv0.y));
    // 裙子：越低权重越大（裙摆不跟着上身转）
    float wSkirt = 1.0 - smoothstep(0.06, 0.40, uv0.y);
    // 头发：两侧 + 从肩到头顶，越往下越"自由"
    float side   = smoothstep(0.10, 0.26, abs(uv0.x - 0.5));
    float wHair  = side * smoothstep(0.22, 0.46, uv0.y) * (1.0 - smoothstep(0.90, 0.99, uv0.y));

    vec2 p = toLocal(uv0);

    // ---------- 头：绕颈部枢轴旋转 ----------
    {
      vec2 piv = toLocal(vec2(uNeck.x, uNeck.y));
      // 三个轴合成一个小角度旋转；权重让颈线附近几乎不动
      float a = radians(uAngleX) * 0.65 * wHead;
      float b = radians(uAngleZ) * 0.85 * wHead;
      vec2 d = p - piv;
      d = rot(a + b) * d;
      p = piv + d;
      // 低头：整体下压 + 前后缩放（看起来像转过去了）
      p.y -= radians(uAngleY) * 0.085 * uSize.y * wHead;
      p.x *= 1.0 - abs(radians(uAngleX)) * 0.16 * wHead;
    }

    // ---------- 身体：绕胯部枢轴前倾 ----------
    {
      vec2 piv = toLocal(vec2(uHip.x, uHip.y));
      float a = radians(uBodyZ) * 0.7 * wBody;
      vec2 d = p - piv;
      d = rot(a) * d;
      p = piv + d;
    }

    // ---------- 呼吸：胸口轻微起伏 ----------
    p.y += sin(uTime * 1.45) * 0.012 * uSize.y * uBreath * wBody;

    // ---------- 头发：横向甩动，越往下越明显 ----------
    {
      float fall = 1.0 - smoothstep(0.30, 0.95, uv0.y);   // 发梢动得多
      p.x += uHair * 0.055 * uSize.x * wHair * fall;
    }

    // ---------- 待机摇摆：整体极轻的横移，裙子滞后一点 ----------
    {
      float lag = 0.75 + 0.25 * wSkirt;
      p.x += sin(uTime * 0.62) * 0.012 * uSize.x * uSway * lag;
    }

    // 回到裁剪空间：正交相机，平面就是 1x1 单位，直接用局部坐标
    vec3 pos = position;
    pos.xy = p / uSize;      // 平面几何是 1x1，局部坐标除以尺寸即归一
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`

const FRAG = /* glsl */`
  precision mediump float;
  uniform sampler2D uMap;
  uniform float uOpacity;     // 地面倒影那一份用得很低
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(uMap, vUv);
    if (c.a < 0.004) discard;
    gl_FragColor = vec4(c.rgb, c.a * uOpacity);
  }
`

/* ------------------------------------------------------------------ 主入口 */

/**
 * @param {Object}      o
 * @param {HTMLElement} o.mount
 * @param {string}      o.url     已经抠好透明底的立绘
 * @param {Function}    [o.onReady]
 */
export async function createPuppetSplash({ mount, url, onReady } = {}) {
  if (!mount) throw new Error('缺少挂载容器')

  /* ---------------- DOM：沿用 .boot-art 那套氛围层 ---------------- */

  const root = document.createElement('div')
  root.className = 'boot-art boot-puppet-root'
  root.innerHTML = `
    <canvas class="art-motes art-motes-back" aria-hidden="true"></canvas>
    <div class="art-beam" aria-hidden="true"></div>
    <div class="art-figure">
      <div class="art-react">
        <div class="art-enter">
          <div class="art-glow" aria-hidden="true"></div>
          <canvas class="art-puppet" aria-hidden="true"></canvas>
        </div>
      </div>
    </div>
    <canvas class="art-motes art-motes-front" aria-hidden="true"></canvas>
  `
  mount.appendChild(root)

  const figure = root.querySelector('.art-figure')
  const canvas = root.querySelector('.art-puppet')
  const back = root.querySelector('.art-motes-back')
  const front = root.querySelector('.art-motes-front')

  /* ---------------- 纹理 ---------------- */

  const loader = new THREE.TextureLoader()
  const texture = await new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, () => reject(new Error('立绘加载失败: ' + url)))
  })
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = 4

  const aspect = texture.image.naturalWidth / texture.image.naturalHeight

  /* ---------------- three 场景 ---------------- */

  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: true,
    // ★ 必须开 preserveDrawingBuffer，否则合成之后 readPixels / toDataURL 读回来全是 0：
    //   WebGL 默认在呈现后就把绘制缓冲丢掉，于是"自动化验证"会得到一个假阴性 ——
    //   上一版就因为这个误报过"画布上什么都没画"。
    //   这场只有一个贴图四边形，开着的开销可以忽略。
    preserveDrawingBuffer: true,
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setClearAlpha(0)
  // 立绘本身已经是画好的成品，不要再做色调映射，否则颜色会被改一遍
  renderer.toneMapping = THREE.NoToneMapping
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 10)
  camera.position.z = 2

  const uniforms = {
    uMap: { value: texture },
    uAngleX: { value: 0 }, uAngleY: { value: 0 }, uAngleZ: { value: 0 },
    uBodyZ: { value: 0 }, uBreath: { value: 0.15 }, uHair: { value: 0 },
    uSway: { value: 1 }, uTime: { value: 0 },
    uSize: { value: new THREE.Vector2(1, 1 / aspect) },
    uNeck: { value: new THREE.Vector2(NECK_UV[0], NECK_UV[1]) },
    uHip: { value: new THREE.Vector2(HIP_UV[0], HIP_UV[1]) },
  }

  const geo = new THREE.PlaneGeometry(1, 1, SEG_X, SEG_Y)
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthTest: false, depthWrite: false,
  })
  const plane = new THREE.Mesh(geo, mat)
  plane.scale.set(1, 1 / aspect, 1)          // 平面 1x1，纵向按图片比例拉伸
  scene.add(plane)

  /* ---------------- 参数状态 ---------------- */

  const P = { AngleX: 0, AngleY: 0, AngleZ: 0, BodyZ: 0, Breath: 0.15, Hair: 0 }
  const shown = { ...P }                     // 实际写进 uniform 的值（做过平滑）
  let motion = null                          // 当前播放的动作
  let motionT = 0

  const lerp = (a, b, k) => a + (b - a) * k

  /** 播放一段动作（名字在 MOTIONS 里） */
  function play(name) {
    const m = MOTIONS[name]
    if (!m) return false
    motion = m
    motionT = 0
    root.dataset.motion = name
    return true
  }

  /** 按时间在当前动作的关键帧之间取值 */
  function evalMotion(t) {
    const kf = motion.kf
    if (t <= kf[0].t) return kf[0]
    for (let i = 1; i < kf.length; i++) {
      if (t <= kf[i].t) {
        const a = kf[i - 1], b = kf[i]
        const k = (t - a.t) / Math.max(1e-6, b.t - a.t)
        // 缓入缓出，动作不生硬
        const e = k * k * (3 - 2 * k)
        const out = {}
        for (const key of ['AngleX', 'AngleY', 'AngleZ', 'BodyZ', 'Breath', 'Hair']) {
          out[key] = lerp(a[key] ?? 0, b[key] ?? 0, e)
        }
        return out
      }
    }
    return kf[kf.length - 1]
  }

  /* ---------------- 鼠标：头部跟随 ---------------- */

  const mouse = { x: 0, y: 0 }
  const smooth = { x: 0, y: 0 }
  const onMove = (ev) => {
    const r = mount.getBoundingClientRect()
    mouse.x = ((ev.clientX - r.left) / Math.max(1, r.width)) * 2 - 1
    mouse.y = ((ev.clientY - r.top) / Math.max(1, r.height)) * 2 - 1
  }
  // ★ 必须挂 window，不能挂 mount（.boot-media）。
  //   开屏里 .boot-body（标题+菜单那一层）是 .boot-media 的**兄弟节点**而不是子节点，
  //   鼠标划到菜单上时事件只会冒泡到 .boot-body，挂在 .boot-media 上的监听器收不到 ——
  //   表现就是"头根本不跟着鼠标转"。实测踩过：重心只动了 1px。
  window.addEventListener('pointermove', onMove)

  /* ---------------- 浮尘（和 boot-art 同一套做法） ---------------- */

  function makeMotes(cv, { count, minR, maxR, alpha, rise, parallax }) {
    const ctx = cv.getContext('2d')
    let W = 1, H = 1
    const ps = []
    const seed = () => {
      ps.length = 0
      for (let i = 0; i < count; i++) {
        const r = minR + Math.random() * (maxR - minR)
        ps.push({ x: Math.random() * W, y: Math.random() * H, r, a: alpha * (0.35 + Math.random() * 0.65), v: rise * (0.4 + Math.random() * 1.2) })
      }
    }
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      W = Math.max(1, mount.clientWidth); H = Math.max(1, mount.clientHeight)
      cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr)
      cv.style.width = W + 'px'; cv.style.height = H + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      seed()
    }
    return {
      resize, parallax,
      draw(t, dt, px, py) {
        ctx.clearRect(0, 0, W, H)
        for (const s of ps) {
          s.y -= s.v * dt
          if (s.y < -s.r * 2) { s.y = H + s.r * 2; s.x = Math.random() * W }
          const x = s.x + px * parallax, y = s.y + py * parallax
          const g = ctx.createRadialGradient(x, y, 0, x, y, s.r)
          g.addColorStop(0, `rgba(214,236,255,${s.a})`)
          g.addColorStop(1, 'rgba(190,220,250,0)')
          ctx.fillStyle = g
          ctx.beginPath(); ctx.arc(x, y, s.r, 0, Math.PI * 2); ctx.fill()
        }
      },
    }
  }
  const backLayer = makeMotes(back, { count: 110, minR: 0.7, maxR: 1.9, alpha: 0.55, rise: 11, parallax: -0.012 })
  const frontLayer = makeMotes(front, { count: 16, minR: 4, maxR: 11, alpha: 0.30, rise: 22, parallax: -0.055 })

  /* ---------------- 布局 ---------------- */

  let planeW = 1, planeH = 1

  function layout() {
    const W = Math.max(1, mount.clientWidth)
    const H = Math.max(1, mount.clientHeight)
    backLayer.resize(); frontLayer.resize()

    renderer.setSize(W, H, false)
    canvas.style.width = W + 'px'
    canvas.style.height = H + 'px'

    // 立绘高度占视口的比例；窄屏小一点，别和菜单挤
    const hFrac = W < 900 ? 0.70 : 0.94
    const ph = H * hFrac
    const pw = ph * aspect
    // 正交视锥是 -1..1（对应整屏），所以 NDC 宽度 = 2*pw/W、高度 = 2*ph/H。
    // ★ 宽度这里必须除以 W（不是 H）—— NDC 在横竖两个方向的比例基准不一样，
    //   写成 H 的话立绘会被横向拉变形。
    planeW = pw / W * 2
    planeH = ph / H * 2
    plane.scale.set(planeW, planeH, 1)

    // 角色整体偏右给菜单让位。
    // ★ 视锥要往**左**移，角色才会出现在画面右侧：
    //   视锥 left/right 都减 shift 之后，x=0 的点在 NDC 里就跑到 +shift 那边去了。
    const shift = W < 900 ? 0 : 0.30
    camera.left = -1 - shift
    camera.right = 1 - shift
    camera.top = 1
    camera.bottom = -1
    camera.updateProjectionMatrix()

    uniforms.uSize.value.set(planeW, planeH)
    root.dataset.ready = '1'
  }

  /* ---------------- 渲染循环 ---------------- */

  const clock = { last: performance.now(), t: 0 }
  let raf = 0, running = false

  function tick(now) {
    raf = requestAnimationFrame(tick)
    const dt = Math.min((now - clock.last) / 1000, 0.1)
    clock.last = now
    clock.t += dt
    const t = clock.t

    // 动作推进
    let target = { ...P }
    if (motion) {
      motionT += dt
      target = evalMotion(motionT)
      if (motionT >= motion.dur) { motion = null; root.dataset.motion = '' }
    }

    // 鼠标叠加到头部（这是"像 Live2D"最关键的一下）
    smooth.x += (mouse.x - smooth.x) * Math.min(1, dt * 3.2)
    smooth.y += (mouse.y - smooth.y) * Math.min(1, dt * 3.2)
    target.AngleX = (target.AngleX || 0) + smooth.x * MOUSE_YAW
    target.AngleY = (target.AngleY || 0) + smooth.y * MOUSE_PITCH
    target.AngleZ = (target.AngleZ || 0) - smooth.x * 3.2

    // 平滑到 uniform，避免动作切换时"啪"地跳
    const k = Math.min(1, dt * 7)
    for (const key of ['AngleX', 'AngleY', 'AngleZ', 'BodyZ', 'Breath', 'Hair']) {
      shown[key] = lerp(shown[key], target[key] ?? 0, k)
    }
    uniforms.uAngleX.value = shown.AngleX
    uniforms.uAngleY.value = shown.AngleY
    uniforms.uAngleZ.value = shown.AngleZ
    uniforms.uBodyZ.value = shown.BodyZ
    uniforms.uBreath.value = shown.Breath
    uniforms.uHair.value = shown.Hair
    uniforms.uTime.value = t

    // 视差
    figure.style.transform = `translate3d(${-smooth.x * 14}px, ${-smooth.y * 9}px, 0)`
    front.style.transform = `translate3d(${-smooth.x * 26}px, ${-smooth.y * 16}px, 0)`
    back.style.transform = `translate3d(${-smooth.x * 6}px, ${-smooth.y * 4}px, 0)`

    backLayer.draw(t, dt, 0, 0)
    frontLayer.draw(t, dt, 0, 0)
    renderer.render(scene, camera)
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
  window.addEventListener('resize', onResize)

  /** 立绘就绪：立刻标 ready 并摆好位置 */
  layout()
  root.dataset.ready = '1'
  if (onReady) onReady()

  return {
    react(entryId) {
      if (!entryId || !MOTIONS[entryId]) return false
      return play(entryId)
    },
    greet() { return play('greet') },
    setVisible(v) {
      if (v) {
        root.classList.remove('art-out')
        layout()
        start()
      } else {
        root.classList.add('art-out')
        stop()
      }
    },
    resize: layout,
    get motions() { return Object.keys(MOTIONS) },
    dispose() {
      stop()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onMove)
      geo.dispose(); mat.dispose(); texture.dispose(); renderer.dispose()
      root.remove()
    },
  }
}
