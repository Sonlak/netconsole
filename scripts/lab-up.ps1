param(
  [switch]$Down,
  [switch]$Logs
)

$ComposeFile = Join-Path $PSScriptRoot "..\docker-compose.lab.yml"

$DockerBin = @(
  "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin",
  "$env:ProgramFiles\Docker\Docker\resources\bin"
) | Where-Object { Test-Path (Join-Path $_ "docker.exe") } | Select-Object -First 1

if ($DockerBin) {
  $env:Path = "$DockerBin;$env:Path"
} else {
  Write-Host "Khong tim thay docker.exe — hay mo Docker Desktop truoc." -ForegroundColor Red
  exit 1
}

if ($Down) {
  docker compose -f $ComposeFile down
  exit $LASTEXITCODE
}

if ($Logs) {
  docker compose -f $ComposeFile logs -f
  exit $LASTEXITCODE
}

Write-Host "Starting NetConsole lab stack (3 Juniper devices)..." -ForegroundColor Cyan
docker compose -f $ComposeFile up -d --build

if ($LASTEXITCODE -ne 0) {
  Write-Host "Failed to start lab stack." -ForegroundColor Red
  exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Lab is starting:" -ForegroundColor Green
Write-Host "  UI:       http://localhost:5173"
Write-Host "  API:      http://localhost:3000/api/health"
Write-Host "  Network:  lab-net 172.30.0.0/24 (3 thiet bi ping/SSH duoc nhau)"
Write-Host "  Juniper1: ssh lab@localhost -p 2221  (pass: lab123)  172.30.0.11  vSRX3"
Write-Host "  Juniper2: ssh lab@localhost -p 2222  (pass: lab123)  172.30.0.12  EX4300"
Write-Host "  Juniper3: ssh lab@localhost -p 2223  (pass: lab123)  172.30.0.13  EX4300"
Write-Host "  Discovery subnet: 172.30.0.0/28"
Write-Host ""
Write-Host "Logs:  .\scripts\lab-up.ps1 -Logs"
Write-Host "Stop:  .\scripts\lab-up.ps1 -Down"
