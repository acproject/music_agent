#!/usr/bin/env bash
# Unix/macOS 薄包装：跨平台实现见 scripts/gen_proto.mjs（需 Node >= 18）。
# Windows 下请直接 `node scripts/gen_proto.mjs web` 或在 apps/web 执行 `pnpm proto`。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/gen_proto.mjs" web "$@"
