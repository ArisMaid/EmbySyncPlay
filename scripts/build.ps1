param(
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"

docker run --rm `
    -v "${root}:/src" `
    -w /src `
    mcr.microsoft.com/dotnet/sdk:8.0 `
    dotnet test SyncPlay.sln -c $Configuration --nologo

New-Item -ItemType Directory -Force -Path $dist | Out-Null
Copy-Item `
    -LiteralPath (Join-Path $root "src\Emby.SyncPlay\bin\$Configuration\netstandard2.0\Emby.SyncPlay.dll") `
    -Destination (Join-Path $dist "Emby.SyncPlay.dll") `
    -Force

Write-Host "Built: $dist\Emby.SyncPlay.dll"

