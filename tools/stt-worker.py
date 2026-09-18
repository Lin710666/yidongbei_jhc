#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
stt-worker.py —— 语音识别工作进程（被 lib/stt.js 以子进程方式调用）

给一段音频，拿回识别出的文字。用的是 OpenAI Whisper（transformers 的
`pipeline("automatic-speech-recognition")`），**完全离线**：模型目录由 --model 指定，
只有本地文件，不会去 huggingface 拉任何东西。

## 为什么优先吃 WAV，而不是"顺手支持 webm"

浏览器 MediaRecorder 在 Chrome/Edge 上录出来的是 **webm/opus**，而 transformers 的
音频前处理链路最终要的是"一段 numpy 浮点波形"。把 webm 变成波形有两条路：

  1. 调 ffmpeg（子进程或 torchaudio 的 ffmpeg 后端）—— 这台机器上**不一定有 ffmpeg**，
     而且多一个外部可执行文件就多一种"在别人机器上装不上"的失败方式。
  2. 用 soundfile/librosa 直接解 —— soundfile 走 libsndfile，**不支持 webm/opus**；
     librosa 的音频后端（audioread）最后还是要 ffmpeg 或 soundfile。

所以最稳的路子是：**前端录完 webm 后，用 AudioContext 解码并重采样成 16kHz 单声道
16-bit PCM WAV 再传上来**（见 public/js/voice.js）。这条路只用浏览器内置能力，
后端只需要一个"读 WAV"的实现，而读 WAV 用 Python 内置的 `wave` 模块就够了 ——
零第三方依赖，永远不会因为缺解码器而失败。

但"只用内置模块"会让无损压缩格式（flac/ogg）也读不了，所以这里的顺序是：
**soundfile → librosa → 内置 wave**，前两个是增强项，后一个是保底。
本机实测两个都在（soundfile 0.14 / librosa 0.11），所以 flac 之类也能吃。

## 关于显存（这台机器的硬约束）

RTX 5060 只有 8GB，而且实测经常被 ComfyUI / 本地大模型占掉一大半。Whisper-small
的权重约 1GB（fp32 载入约 2.5GB 显存），看上去装得下，但**加载那一刻**的峰值
容易撞上别的程序正在用的显存。所以这里的策略是：

  · 先看 `torch.cuda.mem_get_info()` 的可用量，低于阈值就直接上 CPU ——
    与其等一个几秒后必然爆的 OOM，不如立刻选一条能跑完的路；
  · 真去 CUDA 上加载时再兜一层 OOM：爆了就**在同一进程里退回 CPU 重载**，
    而不是把错误抛给用户；
  · **绝不**设置 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True。本机
    torch 2.11+cu128 + RTX 5060 上打开它会改成抛
    `CUDA error: shared object initialization failed`，比 OOM 更难查。
    这一条与 tools/triposr-worker.py 里的结论一致，那边也只在注释里留着说明。

用法：
    python stt-worker.py --model <模型目录> --input <音频> [--language zh] [--json]
