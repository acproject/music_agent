#!/usr/bin/env bash
# 一键启动 music_agent 全部本地开发服务（Linux / macOS）。
#
#   1. Python 分析引擎  :50051  services/analysis  python -m app.main
#   2. Rust HTTP 网关   :8080   仓库根            cargo run -p music-api
#   3. Vite Web 前端    :5173   apps/web          pnpm dev
#
# 后台守护：setsid 独立进程组 + nohup，PID 写 .run/<name>.pid，
# stdout/stderr 写 logs/<name>.log（终端关闭不影响运行）。
#
# 用法：
#   scripts/start-all.sh [--backend yin|crepe] [--no-engine] [--no-api] [--no-web]
#   PITCH_BACKEND=crepe scripts/start-all.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_DIR="$ROOT/.run"
LOG_DIR="$ROOT/logs"
mkdir -p "$RUN_DIR" "$LOG_DIR"

BACKEND="${PITCH_BACKEND:-yin}"
NO_ENGINE=0; NO_API=0; NO_WEB=0

while [ $# -gt 0 ]; do
    case "$1" in
        --backend) BACKEND="$2"; shift 2 ;;
        --backend=*) BACKEND="${1#*=}"; shift ;;
        --no-engine) NO_ENGINE=1; shift ;;
        --no-api)    NO_API=1; shift ;;
        --no-web)    NO_WEB=1; shift ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "[start] 未知参数: $1" >&2; exit 1 ;;
    esac
done
case "$BACKEND" in
    yin|crepe) ;;
    *) echo "[start] ERROR: --backend 只支持 yin|crepe（当前: $BACKEND）" >&2; exit 1 ;;
esac

