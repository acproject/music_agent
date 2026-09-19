#!/usr/bin/env python3
"""下载 CREPE ONNX 音高模型到仓库本地目录 models/crepe/。

权重来源：Hugging Face 仓库 NeoPy/Ultimate-Models
    predictors/crepe_{tiny,small,medium,large,full}.onnx

特点（仅依赖 Python 标准库）：
  - 默认走国内镜像 https://hf-mirror.com，可用 --endpoint 或环境变量
    HF_ENDPOINT 切换（例如 HF_ENDPOINT=https://huggingface.co）；
  - 断点续传（HTTP Range），中断后重跑同一命令即可继续；
  - 网络错误自动重试（指数退避），并对 DNS / 超时 / 403 / 代理给出中文提示；
  - 下载完成后计算真实 sha256 写入 manifest.json（LFS CDN 的 ETag 与真实
    sha256 不一致，故不使用 ETag 做完整性校验）；
  - 若环境中已安装 onnxruntime，默认额外做一次加载校验（--no-validate 关闭）。

用法：
    python scripts/download_model.py                 # 下载 tiny
    python scripts/download_model.py --models tiny,small
    python scripts/download_model.py --models all
    python scripts/download_model.py --endpoint https://huggingface.co
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL_DIR = REPO_ROOT / "models" / "crepe"

HF_REPO_ID = "NeoPy/Ultimate-Models"
FILE_TEMPLATE = "predictors/crepe_{size}.onnx"
VALID_SIZES = ("tiny", "small", "medium", "large", "full")
DEFAULT_ENDPOINT = "https://hf-mirror.com"

CHUNK_BYTES = 1 << 20  # 1 MiB
MAX_RETRIES = 3
CONNECT_TIMEOUT = 30
READ_TIMEOUT = 120
MANIFEST_NAME = "manifest.json"


def build_url(endpoint: str, size: str) -> str:
    return (
        f"{endpoint.rstrip('/')}/{HF_REPO_ID}/resolve/main/"
        f"{FILE_TEMPLATE.format(size=size)}"
    )


def human_size(num: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if num < 1024.0 or unit == "GB":
            return f"{num:.1f}{unit}"
        num /= 1024.0
    return f"{num:.1f}GB"


def classify_error(exc: BaseException) -> str:
    """把常见网络错误翻译成可操作的中文提示。"""
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code in (401, 403):
            return (
                f"HTTP {exc.code}：镜像/源站拒绝访问，可尝试 --endpoint 切换源，"
                "或检查网络代理（HTTP_PROXY/HTTPS_PROXY）"
            )
        if exc.code == 404:
            return f"HTTP 404：文件不存在，请确认仓库 {HF_REPO_ID} 中的路径"
        return f"HTTP {exc.code}：{exc.reason}"
    reason = getattr(exc, "reason", exc)
    if isinstance(reason, socket.gaierror):
        return "DNS 解析失败：检查网络连接，或尝试 --endpoint 切换到其他镜像"
    if isinstance(reason, (socket.timeout, TimeoutError)) or isinstance(
        exc, (socket.timeout, TimeoutError)
    ):
        return "连接/读取超时：网络较慢可重试（支持断点续传），或配置 HTTP(S)_PROXY"
    text = str(reason)
    if "proxy" in text.lower():
        return f"代理连接失败：{text}（检查 HTTP_PROXY/HTTPS_PROXY 设置）"
    return f"网络错误：{text}"


def head_size(url: str) -> int:
    """查询远端文件大小；HEAD 不可用时返回 0（不阻塞下载）。"""
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=CONNECT_TIMEOUT) as resp:
            return int(resp.headers.get("Content-Length") or 0)
    except Exception:
        return 0


def _sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _report(part: Path, have: int, total: int) -> None:
    if total:
        pct = min(100.0, have * 100.0 / total)
        sys.stdout.write(
            f"\r  {human_size(have)} / {human_size(total)} ({pct:5.1f}%)"
        )
    else:
        sys.stdout.write(f"\r  已下载 {human_size(have)}")
    sys.stdout.flush()


def download_one(url: str, dest: Path, force: bool) -> dict:
    """下载单个文件，返回 manifest 条目。已存在且大小一致时跳过。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")

    remote_total = head_size(url)
    if dest.exists() and not force:
        local_size = dest.stat().st_size
        if remote_total == 0 or local_size == remote_total:
            print(f"[跳过] {dest.name} 已存在（{human_size(local_size)}）")
            return _manifest_entry(dest, url, reused=True)
        print(f"[重下] {dest.name} 本地 {local_size} != 远端 {remote_total}")

    have = part.stat().st_size if part.exists() else 0
    if remote_total and have >= remote_total:
        # 残留的 .part 已完整（上次在重命名前中断）
        os.replace(part, dest)
        return _finalize(dest, url)

    last_exc: BaseException | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            headers = {"User-Agent": "music-agent-model-downloader/1.0"}
            mode = "wb"
            if have:
                headers["Range"] = f"bytes={have}-"
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=READ_TIMEOUT) as resp:
                if have and resp.status == 206:
                    content_range = resp.headers.get("Content-Range") or ""
                    if "/" in content_range:
                        remote_total = int(content_range.rsplit("/", 1)[1])
                    mode = "ab"
                else:
                    # 200：源站不支持 Range 或忽略 Range，从头覆盖
                    have = 0
                    mode = "wb"
                    remote_total = int(resp.headers.get("Content-Length") or 0) or remote_total

                with part.open(mode + "") as f:
                    last_report = 0
                    while True:
                        block = resp.read(CHUNK_BYTES)
                        if not block:
                            break
                        f.write(block)
                        have += len(block)
                        # 约每 2MB 刷新一次进度，避免日志噪音
                        if have - last_report >= 2 << 20:
                            _report(part, have, remote_total)
                            last_report = have
                    _report(part, have, remote_total)
            sys.stdout.write("\n")
            if remote_total and have != remote_total:
                raise IOError(
                    f"下载不完整：{have}/{remote_total} 字节，重跑本命令可断点续传"
                )
            os.replace(part, dest)
            return _finalize(dest, url)
        except (urllib.error.URLError, OSError) as exc:
            last_exc = exc
            sys.stdout.write("\n")
            hint = classify_error(exc)
            if attempt < MAX_RETRIES:
                wait = 2 ** (attempt - 1)
                print(f"[重试 {attempt}/{MAX_RETRIES - 1}] {hint}，{wait}s 后继续…")
                time.sleep(wait)
                have = part.stat().st_size if part.exists() else 0
            else:
                print(f"[失败] {hint}", file=sys.stderr)
    raise SystemExit(f"下载 {url} 失败：{classify_error(last_exc)}")


