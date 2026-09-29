"""离线自检脚本：用桩替换大模型与高德，跑通整条 Skill 链。

不联网、不依赖 Ollama，用来验证流水线逻辑：意图抽取 → 规划 → 体检，
包括去重（临时数据结构）、综合分选址、预算计算、问题汇总，
以及"缺关键信息 / 未接入大模型"时是否按预期明确报错。

用法（在 backend 目录下）：
    .venv\\Scripts\\python.exe scripts\\offline_check.py
"""
import json
import logging
import sys
from pathlib import Path

# 允许直接以 `python scripts/offline_check.py` 运行：把 backend 目录加入模块搜索路径
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")  # 避免 Windows 控制台按 GBK 输出导致中文乱码
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

from app.models.plan import Weather
from app.orchestrator import Orchestrator
from app.skills.errors import LLMUnavailableError, MissingRequiredInfoError


def attraction(pid, name, lng, lat, rating, photos=0, cost=None, weight=None):
    biz = {"rating": str(rating)}
    if cost is not None:
        biz["cost"] = str(cost)
    item = {
        "id": pid,
        "name": name,
        "location": f"{lng},{lat}",
        "cityname": "杭州市",
        "adname": "西湖区",
        "address": f"{name}地址",
        "biz_ext": biz,
        "photos": [{"title": "p"} for _ in range(photos)],
    }
    if weight:
        item["weight"] = weight
    return item


ATTRACTIONS = [
    attraction("A1", "西湖", 120.150, 30.250, 4.8, photos=8, weight="9.5"),
    attraction("A2", "灵隐寺", 120.100, 30.240, 4.6, photos=5, weight="8.0"),
    attraction("A3", "雷峰塔", 120.152, 30.231, 4.5, photos=3, weight="7.0"),
    attraction("A4", "浙江省博物馆", 120.160, 30.260, 4.7, photos=2),
    attraction("A5", "西溪湿地", 120.060, 30.270, 4.6, photos=4),
    attraction("A6", "河坊街", 120.170, 30.240, 4.4, photos=1),
]

RESTAURANTS = [
    attraction("R1", "楼外楼", 120.148, 30.248, 4.7, cost=180),
    attraction("R2", "外婆家", 120.155, 30.252, 4.6, cost=80),
    attraction("R3", "知味观", 120.168, 30.238, 4.5, cost=60),
    attraction("R4", "绿茶餐厅", 120.098, 30.242, 4.4, cost=70),
    attraction("R5", "新白鹿", 120.062, 30.268, 4.3, cost=55),
]

HOTELS = [
    attraction("H1", "杭州西湖国宾馆", 120.146, 30.246, 4.8),
    attraction("H2", "如家酒店(西湖店)", 120.158, 30.250, 4.4),
    attraction("H3", "西溪民宿", 120.061, 30.271, 4.2),
]


class FakeAmap:
    key = "fake"

    def resolve_region(self, destination, adcode=""):
        return "杭州市", "杭州市"

    def input_tips(self, keywords, city=""):
        return []

    def search_poi(self, keywords=None, city=None, types=None, offset=20, page=1):
        if page > 1:
            return []
        if types:
            return ATTRACTIONS
        if keywords in ("餐厅", "小吃", "本地菜", "特色美食"):
            return RESTAURANTS if keywords == "餐厅" else []
        if keywords in ("酒店",):
            return HOTELS
        return []

    def get_route(self, origin, destination, mode="walking"):
        """模拟驾车路线。

        必须带 distance 字段：体检的「当天里程」和「绕行判定」现在都读它，
        缺了就退回直线距离，离线环境下就测不到新逻辑。
        这里按直线距离的 1.3 倍模拟（低于 1.5 的绕行阈值，不产生误报）。
        """
        import math

        lng1, lat1 = (float(v) for v in origin.split(","))
        lng2, lat2 = (float(v) for v in destination.split(","))
        dx = (lng2 - lng1) * 111.32 * math.cos(math.radians((lat1 + lat2) / 2))
        dy = (lat2 - lat1) * 110.57
        road_m = int(math.hypot(dx, dy) * 1.3 * 1000)
        return {
            "route": {
                "taxi_cost": "22.5",
                "paths": [{"duration": "1500", "distance": str(road_m)}],
            }
        }


class FakeWeather:
    def forecast(self, city, days=7):
        return {
            "2026-09-23": Weather(condition="晴", temp="22-30℃"),
            "2026-09-24": Weather(condition="小雨", temp="21-27℃"),
            "2026-09-25": Weather(condition="阴", temp="20-26℃"),
        }


