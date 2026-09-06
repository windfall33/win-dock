# win-dock native bridge
# Persistent helper process. Speaks NDJSON over stdin/stdout.
# Request : {"id":"n","cmd":"...","args":{...}}
# Response: {"id":"n","ok":true/false,"data":{...}}
#
# P3-F1c 拆分：本文件只保留编码设置 / dot-source / 主循环 + dispatch；
# 逻辑平移到 bridge/ 子模块（types=C# P-Invoke，windows=窗口操作，
# shell=图标与打开，fs=文件操作，taskbar=任务栏集成）。dot-source 共享
# 调用作用域，脚本级函数平移后全局可见，行为不变。

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)

. (Join-Path $PSScriptRoot 'bridge\types.ps1')
. (Join-Path $PSScriptRoot 'bridge\windows.ps1')
. (Join-Path $PSScriptRoot 'bridge\shell.ps1')
. (Join-Path $PSScriptRoot 'bridge\fs.ps1')
. (Join-Path $PSScriptRoot 'bridge\taskbar.ps1')

function Emit($id, $ok, $data) {
    $r = @{ id = $id; ok = $ok }
    if ($null -ne $data) {
        $r.data = $data
        if (-not $ok) {
            if ($data -is [string]) { $r.err = $data }
            elseif ($data.err) { $r.err = [string]$data.err }
            else { $r.err = 'bridge-error' }
        }
    }
    [Console]::Out.WriteLine(($r | ConvertTo-Json -Compress -Depth 6))
}

while ($true) {
    # 父进程已死则自行退出，防孤儿累积
    if ($env:DOCK_PARENT_PID) {
        if (-not (Get-Process -Id ([int]$env:DOCK_PARENT_PID) -ErrorAction SilentlyContinue)) { break }
    }
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line.Length -eq 0) { continue }

    $req = $null
    $cid = ''
    try { $req = $line | ConvertFrom-Json } catch {
        Emit('', $false, @{ err = 'badjson' }); continue
    }
    try { $cid = '' + $req.id } catch { $cid = '' }
    $cmd = '' + $req.cmd
    $argsObj = $req.args

    switch ($cmd) {

        'ping' {
            Emit $cid $true @{ ver = 3 }
        }

        'enum-windows' {
            $excl = [long]0
            try { $excl = [long]$argsObj.excludePid } catch { $excl = [long]0 }
            $out = [NativeOps]::Enumerate([uint32]([Math]::Min([Math]::Max($excl, 0), 4294967295)))
            if ($out -eq '[]' -and [NativeOps]::LastErr) {
                Emit $cid $false @{ err = 'enum: ' + [NativeOps]::LastErr }
            } else {
                [Console]::Out.Write("{""id"":""$cid"",""ok"":true,""data"":")
                [Console]::Out.Write($out)
                [Console]::Out.WriteLine("}")
            }
        }

        'window-rect'   { Invoke-WindowRect $cid $argsObj }
        'window-pid'    { Invoke-WindowPid $cid $argsObj }
        'processes-running' { Invoke-ProcessesRunning $cid $argsObj }

        'foreground' {
            $fg = [NativeOps]::GetForegroundWindow()
            Emit $cid $true @{ h = ('' + $fg.ToInt64()) }
        }

        'dock-occluded' { Invoke-DockOccluded $cid $argsObj }
        'icon'          { Invoke-Icon $cid $argsObj }
        'window-thumb'  { Invoke-WindowThumb $cid $argsObj }
        'window-shot'   { Invoke-WindowShot $cid $argsObj }
        'list-start-menu' { Invoke-ListStartMenu $cid $argsObj }
        'list-dir'      { Invoke-ListDir $cid $argsObj }
        'resolve-shortcut' { Invoke-ResolveShortcut $cid $argsObj }
        'startup-shortcut-state' { Invoke-StartupShortcutState $cid $argsObj }
        'startup-shortcut' { Invoke-StartupShortcut $cid $argsObj }

        'focus' {
            try {
                $h = [IntPtr][long]([double]::Parse([string]$argsObj.h))
                [NativeOps]::ForceActivate($h)
                Emit $cid $true @{}
            } catch { Emit $cid $false @{ err = $_.Exception.Message } }
        }

        'minimize' {
            try {
                $h = [IntPtr][long]([double]::Parse([string]$argsObj.h))
                [void][NativeOps]::ShowWindow($h, 6)
                Emit $cid $true @{}
            } catch { Emit $cid $false @{ err = $_.Exception.Message } }
        }

        'close-window' {
            try {
                $h = [IntPtr][long]([double]::Parse([string]$argsObj.h))
                [void][NativeOps]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
                Emit $cid $true @{}
            } catch { Emit $cid $false @{ err = $_.Exception.Message } }
        }

        'trash-count' {
            Emit $cid $true @{ count = (TrashCount) }
        }

        'taskbar-state'   { Invoke-TaskbarState $cid $argsObj }
        'taskbar-autohide' { Invoke-TaskbarAutohide $cid $argsObj }
        'set-workarea'    { Invoke-SetWorkarea $cid $argsObj }
        'empty-trash'     { Invoke-EmptyTrash $cid $argsObj }
        'recycle'         { Invoke-Recycle $cid $argsObj }
        'move-files'      { Invoke-MoveFiles $cid $argsObj }
        'reveal'          { Invoke-Reveal $cid $argsObj }
        'open'            { Invoke-Open $cid $argsObj }

        default {
            Emit $cid $false @{ err = 'unknown-cmd' + $cmd }
        }
    }
}
