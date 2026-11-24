param([string]$Pool = "e2e")
Import-Module WebAdministration
Stop-WebAppPool -Name $Pool
$deadline = (Get-Date).AddSeconds(30)
while ((Get-WebAppPoolState -Name $Pool).Value -ne "Stopped" -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 200
}
Start-WebAppPool -Name $Pool
