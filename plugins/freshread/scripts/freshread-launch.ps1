Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Hardened compatibility resolver. The quote-safe WSH launcher reaches this
# script only after the fast discovery path explicitly requests fallback.

function Resolve-SafeExistingPath {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  $fullPath = [System.IO.Path]::GetFullPath($LiteralPath)
  for ($attempt = 0; $attempt -lt 32; $attempt += 1) {
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    $parts = @($fullPath.Substring($root.Length) -split '[\\/]' | Where-Object { $_ })
    $current = $root
    $rewritten = $false

    for ($index = 0; $index -lt $parts.Count; $index += 1) {
      $current = Join-Path -Path $current -ChildPath $parts[$index]
      $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
        continue
      }

      if (-not ($item.PSObject.Properties.Name -contains "Target")) {
        throw "cannot safely resolve reparse point: $current"
      }
      $rawTarget = $item.Target
      if ($rawTarget -is [System.Array]) {
        $rawTarget = @($rawTarget | Where-Object { $_ })[0]
      }
      $target = [string]$rawTarget
      if ([string]::IsNullOrWhiteSpace($target)) {
        throw "cannot safely resolve reparse point: $current"
      }
      if ($target.StartsWith('\??\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $target = '\\' + $target.Substring(8)
      } elseif ($target.StartsWith('\??\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $target = $target.Substring(4)
      }
      if (-not [System.IO.Path]::IsPathRooted($target) -or $target -match '^[A-Za-z]:[^\\/]') {
        $target = Join-Path -Path ([System.IO.Path]::GetDirectoryName($current)) -ChildPath $target
      }
      if ($index + 1 -lt $parts.Count) {
        $tail = $parts[($index + 1)..($parts.Count - 1)] -join [System.IO.Path]::DirectorySeparatorChar
        $target = Join-Path -Path $target -ChildPath $tail
      }
      $fullPath = [System.IO.Path]::GetFullPath($target)
      $rewritten = $true
      break
    }

    if (-not $rewritten) {
      return [System.IO.Path]::GetFullPath($fullPath)
    }
  }
  throw "too many reparse points while resolving: $LiteralPath"
}

function Test-PathWithin {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Candidate
  )

  $rootPath = [System.IO.Path]::GetFullPath($Root)
  $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
  if ($candidatePath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  if (-not $rootPath.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $rootPath += [System.IO.Path]::DirectorySeparatorChar
  }
  return $candidatePath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)
}

try {
  if ([string]::IsNullOrWhiteSpace($env:PLUGIN_ROOT)) {
    throw "PLUGIN_ROOT is not set"
  }

  $workspace = Resolve-SafeExistingPath -LiteralPath (Get-Location).ProviderPath
  $pluginRoot = Resolve-SafeExistingPath -LiteralPath $env:PLUGIN_ROOT
  $hookScript = Resolve-SafeExistingPath -LiteralPath (Join-Path -Path $pluginRoot -ChildPath "scripts\freshread-hook.cjs")
  if (-not (Test-PathWithin -Root $pluginRoot -Candidate $hookScript)) {
    throw "hook script resolves outside PLUGIN_ROOT"
  }

  foreach ($rawEntry in ([string]$env:PATH).Split([System.IO.Path]::PathSeparator)) {
    if ([string]::IsNullOrWhiteSpace($rawEntry)) {
      continue
    }
    $entry = [System.Environment]::ExpandEnvironmentVariables($rawEntry.Trim().Trim([char]0x22))
    if ($entry -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)') {
      continue
    }

    try {
      # Most PATH entries do not contain Node. Keep the cheap lexical/existence
      # checks ahead of the component-by-component reparse-point walk, then
      # fully resolve the only candidate that can actually be executed.
      $directory = [System.IO.Path]::GetFullPath($entry)
      if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        continue
      }
      $candidate = Join-Path -Path $directory -ChildPath "node.exe"
      if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        continue
      }
      $nodePath = Resolve-SafeExistingPath -LiteralPath $candidate
    } catch {
      continue
    }

    if (Test-PathWithin -Root $workspace -Candidate $nodePath) {
      continue
    }

    # The child inherits stdin/stdout/stderr plus PLUGIN_ROOT and PLUGIN_DATA.
    & $nodePath $hookScript
    $childExitCode = $LASTEXITCODE
    if ($null -eq $childExitCode) {
      [System.Environment]::Exit(0)
    }
    [System.Environment]::Exit([int]$childExitCode)
  }

  throw "no trusted node.exe was found in an absolute PATH directory outside the workspace"
} catch {
  [Console]::Error.WriteLine("FreshRead launcher failed: $($_.Exception.Message)")
  # Hook exit 2 is the Codex blocking-error contract. In particular, a
  # PreToolUse launcher failure must not silently allow the pending edit.
  [System.Environment]::Exit(2)
}
