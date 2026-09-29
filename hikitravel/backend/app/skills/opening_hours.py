"""营业时间解析与校验（高德 biz_ext.open_time）。

为什么要它：这个字段高德实测 25/25 家餐厅都有，而我们**从来没存过、也没校验过**。
后果是实打实的——有一次真实生成把晚餐排在 **17:30 开始**，而那家店
（又一·Youyi Sea Coffee）的营业时间是 **10:30-17:30**：正好在关门那一刻开始吃。

设计原则：**读不懂就不要拦**。解析不出时间就当作"营业时间待确认"放行，
而不是因为读不懂就把店排除掉（那是静默降级，会让候选莫名其妙变少）。
"""
import re
from typing import Optional, Tuple

#: 匹配 "10:00-22:00" / "10:00 - 22:00" / "10:00~22:00" / "10:00到22:00"
_RANGE = re.compile(r"(\d{1,2}):(\d{2})\s*[-–—~～至到]\s*(\d{1,2}):(\d{2})")


def parse_open_time(text: str) -> Optional[Tuple[int, int]]:
    """'10:00-22:00' -> (600, 1320)（当天已过分钟数）。识别不了返回 None。

    跨夜的情况（如 '10:00-03:00'）把结束时间加上 24 小时，
    这样"凌晨 0 点半还算营业中"也能判对。
    """
    if not text:
        return None
    match = _RANGE.search(text)
    if match is None:
        return None
    hour1, minute1, hour2, minute2 = (int(x) for x in match.groups())
    if hour1 > 24 or hour2 > 24 or minute1 > 59 or minute2 > 59:
        return None
    start = hour1 * 60 + minute1
    end = hour2 * 60 + minute2
    if end <= start:  # 跨夜：例如 10:00-03:00
        end += 24 * 60
    return start, end


def is_open_at(text: str, minute: int) -> bool:
    """这一刻它开不开门。解析不出来一律返回 True（不因为读不懂就拦）。"""
    parsed = parse_open_time(text)
    if parsed is None:
        return True
    start, end = parsed
    # 同时看今天与"次日凌晨"的区间，跨夜店在 0 点半也能算营业中
    return start <= minute <= end or start <= minute + 24 * 60 <= end


def fits_open_time(text: str, start_minute: int, duration_minutes: int = 60) -> bool:
    """从 start_minute 开始、吃 duration_minutes 分钟，这段时间它是否都在营业。

    只看"起点开没开门"是不够的：那家 10:30-17:30 的店，晚餐排在 17:30
    起点正好卡在关门那一刻——整顿饭都吃不成。所以起点与**结束时刻**都要在营业区间内。
    """
    if parse_open_time(text) is None:
        return True
    return is_open_at(text, start_minute) and is_open_at(
        text, start_minute + duration_minutes
    )
