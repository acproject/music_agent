#!/usr/bin/env bash
# 查看本地三个服务的运行状态与健康检查（Linux / macOS）。
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_DIR="$ROOT/.run"

have() { command -v "$1" >/dev/null 2>&1; }

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

pid_state() {
    # 进程组存活判定；PID 文件不存在/已回收返回 -
    local name="$1" pidfile="$RUN_DIR/$name.pid"
    [ -f "$pidfile" ] || { echo '-'; return; }
    local pgid; pgid="$(cat "$pidfile" 2>/dev/null || true)"
    [ -n "$pgid" ] || { echo '-'; return; }
    if kill -0 -- "-$pgid" 2>/dev/null || kill -0 "$pgid" 2>/dev/null; then
        echo "$pgid"
    else
        echo "stale"
    fi
}

printf '%-28s %-8s %-8s %s\n' 'service' 'pgid' 'listen' 'health'
printf '%-28s %-8s %-8s %s\n' '-------' '----' '------' '------'

check_row() {
    local label="$1" name="$2" port="$3" http="$4"
    local pid listen health='-'
    pid="$(pid_state "$name")"
    if port_busy "$port"; then listen='yes'; else listen='no'; fi
    if [ "$http" = 1 ] && [ "$listen" = 'yes' ] && have curl; then
        body="$(curl -fsS --max-time 2 "http://127.0.0.1:${port}/health" 2>/dev/null || true)"
        if echo "$body" | grep -q '"status":"ok"' && echo "$body" | grep -q '"connected":true'; then
            ver="$(echo "$body" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1)"
            health="ok (engine v${ver})"
        elif echo "$body" | grep -q '"status":"ok"'; then
            health='up, engine DOWN'
        else
            health='no-response'
        fi
    elif [ "$listen" = 'yes' ]; then
        health='port-only'
    fi
    printf '%-28s %-8s %-8s %s\n' "$label" "$pid" "$listen" "$health"
}

check_row 'analysis (gRPC) :50051' analysis 50051 0
check_row 'api (HTTP)       :8080' api      8080  1
check_row 'web (vite)       :5173' web      5173 0

echo
echo "日志：$ROOT/logs/*.log    PID：$RUN_DIR/*.pid"
