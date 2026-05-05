param(
	[Parameter(Mandatory = $true, Position = 0)]
	[string[]]$Engine,

	[string]$RepoUrl = "git@github.com:agenthippoai/custom-engines.git",
	[string]$Ref = "",
	[string]$SourceRoot = "",
	[string]$CacheRoot = "",
	[string]$InstallRoot = "",
	[switch]$NoNpmCi
)

$ErrorActionPreference = "Stop"

function Get-FullPath {
	param([Parameter(Mandatory = $true)][string]$Path)
	return [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path))
}

function Test-Command {
	param([Parameter(Mandatory = $true)][string]$Name)
	return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Logged {
	param(
		[Parameter(Mandatory = $true)][string]$FilePath,
		[Parameter(Mandatory = $true)][string[]]$Arguments,
		[string]$WorkingDirectory = ""
	)
	$display = "$FilePath $($Arguments -join ' ')"
	Write-Host ">> $display"
	if ($WorkingDirectory) {
		& $FilePath @Arguments
	} else {
		& $FilePath @Arguments
	}
	if ($LASTEXITCODE -ne 0) {
		throw "Command failed with exit code ${LASTEXITCODE}: $display"
	}
}

function Ensure-SourceRoot {
	param(
		[Parameter(Mandatory = $true)][string]$RepoUrl,
		[string]$Ref,
		[string]$SourceRoot,
		[string]$CacheRoot
	)

	if ($SourceRoot.Trim()) {
		$resolved = Get-FullPath $SourceRoot
		if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
			throw "SourceRoot does not exist: $resolved"
		}
		return $resolved
	}

	if (-not (Test-Command git)) {
		throw "git is required when -SourceRoot is not provided"
	}

	if (-not $CacheRoot.Trim()) {
		$CacheRoot = Join-Path $HOME ".agent-hippo/cache/custom-engines/agenthippoai-custom-engines"
	}
	$cache = Get-FullPath $CacheRoot
	$cacheParent = Split-Path -Parent $cache
	New-Item -ItemType Directory -Path $cacheParent -Force | Out-Null

	if (Test-Path -LiteralPath (Join-Path $cache ".git") -PathType Container) {
		Invoke-Logged git @("-C", $cache, "fetch", "--all", "--tags", "--prune")
		if ($Ref.Trim()) {
			Invoke-Logged git @("-C", $cache, "checkout", $Ref)
		} else {
			Invoke-Logged git @("-C", $cache, "pull", "--ff-only")
		}
	} elseif (Test-Path -LiteralPath $cache) {
		throw "CacheRoot exists but is not a Git checkout: $cache"
	} else {
		Invoke-Logged git @("clone", $RepoUrl, $cache)
		if ($Ref.Trim()) {
			Invoke-Logged git @("-C", $cache, "checkout", $Ref)
		}
	}

	return $cache
}

function Copy-EngineFolder {
	param(
		[Parameter(Mandatory = $true)][string]$Source,
		[Parameter(Mandatory = $true)][string]$Destination,
		[Parameter(Mandatory = $true)][string]$InstallRoot
	)

	$installRootFull = Get-FullPath $InstallRoot
	New-Item -ItemType Directory -Path $installRootFull -Force | Out-Null
	$destFull = [System.IO.Path]::GetFullPath($Destination)
	$installRootPrefix = $installRootFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
	if (-not $destFull.StartsWith($installRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
		throw "Refusing to write outside InstallRoot. Destination: $destFull InstallRoot: $installRootFull"
	}

	if (Test-Path -LiteralPath $destFull) {
		Remove-Item -LiteralPath $destFull -Recurse -Force
	}
	New-Item -ItemType Directory -Path $destFull -Force | Out-Null

	Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
		if ($_.Name -eq "node_modules" -or $_.Name -eq ".git") {
			return
		}
		Copy-Item -LiteralPath $_.FullName -Destination $destFull -Recurse -Force
	}
}

function Install-OneEngine {
	param(
		[Parameter(Mandatory = $true)][string]$EngineName,
		[Parameter(Mandatory = $true)][string]$SourceRoot,
		[Parameter(Mandatory = $true)][string]$InstallRoot,
		[switch]$NoNpmCi
	)

	$source = Join-Path $SourceRoot $EngineName
	if (-not (Test-Path -LiteralPath $source -PathType Container)) {
		throw "Engine '$EngineName' not found under source root: $SourceRoot"
	}

	$sourceManifestPath = Join-Path $source "engine.manifest.json"
	if (-not (Test-Path -LiteralPath $sourceManifestPath -PathType Leaf)) {
		throw "Missing engine.manifest.json for '$EngineName': $sourceManifestPath"
	}
	$manifest = Get-Content -LiteralPath $sourceManifestPath -Raw | ConvertFrom-Json
	if ($manifest.version -ne 2) {
		throw "Engine '$EngineName' manifest version must be 2"
	}
	if (-not "$($manifest.id)".Trim()) {
		throw "Engine '$EngineName' manifest is missing id"
	}
	if (-not "$($manifest.entry)".Trim()) {
		throw "Engine '$EngineName' manifest is missing entry"
	}

	$engineId = "$($manifest.id)".Trim().ToLowerInvariant()
	$dest = Join-Path $InstallRoot $engineId
	Write-Host "Installing engine '$EngineName' as '$engineId'"
	Copy-EngineFolder -Source $source -Destination $dest -InstallRoot $InstallRoot

	$destManifestPath = Join-Path $dest "engine.manifest.json"
	$destManifest = Get-Content -LiteralPath $destManifestPath -Raw | ConvertFrom-Json
	$entry = "$($destManifest.entry)".Trim()
	$entryPath = if ([System.IO.Path]::IsPathRooted($entry)) { $entry } else { Join-Path $dest $entry }
	if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
		throw "Manifest entry not found after install: $entryPath"
	}

	$packageJson = Join-Path $dest "package.json"
	if ((Test-Path -LiteralPath $packageJson -PathType Leaf) -and -not $NoNpmCi) {
		if (-not (Test-Command npm)) {
			throw "npm is required to install dependencies for '$engineId'"
		}
		$packageLock = Join-Path $dest "package-lock.json"
		if (-not (Test-Path -LiteralPath $packageLock -PathType Leaf)) {
			throw "package-lock.json is required for deterministic npm ci: $packageLock"
		}
		Invoke-Logged npm @("ci", "--prefix", $dest, "--omit=dev")
	}

	if (-not (Test-Command node)) {
		throw "node is required for syntax validation"
	}
	Invoke-Logged node @("--check", $entryPath)

	Write-Host "Installed custom engine '$engineId' at $dest"
}

if (-not $InstallRoot.Trim()) {
	$InstallRoot = Join-Path $HOME ".agent-hippo/engines"
}

$sourceRootResolved = Ensure-SourceRoot -RepoUrl $RepoUrl -Ref $Ref -SourceRoot $SourceRoot -CacheRoot $CacheRoot
$installRootResolved = Get-FullPath $InstallRoot

foreach ($engineName in $Engine) {
	Install-OneEngine -EngineName $engineName -SourceRoot $sourceRootResolved -InstallRoot $installRootResolved -NoNpmCi:$NoNpmCi
}

Write-Host "Done. AgentHippo will discover installed engines from: $installRootResolved"
