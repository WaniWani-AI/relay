$ErrorActionPreference = "Stop"
Start-Transcript -Path C:\relay-reference-bootstrap.log -Append

Install-WindowsFeature -Name Web-Server, Web-Asp-Net45, Web-Static-Content, Web-Http-Logging, Web-Stat-Compression, Web-Dyn-Compression, Web-Http-Redirect, Web-Mgmt-Console | Out-Null

$downloads = "C:\relay-reference-downloads"
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -Uri "https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi" -OutFile "$downloads\rewrite.msi"
Start-Process msiexec.exe -Wait -ArgumentList "/i `"$downloads\rewrite.msi`" /qn /norestart"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi" -OutFile "$downloads\cloudflared.msi"
Start-Process msiexec.exe -Wait -ArgumentList "/i `"$downloads\cloudflared.msi`" /qn /norestart"

$credentials = (Get-SSMParameter -Region "__REGION__" -Name "/relay-reference/tunnel-credentials" -WithDecryption $true).Value
$tunnel = ($credentials | ConvertFrom-Json).TunnelID
$cloudflaredHome = "C:\Windows\System32\config\systemprofile\.cloudflared"
New-Item -ItemType Directory -Force -Path $cloudflaredHome | Out-Null
Set-Content -Path "$cloudflaredHome\$tunnel.json" -Value $credentials -Encoding ascii
Set-Content -Path "$cloudflaredHome\config.yml" -Encoding ascii -Value @"
tunnel: $tunnel
credentials-file: $cloudflaredHome\$tunnel.json
protocol: http2
ingress:
  - service: http://localhost:8080
"@
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" service install

Import-Module WebAdministration
Get-Website | ForEach-Object { Remove-Website -Name $_.Name }
$root = "C:\sites\reference"
New-Item -ItemType Directory -Force -Path "$root\bin" | Out-Null
if (-not (Test-Path "IIS:\AppPools\reference")) {
	New-WebAppPool -Name reference | Out-Null
}
Set-ItemProperty "IIS:\AppPools\reference" -Name managedRuntimeVersion -Value "v4.0"
New-Website -Name reference -Port 8080 -PhysicalPath $root -ApplicationPool reference | Out-Null
icacls C:\sites /grant "IIS_IUSRS:(OI)(CI)RX" | Out-Null

New-Item -ItemType File -Force -Path C:\relay-reference-ready | Out-Null
Stop-Transcript
