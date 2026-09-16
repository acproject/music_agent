#!/usr/bin/env bash
# 由 proto/music/v1 生成 TypeScript 类型到 apps/web/src/proto
# 依赖：protoc（系统）+ ts-proto（web devDependencies，需先 pnpm install）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/apps/web"
OUT="$WEB/src/proto"
PLUGIN="$WEB/node_modules/.bin/protoc-gen-ts_proto"

if [[ ! -x "$PLUGIN" ]]; then
  echo "error: ts-proto 未安装，请先在 apps/web 执行 pnpm install" >&2
  exit 1
fi

mkdir -p "$OUT"

protoc \
  -I"$ROOT/proto" \
  --plugin=protoc-gen-ts_proto="$PLUGIN" \
  --ts_proto_out="$OUT" \
  --ts_proto_opt=esModuleInterop=true,outputServices=generic-definitions,outputClientImpl=false,useOptionals=messages,fileSuffix=.gen \
  "$ROOT/proto/music/v1/events.proto" \
  "$ROOT/proto/music/v1/analysis.proto"

echo "web protos generated at: $OUT"
