"""把"不是景点"的场所挡在自动选点之外（影城 / 剧院 / 文体中心 / 体育馆 …）。

实测（用户反馈 + 高德分类码逐条核对）：

- 「西航国际影城(康湖路店)」typecode **080601 电影院** —— 靠兴趣「娱乐」里的
  `080600 影剧院` 混进来，还排进了平潭那份规划的第 2 天；
- 「西湖区文体中心」typecode **140800 文化宫** —— 靠「人文历史」里的 `140800` 混进来；
- 「运河大剧院」typecode 080603 剧场，同理。

两层处理：

1. **断源头**：把 `080600`（影剧院）与 `140800`（文化宫）从**兴趣检索**的分类码里去掉
   （见 retrieve_skill.PREFERENCE_TYPES），它们不再作为"推荐"出现。
   但 `ATTRACTION_TYPES` 里保留这两个码——用户自己在「必去景点」里点名
   「国家大剧院」时，仍然要能解析出真实记录（带照片与评分）。
2. **兜一道名字护栏**：万一还有从别的分类码混进来的，也先从**自动选点**里排除。

为什么是"排除出自动选点"而不是"从池子里删掉"：
系统替用户做判断，判断就得能被核对——排除名单会写进体检清单。
用户点名的必去景点不受影响；前端「换一个」的备选池也仍然给全量。
"""
from typing import Iterable, List, Tuple

from ..models.plan import POI

#: 命中这些词的场所不作为自动推荐的景点。
#: 刻意只收"明确不是观光地"的词——「体育公园」这类真公园不会被误伤
#: （要完整二字「体育场」才命中）。
NON_ATTRACTION_WORDS = (
    "影城", "影院", "电影院", "剧院", "剧场", "音乐厅",
    "文体中心", "体育馆", "体育场", "游泳馆", "健身",
)


def is_non_attraction(poi: POI) -> bool:
    """这个点更像"城市场馆"而不是景点。"""
    name = getattr(poi, "name", "") or ""
    return any(word in name for word in NON_ATTRACTION_WORDS)


def split_non_attractions(
    pool: Iterable[POI], exempt_names: Iterable[str] = ()
) -> Tuple[List[POI], List[POI]]:
    """把池子切成 (可自动选的点, 被排除的场所)。

    exempt_names：用户点名必去的景点——即使名字命中上面的词也保留
    （用户明确说要去，那就照办）。
    """
    exempt = set(exempt_names or ())
    kept: List[POI] = []
    dropped: List[POI] = []
    for poi in pool:
        if poi.name in exempt or not is_non_attraction(poi):
            kept.append(poi)
        else:
            dropped.append(poi)
    return kept, dropped
