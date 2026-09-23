/* ============================================================================
 * sw.js —— 手机端 Service Worker（PWA）
 *
 * 目标（按三端方案 §7.3）：手机浏览器"添加到主屏幕"后能全屏、有图标起得来；
 * 断网时至少外壳还在，配合已有的重连横幅给出明确提示。
 *
 * ★ 只缓存**外壳静态文件**，`/api` 一律不碰。
 *   理由：这个项目的所有数据（方案、角色卡、记忆、TTS、天气、POI）
 *   都来自本机后端，缓存它们只会让用户看到过期数据 —— 而且后端的
 *   sqlite / 内存状态本来就没法在 SW 里复现。宁可让请求直接失败、
 *   由 wenlv-net.js 的断线重连横幅如实告诉用户"连不上电脑"。
 *
 * 更新策略：外壳用「网络优先、失败回退缓存」。
 *   为什么不是 cache-first：这台机器上的开发迭代很频繁，
 *   cache-first 会让用户一直看到旧界面、还以为是没生效。
 *   网络优先在局域网里几乎瞬间返回，代价可以忽略。
 * ==========================================================================*/
'use strict';

const CACHE = 'wenlv-shell-v1';

//: 只放"离线时也得能起页"的最小集合。别把大文件塞进来。
const SHELL = [
  '/m/',
  '/m/mobile.css',
  '/m/mobile.js',
  '/js/util.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 逐个 add：任何一个失败都不要让整次安装挂掉（离线装不上也得能注册）
    await Promise.all(SHELL.map(async (u) => {
      try { await c.add(new Request(u, { cache: 'reload' })); } catch { /* 忽略单个失败 */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 清掉旧版本缓存
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 只处理同源；跨域（高德跳转等）直接放行
  if (url.origin !== self.location.origin) return;

  // ★ /api 一律不缓存：数据都来自本机后端，缓存只会给出过期结果
  if (url.pathname.startsWith('/api/')) return;

  // 语音/音频字节流也不缓存（大、且没必要）
  if (/\.(mp4|webm|mov|mp3|wav|ogg)$/i.test(url.pathname)) return;

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      // 只缓存成功的、同源的基本响应
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const c = await caches.open(CACHE);
        c.put(req, fresh.clone()).catch(() => { });
      }
      return fresh;
    } catch (err) {
      // 网络挂了 → 回退缓存；再没有就给出一个最小的离线页
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('/m/', { ignoreSearch: true });
        if (shell) return shell;
        return new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
          + '<title>离线</title>'
          + '<body style="margin:0;background:#0f1419;color:#e9eef6;font:15px/1.8 -apple-system,\'Microsoft YaHei\',sans-serif;'
          + 'display:grid;place-items:center;height:100vh;text-align:center">'
          + '<div><div style="font-size:34px;margin-bottom:10px">📡</div>'
          + '<div style="font-weight:600;margin-bottom:6px">连不上电脑上的服务</div>'
          + '<div style="font-size:13px;color:#8fa3ba">请确认电脑上的「启动手机版.bat」还在运行，<br>并且手机和电脑连的是同一个 WiFi。</div>'
          + '</div></body>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }
      return new Response('', { status: 504, statusText: 'offline' });
    }
  })());
});
