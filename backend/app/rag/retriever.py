"""本地 RAG 检索器。

检索策略（双层，保证任何环境下可用）：
1. 优先使用 Ollama 本地 embedding 模型（默认 nomic-embed-text），
   对知识库与查询做稠密向量相似度检索。
2. 若 Ollama 不可用，退化为「字符二元组（bigram）稀疏向量」余弦相似度，
   纯 Python 实现、零依赖、离线可用。

知识来源：SQLite 数据库中的慢变编辑类知识（见 repository.py），
不含门票价 / 预约规则等时效性事实。
"""
import math
from typing import Dict, List, Union

import httpx

from ..config import settings
from .repository import get_all_chunks

# 向量可能是稠密 list（Ollama）或稀疏 dict（bigram 兜底）
Vector = Union[List[float], Dict[str, int]]


def _bigram(text: str) -> Dict[str, int]:
    """字符二元组稀疏向量（兜底 embedding）。"""
    text = text.lower()
    vec: Dict[str, int] = {}
    for i in range(len(text) - 1):
        gram = text[i : i + 2]
        vec[gram] = vec.get(gram, 0) + 1
    return vec


def _cosine(a: Vector, b: Vector) -> float:
    """统一余弦相似度：兼容稠密 list 与稀疏 dict。"""
    if isinstance(a, list) and isinstance(b, list):
        dot = sum(x * y for x, y in zip(a, b))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(y * y for y in b))
    elif isinstance(a, dict) and isinstance(b, dict):
        dot = sum(v * b.get(k, 0) for k, v in a.items())
        na = math.sqrt(sum(v * v for v in a.values()))
        nb = math.sqrt(sum(v * v for v in b.values()))
    else:
        return 0.0
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


class Retriever:
    """知识库检索器：首次查询时对知识建索引（懒加载），之后常驻复用。

    为什么索引不在 __init__ 里建（这是本文件最重要的一条）：
    原来的写法是在构造函数里对每一条知识单独发一次 Ollama embedding 请求。
    而 Orchestrator 是在模块顶层 new 出来的（api.py 与 ui_compat.py 各一个），
    于是「只是 import app.main」就要等 10 次串行 HTTP + 一次模型加载——
    实测导入耗时 42 秒，uvicorn 迟迟不打印启动横幅，
    看起来像服务起不来，实际上是在等 embedding。
    现在索引改成第一次 search() 时才建，导入就只剩毫秒级。
    """

    def __init__(self, city: str | None = None) -> None:
        # 按城市取知识：只保留「该城市的」与「全国通用的」。
        # 为什么在**构造时**就过滤而不是检索时：索引是按 chunks 建的，
        # 检索阶段再过滤只能把结果置空、索引照样是全部城市的，
        # 白白多算一遍还不够干净。要换城市就换一个 Retriever 实例。
        self.city = city
        self.chunks = get_all_chunks(city)
        self._ollama_ok: bool | None = None  # 缓存 Ollama 可用性
        self._index: List[Vector] | None = None   # 惰性：见上面的类注释

    def _ensure_index(self) -> List[Vector]:
        """首次检索时建索引，之后直接复用。"""
        if self._index is None:
            texts = [c["text"] + " " + " ".join(c["tags"]) for c in self.chunks]
            dense = self._ollama_embed_many(texts)
            if dense is not None:
                self._ollama_ok = True
                self._index = dense
            else:
                self._ollama_ok = False
                self._index = [_bigram(t) for t in texts]
        return self._index

    def _ollama_embed_many(self, texts: List[str]) -> List[List[float]] | None:
        """批量向量化：一次请求交一批文本。

        用 /api/embed 的 input 数组，而不是逐条打 /api/embeddings ——
        等价的结果，但往返次数从 N 次降到 1 次。
        批量接口要是不认（老版本 Ollama），就退回逐条。
        """
        if not texts:
            return []
        try:
            resp = httpx.post(f"{settings.ollama_base_url}/api/embed",
                              json={"model": settings.ollama_embed_model, "input": texts},
                              timeout=60.0)
            resp.raise_for_status()
            got = resp.json().get("embeddings")
            if got and len(got) == len(texts):
                return got
        except Exception:  # noqa: BLE001 - 批量失败就退回逐条
            pass

        out: List[List[float]] = []
        for t in texts:
            one = self._ollama_embed(t)
            if one is None:
                return None       # 逐条都失败 → 交给 bigram 兜底
            out.append(one)
        return out

    def _ollama_embed(self, text: str) -> List[float] | None:
        """调用 Ollama embedding 接口，失败返回 None。"""
        try:
            resp = httpx.post(
                f"{settings.ollama_base_url}/api/embeddings",
                json={"model": settings.ollama_embed_model, "prompt": text},
                timeout=10.0,
            )
            resp.raise_for_status()
            return resp.json().get("embedding")
        except Exception:
            return None

    def _embed(self, text: str) -> Vector:
        """对文本向量化：优先 Ollama，失败回退 bigram。"""
        if self._ollama_ok is not False:
            dense = self._ollama_embed(text)
            if dense is not None:
                self._ollama_ok = True
                return dense
            self._ollama_ok = False
        return _bigram(text)

    def search(self, query: str, top_k: int = 3, min_score: float | None = None) -> List[str]:
        """检索与查询最相关的知识片段正文。

        ★ 加了相关度下限（min_score）。

        原来是把全部条目按相似度排个序、**无条件**取前 top_k ——
        哪怕最后一条的相关度是 0.00 也会被塞进结果里。后果：
        苏州/成都的查询里，城市词匹配不上任何一条杭州知识，
        但杭州那几条照样被返回，于是"去成都玩"的方案贴士是
        「杭帮菜代表有西湖醋鱼、东坡肉、龙井虾仁」。实测抓到的。

        下限默认值分两档，因为两种向量的量表不一样：
          · Ollama 稠密向量：余弦一般 0.3~0.9，取 0.35
          · bigram 稀疏兜底：短文本之间的余弦很小，0.3 会把正常结果也砍掉，取 0.05
        经验值，不是算出来的 —— 宁可少给几条贴士，也别张冠李戴。
        """
        if not self.chunks:
            return []          # 这个城市一条知识都没有 → 老实返回空
        index = self._ensure_index()
        q_vec = self._embed(query)
        scored = sorted(
            enumerate(index), key=lambda i: _cosine(q_vec, i[1]), reverse=True
        )
        if min_score is None:
            min_score = 0.35 if self._ollama_ok else 0.05
        out: List[str] = []
        for i, vec in scored[:top_k]:
            if _cosine(q_vec, vec) < min_score:
                break          # 已排序，后面只会更低
            out.append(self.chunks[i]["text"])
        return out
