/**
 * location.js —— 用户位置（来源、时效与持久化）
 *
 * 位置的来源有三种，**可信度差别很大，必须分开对待**：
 *
 *   browser  浏览器 Geolocation（GPS/WiFi 定位）—— 准，但要用户在弹窗里授权，
 *            而且只在页面开着的时候能拿到新值
 *   manual   用户手填 —— 演示时最省事，也最可控
 *   ip       IP 兜底 —— 不需要授权，但精度只到**城市级**，经常偏差几十公里
 *
 * 所以这里不存一个光秃秃的 {lat,lng}，而是连**来源和时间**一起存：
 *   · 界面上必须能显示"这个位置是怎么来的、多久之前的"，
 *     否则用户会以为 IP 定位的坐标是精确的，据此判断"离景点 3 公里"——完全是错的。
 *   · 位置会过期。半小时前的浏览器定位对"我现在在哪"已经没有意义，
 *     所以读的时候要带上 ageMs 与 fresh 标志，由调用方决定怎么提示。
 *
 * 存储：data/location.json（原子写）。MCP 服务是独立进程，直接读这个文件，
 * 因此**不需要**为了给 MCP 提供位置而让两个进程互相调用。
 */

const fs = require('fs');
const path = require('path');
const geo = require('./geo');

/** 浏览器定位多久算"还新鲜"。超过就提示用户重新取一次。 */
const FRESH_MS = Number(process.env.LOCATION_FRESH_MS || 10 * 60 * 1000);

const DEFAULT = { version: 1, current: null, updatedAt: 0 };

/** IP 定位服务的候选（都不需要 Key）。按顺序试，第一个成功的就用。 */
const IP_PROVIDERS = [
  {
    name: 'ipapi.co',
    url: 'https://ipapi.co/json/',
    pick: j => ({ lat: Number(j.latitude), lng: Number(j.longitude), label: [j.city, j.region, j.country_name].filter(Boolean).join(' ') }),
  },
  {
    name: 'ipinfo.io',
    url: 'https://ipinfo.io/json',
    pick: j => {
      const [lat, lng] = String(j.loc || '').split(',').map(Number);
      return { lat, lng, label: [j.city, j.region, j.country].filter(Boolean).join(' ') };
    },
  },
  {
    name: 'ip-api.com',
    url: 'http://ip-api.com/json/',
    pick: j => ({ lat: Number(j.lat), lng: Number(j.lon), label: [j.city, j.regionName, j.country].filter(Boolean).join(' ') }),
  },
];

