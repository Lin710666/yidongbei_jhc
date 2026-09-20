"""SQLite 本地数据库封装。

需求文档要求「数据安全导出、用户隐私数据本地存储」，
因此使用零配置的 SQLite 作为本地存储，隐私数据不出机器。
"""
import os
import sqlite3
from pathlib import Path

# 数据库文件默认位于 backend/data/travelplanner.db，可通过环境变量覆盖
DB_PATH = Path(
    os.getenv("DB_PATH", Path(__file__).resolve().parent.parent / "data" / "travelplanner.db")
)


def get_conn() -> sqlite3.Connection:
    """获取数据库连接（自动创建目录与文件）。"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row  # 支持按列名取值
    return conn
