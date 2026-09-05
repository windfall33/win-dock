# diag-icon.ps1 - verify icon extraction sizes (ASCII only)
# Loads the NativeOps Add-Type block from bridge.ps1 verbatim, then probes
# ExtractIconPng on sample paths and reports decoded PNG dimensions.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing | Out-Null

$bridge = Join-Path $PSScriptRoot '..\src\native\bridge.ps1'
$src = Get-Content -Raw $bridge
$startMark = 'Add-Type -TypeDefinition'
$endMark = '"@ -ReferencedAssemblies System.Drawing | Out-Null'
$start = $src.IndexOf($startMark)
$end = $src.IndexOf($endMark)
if ($start -lt 0 -or $end -lt 0) { throw 'Add-Type block not found' }
$block = $src.Substring($start, $end - $start + $endMark.Length)
Invoke-Expression $block

$aliases = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps') -Filter *.exe -ErrorAction SilentlyContinue |
    Select-Object -First 2 -ExpandProperty FullName

$paths = @('C:\Windows\System32\notepad.exe') + @($aliases)
foreach ($p in $paths) {
    $b64 = ''
    try { $b64 = [string][NativeOps]::ExtractIconPng($p) } catch { $b64 = '' }
    if ([string]::IsNullOrEmpty($b64)) {
        Write-Output ("EMPTY`t" + $p)
        continue
    }
    $bytes = [Convert]::FromBase64String($b64)
    $ms = New-Object System.IO.MemoryStream (, $bytes)
    $img = [System.Drawing.Image]::FromStream($ms)
    Write-Output ($img.Width.ToString() + 'x' + $img.Height.ToString() + "`t" + $p)
    $img.Dispose()
    $ms.Dispose()
}
