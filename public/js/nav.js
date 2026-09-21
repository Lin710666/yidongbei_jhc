/**
 * nav.js —— 定位导航页（零第三方依赖）
 *
 * 用户要的是："开一个页面展示我在哪，并给我导航。"
 *
 * ## 为什么自己画地图，而不是用地图 SDK
 *
 * 高德/百度的 JS SDK 都要 API key，而本项目的原则是不引入需要密钥的外部依赖；
 * 而地图本身需要的核心只有一件事：**把经纬度按 Web Mercator 投影到屏幕上**。
 * 那部分公式是公开且很短的，所以这里自己实现一个极简瓦片地图
 * （256px 瓦片 + 平移 + 缩放 + 打点），一共不到 200 行，还能完全控制观感。
 * 瓦片走本机服务端代理（/api/tile），顺带解决防盗链和缓存。
 *
 * ## 定位的现实约束（必须说清楚）
 *
 * `navigator.geolocation` 只在**安全上下文**里可用：localhost 或 HTTPS。
 * 局域网用 IP 访问（http://192.168.x.x:8000）时浏览器会**直接拒绝**，
 * 连授权弹窗都不给。展会大屏常常就是这种情况，所以这里有三级兜底：
 *   1. 浏览器定位（最准）
 *   2. 手动输入经纬度
 *   3. 选一个内置城市中心当"我在这"（演示用，离线可用）
 *
 * ## 导航能力的边界
 *
 * 真正"怎么走"的路径规划要有路网数据或路径规划 API（都要 key 或额度）。
 * 这里给的是**方位 + 直线距离 + 步行估算**，以及跳转到高德/百度地图去真导航的链接。
 * 不假装能给出逐条转向指令。
 */
