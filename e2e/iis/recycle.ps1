param([string]$Pool = "e2e")
Import-Module WebAdministration
Restart-WebAppPool -Name $Pool
