/* ============================================================================
 * boot-hanfu.js —— 开屏「形象主页」的汉服三维场景（ES Module）
 *
 * ## 这一版补的是什么
 *
 * 上一版角色是**漂在一片黑里**的：没有地面、没有影子、光是平的、脸发白、
 * 镜头一动不动。所以这一版把"像一张会动的静图"变成"像一个场景"，加了：
 *
 *   · 地面 + 光池 + **接触阴影** —— 让她站在一个地方，而不是浮着
 *   · 背光光柱 + 密集浮尘 —— 有纵深，暗场不再是一块死黑
 *   · **鼠标视差** + 推镜入场 + 极轻的手持晃动 —— 一眼就看出是实时三维
 *   · **自定义后期**：ACES 色调映射 + 暗角 + 颗粒 + 边缘色散
 *   · 入场时角色从画面外升起，而不是"啪"地出现
 *
 * ## 为什么自己写后期，不用 EffectComposer
 *
 * 项目的 vendor/three/addons 里只有 GLTFLoader 和 BufferGeometryUtils，
 * 没有 postprocessing 那一套。为了一个暗角去 vendor 七八个文件不划算，
 * 自己写一个全屏 pass 只有几十行，而且**色调映射和 sRGB 编码都在我手里**，
 * 不用去猜 three 在"渲染到 target"时到底应用了哪几段。
 * （踩过的坑：three 默认 NoToneMapping，亮度超过 1 的像素会被削平成纯白，
 *   布料是哑光看不出来，脸的皮肤会先炸 —— 这就是上一版脸发白的原因。）
 *
 * ## 版权说明
 *
 * 这套东西全部是本项目自己的 three.js / CSS 代码，排版思路参考同类
 * "角色展示型"开场界面的通用做法。**没有使用任何第三方游戏的素材、
 * 字体、Logo 或界面元素。**
 * ==========================================================================*/

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

/** 默认循环播放的"待机"动作（前一个不存在就用后一个） */
const IDLE_CLIPS = ['conduct-120_04', 'vmd-miku2', 'dance-05_02']

/** 开屏出现时先做一次的动作（相当于"迎宾"） */
const GREET_CLIPS = ['dance-05_12', 'vmd-miku2']

/** 入口 → 动作偏好链。名字对不上会逐级往下退，最后退到"随机挑一段"。 */
const ENTRY_CLIPS = {
  chat: ['dance-05_02', 'vmd-miku2'],
  settings: ['spell-120_03', 'conduct-120_04'],
  api: ['sword-02_08', 'salsa-60_01', 'indian-94_02'],
}

/* ------------------------------------------------------------------ 程序化贴图 */

