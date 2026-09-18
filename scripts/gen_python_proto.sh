#!/usr/bin/env bash
# Unix/macOS/Docker 薄包装：跨平台实现见 scripts/gen_python_proto.py（需 grpcio-tools）。
# 可用 PYTHON=/path/to/python 指定解释器。Windows 下请直接运行：
#   python scripts/gen_python_proto.py
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3}"
exec "$PYTHON" "$DIR/gen_python_proto.py" "$@"
