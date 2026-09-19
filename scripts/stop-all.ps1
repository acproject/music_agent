<#
.SYNOPSIS
  停止 start-all.ps1 启动的全部服务（Windows / PowerShell）。

.DESCRIPTION
  先按 .run/*.pid 对窗口进程树执行 taskkill /T（连带 python / cargo / music-api /
  node 子进程一起结束）；再按端口兜底回收残留监听进程。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\stop-all.ps1
#>
[CmdletBinding()]
param(
    [switch]$NoEngine,
    [switch]$NoApi,
    [switch]$NoWeb
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RunDir = Join-Path $Root '.run'

# name, port
$Targets = @(
    @{ Name = 'analysis'; Port = 50051; Skip = [bool]$NoEngine },
    @{ Name = 'api';      Port = 8080;  Skip = [bool]$NoApi },
    @{ Name = 'web';      Port = 5173;  Skip = [bool]$NoWeb }
)

function Stop-PidTree($pidPath) {
    if (-not (Test-Path $pidPath)) { return }
    $procId = [int]((Get-Content $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1))
    if ($procId -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
        # /T 结束进程树（窗口 → 实际服务进程及其子进程）
        & taskkill.exe /PID $procId /T /F 2>$null | Out-Null
        Write-Host "[stop] 已结束 PID 进程树 $procId" -ForegroundColor Green
    }
    Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
}

function Stop-PortOwner($port, $name) {
    $owners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($owner in $owners) {
        $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
        if ($proc) {
            & taskkill.exe /PID $owner /T /F 2>$null | Out-Null
            Write-Host "[stop] 端口 $port 仍被 $($proc.ProcessName)(PID $owner) 占用，已按端口回收" -ForegroundColor Yellow
        }
    }
}

foreach ($t in $Targets) {
    if ($t.Skip) { continue }
    Write-Host "[stop] 停止 $($t.Name) …" -ForegroundColor Cyan
    Stop-PidTree (Join-Path $RunDir "$($t.Name).pid")
    Start-Sleep -Milliseconds 300
    Stop-PortOwner $t.Port $t.Name
}

Write-Host '[stop] 完成。' -ForegroundColor Green
