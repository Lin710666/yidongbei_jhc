/**
 * pano.js —— 景区全景场景（three.js）
 *
 * 把一张等距柱状全景图变成一个**可以环视的三维场景**。核心做法是
 * "**用深度图把球面撑出起伏**"：
 *
 *   普通全景球：半径处处相同 → 看起来是个贴了照片的空心球，没有立体感。
 *   这里：      每个顶点的半径由该处深度决定 → 近处凸向观察者、远处退到背景，
 *               于是照片里的山、树、建筑都成了真的"有厚度"的浮雕。
 *
 * 为什么不是把照片切成地形高度图铺在地面上：
 *   那需要假设相机朝下、且地面是唯一平面，对全景图完全不成立 ——
 *   全景里绝大多数内容是**竖直方向**的信息（天空、远山、建筑），
 *   把它们压成地面高度既不对也难看。逐顶点推半径才是与全景几何一致的做法。
 *
 * 视角：相机固定在球心，拖拽改变朝向 —— 这就是"站在景区里环视"。
 */

import * as THREE from 'three'

/** 浮雕壳体的半径范围（近处 / 远处）。相机在球心，所以这些值是"观感距离" */
const R_NEAR = 14
const R_FAR = 42
/** 球面细分：192×96 约 1.8 万顶点，8GB 显卡上完全无压力，边缘也够顺滑 */
const SEG_W = 192
const SEG_H = 96

/* ==========================================================================
 * 程序化全景（离线兜底）
 * ========================================================================*/

/**
 * 生成一张合成的等距柱状全景（2048×1024）。
 *
 * 为什么需要它：实测中文景点在网上基本找不到可自由获取的等距柱状图
 * （中文全景平台都不给直链），而演示时不能因为网络就整个功能不可用。
 * 这张图是**画出来的**，会在界面上明确标成"程序化生成（非实拍）"，
 * 绝不冒充某个景点的照片。
 *
 * 画法照等距柱状的几何来：赤道（v=0.5）是地平线，往上是天空往下是地面，
 * 并且给几层远山 —— 这样它既能当环境球，也能被深度模型判出合理的远近。
 */
export function makeProceduralPanorama(w = 2048, h = 1024) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  const horizon = h * 0.5

  // 天空：顶深底浅的渐变
  const sky = g.createLinearGradient(0, 0, 0, horizon)
  sky.addColorStop(0, '#1b3a63')
  sky.addColorStop(0.55, '#5b8fc7')
  sky.addColorStop(1, '#cfe2f2')
  g.fillStyle = sky
  g.fillRect(0, 0, w, horizon)

  // 太阳 + 光晕（放在西侧，环视时有明确的方位参照）
  const sunX = w * 0.72
  const glow = g.createRadialGradient(sunX, horizon * 0.42, 8, sunX, horizon * 0.42, w * 0.16)
  glow.addColorStop(0, 'rgba(255,244,214,0.95)')
  glow.addColorStop(0.25, 'rgba(255,226,160,0.35)')
  glow.addColorStop(1, 'rgba(255,226,160,0)')
  g.fillStyle = glow
  g.fillRect(0, 0, w, horizon)
  g.fillStyle = '#fffaf0'
  g.beginPath()
  g.arc(sunX, horizon * 0.42, 26, 0, Math.PI * 2)
  g.fill()

  // 云带：用正弦做几条横向拉长的椭圆，等距柱状下会自然环绕
  g.globalAlpha = 0.5
  for (let i = 0; i < 26; i++) {
    const cx = Math.random() * w
    const cy = horizon * (0.12 + Math.random() * 0.6)
    const rx = 60 + Math.random() * 190
    const ry = 10 + Math.random() * 26
    g.fillStyle = 'rgba(255,255,255,0.75)'
    g.beginPath()
    g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
    g.fill()
  }
  g.globalAlpha = 1

  // 地面：近处深、远处浅
  const gnd = g.createLinearGradient(0, horizon, 0, h)
  gnd.addColorStop(0, '#7d8f6a')
  gnd.addColorStop(0.45, '#5f7350')
  gnd.addColorStop(1, '#3d4b34')
  g.fillStyle = gnd
  g.fillRect(0, horizon, w, h - horizon)

  // 三层远山：越远越淡，形成纵深
  const ridgelines = [
    { base: '#7f93a8', amp: 74, y: horizon - 26, freq: 3.1, seed: 1.7 },
    { base: '#5d7288', amp: 96, y: horizon - 6, freq: 4.7, seed: 4.2 },
    { base: '#41566b', amp: 58, y: horizon + 16, freq: 7.3, seed: 8.9 },
  ]
  for (const r of ridgelines) {
    g.fillStyle = r.base
    g.beginPath()
    g.moveTo(0, h)
    for (let x = 0; x <= w; x += 6) {
      const t = (x / w) * Math.PI * 2
      // 多频叠加：比单一正弦更像山脊
      const yv = r.y
        - Math.sin(t * r.freq + r.seed) * r.amp * 0.6
        - Math.sin(t * r.freq * 2.3 + r.seed * 1.7) * r.amp * 0.25
        - Math.sin(t * r.freq * 5.1 + r.seed * 2.9) * r.amp * 0.1
      g.lineTo(x, yv)
    }
    g.lineTo(w, h)
    g.closePath()
    g.fill()
  }

  // 水面/近景纹理：横向条纹，环视时能感知旋转
  for (let i = 0; i < 320; i++) {
    const y = horizon + 24 + Math.random() * (h - horizon - 24)
    const t = (y - horizon) / (h - horizon)
    g.fillStyle = `rgba(255,255,255,${0.03 + 0.05 * (1 - t)})`
    g.fillRect(Math.random() * w, y, 40 + Math.random() * 160, 1 + Math.random() * 2)
  }

  return c
}