/** 径向渐变贴图：地面"光池"和接触阴影都用它，省得引外部图片 */
function radialTexture(size, stops) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  stops.forEach(([at, color]) => grad.addColorStop(at, color))
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** 竖向渐变：做背景幕布 */
function verticalTexture(stops) {
  const c = document.createElement('canvas')
  c.width = 4; c.height = 256
  const g = c.getContext('2d')
  const grad = g.createLinearGradient(0, 0, 0, 256)
  stops.forEach(([at, color]) => grad.addColorStop(at, color))
  g.fillStyle = grad
  g.fillRect(0, 0, 4, 256)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/**
 * 光柱贴图：纵向淡出 **并且**横向也淡出。
 *
 * 踩过的坑：一开始只用竖向渐变，于是光柱左右两条边是**硬切**的，
 * 在暗场里看起来就是"贴了一块灰色板子"。
 * 光这种东西两个方向都得柔，所以先画竖向渐变，再用 destination-in
 * 叠一层横向遮罩把两侧削掉。
 */
function beamTexture() {
  const w = 256, h = 512
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const g = c.getContext('2d')

  const v = g.createLinearGradient(0, 0, 0, h)
  v.addColorStop(0.00, 'rgba(198,230,255,0)')
  v.addColorStop(0.26, 'rgba(198,230,255,0.42)')
  v.addColorStop(0.60, 'rgba(172,208,244,0.22)')
  v.addColorStop(1.00, 'rgba(172,208,244,0)')
  g.fillStyle = v
  g.fillRect(0, 0, w, h)

  const hmask = g.createLinearGradient(0, 0, w, 0)
  hmask.addColorStop(0.00, 'rgba(0,0,0,0)')
  hmask.addColorStop(0.38, 'rgba(0,0,0,1)')
  hmask.addColorStop(0.62, 'rgba(0,0,0,1)')
  hmask.addColorStop(1.00, 'rgba(0,0,0,0)')
  g.globalCompositeOperation = 'destination-in'
  g.fillStyle = hmask
  g.fillRect(0, 0, w, h)

  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/* ------------------------------------------------------------------ 后期着色器 */

const POST_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

// ACES 近似（Narkowicz）：高光滚降柔和，皮肤不会一片死白
const POST_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform vec2  uRes;
  uniform float uTime;
  uniform float uReveal;     // 0→1 入场淡入

  varying vec2 vUv;

  vec3 aces(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }
  vec3 toSRGB(vec3 c) {
    return mix(1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, c * 12.92,
               step(c, vec3(0.0031308)));
  }
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  void main() {
    vec2 uv = vUv;
    vec2 d  = uv - 0.5;
    float r2 = dot(d, d);

    // 边缘色散：越靠边越明显，屏幕中心干净
    float ab = r2 * 0.010;
    vec3 col;
    col.r = texture2D(tDiffuse, uv + d * ab).r;
    col.g = texture2D(tDiffuse, uv).g;
    col.b = texture2D(tDiffuse, uv - d * ab).b;

    // 色调映射 + sRGB（都在这里做，见文件头说明）
    col = aces(col * 1.05);
    col = toSRGB(col);

    // 调色：暗部压冷、亮部留暖
    col = mix(col, col * vec3(0.94, 0.98, 1.08), 0.55 * (1.0 - col));
    col = mix(col, col * vec3(1.06, 1.01, 0.94), 0.35 * col);

    // 暗角
    float vig = smoothstep(1.05, 0.28, length(d) * 1.32);
    col *= mix(1.0, vig, 0.85);

    // 颗粒（固定强度，不做动态噪点动画，免得看着像信号不好）
    col += (hash(uv * uRes) - 0.5) * 0.022;

    // 入场：从暗到亮 + 一点点纵向提亮
    col *= mix(0.0, 1.0, uReveal);

    gl_FragColor = vec4(col, 1.0);
  }
`

/* ------------------------------------------------------------------ 主入口 */

/**
 * 创建一个汉服开屏场景。
 *
 * @param {Object}   o
 * @param {HTMLElement} o.mount       挂载容器（一般是 .boot-media）
 * @param {string}   o.url            glb 地址
 * @param {Function} [o.onProgress]   (0..1|null) => void
 * @param {Function} [o.onReady]      () => void
 */
export async function createHanfuSplash({ mount, url, onProgress, onReady } = {}) {
  if (!mount) throw new Error('缺少挂载容器')

  const canvas = document.createElement('canvas')
  canvas.className = 'boot-hanfu'
  // 先藏起来：createHanfuSplash 一返回就开始渲染，而 boot.js 要到 .then() 里
  // 才根据"开屏是否还开着"决定要不要亮出来。这段窗口期里不藏的话，
  // 用户会先看到一帧没有 UI 的裸画面。
  canvas.style.opacity = '0'
  mount.appendChild(canvas)

  /* ---------------- 渲染器 ----------------
   * 注意 outputColorSpace 设成 Linear：sRGB 编码由后期的着色器负责。
   * 让 three 再编一次的话颜色会被编两遍，整屏发灰。 */
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace
  renderer.toneMapping = THREE.NoToneMapping
  renderer.setClearColor(0x04070b, 1)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 200)

  /* ---------------- 场景：地面 / 幕布 / 光柱 / 阴影 ---------------- */

  // 地面光池：中心亮、四周沉入黑，人物脚下的"舞台感"就从这来
  const poolTex = radialTexture(512, [
    [0.00, 'rgba(150,196,236,0.55)'],
    [0.28, 'rgba(96,140,186,0.26)'],
    [0.62, 'rgba(24,40,58,0.10)'],
    [1.00, 'rgba(0,0,0,0)'],
  ])
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 26),
    // opacity 压到 0.78：全强度时画面下半部会整片泛蓝，像起雾，把人物压住了
    new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, depthWrite: false, opacity: 0.78 }),
  )
  ground.rotation.x = -Math.PI / 2
  ground.position.y = 0.001
  scene.add(ground)

  // 接触阴影：一块软椭圆，让人物"踩"在地上而不是浮着
  const shadowTex = radialTexture(256, [
    [0.00, 'rgba(0,0,0,0.72)'],
    [0.45, 'rgba(0,0,0,0.34)'],
    [1.00, 'rgba(0,0,0,0)'],
  ])
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.05),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
  )
  blob.rotation.x = -Math.PI / 2
  blob.position.set(0, 0.004, 0.05)
  scene.add(blob)

  // 背景幕布：上深下浅的冷色渐变，给场景一个"后面还有空间"的底
  const backdropTex = verticalTexture([
    [0.00, '#03060a'],
    [0.55, '#08131d'],
    [0.82, '#0e2130'],
    [1.00, '#05090d'],
  ])
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 34),
    new THREE.MeshBasicMaterial({ map: backdropTex, depthWrite: false }),
  )
  backdrop.position.set(0, 8, -9)
  scene.add(backdrop)

  // 背后的光柱：加色混合，一条**两向都柔**的光
  const shaft = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 9.5),
    new THREE.MeshBasicMaterial({
      map: beamTexture(), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0.85,
    }),
  )
  shaft.position.set(-0.35, 4.2, -2.6)
  shaft.rotation.z = 0.12
  scene.add(shaft)

  // 地平线附近一圈很淡的冷光：把地面和背景幕布"接"起来，暗场不至于上下两截
  const horizonTex = radialTexture(512, [
    [0.00, 'rgba(120,170,215,0.30)'],
    [0.45, 'rgba(70,110,155,0.12)'],
    [1.00, 'rgba(0,0,0,0)'],
  ])
  const horizon = new THREE.Mesh(
    new THREE.PlaneGeometry(22, 7),
    new THREE.MeshBasicMaterial({
      map: horizonTex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0.38,
    }),
  )
  horizon.position.set(-0.4, 0.9, -5.5)
  scene.add(horizon)

  /* ---------------- 浮尘 ---------------- */

  const DUST = 420
  const dustPos = new Float32Array(DUST * 3)
  const dustSpd = new Float32Array(DUST)
  for (let i = 0; i < DUST; i++) {
    dustPos[i * 3] = (Math.random() - 0.5) * 4.0
    dustPos[i * 3 + 1] = Math.random() * 2.8 - 0.1
    dustPos[i * 3 + 2] = (Math.random() - 0.5) * 2.6 - 0.2
    dustSpd[i] = 0.015 + Math.random() * 0.055
  }
  const dustGeo = new THREE.BufferGeometry()
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3))
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    color: 0xd6ecff, size: 0.014, sizeAttenuation: true,
    transparent: true, opacity: 0.65, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }))
  scene.add(dust)

  /* ---------------- 灯光 ----------------
   * 主光压到 1.0 左右：这是上一版脸发白的直接原因（主光 1.35 + 没有色调映射）。
   * 现在高光由后期的 ACES 滚降处理，主光可以给得更"薄"，暗部靠轮廓光撑。 */

  scene.add(new THREE.HemisphereLight(0x8ea8c6, 0x090d12, 0.38))

  const key = new THREE.DirectionalLight(0xffeacd, 1.0)      // 暖主光：左前上
  key.position.set(-1.9, 2.9, 2.3)
  scene.add(key)

  const rim = new THREE.DirectionalLight(0x9fd8ff, 2.1)      // 冷轮廓光：背后，勾剪影
  rim.position.set(1.5, 2.3, -2.8)
  scene.add(rim)

  const side = new THREE.DirectionalLight(0x8fb0d8, 0.3)     // 右侧很弱的一点补光
  side.position.set(2.6, 1.4, 1.2)
  scene.add(side)

  const lantern = new THREE.PointLight(0xffb066, 1.1, 7, 2)  // 脚下一盏暖色"灯笼"
  lantern.position.set(0.55, 0.4, 1.5)
  scene.add(lantern)

  /* ---------------- 加载模型 ---------------- */

  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().load(url, resolve, (ev) => {
      if (!onProgress) return
      onProgress(ev && ev.total ? Math.min(1, ev.loaded / ev.total) : null)
    }, reject)
  })

  const model = gltf.scene
  scene.add(model)
  // 薄布片必须双面，否则破口处会看穿
  model.traverse((o) => {
    if (!o.isMesh) return
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    mats.forEach((m) => { if (m) m.side = THREE.DoubleSide })
    o.frustumCulled = false          // 蒙皮后的包围盒不可靠，别让它被误剔除
  })

  /* ---------------- 构图 ---------------- */

  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const height = Math.max(size.y, 0.5)

  // 地面/阴影跟着角色走（模型的脚不一定正好在 y=0）
  const footY = box.min.y
  ground.position.y = footY + 0.001
  blob.position.y = footY + 0.004
  blob.scale.setScalar(Math.max(0.85, height * 0.52))

  const look = new THREE.Vector3()
  const base = new THREE.Vector3()
  let baseDist = 3

  function frame() {
    const w = Math.max(1, mount.clientWidth)
    const h = Math.max(1, mount.clientHeight)
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.fov = w / h < 1.15 ? 38 : 32        // 窄屏给大一点的视角，人才装得下
    baseDist = (height * 1.26 / 2) / Math.tan((camera.fov * Math.PI / 180) / 2)

    // 角色居中渲染，再整体偏到画面右侧给左侧菜单让位
    const shift = w < 900 ? 0 : -height * 0.30
    look.set(center.x + shift, center.y - height * 0.015, center.z)
    base.set(look.x, look.y + height * 0.055, look.z + baseDist)
    camera.updateProjectionMatrix()
    if (postTarget) {
      postTarget.setSize(Math.floor(w * renderer.getPixelRatio()), Math.floor(h * renderer.getPixelRatio()))
      postMat.uniforms.uRes.value.set(w, h)
    }
  }

  /* ---------------- 后期：场景先渲到 target，再走全屏 pass ---------------- */

  let postTarget = null
  let postMat = null
  const postScene = new THREE.Scene()
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial())
  postScene.add(postQuad)

  function initPost() {
    postTarget = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
    })
    postMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: postTarget.texture },
        uRes: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uReveal: { value: 0 },
      },
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      depthTest: false, depthWrite: false,
    })
    postQuad.material = postMat
  }
  initPost()

  /* ---------------- 动作 ---------------- */

  const clips = (gltf.animations || []).slice()
  const byName = new Map(clips.map((c) => [c.name, c]))
  const mixer = new THREE.AnimationMixer(model)
  let current = null
  let currentName = ''
  let lastEntry = ''

  const pick = (list) => {
    for (const n of list) if (byName.has(n)) return n
    return clips.length ? clips[Math.floor(Math.random() * clips.length)].name : ''
  }

  /**
   * 切到某段动作。
   * 用 fadeOut/fadeIn 而不是直接 play：动作硬切会"啪"地跳一下，
   * 而开屏本就是慢节奏的东西，交叉淡入才像样。
   */
  function play(name, fade = 0.6) {
    if (!name || name === currentName) return false
    const clip = byName.get(name)
    if (!clip) return false
    const next = mixer.clipAction(clip)
    next.reset()
    next.setLoop(THREE.LoopRepeat, Infinity)
    next.setEffectiveTimeScale(1)
    next.setEffectiveWeight(1)
    next.fadeIn(fade).play()
    if (current && current !== next) current.fadeOut(fade)
    current = next
    currentName = name
    // 暴露当前动作名：验证脚本靠它确认"悬停菜单真的换了动作"
    canvas.dataset.clip = name
    return true
  }

  function react(entryId) {
    const list = ENTRY_CLIPS[entryId]
    if (!list) return false
    if (entryId === lastEntry && current && current.isRunning()) return false
    lastEntry = entryId
    return play(pick(list), 0.5)
  }

  function greet() {
    lastEntry = ''
    return play(pick(GREET_CLIPS), 0.9)
  }

  /* ---------------- 鼠标视差 ---------------- */

  const mouse = { x: 0, y: 0 }
  const smooth = { x: 0, y: 0 }
  function onPointerMove(ev) {
    const r = mount.getBoundingClientRect()
    mouse.x = ((ev.clientX - r.left) / Math.max(1, r.width)) * 2 - 1
    mouse.y = ((ev.clientY - r.top) / Math.max(1, r.height)) * 2 - 1
  }
  mount.addEventListener('pointermove', onPointerMove)

  /* ---------------- 渲染循环 ---------------- */

  const clock = new THREE.Clock()
  let raf = 0
  let running = true
  let targetWeight = 1
  let weight = 0
  let revealStart = -1        // 入场动画起点（秒）
  const camPos = new THREE.Vector3()

  function tick() {
    raf = requestAnimationFrame(tick)
    const dt = Math.min(clock.getDelta(), 0.1)
    const t = clock.elapsedTime

    mixer.update(dt)

    // 入场：角色从画面下方升起（1.1 秒缓出）
    if (revealStart < 0) revealStart = t
    const e = Math.min(1, (t - revealStart) / 1.1)
    const ease = 1 - Math.pow(1 - e, 3)
    model.position.y = (1 - ease) * -0.14

    // 浮尘缓缓上升，出顶绕回底部
    const pos = dustGeo.attributes.position
    for (let i = 0; i < DUST; i++) {
      pos.array[i * 3 + 1] += dustSpd[i] * dt
      if (pos.array[i * 3 + 1] > 2.8) pos.array[i * 3 + 1] = -0.1
    }
    pos.needsUpdate = true

    // 推镜：从 1.18 倍距离缓缓推到位（2.6 秒），之后只留极轻的手持晃动
    const push = 1 + 0.18 * (1 - Math.min(1, (t - revealStart) / 2.6)) ** 2
    smooth.x += (mouse.x - smooth.x) * Math.min(1, dt * 2.4)
    smooth.y += (mouse.y - smooth.y) * Math.min(1, dt * 2.4)

    camPos.set(
      base.x + smooth.x * 0.055 + Math.sin(t * 0.17) * 0.012,
      base.y - smooth.y * 0.035 + Math.sin(t * 0.26 + 1.1) * 0.008,
      base.z + baseDist * 0.001 * 0,
    )
    camPos.z = look.z + baseDist * push
    camera.position.copy(camPos)
    // 视差：看向点也跟着鼠标偏一点，视角变化更真实
    camera.lookAt(look.x + smooth.x * 0.02, look.y - smooth.y * 0.012, look.z)

    // 阴影随呼吸微微缩放，人物就不是"贴在背景上"
    blob.scale.setScalar(Math.max(0.85, height * 0.52) * (1 + Math.sin(t * 0.9) * 0.008))

    weight += (targetWeight - weight) * Math.min(1, dt * 3)
    postMat.uniforms.uReveal.value = weight * ease
    postMat.uniforms.uTime.value = t

    renderer.setRenderTarget(postTarget)
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)
    renderer.render(postScene, postCam)
  }

  frame()
  play(pick(IDLE_CLIPS), 0.01)
  tick()
  // 就绪标记：验证脚本等它，而不是去猜"不透明度到 1 了没"
  // （canvas 的 CSS opacity 默认就是 1，拿它当判据会假通过）
  canvas.dataset.ready = '1'
  if (onReady) onReady()

  const onResize = () => frame()
  window.addEventListener('resize', onResize)

  return {
    play,
    react,
    greet,
    setVisible(v) {
      targetWeight = v ? 1 : 0
      if (v) {
        // 画布自己显隐必须显式控制：它排在 .boot-media 里视频的**后面**，
        // 不透明度留着 1 的话会把模板 A 的视频整个盖住（只剩一张冻结的汉服画面）。
        renderer.domElement.style.opacity = '1'
        revealStart = -1          // 重新播一次入场
        if (!running) { running = true; clock.getDelta(); tick() }
        else if (!raf) tick()
      } else {
        // 直接归零：紧接着就停 rAF 了，插值来不及跑
        weight = 0
        renderer.domElement.style.opacity = '0'
        if (raf) { cancelAnimationFrame(raf); raf = 0; running = false }
      }
    },
    resize: frame,
    get clipNames() { return clips.map((c) => c.name) },
    dispose() {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      window.removeEventListener('resize', onResize)
      mount.removeEventListener('pointermove', onPointerMove)
      mixer.stopAllAction()
      scene.traverse((o) => {
        if (!o.isMesh && !o.isPoints) return
        o.geometry?.dispose?.()
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        mats.forEach((m) => { m?.map?.dispose?.(); m?.dispose?.() })
      })
      postTarget?.dispose?.()
      postMat?.dispose?.()
      renderer.dispose()
      canvas.remove()
    },
  }
}
