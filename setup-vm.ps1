$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Download($url, $out) {
    Write-Host "  Скачиваю: $url" -ForegroundColor Gray
    (New-Object System.Net.WebClient).DownloadFile($url, $out)
}

Write-Host "`n=== CS2 Farm Panel - Авто-установка ===" -ForegroundColor Cyan

# 1. Node.js 18
Write-Host "`n[1/3] Node.js 18..." -ForegroundColor Yellow
$nodePath = "$env:TEMP\node18.msi"
Download "https://nodejs.org/dist/v18.20.4/node-v18.20.4-x64.msi" $nodePath
Start-Process msiexec -ArgumentList "/i `"$nodePath`" /qn /norestart" -Wait
Write-Host "  Node.js установлен" -ForegroundColor Green

# 2. Git
Write-Host "`n[2/3] Git..." -ForegroundColor Yellow
$gitApi = Invoke-RestMethod "https://api.github.com/repos/git-for-windows/git/releases/latest" -Headers @{"User-Agent"="setup"}
$gitAsset = $gitApi.assets | Where-Object { $_.name -like "*64-bit.exe" } | Select-Object -First 1
$gitPath = "$env:TEMP\git.exe"
Download $gitAsset.browser_download_url $gitPath
Start-Process $gitPath -ArgumentList "/VERYSILENT /NORESTART" -Wait
Write-Host "  Git установлен" -ForegroundColor Green

# 3. Sandboxie Classic
Write-Host "`n[3/3] Sandboxie Classic..." -ForegroundColor Yellow
$sbApi = Invoke-RestMethod "https://api.github.com/repos/sandboxie-plus/Sandboxie/releases?per_page=50" -Headers @{"User-Agent"="setup"}
$sbRelease = $sbApi | Where-Object {
    $_.assets | Where-Object { $_.name -like "*Classic*x64*" }
} | Select-Object -First 1
$sbAsset = $sbRelease.assets | Where-Object { $_.name -like "*Classic*x64*" } | Select-Object -First 1
$sbPath = "$env:TEMP\sandboxie.exe"
Download $sbAsset.browser_download_url $sbPath
Start-Process $sbPath -ArgumentList "/S" -Wait
Write-Host "  Sandboxie установлен: $($sbAsset.name)" -ForegroundColor Green

# 4. Настройка Sandboxie для Steam
Write-Host "`n[4/4] Настройка Sandboxie..." -ForegroundColor Yellow
$sbIni = "C:\Windows\Sandboxie.ini"
$config = @"
[GlobalSettings]
EditAdminOnly=n
ForceDisableAdminOnly=n

[DefaultBox]
Enabled=n
"@
# Проверяем что Sandboxie.ini существует и дописываем базовую конфигурацию
if (Test-Path $sbIni) {
    Write-Host "  Sandboxie.ini найден" -ForegroundColor Green
} else {
    Set-Content $sbIni $config -Encoding Unicode
    Write-Host "  Создан Sandboxie.ini" -ForegroundColor Green
}

# 5. Перезагрузка PATH
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

Write-Host "`n=== Готово! ===" -ForegroundColor Cyan
Write-Host "Node.js: $(node --version 2>$null)" -ForegroundColor White
Write-Host "npm:     $(npm --version 2>$null)" -ForegroundColor White
Write-Host "Git:     $(git --version 2>$null)" -ForegroundColor White
Write-Host "`nТеперь перенеси папку панели в VM и запусти npm install" -ForegroundColor Yellow
