/**
 * 输出质检模块（零第三方依赖，可独立单元测试）
 *
 * 为什么单独抽一个文件：
 *   质检的价值完全取决于"它自己会不会失灵"。初版质检曾被实测证明存在**假阴性**——
 *   模型只输出 3 天（请求 7 天）且总览表全空，质检却报 0 告警。把逻辑抽出来后，
 *   `test/audit.js` 就能用固定的"坏输出"做确定性回归，不必每次调用大模型去碰运气。
 *
 * 四类核对：
 *   ① 推荐项是否来自样本库（按 景区/酒店/餐饮 三类分库核对，能识别"把住宿当餐厅"的错位）
 *   ② 字段是否漏填（含整段 Day 缺失）
 *   ③ 结构异常：天数不足、总览表为空、章节重复、表格列数不符
 *   ④ 汇总成人类可读的告警数组
 */

const fs = require('fs');
const path = require('path');

const PLACEHOLDER = /^(无|暂无|待定|略|—|-|\/|N\/A|none|null)$/;

const CAT_LABEL = { sight: '景区/目的地库', hotel: '酒店/民宿库', dining: '餐饮库' };

// 各字段应当引用的样本库类别（交通贴士是话术，不做库核对）
const FIELD_CAT = {
  上午: 'sight', 下午: 'sight', 核心景点: 'sight',
  午餐: 'dining', 晚餐: 'dining',
  住宿: 'hotel',
};

// 名称归一化：去掉括号里的补充说明和分隔符号，便于宽松比对
function normName(s) {
  return String(s == null ? '' : s)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s·・\-—/、]/g, '')
    .trim();
}

// 从样本库表格首列抽出全部"名称"
function loadEntitiesFrom(refDir, files) {
  const set = new Set();
  for (const f of files) {
    const txt = fs.readFileSync(path.join(refDir, f), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\|\s*([^|]+?)\s*\|/);        // 表格行的第一格
      if (!m) continue;
      const name = m[1].trim();
      if (!name || name === '名称' || /^[-: ]+$/.test(name)) continue;   // 跳过表头与分隔行
      set.add(name);
    }
  }
  return [...set];
}

function splitRow(line) {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
}

// 前导动词短语：模型常写"前往九溪烟树徒步""步行至河坊街"，
// 不剥掉前缀就会把库中已有条目误判成库外内容（实测出现过的误报来源）。
const LEADING_VERBS = ['步行至', '步行到', '乘车至', '乘车到', '前往', '抵达', '去往', '游览', '参观', '漫步', '乘坐', '去', '到'];

function stripLeadingVerb(s) {
  for (const v of LEADING_VERBS) {
    if (s.length > v.length && s.startsWith(v)) return s.slice(v.length).trim();
  }
  return s;
}

// 宽松包含匹配：
//   · 完全一致 —— 直接命中
//   · 输出是库中条目的简写（如"河坊街" vs "河坊街 / 清河坊"）—— 命中
//   · 输出以库中条目开头，且后缀不是在另起一个商家名 —— 命中
//     （涵盖"千岛湖 1 日游""西溪湿地国家公园""龙井村采茶或品茗""宋城景区内观看演出"）
//   · 输出以库中条目开头，但后缀是商家类词（如"西湖边特色餐馆""西溪湿地私房菜馆"）
//     —— 判定为蹭着库中名字的虚构条目
//
// 这里刻意用「商家词黑名单」而不是「描述词白名单」：描述性写法是无穷的
// （游湖、品茗、看演出、看日出……），穷举必然漏；而商家类后缀是有限且明确的。
const MAX_SUFFIX = 4;

// 商家 / 场所类词：出现在后缀里说明括号前那段是在说"另一个店"，而不是在描述玩法
const BUSINESS_WORDS = [
  '餐馆', '餐厅', '饭馆', '饭店', '酒店', '客栈', '民宿', '旅馆', '宾馆',
  '酒楼', '小馆', '菜馆', '私房菜', '山庄', '度假村', '会所', '茶楼',
];