class FakeLLM:
    """按系统提示词区分调用方：意图抽取 / 规划 / 体检。"""

    def __init__(self, available=True):
        self._available = available
        self.calls = []
        self.last_error = ""

    def available(self):
        return self._available

    def chat_json(self, system, user, options=None, timeout=None, model=None):
        if "结构化助手" in system:
            self.calls.append("intent")
            return {
                "travelers": {"adults": 2, "children": 0, "elderly": 1},
                "destination": "杭州",
                "duration_days": 3,
                "budget": 2000,
                "preferences": ["人文历史", "自然风光"],
                "must_visit": ["雷峰塔"],
                "pace": "特种兵",
                "transportation": "高铁",
                "start_date": "2026-09-23",
            }
        if "景点挑选助手" in system:
            self.calls.append("planner")
            return {
                "summary": "杭州3日人文自然游",
                "attractions": [
                    {"name": "西湖", "tips": "清晨人少"},
                    {"name": "雷峰塔", "tips": ""},
                    # 同一片景区的别名（雷峰塔景区 vs 雷峰塔）：应被临时结构拦下
                    {"name": "雷峰塔景区", "tips": ""},
                    {"name": "灵隐寺", "tips": ""},
                    # 不在候选池：应被拦下并提示
                    {"name": "上海外滩", "tips": ""},
                ],
                # 模型点名"值得专门去吃"的店：应被优先排进时间轴
                "dining": [
                    {"name": "楼外楼", "tips": "西湖边老字号，值得专门去"},
                    {"name": "并不存在的店", "tips": ""},
                ],
            }
        if "审稿人" in system:
            self.calls.append("check")
            #: 记下体检实际收到的数据，供离线检查断言"用户原话有没有带进去"
            self.last_check_payload = json.loads(user)
            return {
                "passed": False,
                "summary": "整体可行，个别点位偏赶",
                "issues": [
                    {
                        "category": "时间",
                        "severity": "medium",
                        "message": "第1天上午连排两个大景点偏赶",
                        "suggestion": "可把雷峰塔挪到下午",
                    },
                    {
                        # 与事实矛盾（住宿费其实有），应被事实校验过滤掉
                        "category": "预算",
                        "severity": "high",
                        "message": "预算未包含住宿费用",
                        "suggestion": "补上住宿费",
                    },
                    {
                        # 轻微夸大（2 公里内不算远），应被事实校验过滤掉
                        "category": "路径",
                        "severity": "medium",
                        "message": "第1天从西湖到雷峰塔距离较远，约 1.5 公里",
                        "suggestion": "换成更近的点",
                    },
                    {
                        # 说"没安排"，但西湖明明在行程里 → 应被过滤掉
                        "category": "覆盖",
                        "severity": "high",
                        "message": "用户想去的西湖未被安排在行程中",
                        "suggestion": "把西湖加进去",
                    },
                    {
                        # 归到"时间"类、但其实是重复的误报 → 同样应被过滤掉
                        "category": "时间",
                        "severity": "high",
                        "message": "西湖在 2026-09-23 被安排，但 2026-09-24 又安排了一次",
                        "suggestion": "去掉重复",
                    },
                    {
                        # 距离说法与真实坐标差距过大（西湖与雷峰塔实际约 2 公里）→ 应被过滤掉
                        "category": "路径",
                        "severity": "high",
                        "message": "2026-09-23 的行程中，西湖和雷峰塔相距超过 40 公里",
                        "suggestion": "换掉其中一个",
                    },
                    {
                        # 说某景点出现在两天，但实际没有 → 应被过滤掉
                        "category": "时间",
                        "severity": "high",
                        "message": "雷峰塔被安排在了 2026-09-23 和 2026-09-25 的行程中",
                        "suggestion": "去掉一次",
                    },
                    {
                        # 不带数字的"距离较远"，但两点实际约 2 公里 → 应被过滤掉
                        "category": "路径",
                        "severity": "medium",
                        "message": "第一天从雷峰塔到西湖的步行距离较远，建议优化",
                        "suggestion": "换个近点",
                    },
                ],
            }
        if "旅游需求修订助手" in system:
            # 对话式修改：在既有画像上只改用户提到的字段
            self.calls.append("revise")
            payload = json.loads(user)
            pref = dict(payload["当前画像"])
            pref["budget"] = 2500
            pref["pace"] = "悠闲"
            return pref
        return None


def build(available=True):
    llm = FakeLLM(available=available)
    orch = Orchestrator()
    orch.intent.llm = llm
    orch.planner.llm = llm
    orch.check.llm = llm
    orch.retrieve.amap = FakeAmap()
    # planner 也要换成假客户端：它内部会自己 new 一个真 AmapClient，
    # 不换的话所谓「离线检查」里的路线查询会真的打到高德去。
    orch.planner.amap = orch.retrieve.amap
    orch.retrieve.weather_svc = FakeWeather()
    return orch, llm


