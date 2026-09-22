"""知识库数据访问层：知识以 SQLite 行存储，可运营维护，而非硬编码在代码里。

内容原则（与用户对齐）：
1. 知识库只存放「慢变」的编辑类知识：历史人文、游览动线、拍照机位、
   防坑常识、本地特色。
2. 「快变」的动态事实（门票价、预约规则、开放时间、酒店房价）
   **不进知识库**，运行时通过高德 API 等外部接口获取；
   预约提醒使用通用安全话术并提示「以官方公告为准」。
3. 文旅从业者可通过修改数据库直接扩充知识，无需改动代码。

★ 关于 `city`（每条知识属于哪个城市）：
   种子数据里 10 条有 9 条是**杭州专属**（西湖、断桥、雷峰塔、灵隐寺、龙井茶…），
   但原来没有城市字段，检索时也不看目的地 —— 于是"去成都玩"的方案里
   附送的贴士是「杭帮菜代表有西湖醋鱼、东坡肉、龙井虾仁」。实测抓到的。
   现在每条都标 city：具体城市名 = 只对该城市生效；空串 = 全国通用。
   检索时按「目的地 or 通用」过滤（见 retriever.search 的 city 参数）。
"""
from typing import Any, Dict, List

from ..db import get_conn

# 慢变的编辑类知识（首版种子数据，无时效性事实）
STABLE_KNOWLEDGE: List[Dict[str, str]] = [
    {
        "text": "西湖十景包括苏堤春晓、断桥残雪、雷峰夕照、三潭印月等，环湖免费游览。",
        "city": "杭州",
        "tags": "西湖,历史人文",
        "category": "历史人文",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "断桥是《白蛇传》中白娘子与许仙相遇的地方，冬季雪后「断桥残雪」最有意境。",
        "city": "杭州",
        "tags": "断桥,历史人文",
        "category": "历史人文",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "雷峰塔因《白蛇传》而闻名，登塔可俯瞰西湖全景，日落时分视野最佳。",
        "city": "杭州",
        "tags": "雷峰塔,历史人文,拍照",
        "category": "历史人文",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "灵隐寺始建于东晋，飞来峰保存有五代至元代的石窟造像群，是全国重点文保单位。",
        "city": "杭州",
        "tags": "灵隐寺,历史人文",
        "category": "历史人文",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "动线建议：西湖沿线可逆时针串联断桥、苏堤、雷峰塔，减少回头路。",
        "city": "杭州",
        "tags": "动线,西湖",
        "category": "动线",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "拍照建议：断桥残雪、苏堤春晓清晨人少、光线柔和，适合拍照。",
        "city": "杭州",
        "tags": "拍照,建议",
        "category": "拍照",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "防坑建议：景区内「野导」拉客、路边「低价一日游」多为陷阱，请勿轻信。",
        "city": "",
        "tags": "防坑,避雷",
        "category": "防坑",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "防坑建议：景区周边部分龙井茶以次充好，购茶建议到龙井村正规门店。",
        "city": "杭州",
        "tags": "防坑,购物",
        "category": "防坑",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "本地特色：龙井茶产自西湖龙井村一带，以「色绿、香郁、味甘、形美」四绝著称。",
        "city": "杭州",
        "tags": "本地特色,龙井茶",
        "category": "本地特色",
        "source": "",
        "updated_at": "2026-09-19",
    },
    {
        "text": "本地特色：杭帮菜代表有西湖醋鱼、东坡肉、龙井虾仁，老字号如楼外楼、知味观。",
        "city": "杭州",
        "tags": "本地特色,美食",
        "category": "本地特色",
        "source": "",
        "updated_at": "2026-09-19",
    },
]


def init_kb() -> None:
    """初始化知识库表结构（幂等）。

    建表之后还要**补一次 city 列**：老库（已经有 10 条杭州数据那种）是在没有
    city 列的时候建的，CREATE TABLE IF NOT EXISTS 不会给它加列。
    所以这里用 ALTER TABLE 幂等补列，再把老行按正文回填城市 ——
    不回填的话老库的 city 全是 NULL，按城市过滤会把知识全滤掉，
    变成"任何城市都没有贴士"，比现在还糟。
    """
    conn = get_conn()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS knowledge_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL,
            tags TEXT NOT NULL,
            category TEXT NOT NULL,
            source TEXT DEFAULT '',
            updated_at TEXT DEFAULT '',
            city TEXT DEFAULT ''
        )
        """
    )
    have = {r["name"] for r in conn.execute("PRAGMA table_info(knowledge_chunks)").fetchall()}
    if "city" not in have:
        conn.execute("ALTER TABLE knowledge_chunks ADD COLUMN city TEXT DEFAULT ''")

    # 回填 city：把**种子条目**的城市对齐到代码里声明的值。
    #
    # 两个坑都踩过，写在这里免得再犯：
    #   · 不能只查 `city IS NULL` —— `ADD COLUMN city TEXT DEFAULT ''` 给老行
    #     填的是**空串**，不是 NULL，那条查询一条也匹配不到（第一次就是这么白改的）。
    #   · 也不能无脑 `city = ''` 全刷一遍 —— 那样用户自己加的知识会被反复处理。
    # 所以按**正文精确匹配种子数据**：只动认得出的行，且只在城市不一致时才写。
    # 这样跑多少次结果都一样，也不会碰用户自己加的条目。
    by_text = {c["text"]: c["city"] for c in STABLE_KNOWLEDGE}
    for r in conn.execute("SELECT id, text, city FROM knowledge_chunks").fetchall():
        want = by_text.get(r["text"])
        if want is None:
            continue                      # 不是种子条目（用户加的）→ 不动
        if (r["city"] or "") != want:
            conn.execute("UPDATE knowledge_chunks SET city = ? WHERE id = ?", (want, r["id"]))
    conn.commit()
    conn.close()


def seed_kb() -> None:
    """首次运行播种知识库（已有数据则跳过）。"""
    init_kb()
    conn = get_conn()
    count = conn.execute("SELECT COUNT(*) AS c FROM knowledge_chunks").fetchone()["c"]
    if count == 0:
        rows = [
            (c["text"], c["tags"], c["category"], c["source"], c["updated_at"], c["city"])
            for c in STABLE_KNOWLEDGE
        ]
        conn.executemany(
            "INSERT INTO knowledge_chunks(text, tags, category, source, updated_at, city)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
        conn.commit()
    conn.close()


def get_all_chunks(city: str | None = None) -> List[Dict[str, Any]]:
    """读取知识片段（自动初始化 + 播种 + 迁移）。

    city 给定时，只返回「该城市的」和「全国通用的（city 为空）」两类 ——
    这是"去成都玩别给你讲西湖"的关键过滤。不给则返回全部。
    """
    init_kb()
    seed_kb()
    conn = get_conn()
    rows = conn.execute(
        "SELECT text, tags, category, source, city FROM knowledge_chunks"
    ).fetchall()
    conn.close()
    out = [
        {
            "text": r["text"],
            "tags": r["tags"].split(","),
            "category": r["category"],
            "source": r["source"],
            "city": r["city"] or "",
        }
        for r in rows
    ]
    if city:
        c = str(city).strip()
        # 用"包含"匹配：库里可能写「杭州市」，用户填的是「杭州」
        out = [x for x in out if not x["city"] or x["city"] in c or c in x["city"]]
    return out
