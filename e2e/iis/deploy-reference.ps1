param(
	[Parameter(Mandatory = $true)][string]$Bucket,
	[Parameter(Mandatory = $true)][string]$Region,
	[Parameter(Mandatory = $true)][string]$Build,
	[string]$NuGetVersion = "",
	[string]$BaseUrl = "https://dev.waniwani.ai"
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Import-Module WebAdministration

if (-not (Test-Path C:\relay-reference-ready)) {
	throw "The bootstrap has not finished. Read C:\relay-reference-bootstrap.log"
}

$work = Join-Path $env:TEMP ("relay-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $work | Out-Null
Read-S3Object -Region $Region -BucketName $Bucket -Key "builds/$Build/site.zip" -File "$work\site.zip" | Out-Null
Expand-Archive -Path "$work\site.zip" -DestinationPath "$work\site"

if ($NuGetVersion -ne "") {
	foreach ($package in @("Waniwani.Relay", "Waniwani.Relay.AspNet")) {
		Invoke-WebRequest -UseBasicParsing -Uri "https://www.nuget.org/api/v2/package/$package/$NuGetVersion" -OutFile "$work\$package.zip"
		Expand-Archive -Path "$work\$package.zip" -DestinationPath "$work\$package"
		Copy-Item "$work\$package\lib\net462\*.dll" "$work\site\bin\" -Force
	}
}

$key = (Get-SSMParameter -Region $Region -Name "/relay-reference/agent-traffic-key" -WithDecryption $true).Value
$trustedProxies = (Get-SSMParameter -Region $Region -Name "/relay-reference/trusted-proxies").Value
[xml]$config = Get-Content "$work\site\web.config"
$settings = @{
	"Waniwani:AgentTrafficKey" = $key
	"Waniwani:BaseUrl" = $BaseUrl
	"Waniwani:ClientIpHeader" = "X-Forwarded-For"
	"Waniwani:TrustedProxies" = $trustedProxies
	"Waniwani:Enabled" = "true"
}
foreach ($entry in $config.configuration.appSettings.add) {
	if ($settings.ContainsKey($entry.key)) {
		$entry.value = $settings[$entry.key]
	}
}

Stop-WebAppPool -Name reference
while ((Get-WebAppPoolState -Name reference).Value -ne "Stopped") {
	Start-Sleep -Milliseconds 250
}
$root = "C:\sites\reference"
Remove-Item "$root\*" -Recurse -Force
Copy-Item "$work\site\*" $root -Recurse -Force
$config.Save("$root\web.config")
Start-WebAppPool -Name reference
Remove-Item $work -Recurse -Force

$version = (Get-Item "$root\bin\Waniwani.Relay.AspNet.dll").VersionInfo.ProductVersion
Write-Output "deployed build $Build with Waniwani.Relay.AspNet $version"
