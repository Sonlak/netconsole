Set-Location d:\NetConsole
docker compose -f docker-compose.lab.yml up -d --build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
docker compose -f docker-compose.lab.yml ps -a
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
