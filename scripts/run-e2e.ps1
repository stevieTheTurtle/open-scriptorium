# Runs the end-to-end suite in an isolated editor window, against a throwaway copy of a project.
# Usage: run-e2e.ps1 -Exe <Code.exe or Cursor.exe> -WorkDir <scratch> -Tectonic <exe> [-Mode fixture|thesis] [-Project <folder>]
param(
  [Parameter(Mandatory)] [string] $Exe,
  [Parameter(Mandatory)] [string] $WorkDir,
  [Parameter(Mandatory)] [string] $Tectonic,
  [ValidateSet('fixture', 'thesis')] [string] $Mode = 'fixture',
  [string] $Project,
  [int] $TimeoutSeconds = 240
)

$repo = Split-Path $PSScriptRoot -Parent
$utf8 = New-Object System.Text.UTF8Encoding $false
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue

$workspace = Join-Path $WorkDir 'workspace'
New-Item -ItemType Directory -Force $WorkDir | Out-Null
$source = if ($Mode -eq 'fixture') { Join-Path $repo 'test\e2e\fixture' } else { $Project }
Copy-Item $source $workspace -Recurse
New-Item -ItemType Directory -Force (Join-Path $workspace '.vscode') | Out-Null
$settings = @{ 'openScriptorium.tectonicPath' = $Tectonic; 'openScriptorium.compile.trigger' = 'off'; 'openScriptorium.mainFile' = 'main.tex' }
[System.IO.File]::WriteAllText((Join-Path $workspace '.vscode\settings.json'), ($settings | ConvertTo-Json), $utf8)

# A throwaway profile must not be able to update the installed editor.
$userDir = Join-Path $WorkDir 'ud\User'
New-Item -ItemType Directory -Force $userDir | Out-Null
[System.IO.File]::WriteAllText((Join-Path $userDir 'settings.json'), '{ "update.mode": "none" }', $utf8)

$report = Join-Path $WorkDir 'report.json'
$runFile = Join-Path $repo '.e2e-run.json'
[System.IO.File]::WriteAllText($runFile, (@{ reportPath = $report; mode = $Mode } | ConvertTo-Json), $utf8)

try {
  $launchArgs = @(
    "--extensionDevelopmentPath=`"$repo`"",
    "--extensionTestsPath=`"$repo\out-e2e\suite.js`"",
    "--user-data-dir=`"$WorkDir\ud`"",
    "--extensions-dir=`"$WorkDir\ext`"",
    '--disable-updates',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--new-window',
    "`"$workspace`""
  )
  $process = Start-Process -FilePath $Exe -ArgumentList $launchArgs -PassThru
  $exited = $process.WaitForExit($TimeoutSeconds * 1000)
  "window closed by itself: $exited"
  if (-not $exited) { & taskkill /PID $process.Id /T /F | Out-Null }
} finally {
  Remove-Item $runFile -ErrorAction SilentlyContinue
}

if (Test-Path $report) { Get-Content $report -Raw } else { 'NO REPORT WRITTEN' }
