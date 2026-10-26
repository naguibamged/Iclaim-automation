# Change this file when the sign-in updater needs extra behavior.
# The scheduled task keeps running the AppData updater. That script calls
# this file after every successful version check. Bump manifest.json so the
# work PC downloads the new copy.
#
# -Updated is set only when the extension folder was just replaced.
param(
    [Parameter(Mandatory = $true)]
    [string]$Dest,

    [string]$LocalVersion,

    [string]$RemoteVersion,

    [string]$LogPath,

    [switch]$Updated
)

exit 0
