param([string]$Url = "http://127.0.0.1:8080/__heap")
(Invoke-WebRequest -UseBasicParsing -Uri $Url).Content
