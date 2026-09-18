#!/usr/bin/env python3
"""由 proto/ 生成 Python gRPC 桩代码（跨平台，仅依赖标准库 + grpcio-tools）。

被 scripts/gen_proto.mjs python 调用，也可由 scripts/gen_python_proto.sh
（Unix/Docker 薄包装）或直接 `python scripts/gen_python_proto.py` 运行。

生成物：services/analysis/app/proto/<package>/*_pb2.py、*_pb2_grpc.py，并补齐包 __init__.py。
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROTO_DIR = ROOT / "proto"
OUT = ROOT / "services" / "analysis" / "app" / "proto"

# grpc_tools 生成的跨文件 import 形如 `import events_pb2 as ...`，
# 在包结构下必须改写为 `from music.v1 import events_pb2 as ...`。
_FLAT_IMPORT = re.compile(r"^import (\w+_pb2) as (\w+)$", re.MULTILINE)


def main() -> int:
    if importlib.util.find_spec("grpc_tools") is None:
        print(
            "error: 未安装 grpcio-tools，请先 `pip install grpcio grpcio-tools`",
            file=sys.stderr,
        )
        return 2

    proto_files = sorted(PROTO_DIR.rglob("*.proto"))
    if not proto_files:
        print(f"error: {PROTO_DIR} 下没有 .proto 文件", file=sys.stderr)
        return 2

    OUT.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable,
        "-m",
        "grpc_tools.protoc",
        f"-I{PROTO_DIR}",
        f"--python_out={OUT}",
        f"--grpc_python_out={OUT}",
        *[str(p) for p in proto_files],
    ]
    result = subprocess.run(cmd)
    if result.returncode != 0:
        return result.returncode

    # 修正生成物中的扁平 import（包路径取文件相对 OUT 的父目录，兼容未来新增 package）。
    for path in OUT.rglob("*_pb2*.py"):
        text = path.read_text(encoding="utf-8")
        package = ".".join(path.relative_to(OUT).parent.parts)
        replacement = (
            rf"from {package} import \1 as \2" if package else r"import \1 as \2"
        )
        fixed = _FLAT_IMPORT.sub(replacement, text)
        if fixed != text:
            path.write_text(fixed, encoding="utf-8")
            print(f"fixed imports: {path.relative_to(OUT)}")

    # 为 OUT 到每个生成物所在目录的整条路径补齐 __init__.py。
    package_dirs = {OUT}
    for generated in OUT.rglob("*_pb2.py"):
        current = generated.parent
        while True:
            package_dirs.add(current)
            if current == OUT:
                break
            current = current.parent
    for package_dir in sorted(package_dirs):
        init_file = package_dir / "__init__.py"
        if not init_file.exists():
            init_file.touch()

    print(f"python protos generated at: {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
