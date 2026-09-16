#!/usr/bin/env bash
# 由 proto/music/v1 生成 Python gRPC 代码到 services/analysis/app/proto/music/v1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/services/analysis/app/proto"

mkdir -p "$OUT/music/v1"

# 可用 PYTHON=/path/to/python 指定带 grpcio-tools 的解释器（如 venv）
PYTHON="${PYTHON:-python3}"

"$PYTHON" -m grpc_tools.protoc \
  -I"$ROOT/proto" \
  --python_out="$OUT" \
  --grpc_python_out="$OUT" \
  "$ROOT/proto/music/v1/events.proto" \
  "$ROOT/proto/music/v1/analysis.proto"

# grpc_tools 生成的跨文件 import 是 `import events_pb2`，
# 在包结构下无法工作，统一改写为 `from music.v1 import events_pb2 ...`
"$PYTHON" - "$OUT" <<'PY'
import pathlib
import re
import sys

out = pathlib.Path(sys.argv[1])
pattern = re.compile(r"^import (\w+_pb2) as (\w+)$", re.MULTILINE)

for path in out.rglob("*_pb2*.py"):
    text = path.read_text(encoding="utf-8")
    fixed = pattern.sub(r"from music.v1 import \1 as \2", text)
    if fixed != text:
        path.write_text(fixed, encoding="utf-8")
        print(f"fixed imports: {path.relative_to(out)}")
PY

# 建立 Python 包
touch "$OUT/__init__.py" "$OUT/music/__init__.py" "$OUT/music/v1/__init__.py"

echo "python protos generated at: $OUT"
