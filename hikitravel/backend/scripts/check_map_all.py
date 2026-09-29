"""批量验证：拿出一批历史计划，逐个调 /api/map/static，看是否都能出图。

用途：高德静态地图对 markers/paths 有数量限制，这里用真实数据回归验证裁剪逻辑。
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def main() -> int:
    failures = 0
    with TestClient(app) as client:
        plans = client.get("/api/plans").json()
        picks = plans[:4] + plans[8:12] + plans[-4:]
        for summary in picks:
            plan = client.get(f"/api/plans/{summary['plan_id']}").json()
            started = time.time()
            resp = client.post("/api/map/static", json={"plan": plan})
            days = len(plan.get("daily_plans", []))
            points = sum(len(d.get("timeline", [])) for d in plan.get("daily_plans", []))
            if resp.status_code == 200:
                data = resp.json()
                print(
                    f"OK   {summary['summary'][:20]:22s} 天={days} 点={points} "
                    f"标记={len(data['legend'])} 图片={len(data['image'])}字符 "
                    f"耗时={time.time() - started:.1f}s"
                )
            else:
                failures += 1
                print(
                    f"FAIL {summary['summary'][:20]:22s} 天={days} 点={points} "
                    f"状态={resp.status_code} {resp.json()}"
                )
    print("失败数:", failures)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
