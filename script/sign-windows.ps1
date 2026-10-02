param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Path
)

$ErrorActionPreference = "Stop"

if (-not $Path -or $Path.Count -eq 0) {
  throw "At least one path is required"
}

if ($env:GITHUB_ACTIONS -ne "true") {
  Write-Host "Skipping Windows signing because this is not running on GitHub Actions"
  exit 0
}

# The certificate lives in Azure Key Vault Premium on a non-exportable HSM key, so each file's digest is
# signed inside the vault and no key ever reaches the runner. The workflow's azure/login step has already
# signed the Azure CLI in through OIDC, and its token is what AzureSignTool presents to the vault.
$vaultUrl = $env:AZURE_KEY_VAULT_URL
$certificate = $env:AZURE_KEY_VAULT_CERTIFICATE

if (-not $vaultUrl -or -not $certificate) {
  Write-Host "Skipping Windows signing because Azure Key Vault signing is not configured"
  exit 0
}

# electron-builder calls this script once per executable, so the tool is installed into a fixed
# directory and reused by later calls in the same job.
$toolVersion = "7.0.1"
$toolDir = Join-Path ($env:RUNNER_TEMP ?? [IO.Path]::GetTempPath()) "azuresigntool-$toolVersion"
$tool = Join-Path $toolDir "AzureSignTool.exe"

if (-not (Test-Path $tool)) {
  dotnet tool install AzureSignTool --version $toolVersion --tool-path $toolDir
  if ($LASTEXITCODE -ne 0) {
    throw "Installing AzureSignTool $toolVersion failed with exit code $LASTEXITCODE"
  }
}

$files = @($Path | ForEach-Object { Resolve-Path $_ -ErrorAction SilentlyContinue } | Select-Object -ExpandProperty Path -Unique)

if (-not $files -or $files.Count -eq 0) {
  throw "No files matched the requested paths"
}

$token = az account get-access-token --resource https://vault.azure.net --query accessToken --output tsv
if ($LASTEXITCODE -ne 0 -or -not $token) {
  throw "Could not get an Azure Key Vault access token; the azure/login step must run first"
}

& $tool sign `
  --azure-key-vault-url $vaultUrl `
  --azure-key-vault-certificate $certificate `
  --azure-key-vault-accesstoken $token `
  --timestamp-rfc3161 http://timestamp.digicert.com `
  --timestamp-digest sha256 `
  --file-digest sha256 `
  --verbose `
  @files

if ($LASTEXITCODE -ne 0) {
  throw "AzureSignTool failed with exit code $LASTEXITCODE"
}
