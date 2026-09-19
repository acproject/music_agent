<#
.SYNOPSIS
  查看本地三个服务的运行状态与健康检查（Windows / PowerShell）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\status.ps1
#>
[CmdletBinding()]
param()

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RunDir = Join-Path $Root '.run'

$Targets = @(
    @{ Name = 'analysis (gRPC) :50051'; Port = 50051; Pid = 'analysis' },
    @{ Name = 'api (HTTP)       :8080'; Port = 8080;  Pid = 'api' },
    @{ Name = 'web (vite)       :5173'; Port = 5173; Pid = 'web' }
)

Write-Host 'service                         pid      listen   health' -ForegroundColor White
Write-Host '-------                         ---      ------   ------'

foreach ($t in $Targets) {
    $pidPath = Join-Path $RunDir "$($t.Pid).pid"
    $procId = '-'
    if (Test-Path $pidPath) {
        $v = (Get-Content $pidPath | Select-Object -First 1)
        if ($v -and (Get-Process -Id ([int]$v) -ErrorAction SilentlyContinue)) { $procId = $v }
    }

    $conn = Get-NetTCPConnection -State Listen -LocalPort $t.Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    $listen = if ($conn) { 'yes' } else { 'no' }

    $health = '-'
    if ($t.Port -eq 8080 -and $conn) {
        try {
            $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 3
            if ($h.status -eq 'ok' -and $h.analysis_engine.connected) {
                $health = "ok (engine v$($h.analysis_engine.version))"
            } elseif ($h.status -eq 'ok') {
                $health = 'up, engine DOWN'
            }
        } catch { $health = 'no-response' }
    }
    elseif ($conn) { $health = 'port-only' }

    $color = if ($listen -eq 'yes' -and $health -ne 'up, engine DOWN') { 'Green' } else { 'Yellow' }
    Write-Host ("{0,-31} {1,-8} {2,-8} {3}" -f $t.Name, $procId, $listen, $health) -ForegroundColor $color
}

Write-Host ''
Write-Host "日志：$Root\logs\*.log    PID：$RunDir\*.pid" -ForegroundColor DarkGray
