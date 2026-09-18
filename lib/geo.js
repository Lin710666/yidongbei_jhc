/**
 * geo.js —— 地理计算与景点坐标（零第三方依赖）
 *
 * 位置功能要做的事其实只有两件：
 *   1. 把"用户在哪"和"景点在哪"换算成**距离与方位**（这是用户真正关心的信息）；
 *   2. 在 3D 场景里把这两点画出来。
 *
 * 所以这个模块提供两样东西：纯函数的地理计算，以及一份**内置景点坐标表**。
 *
 * 为什么要内置坐标表，而不是全都联网查：
 *   查坐标要走地理编码服务（Nominatim 之类），既慢又要联网，演示时一旦网络不好，
 *   "看距离"这个最基础的功能就整个不可用了。内置这 5 个城市的主要景点坐标之后，
 *   断网也能演示完整流程；需要表外的地方时再走在线地理编码兜底。
 *
 * 坐标精度说明：内置坐标取自公开的景点位置，精度到"百米级"。
 * 用来算"离你多远、在哪个方向"完全够用；不要拿它做导航。
 */

/* ==========================================================================
 * 基础计算
 * ========================================================================*/

const EARTH_R = 6371008.8;   // 地球平均半径（米），IUGG 推荐值

const toRad = d => (d * Math.PI) / 180;
const toDeg = r => (r * 180) / Math.PI;

function isValidCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/**
 * 两点间大圆距离（米）。
 *
 * 用 haversine 而不是"平面勾股"：后者在城市尺度上误差不大，但高纬度会明显偏，
 * 而方位角本来就要靠球面公式算，两处用同一套模型更不容易出现"距离说很近、
 * 箭头却指向反方向"这种自相矛盾的结果。
 */