/** 把 canvas 变成 three.js 纹理 */
function textureFromCanvas(canvas, { srgb = true } = {}) {
  const t = new THREE.CanvasTexture(canvas)
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  t.minFilter = THREE.LinearFilter
  t.magFilter = THREE.LinearFilter
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  return t
}

/* ==========================================================================
 * 场景
 * ========================================================================*/

export class PanoramaScene {
  constructor() {
    this.group = new THREE.Group()
    this.group.name = 'panorama-scene'
    this.mesh = null
    this.skyMesh = null
    this.colorTex = null
    this.depthTex = null
    this.depthData = null      // { data: Uint8ClampedArray, width, height }
    this.ready = false
    this.report = null         // 生成结果摘要，给界面显示
    this._yaw = 0
    this._pitch = 0
  }

  /** 载入一张已成图的全景（ImageBitmap / HTMLImageElement / canvas 都行） */
  async setPanoramaSource(source, { label = '', sourceKind = 'unknown' } = {}) {
    this.disposeMesh()
    this.colorTex = textureFromCanvas(source)
    this.colorTex.needsUpdate = true
    this.sourceLabel = label
    this.sourceKind = sourceKind
    this._sourceCanvas = source
    this.ready = true
  }

  /** 从 URL 载入全景图（同源的 /api/pano/image/:id） */
  setPanoramaUrl(url, meta = {}) {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = async () => {
        try {
          // 画到 canvas 再当纹理：这样后续也能直接从里面取像素
          const c = document.createElement('canvas')
          c.width = img.naturalWidth
          c.height = img.naturalHeight
          c.getContext('2d').drawImage(img, 0, 0)
          await this.setPanoramaSource(c, meta)
          resolve(c)
        } catch (e) { reject(e) }
      }
      img.onerror = () => reject(new Error('全景图加载失败'))
      img.src = url
    })
  }

  /**
   * 载入深度图并重建浮雕。
   * 深度图是灰度 PNG：越亮 = 越近。
   */
  async setDepthUrl(url) {
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('深度图加载失败'))
      i.src = url
    })
    // 降采样到 512 宽：位移只需要低频信息，原图 1024 宽既慢又没必要
    const W = Math.min(512, img.naturalWidth)
    const H = Math.max(1, Math.round(img.naturalHeight * (W / img.naturalWidth)))
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(img, 0, 0, W, H)
    const id = g.getImageData(0, 0, W, H)
    this.depthData = { data: id.data, width: W, height: H }
    this.depthTex = textureFromCanvas(c, { srgb: false })
    this.rebuild()
    return { width: W, height: H }
  }

  clearDepth() {
    this.depthData = null
    if (this.depthTex) { this.depthTex.dispose(); this.depthTex = null }
    this.rebuild()
  }

  /** 按当前纹理与深度重建网格 */
  rebuild() {
    this.disposeMesh()
    if (!this.colorTex) return

    const geo = new THREE.SphereGeometry(1, SEG_W, SEG_H)
    const pos = geo.attributes.position
    const uv = geo.attributes.uv

    if (this.depthData) {
      const { data, width, height } = this.depthData
      const v3 = new THREE.Vector3()
      let minR = Infinity
      let maxR = -Infinity
      for (let i = 0; i < pos.count; i++) {
        // 用 UV 去采样深度：UV 本来就是球面参数化，比反算经纬度更准
        const u = uv.getX(i)
        const v = uv.getY(i)
        const px = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))))
        const py = Math.min(height - 1, Math.max(0, Math.round((1 - v) * (height - 1))))
        const d = data[(py * width + px) * 4] / 255        // 0..1，越大越近

        v3.fromBufferAttribute(pos, i).normalize()
        // 深度小（远）→ 半径大；深度大（近）→ 半径小。
        // 指数的 0.75 次方是压一下对比：线性映射会让天空整片塌成同一个凸面，
        // 压过之后远山与天空才分得开。
        const shaped = Math.pow(d, 0.75)
        const r = R_FAR - (R_FAR - R_NEAR) * shaped
        if (r < minR) minR = r
        if (r > maxR) maxR = r
        pos.setXYZ(i, v3.x * r, v3.y * r, v3.z * r)
      }
      this.report = { relief: true, minRadius: minR, maxRadius: maxR }
      geo.computeVertexNormals()
    } else {
      // 没有深度图时就退化成普通环境球（依然可环视，只是没有立体起伏）
      const R = (R_NEAR + R_FAR) / 2
      for (let i = 0; i < pos.count; i++) {
        const v3 = new THREE.Vector3().fromBufferAttribute(pos, i).normalize().multiplyScalar(R)
        pos.setXYZ(i, v3.x, v3.y, v3.z)
      }
      this.report = { relief: false }
    }
    pos.needsUpdate = true

    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: this.colorTex,
      side: THREE.BackSide,     // 相机在球内，要看内表面
      // 贴图为 sRGB，three.js 会做线性化；这里不再额外调色
      toneMapped: false,
    }))
    this.mesh.frustumCulled = false
    this.group.add(this.mesh)
  }

  /** 视角：yaw 水平（度）、pitch 垂直（度，+ 向上） */
  setView(yawDeg, pitchDeg) {
    this._yaw = yawDeg
    this._pitch = Math.max(-80, Math.min(80, pitchDeg))
  }

  get yaw() { return this._yaw }
  get pitch() { return this._pitch }

  /** 相机固定在球心，只改朝向 */
  applyToCamera(camera) {
    const y = (this._yaw * Math.PI) / 180
    const p = (this._pitch * Math.PI) / 180
    camera.position.set(0, 0, 0)
    const dir = new THREE.Vector3(
      Math.sin(y) * Math.cos(p),
      Math.sin(p),
      -Math.cos(y) * Math.cos(p),
    )
    camera.lookAt(dir.multiplyScalar(10))
  }

  disposeMesh() {
    if (this.mesh) {
      this.group.remove(this.mesh)
      try { this.mesh.geometry.dispose() } catch { /* 忽略 */ }
      try { this.mesh.material.dispose() } catch { /* 忽略 */ }
      this.mesh = null
    }
  }

  dispose() {
    this.disposeMesh()
    if (this.colorTex) { this.colorTex.dispose(); this.colorTex = null }
    if (this.depthTex) { this.depthTex.dispose(); this.depthTex = null }
    this.depthData = null
    this.ready = false
  }
}
