# -*- coding: utf-8 -*-
"""
把 Live2D 动作文件的幅度按比例压小。

背景（实测）：
  hanfu 这套动作是 PSD2Live 自动生成的，幅度偏大，尤其是 shake：
      shake: ParamAngleX  -20 → +20   峰峰 40°
      nod:   ParamAngleY  -18 → +6    峰峰 24°
      idle:  ParamAngleZ  -2  → +2    （这个正常）
  实测把动作打开后，ParamAngleX 的峰峰从 15.9° 跳到 41.08° ——
  人物会被明显甩偏，这就是"动作幅度过大导致形象偏移"的直接原因。

做法：只缩"旋转类"参数（Angle* / BodyAngle*），**不动**眼睛开合、
      呼吸、口型这些 —— 那些是表情与生理动作，缩小了会显得病态。

用法：
    python tools/shrink_motions.py <模型目录> [--scale 0.4]
    python tools/shrink_motions.py public/models/hanfu --scale 0.4
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

#: 需要缩幅度的参数（旋转/位移类）。其余参数原样保留。
ROTATE = (
    "ParamAngleX", "ParamAngleY", "ParamAngleZ",
    "ParamBodyAngleX", "ParamBodyAngleY", "ParamBodyAngleZ",
    "ParamBodyX", "ParamBodyY", "ParamBodyZ",
)


def is_rotate(pid: str) -> bool:
    return pid in ROTATE


def scale_segments(segs, k):
    """Segments 形如 [t0, v0, type, t1, v1, type, ...] —— 只缩 v，不动 t 与 type。

    解析规则（Cubism motion3 的段格式）：
      线性(0)：[t, v, 0]              占 3 个
      贝塞尔(1)：[t, v, 1, c1t,c1v,c2t,c2v, t2,v2]  占 8 个
      阶梯(2)/反阶梯(3)：[t, v, 2]    与线性同长，但只是采样点
    这里按"每段头部 3 个元素"推进，遇到贝塞尔多读几个控制点。
    """
    out = []
    i = 0
    n = len(segs)
    while i < n:
        t = segs[i]
        if i + 1 >= n:
            out.append(t)
            break
        v = segs[i + 1]
        typ = segs[i + 2] if i + 2 < n else 0
        out.append(t)
        out.append(v * k)
        out.append(typ)
        if typ == 1:
            # 贝塞尔：后面还有 5 个数（c1t,c1v,c2t,c2v,t2,v2 里的前 5 个）
            for j in range(i + 3, min(i + 8, n)):
                # 控制点的 y 也要缩，否则曲线形状会歪
                if (j - (i + 3)) % 2 == 1:
                    out.append(segs[j] * k)
                else:
                    out.append(segs[j])
            i += 8
        else:
            i += 3
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("model_dir", help="模型目录（含 *.motion3.json）")
    ap.add_argument("--scale", type=float, default=0.4,
                    help="旋转类参数的缩放比例，默认 0.4")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    d = Path(args.model_dir)
    if not d.is_dir():
        print(f"  找不到目录：{d}")
        return 1
    files = sorted(d.glob("*.motion3.json"))
    if not files:
        print(f"  {d} 下没有 motion3.json")
        return 1

    k = max(0.01, min(1.0, args.scale))
    print(f"  目录 {d}")
    print(f"  缩放系数 {k}（只作用于旋转类参数）\n")

    for f in files:
        j = json.loads(f.read_text(encoding="utf-8"))
        curves = j.get("Curves") or []
        changed = []
        for c in curves:
            if not isinstance(c, dict):
                continue
            pid = c.get("Id") or ""
            if not is_rotate(pid):
                continue
            segs = c.get("Segments") or []
            if not segs:
                continue
            # 统计缩放前的峰峰
            vals = [segs[i] for i in range(1, len(segs), 3)]
            if not vals:
                continue
            before = max(vals) - min(vals)
            c["Segments"] = scale_segments(segs, k)
            vals2 = [c["Segments"][i] for i in range(1, len(c["Segments"]), 3)]
            after = max(vals2) - min(vals2) if vals2 else 0
            changed.append((pid, before, after))

        if not changed:
            print(f"    {f.name}: 没有旋转类参数，跳过")
            continue
        if args.dry_run:
            print(f"    {f.name}: （dry-run，未写入）")
        else:
            shutil.copy2(f, str(f) + ".bak")
            f.write_text(json.dumps(j, ensure_ascii=False, indent="\t"), encoding="utf-8")
            print(f"    {f.name}: 已改写（原文件备份为 {f.name}.bak）")
        for pid, b, a in changed:
            print(f"        {pid:<20} {b:6.1f} -> {a:6.1f}")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
