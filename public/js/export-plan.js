/* ============================================================================
 * export-plan.js —— 方案导出：套模板 + 排版
 *
 * 原来导出就是 `download('文旅方案.md', S.lastResult)` —— 把 Markdown 原样甩出去，
 * 用户拿到的是一坨带 ## 和 | 管道的纯文本，交作业/打印都得自己再排一遍。
 *
 * 现在两件事：
 *   1. **内置一套排版模板**：导出自包含的 HTML（封面抬头 + 正文 + 页脚），
 *      双击能看、Ctrl+P 能直接存 PDF。样式全部内联，文件拷到别的机器也不掉图。
 *   2. **用户能上传自己的模板**：一个带占位符的 HTML 文件，
 *      占位符（{{title}} / {{body}} / {{date}} …）会被替换掉。
 *      模板存在浏览器本地（localStorage），不上传服务器。
 * ==========================================================================*/

(function () {
  'use strict';

  var TPL_KEY = 'wenlv.exportTpl';
  var NAME_KEY = 'wenlv.exportTplName';

  /* ------------------------------------------------------------------ 占位符 */

  /** 模板里可用的占位符（面板上要列给用户看） */
  var VARS = [
    ['{{title}}', '方案标题'],
    ['{{body}}', '正文（方案 Markdown 渲染成的 HTML）'],
    ['{{date}}', '导出日期 2026-09-20'],
    ['{{time}}', '导出时间 12:34'],
    ['{{who}}', '向导名字（小文）'],
    ['{{city}}', '城市'],
    ['{{days}}', '天数'],
    ['{{markdown}}', '正文的原始 Markdown'],
  ];

  /* -------------------------------------------------------------- 内置模板 */

  var DEFAULT_TPL = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<title>{{title}}</title>',
    '<style>',
    '  :root{--ink:#1b2430;--dim:#5b6b7c;--line:#e2e8f0;--accent:#0e7c86;--bg:#f7fafc}',
    '  *{box-sizing:border-box}',
    '  body{margin:0;background:var(--bg);color:var(--ink);',
    '       font:15px/1.75 "Microsoft YaHei","PingFang SC",system-ui,sans-serif}',
    '  .sheet{max-width:820px;margin:32px auto;background:#fff;border-radius:14px;',
    '         box-shadow:0 10px 40px rgba(16,32,48,.10);overflow:hidden}',
    '  .cover{padding:38px 46px 30px;border-bottom:3px solid var(--accent);',
    '         background:linear-gradient(135deg,#0e7c86 0%,#12606d 100%);color:#fff}',
    '  .cover .kicker{font-size:12px;letter-spacing:.22em;opacity:.82;margin-bottom:10px}',
    '  .cover h1{margin:0;font-size:29px;letter-spacing:.02em;font-weight:700}',
    '  .cover .meta{margin-top:14px;font-size:12.5px;opacity:.9;display:flex;gap:18px;flex-wrap:wrap}',
    '  main{padding:34px 46px 42px}',
    '  main h1{font-size:22px;margin:26px 0 12px;padding-left:12px;border-left:4px solid var(--accent)}',
    '  main h2{font-size:18px;margin:26px 0 10px;color:var(--accent);',
    '          border-bottom:1px solid var(--line);padding-bottom:6px}',
    '  main h3{font-size:15.5px;margin:20px 0 8px}',
    '  main p{margin:8px 0}',
    '  main ul,main ol{margin:8px 0;padding-left:22px}',
    '  main li{margin:4px 0}',
    '  main code{background:#eef2f6;padding:1px 5px;border-radius:4px;font-size:13px}',
    '  main table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13.5px}',
    '  main th{background:#eef6f7;text-align:left;font-weight:600}',
    '  main th,main td{border:1px solid var(--line);padding:8px 11px;vertical-align:top}',
    '  main tr:nth-child(even) td{background:#fafcfd}',
    '  main blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid var(--accent);',
    '                  background:#f4f8f9;color:var(--dim)}',
    '  footer{padding:16px 46px 26px;border-top:1px solid var(--line);',
    '         color:var(--dim);font-size:12px;display:flex;justify-content:space-between}',
    '  @media print{body{background:#fff}.sheet{box-shadow:none;margin:0;border-radius:0}',
    '               .cover{background:#0e7c86 !important;-webkit-print-color-adjust:exact}}',
    '</style></head><body>',
    '<div class="sheet">',
    '  <header class="cover">',
    '    <div class="kicker">HIKITRAVEL · 智能文旅辅助系统</div>',
    '    <h1>{{title}}</h1>',
    '    <div class="meta"><span>📅 {{date}} {{time}}</span><span>🧭 {{who}} 生成</span>',
    '      {{extra_meta}}</div>',
    '  </header>',
    '  <main>{{body}}</main>',
    '  <footer><span>本方案由本机大模型生成，行程与价格请以现场为准</span>',
    '          <span>{{date}}</span></footer>',
    '</div></body></html>',
  ].join('\n');

  /* ------------------------------------------------------------------ 工具 */

  function readTpl() {
    try { return localStorage.getItem(TPL_KEY) || ''; } catch (e) { return ''; }
  }
  function readName() {
    try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
  }

  function setTemplate(text, name) {
    try {
      localStorage.setItem(TPL_KEY, String(text || ''));
      localStorage.setItem(NAME_KEY, String(name || '自定义模板'));
    } catch (e) { /* 隐私模式写不了，忽略 */ }
  }
  function clearTemplate() {
    try { localStorage.removeItem(TPL_KEY); localStorage.removeItem(NAME_KEY); } catch (e) { /* 忽略 */ }
  }

  /**
   * 把方案 Markdown 渲染成 HTML。
   *
   * ★ 两个来源都要试：util.js 里 renderMarkdown 是普通函数声明（挂在 window 上），
   *   同时 line 217 又把它挂进了 `window.U`。只认 `window.renderMarkdown` 的话，
   *   一旦 util.js 改成模块、或者加载顺序变了，就会**静默退到下面的朴素兜底**——
   *   导出的文件里 `#` 和 `|` 原样躺着，看着像"排版没生效"。第一版就栽在这。
   */
  function md2html(md) {
    var fns = [
      (typeof window.renderMarkdown === 'function') ? window.renderMarkdown : null,
      (window.U && typeof window.U.renderMarkdown === 'function') ? window.U.renderMarkdown : null,
    ];
    for (var i = 0; i < fns.length; i++) {
      if (!fns[i]) continue;
      try {
        var out = fns[i](md);
        if (out && /<(h1|h2|h3|table|ul|ol|p)[\s>]/i.test(out)) return out;
      } catch (e) { /* 试下一个 */ }
    }
    // 兜底：极简转义 + 段落，保证导出永远不崩（但排版就是朴素的）
    var esc = String(md == null ? '' : md)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc.split(/\n{2,}/).map(function (p) { return '<p>' + p.replace(/\n/g, '<br>') + '</p>'; }).join('');
  }

  var esc2 = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  /** 从方案正文里猜标题 / 城市 / 天数 —— 猜不到就用兜底值，不报错 */
  function guess(md) {
    var title = '文旅行程方案';
    var city = '', days = '';
    var m = String(md || '').match(/^#{1,3}\s*(.+)$/m);
    if (m) title = m[1].trim().replace(/[#*`]/g, '');
    var c = String(md || '').match(/([\u4e00-\u9fa5]{2,6})\s*[·・]?\s*(\d+)\s*天/);
    if (c) { city = c[1]; days = c[2]; }
    return { title: title, city: city, days: days };
  }

  /**
   * 生成完整 HTML 文档。
   * @param {string} md    方案 Markdown
   * @param {Object} [opt] { title, who, city, days }
   */
  function buildDoc(md, opt) {
    opt = opt || {};
    var g = guess(md);
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    var time = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var who = opt.who || (window.S && window.S.card && window.S.card.name) || '小文';
    var city = opt.city || g.city;
    var days = opt.days || g.days;

    var extra = [];
    if (city) extra.push('<span>📍 ' + esc2(city) + '</span>');
    if (days) extra.push('<span>🗓 ' + esc2(days) + ' 天</span>');

    var tpl = readTpl() || DEFAULT_TPL;
    var map = {
      '{{title}}': esc2(opt.title || g.title),
      '{{body}}': md2html(md),
      '{{markdown}}': esc2(md),
      '{{date}}': date,
      '{{time}}': time,
      '{{who}}': esc2(who),
      '{{city}}': esc2(city),
      '{{days}}': esc2(days),
      '{{extra_meta}}': extra.join(''),
    };
    var out = tpl;
    Object.keys(map).forEach(function (k) {
      out = out.split(k).join(map[k]);   // 用 split/join 而不是正则，避免 $ 被当成替换模式
    });
    return { html: out, title: opt.title || g.title, date: date, city: city, days: days };
  }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /** 导出自包含 HTML（默认，最好看：双击能看、Ctrl+P 存 PDF） */
  function exportHtml(md, opt) {
    var r = buildDoc(md, opt);
    var safe = r.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '文旅方案';
    download(safe + '_' + r.date + '.html', r.html, 'text/html');
    return r;
  }

  /** 导出带抬头/页脚的 Markdown（要交纯文本稿时用） */
  function exportMarkdown(md, opt) {
    var r = buildDoc(md, opt);
    var head = [
      '---',
      'title: ' + r.title,
      'date: ' + r.date,
      'generator: 智能文旅辅助系统',
      '---', '',
    ].join('\n');
    var foot = '\n\n---\n\n> 本方案由本机大模型生成，行程与价格请以现场为准。\n';
    var safe = r.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '文旅方案';
    download(safe + '_' + r.date + '.md', head + String(md || '') + foot, 'text/markdown');
    return r;
  }

  /** 上传的模板预览：把占位符换成示例值，让用户先看一眼 */
  function preview() {
    return buildDoc('# 示例方案\n\n## Day 1\n\n- 断桥残雪\n- 平湖秋月\n', { title: '示例方案' }).html;
  }

  window.WenlvExport = {
    VARIANTS: VARS,
    DEFAULT_TPL: DEFAULT_TPL,
    exportHtml: exportHtml,
    exportMarkdown: exportMarkdown,
    setTemplate: setTemplate,
    clearTemplate: clearTemplate,
    templateName: readName,
    hasTemplate: function () { return !!readTpl(); },
    preview: preview,
    buildDoc: buildDoc,
  };
})();
