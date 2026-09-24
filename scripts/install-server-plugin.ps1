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

  $installRoots = @(Find-SillyTavernRoots)
  if ($installRoots.Count -eq 1) {
    Write-Host "Detected SillyTavern: $($installRoots[0])"
    return $installRoots[0]
  }
  if ($installRoots.Count -gt 1 -and -not $NonInteractive) {
    Write-Host 'Multiple SillyTavern installations were found:'
    for ($index = 0; $index -lt $installRoots.Count; $index += 1) {
      Write-Host "  [$($index + 1)] $($installRoots[$index])"
    }
    $choice = Read-Host 'Enter a number, or paste another SillyTavern root path'
    if ($choice -match '^\d+$' -and [int]$choice -ge 1 -and [int]$choice -le $installRoots.Count) {
      return $installRoots[[int]$choice - 1]
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

function Remove-InstallerFolder([string]$Path, [string]$ParentPath) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  $parent = [IO.Path]::GetFullPath($ParentPath).TrimEnd('\') + '\'
  if (-not $fullPath.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup path is outside its expected parent.' }
  if (-not (Test-Path -LiteralPath $fullPath)) { return }
  $rootItem = Get-Item -LiteralPath $fullPath -Force
  $entries = @(Get-ChildItem -LiteralPath $fullPath -Recurse -Force)
  foreach ($item in @($rootItem) + $entries) {
    if (($item.Attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System)) -ne 0) {
      throw "Cleanup left protected or linked content untouched: $($item.FullName)"
    }
    if (-not [IO.Path]::GetFullPath($item.FullName).StartsWith($parent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup entry escaped its expected parent.' }
  }
  foreach ($item in $entries | Where-Object { -not $_.PSIsContainer }) { Remove-Item -LiteralPath $item.FullName }
  foreach ($item in $entries | Where-Object { $_.PSIsContainer } | Sort-Object { $_.FullName.Length } -Descending) { Remove-Item -LiteralPath $item.FullName }
  Remove-Item -LiteralPath $fullPath
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
    # Match the Termux installer: the old fixed Release ZIP URL can return 404.
    $entryRoot = Join-Path $tempRoot 'package\srl-bridge'
    New-Item -ItemType Directory -Path $entryRoot -Force | Out-Null
    Write-Host 'Downloading the two server-plugin files (no Release ZIP required)...'
    foreach ($name in @('index.mjs', 'relay.js')) {
      $downloadPath = Join-Path $entryRoot $name
      try {
        Invoke-WebRequest -Uri "https://raw.githubusercontent.com/jixiangruyi117/SillyTavern-SRL-Bridge/main/server-plugin/$name" -OutFile $downloadPath -UseBasicParsing
      } catch {
        Write-Warning "Raw GitHub download failed; trying the CDN mirror for $name."
        Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/gh/jixiangruyi117/SillyTavern-SRL-Bridge@main/server-plugin/$name" -OutFile $downloadPath -UseBasicParsing
      }
    }
  }

  $extractRoot = Join-Path $tempRoot 'package'
  if ($PackagePath) { Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot }
  $entry = Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter 'index.mjs' |
    Where-Object { $_.Directory.Name -eq 'srl-bridge' } |
    Select-Object -First 1
  if (-not $entry) { throw 'Invalid package: srl-bridge/index.mjs was not found.' }
  if (-not (Test-Path -LiteralPath (Join-Path $entry.Directory.FullName 'relay.js'))) {
    throw 'Invalid package: relay.js is missing.'
  }
  $relayFile = Join-Path $entry.Directory.FullName 'relay.js'
  if (-not (Select-String -LiteralPath $entry.FullName -SimpleMatch "id: 'srl-bridge'" -Quiet) -or
      -not (Select-String -LiteralPath $relayFile -SimpleMatch 'srl-tavern-bridge' -Quiet)) {
    throw 'The downloaded files are not an SRL server plugin. Nothing was installed.'
  }
  $nodeCommand = Get-Command node -ErrorAction Stop
  foreach ($sourceFile in @($entry.FullName, $relayFile)) {
    & $nodeCommand.Source --check $sourceFile
    if ($LASTEXITCODE -ne 0) { throw 'Server plugin syntax validation failed. Nothing was installed.' }
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
  $settingPattern = '(?m)^enableServerPlugins\s*:\s*(?:true|false)[ \t]*(#[^\r\n]*)?\r?$'
  if ([regex]::IsMatch($config, $settingPattern)) {
    $config = [regex]::Replace($config, $settingPattern, 'enableServerPlugins: true $1')
    Set-Content -LiteralPath $configFile -Value $config -Encoding utf8
  } else {
    Add-Content -LiteralPath $configFile -Value "`nenableServerPlugins: true" -Encoding utf8
  }

  $extensionCount = 0
  $extensionUpdated = 0
  $dataRoot = Join-Path $stRoot 'data'
  if (Test-Path -LiteralPath $dataRoot -PathType Container) {
    $extensionManifests = @(
      Get-ChildItem -LiteralPath $dataRoot -Recurse -File -Filter 'manifest.json' -ErrorAction SilentlyContinue |
        Where-Object {
          $_.Directory.Name -eq 'SillyTavern-SRL-Bridge' -and
          $_.Directory.Parent.Name -eq 'extensions'
        }
    )
    foreach ($manifest in $extensionManifests) {
      $extensionCount += 1
      $extensionPath = $manifest.Directory.FullName
      $gitDirectory = Join-Path $extensionPath '.git'
      $gitCommand = Get-Command git -ErrorAction SilentlyContinue
      if ((Test-Path -LiteralPath $gitDirectory -PathType Container) -and $gitCommand) {
        $dirty = & git -C $extensionPath status --porcelain
        if ($LASTEXITCODE -eq 0 -and -not $dirty) {
          & git -C $extensionPath pull --ff-only
          if ($LASTEXITCODE -eq 0) {
            $extensionUpdated += 1
            $extensionVersion = (Get-Content -LiteralPath $manifest.FullName -Raw -Encoding utf8 | ConvertFrom-Json).version
            Write-Host "SUCCESS: SRL front-end extension updated to $extensionVersion`: $extensionPath" -ForegroundColor Green
            continue
          }
        }
      }
      Write-Warning "The front-end extension could not be updated automatically: $extensionPath"
      Write-Warning 'Open SillyTavern > Extensions > Manage extensions, then update SRL 酒馆资源库互传.'
    }
  }

  $installCompleted = $true
  if ($backupPath -and (Test-Path -LiteralPath $backupPath)) {
    if ($KeepBackup) {
      Write-Host "The previous server plugin was kept as a backup: $backupPath"
    } else {
      Remove-InstallerFolder $backupPath $backupRoot
      Write-Host 'The previous server plugin was removed after the new version was installed.'
    }
  }

  Write-Host ''
  Write-Host 'SUCCESS: SRL server relay plugin has been installed.' -ForegroundColor Green
  if ($extensionCount -eq 0) {
    Write-Warning 'The SRL front-end extension was not found.'
    Write-Warning 'Install it in SillyTavern with this Git URL:'
    Write-Warning 'https://github.com/jixiangruyi117/SillyTavern-SRL-Bridge.git'
  } elseif ($extensionUpdated -ne $extensionCount) {
    Write-Warning 'The server plugin is current, but at least one SRL front-end extension still needs a manual update.'
  }
  Write-Host "SillyTavern root: $stRoot"
  Write-Host "Plugin directory: $targetPath"
  Write-Host "Config file: $configFile"
  Write-Host 'Next: fully stop and restart SillyTavern.'
  Write-Host 'Verify: the startup log should contain: [SRL Bridge] Short-lived device relay loaded'
  Write-Host 'If you do not see it, make sure the running SillyTavern uses the SillyTavern root printed above.'
} catch {
  if (-not $installCompleted -and $backupPath -and (Test-Path -LiteralPath $backupPath)) {
    if (Test-Path -LiteralPath $targetPath) {
      Remove-InstallerFolder $targetPath $pluginsRoot
    }
    Move-Item -LiteralPath $backupPath -Destination $targetPath
    Write-Warning "Install failed; the previous server plugin was restored to: $targetPath"
  }
  throw
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-InstallerFolder $tempRoot ([IO.Path]::GetTempPath())
  }
}