(function () {
  'use strict';

  const TILE = 256;
  const EARTH_R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  /* ---------------- Web Mercator ---------------- */

  /** 经度 → 瓦片坐标（带小数，z 层级） */
  function lngToTileX(lng, z) { return ((lng + 180) / 360) * Math.pow(2, z); }
  /** 纬度 → 瓦片坐标（带小数） */
  function latToTileY(lat, z) {
    const r = toRad(Math.max(-85.05112878, Math.min(85.05112878, lat)));
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
  }
  function tileXToLng(x, z) { return (x / Math.pow(2, z)) * 360 - 180; }
  function tileYToLat(y, z) {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
    return toDeg(Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
  }

  function distanceMeters(a, b) {
    if (!a || !b) return null;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const la1 = toRad(a.lat), la2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearingDeg(a, b) {
    const la1 = toRad(a.lat), la2 = toRad(b.lat), dLng = toRad(b.lng - a.lng);
    const y = Math.sin(dLng) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }
  const COMPASS = ['北', '北东北', '东北', '东东北', '东', '东东南', '东南', '南东南',
    '南', '南西南', '西南', '西西南', '西', '西西北', '西北', '北西北'];
  function compassLabel(deg) {
    if (!Number.isFinite(deg)) return '';
    return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
  }
  function formatDistance(m) {
    if (!Number.isFinite(m)) return '—';
    if (m < 1000) return `${Math.round(m)} 米`;
    if (m < 10000) return `${(m / 1000).toFixed(1)} 公里`;
    return `${Math.round(m / 1000)} 公里`;
  }
  /** 步行时间：城市步行按 1.2 m/s（4.3 km/h）估，比按 1.4 更接近真实（等灯、看景） */
  function walkMinutes(m) { return Math.max(1, Math.round(m / 1.2 / 60)); }

  /** 跳转到真正的地图 App 去导航（这一段是"真导航"，我们不自己造 */
  function mapLinks(target, here) {
    const name = encodeURIComponent(target.name);
    return [
      {
        label: '高德地图',
        // uri 协议在手机上能直接唤起 App，桌面端会打开网页版
        url: `https://uri.amap.com/marker?position=${target.lng},${target.lat}&name=${name}&src=wenlv&coordinate=gaode&callnative=1`,
      },
      {
        label: '百度地图',
        url: `https://api.map.baidu.com/marker?location=${target.lat},${target.lng}&title=${name}&content=文旅导览&output=html&coord_type=gcj02`,
      },
      {
        label: '腾讯地图',
        url: `https://apis.map.qq.com/uri/v1/marker?marker=coord:${target.lat},${target.lng};title:${name}&referer=wenlv`,
      },
    ];
  }

  /* ==========================================================================
   * 极简瓦片地图
   * ========================================================================*/

  function createMap(canvas, opts) {
    const ctx = canvas.getContext('2d');
    let center = { lat: opts.lat || 30.2489, lng: opts.lng || 120.1419 };
    let zoom = opts.zoom || 14;
    const imgCache = new Map();     // key → {img, ready}
    let markers = [];
    let raf = 0;
    let w = 0, h = 0;

    function tileImg(z, x, y) {
      const key = `${z}/${x}/${y}`;
      let rec = imgCache.get(key);
      if (rec) return rec;
      const img = new Image();
      rec = { img, ready: false, failed: false };
      img.onload = () => { rec.ready = true; paint(); };
      img.onerror = () => { rec.failed = true; paint(); };
      // 走本机代理：顺带解决防盗链，服务端还会缓存
      img.src = `/api/tile?z=${z}&x=${x}&y=${y}`;
      imgCache.set(key, rec);
      // 缓存别无限涨（一屏约 20 块，留 300 够平移很久）
      if (imgCache.size > 300) {
        const first = imgCache.keys().next().value;
        imgCache.delete(first);
      }
      return rec;
    }

    function project(lat, lng) {
      const z = Math.round(zoom);
      const cx = lngToTileX(center.lng, z);
      const cy = latToTileY(center.lat, z);
      const px = lngToTileX(lng, z);
      const py = latToTileY(lat, z);
      return { x: (px - cx) * TILE + w / 2, y: (py - cy) * TILE + h / 2 };
    }

    function paint() {
      if (!w || !h) return;
      const z = Math.round(zoom);
      const n = Math.pow(2, z);
      ctx.clearRect(0, 0, w, h);
      // 底：深色，瓦片没到位时不会闪白
      ctx.fillStyle = '#0d1418';
      ctx.fillRect(0, 0, w, h);

      const cx = lngToTileX(center.lng, z);
      const cy = latToTileY(center.lat, z);
      const halfW = w / 2 / TILE;
      const halfH = h / 2 / TILE;
      const x0 = Math.floor(cx - halfW), x1 = Math.ceil(cx + halfW);
      const y0 = Math.floor(cy - halfH), y1 = Math.ceil(cy + halfH);
      let pending = 0;

      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          if (y < 0 || y >= n) continue;
          const wx = ((x % n) + n) % n;      // 经度方向环绕
          const rec = tileImg(z, wx, y);
          const sx = (x - cx) * TILE + w / 2;
          const sy = (y - cy) * TILE + h / 2;
          if (rec.ready) {
            ctx.drawImage(rec.img, sx, sy, TILE, TILE);
          } else {
            pending++;
            ctx.fillStyle = '#16222a';
            ctx.fillRect(sx, sy, TILE, TILE);
          }
        }
      }
      if (pending && !raf) raf = requestAnimationFrame(() => { raf = 0; paint(); });

      // 打点
      for (const m of markers) {
        const p = project(m.lat, m.lng);
        if (p.x < -60 || p.y < -60 || p.x > w + 60 || p.y > h + 60) continue;
        drawMarker(m, p);
      }
    }

    function drawMarker(m, p) {
      ctx.save();
      if (m.kind === 'me') {
        // 我：呼吸的蓝点 + 外圈
        const t = (performance.now() % 2000) / 2000;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 9 + t * 12, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(120,200,255,${0.28 * (1 - t)})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#4aa8ff';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      } else {
        const active = m.active;
        ctx.beginPath();
        ctx.arc(p.x, p.y, active ? 9 : 6.5, 0, Math.PI * 2);
        ctx.fillStyle = active ? '#e8b04a' : '#d2555f';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        if (active) {
          ctx.font = '600 13px system-ui, "Microsoft YaHei", sans-serif';
          ctx.textAlign = 'center';
          ctx.lineWidth = 3.5;
          ctx.strokeStyle = 'rgba(0,0,0,0.75)';
          ctx.strokeText(m.name, p.x, p.y - 14);
          ctx.fillStyle = '#fff';
          ctx.fillText(m.name, p.x, p.y - 14);
        }
      }
      ctx.restore();
    }

    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, lat: center.lat, lng: center.lng };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const z = Math.round(zoom);
      const cx = lngToTileX(drag.lng, z) - (e.clientX - drag.x) / TILE;
      const cy = latToTileY(drag.lat, z) - (e.clientY - drag.y) / TILE;
      center = { lng: tileXToLng(cx, z), lat: tileYToLat(cy, z) };
      paint();
    });
    const endDrag = () => { drag = null; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      setZoom(zoom + (e.deltaY < 0 ? 0.5 : -0.5));
    }, { passive: false });

    function setZoom(z) {
      zoom = Math.max(3, Math.min(18, z));
      if (opts.onZoom) opts.onZoom(Math.round(zoom));
      paint();
    }

    function resize() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, Math.round(r.width));
      h = Math.max(1, Math.round(r.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint();
    }

    return {
      resize,
      render() { resize(); },
      setCenter(lat, lng, z) {
        center = { lat, lng };
        if (z) zoom = Math.max(3, Math.min(18, z));
        paint();
      },
      getCenter: () => ({ ...center }),
      getZoom: () => Math.round(zoom),
      zoomBy: (d) => setZoom(zoom + d),
      setMarkers(list) { markers = list || []; paint(); },
      repaint: paint,
    };
  }

  /* ==========================================================================
   * 页面
   * ========================================================================*/

  function createNavPage({ onToast, cities } = {}) {
    let root = null;
    let map = null;
    let me = null;             // {lat,lng} 或 null
    let meSource = '';         // 'gps' | 'manual' | 'preset'
    let spots = [];
    let target = null;

    const $ = (sel) => root && root.querySelector(sel);

    function build() {
      root = document.createElement('div');
      root.className = 'navpage';
      root.id = 'navpage';
      root.hidden = true;
      root.innerHTML = `
        <div class="navpage-head">
          <div class="navpage-title">
            <span class="navpage-kicker">西湖文旅 · 定位导航</span>
            <h2>我在哪 · 去哪儿</h2>
          </div>
          <div class="navpage-actions">
            <button class="mini-btn" id="np-locate" type="button">📍 定位我</button>
            <button class="mini-btn" id="np-manual" type="button">⌨️ 手动输入</button>
            <button class="mini-btn" id="np-close" type="button">✕ 关闭</button>
          </div>
        </div>

        <div class="navpage-body">
          <div class="navpage-map-wrap">
            <canvas class="navpage-map" id="np-map"></canvas>
            <div class="navpage-zoom">
              <button type="button" id="np-zoom-in">＋</button>
              <button type="button" id="np-zoom-out">－</button>
            </div>
            <div class="navpage-status" id="np-status">还没定位。点「📍 定位我」，或从下面选一个位置。</div>
          </div>

          <aside class="navpage-side">
            <div class="nphere">
              <div class="nphere-label">我的位置</div>
              <div class="nphere-value" id="np-here">—</div>
              <div class="nphere-src" id="np-src"></div>
            </div>

            <div class="npnav" id="np-navcard" hidden>
              <div class="npnav-arrow" id="np-arrow">↑</div>
              <div class="npnav-main">
                <div class="npnav-name" id="np-target">—</div>
                <div class="npnav-meta" id="np-meta">—</div>
              </div>
              <div class="npnav-links" id="np-links"></div>
            </div>

            <div class="nplist-head">
              <span>附近景点</span>
              <button class="mini-btn" id="np-refresh" type="button" hidden>↻ 刷新</button>
            </div>
            <div class="nplist" id="np-list">
              <div class="np-empty">定位之后，这里会按距离列出最近的景点。</div>
            </div>

            <div class="nppreset">
              <div class="nplist-head"><span>没有定位权限？选一个城市起点</span></div>
              <div class="nppreset-btns" id="np-presets"></div>
              <div class="np-note">
                <b>为什么需要兜底：</b>浏览器只在 <code>localhost</code> 或 HTTPS 下允许定位；
                用局域网 IP（如 192.168.x.x）打开时会被直接拒绝，连授权弹窗都没有。
                展会大屏经常就是这种情况。
              </div>
            </div>
          </aside>
        </div>
      `;
      document.body.appendChild(root);

      // 城市兜底按钮（来自服务端的城市中心表）。
      // 服务端拿不到就退回内置的杭州 —— 这个功能不能因为一次请求失败就整块消失。
      const presets = $('#np-presets');
      const renderPresets = (cs) => {
        presets.innerHTML = '';
        for (const [name, c] of Object.entries(cs || {})) {
          const b = document.createElement('button');
          b.className = 'mini-btn';
          b.type = 'button';
          b.textContent = name;
          b.addEventListener('click', () => setMe(c.lat, c.lng, 'preset', `${name}市中心`));
          presets.appendChild(b);
        }
      };
      const fallback = { 杭州: { lat: 30.2741, lng: 120.1551 }, 苏州: { lat: 31.2989, lng: 120.5853 } };
      renderPresets(cities && Object.keys(cities).length ? cities : fallback);
      if (!(cities && Object.keys(cities).length)) {
        // 没从外面拿到就自己取一次（比如从聊天里直接打开的入口）
        fetch('/api/geo/cities').then((r) => r.json())
          .then((r) => { if (r && r.ok) renderPresets(r.cities); })
          .catch(() => { /* 用内置的就行 */ });
      }

      map = createMap($('#np-map'), {
        lat: 30.2489, lng: 120.1419, zoom: 14,
        onZoom: (z) => { const el = $('#np-zoominfo'); if (el) el.textContent = z; },
      });
      window.addEventListener('resize', () => { if (!root.hidden) map.resize(); });

      $('#np-close').addEventListener('click', hide);
      $('#np-locate').addEventListener('click', locate);
      $('#np-zoom-in').addEventListener('click', () => map.zoomBy(1));
      $('#np-zoom-out').addEventListener('click', () => map.zoomBy(-1));
      $('#np-manual').addEventListener('click', manualInput);
      $('#np-refresh').addEventListener('click', refreshSpots);

      // Esc 关闭
      root.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    }

    function status(text, warn) {
      const el = $('#np-status');
      if (!el) return;
      el.textContent = text;
      el.style.color = warn ? '#e8a04a' : '';
    }

    function setMe(lat, lng, source, extra) {
      me = { lat, lng };
      meSource = source;
      const label = { gps: '浏览器定位', manual: '手动输入', preset: '内置城市起点' }[source] || source;
      $('#np-here').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}${extra ? ' · ' + extra : ''}`;
      $('#np-src').textContent = `来源：${label}`;
      const z = $('#np-refresh');
      if (z) z.hidden = false;
      map.setCenter(lat, lng, 15);
      refreshSpots();
      if (source !== 'gps') {
        status('这是手动/预设位置，不是真实定位。距离和方位是按它算的。');
      }
    }

    function locate() {
      if (!navigator.geolocation) {
        status('这个浏览器不支持定位。用下面的城市起点，或「手动输入」。', true);
        return;
      }
      status('正在请求定位…（浏览器可能会弹授权框）');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, accuracy } = pos.coords;
          setMe(latitude, longitude, 'gps');
          status(`定位成功，精度约 ${Math.round(accuracy)} 米。`);
        },
        (err) => {
          // 把失败原因说清楚 —— 最常见的其实是"不安全上下文"，而报错文案看不出来
          const insecure = !window.isSecureContext;
          const why = {
            1: '你拒绝了授权',
            2: '拿不到位置信号',
            3: '等待超时',
          }[err.code] || err.message;
          status(insecure
            ? `定位不可用：当前页面不是安全上下文（${location.protocol}//${location.host}）。`
              + '浏览器只在 localhost 或 HTTPS 下允许定位。可以改用下面的城市起点或「手动输入」。'
            : `定位失败：${why}。可以改用下面的城市起点或「手动输入」。`, true);
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
      );
    }

    function manualInput() {
      const cur = me ? `${me.lat}, ${me.lng}` : '30.2489, 120.1419';
      const raw = window.prompt('输入经纬度，格式：纬度, 经度\n例如西湖：30.2489, 120.1419', cur);
      if (!raw) return;
      const m = String(raw).match(/(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)/);
      if (!m) { status('没认出来。请按「纬度, 经度」的格式输入，例如 30.2489, 120.1419', true); return; }
      const lat = Number(m[1]), lng = Number(m[2]);
      if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) {
        status('经纬度超出范围了。纬度 -90~90，经度 -180~180。', true);
        return;
      }
      setMe(lat, lng, 'manual');
    }

    async function refreshSpots() {
      if (!me) return;
      const list = $('#np-list');
      list.innerHTML = '<div class="np-empty">正在算距离…</div>';
      try {
        const r = await fetch(`/api/geo/nearby?lat=${me.lat}&lng=${me.lng}&limit=12`).then((x) => x.json());
        if (!r.ok) throw new Error(r.error || '接口出错');
        spots = r.spots || [];
        renderList();
        drawMarkers();
      } catch (e) {
        list.innerHTML = `<div class="np-empty">算不出来：${String(e.message).slice(0, 80)}</div>`;
      }
    }

    function renderList() {
      const list = $('#np-list');
      list.innerHTML = '';
      if (!spots.length) {
        list.innerHTML = '<div class="np-empty">附近没有收录的景点。</div>';
        return;
      }
      for (const s of spots) {
        const row = document.createElement('button');
        row.className = `npitem${target && target.name === s.name ? ' active' : ''}`;
        row.type = 'button';
        row.innerHTML = `
          <span class="npitem-name">${s.name}</span>
          <span class="npitem-city">${s.city}</span>
          <span class="npitem-dist">${s.distance}</span>
          <span class="npitem-dir">${s.compass}</span>
        `;
        row.addEventListener('click', () => selectTarget(s));
        list.appendChild(row);
      }
    }

    function selectTarget(s) {
      target = s;
      renderList();
      drawMarkers();
      const card = $('#np-navcard');
      card.hidden = false;
      $('#np-target').textContent = `${s.name}　·　${s.city}`;

      // 方位角 → 屏幕上的箭头。屏幕上方是北，所以旋转角就是方位角本身。
      const arrow = $('#np-arrow');
      const rel = me ? bearingDeg(me, { lat: s.lat, lng: s.lng }) : s.bearing;
      arrow.style.transform = `rotate(${rel}deg)`;

      const walk = walkMinutes(s.meters);
      $('#np-meta').innerHTML =
        `${s.distance}　·　在正${s.compass}方向 <span class="npdeg">${s.bearing}°</span>`
        + `<br>步行约 <b>${walk}</b> 分钟（按 1.2 米/秒估，含等灯与观景停留）`
        + `<br><span class="npwarn">直线距离，不是步行路程。真正的怎么走请用下面的地图：</span>`;

      const links = $('#np-links');
      links.innerHTML = '';
      for (const l of mapLinks(s, me)) {
        const a = document.createElement('a');
        a.className = 'npbtn';
        a.href = l.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = `🧭 ${l.label}`;
        links.appendChild(a);
      }

      // 地图上把目标移到视野里
      if (me) {
        const mid = { lat: (me.lat + s.lat) / 2, lng: (me.lng + s.lng) / 2 };
        map.setCenter(mid.lat, mid.lng, s.meters > 8000 ? 12 : 14);
      }
    }

    function drawMarkers() {
      if (!map) return;
      const list = [];
      if (me) list.push({ kind: 'me', lat: me.lat, lng: me.lng, name: '我' });
      for (const s of spots) {
        list.push({
          kind: 'spot', lat: s.lat, lng: s.lng, name: s.name,
          active: Boolean(target && target.name === s.name),
        });
      }
      map.setMarkers(list);
    }

    function show() {
      if (!root) build();
      root.hidden = false;
      document.body.classList.add('navpage-open');
      // 显示之后再量尺寸，否则 canvas 拿到的是隐藏时的 0
      requestAnimationFrame(() => {
        map.render();
        drawMarkers();
      });
      if (!me) status('还没定位。点「📍 定位我」，或从下面选一个位置。');
    }
    function hide() {
      if (!root) return;
      root.hidden = true;
      document.body.classList.remove('navpage-open');
    }

    return {
      show, hide,
      toggle: () => (root && !root.hidden ? hide() : show()),
      isOpen: () => Boolean(root && !root.hidden),
      /** 舞台小卡片用：已知位置时给出到某个景点的距离/方位；没定位就返回 null */
      infoForSpot(name) {
        if (!me || !name) return null;
        const hit = spots.find((s) => s.name === name)
          || (() => {
            // 还没算过（用户没打开过导航页）→ 用内置坐标现算一次
            return null;
          })();
        if (!hit) return null;
        return {
          distance: hit.distance, compass: hit.compass,
          bearing: hit.bearing, meters: hit.meters,
          walk: walkMinutes(hit.meters),
        };
      },
      hasLocation: () => Boolean(me),
      // 测试用
      _setMe: setMe,
      _state: () => ({ me, meSource, target, spotCount: spots.length }),
    };
  }

  window.WenlvNav = { createNavPage, distanceMeters, bearingDeg, compassLabel, formatDistance, walkMinutes };
})();