function looksLikeOtherBusiness(suffix) {
  return BUSINESS_WORDS.some((w) => suffix.includes(w));
}

function matchesList(raw, list) {
  const n = normName(raw);
  if (!n) return false;
  return list.some((e) => {
    const en = normName(e);
    if (!en) return false;
    if (en === n) return true;
    if (en.includes(n)) return true;
    if (n.startsWith(en)) {
      const suffix = n.slice(en.length);
      if (suffix.length <= MAX_SUFFIX) return true;
      return !looksLikeOtherBusiness(suffix);
    }
    return false;
  });
}

/**
 * 创建一个质检器
 * @param {string} refDir references 目录
 * @param {object} [entities] 可选：直接注入实体表（测试用）
 */
function createAuditor(refDir, entities) {
  const ENTITY_BY_CAT = entities || {
    sight: loadEntitiesFrom(refDir, ['destinations.md']),
    hotel: loadEntitiesFrom(refDir, ['hotels.md']),
    dining: loadEntitiesFrom(refDir, ['dining.md']),
  };
  const entityCount = Object.values(ENTITY_BY_CAT).flat().length;

  // 该名称命中了哪些类别
  const catsOf = (raw) => Object.keys(ENTITY_BY_CAT).filter((k) => matchesList(raw, ENTITY_BY_CAT[k]));

  /**
   * 质检一份模型输出
   * @param {string} content 模型返回的 Markdown
   * @param {string} type    plan | marketing | intake
   * @param {object} params  本次请求参数（用于核对天数）
   * @returns {string[]} 人类可读的告警列表（为空表示未发现问题）
   */
  function audit(content, type, params) {
    const warnings = [];
    const unknown = new Set();          // 样本库里查不到的推荐项（可能编造）
    const miscat = new Set();           // 在库中但分类错位（例如把住宿条目当餐厅用）
    let blanks = 0;                     // 空字段数（含整段缺失的字段）
    let filled = 0;                     // 有内容的字段数
    const lines = String(content || '').split('\n');

    const check = (raw, cat, label) => {
      // 只取"名称部分"：以逗号/分号/箭头/括号切开，剥掉前导动词短语，
      // 避免把"西溪湿地 → 租船游湖赏景""前往九溪烟树徒步"这类带说明的写法
      // 整句拿去比对样本库（否则会误报成"库外条目"）
      const name = stripLeadingVerb(
        String(raw || '').split(/[，,；;→]/)[0].replace(/[（(].*$/, '').trim()
      );
      const n = normName(name);
      if (!n || PLACEHOLDER.test(n)) { blanks++; return; }
      filled++;
      if (!cat) return;                              // 无类别要求的字段不做库核对
      const cats = catsOf(name);
      if (cats.includes(cat)) return;                // 正确引用，通过
      if (cats.length) {                             // 在库中，但放错了类别
        miscat.add(`「${name}」来自${cats.map((c) => CAT_LABEL[c]).join('、')}，被放在了「${label}」位置`);
        return;
      }
      unknown.add(name);                             // 完全不在库中
    };

    // ① 逐日字段：按 ## Day N 分节，核对样本库引用 + 统计 6 个字段是否齐全
    let dayCount = 0;
    for (const sec of String(content || '').split(/^##\s+/m).slice(1)) {
      if (!/^Day\s*\d+/i.test(sec.split('\n')[0].trim())) continue;
      dayCount++;
      const present = new Set();
      for (const m of sec.matchAll(/^[-*]\s*(上午|下午|午餐|晚餐|住宿|交通贴士)\s*[:：]\s*(.+)$/gm)) {
        present.add(m[1]);
        check(m[2], FIELD_CAT[m[1]], m[1]);
      }
      blanks += 6 - present.size;        // 缺失的字段按漏填计入
    }

    // ② 行程总览表：按表头定位「核心景点 / 午餐 / 晚餐 / 住宿」列后逐格核对，并统计数据行数
    let overviewRows = 0;
    let overviewFound = false;          // 与"表存在但没有数据行"区分开，避免提示词不准确
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l.startsWith('|')) continue;
      const wanted = ['核心景点', '午餐', '晚餐', '住宿'];
      const cols = splitRow(l)
        .map((c, j) => (wanted.includes(c) ? { cat: FIELD_CAT[c], label: c, j } : null))
        .filter(Boolean);
      if (!cols.length) continue;
      overviewFound = true;
      for (let k = i + 2; k < lines.length && lines[k].trim().startsWith('|'); k++) {
        const row = splitRow(lines[k].trim());
        if (!row.some((c) => c)) continue;            // 跳过空行
        overviewRows++;
        for (const { cat, label, j } of cols) {
          if (j < row.length) check(row[j], cat, label);
        }
      }
      break;                          // 只处理第一个行程总览表
    }

    // ③ 重复章节（小模型长文生成的经典退化）
    const heads = [...String(content || '').matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
    const seen = new Set();
    const dup = new Set();
    for (const h of heads) {
      if (seen.has(h)) dup.add(h);
      seen.add(h);
    }
    if (dup.size) {
      warnings.push(`检测到重复章节：${[...dup].join('、')}。这是小模型长文生成时的重复退化，建议重试一次。`);
    }

    // ④ 表格列数与表头不一致（该列内容缺失，导出后对应单元格会是空的）
    const badTable = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l.startsWith('|')) continue;
      if (!/^\|[\s:|-]+\|$/.test((lines[i + 1] || '').trim())) continue;   // 下一行必须是分隔行才算表头
      const nCols = splitRow(l).length;
      for (let k = i + 2; k < lines.length && lines[k].trim().startsWith('|'); k++) {
        const c = splitRow(lines[k].trim()).length;
        if (c < nCols) { badTable.push(`表头 ${nCols} 列、数据行 ${c} 列`); break; }
      }
    }
    if (badTable.length) {
      warnings.push(`表格列数与表头不一致（${badTable[0]}），该列内容缺失，导出后对应单元格会是空的。`);
    }

    // ⑤ 完整性：请求的天数 vs 实际生成的天数、总览表是否有数据行
    const expectedDays = type === 'plan' ? Number(params && params.days) || 0 : 0;
    if (expectedDays && dayCount < expectedDays) {
      warnings.push(
        `请求的是 ${expectedDays} 天方案，实际只生成了 ${dayCount} 天（缺 ${expectedDays - dayCount} 天）。` +
        `模型可能提前收尾，或输出触达了长度上限，建议重试一次，或把天数改小后再生成。`
      );
    }
    if (expectedDays && !overviewFound) {
      warnings.push('未找到「行程总览」表（SKILL.md 要求输出该表）；可重试生成，或直接参考下方逐日行程。');
    } else if (expectedDays && overviewRows === 0) {
      warnings.push('「行程总览」表只有表头、没有数据行，导出的表格会是空的；可重试生成，或直接参考下方逐日行程。');
    }

    // ⑥ 汇总
    if (unknown.size) {
      warnings.push(
        `以下推荐未能在本地样本库中核实，可能是模型自行生成的内容：${[...unknown].join('、')}。` +
        `落地前请人工确认，或把它们补充到 references/ 下的样本库。`
      );
    }
    if (miscat.size) {
      warnings.push(
        `以下条目在样本库中存在，但类别用错了：${[...miscat].join('；')}。` +
        `例如把住宿条目当成餐厅推荐，请人工校正后再使用。`
      );
    }
    if (blanks >= 8 || (blanks + filled > 0 && blanks / (blanks + filled) > 0.3)) {
      warnings.push(
        `本次输出有 ${blanks} 处字段为空或缺失，样本库条目可能不足以覆盖当前天数。` +
        `建议减少天数，或补充 references/ 下的样本库数据。`
      );
    }

    return warnings;
  }

  return { audit, entityCount, ENTITY_BY_CAT };
}

module.exports = { createAuditor, normName, PLACEHOLDER };
