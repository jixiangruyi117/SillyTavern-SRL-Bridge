param([string]$Version = '0.3.12')

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function New-PortableZip {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Target
  )

  if (Test-Path -LiteralPath $Target) {
    Remove-Item -LiteralPath $Target -Force
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
$releaseRoot = Join-Path $repoRoot 'release'
$stageRoot = Join-Path $releaseRoot ".stage-$Version"
$extensionStage = Join-Path $stageRoot 'srl-bridge-extension\srl-bridge'
$serverStage = Join-Path $stageRoot 'srl-bridge-server-plugin\srl-bridge'
$completeStage = Join-Path $stageRoot 'srl-bridge-complete'

$resolvedRelease = [IO.Path]::GetFullPath($releaseRoot)
$resolvedStage = [IO.Path]::GetFullPath($stageRoot)
if (-not $resolvedStage.StartsWith($resolvedRelease, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Unsafe staging directory.'
}
if (Test-Path -LiteralPath $stageRoot) {
  Remove-Item -LiteralPath $stageRoot -Recurse -Force
}

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
Copy-Item -LiteralPath (Join-Path $releaseRoot 'INSTALL.md') -Destination (Join-Path $completeStage 'INSTALL.md')
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

Remove-Item -LiteralPath $stageRoot -Recurse -Force
Get-ChildItem -LiteralPath $releaseRoot -Filter "*v$Version.zip" | Select-Object Name, Length
