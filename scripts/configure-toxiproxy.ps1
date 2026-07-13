param(
    [int]$LatencyMs = 50,
    [int]$JitterMs = 20
)

$ErrorActionPreference = "Stop"
$api = "http://localhost:8474"

try {
    Invoke-RestMethod -Method Delete -Uri "$api/proxies/emby-syncplay" -TimeoutSec 5 | Out-Null
} catch {
    # The proxy does not exist on the first run.
}

$proxy = @{
    name = "emby-syncplay"
    listen = "0.0.0.0:38096"
    upstream = "emby:8096"
    enabled = $true
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$api/proxies" -ContentType "application/json" -Body $proxy | Out-Null

$toxic = @{
    name = "wan-latency"
    type = "latency"
    stream = "downstream"
    toxicity = 1.0
    attributes = @{
        latency = $LatencyMs
        jitter = $JitterMs
    }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "$api/proxies/emby-syncplay/toxics" -ContentType "application/json" -Body $toxic | Out-Null

Write-Host "Latency proxy ready at http://localhost:38096 ($LatencyMs ms +/- $JitterMs ms)."