def _finalize(dest: Path, url: str) -> dict:
    sha = _sha256_of(dest)
    print(f"[完成] {dest.name}  {human_size(dest.stat().st_size)}  sha256={sha[:16]}…")
    return _manifest_entry(dest, url, reused=False, sha=sha)


def _manifest_entry(dest: Path, url: str, reused: bool, sha: str | None = None) -> dict:
    return {
        "file": dest.name,
        "size": dest.stat().st_size,
        "sha256": sha or _sha256_of(dest),
        "source_url": url,
        "downloaded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "reused": reused,
    }


def write_manifest(model_dir: Path, entries: list[dict]) -> None:
    manifest_path = model_dir / MANIFEST_NAME
    existing: dict = {}
    if manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing = {}
    for e in entries:
        existing[e["file"]] = e
    manifest_path.write_text(
        json.dumps(existing, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"[清单] 已更新 {manifest_path}")


def validate_onnx(path: Path) -> bool:
    """用 onnxruntime 做一次 CPU 加载校验；未安装 onnxruntime 则跳过。"""
    try:
        import onnxruntime as ort
    except ImportError:
        print("[校验] 未安装 onnxruntime，跳过加载校验（pip install onnxruntime）")
        return True
    try:
        sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        ipt = sess.get_inputs()[0]
        out = sess.get_outputs()[0]
        print(
            f"[校验] onnxruntime {ort.__version__} 加载成功："
            f"输入 {ipt.name}{ipt.shape} -> 输出 {out.name}{out.shape}"
        )
        return True
    except Exception as exc:  # noqa: BLE001 - 校验失败需展示原始原因
        print(f"[校验] 模型加载失败：{exc}", file=sys.stderr)
        return False


def parse_sizes(raw: str) -> list[str]:
    if raw.strip().lower() == "all":
        return list(VALID_SIZES)
    sizes = [s.strip() for s in raw.split(",") if s.strip()]
    bad = [s for s in sizes if s not in VALID_SIZES]
    if bad:
        raise SystemExit(f"未知模型规格：{bad}，可选：{', '.join(VALID_SIZES)} 或 all")
    if not sizes:
        raise SystemExit("请用 --models 指定至少一个规格")
    return sizes


def main() -> None:
    parser = argparse.ArgumentParser(description="下载 CREPE ONNX 模型到 models/crepe/")
    parser.add_argument(
        "--models",
        default="tiny",
        help="逗号分隔的规格：tiny,small,medium,large,full（默认 tiny，all=全部）",
    )
    parser.add_argument(
        "--endpoint",
        default=os.getenv("HF_ENDPOINT", DEFAULT_ENDPOINT),
        help=f"HF 兼容源（默认 {DEFAULT_ENDPOINT}，也可用环境变量 HF_ENDPOINT）",
    )
    parser.add_argument(
        "--dir",
        type=Path,
        default=DEFAULT_MODEL_DIR,
        help="模型落盘目录（默认仓库根 models/crepe）",
    )
    parser.add_argument(
        "--force", action="store_true", help="即使本地文件已存在也重新下载"
    )
    parser.add_argument(
        "--no-validate",
        action="store_true",
        help="下载后不使用 onnxruntime 做加载校验",
    )
    args = parser.parse_args()

    sizes = parse_sizes(args.models)
    model_dir = args.dir.resolve()
    print(f"模型来源：{args.endpoint.rstrip('/')}/{HF_REPO_ID}")
    print(f"落盘目录：{model_dir}")
    print(f"规格：{', '.join(sizes)}")

    entries: list[dict] = []
    ok = True
    for size in sizes:
        url = build_url(args.endpoint, size)
        dest = model_dir / f"crepe_{size}.onnx"
        print(f"\n== crepe_{size}.onnx ==")
        entry = download_one(url, dest, force=args.force)
        entries.append(entry)
        if not args.no_validate and not validate_onnx(dest):
            ok = False

    write_manifest(model_dir, entries)
    if not ok:
        raise SystemExit("部分模型加载校验失败，请检查下载或重装 onnxruntime")
    print("\n全部完成。离线分析设置 PITCH_BACKEND=crepe 即可启用高质量音高后端。")


if __name__ == "__main__":
    main()
