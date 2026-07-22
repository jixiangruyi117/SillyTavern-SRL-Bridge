param([string]$Version = '0.3.2')

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

$archives = @(
  @{ Source = (Split-Path -Parent $extensionStage); Name = "srl-bridge-extension-v$Version.zip" },
  @{ Source = (Split-Path -Parent $serverStage); Name = "srl-bridge-server-plugin-v$Version.zip" },
  @{ Source = $completeStage; Name = "srl-bridge-complete-v$Version.zip" }
)
foreach ($archive in $archives) {
  $target = Join-Path $releaseRoot $archive.Name
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  Compress-Archive -Path (Join-Path $archive.Source '*') -DestinationPath $target -CompressionLevel Optimal
}

Remove-Item -LiteralPath $stageRoot -Recurse -Force
Get-ChildItem -LiteralPath $releaseRoot -Filter "*v$Version.zip" | Select-Object Name, Length