c_info() { printf '\033[36m[start]\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[32m[start]\033[0m %s\n' "$*"; }
die()    { printf '\033[31m[start] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# 端口监听检测：优先 ss，退化到 bash 内建 /dev/tcp
port_busy() {
    local port="$1"
    if have ss; then
        ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[.:]${port}\$" && return 0
    fi
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
        exec 3<&- 2>/dev/null; exec 3>&- 2>/dev/null; return 0
    fi
    return 1
}

wait_port() {
    local port="$1" deadline="$2"
    local end=$(( $(date +%s) + deadline ))
    while [ "$(date +%s)" -lt "$end" ]; do
        port_busy "$port" && return 0
        sleep 0.5
    done
    return 1
}

shell_q() { printf '%q' "$1"; }

# ---------------------------------------------------------------- 解释器探测
if [ -z "${PYTHON:-}" ]; then
    if have python3; then PYTHON=python3
    elif have python; then PYTHON=python
    else die "未找到 Python（需要 3.12）。可 PYTHON=/path/python scripts/start-all.sh"; fi
fi
"$PYTHON" --version >/dev/null 2>&1 || die "$PYTHON 不可执行。"

# ---------------------------------------------------------------- 端口冲突预检
check_conflict() {
    local port="$1" name="$2"
    if port_busy "$port"; then
        die "端口 $port 已被占用（$name）。如旧实例仍在运行，请先 scripts/stop-all.sh"
    fi
}
[ "$NO_ENGINE" -eq 1 ] || check_conflict 50051 analysis
[ "$NO_API" -eq 1 ]    || check_conflict 8080  api
[ "$NO_WEB" -eq 1 ]    || check_conflict 5173 web

# ---------------------------------------------------------------- 产物预检
PY_PROTO="$ROOT/services/analysis/app/proto/music/v1/analysis_pb2.py"
if [ ! -f "$PY_PROTO" ]; then
    c_info "未发现 Python proto 生成物，执行 gen_proto.mjs python …"
    have node || die "需要 Node.js>=18 生成 proto 桩代码（node scripts/gen_proto.mjs python）。"
    (cd "$ROOT" && PYTHON="$PYTHON" node scripts/gen_proto.mjs python) || die "Python proto 生成失败。"
fi

if [ "$NO_API" -eq 0 ]; then
    if ! have cargo; then die "未找到 cargo，请先安装 Rust 工具链（rustup）。"; fi
    API_BIN="$ROOT/target/debug/music-api"
    if [ ! -x "$API_BIN" ]; then
        if [ -z "${PROTOC:-}" ] && ! have protoc; then
            die "Rust 首次构建需要 protoc 但未找到。请安装 protoc 并 export PROTOC=/path/protoc"
        fi
    fi
fi

if [ "$NO_WEB" -eq 0 ]; then
    have pnpm || die "未找到 pnpm（npm i -g pnpm 或 corepack enable）。"
    if [ ! -d "$ROOT/apps/web/node_modules" ]; then
        c_info "apps/web/node_modules 不存在，执行 pnpm install（首次较慢）…"
        (cd "$ROOT/apps/web" && pnpm install) || die "pnpm install 失败。"
    fi
fi

# ---------------------------------------------------------------- 启动
start_service() {
    # start_service <name> <workdir> <cmd...>
    local name="$1" workdir="$2"; shift 2
    local pidfile="$RUN_DIR/$name.pid" logfile="$LOG_DIR/$name.log"
    local cmd; cmd="$(printf '%q ' "$@")"
    local inner="cd $(shell_q "$workdir") && exec $cmd"
    if command -v setsid >/dev/null 2>&1; then
        # setsid 独立会话/进程组，关闭终端不退出；非交互脚本中 setsid 不 fork，$! 即 PGID
        setsid bash -c "$inner" >"$logfile" 2>&1 &
    else
        # macOS / 精简环境无 setsid：nohup 兜底，stop 时退化为按 PID + 端口回收
        nohup bash -c "$inner" >"$logfile" 2>&1 &
    fi
    local pid=$!
    echo "$pid" >"$pidfile"
    disown 2>/dev/null || true
    c_ok "$name 已启动（进程组 $pid，日志 logs/$name.log）"
}

if [ "$NO_ENGINE" -eq 0 ]; then
    c_info "启动分析引擎 :50051（PITCH_BACKEND=$BACKEND）…"
    PITCH_BACKEND="$BACKEND" start_service analysis "$ROOT/services/analysis" "$PYTHON" -m app.main
    wait_port 50051 40 || die "引擎 40s 内未监听 :50051，见 logs/analysis.log"
    c_ok "引擎端口就绪。"
fi

if [ "$NO_API" -eq 0 ]; then
    c_info "启动 HTTP 网关 :8080（首次 cargo build 可能需要数分钟）…"
    start_service api "$ROOT" cargo run -p music-api
    wait_port 8080 300 || die "网关 300s 内未监听 :8080，见 logs/api.log"
    # /health 还要确认引擎已连通
    if have curl; then
        ok=0
        end=$(( $(date +%s) + 20 ))
        while [ "$(date +%s)" -lt "$end" ]; do
            body="$(curl -fsS --max-time 2 http://127.0.0.1:8080/health 2>/dev/null || true)"
            if echo "$body" | grep -q '"status":"ok"' && echo "$body" | grep -q '"connected":true'; then
                ok=1; break
            fi
            sleep 0.7
        done
        [ "$ok" -eq 1 ] && c_ok "网关健康检查通过（引擎已连通）。" \
            || printf '\033[33m[start] WARN:\033[0m 网关已起但引擎未连通，检查 logs/analysis.log\n'
    fi
fi

if [ "$NO_WEB" -eq 0 ]; then
    c_info "启动 Web 前端 :5173…"
    start_service web "$ROOT/apps/web" pnpm dev
    wait_port 5173 90 || die "前端 90s 内未监听 :5173，见 logs/web.log"
    c_ok "前端端口就绪。"
fi

# ---------------------------------------------------------------- 汇总
cat <<EOF

============== 全部服务已启动 ==============
  Web 前端       http://localhost:5173
  HTTP 网关      http://localhost:8080
  健康检查       http://localhost:8080/health
  gRPC 引擎      127.0.0.1:50051
  日志目录       $LOG_DIR
  停止全部       scripts/stop-all.sh
  查看状态       scripts/status.sh
===========================================
EOF