function createLocation({ dir, file = 'location.json', fetchRaw } = {}) {
  const filePath = path.join(dir, file);
  fs.mkdirSync(dir, { recursive: true });

  let state = JSON.parse(JSON.stringify(DEFAULT));

  function load() {
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const c = raw && raw.current;
      // 只接受结构完整的记录。半个坐标（只有 lat 没有 lng）比没有更危险 ——
      // 它会算出"距离 0 米"这种看起来很确定、实则完全错误的结果。
      if (c && geo.isValidCoord(Number(c.lat), Number(c.lng))) {
        state = { version: 1, current: { ...c, lat: Number(c.lat), lng: Number(c.lng) }, updatedAt: raw.updatedAt || 0 };
      }
    } catch (e) {
      console.error('[location] 位置文件损坏，已忽略：', e.message);
      try { fs.copyFileSync(filePath, `${filePath}.corrupt`); } catch { /* 忽略 */ }
      state = JSON.parse(JSON.stringify(DEFAULT));
    }
  }
  load();

  function persist() {
    state.updatedAt = Date.now();
    try {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (e) {
      console.error('[location] 位置写入失败：', e.message);
    }
  }

  function record({ lat, lng, accuracy, label, source, note }) {
    const la = Number(lat);
    const ln = Number(lng);
    if (!geo.isValidCoord(la, ln)) {
      throw Object.assign(new Error(`坐标不合法：lat=${lat} lng=${lng}（纬度需在 -90~90，经度在 -180~180）`), { code: 'BAD_INPUT' });
    }
    state.current = {
      lat: la,
      lng: ln,
      accuracy: Number.isFinite(Number(accuracy)) ? Number(accuracy) : null,
      label: String(label || ''),
      source,
      note: note || '',
      at: Date.now(),
    };
    persist();
    return get();
  }

  /** 浏览器定位（用户在弹窗里授权后由前端上报） */
  function setFromBrowser({ lat, lng, accuracy, label }) {
    return record({ lat, lng, accuracy, label, source: 'browser' });
  }

  /** 手动坐标：演示时最可控，也便于在没有定位权限的环境里验证功能 */
  function setManual({ lat, lng, label }) {
    return record({ lat, lng, label, source: 'manual' });
  }

  function clear() {
    state.current = null;
    persist();
    return get();
  }

  /**
   * 读当前位置，并附上时效信息。
   *
   * `fresh` 是关键字段：调用方（界面 / MCP 工具）应当据此提示"这个位置可能已经不准了"，
   * 而不是把一个半小时前的坐标当成"你现在的位置"直接用来算距离。
   */
  function get() {
    const c = state.current;
    if (!c) return null;
    const ageMs = Date.now() - (c.at || 0);
    return {
      ...c,
      ageMs,
      ageText: ageMs < 60000 ? '刚刚' : ageMs < 3600000 ? `${Math.round(ageMs / 60000)} 分钟前` : `${Math.round(ageMs / 3600000)} 小时前`,
      fresh: ageMs <= FRESH_MS,
      // 精度说明直接写进数据里，避免界面各自编一套口径
      accuracyNote: c.source === 'browser'
        ? (c.accuracy ? `浏览器定位，精度约 ±${Math.round(c.accuracy)} 米` : '浏览器定位')
        : c.source === 'manual' ? '手动填写的坐标'
          : 'IP 定位（精度仅到城市级，可能偏差几十公里）',
    };
  }

  /**
   * IP 兜底定位。
   *
   * 需要联网，且会把请求发给第三方服务；调用方必须先确认用户开了这个开关。
   * 三家依次尝试 —— 这类免费服务单点不可用是常态，只试一家会出现
   * "昨天还能用今天就报错"这种没法解释的现象。
   */
  async function resolveByIp() {
    if (typeof fetchRaw !== 'function') {
      throw Object.assign(new Error('IP 定位需要联网能力（fetchRaw 未注入）'), { code: 'NOT_AVAILABLE' });
    }
    const failures = [];
    for (const p of IP_PROVIDERS) {
      try {
        const res = await fetchRaw(p.url, { accept: 'application/json', timeout: 10000 });
        if (res.status !== 200) { failures.push(`${p.name}: HTTP ${res.status}`); continue; }
        const j = JSON.parse(res.body.toString('utf8'));
        const got = p.pick(j);
        if (!geo.isValidCoord(got.lat, got.lng)) { failures.push(`${p.name}: 返回的坐标不可用`); continue; }
        return record({
          lat: got.lat, lng: got.lng, label: got.label,
          source: 'ip',
          note: `经 ${p.name} 解析，仅城市级精度`,
        });
      } catch (e) {
        failures.push(`${p.name}: ${e.message.split('\n')[0]}`);
      }
    }
    throw Object.assign(
      new Error(`IP 定位全部失败：\n  · ${failures.join('\n  · ')}\n可以直接手填坐标，或在浏览器弹窗里授权定位。`),
      { code: 'IP_LOOKUP_FAILED' },
    );
  }

  /** 给界面/MCP 看的状态摘要 */
  function status() {
    const cur = get();
    return {
      hasLocation: Boolean(cur),
      source: cur ? cur.source : null,
      fresh: cur ? cur.fresh : false,
      ageText: cur ? cur.ageText : '',
      accuracyNote: cur ? cur.accuracyNote : '',
      label: cur ? cur.label : '',
      lat: cur ? cur.lat : null,
      lng: cur ? cur.lng : null,
      file: filePath,
    };
  }

  /**
   * 算"从用户当前位置到某个景点"的距离与方位。
   * online 为真时才允许走在线地理编码补查坐标。
   */
  async function relationTo(spot, { city, online = false } = {}) {
    const cur = get();
    if (!cur) {
      throw Object.assign(new Error('还不知道你在哪。可以点「获取我的位置」授权浏览器定位，或手填坐标。'), { code: 'NO_LOCATION' });
    }
    const target = await geo.resolveSpot(spot, { city, online, fetchRaw });
    if (!target) {
      throw Object.assign(
        new Error(`查不到「${spot}」的坐标。内置坐标表只覆盖样本库的 5 个城市（杭州/苏州/成都/丽江/西安）的主要景点；`
          + '表外的地点需要开启联网，用手动填坐标的方式也可以。'),
        { code: 'NO_SPOT' },
      );
    }
    const rel = geo.describeRelation(
      { lat: cur.lat, lng: cur.lng, label: cur.label || '你的位置' },
      { lat: target.lat, lng: target.lng, label: target.name },
    );
    return {
      ...rel,
      fromSource: cur.source,
      fromFresh: cur.fresh,
      fromAgeText: cur.ageText,
      fromAccuracyNote: cur.accuracyNote,
      target: { name: target.name, city: target.city, lat: target.lat, lng: target.lng, source: target.source, precise: target.precise !== false },
      note: cur.source === 'ip'
        ? '注意：当前位置来自 IP 解析，只精确到城市，距离仅供参考。'
        : (cur.fresh ? '' : '注意：这个位置已经有一段时间了，距离可能已不准。'),
    };
  }

  return {
    filePath,
    get,
    status,
    setFromBrowser,
    setManual,
    clear,
    resolveByIp,
    relationTo,
    FRESH_MS,
    IP_PROVIDERS,
  };
}

module.exports = { createLocation, FRESH_MS, IP_PROVIDERS };
