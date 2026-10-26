@echo off
setlocal

:: ====================================================================
:: Silent unpacked-extension updater
::
:: Extracts IclaimUpdate.ps1, downloads the public main branch into
:: Documents\Iclaim-automation, and registers a hidden logon task that
:: replaces that folder only when the remote manifest version is higher.
::
:: The GitHub repo must be public. To use a folder other than Documents,
:: change $DestParent in the PowerShell section below, then run this file
:: again so the scheduled task keeps the new path.
:: ====================================================================

:: ====================================================================
:: 1. AUTO-ELEVATE TO ADMINISTRATOR
:: ====================================================================
net session >nul 2>&1
if %errorLevel% NEQ 0 (
    echo Requesting Administrator privileges...
    powershell.exe -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:: ====================================================================
:: 2. EXTRACT THE POWERSHELL SCRIPT
:: ====================================================================
echo Setting up silent Iclaim extension updater...

set "TasksDir=%APPDATA%\CustomScripts\IclaimUpdate"
set "PS1Path=%TasksDir%\IclaimUpdate.ps1"

if not exist "%TasksDir%" mkdir "%TasksDir%"

powershell.exe -NoProfile -Command "$content = Get-Content '%~f0' -Raw; $delim = ':: --- BEGIN ' + 'POWERSHELL SCRIPT ---'; $parts = $content -split $delim; Set-Content -Path '%PS1Path%' -Value $parts[1].Trim() -Encoding UTF8"

:: ====================================================================
:: 3. RUN THE EXTRACTED SCRIPT IN INSTALL MODE
:: ====================================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1Path%" -InstallMode

echo.
pause
exit /b

:: --- BEGIN POWERSHELL SCRIPT ---
param (
    [switch]$InstallMode,
    [switch]$RunUpdate
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
}

$RepoZipUrl = 'https://github.com/naguibamged/Iclaim-automation/archive/refs/heads/main.zip'
$RemoteManifestUrl = 'https://raw.githubusercontent.com/naguibamged/Iclaim-automation/main/manifest.json'
$AttemptCount = 3
$RetrySeconds = 15

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$ConfigPath = Join-Path $ScriptDir 'config.json'
$LogPath = Join-Path $ScriptDir 'update.log'

function Write-UpdateLog {
    param([string]$Message)
    $dir = Split-Path -Parent $LogPath
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $line = '{0}  {1}{2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message, [Environment]::NewLine
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::AppendAllText($LogPath, $line, $utf8)
}

function Get-ManifestVersion {
    param([Parameter(Mandatory = $true)][string]$ManifestPath)
    $json = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $json.version) {
        throw "No version in $ManifestPath"
    }
    return [version]$json.version
}

function Get-SavedDest {
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw 'config.json was not found. Run the installer first.'
    }
    $cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $cfg.dest) {
        throw 'config.json has no dest path.'
    }
    return [string]$cfg.dest
}

function Assert-SafeDest {
    param([Parameter(Mandatory = $true)][string]$Dest)
    $full = [System.IO.Path]::GetFullPath($Dest)
    $parent = Split-Path -Parent $full
    $leaf = Split-Path -Leaf $full
    if (-not $parent -or -not $leaf) {
        throw 'Destination path is not a specific folder.'
    }
    if ($full -match '^[A-Za-z]:\\$') {
        throw 'Refusing to replace a drive root.'
    }
    $scriptFull = [System.IO.Path]::GetFullPath($ScriptDir).TrimEnd('\')
    if ($full.TrimEnd('\') -eq $scriptFull) {
        throw 'Refusing to replace the updater script folder.'
    }
    return $full
}

function Expand-RepoZip {
    param([Parameter(Mandatory = $true)][string]$WorkRoot)
    New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
    $zipPath = Join-Path $WorkRoot 'repo.zip'
    Invoke-WebRequest -Uri $RepoZipUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 120
    $expanded = Join-Path $WorkRoot 'expanded'
    Expand-Archive -LiteralPath $zipPath -DestinationPath $expanded -Force
    $inner = Get-ChildItem -LiteralPath $expanded -Force -Directory | Where-Object {
        Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json')
    } | Select-Object -First 1
    if (-not $inner) {
        throw 'Downloaded zip has no manifest.json.'
    }
    return $inner.FullName
}

function Install-StagedExtension {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDir,
        [Parameter(Mandatory = $true)][string]$Dest,
        [version]$LocalVersion
    )

    $fullDest = Assert-SafeDest -Dest $Dest
    $parent = Split-Path -Parent $fullDest
    $leaf = Split-Path -Leaf $fullDest
    $staging = Join-Path $parent ($leaf + '.new')
    $backup = Join-Path $parent ($leaf + '.old')

    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }

    Copy-Item -LiteralPath $SourceDir -Destination $staging -Recurse -Force
    $stagedManifest = Join-Path $staging 'manifest.json'
    if (-not (Test-Path -LiteralPath $stagedManifest)) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        throw 'Staged copy is missing manifest.json.'
    }

    $stagedVersion = Get-ManifestVersion -ManifestPath $stagedManifest
    if ($LocalVersion -and $stagedVersion -le $LocalVersion) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        throw "Downloaded version $stagedVersion is not newer than $LocalVersion."
    }

    $renamedAway = $false
    try {
        if (Test-Path -LiteralPath $fullDest) {
            if (Test-Path -LiteralPath $backup) {
                Remove-Item -LiteralPath $backup -Recurse -Force
            }
            Rename-Item -LiteralPath $fullDest -NewName ($leaf + '.old')
            $renamedAway = $true
        }
        Rename-Item -LiteralPath $staging -NewName $leaf
    } catch {
        if ($renamedAway -and -not (Test-Path -LiteralPath $fullDest) -and (Test-Path -LiteralPath $backup)) {
            Rename-Item -LiteralPath $backup -NewName $leaf
        }
        if (Test-Path -LiteralPath $staging) {
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        }
        throw
    }

    if (Test-Path -LiteralPath $backup) {
        try {
            Remove-Item -LiteralPath $backup -Recurse -Force
        } catch {
            Write-UpdateLog ("Could not remove previous copy: " + $_.Exception.Message)
        }
    }

    return $stagedVersion
}

