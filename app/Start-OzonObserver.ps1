param([switch]$EnableTrialWrite)
$ErrorActionPreference = 'Stop'
$node = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
if (!(Test-Path -LiteralPath $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
Remove-Item Env:OZON_OBSERVER_WRITE_KEY -ErrorAction SilentlyContinue
$id = (Read-Host 'Ozon Client ID').Trim()
if ($id -notmatch '^[0-9]+$') { throw 'Client ID must contain only digits.' }
$key = Read-Host 'Read-only Ozon API key (hidden)' -AsSecureString
$handle = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($key)
try {
    $env:OZON_OBSERVER_CLIENT_ID = $id
    $env:OZON_OBSERVER_READ_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($handle).Trim()
    if ($env:OZON_OBSERVER_READ_KEY -notmatch '^[!-~]{8,}$') { throw 'Paste the full API key.' }
    if ($EnableTrialWrite) {
        $writeKey = Read-Host 'Ozon price-write key (hidden)' -AsSecureString
        $writeHandle = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($writeKey)
        try {
            $env:OZON_OBSERVER_WRITE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($writeHandle).Trim()
            if ($env:OZON_OBSERVER_WRITE_KEY -notmatch '^[!-~]{8,}$') { throw 'Paste the full write key.' }
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($writeHandle)
            $writeKey.Dispose()
        }
    }
    & $node (Join-Path $PSScriptRoot 'server.cjs')
    if ($LASTEXITCODE -ne 0) { throw "Local observer stopped with exit code $LASTEXITCODE." }
} finally {
    Remove-Item Env:OZON_OBSERVER_CLIENT_ID,Env:OZON_OBSERVER_READ_KEY,Env:OZON_OBSERVER_WRITE_KEY -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($handle)
    $key.Dispose()
}
