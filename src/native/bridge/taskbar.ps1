# mac-dock bridge — 任务栏集成（注册表状态 / 自动隐藏切换 / 工作区预留）
# 由 bridge.ps1 dot-source 加载；函数体自 switch case / 原函数逐行平移（P3-F1c）。

function Get-TaskbarSettingsBlob {
    try {
        $v = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StuckRects3' -Name Settings -ErrorAction Stop
        return [byte[]]$v.Settings
    } catch { return $null }
}

function Restart-Explorer {
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) {
        Start-Process explorer.exe | Out-Null
    }
}

function Invoke-TaskbarState($cid, $argsObj) {
    $blob = Get-TaskbarSettingsBlob
    if ($null -eq $blob) { Emit $cid $true @{ exists = $false; autohide = $false } }
    else { Emit $cid $true @{ exists = $true; autohide = (($blob[8] -band 0x02) -ne 0) } }
}

function Invoke-TaskbarAutohide($cid, $argsObj) {
    try {
        $on = [bool]$argsObj.on
        $backup = [string]$argsObj.backup
        $path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StuckRects3'
        $blob = Get-TaskbarSettingsBlob
        if ($null -eq $blob) { throw 'taskbar settings blob not found' }
        if ($on) {
            if (($blob[8] -band 0x02) -ne 0) {
                # 已处于自动隐藏：不重写注册表、不重启 explorer；
                # 返回原有备份（无则用当前 blob），避免覆盖原始还原点
                $keep = $backup
                if ([string]::IsNullOrEmpty($keep)) { $keep = [Convert]::ToBase64String($blob) }
                Emit $cid $true @{ backup = $keep }
            } else {
                $original = [Convert]::ToBase64String($blob)
                $blob[8] = $blob[8] -bor 0x02
                New-ItemProperty -Path $path -Name Settings -Value $blob -PropertyType Binary -Force | Out-Null
                Restart-Explorer
                Emit $cid $true @{ backup = $original }
            }
        } else {
            if (-not [string]::IsNullOrEmpty($backup)) {
                $restored = [Convert]::FromBase64String($backup)
                New-ItemProperty -Path $path -Name Settings -Value $restored -PropertyType Binary -Force | Out-Null
            } else {
                $blob[8] = $blob[8] -band (-bnot 0x02)
                New-ItemProperty -Path $path -Name Settings -Value $blob -PropertyType Binary -Force | Out-Null
            }
            Restart-Explorer
            Emit $cid $true @{ restored = $true }
        }
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}

function Invoke-SetWorkarea($cid, $argsObj) {
    # 工作区预留：把 Dock 条占据的边缘从桌面工作区中扣除（SPI_SETWORKAREA），
    # 让最大化窗口不再压住 Dock。orig 未传时先 GET 当前值。
    # 注意：SPI 工作区仅对主显示器生效；DPI-unaware 进程中 RECT 为 DIP 域。
    try {
        $wa = New-Object NativeOps+RECT
        if ($argsObj.orig) {
            $wa.L = [int]$argsObj.orig.l; $wa.T = [int]$argsObj.orig.t
            $wa.R = [int]$argsObj.orig.r; $wa.B = [int]$argsObj.orig.b
        } else {
            [NativeOps]::SystemParametersInfo([NativeOps]::SPI_GETWORKAREA, 0, [ref]$wa, 0) | Out-Null
        }
        if ($argsObj.reserve) {
            $bar = [int]$argsObj.barSize
            switch ([string]$argsObj.edge) {
                'left'  { $wa.L += $bar }
                'right' { $wa.R -= $bar }
                default { $wa.B -= $bar }
            }
        }
        $flags = [NativeOps]::SPIF_UPDATEINIFILE -bor [NativeOps]::SPIF_SENDCHANGE
        $ok = [NativeOps]::SystemParametersInfo([NativeOps]::SPI_SETWORKAREA, 0, [ref]$wa, $flags)
        Emit $cid $true @{ ok = [bool]$ok; wa = @{ l = $wa.L; t = $wa.T; r = $wa.R; b = $wa.B } }
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}
