"""本地 RAG 知识库包。

对应需求文档「模块2」中的本地 RAG 知识库：
当地文旅历史知识、景点最佳拍照机位、游览动线、本地人防坑指南。

知识存放于 SQLite 数据库（可运营维护），只含慢变编辑类知识；
门票价 / 预约规则等时效性事实由外部 API 动态获取，不硬编码。

- repository : 知识库数据访问层（SQLite + 种子数据）
- retriever  : 检索器（Ollama embedding + 本地稀疏向量兜底）
"""
from .retriever import Retriever

__all__ = ["Retriever"]