退出码：0 成功；2 模型不可用；3 输入有问题；4 显存/设备问题；1 其它异常。
stdout 只输出一行 JSON（成功或失败都走它），日志走 stderr —— 与 depth-worker 同一原则。
"""

import argparse
import json
import os
import sys
import time

# ===== 不要把这段注释删掉：它是踩过的坑，不是建议 =====
# CUDA OOM 的提示里常建议设 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True。
# 本机（torch 2.11+cu128 / RTX 5060）开启后会变成
# `CUDA error: shared object initialization failed` —— 见 tools/triposr-worker.py。
# 所以这里既不设置它，也不在失败时建议用户去设它。

# 识别采样率：Whisper 只认 16kHz。放在这里当常量，免得前后端各写一个数字。
SAMPLE_RATE = 16000

# 低于这个可用显存就不上 CUDA。Whisper-small fp32 载入峰值实测约 2.5GB，
# 留一倍余量给它自己和 CUDA 上下文；不够就走 CPU（small 在 CPU 上约 10~20 秒/30 秒音频，
# 慢但一定能出结果 —— 而这台机器上"能出结果"比"快"重要）。
MIN_FREE_VRAM_BYTES = 3 * 1024 ** 3


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def fail(exit_code, msg, **extra):
    """按约定把失败写成一行 JSON 到 stdout，再用非零码退出。

    错误信息一律用中文、且必须是"能照着做"的话：用户看到的是这一段文本，
    不是栈。

    注意第一个参数名是 exit_code 而不是 code：JSON 里那个 `code` 字段是给
    lib/stt.js 用来分派错误的机器可读标识（NO_MODEL_DIR / OOM / ...），
    两者同名会在调用处撞车（`fail(2, '...', code='X')` 直接 TypeError）。
    extra 用来带上这些机器可读的细节。
    """
    payload = {"ok": False, "error": msg}
    payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(exit_code)


def encode_wav_pcm16(path, target_rate=SAMPLE_RATE):
    """
    用 Python 内置 wave 模块读 16-bit PCM WAV → (numpy float32 单声道, 采样率)。

    这是**保底路径**：只要前端按约定录 WAV，它永远可用，不需要任何第三方包。
    只支持 PCM（fmt 1）的 8/16/32 位：其它编码（如 ADPCM、IEEE float）在
    浏览器录出来的 WAV 里不会出现，出现了也宁可明确报错而不是读出一堆噪音。
    """
    import wave
    import numpy as np

    with wave.open(path, 'rb') as w:
        channels = w.getnchannels()
        width = w.getsampwidth()
        rate = w.getframerate()
        frames = w.getnframes()
        comptype = w.getcomptype()
        raw = w.readframes(frames)

    if comptype != 'NONE':
        raise ValueError(f'WAV 用了压缩编码（{comptype}），请提供未压缩的 PCM WAV')
    if width not in (1, 2, 4):
        raise ValueError(f'不支持的 WAV 位宽：{width * 8} 位（只支持 8/16/32 位 PCM）')
    if frames <= 0:
        raise ValueError('WAV 里没有任何采样点（录音是空的）')

    if width == 2:
        data = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    elif width == 1:
        # 8 位 WAV 是无符号的，中点是 128
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        data = np.frombuffer(raw, dtype='<i4').astype(np.float32) / 2147483648.0

    if channels > 1:
        # 交错存放，直接 reshape 后按声道取平均（等价于混成单声道）
        usable = (len(data) // channels) * channels
        data = data[:usable].reshape(-1, channels).mean(axis=1)

    return np.ascontiguousarray(data, dtype=np.float32), rate


def load_audio(path, target_rate=SAMPLE_RATE):
    """
    读音频 → (numpy float32 单声道, 采样率, 用的哪个后端)。

    顺序有意为之：soundfile / librosa 是"能读更多格式"的增强项，内置 wave 是保底。
    注意不要写成"先试内置、失败再试 soundfile" —— 那样 WAV 永远走内置，
    soundfile 就成了死代码；而 soundfile 读大文件更快、还能读 flac。
    """
    errors = []

    try:
        import soundfile as sf
        data, rate = sf.read(path, dtype='float32', always_2d=False)
        if data.ndim > 1:
            data = data.mean(axis=1)          # 多声道 → 单声道
        return data.astype('float32'), int(rate), 'soundfile'
    except Exception as e:  # noqa: BLE001
        errors.append(f'soundfile: {type(e).__name__}: {e}')

    try:
        import librosa
        data, rate = librosa.load(path, sr=None, mono=True)
        return data.astype('float32'), int(rate), 'librosa'
    except Exception as e:  # noqa: BLE001
        errors.append(f'librosa: {type(e).__name__}: {e}')

    try:
        data, rate = encode_wav_pcm16(path, target_rate)
        return data, rate, 'wave'
    except Exception as e:  # noqa: BLE001
        errors.append(f'wave: {type(e).__name__}: {e}')

    raise RuntimeError(
        '读不了这个音频文件。\n'
        f'  文件：{path}\n'
        '  依次试过的解码方式：\n'
        + '\n'.join(f'   · {e}' for e in errors)
        + '\n  建议：让前端录成 16kHz 单声道 16-bit WAV 再上传 —— '
          '这样用 Python 内置 wave 模块就能读，不依赖 ffmpeg。'
    )


def resample_to(data, rate, target_rate=SAMPLE_RATE):
    """
    重采样到 16kHz。已经是对的就不动。

    优先 librosa（自带抗混叠滤波，质量好）；它不在时退到线性插值。
    线性插值对语音识别够用 —— 反正 Whisper 内部的前处理还会再做一遍
    归一化与 80 通道 mel 变换，插值带来的高频镜像影响有限；但**降采样不滤波**
    会有混叠，所以 librosa 优先。
    """
    if rate == target_rate:
        return data
    try:
        import librosa
        return librosa.resample(data, orig_sr=rate, target_sr=target_rate).astype('float32')
    except Exception as e:  # noqa: BLE001
        log(f'[stt] librosa 重采样不可用（{type(e).__name__}: {e}），改用线性插值')
    import numpy as np
    n_out = int(round(len(data) * target_rate / float(rate)))
    if n_out <= 0:
        return data
    idx = np.linspace(0, len(data) - 1, n_out, dtype=np.float64)
    lo = np.floor(idx).astype(np.int64)
    hi = np.minimum(lo + 1, len(data) - 1)
    frac = (idx - lo).astype(np.float32)
    return (data[lo] * (1 - frac) + data[hi] * frac).astype('float32')


def pick_device(requested):
    """
    决定跑在哪。返回 (device, 原因说明)。

    这里的判断故意"保守"：显存不够宁可先上 CPU。原因见文件头的显存那段 ——
    8GB 卡上被别的程序占了 4GB 是常态，而 Whisper 加载完成前无法知道真正的峰值。
    """
    if requested == 'cpu':
        return 'cpu', '调用方指定 --device cpu'
    try:
        import torch
    except Exception as e:  # noqa: BLE001
        return 'cpu', f'没有 torch（{type(e).__name__}），用 CPU'

    if not torch.cuda.is_available():
        return 'cpu', '本机 CUDA 不可用（cuda.is_available() 为假），用 CPU'

    try:
        free, total = torch.cuda.mem_get_info()
        if free < MIN_FREE_VRAM_BYTES:
            return 'cpu', (f'显存可用只有 {free / 1024 ** 3:.1f}GB / {total / 1024 ** 3:.1f}GB'
                           f'（低于 {MIN_FREE_VRAM_BYTES / 1024 ** 3:.0f}GB 的门槛），用 CPU')
    except Exception:  # noqa: BLE001
        # 查不到显存不当成失败：继续按 CUDA 试，真 OOM 还有下面那层回退
        pass

    return 'cuda', f'CUDA 可用且显存够（{torch.cuda.get_device_name(0)}）'


def build_pipeline(model_dir, device):
    """按指定设备加载 pipeline。抽出来是为了让"CUDA 失败 → CPU 重载"能复用同一段代码。"""
    import torch
    from transformers import pipeline

    torch_dtype = torch.float16 if device == 'cuda' else torch.float32
    return pipeline(
        'automatic-speech-recognition',
        model=model_dir,
        device=0 if device == 'cuda' else -1,
        torch_dtype=torch_dtype,
    )


def is_oom(e):
    """判断异常是不是显存不足。torch 的 OOM 是 torch.cuda.OutOfMemoryError，
    但镜像/版本差异下也可能只是一句 RuntimeError('CUDA out of memory...')。"""
    name = type(e).__name__.lower()
    msg = str(e).lower()
    return 'outofmemory' in name or 'out of memory' in msg or 'cuda error' in msg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True, help='Whisper 模型目录（本地，不联网）或 HF 名字')
    ap.add_argument('--input', required=True, help='输入音频路径（推荐 16kHz 单声道 16-bit WAV）')
    ap.add_argument('--language', default='', help='语言代码，默认 zh（中文）；传 auto 走自动探测')
    ap.add_argument('--device', default='auto', choices=['auto', 'cuda', 'cpu'],
                    help='跑在哪；auto 会看显存自己选，cuda 失败也会自动退回 CPU')
    ap.add_argument('--task', default='transcribe', choices=['transcribe', 'translate'],
                    help='transcribe 保持原语言；translate 翻成英文')
    ap.add_argument('--no-timestamps', action='store_true', help='不返回分段时间戳（更省内存）')
    ap.add_argument('--json', action='store_true', help='结果以 JSON 输出（与成功路径一致，为兼容保留）')
    args = ap.parse_args()

    # ---- 输入检查：全部在加载模型之前做完 ----
    # 先把"不花钱就能发现的问题"报掉。加载 1GB 权重要几秒到几十秒，
    # 参数错了却等加载完才报，用户会以为程序卡死。
    if not os.path.isdir(args.model):
        fail(2, f'模型目录不存在：{args.model}\n'
                f'请先运行 npm run fetch:whisper 下载（默认 openai/whisper-small，约 1GB，走 hf-mirror 镜像）。',
             code='NO_MODEL_DIR')
    # 权重文件是 HuggingFace 的布局：pytorch 权重 + 前处理配置。
    # 只认 model.safetensors 会让老的 .bin 权重被误判成"没下载"，
    # 所以两种都接受（fetch-whisper.js 下的是 safetensors）。
    has_weights = any(
        os.path.isfile(os.path.join(args.model, f))
        for f in ('model.safetensors', 'pytorch_model.bin', 'model.safetensors.index.json')
    )
    if not has_weights:
        fail(2, f'模型目录里没有权重文件（model.safetensors / pytorch_model.bin）：{args.model}\n'
                f'下载可能中断了，重新运行 npm run fetch:whisper 即可（已下好的文件会跳过）。',
             code='NO_MODEL_WEIGHTS')
    if not os.path.isfile(args.input):
        fail(3, f'输入音频不存在：{args.input}', code='BAD_INPUT')

    t0 = time.time()

    try:
        import numpy as np  # noqa: F401  仅用于尽早失败：缺 numpy 的话下面全跑不了
        import torch
        import transformers  # noqa: F401
    except Exception as e:  # noqa: BLE001
        fail(2, f'缺少 Python 依赖：{type(e).__name__}: {e}\n'
                f'需要 torch + transformers（+ 建议 soundfile / librosa）。\n'
                f'可以复用本机已有的 AI 环境：设 WENLV_PYTHON 指向它的 python.exe，'
                f'或在项目 venv 里 npm run fetch:whisper 之后重试。',
             code='NO_DEPS')

    # ---- 读音频 ----
    try:
        t_audio = time.time()
        data, rate, backend = load_audio(args.input)
        data = resample_to(data, rate)
        audio_s = len(data) / float(SAMPLE_RATE)
        log(f'[stt] 音频就绪 后端={backend} 原始采样率={rate} 时长={audio_s:.2f}s '
            f'耗时={time.time() - t_audio:.1f}s')
    except Exception as e:  # noqa: BLE001
        fail(3, f'音频解码失败：{e}', code='BAD_AUDIO')

    if audio_s < 0.2:
        # 太短的音频 Whisper 会返回空串或幻觉出一句固定的客套话，不如直接说清楚
        fail(3, f'音频太短（{audio_s:.2f} 秒），至少要有 0.2 秒。', code='TOO_SHORT')

    # ---- 选设备并加载模型 ----
    device, why = pick_device(args.device)
    log(f'[stt] 设备：{device}（{why}）')
    device_fallback = None
    try:
        t1 = time.time()
        pipe = build_pipeline(args.model, device)
        log(f'[stt] 模型载入 {time.time() - t1:.1f}s（{args.model}）')
    except Exception as e:  # noqa: BLE001
        # CUDA 加载失败（最常见的还是显存）→ 在同一进程里退回 CPU。
        # 为什么不直接失败：用户要的是"这句话是什么"，不是"用没用上显卡"。
        if device == 'cuda' and is_oom(e):
            log(f'[stt] CUDA 加载失败（{type(e).__name__}: {str(e).splitlines()[0][:200]}），'
                f'自动退回 CPU 重载')
            device_fallback = 'CUDA 加载失败，已退回 CPU'
            device = 'cpu'
            try:
                t1 = time.time()
                pipe = build_pipeline(args.model, 'cpu')
                log(f'[stt] 模型载入（CPU）{time.time() - t1:.1f}s')
            except Exception as e2:  # noqa: BLE001
                import traceback
                log(traceback.format_exc())
                fail(1, f'模型加载失败（CUDA 与 CPU 都试过）：{type(e2).__name__}: {e2}')
        else:
            import traceback
            log(traceback.format_exc())
            if is_oom(e):
                fail(4, '显存不足，加载模型失败。\n'
                        '  可以照做：\n'
                        '   · 用 --device cpu 强制走 CPU（Whisper-small 在 CPU 上也能跑，只是慢些）\n'
                        '   · 关掉正在占用显卡的程序（ComfyUI / 本地大模型 / 游戏 / 浏览器硬件加速）\n'
                        f'  原始错误：{type(e).__name__}: {e}',
                     code='OOM_LOAD')
            fail(1, f'模型加载失败：{type(e).__name__}: {e}\n'
                    f'  请确认模型目录完整（{args.model}），必要时重新运行 npm run fetch:whisper。')

    # ---- 识别 ----
    lang = (args.language or '').strip()
    if lang.lower() in ('auto', 'none'):
        lang = ''
    generate_kwargs = {'task': args.task}
    if lang:
        generate_kwargs['language'] = lang

    try:
        t2 = time.time()
        out = pipe(
            {'array': data, 'sampling_rate': SAMPLE_RATE},
            generate_kwargs=generate_kwargs,
            return_timestamps=not args.no_timestamps,
        )
        infer_s = time.time() - t2
    except Exception as e:  # noqa: BLE001
        import traceback
        log(traceback.format_exc())
        if is_oom(e):
            fail(4, '识别过程中显存不足。\n'
                    '  最直接的办法是用 --device cpu 再试一次（慢，但一定能出结果）。\n'
                    f'  原始错误：{type(e).__name__}: {e}',
                 code='OOM_INFER')
        fail(1, f'语音识别失败：{type(e).__name__}: {e}')

    # transformers 的 pipeline 单条输入返回 dict，批量输入返回 list；这里只喂一条，
    # 但不同版本偶有差异，统一取一下。
    if isinstance(out, list):
        out = out[0] if out else {}
    text = str(out.get('text', '') or '').strip()
    chunks = out.get('chunks') or []

    result = {
        'ok': True,
        'text': text,
        'language': lang or 'auto',
        'durationMs': int(round(audio_s * 1000)),
        'audioSeconds': round(audio_s, 3),
        'inferSeconds': round(infer_s, 2),
        'totalSeconds': round(time.time() - t0, 2),
        'device': device,
        'deviceFallback': device_fallback,
        'decoder': backend,
        'model': args.model,
        'segments': len(chunks) if chunks else 0,
        'empty': text == '',
    }
    if chunks:
        # 只带时间戳，不带每段的文字 —— 单次识别的文字已经在 text 里，
        # 重复带上会让大段音频的返回体膨胀好几倍。
        result['timestamps'] = [
            {'start': round(float(c.get('timestamp', (0, 0))[0] or 0), 2),
             'end': round(float(c.get('timestamp', (0, 0))[1] or 0), 2)}
            for c in chunks[:200]
        ]
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
