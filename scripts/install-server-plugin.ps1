param(
  [Parameter(Mandatory = $true)]
  [string]$SillyTavernPath,
  [string]$PackagePath = ''
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$stRoot = [IO.Path]::GetFullPath($SillyTavernPath)
$serverFile = Join-Path $stRoot 'server.js'
$configFile = Join-Path $stRoot 'config.yaml'
$pluginsRoot = Join-Path $stRoot 'plugins'
$targetPath = Join-Path $pluginsRoot 'srl-bridge'
$backupRoot = Join-Path $stRoot '.srl-bridge-backups'

if (-not (Test-Path -LiteralPath $serverFile -PathType Leaf)) {
  throw "server.js was not found in $stRoot. Set -SillyTavernPath to the SillyTavern root."
}
if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) {
  throw "config.yaml was not found in $stRoot. Start SillyTavern at least once first."
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("srl-bridge-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tempRoot | Out-Null

try {
  if ($PackagePath) {
    $archivePath = [IO.Path]::GetFullPath($PackagePath)
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
      throw "Package not found: $archivePath"
    }
  } else {
    $archivePath = Join-Path $tempRoot 'srl-bridge-server-plugin-latest.zip'
    $downloadUrl = 'https://github.com/jixiangruyi117/SillyTavern-SRL-Bridge/releases/latest/download/srl-bridge-server-plugin-latest.zip'
    Write-Host 'Downloading the latest SRL Bridge server plugin...'
    Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath -UseBasicParsing
  }

  $extractRoot = Join-Path $tempRoot 'package'
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
  $entry = Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter 'index.mjs' |
    Where-Object { $_.Directory.Name -eq 'srl-bridge' } |
    Select-Object -First 1
  if (-not $entry) { throw 'Invalid package: srl-bridge/index.mjs was not found.' }
  if (-not (Test-Path -LiteralPath (Join-Path $entry.Directory.FullName 'relay.js'))) {
    throw 'Invalid package: relay.js is missing.'
  }

  New-Item -ItemType Directory -Force -Path $pluginsRoot | Out-Null
  if (Test-Path -LiteralPath $targetPath) {
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    $backupPath = Join-Path $backupRoot ("srl-bridge-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Move-Item -LiteralPath $targetPath -Destination $backupPath
    Write-Host "The previous server plugin was backed up to: $backupPath"
  }
  Copy-Item -LiteralPath $entry.Directory.FullName -Destination $targetPath -Recurse

  $config = Get-Content -LiteralPath $configFile -Raw -Encoding utf8
  $settingPattern = '(?m)^(\s*)enableServerPlugins\s*:\s*(?:true|false)\s*$'
  if ([regex]::IsMatch($config, $settingPattern)) {
    $config = [regex]::Replace($config, $settingPattern, '${1}enableServerPlugins: true')
    Set-Content -LiteralPath $configFile -Value $config -Encoding utf8
  } else {
    Add-Content -LiteralPath $configFile -Value "`nenableServerPlugins: true" -Encoding utf8
  }

  Write-Host ''
  Write-Host 'SRL device relay server plugin installed.' -ForegroundColor Green
  Write-Host "Plugin directory: $targetPath"
  Write-Host 'Fully restart SillyTavern. The startup log should contain: [SRL Bridge] Short-lived device relay loaded'
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
