/* ============================================================================
 * util.js —— 通用工具（DOM / Markdown / SSE / Toast）
 * 零依赖，纯浏览器原生 API。
 * ==========================================================================*/
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
        else node.setAttribute(k, v);
      }
    }
    for (const c of [].concat(children || [])) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* ---------- Toast ---------- */
  function toast(msg, kind, ms) {
    const wrap = $('#toasts');
    if (!wrap) return;
    const node = el('div', { class: `toast ${kind || ''}`, text: String(msg) });
    wrap.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .3s, transform .3s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(10px)';
      setTimeout(() => node.remove(), 320);
    }, ms || 2800);
  }

  /* ---------- 极简 Markdown → HTML（先转义，再解析，杜绝 XSS） ---------- */
  function renderInline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }

  function renderMarkdown(src) {
    const lines = escapeHtml(src).split('\n');
    const out = [];
    let i = 0;
    let listOpen = false;

    const closeList = () => { if (listOpen) { out.push('</ul>'); listOpen = false; } };

    while (i < lines.length) {
      const line = lines[i];
      const t = line.trim();

      // 表格：表头 | --- | 数据行
      if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
        closeList();
        const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const head = cells(t);
        out.push('<table class="md-table"><thead><tr>' + head.map(c => `<th>${renderInline(c)}</th>`).join('') + '</tr></thead><tbody>');
        i += 2;
        while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
          const row = cells(lines[i]);
          out.push('<tr>' + head.map((_, k) => `<td>${renderInline(row[k] || '')}</td>`).join('') + '</tr>');
          i++;
        }
        out.push('</tbody></table>');
        continue;
      }

      const h = t.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeList();
        const lvl = Math.min(h[1].length, 3);
        out.push(`<h${lvl}>${renderInline(h[2])}</h${lvl}>`);
        i++; continue;
      }

      if (/^[-*+]\s+/.test(t)) {
        if (!listOpen) { out.push('<ul>'); listOpen = true; }
        out.push(`<li>${renderInline(t.replace(/^[-*+]\s+/, ''))}</li>`);
        i++; continue;
      }

      if (/^&gt;\s?/.test(t)) { closeList(); out.push(`<blockquote>${renderInline(t.replace(/^&gt;\s?/, ''))}</blockquote>`); i++; continue; }
      if (/^[-*_]{3,}$/.test(t)) { closeList(); out.push('<hr>'); i++; continue; }
      if (!t) { closeList(); i++; continue; }

      closeList();
      out.push(`<p>${renderInline(t)}</p>`);
      i++;
    }
    closeList();
    return out.join('\n');
  }

  /* ---------- JSON API ---------- */
  /**
   * 请求后端。失败时向全局网络监视器报告，由它决定是否进入"重连中"。
   *
   * 为什么要这一句：本项目后端是**本机服务**，它没起来 / 中途重启 / 崩了的时候，
   * 所有请求都会以 "Failed to fetch" 失败。原来是直接抛错，用户只看到
   * "请求失败"这种没用的话，也不知道该等还是该做什么。现在上报给
   * WenlvNet 后，页面上会出现「连接已断开，正在重连…」并持续重试。
   */
  async function api(path, { method = 'GET', body, timeout = 600000 } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      // 网络层失败（后端没起来/断网）：交给监视器重连
      if (window.WenlvNet) window.WenlvNet.reportFailure(e);
      throw e;
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: false, error: text.slice(0, 400) }; }
    if (!res.ok || data.ok === false) {
      const err = new Error(data.error || `请求失败（HTTP ${res.status}）`);
      err.code = data.code || `HTTP_${res.status}`;
      err.status = res.status;
      // 5xx / 502 / 503 这类也算"后端不可用"，同样进入重连
      if (window.WenlvNet) window.WenlvNet.reportFailure(err);
      throw err;
    }
    if (window.WenlvNet) window.WenlvNet.reportSuccess();
    return data;
  }

  /**
   * POST + SSE。逐事件回调 onEvent(obj)。
   * 返回 { promise, abort() }，promise 在流结束时 resolve。
   */
  function sse(path, body, onEvent, { signal } = {}) {
    const ctrl = new AbortController();
    if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });

    const promise = (async () => {
      let res;
      try {
        res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
          signal: ctrl.signal,
        });
      } catch (e) {
        // 用户主动 abort 不算断网；其余网络失败交给监视器
        if (!(e && e.name === 'AbortError') && window.WenlvNet) window.WenlvNet.reportFailure(e);
        throw e;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let d = {};
        try { d = JSON.parse(text); } catch { /* 非 JSON 错误体 */ }
        const err = new Error(d.error || `请求失败（HTTP ${res.status}）`);
        err.code = d.code || `HTTP_${res.status}`;
        err.status = res.status;
        if (window.WenlvNet) window.WenlvNet.reportFailure(err);
        throw err;
      }
      if (window.WenlvNet) window.WenlvNet.reportSuccess();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          const line = part.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          try { onEvent(JSON.parse(payload)); } catch { /* 跳过坏事件 */ }
        }
      }
    })();

    return { promise, abort: () => ctrl.abort() };
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: (mime || 'text/markdown') + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  const fmtTime = (ts) => {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const debounce = (fn, ms) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  /** 把 base64 图片缩到最长边 max 像素，避免 12MB 上限被手机原图顶爆 */
  function downscaleImage(dataUrl, max = 1280, quality = 0.85) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        if (scale === 1 && dataUrl.length < 2.2e6) return resolve(dataUrl);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  window.U = { $, $$, el, escapeHtml, toast, renderMarkdown, api, sse, download, fmtTime, debounce, downscaleImage };
})();
