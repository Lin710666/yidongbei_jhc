"""Skill1：用户意图识别与信息采集（输入层）。

将用户的自然语言对话或极简表单转换为结构化 UserPreference 画像。
优先用 LLM（Ollama）做结构化抽取，LLM 不可用时退化为规则抽取，
保证无 AI 环境下也能跑通。
"""
import re
from typing import Any, Optional

from ..llm.client import LLMClient
from ..models.preference import Travelers, UserPreference
from .base import Skill

#: 扫描「输入框里提到的城市」用。只影响 parse_partial（输入框优先那条路），
#: 组员原有的 _parse_rules 行为不变 —— 见那个函数的说明。
_KNOWN_CITIES = (
    "杭州", "苏州", "成都", "丽江", "西安", "北京", "上海", "广州", "深圳", "重庆",
    "厦门", "三亚", "桂林", "青岛", "南京", "长沙", "昆明", "大理", "武汉", "天津",
    "大连", "哈尔滨", "拉萨", "西宁", "银川", "贵阳", "南宁", "福州", "济南", "郑州",
    "太原", "沈阳", "长春", "兰州", "银川", "海口", "珠海", "宁波", "无锡", "黄山",
    "张家界", "敦煌", "呼伦贝尔", "伊犁", "香格里拉", "西双版纳", "平遥", "婺源",
)

#: 中文数字 → 阿拉伯数字。原来只认 "\d+天"，所以「两天」「三日游」一律解析不出来
#: （这是反复被提到的老问题）。中文里这两种写法同样常见，必须一起认。
_CN_DIGIT = {"一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5,
             "六": 6, "七": 7, "八": 8, "九": 9}
_CN_NUM_RE = r"[0-9]+|[一二两三四五六七八九十]+"


def _cn_to_int(s: str) -> Optional[int]:
    """把「3」/「三」/「十二」/「二十」/「三十三」转成整数；认不出返回 None。"""
    s = (s or "").strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    if s == "十":
        return 10
    if "十" in s:
        left, _, right = s.partition("十")
        tens = _CN_DIGIT.get(left, 0) if left else 1     # 「十五」左空 = 1
        ones = _CN_DIGIT.get(right, 0) if right else 0
        return tens * 10 + ones
    return _CN_DIGIT.get(s)


