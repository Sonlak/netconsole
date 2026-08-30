try {
    # 1. Login fresh (no rate-limit issue)
    $login = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 `
        -Uri "http://42.119.165.109:8443/api/auth/login" `
        -Method POST -ContentType "application/json" `
        -Body '{"username":"admin","password":"Admin@123"}'
    $lr = ($login.Content | ConvertFrom-Json)
    $tok = $lr.token
    Write-Host "1. login OK mustChange=$($lr.mustChangePassword) tokenLen=$($tok.Length)"
    $hdr = @{ Authorization = "Bearer $tok" }

    # 2. /me
    $me = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 `
        -Uri "http://42.119.165.109:8443/api/auth/me" -Headers $hdr
    Write-Host "2. me status=$($me.StatusCode) body=$($me.Content.Substring(0, [Math]::Min(200,$me.Content.Length)))"

    # 3. change password
    $chg = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 `
        -Uri "http://42.119.165.109:8443/api/auth/password" -Method PUT `
        -Headers $hdr -ContentType "application/json" `
        -Body '{"currentPassword":"Admin@123","newPassword":"Admin@123"}'
    Write-Host "3. change pw status=$($chg.StatusCode) body=$($chg.Content)"

    # 4. dashboard stats
    $stats = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 `
        -Uri "http://42.119.165.109:8443/api/devices/stats" -Headers $hdr
    Write-Host "4. stats status=$($stats.StatusCode) body=$($stats.Content)"

    # 5. devices list
    $devs = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 `
        -Uri "http://42.119.165.109:8443/api/devices" -Headers $hdr
    Write-Host "5. devices status=$($devs.StatusCode) bodyLen=$($devs.Content.Length)"
}
catch {
    $code = $_.Exception.Response.StatusCode
    $body = $_.ErrorDetails.Message
    Write-Host "ERR status=$code body=$body"
}