# generate_self_signed.ps1 — PowerShell variant of generate_self_signed.sh.
# Produces a 1-year self-signed cert for local dev. Writes to
# frontend/certs/{cert,key}.pem which is in .gitignore (cert files
# must NEVER be committed).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File frontend/certs/generate_self_signed.ps1
#
# Requires: openssl on PATH (Git for Windows, WSL, or Strawberry Perl
# typically ship it). If you don't have openssl, install via choco:
#   choco install openssl
# Or use the bash script via Git Bash:
#   bash frontend/certs/generate_self_signed.sh

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cert = Join-Path $ScriptDir 'cert.pem'
$Key  = Join-Path $ScriptDir 'key.pem'

if (-not (Get-Command openssl -ErrorAction SilentlyContinue)) {
  Write-Error "openssl not found on PATH. Install via 'choco install openssl' or run the bash variant: bash frontend/certs/generate_self_signed.sh"
  exit 1
}

if ((Test-Path $Cert) -and (Test-Path $Key)) {
  Write-Host "[generate_self_signed] certs already exist at $Cert"
  Write-Host "[generate_self_signed] delete them first if you want to regenerate"
  exit 0
}

& openssl req -x509 -nodes -days 365 -newkey rsa:2048 `
  -keyout $Key `
  -out $Cert `
  -subj '/CN=localhost/O=NetConsole-Local-Dev' `
  -addext 'subjectAltName=DNS:localhost,DNS:127.0.0.1,IP:127.0.0.1'

# chmod 600 equivalent on Windows: ACL the file to current user only.
# PowerShell 5+ uses `icacls`. (NTFS file system only; on FAT / SMB
# shares the ACL is a no-op and that's fine for local dev.)
try {
  $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls $Cert /inheritance:r /grant:r "${currentUser}:(R)" | Out-Null
  & icacls $Key  /inheritance:r /grant:r "${currentUser}:(R)" | Out-Null
} catch {
  Write-Warning "Could not set NTFS ACL on certs (this is fine on non-NTFS filesystems): $_"
}

Write-Host "[generate_self_signed] wrote $Cert + $Key (1y, 2048-bit RSA)"
Write-Host "[generate_self_signed] now run: docker compose up -d frontend"
Write-Host "[generate_self_signed] then open: https://localhost:8443 (accept the cert warning once)"
