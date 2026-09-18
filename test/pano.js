#!/usr/bin/env node
/**
 * 全景获取与校验测试
 *
 * 运行：node test/pano.js      （或 npm run test:pano）
 *
 * 重点测**手写的那部分**：图片头解析与等值柱状判定。
 * 这两件事决定"这张图能不能当环境球"，判错的表现是"贴上去整个变形"，
 * 而用户只会觉得程序坏了 —— 所以必须钉死。
 *
 * 用**构造出来的字节**测，不依赖网络、不依赖任何真实图片文件。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const pano = require('../lib/pano');

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${extra !== undefined ? `  → ${extra}` : ''}`); }
}

/* ---------- 构造最小可解析的图片头 ---------- */

function pngBytes(w, h) {
  const b = Buffer.alloc(26);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);                       // IHDR 长度
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function jpegBytes(w, h) {
  // SOI + APP0(最小) + SOF0 + 填充
  const sof = Buffer.alloc(11);
  sof[0] = 0xff; sof[1] = 0xc0;
  sof.writeUInt16BE(8, 2);                      // 段长
  sof[4] = 8;                                   // 精度
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(8)]);
}

function gifBytes(w, h) {
  const b = Buffer.alloc(16);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

function webpVp8xBytes(w, h) {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(24, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  // 24 位小端存 (宽-1)、(高-1)
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

async function main() {
  console.log('全景获取与校验测试\n');

  console.log('A. 图片头解析（手写的部分）');
  const p = pano.parseImageSize(pngBytes(4096, 2048));
  check('PNG 尺寸', p && p.width === 4096 && p.height === 2048 && p.format === 'png', JSON.stringify(p));

  const j = pano.parseImageSize(jpegBytes(2048, 1024));
  check('JPEG 尺寸', j && j.width === 2048 && j.height === 1024 && j.format === 'jpeg', JSON.stringify(j));

  const g = pano.parseImageSize(gifBytes(1200, 600));
  check('GIF 尺寸', g && g.width === 1200 && g.height === 600 && g.format === 'gif', JSON.stringify(g));

  const w = pano.parseImageSize(webpVp8xBytes(2048, 1024));
  check('WebP(VP8X) 尺寸', w && w.width === 2048 && w.height === 1024 && w.format === 'webp', JSON.stringify(w));

  check('空数据返回 null', pano.parseImageSize(Buffer.alloc(0)) === null);
  check('随机数据返回 null', pano.parseImageSize(Buffer.from('这不是图片，只是一段文字而已')) === null);
  check('截断的 PNG 返回 null', pano.parseImageSize(pngBytes(100, 100).slice(0, 12)) === null);

  console.log('\nB. 等距柱状判定（决定"能不能当环境球"）');
  check('标准 2:1 通过', pano.isEquirectangular({ width: 4096, height: 2048 }).ok === true);
  check('4096×2048 的比例约为 2', Math.abs(pano.isEquirectangular({ width: 4096, height: 2048 }).ratio - 2) < 1e-9);
  // 边界：容差是 1.9~2.12
  check('1.95:1 通过（略窄但可接受）', pano.isEquirectangular({ width: 1950, height: 1000 }).ok === true);
  check('2.08:1 通过（略宽但可接受）', pano.isEquirectangular({ width: 2080, height: 1000 }).ok === true);
  check('1.78:1 被拒（16:9 普通照片）', pano.isEquirectangular({ width: 1920, height: 1080 }).ok === false,
    pano.isEquirectangular({ width: 1920, height: 1080 }).reason);
  check('1.5:1 被拒（相机竖幅 3:2）', pano.isEquirectangular({ width: 3000, height: 2000 }).ok === false);
  check('2.5:1 被拒（宽幅裁切）', pano.isEquirectangular({ width: 2500, height: 1000 }).ok === false);
  check('分辨率过低被拒（贴上会糊）', pano.isEquirectangular({ width: 800, height: 400 }).ok === false,
    pano.isEquirectangular({ width: 800, height: 400 }).reason);
  check('尺寸缺失被拒', pano.isEquirectangular(null).ok === false);
  check('被拒时给出可读原因', typeof pano.isEquirectangular({ width: 1920, height: 1080 }).reason === 'string');

  console.log('\nC. 图片搜索结果解析');
  // Bing 当前版本把 murl 放在 HTML 转义的 JSON 里；旧版本是裸 JSON。两种都要认。
  const bingHtml = `
    <a class="iusc" m="{&quot;cid&quot;:&quot;x&quot;,&quot;murl&quot;:&quot;https://cdn.example.com/a.jpg&quot;,&quot;purl&quot;:&quot;https://p.example.com&quot;}"></a>
    <div murl&quot;:&quot;https://cdn.example.com/b.jpg&quot;></div>
    <script>"murl":"https://cdn.example.com/c.png"</script>
    <span>"murl":"https://cdn.example.com/a.jpg"</span>
    <span>"murl":"not-a-url"</span>
  `;
  const bing = pano.parseBingImages(bingHtml);
  check('解析出 3 个直链（去重 + 过滤非法）', bing.length === 3, JSON.stringify(bing));
  check('认 HTML 转义的 murl（当前版本）', bing.includes('https://cdn.example.com/b.jpg'));
  check('认 iusc 元素里的 JSON', bing.includes('https://cdn.example.com/a.jpg'));
  check('认裸 JSON 形态（旧版本）', bing.includes('https://cdn.example.com/c.png'));
  check('重复 URL 被去掉', bing.filter(u => u === 'https://cdn.example.com/a.jpg').length === 1);

  const baidu = pano.parseBaiduImages({
    data: [
      { middleURL: 'https://img0.baidu.com/it/u=1', thumbURL: 'https://img0.baidu.com/it/u=1&w=500' },
      { thumbURL: 'https://img1.baidu.com/it/u=2' },
      { middleURL: '' },
      null,
      { hoverURL: 'https://img2.baidu.com/it/u=3' },
    ],
  });
  check('百度：取 middleURL/thumbURL/hoverURL', baidu.length === 3, JSON.stringify(baidu));
  check('百度：优先用 middleURL', baidu.includes('https://img0.baidu.com/it/u=1'));
  check('百度：空值与非对象被跳过', !baidu.some(u => !u));

  console.log('\nD. 站点识别');
  check('认得 720 云', pano.hostInfo('https://www.720yun.com/x').label === '720云');
  check('认得维基共享资源直链', pano.hostInfo('https://upload.wikimedia.org/x.jpg').direct === true);
  check('未知站点回落到域名', pano.hostInfo('https://foo.example.com/a.jpg').host === 'foo.example.com');
  check('非法 URL 不抛异常', pano.hostInfo('不是网址').host === '');
  check('直链图片识别', pano.looksLikeImage('https://x/a.jpg?w=100') === true && pano.looksLikeImage('https://x/a') === false);

  console.log('\nE. 缓存与下载（用假 fetch，不联网）');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-pano-'));
  try {
    // 假 fetch：按 URL 返回不同内容，验证"不合格的不会被写进缓存"
    const fakeFetch = async (url) => {
      if (url.includes('good')) {
        return { url, status: 200, contentType: 'image/png', body: pngBytes(2048, 1024) };
      }
      if (url.includes('notimage')) {
        return { url, status: 200, contentType: 'text/html', body: Buffer.from('<html>') };
      }
      if (url.includes('wrongratio')) {
        return { url, status: 200, contentType: 'image/jpeg', body: jpegBytes(1920, 1080) };
      }
      return { url, status: 404, contentType: '', body: Buffer.alloc(0) };
    };

    const store = pano.createPano({ dir, fetchRaw: fakeFetch });

    const okRes = await store.fetchOne('https://x/good.png');
    check('合格图片被接受', okRes.ok === true, JSON.stringify(okRes));
    check('记录了尺寸与比例', okRes.ok && okRes.record.width === 2048 && okRes.record.ratio === 2);
    check('写进了索引', store.list().length === 1);

    const bad1 = await store.fetchOne('https://x/notimage');
    check('非图片被拒且不写缓存', bad1.ok === false && store.list().length === 1, bad1.reason);
    check('非图片的拒绝原因提到 Content-Type', /Content-Type/.test(bad1.reason), bad1.reason);

    const bad2 = await store.fetchOne('https://x/wrongratio.jpg');
    check('比例不对被拒且不写缓存', bad2.ok === false && store.list().length === 1);
    check('比例不对的原因里带实际比例', /1\.78/.test(bad2.reason), bad2.reason);

    const bad3 = await store.fetchOne('https://x/missing');
    check('HTTP 非 200 被拒', bad3.ok === false && /404/.test(bad3.reason));

    // 取图与删除
    const img = store.readImage(okRes.record.id);
    check('能读回图片字节', img && img.buffer.length > 0 && img.mime === 'image/png');
    check('删除后索引与文件都没了', store.remove(okRes.record.id) === true && store.list().length === 0);
    check('删不存在的返回 false', store.remove('nope') === false);
    check('读不存在的返回 null', store.readImage('nope') === null);

    // 索引损坏要能自愈
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-pano2-'));
    fs.mkdirSync(path.join(dir2, 'panoramas'), { recursive: true });
    fs.writeFileSync(path.join(dir2, 'panoramas', 'index.json'), '{坏掉的 json', 'utf8');
    const store2 = pano.createPano({ dir: dir2, fetchRaw: fakeFetch });
    check('索引损坏时回退为空而不是崩掉', store2.list().length === 0);
    check('损坏的索引被备份', fs.existsSync(path.join(dir2, 'panoramas', 'index.json.corrupt')));
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('测试自身出错：', e);
  process.exitCode = 1;
});
