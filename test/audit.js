#!/usr/bin/env node
/**
 * 输出质检的单元测试（不需要调用大模型，完全确定性）
 *
 * 运行：node test/audit.js
 *
 * 为什么需要它：质检的价值取决于"它自己会不会失灵"。初版质检曾被真实输出证明存在假阴性——
 * 模型只给了 3 天（请求 7 天）、总览表全空，质检却报 0 告警。这里把两次真实翻车输出
 * 固化成 fixtures，保证同样的漏检不会再次发生。
 */

const fs = require('fs');
const path = require('path');
const { createAuditor } = require('../lib/audit');

const REF_DIR = path.join(__dirname, '..', '.agents', 'skills', 'wenlv-assistant', 'references');
const FIX = path.join(__dirname, 'fixtures');
const auditor = createAuditor(REF_DIR);

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}${detail ? '\n      → ' + detail : ''}`);
  }
}

const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const has = (arr, kw) => arr.some((w) => w.includes(kw));

console.log('输出质检 · 单元测试');
console.log(`样本库实体：${auditor.entityCount} 条（景区 ${auditor.ENTITY_BY_CAT.sight.length} / 酒店 ${auditor.ENTITY_BY_CAT.hotel.length} / 餐饮 ${auditor.ENTITY_BY_CAT.dining.length}）\n`);

// ---- 用例 1：改造前的真实输出（编造商家 + 结尾重复 + 表格缺列） ----
{
  console.log('用例 1：plan-bad-hallucination.md（改造前的真实输出）');
  const w = auditor.audit(read('plan-bad-hallucination.md'), 'plan', { days: 7 });
  check('识别出编造条目「东坡美食」', has(w, '东坡美食'));
  check('识别出编造条目「老板娘小馆」', has(w, '老板娘小馆'));
  check('识别出重复章节', has(w, '重复章节'));
  check('识别出表格列数与表头不一致', has(w, '列数与表头不一致'));
  check('未把真实条目「知味观 / 龙井茶室」误报为编造', !has(w, '知味观') && !has(w, '龙井茶室'));
}

// ---- 用例 2：改造后的真实输出（只给 3 天、总览表为空、类别错位） ----
{
  console.log('\n用例 2：plan-bad-truncated.md（改造后的真实输出，暴露初版假阴性）');
  const w = auditor.audit(read('plan-bad-truncated.md'), 'plan', { days: 7 });
  check('识别出天数不足（请求 7 天、实际 3 天）', has(w, '只生成了 3 天'));
  check('识别出总览表只有表头、没有数据行', has(w, '只有表头'));
  check('识别出「青芝坞·山居民宿」被当成餐厅（分类错位）', has(w, '青芝坞·山居民宿'));
  check('识别出「龙井村」被当成餐厅（分类错位）', has(w, '龙井村'));
  check('分类错位不会被误报成"库外编造"', !has(w, '未能在本地样本库中核实'));
}

// ---- 用例 3：合格输出不应有任何误报 ----
{
  console.log('\n用例 3：plan-good.md（全部字段合规）');
  const w = auditor.audit(read('plan-good.md'), 'plan', { days: 7 });
  check('0 条告警（无误报）', w.length === 0, w.join(' | '));
}

// ---- 用例 4：营销文案的 A/B 两版有同名小节，不应该被当成"重复章节" ----
{
  console.log('\n用例 4：marketing-good.md（A/B 两版有同名三级小节）');
  const w = auditor.audit(read('marketing-good.md'), 'marketing', {});
  check('0 条告警（### 级小节重复不算问题）', w.length === 0, w.join(' | '));
}

// ---- 用例 5：边界情况 ----
{
  console.log('\n用例 5：边界情况');
  check('空字符串不抛异常', Array.isArray(auditor.audit('', 'plan', { days: 2 })));
  check('非 plan 类型不做天数核对', auditor.audit('# 标题\n## 版本 A\n内容', 'marketing', {}).length === 0);
  const w = auditor.audit('# 方案\n## Day 1 · 主题\n- 上午：无\n- 午餐：无\n- 下午：无\n- 晚餐：无\n- 住宿：无\n- 交通贴士：无', 'plan', { days: 1 });
  check('全部字段填"无"会被识别为漏填', has(w, '字段为空或缺失'), w.join(' | '));
  check('完全没有总览表时，提示是"未找到"而不是"只有表头"', has(w, '未找到「行程总览」表'), w.join(' | '));
}

// ---- 用例 6：字段里带说明的写法，不应被误报为"库外编造" ----
{
  console.log('\n用例 6：字段里带说明（"西溪湿地 → 租船游湖赏景"）');
  const md = [
    '# 杭州 · 1天方案',
    '## 行程总览',
    '| 天数 | 主题 | 核心景点 | 午餐 | 晚餐 | 住宿 |',
    '| --- | --- | --- | --- | --- | --- |',
    '| Day 1 | 湿地 | 西溪湿地 | 知味观 | 楼外楼 | 西溪·亲子度假酒店 |',
    '## Day 1 · 湿地',
    '- 上午：西溪湿地 → 租船游湖赏景（80 元）',
    '- 午餐：知味观（40 元）',
    '- 下午：九溪烟树（免费）',
    '- 晚餐：楼外楼（150 元）',
    '- 住宿：西溪·亲子度假酒店（680 元）',
    '- 交通贴士：打车前往',
  ].join('\n');
  const w = auditor.audit(md, 'plan', { days: 1 });
  check('带 → 说明的写法不被误报为编造', !has(w, '未能在本地样本库中核实'), w.join(' | '));
  check('该用例整体 0 告警', w.length === 0, w.join(' | '));
}

// ---- 用例 7：蹭着库中名字编造的条目仍要被抓住 ----
{
  console.log('\n用例 7：蹭名字的虚构条目（"西湖边特色餐馆"）');
  const md = '# 方案\n## Day 1 · 主题\n- 午餐：西湖边特色餐馆（人均 100 元）';
  const w = auditor.audit(md, 'plan', { days: 1 });
  check('「西湖边特色餐馆」被判为库外条目，不会靠"西湖"二字蒙混过关', has(w, '西湖边特色餐馆'), w.join(' | '));
}

// ---- 用例 8：模型写成"名称 + 动作描述"时不应误报（真实输出回归） ----
// 这三条都是模型真实输出过的写法，条目本身都在样本库里，
// 早期版本按"后缀长度"卡死会导致误报，把实用的告警变成噪音。
{
  console.log('\n用例 8：名称 + 动作描述的真实写法（不应误报）');
  const md = [
    '# 方案',
    '## 行程总览',
    '| 天数 | 主题 | 核心景点 | 午餐 | 晚餐 | 住宿 |',
    '| --- | --- | --- | --- | --- | --- |',
    '| Day 1 | 茶文化 | 龙井村 | 知味观 | 楼外楼 | 河坊街青年旅舍 |',
    '| Day 2 | 人文演艺 | 宋城 | 绿茶餐厅 | 外婆家 | 西溪·亲子度假酒店 |',
    '## Day 1 · 主题',
    '- 上午：龙井村采茶或品茗（免费）',
    '- 午餐：知味观（人均 40 元）',
    '- 下午：灵隐寺及飞来峰石刻游览（75 元）',
    '- 晚餐：楼外楼（人均 150 元）',
    '- 住宿：河坊街青年旅舍（约 120 元）',
    '- 交通贴士：打车前往',
    '## Day 2 · 主题',
    '- 上午：宋城景区内观看《宋城千古情》演出（300 元起）',
    '- 午餐：绿茶餐厅（人均 80 元）',
    '- 下午：西溪湿地摇橹船游湖（80 元）',
    '- 晚餐：外婆家（人均 70 元）',
    '- 住宿：西溪·亲子度假酒店（约 680 元）',
    '- 交通贴士：公交前往',
  ].join('\n');
  const w = auditor.audit(md, 'plan', { days: 2 });
  check('「龙井村采茶或品茗」不被误报为编造', !has(w, '龙井村采茶或品茗'), w.join(' | '));
  check('「灵隐寺及飞来峰石刻游览」不被误报为编造', !has(w, '灵隐寺及飞来峰石刻游览'), w.join(' | '));
  check('「宋城景区内观看…演出」不被误报为编造', !has(w, '宋城景区内观看'), w.join(' | '));
  check('「西溪湿地摇橹船游湖」不被误报为编造', !has(w, '西溪湿地摇橹船游湖'), w.join(' | '));
  check('该用例整体 0 告警', w.length === 0, w.join(' | '));
}

// ---- 用例 9：放宽后仍要抓住"蹭名字 + 商家后缀"的虚构条目 ----
{
  console.log('\n用例 9：放宽规则后，蹭名字的虚构商家仍要被抓住');
  for (const bad of ['西湖边特色餐馆', '西湖印象大酒店', '西溪湿地私房菜馆']) {
    const w = auditor.audit(`# 方案\n## Day 1 · 主题\n- 午餐：${bad}（人均 100 元）`, 'plan', {});
    check(`「${bad}」仍被判为库外条目`, has(w, bad), w.join(' | '));
  }
}

