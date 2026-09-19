#!/usr/bin/env bash
# 停止 start-all.sh 启动的全部服务（Linux / macOS）。
#
# 优先按 .run/<name>.pid 对整个进程组发信号（setsid 启动，cargo/node 的子进程
# 同属该组）；TERM 后等 2s 仍存活则 KILL；最后用 fuser 按端口兜底回收。
#
# 用法：scripts/stop-all.sh [--no-engine] [--no-api] [--no-web]
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_DIR="$ROOT/.run"

NO_ENGINE=0; NO_API=0; NO_WEB=0
while [ $# -gt 0 ]; do
    case "$1" in
        --no-engine) NO_ENGINE=1; shift ;;
        --no-api)    NO_API=1; shift ;;
        --no-web)    NO_WEB=1; shift ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "[stop] 未知参数: $1" >&2; exit 1 ;;
    esac
done

have() { command -v "$1" >/dev/null 2>&1; }

stop_group() {
    # stop_group <name> — 按 PID 文件结束进程组（PID==setsid 后的 PGID）
    local name="$1" pidfile="$RUN_DIR/$name.pid"
    [ -f "$pidfile" ] || return 0
    local pgid; pgid="$(cat "$pidfile" 2>/dev/null || true)"
    rm -f "$pidfile"
    [ -n "$pgid" ] || return 0

    if kill -0 -- "-$pgid" 2>/dev/null; then
        kill -TERM -- "-$pgid" 2>/dev/null || true
        printf '\033[36m[stop]\033[0m 已向 %s 进程组 %s 发送 TERM\n' "$name" "$pgid"
        local i
        for i in 1 2 3 4; do
            kill -0 -- "-$pgid" 2>/dev/null || return 0
            sleep 0.5
        done
        kill -KILL -- "-$pgid" 2>/dev/null || true
        printf '\033[33m[stop]\033[0m %s 未退出，已发送 KILL\n' "$name"
    else
        # 退化：setsid 在交互 shell 中 fork 时，PID 指向已退出的 setsid
        if kill -0 "$pgid" 2>/dev/null; then
            kill -TERM "$pgid" 2>/dev/null || true
            sleep 1
            kill -KILL "$pgid" 2>/dev/null || true
        fi
    fi
}

stop_port() {
    # 端口仍被占用时用 fuser 兜底
    local port="$1" name="$2"
    if have fuser; then
        if fuser -s "${port}/tcp" 2>/dev/null; then
            fuser -k -TERM "${port}/tcp" >/dev/null 2>&1 || true
            sleep 1
            fuser -k -KILL "${port}/tcp" >/dev/null 2>&1 || true
            printf '\033[33m[stop]\033[0m 端口 %s 仍被占用，已按端口回收（%s）\n' "$port" "$name"
        fi
    else
        printf '\033[33m[stop]\033[0m WARN: 无 fuser 可用于端口 %s 兜底，请手动检查\n' "$port"
    fi
}

[ "$NO_ENGINE" -eq 1 ] || { printf '\033[36m[stop]\033[0m 停止 analysis …\n'; stop_group analysis; sleep 0.3; stop_port 50051 analysis; }
[ "$NO_API" -eq 1 ]    || { printf '\033[36m[stop]\033[0m 停止 api …\n';      stop_group api;      sleep 0.3; stop_port 8080  api; }
[ "$NO_WEB" -eq 1 ]    || { printf '\033[36m[stop]\033[0m 停止 web …\n';      stop_group web;      sleep 0.3; stop_port 5173 web; }

printf '\033[32m[stop]\033[0m 完成。\n'