class IntentSkill(Skill):
    """意图识别与信息采集。"""
    name = "intent"
    description = "从对话/表单中提取用户画像 UserPreference"

    def __init__(self, llm: Optional[LLMClient] = None):
        self.llm = llm or LLMClient()

    def run(self, ctx: dict[str, Any]) -> dict[str, Any]:
        # 若上游已直接给出结构化画像（表单模式），跳过解析
        if ctx.get("preference") is not None:
            return ctx

        raw = ctx.get("raw_text", "")
        pref = self._parse_llm(raw)
        if pref is None:
            pref = self._parse_rules(raw)
        ctx["preference"] = pref
        return ctx

    # ---------------- LLM 结构化抽取 ----------------
    def _parse_llm(self, raw: str) -> Optional[UserPreference]:
        system = (
            "你是旅游需求结构化抽取助手。从用户描述中提取字段，只输出合法 JSON，"
            "结构如下："
            '{"travelers":{"adults":0,"children":0,"elderly":0},'
            '"destination":"","duration_days":0,"budget":0,'
            '"preferences":[],"must_visit":[],"pace":"悠闲|适中|特种兵",'
            '"transportation":"自驾|高铁|飞机|本地",'
            '"dietary_restrictions":[],"avoidances":[],'
            '"start_date":"","origin":""}。'
            "缺省字段用合理默认值，preferences 取值限于：人文历史/自然风光/美食/娱乐；"
            "must_visit 为用户特别想去的景点名列表（如「想去雷峰塔和西湖」应提取为 [\"雷峰塔\",\"西湖\"]），无则留空。"
        )
        data = self.llm.chat_json(system, raw)
        if data is None:
            return None
        try:
            return UserPreference.model_validate(data)
        except Exception:
            return None

    # ---------------- 规则抽取（降级）----------------
    def parse_partial(self, raw: str) -> dict[str, Any]:
        """**只返回文字里真的说到的字段**，没提到的键根本不出现。

        和 _parse_rules 的区别很关键：_parse_rules 返回的是完整画像，
        没提到的字段也会被填上默认值（travelers 默认 1 人、preferences 默认
        ["人文历史","自然风光"]）。所以拿它的结果无法判断"用户到底说没说这一项"。

        这里要判断的是"输入框优先"：用户在输入框里说的话，要盖过气泡里点过的
        选项，但**只能盖过他真说到的那些字段** —— 否则输入框里随便一句话就会把
        气泡选的城市/天数一起冲掉。

        规则与 _parse_rules 同源（同一套正则），改的时候两边要一起改；
        _parse_rules 现在就是基于这个函数实现的。
        """
        out: dict[str, Any] = {}

        # 目的地：优先认"已知城市名"，其次才是「去/到/游/玩 + 地名」。
        #
        # 为什么把城市名放前面：光靠动词正则，像「苏州 · 3 天」这种没有动词的句子
        # 根本认不出城市，而「想去雷峰塔和西湖，杭州，2天」会被抓成
        # destination="雷峰塔和西湖"（把景点当成了城市）。
        # 这两句都是实际会出现的输入，所以先扫已知城市名更稳。
        m = re.search(r"(?:去|到|游|玩)\s*([一-龥]{2,8})", raw)
        verb_city = m.group(1).rstrip("市县") if m else ""
        hit_city = next((c for c in _KNOWN_CITIES if c in raw), "")
        if hit_city:
            out["destination"] = hit_city
        elif verb_city:
            out["destination"] = verb_city

        # 人数与同行人构成（阿拉伯数字与中文数字都认，中间允许「个/位」：
        # 「两个人」「3个人」「三位」都是常见说法）
        m = re.search(rf"({_CN_NUM_RE})\s*[个位]?\s*人", raw)
        hit_people = bool(m) or bool(re.search(r"情侣|夫妻|两口子|二人|两人|双人", raw)) \
            or bool(re.search(r"老人|奶奶|爷爷|外婆|外公|[7-9]0岁", raw)) \
            or bool(re.search(r"小孩|孩子|儿童|宝宝", raw))
        if hit_people:
            total = _cn_to_int(m.group(1)) if m else None
            if re.search(r"情侣|夫妻|两口子|二人|两人|双人", raw):
                total = 2
            if not total:
                total = 1
            elderly = 1 if re.search(r"老人|奶奶|爷爷|外婆|外公|[7-9]0岁", raw) else 0
            children = 1 if re.search(r"小孩|孩子|儿童|宝宝", raw) else 0
            adults = max(total - elderly - children, 0) if (elderly or children) else total
            out["travelers"] = {"adults": adults, "children": children, "elderly": elderly}

        # 天数
        m = re.search(rf"({_CN_NUM_RE})\s*天", raw)
        if m:
            n = _cn_to_int(m.group(1))
            if n:
                out["duration_days"] = n

        # 预算（支持「2000元」与「预算2000」两种写法）
        m = re.search(r"(\d+)\s*(?:元|块钱|块)", raw) or re.search(r"预算\s*(\d+)", raw)
        if m:
            out["budget"] = float(m.group(1))

        # 特别想去的景点
        m = re.search(r"(?:想去|必去|一定要去|特别想去)\s*([^。，,；;]+)", raw)
        if m:
            seg = re.split(r"[、，,和与及]|\s+", m.group(1))
            names = [s.strip(" 的了啊呀吧").strip() for s in seg if s.strip()]
            if names:
                out["must_visit"] = names

        # 兴趣导向
        tags = []
        if re.search(r"人文|历史|文化|古迹|博物馆", raw):
            tags.append("人文历史")
        if re.search(r"自然|风光|山水|风景|公园", raw):
            tags.append("自然风光")
        if re.search(r"美食|小吃|餐厅|吃", raw):
            tags.append("美食")
        if re.search(r"娱乐|演出|主题|乐园", raw):
            tags.append("娱乐")
        if tags:
            out["preferences"] = tags

        # 节奏
        if re.search(r"特种兵|紧凑|打卡|暴走", raw):
            out["pace"] = "特种兵"
        elif re.search(r"悠闲|轻松|躺平|慢|度假", raw):
            out["pace"] = "悠闲"

        # 交通
        if "自驾" in raw:
            out["transportation"] = "自驾"
        elif "高铁" in raw:
            out["transportation"] = "高铁"
        elif "飞机" in raw or "航班" in raw:
            out["transportation"] = "飞机"

        # 饮食禁忌
        diet = []
        if re.search(r"海鲜|过敏", raw):
            diet.append("海鲜")
        if "清真" in raw:
            diet.append("清真")
        if "素食" in raw:
            diet.append("素食")
        if diet:
            out["dietary_restrictions"] = diet

        # 避雷
        avoid = []
        if "爬山" in raw:
            avoid.append("爬山")
        if "排队" in raw:
            avoid.append("排队")
        if "网红" in raw:
            avoid.append("网红打卡")
        if avoid:
            out["avoidances"] = avoid

        return out

    def _parse_rules(self, raw: str) -> UserPreference:
        """基于 parse_partial 拼出完整画像（没提到的字段留默认值，行为与原来一致）。

        注意 destination 这里**仍然用原来的动词正则**，没有跟着 parse_partial 走
        「优先认已知城市名」：那是给"输入框优先"那条新路用的。
        组员这套规则解析的行为保持原样，免得悄悄改掉别的链路的输出。
        """
        pref = UserPreference()
        m = re.search(r"(?:去|到|游|玩)\s*([一-龥]{2,8})", raw)
        if m:
            pref.destination = m.group(1).rstrip("市县")

        p = self.parse_partial(raw)
        p.pop("destination", None)     # 上面已经按原语义处理过
        # 没提到同行人时保持原来的默认：1 名成人
        t = p.get("travelers") or {"adults": 1, "children": 0, "elderly": 0}
        pref.travelers = Travelers(**t)
        if "duration_days" in p:
            pref.duration_days = p["duration_days"]
        if "budget" in p:
            pref.budget = p["budget"]
        if "must_visit" in p:
            pref.must_visit = p["must_visit"]
        pref.preferences = p.get("preferences") or ["人文历史", "自然风光"]
        if "pace" in p:
            pref.pace = p["pace"]
        if "transportation" in p:
            pref.transportation = p["transportation"]
        pref.dietary_restrictions = list(p.get("dietary_restrictions") or [])
        pref.avoidances = list(p.get("avoidances") or [])
        return pref