// ---- 用例 10：前导动词短语不应导致误报（真实输出回归） ----
{
  console.log('\n用例 10：前导动词写法（"前往X徒步""步行至X"）');
  const md = [
    '# 方案',
    '## 行程总览',
    '| 天数 | 主题 | 核心景点 | 午餐 | 晚餐 | 住宿 |',
    '| --- | --- | --- | --- | --- | --- |',
    '| Day 1 | 徒步 | 九溪烟树 | 知味观 | 楼外楼 | 河坊街青年旅舍 |',
    '## Day 1 · 徒步',
    '- 上午：前往九溪烟树徒步（免费）',
    '- 午餐：知味观（40 元）',
    '- 下午：步行至河坊街（免费）',
    '- 晚餐：楼外楼（150 元）',
    '- 住宿：河坊街青年旅舍（120 元）',
    '- 交通贴士：打车前往',
  ].join('\n');
  const w = auditor.audit(md, 'plan', { days: 1 });
  check('「前往九溪烟树徒步」不被误报为编造', !has(w, '前往九溪烟树徒步'), w.join(' | '));
  check('「步行至河坊街」不被误报为编造', !has(w, '步行至河坊街'), w.join(' | '));
  check('该用例整体 0 告警', w.length === 0, w.join(' | '));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