function distanceMeters(a, b) {
  if (!a || !b) return null;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 从 a 看向 b 的方位角（度，正北为 0，顺时针增加）。
 *
 * 用途是"箭头指哪边"。这里刻意不扣除磁偏角：本项目给的是"地图方位"，
 * 而手机罗盘给的是磁北，两者在国内一般差 2~6 度 —— 对"往哪个方向走"这个
 * 粒度的问题没有影响，但要在文案里说清楚，不能让人以为可以拿来精确导航。
 */
function bearingDeg(a, b) {
  if (!a || !b) return null;
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS_16 = ['北', '北东北', '东北', '东东北', '东', '东东南', '东南', '南东南',
  '南', '南西南', '西南', '西西南', '西', '西西北', '西北', '北西北'];

function compassLabel(deg) {
  if (!Number.isFinite(deg)) return '';
  const i = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return COMPASS_16[i];
}

/** 距离的中文说法。带一位小数就够，多余的精度只会让人以为它很准。 */
function formatDistance(m) {
  if (!Number.isFinite(m)) return '';
  if (m < 1000) return `${Math.round(m)} 米`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} 公里`;
  return `${Math.round(m / 1000)} 公里`;
}

/* ==========================================================================
 * 内置景点坐标
 *
 * 只覆盖项目样本库里的 5 个城市。每条 { name, lat, lng }，name 用最常见的中文写法，
 * 同时列几个别名（`aka`）以适配"西湖 / 杭州西湖 / 西湖景区"这类不同叫法。
 * ========================================================================*/

const GAZETTEER = [
  // ---- 杭州 ----
  { city: '杭州', name: '西湖', aka: ['杭州西湖', '西湖景区', '西湖风景名胜区'], lat: 30.2470, lng: 120.1490 },
  { city: '杭州', name: '灵隐寺', aka: ['灵隐', '灵隐飞来峰', '飞来峰'], lat: 30.2410, lng: 120.1010 },
  { city: '杭州', name: '雷峰塔', aka: [], lat: 30.2330, lng: 120.1490 },
  { city: '杭州', name: '西溪湿地', aka: ['西溪'], lat: 30.2660, lng: 120.0670 },
  { city: '杭州', name: '河坊街', aka: ['清河坊'], lat: 30.2390, lng: 120.1720 },
  { city: '杭州', name: '宋城', aka: [], lat: 30.1890, lng: 120.1010 },
  { city: '杭州', name: '千岛湖', aka: [], lat: 29.6050, lng: 119.0400 },

  // ---- 苏州 ----
  { city: '苏州', name: '拙政园', aka: [], lat: 31.3245, lng: 120.6295 },
  { city: '苏州', name: '虎丘', aka: ['虎丘塔'], lat: 31.3430, lng: 120.5760 },
  { city: '苏州', name: '平江路', aka: ['平江历史街区'], lat: 31.3140, lng: 120.6290 },
  { city: '苏州', name: '留园', aka: [], lat: 31.3230, lng: 120.5960 },
  { city: '苏州', name: '山塘街', aka: [], lat: 31.3230, lng: 120.5790 },
  { city: '苏州', name: '周庄', aka: [], lat: 31.1150, lng: 120.8470 },

  // ---- 成都 ----
  { city: '成都', name: '宽窄巷子', aka: [], lat: 30.6690, lng: 104.0570 },
  { city: '成都', name: '武侯祠', aka: [], lat: 30.6470, lng: 104.0470 },
  { city: '成都', name: '锦里', aka: [], lat: 30.6450, lng: 104.0450 },
  { city: '成都', name: '杜甫草堂', aka: [], lat: 30.6600, lng: 104.0290 },
  { city: '成都', name: '大熊猫繁育研究基地', aka: ['熊猫基地', '大熊猫基地'], lat: 30.7330, lng: 104.1450 },
  { city: '成都', name: '都江堰', aka: [], lat: 31.0020, lng: 103.6180 },

  // ---- 丽江 ----
  { city: '丽江', name: '丽江古城', aka: ['大研古城', '古城'], lat: 26.8740, lng: 100.2340 },
  { city: '丽江', name: '玉龙雪山', aka: [], lat: 27.1000, lng: 100.1800 },
  { city: '丽江', name: '束河古镇', aka: ['束河'], lat: 26.9100, lng: 100.1980 },
  { city: '丽江', name: '拉市海', aka: [], lat: 26.8300, lng: 100.1350 },

  // ---- 西安 ----
  { city: '西安', name: '秦始皇兵马俑', aka: ['兵马俑', '秦兵马俑'], lat: 34.3841, lng: 109.2785 },
  { city: '西安', name: '大雁塔', aka: [], lat: 34.2186, lng: 108.9640 },
  { city: '西安', name: '西安城墙', aka: ['城墙'], lat: 34.2600, lng: 108.9470 },
  { city: '西安', name: '钟楼', aka: [], lat: 34.2610, lng: 108.9450 },
  { city: '西安', name: '回民街', aka: [], lat: 34.2650, lng: 108.9400 },
  { city: '西安', name: '华清宫', aka: ['华清池'], lat: 34.3620, lng: 109.2130 },
];

/** 城市中心点，作为"只知道城市、不知道具体景点"时的兜底 */
const CITY_CENTERS = {
  杭州: { lat: 30.2741, lng: 120.1551 },
  苏州: { lat: 31.2989, lng: 120.5853 },
  成都: { lat: 30.5728, lng: 104.0668 },
  丽江: { lat: 26.8721, lng: 100.2299 },
  西安: { lat: 34.3416, lng: 108.9398 },
};

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s·・,，.。、\-—_()（）]/g, '')
    .replace(/(景区|风景区|旅游区|景点|公园)$/g, '');
}

/**
 * 在内置表里找景点坐标。
 *
 * 匹配策略由严到宽：
 *   1. 先按（城市 + 名称）精确匹配
 *   2. 再按别名精确匹配
 *   3. 最后按"包含"匹配，并**优先选名字最长的那个** ——
 *      "西湖"要能匹配到"杭州西湖"，但输入"杭州西湖景区"也不能错配到别的条目
 *
 * @returns {{name,city,lat,lng,matched,source}|null}
 */
function lookupSpot(spot, { city } = {}) {
  const q = normName(spot);
  if (!q) return null;
  const cityQ = normName(city);

  const inCity = e => !cityQ || normName(e.city) === cityQ;

  // 1) 名称精确
  for (const e of GAZETTEER) {
    if (inCity(e) && normName(e.name) === q) return hit(e, e.name);
  }
  // 2) 别名精确
  for (const e of GAZETTEER) {
    if (!inCity(e)) continue;
    for (const a of e.aka || []) if (normName(a) === q) return hit(e, a);
  }
  // 3) 包含匹配，取名字最长的（最长匹配能避开"西湖"误命中"西湖区"这类子串问题）
  const cands = [];
  for (const e of GAZETTEER) {
    if (!inCity(e)) continue;
    const names = [e.name, ...(e.aka || [])];
    for (const n of names) {
      const nn = normName(n);
      if (!nn) continue;
      if (nn.includes(q) || q.includes(nn)) cands.push({ e, n, len: nn.length });
    }
  }
  if (cands.length) {
    cands.sort((a, b) => b.len - a.len);
    return hit(cands[0].e, cands[0].n);
  }
  // 4) 退而求其次：只知道城市时给城市中心，并明确标注精度不同
  if (cityQ && CITY_CENTERS[city]) {
    const c = CITY_CENTERS[city];
    return { name: city, city, lat: c.lat, lng: c.lng, matched: city, source: 'city-center', precise: false };
  }
  return null;

  function hit(e, matched) {
    return { name: e.name, city: e.city, lat: e.lat, lng: e.lng, matched, source: 'builtin', precise: true };
  }
}

/* ==========================================================================
 * 在线地理编码（可选，需要联网）
 * ========================================================================*/

/**
 * 用 OpenStreetMap 的 Nominatim 查坐标。
 *
 * 只在联网开关打开时才允许调用（调用方负责判断），因为：
 *   · 这是把"用户在找哪个景点"发到外部服务；
 *   · Nominatim 的公共实例有使用条款，要求标明来源、限制频率。
 * 所以这里串行化 + 节流，并把来源写进返回值供界面标注。
 */
let lastGeocodeAt = 0;
const GEOCODE_MIN_INTERVAL = 1100;   // Nominatim 公共实例要求不超过 1 次/秒

async function geocodeOnline(spot, { city, fetchRaw, contact } = {}) {
  if (typeof fetchRaw !== 'function') throw new Error('geocodeOnline 需要传入 fetchRaw');
  const q = [city, spot].filter(Boolean).join(' ');
  if (!q.trim()) throw new Error('缺少要查询的地名');

  // 节流：两次请求之间至少隔 1.1 秒，避免触发对方的频率限制被封
  const wait = GEOCODE_MIN_INTERVAL - (Date.now() - lastGeocodeAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocodeAt = Date.now();

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=zh-CN&q=${encodeURIComponent(q)}`;
  const res = await fetchRaw(url, {
    timeout: 12000,
    accept: 'application/json',
    headers: {
      // Nominatim 要求带可识别的 UA，带上联系方式更容易被容忍
      'User-Agent': `wenlv-assistant/4.1 (+${contact || 'local demo'})`,
    },
  });
  if (res.status !== 200) throw new Error(`地理编码服务返回 HTTP ${res.status}`);
  const list = JSON.parse(res.body.toString('utf8'));
  if (!Array.isArray(list) || !list.length) return null;
  const it = list[0];
  const lat = Number(it.lat);
  const lng = Number(it.lon);
  if (!isValidCoord(lat, lng)) return null;
  return {
    name: it.display_name || spot,
    city: city || '',
    lat,
    lng,
    matched: spot,
    source: 'nominatim',
    precise: true,
    attribution: '© OpenStreetMap contributors',
  };
}

/**
 * 统一的"查景点坐标"入口：内置表优先，查不到再走在线。
 * 返回值里带 source，界面才能如实告诉用户"这是内置坐标还是联网查的"。
 */
async function resolveSpot(spot, { city, online = false, fetchRaw, contact } = {}) {
  const local = lookupSpot(spot, { city });
  if (local && local.precise) return local;
  if (online && fetchRaw) {
    try {
      const remote = await geocodeOnline(spot, { city, fetchRaw, contact });
      if (remote) return remote;
    } catch (e) {
      // 在线失败不能把整个位置功能带崩：退回到能拿到的东西，并如实标注
      if (local) return { ...local, note: `在线地理编码失败（${e.message}），用的是城市中心坐标` };
      return null;
    }
  }
  return local || null;
}

/** 把两个点算成一份"给你看的"位置简报 */
function describeRelation(from, to) {
  if (!from || !to) return null;
  const dist = distanceMeters(from, to);
  const brg = bearingDeg(from, to);
  return {
    distanceMeters: dist,
    distanceText: formatDistance(dist),
    bearing: brg,
    bearingText: compassLabel(brg),
    from: { lat: from.lat, lng: from.lng, label: from.label || '' },
    to: { lat: to.lat, lng: to.lng, label: to.label || to.name || '' },
  };
}

module.exports = {
  EARTH_R,
  isValidCoord,
  distanceMeters,
  bearingDeg,
  compassLabel,
  formatDistance,
  lookupSpot,
  geocodeOnline,
  resolveSpot,
  describeRelation,
  GAZETTEER,
  CITY_CENTERS,
  normName,
};
