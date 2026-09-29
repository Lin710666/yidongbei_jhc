"""景点去重：把「同一片地方的多条高德记录」合并成一个。

为什么需要它（真实案例）：一份平潭规划的 9 个"景点"里有 6 个其实是同一片地方——

    平潭长江澳·沙滩 ↔ 平潭国际旅游岛·长江澳        78 米
    镜沙黑洞       ↔ 镜沙黑石滩                  428 米
    镜沙黑石滩      ↔ 星辰大海·镜沙                411 米
    长江澳风力发电景观区 ↔ 平潭长江澳·沙滩            2889 米

后果是：同一天上午走 78 米去"下一个景点"，以及把相距 5 公里的点塞进同一天。
原有的去重（见 planner_skill._duplicate_of）只看"完整名字互为子串"，
所以能拦住「雷峰塔」/「雷峰塔景区」，但上面这些名字互不包含，全部漏掉。

判重规则（两个信号取"或"，各自带距离护栏）：

1. 直线距离 < SAME_SPOT_METERS：几乎一定是同一处，直接合并；
2. 名字去掉噪声后的最长公共词干 ≥ MIN_STEM_CHARS、且不是通用地名、
   且直线距离 < SAME_STEM_METERS：覆盖「长江澳」这类同一片景区不同分区的写法。

两个细节是必需的，否则会误杀：

- **必须带距离护栏**：只看名字会把异地同名当成同一处（杭州西湖 / 惠州西湖）。
- **词干至少要 3 个字**：平潭大量景点都以「平潭」开头（坛南湾 / 北港村），
  公共词干正好是 2 个字的「平潭」——按 2 字判会把整个平潭的景点合成一个。

合并是**传递**的：黑洞↔黑石滩（428 米）合并、黑石滩↔星辰大海（411 米）合并，
于是三个自动归成一组，不需要任何一对满足"长距离 + 长词干"。

保留哪一个：必去景点优先（用户点过名的不能被合并掉），其次评分高，
再次照片多。高德的热度字段（weight）在转成 POI 之后就丢了，
所以用照片数当热度代理。
"""
import re
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from ..models.plan import POI
from .scoring import distance_km

#: 直线距离小于这个值（米）就当作同一处——无需看名字
SAME_SPOT_METERS = 500.0
#: 名字词干相同、且距离小于这个值（米）才当作同一处
SAME_STEM_METERS = 5000.0
#: 公共词干至少这么长才算数（见模块说明：2 字会被「平潭」这类地名前缀骗到）
MIN_STEM_CHARS = 3

#: 通用地名：光靠它们相同不足以判定是同一处
#: （否则「XX公园」「XX博物馆」会互相误杀）
GENERIC_WORDS: Set[str] = {
    "公园", "广场", "中心", "景区", "景点", "名胜区", "风景区", "旅游区",
    "沙滩", "海滩", "海滨", "海边", "海岛", "湿地", "古镇", "古城", "老街",
    "步行街", "观景台", "观景点", "度假区", "度假村", "生态园", "植物园",
    "动物园", "游乐园", "博物馆", "纪念馆", "美术馆", "科技馆", "展览馆",
    "酒店", "民宿", "客栈", "餐厅", "酒楼", "大排档", "小吃", "停车场",
}

#: 比较名字前先去掉的噪声（分隔符、括号、标点）
_NOISE = re.compile(r"[\s·•・\-—_~()（）\[\]【】{}<>、,，.。:：;；!！?？'\"“”‘’/\\|+&]+")


def _normalize(name: str) -> str:
    """去掉分隔符与括号等噪声，只留可比较的字符。"""
    return _NOISE.sub("", name or "")


def common_stem(a: str, b: str) -> str:
    """两个名字（去噪后）的最长公共子串；没有公共字符时返回空串。"""
    x, y = _normalize(a), _normalize(b)
    if not x or not y:
        return ""
    # 经典最长公共子串 DP；名字只有十几个字，代价可忽略
    best_len, best_end = 0, 0
    prev = [0] * (len(y) + 1)
    for i in range(1, len(x) + 1):
        cur = [0] * (len(y) + 1)
        for j in range(1, len(y) + 1):
            if x[i - 1] == y[j - 1]:
                cur[j] = prev[j - 1] + 1
                if cur[j] > best_len:
                    best_len, best_end = cur[j], i
        prev = cur
    return x[best_end - best_len : best_end]


def _is_generic(stem: str) -> bool:
    """词干是否只是通用地名（是的话不足以判定为同一处）。"""
    if stem in GENERIC_WORDS:
        return True
    # 「XX公园」这类：词干本身含通用词，但还剩别的信息时仍算有效
    return all(ch in "".join(GENERIC_WORDS) for ch in stem)


def same_spot(a: POI, b: POI) -> Optional[str]:
    """两个景点是否应视为同一处。是则返回判定理由，否则返回 None。"""
    km = distance_km(a, b)
    if km is None:
        return None
    meters = km * 1000.0
    if meters < SAME_SPOT_METERS:
        return f"相距 {meters:.0f} 米"
    if meters >= SAME_STEM_METERS:
        return None
    stem = common_stem(a.name, b.name)
    if len(stem) >= MIN_STEM_CHARS and not _is_generic(stem):
        return f"同名景点「{stem}」，相距 {meters / 1000:.1f} 公里"
    return None


def _keep_rank(poi: POI, protected: Set[str]) -> Tuple[int, float, int]:
    """决定同一组里保留谁的排序键（越大越该保留）。"""
    return (
        1 if poi.name in protected else 0,
        poi.rating or 0.0,
        len(poi.photos or []),
    )


def dedupe_attractions(
    pois: Sequence[POI],
    protect_names: Optional[Iterable[str]] = None,
) -> Tuple[List[POI], List[Dict[str, Any]]]:
    """把同一片地方的多条记录合并，返回 (去重后的景点, 合并说明)。

    Args:
        pois: 候选景点（顺序即优先级，越靠前越"想保留"）。
        protect_names: 必须保留的名字（通常是用户点名的必去景点）。

    Returns:
        (去重后的列表, 合并记录)。合并记录用于在体检里如实告诉用户
        "哪几个点被合并了"，而不是悄悄改掉用户的行程。
    """
    items = [p for p in pois if p.name]
    protected = set(protect_names or [])
    if len(items) < 2:
        return list(items), []

    # 并查集：把"同一处"的点连起来（合并是传递的，见模块说明）
    parent = list(range(len(items)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[max(ri, rj)] = min(ri, rj)

    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            if same_spot(items[i], items[j]):
                union(i, j)

    groups: Dict[int, List[int]] = {}
    for i in range(len(items)):
        groups.setdefault(find(i), []).append(i)

    kept: List[POI] = []
    notes: List[Dict[str, Any]] = []
    # 按原始顺序输出，保持候选池"越靠前越优先"的语义
    for root in sorted(groups, key=lambda r: min(groups[r])):
        members = groups[root]
        winner = max(members, key=lambda i: _keep_rank(items[i], protected))
        kept.append(items[winner])
        # 每个被合并的点单独写它自己的理由：可能是直接与保留点判重，
        # 也可能是靠其它重复条目"传递"过来的（这时直说不确定，别张冠李戴）
        for index in members:
            if index == winner:
                continue
            direct = same_spot(items[index], items[winner])
            notes.append(
                {
                    "kept": items[winner].name,
                    "merged": [items[index].name],
                    "reason": direct or "与保留的点同属一片区域（经其它重复条目传递）",
                }
            )
    return kept, notes
