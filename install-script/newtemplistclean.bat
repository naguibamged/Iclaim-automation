@echo off
setlocal

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
echo Setting up TempList silent cleanup task and context menus...

set "TasksDir=%APPDATA%\CustomScripts\TempList"
set "PS1Path=%TasksDir%\TempList.ps1"

:: Create the directory if it doesn't exist
if not exist "%TasksDir%" mkdir "%TasksDir%"

:: Extract the bottom half of this file securely
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
    [switch]$RunCleanup
)

# ====================================================================
# THE CLEANUP LOGIC (Triggered by Task Scheduler)
# ====================================================================
if ($RunCleanup -or -not $InstallMode) {
    
    # 1. Define the function (returns $true on successful deletion)
    function Clear-OldItems {
        param (
            [Parameter(Mandatory=$true)]
            [string]$Path,

            [Parameter(Mandatory=$false)]
            [int]$Days = 14,

            [Parameter(Mandatory=$false)]
            [ValidateSet("Clear", "Remove")]
            [string]$Mode = "Clear"
        )

        if (Test-Path $Path) {
            if ($Mode -eq "Clear") {
                Write-Host "Running in CLEAR mode (checking children inside: $Path)..." -ForegroundColor Cyan
                $anyDeleted = $false
                
                Get-ChildItem -Path $Path | ForEach-Object { 
                    if (((Get-Date) - $_.LastWriteTime).Days -gt $Days) { 
                        $_ | Remove-Item -Recurse -Force 
                        Write-Host "  Deleted child: $($_.Name) (Older than $Days days)" -ForegroundColor DarkRed
                        $anyDeleted = $true 
                    } else { 
                        Write-Host "  Kept child: $($_.Name) (lalal)" -ForegroundColor Green
                    } 
                }
                return $anyDeleted 
            } 
            elseif ($Mode -eq "Remove") {
                Write-Host "Running in REMOVE mode (checking the target itself)..." -ForegroundColor Cyan
                $TargetItem = Get-Item -Path $Path

                if (((Get-Date) - $TargetItem.LastWriteTime).Days -gt $Days) { 
                    $TargetItem | Remove-Item -Recurse -Force 
                    Write-Host "Deleted the target folder/file: $($TargetItem.Name) (Older than $Days days)" -ForegroundColor DarkRed
                    return $true 
                } else { 
                    Write-Host "Kept the target folder/file: $($TargetItem.Name)" -ForegroundColor Green
                    return $false
                }
            }
        } else {
            Write-Warning "The path '$Path' does not exist."
            return $false
        }
    }

    # 2. Main Script Logic
    $jsonPath = "$PSScriptRoot\List.json"

    if (Test-Path $jsonPath) {
        $jsonContent = Get-Content -Raw -Path $jsonPath | ConvertFrom-Json
        
        $itemsList = [System.Collections.ArrayList]@($jsonContent)
        
        for ($i = $itemsList.Count - 1; $i -ge 0; $i--) {
            $item = $itemsList[$i]
            
            Write-Host "--------------------------------------------------" -ForegroundColor Gray
            Write-Host "Processing Path: $($item.Path)" -ForegroundColor Yellow
            
            $wasDeleted = Clear-OldItems -Path $item.Path -Days $item.Days -Mode $item.Mode
            
            if ($wasDeleted) {
                if ($item.Mode -eq "Clear") {
                    Write-Host "-> Folder contents were cleared. Keeping folder in JSON registry." -ForegroundColor Blue
                } else {
                    Write-Host "-> Success! File/Folder completely removed. Deleting entry from JSON." -ForegroundColor Cyan
                    $itemsList.RemoveAt($i)
                }
            }
        }

      # 3. Save the remaining items back to the JSON file
        Write-Host "--------------------------------------------------" -ForegroundColor Gray
        Write-Host "Updating JSON file..." -ForegroundColor Yellow
        , $itemsList | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonPath
        Write-Host "JSON update complete!" -ForegroundColor Green

    } else {
        Write-Host "List.json not found yet. Add items via right-click to begin." -ForegroundColor Gray
    }
    
    exit
}

