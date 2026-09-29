"""目的地解析正确率检查（需要联网，会消耗高德额度）。

跑法：
    cd backend
    .venv\\Scripts\\python.exe scripts\\check_destination.py

为什么需要这么一个脚本：目的地解析是我们自己写的逻辑（adcode 优先 →
行政区查询 → 明确拒绝），不像「直接调高德」那样天然正确，
没有固定用例盯着就会悄悄退化。

这个脚本已经拦下过一次真实事故：曾经加过一层「POI 检索兜底」，
用 /place/text 的结果反推城市。它把正确率从 68% 抬到 86%，
但把 `福建福州` 解析成了南京市鼓楼区——用户会拿到一份完全无关城市的行程，
全程没有任何异常提示。那层逻辑已据此撤掉。

判定口径：
- 正例：期望值是「解析出的检索范围」对应的 adcode。
  脚本会把解析结果的名字再查一次行政区接口换成 adcode 来比对，
  避免我们自己写死名字导致循环论证。
  注意区分：`故宫` 期望 `110101`（东城区）而不是 `110000`（北京市）——
  检索范围落到区级更聚焦，这是设计意图，不是错误。
- 负例：期望「明确拒绝」。乱码 / 不存在的地名必须报无法识别，
  绝不能返回某个真实城市——那比报错更糟，用户会拿到完全无关的行程。
- 判定分三档：OK / 拒绝(安全) / 错答。**错答是唯一的红线**，
  脚本以错答数决定退出码；命中率只作为参考，不拿它换错误率。
"""
import sys
import time
from typing import List, Optional, Tuple

sys.path.insert(0, ".")

from app.services.amap import AmapClient, AmapError, AmapDestinationError  # noqa: E402

#: (输入, 期望检索范围的 adcode；None 表示必须拒绝)
CASES: List[Tuple[str, Optional[str]]] = [
    # 标准城市名：走行政区接口即可
    ("\u676d\u5dde", "330100"),          # 杭州 -> 杭州市
    ("\u53a6\u95e8", "350200"),          # 厦门 -> 厦门市
    ("\u798f\u5dde", "350100"),          # 福州 -> 福州市
    ("\u5317\u4eac", "110000"),          # 北京 -> 北京市
    # 「省 + 地名」连写：行政区接口匹配不上，考察兜底
    ("\u798f\u5efa\u798f\u5dde", "350100"),        # 福建福州
    ("\u6d59\u6c5f\u676d\u5dde", "330100"),        # 浙江杭州
    ("\u5e7f\u4e1c\u7701\u6df1\u5733\u5e02", "440300"),  # 广东省深圳市
    # 区县级
    ("\u5e73\u6f6d\u53bf", "350128"),      # 平潭县
    ("\u4e49\u4e4c", "330782"),            # 义乌 -> 义乌市
    ("\u6606\u5c71", "320583"),            # 昆山 -> 昆山市
    # 非标准通称 / 景点级：用户最常这么写
    ("\u5e73\u6f6d", "350128"),            # 平潭
    ("\u798f\u5efa\u5e73\u6f6d", "350128"),        # 福建平潭
    ("\u5e73\u6f6d\u7efc\u5408\u5b9e\u9a8c\u533a", "350128"),  # 平潭综合实验区
    ("\u5e73\u6f6d\u5c9b", "350128"),      # 平潭岛
    ("\u9f13\u6d6a\u5c7f", "350203"),      # 鼓浪屿 -> 厦门思明区
    ("\u6545\u5bab", "110101"),            # 故宫 -> 北京东城区
    # 同名歧义：广东惠阳的平潭镇，不能被解析成福建的平潭县
    ("\u5e73\u6f6d\u9547", "441303"),      # 平潭镇 -> 惠州惠阳区
    # 负例：必须明确拒绝
    ("\u963f\u5df4\u963f\u5df4\u4e0d\u5b58\u5728", None),  # 阿巴阿巴不存在
    ("\u4e0d\u5b58\u5728\u7684\u5730\u65b9xyz", None),     # 不存在的地方xyz
    ("qwertyuiop", None),
    ("\u6211\u968f\u4fbf\u6253\u7684", None),              # 我随便打的
    ("\u6d4b\u8bd5\u6d4b\u8bd5\u6d4b\u8bd5", None),        # 测试测试测试
]

RETRIES = 3


def with_retry(fn):
    """高德偶发网络抖动（本机开代理时尤其容易）不该算进正确率。"""
    last: Optional[Exception] = None
    for attempt in range(RETRIES):
        try:
            return fn()
        except AmapDestinationError:
            raise
        except AmapError as exc:
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise last  # type: ignore[misc]


def adcode_of(client: AmapClient, name: str) -> str:
    """把解析出来的名字换成 adcode，用于和期望值比对。"""
    data = with_retry(lambda: client._get("/config/district", {"keywords": name, "subdistrict": "0"}))
    districts = data.get("districts") or []
    return (districts[0].get("adcode") or "") if districts else ""


def main() -> int:
    client = AmapClient()
    rows: List[Tuple[str, object, str, str, str]] = []
    passed = skipped = refused = wrong = 0

    for text, expect in CASES:
        try:
            # 先单独看一眼行政区接口有没有命中，用来判断走的是哪一层
            layer = 1 if with_retry(lambda: client._lookup_district(text)) else 2
        except AmapDestinationError:
            layer = 2
        except AmapError:
            layer = "?"  # 网络抖动，拿不准走哪层，不影响判定

        try:
            city, city_name = with_retry(lambda: client.resolve_region(text))
        except AmapDestinationError:
            if expect is None:
                passed += 1
                verdict = "OK"
            else:
                refused += 1
                verdict = "拒绝(安全)"
            rows.append((text, layer, "(未识别)", expect or "必须拒绝", verdict))
            continue
        except AmapError as exc:
            rows.append((text, layer, f"网络失败 {str(exc)[:22]}", expect or "必须拒绝", "跳过"))
            skipped += 1
            continue

        try:
            code = with_retry(lambda: adcode_of(client, city))
        except AmapError:
            rows.append((text, layer, f"{city}/{city_name}", expect or "必须拒绝", "跳过"))
            skipped += 1
            continue

        got = f"{city}/{city_name} [{code}]"
        # 「错答」= 给了一个具体的、但不对的结果（给错城，或负例被解析成了某个地方）。
        # 这是唯一的红线：用户会拿着它跑完整条生成链路，全程没有任何异常提示。
        # 「拒绝」则是安全失败——用户立刻看到提示，可以改用下拉候选。
        if expect is None or code != expect:
            verdict, wrong = "错答", wrong + 1
        else:
            verdict, passed = "OK", passed + 1
        rows.append((text, layer, got, expect or "必须拒绝", verdict))

    width = max(len(str(r[0])) for r in rows) + 2
    print(f"{'输入':<{width}} {'层':<3} {'解析结果':<30} {'期望':<12} 判定")
    print("-" * (width + 62))
    for text, layer, got, expect, verdict in rows:
        print(f"{text:<{width}} {str(layer):<3} {got:<30} {expect:<12} {verdict}")

    total = len(CASES) - skipped
    rate = (passed / total * 100) if total else 0.0
    print("-" * (width + 62))
    tail = "  ← 红线，必须为 0" if wrong == 0 else "  ← 必须修复"
    print(
        f"正确 {passed}/{total}（{rate:.1f}%）  安全拒绝 {refused}  "
        f"错答 {wrong}{tail}  跳过 {skipped}"
    )
    return 1 if wrong > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
