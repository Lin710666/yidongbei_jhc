/**
 * gen-previews-cdp.js —— 用 Edge 无头给每个 Live2D 形象生成预览图（零依赖）
 *
 * 运行：先 npm start，然后 node test/gen-previews-cdp.js
 *
 * 为什么要自己写一个：项目里原本的 `test/generate-model-previews.mjs` 依赖
 * Playwright（本项目零依赖，装不上就只能跳过）。这个脚本走系统自带 Edge 的
 * 调试端口 + Node 内置 WebSocket，**不需要装任何东西**，和 test/verify-cdp.js 同一路子。
 *
 * 预览图有两个用处：
 *   · 「外观 → 更换形象」的选择器会显示它（原来所有卡片都是一枚 🧍 图标）
 *   · 选形象之前能先看一眼长什么样，不用逐个切过去试
 *
 * 产物：public/models/<id>/preview.png（与 app.js 里找预览图的约定一致）
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
const BASE = process.argv[2] || 'http://127.0.0.1:8000';

/** 要生成预览的形象 id（和 public/models 下的目录名一致） */
const ONLY = process.argv.slice(3).filter(a => !a.startsWith('-'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getJson(p) {
  return new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${PORT}${p}`, r => {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

(async () => {
  // 先问服务要形象清单（走运行时路径，不是数目录）
  const status = await new Promise((res, rej) => {
    http.get(`${BASE}/api/status`, r => {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  }).catch(e => { console.error('取不到 /api/status：', e.message, '\n请先 npm start'); process.exit(1); });

  let models = (status.live2d || []).map(m => ({ id: m.id, label: m.label }));
  if (ONLY.length) models = models.filter(m => ONLY.includes(m.id));
  if (!models.length) { console.log('没有要处理的形象'); return; }
  console.log(`准备为 ${models.length} 个形象生成预览图\n`);

  const userDir = path.join(os.tmpdir(), 'wenlv-preview-cdp');
  const proc = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--no-first-run', '--no-default-browser-check',
    '--use-angle=swiftshader',          // 无头下要软渲染，否则 WebGL 起不来
    '--window-size=1400,900', `--user-data-dir=${userDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const list = await getJson('/json/list');
      target = (list || []).find(t => t.type === 'page');
      if (target) break;
    } catch { /* 还没起来 */ }
  }
  if (!target) { console.error('连不上 Edge 调试端口'); proc.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  const send = (method, params) => new Promise(res => {
    const myId = ++id; pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: BASE });
  await sleep(6000);

  // 关掉开屏，免得截图里全是开屏
  await evaluate(`(()=>{const b=document.getElementById('boot-screen'); if(b) b.hidden=true; return true;})()`);
  // 关掉词云，别挡住人物
  await evaluate(`(()=>{const w=document.getElementById('wordcloud-layer'); if(w) w.style.display='none'; return true;})()`);
  await sleep(600);

  let ok = 0;
  for (const m of models) {
    process.stdout.write(`  ${m.id.padEnd(12)} `);
    try {
      await evaluate(`window.__wenlv.switchDisplay('live2d', ${JSON.stringify(m.id)})`);
      await sleep(3600);      // 等模型加载 + 站稳
      const box = await evaluate(`(()=>{
        const s=document.querySelector('.stage');
        const r=s.getBoundingClientRect();
        return { x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height) };
      })()`);
      if (!box || !box.w) { console.log('✗ 取不到舞台尺寸'); continue; }
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 },
      });
      const data = shot.result && shot.result.data;
      if (!data) { console.log('✗ 截图失败'); continue; }
      const out = path.join(ROOT, 'public', 'models', m.id, 'preview.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(data, 'base64'));
      console.log(`✓ ${Math.round(Buffer.from(data, 'base64').length / 1024)}KB`);
      ok++;
    } catch (e) {
      console.log('✗', e.message);
    }
  }

  console.log(`\n完成：${ok}/${models.length} 张预览图已写入 public/models/<id>/preview.png`);
  try { ws.close(); } catch { /* 忽略 */ }
  try { proc.kill(); } catch { /* 忽略 */ }
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('脚本出错：', e); process.exit(1); });
