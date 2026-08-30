$ErrorActionPreference = 'Continue'
$body = '{"username":"admin","password":"Admin@123"}'
try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 `
        -Uri 'http://42.119.165.109:8443/api/auth/login' `
        -Method POST -ContentType 'application/json' -Body $body
    $j = $r.Content | ConvertFrom-Json
    $tok = $j.token
    Write-Host ("login OK mcp=" + $j.mustChangePassword)
    $hdr = @{ Authorization = "Bearer $tok" }
    foreach ($ep in @('/api/health','/api/auth/me','/api/devices','/api/jobs','/api/dhcp/dashboard','/api/interfaces','/api/mac-addresses','/api/arp-addresses','/api/fabric/topology','/api/discovery')) {
        try {
            $x = Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 -Uri ("http://42.119.165.109:8443" + $ep) -Headers $hdr
            Write-Host ($ep + " OK " + $x.StatusCode + " len=" + $x.Content.Length)
        } catch {
            $code = $null
            try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
            Write-Host ($ep + " ERR code=" + $code + " msg=" + $_.Exception.Message)
        }
    }
} catch {
    Write-Host ("LOGIN ERR: " + $_.Exception.Message)
}