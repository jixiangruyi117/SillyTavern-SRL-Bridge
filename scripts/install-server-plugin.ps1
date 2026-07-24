param(
  [string]$SillyTavernPath = '',
  [string]$ConfigPath = '',
  [string]$PackagePath = '',
  [switch]$NonInteractive,
  [switch]$KeepBackup
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Test-SillyTavernRoot([string]$Path) {
  if (-not $Path) { return $false }
  try {
    $resolved = [IO.Path]::GetFullPath($Path)
    return Test-Path -LiteralPath (Join-Path $resolved 'server.js') -PathType Leaf
  } catch { return $false }
}

function Find-SillyTavernRoots {
  $found = [Collections.Generic.List[string]]::new()
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $direct = @(
    $env:SILLY_TAVERN_HOME,
    (Get-Location).Path,
    (Join-Path $HOME 'SillyTavern'),
    (Join-Path $HOME 'Desktop\SillyTavern'),
    (Join-Path $HOME 'Documents\SillyTavern'),
    (Join-Path $HOME 'Downloads\SillyTavern')
  )
  if ($PSScriptRoot) {
    $direct += $PSScriptRoot
    $direct += (Split-Path -Parent $PSScriptRoot)
  }
  foreach ($drive in Get-PSDrive -PSProvider FileSystem) {
    $direct += (Join-Path $drive.Root 'SillyTavern')
    $direct += (Join-Path $drive.Root 'SillyTavern\SillyTavern')
  }
  foreach ($candidate in $direct) {
    if (Test-SillyTavernRoot $candidate) {
      $resolved = [IO.Path]::GetFullPath($candidate)
      if ($seen.Add($resolved)) { $found.Add($resolved) }
    }
  }

  $searchRoots = @(
    (Join-Path $HOME 'Desktop'),
    (Join-Path $HOME 'Documents'),
    (Join-Path $HOME 'Downloads')
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Container }
  foreach ($root in $searchRoots) {
    Get-ChildItem -LiteralPath $root -Filter 'server.js' -File -Recurse -Depth 4 -ErrorAction SilentlyContinue |
      ForEach-Object {
        $candidate = $_.Directory.FullName
        if (Test-SillyTavernRoot $candidate) {
          $resolved = [IO.Path]::GetFullPath($candidate)
          if ($seen.Add($resolved)) { $found.Add($resolved) }
        }
      }
  }
  return $found.ToArray()
}

function Resolve-SillyTavernRoot([string]$RequestedPath) {
  if ($RequestedPath) {
    if (-not (Test-SillyTavernRoot $RequestedPath)) {
      throw "server.js was not found in $RequestedPath. Choose the SillyTavern root directory."
    }
    return [IO.Path]::GetFullPath($RequestedPath)
  }

  $matches = @(Find-SillyTavernRoots)
  if ($matches.Count -eq 1) {
    Write-Host "Detected SillyTavern: $($matches[0])"
    return $matches[0]
  }
  if ($matches.Count -gt 1 -and -not $NonInteractive) {
    Write-Host 'Multiple SillyTavern installations were found:'
    for ($index = 0; $index -lt $matches.Count; $index += 1) {
      Write-Host "  [$($index + 1)] $($matches[$index])"
    }
    $choice = Read-Host 'Enter a number, or paste another SillyTavern root path'
    if ($choice -match '^\d+$' -and [int]$choice -ge 1 -and [int]$choice -le $matches.Count) {
      return $matches[[int]$choice - 1]
    }
    if (Test-SillyTavernRoot $choice) { return [IO.Path]::GetFullPath($choice) }
    throw 'The selected directory is not a SillyTavern root.'
  }
  if (-not $NonInteractive) {
    $choice = Read-Host 'SillyTavern was not detected. Paste its root directory path'
    if (Test-SillyTavernRoot $choice) { return [IO.Path]::GetFullPath($choice) }
  }
  throw 'SillyTavern was not detected. Re-run with -SillyTavernPath "your path".'
}

$stRoot = Resolve-SillyTavernRoot $SillyTavernPath
$pluginsRoot = Join-Path $stRoot 'plugins'
$targetPath = Join-Path $pluginsRoot 'srl-bridge'
$backupRoot = Join-Path $stRoot '.srl-bridge-backups'

if ($ConfigPath) {
  $configFile = [IO.Path]::GetFullPath($ConfigPath)
} else {
  $configFile = Join-Path $stRoot 'config.yaml'
  $globalConfig = if ($env:APPDATA) { Join-Path $env:APPDATA 'SillyTavern\config.yaml' } else { '' }
  if (-not (Test-Path -LiteralPath $configFile -PathType Leaf) -and $globalConfig -and (Test-Path -LiteralPath $globalConfig -PathType Leaf)) {
    $configFile = $globalConfig
    Write-Host "Using global-mode config: $configFile"
  }
}
if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) {
  throw 'config.yaml was not found. Start SillyTavern once, or pass -ConfigPath for global mode.'
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("srl-bridge-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tempRoot | Out-Null
$backupPath = ''
$installCompleted = $false

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
    Write-Host "The previous server plugin was moved aside temporarily: $backupPath"
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

  $installCompleted = $true
  if ($backupPath -and (Test-Path -LiteralPath $backupPath)) {
    if ($KeepBackup) {
      Write-Host "The previous server plugin was kept as a backup: $backupPath"
    } else {
      Remove-Item -LiteralPath $backupPath -Recurse -Force
      Write-Host 'The previous server plugin was removed after the new version was installed.'
    }
  }

  Write-Host ''
  Write-Host 'SRL device relay server plugin installed.' -ForegroundColor Green
  Write-Host "SillyTavern root: $stRoot"
  Write-Host "Plugin directory: $targetPath"
  Write-Host "Config file: $configFile"
  Write-Host 'Fully restart SillyTavern. The startup log should contain: [SRL Bridge] Short-lived device relay loaded'
} catch {
  if (-not $installCompleted -and $backupPath -and (Test-Path -LiteralPath $backupPath)) {
    if (Test-Path -LiteralPath $targetPath) {
      Remove-Item -LiteralPath $targetPath -Recurse -Force
    }
    Move-Item -LiteralPath $backupPath -Destination $targetPath
    Write-Warning "Install failed; the previous server plugin was restored to: $targetPath"
  }
  throw
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
