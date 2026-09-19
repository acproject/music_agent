<#
.SYNOPSIS
  一键启动 music_agent 全部本地开发服务（Windows / PowerShell 5.1+）。

.DESCRIPTION
  依次启动三个独立进程，每个服务一个新的 PowerShell 窗口（日志同时输出到窗口与 logs/）：
    1. Python 分析引擎  :50051  services/analysis  python -m app.main
    2. Rust HTTP 网关   :8080   仓库根            cargo run -p music-api
    3. Vite Web 前端    :5173   apps/web          pnpm dev
  启动后做端口探测与 /health 健康检查；PID 写入 .run/，由 stop-all.ps1 回收。

.PARAMETER PitchBackend
  离线音高后端 yin（默认）或 crepe；等价于环境变量 PITCH_BACKEND。

.PARAMETER NoWeb / -NoApi / -NoEngine
  跳过对应服务。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1
  powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1 -PitchBackend crepe -NoWeb
#>
[CmdletBinding()]
param(
    [ValidateSet('yin', 'crepe')]
    [string]$PitchBackend = $(if ($env:PITCH_BACKEND) { $env:PITCH_BACKEND } else { 'yin' }),
    [switch]$NoEngine,
    [switch]$NoApi,
    [switch]$NoWeb
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# ---------------------------------------------------------------- 路径与目录
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RunDir = Join-Path $Root '.run'
$LogDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $RunDir, $LogDir | Out-Null

$Services = @(
    @{ Name = 'analysis'; Port = 50051; Dir = Join-Path $Root 'services/analysis' },
    @{ Name = 'api';      Port = 8080;  Dir = $Root },
    @{ Name = 'web';      Port = 5173; Dir = Join-Path $Root 'apps/web' }
)

function Write-Step($m) { Write-Host "[start] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "[start] $m" -ForegroundColor Green }
function Die($m) { Write-Host "[start] ERROR: $m" -ForegroundColor Red; exit 1 }

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Test-PortListening($port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

function Wait-Port($port, $timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-PortListening $port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# ---------------------------------------------------------------- 解释器探测
$PythonExe = if ($env:PYTHON) { $env:PYTHON } else {
    $cand = Get-Command python -ErrorAction SilentlyContinue
    if (-not $cand) { $cand = Get-Command python3 -ErrorAction SilentlyContinue }
    if ($cand) { $cand.Source } else { $null }
}
if (-not $PythonExe -or -not (& $PythonExe --version 2>$null)) {
    Die "未找到 Python（需要 3.12）。可设置 `$env:PYTHON 指向解释器后重试。"
}

# ---------------------------------------------------------------- 端口冲突预检
foreach ($s in $Services) {
    if (Test-PortListening $s.Port) {
        Die "端口 $($s.Port) 已被占用（$($s.Name)）。如旧实例仍在运行，请先执行 stop-all.ps1。"
    }
}

# ---------------------------------------------------------------- 产物预检
# Python gRPC 桩代码（services/analysis/app/proto）
$pyProto = Join-Path $Root 'services/analysis/app/proto/music/v1/analysis_pb2.py'
if (-not (Test-Path $pyProto)) {
    Write-Step "未发现 Python proto 生成物，执行 gen_proto.mjs python …"
    if (-not (Test-Command 'node')) { Die "需要 Node.js>=18 生成 proto 桩代码（node scripts/gen_proto.mjs python）。" }
    $env:PYTHON = $PythonExe
    Push-Location $Root
    try { node scripts/gen_proto.mjs python } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Die "Python proto 生成失败。" }
}

if (-not $NoApi) {
    # protoc 只在首次构建 / proto 变更时需要
    $apiBin = Join-Path $Root 'target/debug/music-api.exe'
    $haveProtoc = $false
    if ($env:PROTOC -and (Test-Path $env:PROTOC)) { $haveProtoc = $true }
    elseif (Test-Command 'protoc') { $env:PROTOC = (Get-Command protoc).Source; $haveProtoc = $true }
    if (-not $haveProtoc -and -not (Test-Path $apiBin)) {
        Die "未找到 protoc（Rust 首次构建需要）。请安装并设置 `$env:PROTOC，例如：`n  `$env:PROTOC='C:\tools\protoc\bin\protoc.exe'"
    }
    if (-not (Test-Command 'cargo')) { Die "未找到 cargo，请先安装 Rust 工具链（rustup）。" }
}

if (-not $NoWeb) {
    if (-not (Test-Command 'pnpm')) { Die "未找到 pnpm（npm i -g pnpm 或启用 corepack）。" }
    if (-not (Test-Path (Join-Path $Root 'apps/web/node_modules'))) {
        Write-Step "apps/web/node_modules 不存在，执行 pnpm install（首次较慢）…"
        Push-Location (Join-Path $Root 'apps/web')
        try { pnpm install } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { Die "pnpm install 失败。" }
    }
}

# ---------------------------------------------------------------- 启动服务
function Start-ServiceWindow($name, $title, $workDir, $cmdLine, [switch]$UseBackend) {
    # cmdLine 为给 cmd.exe 的原始命令行（可执行文件路径已加引号）；
    # 在 cmd 内做 2>&1 合流，避免 PowerShell 把原生 stderr 包装成 ErrorRecord。
    $logFile = Join-Path $LogDir "$name.log"
    $pidFile = Join-Path $RunDir "$name.pid"
    $envPrefix = ''
    if ($UseBackend) {
        $envPrefix = "if ('$PitchBackend') { `$env:PITCH_BACKEND = '$PitchBackend' }`n"
    } elseif ($name -eq 'api' -and $env:PROTOC) {
        $envPrefix = "`$env:PROTOC = '$($env:PROTOC -replace "'", "''")'`n"
    }
    $safeCmd = $cmdLine -replace "'", "''"
    $safeLog = $logFile -replace "'", "''"
    $safeWork = $workDir -replace "'", "''"
    $inner = @"
`$Host.UI.RawUI.WindowTitle = '$title'
$envPrefix
Set-Location -LiteralPath '$safeWork'
Write-Host '=== $title 日志同时写入 $safeLog ==='
& cmd.exe /c '$safeCmd 2>&1' | Tee-Object -FilePath '$safeLog'
Write-Host ''
Write-Host '[服务已退出] 按任意键关闭本窗口…' -ForegroundColor Yellow
`$null = `$Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
"@
    $proc = Start-Process -FilePath 'powershell.exe' -WorkingDirectory $workDir `
        -ArgumentList @('-NoProfile', '-Command', $inner) -PassThru -WindowStyle Normal
    $proc.Id | Set-Content -Path $pidFile -Encoding ascii
    Write-Ok "$name 已启动（PID $($proc.Id)）"
}

$pyCmd = '"' + $PythonExe + '" -m app.main'

if (-not $NoEngine) {
    Write-Step "启动分析引擎 :50051（PITCH_BACKEND=$PitchBackend）…"
    Start-ServiceWindow 'analysis' 'music-analysis :50051' `
        (Join-Path $Root 'services/analysis') $pyCmd -UseBackend
    if (-not (Wait-Port 50051 40)) { Die "引擎 40s 内未监听 :50051，见 logs/analysis.log。" }
    Write-Ok '引擎端口就绪。'
}

if (-not $NoApi) {
    Write-Step '启动 HTTP 网关 :8080（首次 cargo build 可能需要数分钟）…'
    Start-ServiceWindow 'api' 'music-api :8080' $Root 'cargo run -p music-api'
    if (-not (Wait-Port 8080 300)) { Die "网关 300s 内未监听 :8080，见 logs/api.log。" }
    # /health 还要确认引擎已连通
    $healthy = $false
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        try {
            $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 3
            if ($h.status -eq 'ok' -and $h.analysis_engine.connected) { $healthy = $true; break }
        } catch { Start-Sleep -Milliseconds 700 }
    }
    if (-not $healthy) { Write-Host '[start] WARN: 网关已起但引擎未连通，请检查 logs/analysis.log' -ForegroundColor Yellow }
    else { Write-Ok '网关健康检查通过（引擎已连通）。' }
}

if (-not $NoWeb) {
    Write-Step '启动 Web 前端 :5173…'
    Start-ServiceWindow 'web' 'music-web :5173' (Join-Path $Root 'apps/web') 'pnpm dev'
    if (-not (Wait-Port 5173 90)) { Die "前端 90s 内未监听 :5173，见 logs/web.log。" }
    Write-Ok '前端端口就绪。'
}

# ---------------------------------------------------------------- 汇总
Write-Host ''
Write-Host '============== 全部服务已启动 ==============' -ForegroundColor Green
Write-Host '  Web 前端       http://localhost:5173'
Write-Host '  HTTP 网关      http://localhost:8080'
Write-Host '  健康检查       http://localhost:8080/health'
Write-Host '  gRPC 引擎      127.0.0.1:50051'
Write-Host "  日志目录       $LogDir"
Write-Host '  停止全部       powershell -ExecutionPolicy Bypass -File scripts\stop-all.ps1'
Write-Host '  查看状态       powershell -ExecutionPolicy Bypass -File scripts\status.ps1'
Write-Host '===========================================' -ForegroundColor Green