def main():
    # 0) 确定性用例：08:30 出发 + 只有 2 个景点时，午餐不能被排到下午
    from app.models.plan import Location, POI
    from app.models.preference import MustVisit, Travelers, UserPreference
    from app.skills.planner_skill import PlannerSkill

    def poi(name, kind, lat, lng):
        return POI(name=name, type=kind, location=Location(lat=lat, lng=lng))

    early = UserPreference(
        destination="杭州", duration_days=1, budget=1000,
        travelers=Travelers(adults=2), preferences=["人文历史"],
        pace="悠闲", departure_time="08:30", return_hotel_time="20:00",
    )
    sim = PlannerSkill(llm=FakeLLM(), amap=FakeAmap())
    items, _end, _used = sim._simulate_day(
        early,
        [poi("A景点", "景点", 30.25, 120.15), poi("B景点", "景点", 30.26, 120.16)],
        None,
        None,
        [poi("餐厅1", "餐厅", 30.251, 120.151), poi("餐厅2", "餐厅", 30.252, 120.152)],
        set(),
        8 * 60 + 30,
        [],
    )
    print(
        "== 08:30 出发 / 2 个景点的时间轴 ==",
        [(i.time, i.poi.type, i.poi.name) for i in items],
    )
    lunch = next((i for i in items if i.poi.type == "餐厅"), None)
    lunch_start = int(lunch.time.split("-")[0].split(":")[0]) * 60 + int(lunch.time.split("-")[0].split(":")[1]) if lunch else -1
    print("午餐开始时间:", lunch.time.split("-")[0] if lunch else "无", "| 是否晚于 14:00:", lunch_start > 14 * 60)

    # 1) 正常路径：应生成 3 天行程，并把重复/超范围景点记进体检问题
    orch, llm = build()
    plan = orch.run(raw_text="带80岁老人特种兵游杭州，3天，预算2000，想去雷峰塔")
    print("== LLM 调用顺序 ==", llm.calls)
    print("== 摘要 ==", plan.summary)
    print("== 预算 ==", plan.total_budget_estimate, plan.budget_breakdown.model_dump())
    for day in plan.daily_plans:
        print(
            f"-- {day.date} {day.weather.condition} 酒店={day.hotel.name if day.hotel else None}",
            [(it.time, it.poi.type, it.poi.name) for it in day.timeline],
            "plan_b=", day.plan_b,
        )
    print("== 体检 passed ==", plan.checks.passed)
    for issue in plan.checks.issues:
        print("  -", issue.category, issue.severity, issue.message)
    print(
        "== 体检收到的数据 ==",
        "用户原话已带上:",
        bool((getattr(llm, "last_check_payload", {}) or {}).get("用户原话")),
        "| 已无「讨厌的项目」字段:",
        "讨厌的项目" not in (getattr(llm, "last_check_payload", {}) or {}),
    )

    # 2) 对话式修改：应在既有画像上只改提到的字段，并重新生成
    orch_r, llm_r = build()
    plan_v1 = orch_r.run(raw_text="带80岁老人特种兵游杭州，3天，预算2000，想去雷峰塔")
    plan_v2 = orch_r.revise("预算压到 2500，节奏改成悠闲", plan_v1)
    print(
        "== 对话式修改 ==",
        "LLM 调用:", llm_r.calls,
        "| 新画像预算:", plan_v2.user_preference.budget,
        "节奏:", plan_v2.user_preference.pace,
        "| 传送给前端可继续改:", plan_v2.user_preference is not None,
        "| 交通口径:", bool(plan_v2.transport_note),
    )

    # 3) 兴趣留空 = 全部类别都检索；必去景点带坐标（前端下拉选定）时直接用坐标
    orch_m, _ = build()
    pref_m = UserPreference(
        destination="杭州",
        duration_days=2,
        budget=3000,
        travelers=Travelers(adults=2),
        preferences=[],  # 用户没表达兴趣：应保持空，不再由大模型推断
        must_visit=[MustVisit(name="九溪烟树", lat=30.1111, lng=120.2222)],
        pace="适中",
    )
    plan_m = orch_m.run(preference=pref_m)
    found_m = next(
        (it.poi for d in plan_m.daily_plans for it in d.timeline if it.poi.name == "九溪烟树"),
        None,
    )
    print(
        "== 兴趣留空 / 必去带坐标 ==",
        "候选景点数:", len(plan_m.attraction_options),
        "| 必去已入行程:", found_m is not None,
        "| 用的是下拉坐标:",
        found_m is not None
        and (found_m.location.lat, found_m.location.lng) == (30.1111, 120.2222),
        "| 摘要:", plan_m.summary,
    )

    # 4) 必去景点只有名字、又定位不到：应点名提示，而不是悄悄留个没坐标的条目
    pref_u = UserPreference(
        destination="杭州",
        duration_days=1,
        budget=2000,
        travelers=Travelers(adults=2),
        preferences=["人文历史"],
        must_visit=[MustVisit(name="子虚乌有景点")],
        pace="适中",
    )
    plan_u = orch_m.run(preference=pref_u)
    unlocated_issues = [
        i for i in plan_u.checks.issues if i.category == "地点" and "没能定位" in i.message
    ]
    print(
        "== 必去景点定位不到 ==",
        [i.message for i in unlocated_issues] or "!! 没有提示（应该有一条）",
    )

    # 5) 同行有老人时，体力消耗大的景点应被提示（这条以前写在 GuardSkill，永远不触发）
    pref_old = UserPreference(
        destination="杭州",
        duration_days=2,
        budget=3000,
        travelers=Travelers(adults=1, elderly=1),
        preferences=["自然风光"],
        pace="悠闲",
    )
    arduous_issues: list = []
    PlannerSkill._note_arduous_for_elderly(
        pref_old, [poi("北高峰", "景点", 30.25, 120.12)], arduous_issues
    )
    PlannerSkill._note_arduous_for_elderly(
        pref_old, [poi("浙江省博物馆", "景点", 30.25, 120.12)], arduous_issues
    )
    print("== 老人 + 爬山类景点 ==", [i.message for i in arduous_issues])

    # 7) 真实数据回归：平潭那份规划暴露的三个问题（重复条目 / 排序不看终点 / 跨天分组）
    #    坐标与评分都取自那份实际生成的规划（plans 表里的 2b22ae4d）。
    from app.models.plan import Location, POI as _POI
    from app.skills.dedupe import dedupe_attractions, same_spot
    import app.skills.route as route_mod
    from app.skills.route import cluster_into_days, order_nearest, total_distance_km

    def pt(name, lng, lat, rating):
        return _POI(name=name, type="景点", location=Location(lat=lat, lng=lng), rating=rating)

    pingtan = [
        pt("平潭长江澳·沙滩", 119.791879, 25.608704, None),      # 用户点名的必去（下拉选的，没有评分）
        pt("平潭国际旅游岛·长江澳", 119.791215, 25.608958, 4.7),
        pt("长江澳风力发电景观区", 119.775351, 25.629992, 4.6),
        pt("镜沙黑洞", 119.806367, 25.616370, 4.7),
        pt("镜沙黑石滩", 119.809925, 25.614225, 4.5),
        pt("星辰大海·镜沙", 119.813611, 25.615767, 4.8),
        pt("风车森林公路", 119.779997, 25.659455, 4.7),
        pt("北部生态廊道F2观景台", 119.770865, 25.655772, 4.7),
        pt("国彩村童话小镇", 119.774001, 25.641224, 4.4),
    ]
    kept, merge_notes = dedupe_attractions(pingtan, protect_names=["平潭长江澳·沙滩"])
    print(f"== 平潭去重 == {len(pingtan)} 个候选 → {len(kept)} 个真实地点")
    for note in merge_notes:
        print(f"   {note['merged']} → 保留 {note['kept']}（{note['reason']}）")
    must_kept = "平潭长江澳·沙滩" in {p.name for p in kept}
    print(f"   必去景点是否保留: {must_kept}（它没有评分，不保护就会被 4.7 的别名挤掉）")

    # 反例：不能误杀。这两对"有点像"，但不该被判成同一处
    near_prefix = (
        pt("平潭坛南湾", 119.78, 25.600, 4.5),
        pt("平潭北港村", 119.80, 25.630, 4.5),
    )
    far_same_name = (
        pt("千岛湖中心湖区", 119.03, 29.60, 4.6),
        pt("千岛湖东南湖区", 119.20, 29.50, 4.6),
    )
    print(
        "   地名前缀不误杀(平潭坛南湾/平潭北港村):",
        same_spot(*near_prefix) is None,
        "| 异地同名不误杀(两个千岛湖湖区):",
        same_spot(*far_same_name) is None,
    )

    # 把当晚酒店作为路径终点：否则会出现"玩到很晚，结果离酒店还有七八公里"
    start = pt("起点(前一晚酒店)", 119.80, 25.600, None)
    end = pt("终点(当晚酒店)", 119.80, 25.700, None)
    day_pts = [
        pt("A近起点", 119.80, 25.610, None),
        pt("B近终点", 119.80, 25.690, None),
        pt("C东侧远点", 119.90, 25.650, None),
    ]
    no_end = order_nearest(day_pts, start)
    with_end = order_nearest(day_pts, start, end)
    km_no = total_distance_km([start] + no_end + [end])
    km_with = total_distance_km([start] + with_end + [end])
    print(f"== 排序是否看终点 == 不看终点 {[p.name for p in no_end]} → {km_no:.1f}km")
    print(f"                      看终点   {[p.name for p in with_end]} → {km_with:.1f}km")

    # 分天算法：拿一份真实规划里被选中的 9 个景点做回归。
    # 老算法（从种子往外长）把它们分成：
    #   第1天 长江澳(海湾) + 国彩村童话小镇 + 童话小镇s弯
    #   第2天 镜沙黑洞 + 镜沙黑石滩 + 星辰大海·镜沙
    #   第3天 北部生态廊道F2观景台 + 风车森林公路 + 北港村 ← 单天跨度 8.3 公里
    # 第 3 天就是用户抱怨的「一天横跨全城」：北港村在最南边，另外两个在最北边。
    real9 = [
        pt("长江澳", 119.779511, 25.626095, None),
        pt("国彩村童话小镇", 119.774001, 25.641224, 4.4),
        pt("童话小镇s弯", 119.771577, 25.645477, 4.6),
        pt("镜沙黑洞", 119.806367, 25.616370, 4.7),
        pt("镜沙黑石滩", 119.809925, 25.614225, 4.5),
        pt("星辰大海·镜沙", 119.813611, 25.615767, 4.8),
        pt("北部生态廊道F2观景台", 119.770865, 25.655772, 4.7),
        pt("风车森林公路", 119.779997, 25.659455, 4.7),
        pt("北港村", 119.828741, 25.584804, 4.7),
    ]
    old_days = [real9[0:3], real9[3:6], real9[6:9]]

    def max_span(groups):
        """单天内部的最大跨度（组内任意两点的最远距离）。"""
        worst = 0.0
        for group in groups:
            for i in range(len(group)):
                for j in range(i + 1, len(group)):
                    d = route_mod.distance_km(group[i], group[j])
                    if d is not None and d > worst:
                        worst = d
        return worst

    new_days = cluster_into_days(real9, 3, 3, {"长江澳"})
    print(
        f"== 分天算法 == 单天最大跨度 老算法 {max_span(old_days):.1f}km"
        f" → 链式分天 {max_span(new_days):.1f}km"
    )
    for i, group in enumerate(new_days, 1):
        print(f"   第{i}天: {[p.name for p in group]}")
    day_of = {
        p.name: i for i, group in enumerate(new_days, 1) for p in group
    }
    wind, north = day_of["风车森林公路"], day_of["北部生态廊道F2观景台"]
    print(
        f"   风车森林公路在第 {wind} 天、北部生态廊道F2在第 {north} 天 → "
        f"{'同一天 ✓（老算法把它们分在两天，相距仅 1.0 公里）' if wind == north else '仍被分开 ✗'}"
    )

    # 8) 饮食禁忌：只保留"判得准"的那部分
    #    （排斥项已整个删掉：画像字段、意图抽取、体检提示词、前端选项，见 constraints.py）
    from app.skills.constraints import restaurant_excluded

    seafood = pt("海鲜大排档", 119.79, 25.61, 4.6)
    plain = pt("外婆家", 119.80, 25.61, 4.5)
    excluded = restaurant_excluded(seafood.name, ["无海鲜"])
    print(
        "== 饮食禁忌 ==",
        f"「{seafood.name}」→ {'排除（' + excluded + '）' if excluded else '保留'}；"
        f"「{plain.name}」→ {'排除' if restaurant_excluded(plain.name, ['无海鲜']) else '保留'}",
    )

    # 酒店按切点选：应该选挨着切点的那家，而不是"评分最高但在几十公里外"的那家
    hotels = [
        pt("挨着切点的酒店", 100.10, 25.60, 4.2),
        pt("很远但评分高的酒店", 100.50, 25.90, 4.9),
    ]
    for item in hotels:
        item.type = "住宿"
    cut_prev, cut_next = pt("当天末景点", 100.11, 25.60, 4.5), pt("次日首景点", 100.12, 25.61, 4.5)
    best_hotel = PlannerSkill._best_hotel_at_cut(hotels, cut_prev, cut_next, None)
    print("== 酒店按切点选 ==", best_hotel.name, f"（评分 {best_hotel.rating}）")

    # 9) 成链后的「跨度 + 配套」校验：点集本身不成形时，成链也救不回来
    def mk(name, lng, lat, rating=4.6):
        return _POI(name=name, type="景点", location=Location(lat=lat, lng=lng), rating=rating)

    orch_fix, _ = build()
    # ① 跨度：三个点挤在市区，第四个点被甩到 50 公里外（评分还最高）
    pool_span = [
        mk("市区A", 120.150, 30.250), mk("市区B", 120.160, 30.260),
        mk("市区C", 120.155, 30.255), mk("市区D", 120.152, 30.252),
        mk("远郊X", 120.600, 30.600, 4.9), mk("远郊Y", 120.580, 30.580),
    ]
    span_issues: list = []
    fixed_span = orch_fix.planner._fix_day_quality(
        [pool_span[0], pool_span[1], pool_span[3], pool_span[4]],
        1, 4, set(), pool_span, [], [], None, span_issues,
    )
    print("== 跨度校验 ==", [p.name for p in fixed_span],
          "|", span_issues[0].message if span_issues else "!! 没有提示")

    # ② 配套：有个景点 5 公里内没有任何餐厅
    pool_am = [
        mk("近店A", 120.150, 30.250), mk("近店B", 120.152, 30.251),
        mk("近店D", 120.153, 30.252),
        mk("荒郊C", 120.300, 30.400, 4.8),
    ]
    dining_am = [mk("附近餐厅", 120.151, 30.251)]
    amenity_issues: list = []
    fixed_am = orch_fix.planner._fix_day_quality(
        [pool_am[0], pool_am[1], pool_am[3]],
        1, 3, set(), pool_am, dining_am, [], None, amenity_issues,
    )
    print("== 配套校验 ==", [p.name for p in fixed_am],
          "|", amenity_issues[0].message if amenity_issues else "!! 没有提示")

    # ③ 必去景点再离谱也不许替换，但要说清楚
    must_issues: list = []
    fixed_must = orch_fix.planner._fix_day_quality(
        [pool_span[0], pool_span[1], pool_span[4]],
        1, 3, {"远郊X"}, pool_span, [], [], None, must_issues,
    )
    print("== 跨度校验(必去不换) ==", [p.name for p in fixed_must],
          "|", must_issues[0].message if must_issues else "!! 没有提示")

    # 10) 营业时间校验 + 本地特色统计（高德本来就给了 open_time / atag，以前直接丢掉）
    from app.skills.opening_hours import fits_open_time
    from app.skills.scoring import is_local_specialty, local_specialty_keywords

    print(
        "== 营业时间校验 ==",
        "10:30-17:30 的店，晚餐 17:30-19:00 能吃吗:",
        fits_open_time("10:30-17:30", 17 * 60 + 30, 90),
        "| 10:00-03:00 的店，晚餐 18:00-19:30:", fits_open_time("10:00-03:00", 18 * 60, 90),
        "| 读不懂的一律放行:", fits_open_time("", 18 * 60, 90),
    )
    # 本地特色：从招牌菜标签里统计（零人工）
    ptown_dine = [
        _POI(name="海先生大排档·平潭老字号·海鲜·烧烤", type="餐厅",
             location=Location(lat=25.50, lng=119.79), rating=4.6,
             tags=["海鲜", "大排档", "椒盐皮皮虾"]),
        _POI(name="老工会大排档·29年老字号", type="餐厅",
             location=Location(lat=25.51, lng=119.80), rating=4.5,
             tags=["海鲜", "大排档"]),
        _POI(name="今天不上班·海鲜大排档", type="餐厅",
             location=Location(lat=25.52, lng=119.81), rating=4.4,
             tags=["海鲜", "大排档", "双人餐"]),
        _POI(name="麦当劳(龙王头海洋公园店)", type="餐厅",
             location=Location(lat=25.53, lng=119.82), rating=4.6, tags=["汉堡"]),
    ]
    kws = local_specialty_keywords(ptown_dine)
    print("== 本地特色统计 ==", kws)
    print(
        "   老字号大排档算本地特色:", is_local_specialty(ptown_dine[0], kws),
        "| 麦当劳算本地特色:", is_local_specialty(ptown_dine[3], kws),
    )

    # 10.5) 选餐的"内容优先"：景点门口的连锁快餐 vs 附近的本地老店
    from app.skills.scoring import is_chain_dining, meal_score

    def eat(name, lat, lng, rating, *, cuisine="中餐厅", tags=()):
        return _POI(name=name, type="餐厅", cuisine=cuisine,
                    location=Location(lat=lat, lng=lng), rating=rating, tags=list(tags))

    # 链上前后两点：长江澳（北）与龙王头海洋公园（城区）
    link_prev = mk("长江澳", 119.79, 25.63, 4.6)
    link_next = mk("龙王头海洋公园", 119.80, 25.50, 4.7)
    mcd = eat("麦当劳(龙王头海洋公园店)", 25.4996, 119.8002, 4.6,
              cuisine="西式快餐", tags=["汉堡", "快餐"])
    # 5 家更近的连锁店：用来验证"只按距离取前 5 家"时本地老店会不会被挤掉
    blockers = [
        eat(f"连锁快餐{i}", 25.4998 + i * 0.0004, 119.8001, 4.5,
            cuisine="西式快餐", tags=["快餐"])
        for i in range(1, 6)
    ]
    local_near = eat("海先生大排档·平潭老字号·海鲜·烧烤", 25.478, 119.798, 4.7,
                     cuisine="中餐厅", tags=["海鲜", "大排档"])
    # 同一家店、但挪到 6 公里外：超出内容通道半径，应当老老实实让位给连锁店
    local_far = eat("海先生大排档·平潭老字号·海鲜·烧烤", 25.445, 119.796, 4.7,
                    cuisine="中餐厅", tags=["海鲜", "大排档"])

    def pick(pool, featured=()):
        return PlannerSkill._pick_meal(
            pool, set(), link_prev, link_next, None,
            12 * 60, 60, kws, list(featured),
        )

    near_pick = pick(blockers + [mcd, local_near])
    far_pick = pick(blockers + [mcd, local_far])
    print(
        "== 选餐内容优先 ==",
        "门口的麦当劳 + 5 家更近的连锁店 + 2.5 公里外的本地老店 →",
        near_pick.name,
        "|",
        "本地老店挪到 6 公里外 →",
        far_pick.name,
    )
    print(
        "   连锁识别:", is_chain_dining(mcd, kws), "（麦当劳）| 本地特色店不会被误判为连锁:",
        not is_chain_dining(local_near, kws),
        "| 店名带 Coffee 的海景咖啡厅也算通用餐饮:",
        is_chain_dining(eat("又一·Youyi Sea Coffee", 25.50, 119.80, 4.7), kws),
        "| 离链 2.5 公里时的分差:",
        f"{meal_score(local_near, link_prev, link_next, None, kws) - meal_score(mcd, link_prev, link_next, None, kws):+.2f}",
    )

    # 10.6) 内容店不被"微调"换掉：模型点名"值得专门去吃"的店，不能被纯几何优化挤走
    day_seq = [
        mk("龙王头海洋公园", 119.80, 25.50, 4.7),
        eat("海先生大排档·平潭老字号·海鲜·烧烤", 119.798, 25.478, 4.7,
            cuisine="中餐厅", tags=["海鲜", "大排档"]),
        mk("澳前台湾小镇", 119.83, 25.48, 4.5),
    ]
    day_seq[1].open_time = "10:00-23:00"
    mcd_used = {day_seq[1].name}
    PlannerSkill._optimize_meals(
        day_seq, [mcd] + blockers, mcd_used, None, {1: 12 * 60}, 60, kws, [day_seq[1]],
    )
    print(
        "== 内容店不被微调换掉 ==", day_seq[1].name,
        "→", "仍然在时间轴上 ✓" if day_seq[1].name.startswith("海先生") else "被换掉了 ✗",
    )

    # 10.7) 内容店也要有绕路额度：模型点名的店离得太远时，这一顿仍按就近挑
    near_a = mk("甲景点", 119.80, 25.50, 4.5)
    near_b = mk("乙景点", 119.81, 25.50, 4.5)
    plain_shop = eat("挨着景点的普通店", 25.5001, 119.8010, 4.5)
    featured_near = eat("模型点名的老字号(近)", 25.5005, 119.8030, 4.9,
                        cuisine="中餐厅", tags=["海鲜", "大排档"])
    featured_far = eat("模型点名的老字号(远)", 25.46, 119.85, 4.9,
                       cuisine="中餐厅", tags=["海鲜", "大排档"])
    pick_near = PlannerSkill._pick_meal(
        [plain_shop, featured_near], set(), near_a, near_b, None, 12 * 60, 60, kws, [featured_near]
    )
    pick_far = PlannerSkill._pick_meal(
        [plain_shop, featured_far], set(), near_a, near_b, None, 12 * 60, 60, kws, [featured_far]
    )
    print(
        "== 内容店的绕路额度 ==",
        "点名店只多绕 0.1 公里 →", pick_near.name,
        "|", "点名店要多绕 10 公里 →", pick_far.name,
    )

    # 10.7) 体检误报：用户写"长江澳"，行程里用的是景点库正式名"平潭国际旅游岛·长江澳"，
    #       模型据此说"必去景点没排进去"——这类与事实矛盾的结论必须丢掉。
    from app.models.plan import CheckIssue
    from app.skills.check_skill import CheckSkill

    alias_plan = plan.model_copy(deep=True)
    alias_plan.user_preference = UserPreference(
        destination="平潭", duration_days=1, budget=1000,
        travelers=Travelers(adults=2), preferences=["自然风光"],
        must_visit=[MustVisit(name="长江澳")], pace="适中",
    )
    alias_plan.daily_plans[0].timeline[0].poi.name = "平潭国际旅游岛·长江澳"
    kept_issues = CheckSkill._drop_contradicted(
        [
            CheckIssue(category="覆盖", severity="medium",
                       message="必去景点长江澳未出现在行程中", suggestion="加进去"),
            CheckIssue(category="覆盖", severity="medium",
                       message="必去景点外星滩未出现在行程中", suggestion="加进去"),
        ],
        alias_plan,
    )
    print(
        "== 体检误报过滤（必去景点换了正式名）==",
        [i.message for i in kept_issues],
        "（应只剩「外星滩」那条）",
    )

    # 10.8) 体检的新判据：绕行跟"本趟基线"比，折返只看景点之间
    from types import SimpleNamespace

    from app.skills.route import day_route_stats_from_day

    def fake_day(points):
        """points = [(名称, 类型, 纬度, 经度, 到下一站的实际驾车公里 or None)]"""
        items = []
        for name, kind, lat, lng, road in points:
            item = SimpleNamespace(
                poi=_POI(name=name, type=kind,
                         location=Location(lat=lat, lng=lng), rating=4.5),
                transport_to_next=(None if road is None
                                   else SimpleNamespace(distance_km=road)),
            )
            items.append(item)
        return SimpleNamespace(timeline=items)

    # 直线 2.5 公里、实际 5.8 公里 → 绕 2.32 倍、多跑 3.3 公里
    detour_day = fake_day([
        ("甲", "景点", 30.00, 120.00, 5.8),
        ("乙", "景点", 30.00, 120.02594, None),
    ])
    plain = day_route_stats_from_day(detour_day)["detours"]
    island = day_route_stats_from_day(detour_day, road_baseline=2.15)["detours"]
    print(
        "== 绕行判据（跟本趟基线比）==",
        "直线 2.5 / 实际 5.8 公里（绕 2.3 倍、多跑 3.3 公里）：",
        f"基线 1.0（普通城市）→ 报 {len(plain)} 条；",
        f"基线 2.15（平潭实测）→ 报 {len(island)} 条（应为 0：岛上这就是常态）",
    )

    # 折返：餐厅插在中间多跑 19 公里 → 那是"要吃饭"，不是路线问题
    with_food = fake_day([
        ("景点甲", "景点", 30.00, 120.00, 9.6),
        ("餐厅乙", "餐厅", 30.00, 120.10, 9.6),
        ("景点丙", "景点", 30.001, 120.00, None),
    ])
    # 景点之间真绕回去了 → 必须报
    only_spots = fake_day([
        ("景点甲", "景点", 30.00, 120.00, 9.6),
        ("景点乙", "景点", 30.00, 120.10, 8.6),
        ("景点丙", "景点", 30.001, 120.00, None),
    ])
    print(
        "== 折返判据（只看景点之间）==",
        "餐厅插在中间 →", len(day_route_stats_from_day(with_food)["backtracks"]),
        "条（应为 0）| 景点之间绕回 →",
        len(day_route_stats_from_day(only_spots)["backtracks"]), "条（应为 1）",
    )

    # 10.9) 地域收敛：按行政区给的候选（千岛湖属杭州市）要按距离挡掉
    from app.skills.geo_gate import apply_gate, densest_center

    def spot(name, lat, lng):
        return _POI(name=name, type="景点",
                    location=Location(lat=lat, lng=lng), rating=4.6)

    # ① 杭州式：10 个点挤在市区，外加 2 个远郊点（33 公里 / 127 公里）
    hz = [spot(f"市区{i}", 30.25 + i * 0.012, 120.15 + i * 0.012) for i in range(10)]
    hz += [spot("青山湖景区", 30.235, 119.720), spot("千岛湖风景区", 29.600, 119.030)]
    hz_gate = apply_gate(hz, min_keep=9)
    print(
        "== 地域收敛（杭州式）==",
        f"阈值 {hz_gate.gate_km:.0f} 公里 → 保留 {len(hz_gate.kept)} 个，"
        + "切掉 " + "、".join(f"{p.name}({km:.0f}km)" for p, km in hz_gate.dropped),
    )

    # ② 平潭式：所有点都在 20 公里内 → 一个都不该切（岛屿城市别误伤）
    pt = [spot(f"岛上{i}", 25.50 + i * 0.02, 119.79 + i * 0.015) for i in range(10)]
    pt_gate = apply_gate(pt, min_keep=9)
    print(
        "== 地域收敛（平潭式）==",
        f"阈值 {pt_gate.gate_km:.0f} 公里 → 保留 {len(pt_gate.kept)} 个，切掉 {len(pt_gate.dropped)} 个（应为 0）",
    )

    # ③ 双簇（市区 + 远郊各一撮，必去点在远郊）：不该由系统决定砍哪一簇 → 不切
    two = [spot(f"市区{i}", 30.25 + i * 0.01, 120.15) for i in range(6)]
    two += [spot(f"湖区{i}", 29.60 + i * 0.01, 119.03) for i in range(6)]
    two_gate = apply_gate(two, must_pois=[two[6]], min_keep=9)
    print(
        "== 地域收敛（双簇 + 必去远郊点）==",
        f"切掉 {len(two_gate.dropped)} 个、保留 {len(two_gate.kept)} 个（应为 0 / 12，不替用户砍簇）",
        "| 最密集带中心算得出:", densest_center(two) is not None,
    )

    # 11) 权威名录 + 实时攻略检索（可选功能：不配也必须不影响主流程）
    from app.skills.authority import authority_names, match_authority
    from app.services.web_search import WebSearchClient

    print(
        "== 权威名录 ==",
        f"{len(authority_names())} 条",
        "| 杭州西湖风景名胜区 →", match_authority("杭州西湖风景名胜区"),
        "| 灵隐寺 →", match_authority("灵隐寺") or "未收录（正确，它不是 5A）",
    )
    off = WebSearchClient(mode="", url="", key="")
    print(
        "== 攻略检索（未配置）==",
        "enabled =", off.enabled,
        "| 返回", off.search("平潭 必去 攻略"),
        "（应为空，且不报错）",
    )

    # 12) 缺目的地：应直接提示用户
    orch2, _ = build()
    orch2.intent.llm = FakeLLM()
    orig = orch2.intent.llm.chat_json
    orch2.intent.llm.chat_json = lambda system, user, options=None, timeout=None, model=None: (
        {**orig(system, user), "destination": ""} if "结构化助手" in system else orig(system, user)
    )
    try:
        orch2.run(raw_text="帮我安排三天行程")
        print("!! 缺目的地时没有报错")
    except MissingRequiredInfoError as exc:
        print("== 缺目的地提示 ==", exc)

    # 13) 无大模型：应明确提示未接入，不降级
    orch3, _ = build(available=False)
    try:
        orch3.run(raw_text="杭州3天")
        print("!! 无大模型时没有报错")
    except LLMUnavailableError as exc:
        print("== 无大模型提示 ==", exc)

    # 14) 目的地范围解析：adcode 落到区级、但用户填的是市名时，不能把范围缩到那个区
    from app.services.amap import AmapClient

    class StubAmap(AmapClient):
        """只保留解析逻辑，不打网络（区县查询与父级城市查询都用桩）。"""

        def __init__(self):
            self.key = "stub"
            self.timeout = 1.0
            self._cache = {}
            self._cache_lock = None

        def _lookup_district(self, keywords):
            return {
                "330102": {"name": "上城区", "level": "district"},
                "杭州": {"name": "杭州市", "level": "city"},
                "杭州市": {"name": "杭州市", "level": "city"},
                "平潭": {"name": "平潭县", "level": "district"},
            }.get(keywords)

        def _city_of(self, adname):
            return {"上城区": "杭州市", "平潭县": "福州市"}.get(adname)

    stub = StubAmap()
    print(
        "== 目的地范围解析 ==",
        "「杭州市」+330102 →", stub.resolve_region("杭州市", "330102"),
        "|「上城区」+330102 →", stub.resolve_region("上城区", "330102"),
        "|「平潭」→", stub.resolve_region("平潭"),
    )

    # 15) 旧规划补图：必去景点的占位条目没图时，用同一份规划的候选池按名字补上
    from app.skills.photo_backfill import backfill_plan_photos

    legacy = {
        "plan_id": "legacy",
        "attraction_options": [
            {"name": "长江澳风力发电景观区", "photos": ["https://x/1.jpg"],
             "rating": 4.6, "description": "君山镇磹水村"},
        ],
        "daily_plans": [
            {
                "date": "2026-09-25",
                "hotel": {"name": "某民宿", "photos": []},
                "timeline": [
                    {"time": "09:00-11:00",
                     "poi": {"name": "长江澳", "type": "景点", "photos": [], "rating": None}},
                ],
            }
        ],
    }
    backfill_plan_photos(legacy)
    legacy_poi = legacy["daily_plans"][0]["timeline"][0]["poi"]
    print(
        "== 旧规划补图 ==",
        f"「{legacy_poi['name']}」图片 {len(legacy_poi['photos'])} 张，"
        f"评分 {legacy_poi['rating']}，简介 {legacy_poi['description']}"
        "（应为 1 张 / 4.6 / 君山镇磹水村）",
    )

    # 16) 非景点场所：影城 / 剧院 / 文体中心 / 体育馆不该被推荐成景点
    from app.skills.spot_filter import is_non_attraction, split_non_attractions

    mixed = [
        spot("杭州西湖风景名胜区", 30.25, 120.15),
        spot("杭州博物馆", 30.24, 120.16),
        spot("西航国际影城(康湖路店)", 25.50, 119.80),
        spot("西湖区文体中心", 30.26, 120.07),
        spot("运河大剧院", 30.30, 120.15),
        spot("奥体中心体育馆", 30.20, 120.20),
        spot("黄龙体育中心体育场", 30.26, 120.13),
        spot("湘湖体育公园", 30.15, 120.20),   # 真公园，不能被误伤
    ]
    kept_spots, dropped_spots = split_non_attractions(
        mixed, exempt_names=["西航国际影城(康湖路店)"]  # 用户点名要去的照样保留
    )
    print(
        "== 非景点场所过滤 ==",
        "切掉 " + "、".join(p.name for p in dropped_spots),
        "| 体育公园是否被误伤:", is_non_attraction(mixed[7]),
        "| 点名的影城是否保留:", any("影城" in p.name for p in kept_spots),
    )


if __name__ == "__main__":
    sys.exit(main())
