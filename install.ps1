# Install the SwiftEngineer Pi Distribution from a local checkout (Windows).
# For a one-line remote install, see the README (npx one-liner).
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Missing required command: node (install Node.js >= 22.19.0)"
    exit 1
}

# Running from a checkout means "install this copy" as the harness.
if (-not $env:PI_HARNESS_SOURCE) { $env:PI_HARNESS_SOURCE = $Root }
node "$Root/scripts/bootstrap.mjs" @args
if ($LASTEXITCODE -ne 0) {
    # Windows PowerShell 5.1: $ErrorActionPreference='Stop' does not stop on
    # native nonzero exits, so propagate the failure explicitly.
    exit $LASTEXITCODE
}
