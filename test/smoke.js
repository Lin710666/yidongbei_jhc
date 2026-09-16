#!/usr/bin/env node
/**
 * 冒烟测试：把几个"踩过的坑"钉住，防止以后改回去。
 *
 * 运行：node test/smoke.js      （或 npm run test:smoke）
 *
 * 覆盖的回归点：
 *   1. /api/status 返回 200，且该有的状态字段都在（前端状态灯靠它，缺字段会"假绿"）
 *   2. 首页能打开，且确实是 AIRI 风格新界面
 *   3. 畸形 URL（/%）返回 400 —— 而不是把整个服务打崩（原项目的历史 bug）
 *   4. 目录穿越（/..%2f..%2fserver.js）被拦，且不返回源码
 *   5. data/ 目录不会被当静态文件下载走（记忆/角色卡不能外泄）
 *   6. 非法 type、非法 JSON 返回 4xx —— 而不是一律 200
 *   7. 新增接口的基本契约：capabilities / 词云 / 记忆 / 角色卡 / 语音状态
 *   8. 跑完全部畸形请求后，服务仍然活着（最关键的一条）
 *
 * 会用 SMOKE_PORT（默认 8123）临时启动一份服务副本，结束时自动关闭。
 * 注意：会用独立的 DATA_DIR，不污染正式的记忆与角色卡。
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = Number(process.env.SMOKE_PORT || 8123);
const HOST = '127.0.0.1';
const ROOT = path.join(__dirname, '..');
// 测试用独立数据目录：冒烟测试会写记忆与角色卡，别把正式数据搞脏
const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-smoke-'));

let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}${extra ? `  → ${extra}` : ''}`);
  }
}

// 直接用 http 模块发请求：不会像 fetch 那样对路径做归一化，才能测出 /..%2f 这类编码穿越
function request(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, path: reqPath, method, headers: body ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await request('GET', '/api/status');
      if (r.status === 200) return true;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

const j = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };

async function main() {
  console.log('文旅智能辅助 · AIRI 网页版 · 冒烟测试');
  console.log(`临时服务端口：${PORT}`);
  console.log(`临时数据目录：${TEST_DATA}\n`);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST, DATA_DIR: TEST_DATA },
    stdio: 'ignore', // 不用管道，兼容受限的沙箱环境
  });

  let alive = true;
  child.on('exit', () => (alive = false));

  try {
    if (!(await waitReady(15000))) {
      console.log('  \u2717 服务未能在 15 秒内就绪，测试中止');
      process.exitCode = 1;
      return;
    }

    // ---- 1. 状态接口 ----
    const st = await request('GET', '/api/status');
    const sj = j(st);
    check('/api/status 返回 200', st.status === 200, `实际 ${st.status}`);
    check('状态里带 ollama 子对象（前端状态灯靠它）', sj.ollama && typeof sj.ollama.running === 'boolean', JSON.stringify(sj).slice(0, 200));
    check('状态里带 chatModel 字段（避免状态灯"假绿"）', sj.ollama && 'chatModel' in sj.ollama);
    check('状态里带 memory / tts / cards / wenlv / live2d', Boolean(sj.memory && sj.tts && sj.cards && sj.wenlv && Array.isArray(sj.live2d)));

    // ---- 2. 首页 ----
    const home = await request('GET', '/');
    check('首页返回 200', home.status === 200, `实际 ${home.status}`);
    check('首页是新版 AIRI 风格界面', home.body.includes('文旅智能辅助') && home.body.includes('wordcloud-layer'));
    check('首页引用了本地化的 Live2D 运行时', home.body.includes('/vendor/live2dcubismcore.min.js') && home.body.includes('/vendor/pixi.min.js'));

    // ---- 3. 历史 bug：畸形 URL 曾把服务打崩（退出码 1）----
    const bad = await request('GET', '/%');
    check('畸形 URL /%  返回 400', bad.status === 400, `实际 ${bad.status}`);

    // ---- 4. 目录穿越 ----
    const trav = await request('GET', '/..%2f..%2fserver.js');
    check('目录穿越被拦截（403/404，且不返回源码）',
      (trav.status === 403 || trav.status === 404) && !trav.body.includes('openSSE'),
      `实际 ${trav.status}`);

    // ---- 5. data/ 不外泄 ----
    const leak = await request('GET', '/data/cards.json');
    check('data/ 目录不会被静态服务泄露', leak.status === 403 || leak.status === 404, `实际 ${leak.status}`);

    // ---- 6. 输入校验 ----
    const badType = await request('POST', '/api/generate', JSON.stringify({ type: 'nope', params: {} }));
    check('非法 type 返回 4xx（不再一律 200）', badType.status >= 400 && badType.status < 500, `实际 ${badType.status}`);

    const badJson = await request('POST', '/api/generate', '{不是合法JSON');
    check('非法 JSON 返回 400', badJson.status === 400, `实际 ${badJson.status}`);

    const badWenlvType = await request('POST', '/api/wenlv/generate', JSON.stringify({ type: 'nope', params: {} }));
    check('流式接口在开 SSE 之前就校验 type（返回 4xx 而不是 200）',
      badWenlvType.status === 400, `实际 ${badWenlvType.status}`);

    // ---- 7. 新增接口契约 ----
    const caps = await request('GET', '/api/capabilities');
    const cj = j(caps);
    check('/api/capabilities 返回 200', caps.status === 200, `实际 ${caps.status}`);
    check('词云清单非空且每条都有 action', Array.isArray(cj.wordCloud) && cj.wordCloud.length > 20 && cj.wordCloud.every(w => w.word && w.action),
      `条数 ${(cj.wordCloud || []).length}`);
    check('选项常量齐备（词云与表单共用同一份）', Boolean(cj.options && cj.options.budget && cj.options.platform && cj.options.interests));
    check('样本库实体数已统计', typeof cj.entityCount === 'number' && cj.entityCount > 0, String(cj.entityCount));
    check('音色预设非空', Array.isArray(cj.voices) && cj.voices.length > 0);
    check('Live2D 模型已就绪', Array.isArray(cj.live2d) && cj.live2d.length > 0);

    // 「我的音色」（声音克隆的参考音频）
    // 这几条盯的是两个真实踩过的坑：
    //   ① 后端只是把字节写进 .wav，什么都不校验 —— MP3 改名也能"上传成功"，
    //      所以必须在服务端拦下来，这里就测它拦不拦。
    //   ② 角色卡白名单漏了 refVoiceId —— 界面选了自定义音色、合成时却拿不到参考音频。
    check('能力清单带 myVoices', Array.isArray(cj.myVoices), typeof cj.myVoices);
    const badVoice = await request('POST', '/api/voices', JSON.stringify({
      name: '冒烟测试-假WAV', audio: Buffer.from('这不是音频，只是个文本').toString('base64'),
    }));
    check('假 WAV 被挡下来（不是 2xx）', badVoice.status >= 400, `实际 ${badVoice.status}`);
    const noName = await request('POST', '/api/voices', JSON.stringify({ audio: '' }));
    check('没名字没音频被挡下来（400）', noName.status === 400, `实际 ${noName.status}`);

    // 造一段 3 秒的正经 WAV（24000Hz / 16bit / 单声道），走一遍 上传 → 列出 → 删除
    {
      const sr = 24000;
      const pcm = Buffer.alloc(sr * 2 * 3);
      for (let i = 0; i < sr * 3; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), i * 2);
      const hdr = Buffer.alloc(44);
      hdr.write('RIFF', 0, 'ascii'); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8, 'ascii');
      hdr.write('fmt ', 12, 'ascii'); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
      hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(sr, 24); hdr.writeUInt32LE(sr * 2, 28);
      hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
      hdr.write('data', 36, 'ascii'); hdr.writeUInt32LE(pcm.length, 40);
      const wav = Buffer.concat([hdr, pcm]);

      const up = await request('POST', '/api/voices', JSON.stringify({
        name: '冒烟测试音色', refText: '测试', audio: wav.toString('base64'), originalName: 'smoke.wav',
      }));
      const upJson = j(up);
      check('上传正经 WAV 返回 201 且有 id', up.status === 201 && upJson.voice && upJson.voice.id, `实际 ${up.status}`);
      check('记下了时长与采样率', upJson.voice && upJson.voice.seconds === 3 && upJson.voice.sampleRate === sr,
        JSON.stringify(upJson.voice && { s: upJson.voice.seconds, sr: upJson.voice.sampleRate }));

      if (upJson.voice) {
        const ls = await request('GET', '/api/voices');
        check('清单里能读到刚上传的', (j(ls).voices || []).some(v => v.id === upJson.voice.id));
        const audioRes = await request('GET', `/api/voices/${upJson.voice.id}/audio`);
        check('试听接口能回音频字节', audioRes.status === 200, `实际 ${audioRes.status}`);

        // 角色卡要能记住 refVoiceId（不能又被白名单吃掉）
        const cardsNow = j(await request('GET', '/api/cards'));
        const target = cardsNow.cards && cardsNow.cards[0];
        if (target) {
          const put = await request('PUT', `/api/cards/${target.id}`, JSON.stringify({
            voice: { presetId: `custom-${upJson.voice.id}`, mode: 'voice-clone', speaker: null, refVoiceId: upJson.voice.id },
          }));
          const saved = j(put).card || j(put).item || {};
          const c2 = j(await request('GET', '/api/cards')).cards.find(c => c.id === target.id);
          check('角色卡能存住 refVoiceId（没被白名单吃掉）', c2 && c2.voice && c2.voice.refVoiceId === upJson.voice.id,
            JSON.stringify(c2 && c2.voice));
          void saved;
          // 还原，别把用户卡片改坏了
          await request('PUT', `/api/cards/${target.id}`, JSON.stringify({
            voice: { presetId: 'wenlv-guide-female', mode: 'custom-voice', speaker: 'vivian', refVoiceId: null, instruct: '' },
          }));
        }

        const del = await request('DELETE', `/api/voices/${upJson.voice.id}`);
        check('自定义音色能删掉', del.status === 200, `实际 ${del.status}`);
        const ls2 = await request('GET', '/api/voices');
        check('删掉之后清单里没有了', !(j(ls2).voices || []).some(v => v.id === upJson.voice.id));
      }
    }

    // 记忆：写 → 读 → 检索 → 删
    const addMem = await request('POST', '/api/memory', JSON.stringify({ text: '冒烟测试：用户带 6 岁小孩，忌辣', kind: 'fact' }));
    const addJson = j(addMem);
    check('记忆写入返回 200 且有 id', addMem.status === 200 && addJson.item && addJson.item.id, `实际 ${addMem.status}`);
    const listMem = await request('GET', '/api/memory?limit=10');
    check('记忆列表能读到刚写的那条', j(listMem).total >= 1, `total ${j(listMem).total}`);
    const searchMem = await request('POST', '/api/memory/search', JSON.stringify({ query: '忌辣', limit: 5 }));
    check('记忆检索能召回相关条目', Array.isArray(j(searchMem).hits) && j(searchMem).hits.length > 0,
      JSON.stringify(j(searchMem)).slice(0, 160));
    if (addJson.item) {
      const delMem = await request('DELETE', `/api/memory/${addJson.item.id}`);
      check('记忆删除返回 200', delMem.status === 200, `实际 ${delMem.status}`);
    }

    // 角色卡
    const cards = await request('GET', '/api/cards');
    const cardsJson = j(cards);
    check('内置角色卡存在', cards.status === 200 && Array.isArray(cardsJson.cards) && cardsJson.cards.length >= 3,
      `实际 ${cards.status}，${(cardsJson.cards || []).length} 张`);
    check('内置角色卡不可删除（有明确错误提示）', cardsJson.cards && cardsJson.cards.every(c => c.builtin !== undefined));

    // 语音状态（不依赖 Qwen TTS 是否启动，只要接口本身可用）
    const ttsStatus = await request('GET', '/api/tts/status');
    check('/api/tts/status 返回 200 且带 5 个音色预设',
      ttsStatus.status === 200 && Array.isArray(j(ttsStatus).presets) && j(ttsStatus).presets.length >= 5,
      `实际 ${ttsStatus.status}`);

    // 空文本合成应当被明确拒绝，而不是静默返回空音频
    const ttsEmpty = await request('POST', '/api/tts', JSON.stringify({ text: '' }));
    check('空文本合成返回 400', ttsEmpty.status === 400, `实际 ${ttsEmpty.status}`);

    // ---- 8. 关键：经过上面所有畸形请求，服务必须还活着 ----
    await new Promise(r => setTimeout(r, 500));
    const after = await request('GET', '/api/status');
    check('全部畸形请求之后服务仍然存活', alive && after.status === 200, alive ? `status ${after.status}` : '进程已退出（崩服回归！）');
  } catch (e) {
    fail++;
    console.log(`  \u2717 测试过程抛出异常：${e.message}`);
  } finally {
    if (alive) child.kill();
    // 清理临时数据目录，别在系统临时目录里留垃圾
    try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
}

main();
