"""音频抽取：从上传的视频里把音轨扒出来，放进独立的音频库。

## 为什么要这一步

用户上传宣传片之后，现场常要换配乐（原声是日语歌、或者干脆只有环境音）。
但"换配乐"的前提是**先能拿到音频**——浏览器端做不到无损抽取，
所以放在后端：上传视频的同一个请求里顺手探一次音轨，有就抽出来。

这样前端就有了三样东西：
  · 视频自带的原声（默认就用它，什么都不用做）
  · 抽出来的独立音轨文件（可以单独试听、单独指定给别的片子用）
  · 都没有声音时，明确告诉用户"这条片子没有音轨"

## 为什么用 PyAV 而不是调 ffmpeg

这台机器 PATH 里没有 ffmpeg。PyAV 的 wheel **自带 FFmpeg 库**，
pip 装完就能用，不用让用户再去装一个系统级 ffmpeg ——
「本地部署、拷贝即用」这个前提下，这一点很重要。
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

#: 抽出来的音轨放这儿（和 data/videos 并列）
AUDIO_EXTS = {".m4a", ".mp3", ".opus", ".ogg", ".wav", ".aac", ".flac"}
#: 输出格式固定 m4a：AAC 编码，浏览器原生支持，体积也比 wav 小得多
OUT_EXT = ".m4a"


def probe_audio(video_path: Path) -> Dict[str, Any]:
    """看这个视频有没有音轨，有的话报出编码/声道/时长。

    Returns:
        {"has_audio": bool, "codec": str, "channels": int, "duration": float, "reason": str}
    """
    try:
        import av  # 延迟导入：没装 PyAV 时不影响视频功能本身
    except ImportError:
        return {"has_audio": False, "reason": "没装 PyAV，无法探测音轨"}

    try:
        with av.open(str(video_path)) as c:
            streams = [s for s in c.streams if s.type == "audio"]
            if not streams:
                return {"has_audio": False, "reason": "这条片子没有音轨"}
            s = streams[0]
            dur = float(c.duration / av.time_base) if c.duration else 0.0
            return {
                "has_audio": True,
                "codec": getattr(s.codec_context, "name", "") or "",
                "channels": int(getattr(s.codec_context, "channels", 0) or 0),
                "duration": round(dur, 2),
                "reason": "",
            }
    except Exception as e:  # noqa: BLE001 —— 探测失败不该让上传整体失败
        log.warning("探测音轨失败 %s: %s", video_path, e)
        return {"has_audio": False, "reason": f"探测失败：{e}"}


def extract_audio(video_path: Path, out_dir: Path,
                  out_stem: Optional[str] = None) -> Dict[str, Any]:
    """把视频的音轨抽成 m4a 落到 out_dir。

    Returns:
        {"ok": bool, "path": Path|None, "name": str, "bytes": int, "error": str}
    """
    info = probe_audio(video_path)
    if not info.get("has_audio"):
        return {"ok": False, "path": None, "name": "", "bytes": 0,
                "error": info.get("reason") or "没有音轨"}
    try:
        import av
    except ImportError:
        return {"ok": False, "path": None, "name": "", "bytes": 0,
                "error": "没装 PyAV"}

    out_dir.mkdir(parents=True, exist_ok=True)
    stem = out_stem or video_path.stem
    out_path = out_dir / f"{stem}{OUT_EXT}"

    try:
        with av.open(str(video_path)) as src:
            in_stream = next(s for s in src.streams if s.type == "audio")
            with av.open(str(out_path), mode="w") as dst:
                # 用 aac 重编码而不是 copy：源可能是 opus/ac3，直接 copy 进 m4a 容器
                # 浏览器不一定认；重编码一次兼容性最好，代价也不大。
                out_stream = dst.add_stream("aac", rate=in_stream.codec_context.sample_rate or 44100)
                out_stream.layout = in_stream.codec_context.layout
                for frame in src.decode(in_stream):
                    for packet in out_stream.encode(frame):
                        dst.mux(packet)
                for packet in out_stream.encode(None):   # flush
                    dst.mux(packet)
        return {"ok": True, "path": out_path, "name": out_path.name,
                "bytes": out_path.stat().st_size, "error": ""}
    except Exception as e:  # noqa: BLE001
        log.warning("抽取音轨失败 %s: %s", video_path, e)
        # 半截文件别留在库里
        try:
            out_path.unlink(missing_ok=True)
        except OSError:
            pass
        return {"ok": False, "path": None, "name": "", "bytes": 0, "error": str(e)}


def list_audio(audio_dir: Path) -> List[Dict[str, Any]]:
    """列出音频库里的文件。"""
    if not audio_dir.is_dir():
        return []
    out: List[Dict[str, Any]] = []
    for p in sorted(audio_dir.iterdir()):
        if not p.is_file() or p.suffix.lower() not in AUDIO_EXTS:
            continue
        out.append({
            "name": p.name,
            "url": "/api/audio/" + p.name,
            "bytes": p.stat().st_size,
        })
    return out
