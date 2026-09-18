$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (!$nodeCommand) {
    Write-Host 'Please install Node.js 22 or newer, then run this script again.'
    exit 1
}
Write-Host 'Keep this window open while playing. Stop with Ctrl+C.'
Write-Host 'Phones on the same Wi-Fi should use one of these addresses:'
Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'
} | ForEach-Object { Write-Host ('  http://' + $_.IPAddress + ':8787') }
& $nodeCommand.Source server.mjs