function Update-Extension {
    $dest = Assert-SafeDest -Dest (Get-SavedDest)
    $manifestPath = Join-Path $dest 'manifest.json'
    $lastError = $null

    for ($attempt = 1; $attempt -le $AttemptCount; $attempt++) {
        $work = Join-Path $env:TEMP ('IclaimUpdate-' + [guid]::NewGuid().ToString('N'))
        try {
            $localVersion = $null
            if (Test-Path -LiteralPath $manifestPath) {
                $localVersion = Get-ManifestVersion -ManifestPath $manifestPath
                $remoteVersion = Invoke-RestMethod -Uri $RemoteManifestUrl -UseBasicParsing -TimeoutSec 30
                if (-not $remoteVersion.version) {
                    throw 'Remote manifest has no version.'
                }
                $remoteParsed = [version]$remoteVersion.version
                if ($remoteParsed -le $localVersion) {
                    Write-UpdateLog "Already at version $localVersion."
                    if ($InstallMode) {
                        Write-Host "Already at version $localVersion." -ForegroundColor Green
                    }
                    return
                }
                if ($InstallMode) {
                    Write-Host "Remote version $remoteParsed is newer than $localVersion. Downloading..." -ForegroundColor Cyan
                }
            } elseif ($InstallMode) {
                Write-Host 'No local copy yet. Downloading main...' -ForegroundColor Cyan
            }

            $sourceDir = Expand-RepoZip -WorkRoot $work
            $installed = Install-StagedExtension -SourceDir $sourceDir -Dest $dest -LocalVersion $localVersion
            Write-UpdateLog "Extension folder set to version $installed ($dest)."
            if ($InstallMode) {
                Write-Host "Extension is at version $installed." -ForegroundColor Green
            }
            return
        } catch {
            $lastError = $_.Exception.Message
            Write-UpdateLog "Attempt $attempt of $AttemptCount failed: $lastError"
            if ($attempt -lt $AttemptCount) {
                Start-Sleep -Seconds $RetrySeconds
            }
        } finally {
            if ($work -and (Test-Path -LiteralPath $work)) {
                Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }

    throw $lastError
}

# ====================================================================
# UPDATE (Task Scheduler, and any run without -InstallMode)
# ====================================================================
if ($RunUpdate -or -not $InstallMode) {
    try {
        Update-Extension
        exit 0
    } catch {
        $failed = $_.Exception.Message
        Write-UpdateLog "Update failed: $failed"
        exit 1
    }
}

# ====================================================================
# INSTALL (run by the top half of this batch file)
# ====================================================================
if ($InstallMode) {
    try {
        # Destination parent. This is the only path to change later.
        # Re-run this installer after editing it so config.json is saved again.
        $DestParent = [Environment]::GetFolderPath('MyDocuments')
        $DestFolderName = 'Iclaim-automation'
        $dest = [System.IO.Path]::GetFullPath((Join-Path $DestParent $DestFolderName))
        Assert-SafeDest -Dest $dest | Out-Null

        Write-Host '1/2: Saving destination and downloading the extension...' -ForegroundColor Cyan
        @{ dest = $dest } | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
        Update-Extension

        Write-Host '2/2: Creating scheduled task...' -ForegroundColor Cyan
        $TaskName = 'SilentIclaimUpdate'
        $Action = New-ScheduledTaskAction -Execute 'PowerShell.exe' `
            -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -RunUpdate"
        $Trigger = New-ScheduledTaskTrigger -AtLogOn
        $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
        $Principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null

        Write-Host ''
        Write-Host 'Success!' -ForegroundColor Green
        Write-Host "The updater script is at: $PSCommandPath"
        Write-Host "Load this folder once in Chrome (Developer mode, Load unpacked):"
        Write-Host $dest
        Write-Host "Task '$TaskName' is registered and will check for a newer version at each sign-in."
    } catch {
        Write-Host ''
        Write-Host '--- AN ERROR OCCURRED ---' -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Yellow
        Write-UpdateLog ("Install failed: " + $_.Exception.Message)
    }
}
