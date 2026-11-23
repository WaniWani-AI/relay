param([string]$Pool = "e2e")
$process = Get-CimInstance Win32_Process -Filter "name='w3wp.exe'" | Where-Object { $_.CommandLine -match "-ap `"$Pool`"" } | Select-Object -First 1
if ($process) { $process.WorkingSetSize } else { "NaN" }
