/**
 * stage3d.js —— 3D 角色舞台（three.js + @pixiv/three-vrm）
 *
 * 这个文件是 **ES Module**，而且是被 app.js 用 `await import()` 按需加载的。
 * 原因：three.js 1.3MB + three-vrm 0.9MB 加起来 2.2MB，
 * 而默认形象是 Live2D —— 不能为了"支持 3D"就让所有用户都先下这 2.2MB。
 * 只有真的选了 3D 形象，才会加载它。
 *
 * 依赖用 importmap 映射（见 index.html）：
 *   "three"          -> /vendor/three/three.module.js
 *   "three/addons/"  -> /vendor/three/addons/
 *
 * 支持格式：.vrm（VRM 0.x / 1.0）、.glb、.gltf
 *
 * 实现的互动（VRM 有骨骼与表情才能做，纯 glb 只能做整体位移）：
 *   · 视线跟随鼠标（vrm.lookAt）
 *   · 自动眨眼（程序化驱动 blink 表情）
 *   · 说话口型（用 TTS 音频的实时频谱驱动 aa 表情）
 *   · 待机呼吸与轻微摆动（程序化，不依赖外部动画文件）
 *   · 点头/摇头等小动作（点一下触发）
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
// three-vrm 用相对路径引，少一条 importmap 映射就少一个出错的地方；
// 它内部只 import 'three'，那条由 importmap 负责。
import { VRMLoaderPlugin, VRMUtils } from '../vendor/three/three-vrm.module.js'

/** 目标身高（米）。VRM 本身按米建模，纯 glb 可能是任意尺度，统一归一到这个高度 */
const TARGET_HEIGHT = 1.62

export class ThreeDStage {
  constructor(canvas) {
    this.canvas = canvas
    this.renderer = null
    this.scene = null
    this.camera = null
    this.model = null
    this.vrm = null
    this.mixer = null
    this.clock = new THREE.Clock()
    this.ready = false
    this.url = null

    // 交互状态
    this.pointer = { x: 0, y: 0 }          // -1..1，鼠标在舞台里的归一化位置
    this.lookTarget = null
    this.mouthOpen = 0
    this.targetMouthOpen = 0
    this.analyser = null
    this.audioCtx = null
    this.audioSource = null

    // 程序化待机
    this.idlePhase = Math.random() * Math.PI * 2
    this.blinkTimer = 1.5
    this.blinkPhase = -1                    // <0 表示没在眨
    this.nodUntil = 0

    // 用户可调（与 Live2D 那套保持一致的语义）
    this.userScale = 1
    this.userX = 0
    this.userY = 0
    this.baseScale = 1
    this.modelBaseY = 0
    this.targetHeight = TARGET_HEIGHT

    this.onReadyCb = null
    this.onTapCb = null
    this._raf = null
    this._disposed = false
  }

  /** three.js 是否已经加载好可用（app.js 用它决定要不要懒加载） */
  static async available() {
    try {
      await import('three')
      return true
    } catch {
      return false
    }
  }

