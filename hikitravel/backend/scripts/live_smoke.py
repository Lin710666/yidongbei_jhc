"""真实链路冒烟测试：在进程内跑完整接口（走真实 Ollama + 高德，不需要先启动服务）。

用法（在 backend 目录下）：
    .venv\\Scripts\\python.exe scripts\\live_smoke.py

说明：用 FastAPI 官方 TestClient 直接调用应用，路由、校验、异常处理、
Skill 流水线、SQLite 落库都走真实代码路径，只是省掉了起 uvicorn 这一步。

覆盖场景：
1. GET  /api/health   —— 大模型 / 高德配置状态
2. POST /api/plan     —— 完整画像，真实走 高德 + Ollama 生成规划
3. POST /api/chat     —— 一句自然语言，走完整五段流水线
4. POST /api/plan     —— 缺目的地，应 400 且提示补充
5. POST /api/plan     —— 缺天数/预算/兴趣/人数，应 400 且逐项列出
6. GET  /api/plans    —— 历史计划落库情况
7. POST /api/plan/revise —— 对话式修改（在既有画像上改条件重新生成）
8. POST /api/map/static  —— 高德真实地图（静态地图代理，含编号标记与每日轨迹）
"""
import json
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

# 允许直接以 `python scripts/live_smoke.py` 运行：把 backend 目录加入模块搜索路径
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def title(text: str) -> None:
    print("\n" + "=" * 8 + " " + text + " " + "=" * 8)


def summarize(plan: dict) -> None:
    print("摘要:", plan.get("summary"))
    print("预算:", plan.get("total_budget_estimate"), plan.get("budget_breakdown"))
    print("出行人数:", plan.get("travelers"), "用户预算:", plan.get("user_budget"))
    for day in plan.get("daily_plans", []):
        times = [item["time"] for item in day.get("timeline", [])]
        print(f"[{day['date']}] {day['weather'].get('condition')} {day['weather'].get('temp')}"
              f" 酒店={day['hotel']['name'] if day.get('hotel') else None}"
              f" 首项={times[0] if times else '—'} 末项={times[-1] if times else '—'}")
        for item in day.get("timeline", []):
            poi = item["poi"]
            nxt = item.get("transport_to_next")
            print(f"   {item['time']} {poi['type']} {poi['name']}"
                  f" 价={poi.get('price')} 评分={poi.get('rating')}"
                  f" 下一段={nxt['mode'] + '/' + nxt['duration'] if nxt else '-'}")
        if day.get("plan_b"):
            print("   PlanB:", day["plan_b"])
    checks = plan.get("checks")
    if checks:
        print("体检:", checks["passed"], checks["summary"])
        for issue in checks["issues"]:
            print("   -", issue["category"], issue["severity"], issue["message"])
    print("推荐池大小: 餐饮", len(plan.get("dining_options", [])),
          "酒店", len(plan.get("hotel_options", [])),
          "景点", len(plan.get("attraction_options", [])))


def main() -> int:
    # TestClient 默认超时很长，本地 7B 生成一份规划要 1~3 分钟，够用
    with TestClient(app) as client:
        title("1. 健康检查")
        r = client.get("/api/health")
        print(r.status_code, r.json())
        env = r.json()
        if not env.get("ollama_available"):
            print("!! 未检测到本地大模型，后续生成规划会返回 503（这是设计行为）")
        if not env.get("amap_configured"):
            print("!! 未配置高德密钥，POI/天气检索会失败")

        title("2. 表单模式：完整画像生成规划")
        pref = {
            "destination": "杭州",
            "duration_days": 3,
            "budget": 3000,
            "travelers": {"adults": 2, "children": 0, "elderly": 1},
            "preferences": ["人文历史", "自然风光"],
            # 两种输入都覆盖：下拉选定（带坐标，后端直接用）与手输（只有名字，按名解析）
            "must_visit": [
                {"name": "灵隐寺", "adcode": "330100", "lat": 30.2409, "lng": 120.1016},
                {"name": "雷峰塔"},
            ],
            "pace": "悠闲",
            "transportation": "高铁",
            "departure_time": "08:30",       # 表单新增项：每天出发时间
            "return_hotel_time": "20:00",    # 表单新增项：期望回酒店时间
        }
        t0 = time.time()
        r = client.post("/api/plan", json={"preference": pref})
        print(f"耗时 {time.time() - t0:.1f}s 状态 {r.status_code}")
        first_plan = None
        if r.status_code == 200:
            first_plan = r.json()
            summarize(first_plan)
            print("画像已随规划返回:", first_plan.get("user_preference") is not None,
                  "| 预算口径提示:", first_plan.get("transport_note", "")[:40], "…")
        else:
            print("错误:", r.json())

        title("2.5 对话式修改：把预算压到 2500、节奏改悠闲")
        if first_plan is None:
            print("跳过（上一版未成功生成）")
        else:
            t0 = time.time()
            r = client.post(
                "/api/plan/revise",
                json={"message": "预算压到 2500，节奏改成悠闲", "plan": first_plan},
            )
            print(f"耗时 {time.time() - t0:.1f}s 状态 {r.status_code}")
            if r.status_code == 200:
                revised = r.json()
                pref_after = revised.get("user_preference") or {}
                print("修改后画像:", "预算", pref_after.get("budget"), "节奏", pref_after.get("pace"))
                summarize(revised)
            else:
                print("错误:", r.json())

        title("3. 对话模式：一句话走完整流水线")
        t0 = time.time()
        r = client.post(
            "/api/chat",
            json={"message": "带80岁老人特种兵游杭州，3天，预算2000，特别想去雷峰塔"},
        )
        print(f"耗时 {time.time() - t0:.1f}s 状态 {r.status_code}")
        chat_plan = None
        if r.status_code == 200:
            chat_plan = r.json()
            summarize(chat_plan)
        else:
            print("错误:", r.json())

        title("4. 缺目的地：应 400 并提示补充")
        r = client.post(
            "/api/plan",
            json={
                "preference": {
                    "duration_days": 2,
                    "budget": 1000,
                    "travelers": {"adults": 1},
                    "preferences": ["自然风光"],
                }
            },
        )
        print(r.status_code, r.json())

        title("5. 缺多项关键信息：应 400 并逐项列出")
        r = client.post("/api/plan", json={"preference": {"destination": "杭州"}})
        print(r.status_code, r.json())

        title("6. 历史计划")
        r = client.get("/api/plans")
        print(r.status_code, json.dumps(r.json(), ensure_ascii=False)[:400])

        title("7. 高德地图（静态地图代理）")
        if first_plan is None:
            print("跳过（没有可用的规划）")
        else:
            t0 = time.time()
            r = client.post("/api/map/static", json={"plan": first_plan})
            print(f"耗时 {time.time() - t0:.1f}s 状态 {r.status_code}")
            if r.status_code == 200:
                data = r.json()
                print(
                    "地图图片字符数:", len(data["image"]),
                    "| zoom:", data["zoom"],
                    "| 标记/图例:", len(data["legend"]),
                )
                print("图例前 3 条:", [(i["label"], i["name"]) for i in data["legend"][:3]])
            else:
                print("错误:", r.json())
    return 0


if __name__ == "__main__":
    sys.exit(main())
