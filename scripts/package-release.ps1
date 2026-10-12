param(
  [string]$Version = '0.3.59',
  [string]$OutputDirectory = '',
  [switch]$KeepStaging
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function New-PortableZip {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Target
  )

  if (Test-Path -LiteralPath $Target) {
    throw "Release archive already exists: $Target"
  }
  $sourceRoot = [IO.Path]::GetFullPath($Source).TrimEnd([char[]]@('\', '/'))
  $archive = [IO.Compression.ZipFile]::Open(
    $Target,
    [IO.Compression.ZipArchiveMode]::Create
  )
  try {
    Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | ForEach-Object {
      $entryName = $_.FullName.Substring($sourceRoot.Length).TrimStart([char[]]@('\', '/')).Replace('\', '/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,
        $_.FullName,
        $entryName,
        [IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
  } finally {
    $archive.Dispose()
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $repoRoot 'release' }
$temporaryRoot = Join-Path $repoRoot '.codex-tmp'
$stageRoot = Join-Path $temporaryRoot ("bridge-package-$Version-" + [guid]::NewGuid().ToString('N'))
$extensionStage = Join-Path $stageRoot 'srl-bridge-extension\srl-bridge'
$serverStage = Join-Path $stageRoot 'srl-bridge-server-plugin\srl-bridge'
$completeStage = Join-Path $stageRoot 'srl-bridge-complete'

$resolvedTemporary = [IO.Path]::GetFullPath($temporaryRoot).TrimEnd('\') + '\'
$resolvedStage = [IO.Path]::GetFullPath($stageRoot)
if (-not $resolvedStage.StartsWith($resolvedTemporary, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Unsafe staging directory.'
}
if (Test-Path -LiteralPath $stageRoot) {
  throw 'Staging path already exists.'
}

New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
New-Item -ItemType Directory -Force -Path $extensionStage, $serverStage, $completeStage | Out-Null
$extensionFiles = @('index.js', 'manifest.json', 'settings.html', 'style.css', 'bridge.html', 'bridge.js', 'bridge.css')
foreach ($name in $extensionFiles) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $name) -Destination (Join-Path $extensionStage $name)
}
Copy-Item -LiteralPath (Join-Path $repoRoot 'modules') -Destination $extensionStage -Recurse
Copy-Item -LiteralPath (Join-Path $repoRoot 'server-plugin\index.mjs') -Destination (Join-Path $serverStage 'index.mjs')
Copy-Item -LiteralPath (Join-Path $repoRoot 'server-plugin\relay.js') -Destination (Join-Path $serverStage 'relay.js')

Copy-Item -LiteralPath (Split-Path -Parent $extensionStage) -Destination $completeStage -Recurse
Copy-Item -LiteralPath (Split-Path -Parent $serverStage) -Destination $completeStage -Recurse
Copy-Item -LiteralPath (Join-Path $repoRoot 'release\INSTALL.md') -Destination (Join-Path $completeStage 'INSTALL.md')
New-Item -ItemType Directory -Force -Path (Join-Path $completeStage 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\install-server-plugin.ps1') -Destination (Join-Path $completeStage 'scripts\install-server-plugin.ps1')
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\install-server-plugin.sh') -Destination (Join-Path $completeStage 'scripts\install-server-plugin.sh')

$archives = @(
  @{ Source = (Split-Path -Parent $extensionStage); Name = "srl-bridge-extension-v$Version.zip" },
  @{ Source = (Split-Path -Parent $serverStage); Name = "srl-bridge-server-plugin-v$Version.zip" },
  @{ Source = $completeStage; Name = "srl-bridge-complete-v$Version.zip" }
)
foreach ($archive in $archives) {
  $target = Join-Path $releaseRoot $archive.Name
  New-PortableZip -Source $archive.Source -Target $target
}

Copy-Item `
  -LiteralPath (Join-Path $releaseRoot "srl-bridge-server-plugin-v$Version.zip") `
  -Destination (Join-Path $releaseRoot 'srl-bridge-server-plugin-latest.zip') `
  -Force

if (-not $KeepStaging) {
  # Review the exact newly created staging tree before deleting ordinary files.
  $entries = @(Get-ChildItem -LiteralPath $resolvedStage -Recurse -Force)
  $protected = [IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System
  if ($entries | Where-Object { ($_.Attributes -band $protected) -ne 0 }) {
    throw "Protected staging entry; retained: $resolvedStage"
  }
  foreach ($entry in $entries | Where-Object { -not $_.PSIsContainer }) {
    Remove-Item -LiteralPath $entry.FullName -ErrorAction Stop
  }
  foreach ($entry in $entries | Where-Object { $_.PSIsContainer } | Sort-Object { $_.FullName.Length } -Descending) {
    if (@(Get-ChildItem -LiteralPath $entry.FullName -Force).Count -ne 0) { throw 'Staging directory is not empty.' }
    Remove-Item -LiteralPath $entry.FullName -ErrorAction Stop
  }
  Remove-Item -LiteralPath $resolvedStage -ErrorAction Stop
} else {
  Write-Output "Retained staging for verification: $resolvedStage"
}
Get-ChildItem -LiteralPath $releaseRoot -Filter "*v$Version.zip" | Select-Object Name, Length