  async init() {
    if (this.renderer) return

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,                 // 透明底：后面的背景层能透出来
      antialias: true,
      preserveDrawingBuffer: true, // 便于验收脚本采样像素
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.scene = new THREE.Scene()

    // 光照：半球光给环境色，主光从斜前上方打，补光压一下阴影面
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8b93a7, 2.0)
    this.scene.add(hemi)
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(0.6, 1.6, 1.2)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xa9c6ff, 0.6)
    fill.position.set(-0.9, 0.9, 0.8)
    this.scene.add(fill)

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100)

    // 视线目标：一个空对象，鼠标一动就把它挪到对应的方位
    this.lookTarget = new THREE.Object3D()
    this.lookTarget.position.set(0, 1.4, 2)
    this.scene.add(this.lookTarget)

    const host = this.canvas.parentElement
    host.addEventListener('mousemove', (e) => {
      const r = host.getBoundingClientRect()
      this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1
      this.pointer.y = ((e.clientY - r.top) / r.height) * 2 - 1
    })
    host.addEventListener('mouseleave', () => { this.pointer.x = 0; this.pointer.y = 0 })
    host.addEventListener('pointerdown', () => { if (this.onTapCb) this.onTapCb() })

    window.addEventListener('resize', () => this.resize())
    this.ready = true
    this._loop()
  }

  /**
   * 载入模型。
   * @param {string} url .vrm / .glb / .gltf 地址
   */
  async load(url) {
    if (!this.renderer) await this.init()
    this.url = url
    if (this.model) this._unload()

    const loader = new GLTFLoader()
    // 注册 VRM 插件：不是 VRM 的文件它不会插手，所以一个 loader 通吃 .vrm/.glb
    loader.register(parser => new VRMLoaderPlugin(parser))

    let gltf
    try {
      gltf = await loader.loadAsync(url)
    } catch (e) {
      throw new Error(`3D 模型加载失败：${e && e.message ? e.message : e}\n模型地址：${url}`)
    }

    const vrm = gltf.userData.vrm
    this.vrm = vrm || null
    const model = vrm ? vrm.scene : gltf.scene
    if (!model) throw new Error('文件里没有可显示的 3D 场景')

    // VRM 0.x 是朝 +Z 的（面对镜头背面），统一转成朝 -Z，和 glTF 约定一致
    if (vrm) {
      try { VRMUtils.rotateVRM0(vrm) } catch { /* 旧版本没有这个工具，忽略 */ }
    }
    model.traverse((obj) => {
      obj.frustumCulled = false          // 骨骼动画容易算出错误的包围盒，直接关掉
      if (obj.isMesh) obj.castShadow = false
    })

    this.model = model
    this.scene.add(model)

    // 归一化尺度与落地点：算包围盒 -> 缩到目标身高 -> 脚底贴地 -> 水平居中
    const box = new THREE.Box3().setFromObject(model)
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)
    const h = size.y || 1
    this.baseScale = TARGET_HEIGHT / h
    this.modelBaseY = -box.min.y * this.baseScale
    model.scale.setScalar(this.baseScale)
    model.position.set(-center.x * this.baseScale, this.modelBaseY, -center.z * this.baseScale)

    // VRM：把 T-pose 掰成自然站姿（见方法注释），再接上视线跟随
    if (vrm) {
      this._applyRelaxedPose(vrm)
      if (vrm.lookAt) {
        try {
          vrm.lookAt.target = this.lookTarget
          // 有些 VRM 0.x 的 lookAt 需要显式指定朝向
          if (typeof vrm.lookAt.autoUpdate === 'boolean') vrm.lookAt.autoUpdate = true
        } catch { /* 忽略 */ }
      }
    }

    this.applyTransform()
    this.resize()
    if (this.onReadyCb) {
      this.onReadyCb({
        url,
        isVRM: Boolean(vrm),
        hasExpressions: Boolean(vrm && vrm.expressionManager),
        expressionNames: vrm && vrm.expressionManager
          ? Object.keys(vrm.expressionManager.expressionMap || {})
          : [],
      })
    }
    return model
  }

  /**
   * 把 VRM 的 T-pose 掰成自然站姿。
   *
   * 为什么必须做：VRM 文件的"静止姿态"就是双臂平举的 T-pose（建模约定），
   * 不加载任何动画时人物会一直张开双臂站着，看起来像没做完。
   * three-vrm 的 normalized bone 提供一个与原始骨骼解耦的标准化骨架，
   * 直接旋转上臂就能把手臂放下来，不需要 MMA/动画文件。
   *
   * 角度是试出来的：上臂绕 Z 轴约 79° 让手臂自然下垂并略微外张（A-pose）。
   * 只动上臂，**不动小臂与手腕** —— 试过给 lowerArm 加内旋、给 hand 加偏转，
   * 结果手部朝向反而变得别扭（不同模型的骨骼朝向约定并不统一，
   * 猜错轴就会把手拧到背后）。只放上臂是"对任何模型都不会更丑"的最小改动。
   */
  _applyRelaxedPose(vrm) {
    if (!vrm.humanoid) return
    try {
      const set = (name, axis, value) => {
        const b = vrm.humanoid.getNormalizedBoneNode(name)
        if (b) b.rotation[axis] = value
      }
      set('leftUpperArm', 'z', Math.PI * 0.44)
      set('rightUpperArm', 'z', -Math.PI * 0.44)
      this._relaxedPoseApplied = true
    } catch { /* 骨骼名不在的模型就直接保持原样 */ }
  }

  _unload() {
    if (!this.model) return
    this.scene.remove(this.model)
    this.model.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose()
      const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : [])
      for (const m of mats) {
        for (const k of Object.keys(m)) {
          const v = m[k]
          if (v && v.isTexture) v.dispose()
        }
        m.dispose()
      }
    })
    this.model = null
    this.vrm = null
  }

  /** 相机取景：按模型身高把人物框在画面里，留出头顶与脚下一点余量 */
  _frameCamera() {
    const h = TARGET_HEIGHT * this.userScale
    const cy = this.modelBaseY + h * 0.52
    // 2.7 倍身高是试出来的：fov 30° 时可视高度 = 2 * dist * tan(15°) ≈ 0.536 * dist，
    // dist = 2.7h 时可视高度 ≈ 1.45h —— 人物占画面约七成，头顶和脚下都有余量。
    // 之前写 1.85h 时可视高度刚好等于身高，人物会顶天立地贴满整个画面。
    const dist = h * 2.7
    this.camera.fov = 30
    this.camera.position.set(this.userX * 0.6, cy + h * 0.04, dist)
    this.camera.lookAt(this.userX * 0.6, cy, 0)
    this.camera.updateProjectionMatrix()
  }

  applyTransform() {
    if (!this.model) return
    this.model.scale.setScalar(this.baseScale * this.userScale)
    this.model.position.y = this.modelBaseY
    this.model.position.x = this.userX
    this._frameCamera()
  }

  setScale(v) { this.userScale = Math.max(0.3, Math.min(3, v)); this.applyTransform() }
  setPosition(x, y) { this.userX = x * 0.01; this.userY = y; this.applyTransform() }

  resize() {
    if (!this.renderer || !this.camera) return
    const host = this.canvas.parentElement
    const r = host.getBoundingClientRect()
    const w = Math.max(1, Math.floor(r.width))
    const h = Math.max(1, Math.floor(r.height))
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this._frameCamera()
  }

  /** 打开/关闭某类表情（模型没有该表情时静默跳过） */
  _setExpression(name, value) {
    const em = this.vrm && this.vrm.expressionManager
    if (!em) return false
    try {
      if (!em.expressionMap || !(name in em.expressionMap)) return false
      em.setValue(name, value)
      return true
    } catch { return false }
  }

  /** 当前模型可用的表情名（供界面列出） */
  expressionNames() {
    const em = this.vrm && this.vrm.expressionManager
    if (!em || !em.expressionMap) return []
    // 眨眼与口型是内部驱动的，不列给用户手动选
    return Object.keys(em.expressionMap).filter(n => !['blink', 'aa', 'ih', 'ou', 'ee', 'oh'].includes(n))
  }

  /** 手动切一个情绪表情，几秒后回到 neutral */
  setExpression(name) {
    if (!name) return false
    const ok = this._setExpression(name, 1)
    if (ok) {
      clearTimeout(this._exprTimer)
      this._exprTimer = setTimeout(() => {
        this._setExpression(name, 0)
        this._setExpression('neutral', 0)
      }, 3200)
    }
    return ok
  }

  /** 点一下：点个头 + 随机一个情绪表情 */
  playMotion() {
    this.nodUntil = performance.now() + 900
    const list = this.expressionNames().filter(n => ['happy', 'relaxed', 'surprised', 'joy', 'fun'].includes(n))
    if (list.length) this.setExpression(list[Math.floor(Math.random() * list.length)])
    return true
  }

  /** 用音频驱动口型：读实时频谱能量 -> aa 表情 */
  async speak(url, audioEl) {
    if (!url) return
    if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume()

    audioEl.src = url
    audioEl.crossOrigin = 'anonymous'
    try {
      if (this.audioSource) { try { this.audioSource.disconnect() } catch { /* 忽略 */ } }
      this.audioSource = this.audioCtx.createMediaElementSource(audioEl)
      this.analyser = this.audioCtx.createAnalyser()
      this.analyser.fftSize = 256
      this.analyser.smoothingTimeConstant = 0.7
      this.audioSource.connect(this.analyser)
      this.analyser.connect(this.audioCtx.destination)
    } catch {
      // 同一个 <audio> 只能被 createMediaElementSource 绑一次；重复绑定就退化成"只出声不动嘴"
      this.analyser = null
    }

    await new Promise((resolve, reject) => {
      const done = () => { cleanup(); this.targetMouthOpen = 0; resolve() }
      const err = (e) => { cleanup(); reject(e) }
      const cleanup = () => {
        audioEl.removeEventListener('ended', done)
        audioEl.removeEventListener('error', err)
      }
      audioEl.addEventListener('ended', done)
      audioEl.addEventListener('error', err)
      audioEl.play().catch(err)
    })
  }

  stopSpeaking(audioEl) {
    try { audioEl.pause() } catch { /* 忽略 */ }
    this.targetMouthOpen = 0
    this.mouthOpen = 0
  }

  _loop() {
    const step = () => {
      if (this._disposed) return
      this._raf = requestAnimationFrame(step)
      const dt = Math.min(this.clock.getDelta(), 0.05)
      const now = performance.now()

      if (this.model) {
        // ---- 视线跟随：把目标点挪到鼠标方位 ----
        if (this.lookTarget) {
          const t = performance.now() / 1000
          this.lookTarget.position.set(
            this.pointer.x * 1.2,
            this.modelBaseY + TARGET_HEIGHT * 0.95 - this.pointer.y * 0.5,
            1.6,
          )
          void t
        }

        // ---- 待机呼吸：整体轻微上下 + 侧向摆动（不依赖外部动画文件）----
        this.idlePhase += dt * 1.15
        const breath = Math.sin(this.idlePhase) * 0.006
        const sway = Math.sin(this.idlePhase * 0.5) * 0.012
        this.model.position.y = this.modelBaseY + breath
        this.model.rotation.z = sway
        // 点头：在 nodUntil 内做一个阻尼正弦，结束后归零
        if (now < this.nodUntil) {
          const p = 1 - (this.nodUntil - now) / 900
          this.model.rotation.x = Math.sin(p * Math.PI * 2) * 0.10
        } else if (this.model.rotation.x !== 0) {
          this.model.rotation.x *= 0.85
          if (Math.abs(this.model.rotation.x) < 0.001) this.model.rotation.x = 0
        }

        // ---- 自动眨眼 ----
        if (this.vrm && this.vrm.expressionManager) {
          if (this.blinkPhase < 0) {
            this.blinkTimer -= dt
            if (this.blinkTimer <= 0) { this.blinkPhase = 0; this.blinkTimer = 2 + Math.random() * 3.5 }
          } else {
            this.blinkPhase += dt
            const T = 0.14
            const p = this.blinkPhase / T
            const v = p < 0.5 ? p * 2 : Math.max(0, (1 - p) * 2)
            this._setExpression('blink', Math.min(1, v))
            if (p >= 1) { this.blinkPhase = -1; this._setExpression('blink', 0) }
          }

          // ---- 口型：读频谱能量，平滑逼近 ----
          if (this.analyser) {
            const buf = new Uint8Array(this.analyser.frequencyBinCount)
            this.analyser.getByteFrequencyData(buf)
            let sum = 0
            const from = 2
            const to = Math.min(buf.length, 48)
            for (let i = from; i < to; i++) sum += buf[i]
            this.targetMouthOpen = Math.min(1, (sum / ((to - from) * 255)) * 2.6)
          } else {
            this.targetMouthOpen = 0
          }
          this.mouthOpen += (this.targetMouthOpen - this.mouthOpen) * 0.35
          // VRM 的 'aa' 是元音口型；没有就退到 'ou'，再没有就跳过
          if (!this._setExpression('aa', this.mouthOpen)) this._setExpression('ou', this.mouthOpen * 0.8)
        }
      }

      if (this.vrm && this.vrm.update) {
        try { this.vrm.update(dt) } catch { /* 单个模型的骨骼异常不该打断整帧 */ }
      }
      this.renderer.render(this.scene, this.camera)
    }
    step()
  }

  destroy() {
    this._disposed = true
    if (this._raf) cancelAnimationFrame(this._raf)
    clearTimeout(this._exprTimer)
    this._unload()
    if (this.renderer) { try { this.renderer.dispose() } catch { /* 忽略 */ } }
    this.ready = false
  }
}