# ====================================================================
# THE INSTALLER LOGIC (Triggered by the top half of this batch file)
# ====================================================================
if ($InstallMode) {
    $ErrorActionPreference = "Stop"

    try {
        Write-Host "1/2: Applying Context Menu Registry Keys..." -ForegroundColor Cyan
        
        # 1. Define the commands as pure code blocks (FIXED $env:APPDATA concatenation)
        $fileBlock = {
            $p='%1'; $f=$env:APPDATA+'\CustomScripts\TempList\List.json'; [array]$json=if(Test-Path $f){Get-Content $f -Raw|ConvertFrom-Json}else{@()}; $json=$json|Group-Object Path|ForEach-Object{$_.Group[0]}; $ext=$json|Where-Object{$_.Path -eq $p}|Select-Object -First 1; if($ext){Write-Host ('This file is already added with Mode: {0} and Days: {1}' -f $ext.Mode, $ext.Days) -ForegroundColor Cyan; do{$act=Read-Host '[O]verwrite / [R]emove from list / [C]ancel'; $v=$act -in @('o','r','c')}while(-not $v); if($act -eq 'c'){Write-Host 'Cancelled.' -ForegroundColor Red; Read-Host 'Press Enter to close...'; exit}elseif($act -eq 'r'){$json=$json|Where-Object{$_.Path -ne $p}; ConvertTo-Json -InputObject @($json) -Depth 10|Out-File $f -Encoding utf8; Write-Host 'Successfully removed from list!' -ForegroundColor Green; Read-Host 'Press Enter to close...'; exit}}; $m='Remove'; do{$d=Read-Host 'Enter Days'; $v=$d -match '^\d+$' -and [int]$d -ge 0; if(-not $v){Write-Host 'Invalid input. Allowed: Any integer 0 or greater' -ForegroundColor Yellow}}while(-not $v); if($ext){$ext.Mode=$m; $ext.Days=[int]$d}else{$json+=[PSCustomObject]@{Path=$p; Mode=$m; Days=[int]$d}}; ConvertTo-Json -InputObject @($json) -Depth 10|Out-File $f -Encoding utf8;        }

        $folderBlock = {
            $p='%1'; $f=$env:APPDATA+'\CustomScripts\TempList\List.json'; [array]$json=if(Test-Path $f){Get-Content $f -Raw|ConvertFrom-Json}else{@()}; $json=$json|Group-Object Path|ForEach-Object{$_.Group[0]}; $ext=$json|Where-Object{$_.Path -eq $p}|Select-Object -First 1; if($ext){Write-Host ('This folder is already added with Mode: {0} and Days: {1}' -f $ext.Mode, $ext.Days) -ForegroundColor Cyan; do{$act=Read-Host '[O]verwrite / [R]emove from list / [C]ancel'; $v=$act -in @('o','r','c')}while(-not $v); if($act -eq 'c'){Write-Host 'Cancelled.' -ForegroundColor Red; Read-Host 'Press Enter to close...'; exit}elseif($act -eq 'r'){$json=$json|Where-Object{$_.Path -ne $p}; ConvertTo-Json -InputObject @($json) -Depth 10|Out-File $f -Encoding utf8; Write-Host 'Successfully removed from list!' -ForegroundColor Green; Read-Host 'Press Enter to close...'; exit}}; do{$m=Read-Host 'Enter Mode (C for Clear / R for Remove)'; if($m -eq 'c') {$m='Clear'}elseif($m -eq 'r') {$m='Remove'}; $v=$m -in @('Clear','Remove'); if(-not $v){Write-Host 'Invalid input. Allowed: C, R, Clear, Remove' -ForegroundColor Yellow}}while(-not $v); do{$d=Read-Host 'Enter Days'; $v=$d -match '^\d+$' -and [int]$d -ge 0; if(-not $v){Write-Host 'Invalid input. Allowed: Any integer 0 or greater' -ForegroundColor Yellow}}while(-not $v); if($ext){$ext.Mode=$m; $ext.Days=[int]$d}else{$json+=[PSCustomObject]@{Path=$p; Mode=$m; Days=[int]$d}}; ConvertTo-Json -InputObject @($json) -Depth 10|Out-File $f -Encoding utf8;        }

        # 2. Extract the literal, raw text string inside those blocks
        $fileCommand   = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "' + $fileBlock.ToString().Trim("`r`n ") + '"'
        $folderCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "' + $folderBlock.ToString().Trim("`r`n ") + '"'

        # 3. Commit cleanly to Registry using .NET methods
        $fileKey = [Microsoft.Win32.Registry]::ClassesRoot.CreateSubKey('*\shell\MakeTemp2')
        $fileKey.SetValue('', 'Add File to Temp List')
        $fileCmdKey = $fileKey.CreateSubKey('command')
        $fileCmdKey.SetValue('', $fileCommand)

        $folderKey = [Microsoft.Win32.Registry]::ClassesRoot.CreateSubKey('Directory\shell\MakeTemp2')
        $folderKey.SetValue('', 'Add Folder to Temp List')
        $folderCmdKey = $folderKey.CreateSubKey('command')
        $folderCmdKey.SetValue('', $folderCommand)


        Write-Host "2/2: Creating Scheduled Task..." -ForegroundColor Cyan
        $TaskName = "SilentTempListCleanup"
        
        $Action = New-ScheduledTaskAction -Execute "PowerShell.exe" `
            -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -RunCleanup"

        $Trigger = New-ScheduledTaskTrigger -AtLogOn
        $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
        $Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest

        Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null

        Write-Host "`nSuccess!" -ForegroundColor Green
        Write-Host "The PowerShell script was placed in: $PSCommandPath"
        Write-Host "Context menus added, and Task '$TaskName' registered completely invisibly."
    }
    catch {
        Write-Host "`n--- AN ERROR OCCURRED ---" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Yellow
    }
}