# win-dock bridge — 窗口操作（窗口枚举辅助/前台/截图/hung 由 types.ps1 的 C# 承担）
# 由 bridge.ps1 dot-source 加载；函数体自 switch case / 原函数逐行平移（P3-F1c）。

function Test-Target ($p) { [bool]$p }

# PrintWindow 对 GPU 加速窗口、UWP、DRM 保护内容抓不到画面，会返回全黑或全白的位图。
# 直接呈现就是「一个黑窗」，比没有缩略图更糟。这里采样网格判断画面是否为空：
# 亮度极低或极高、且几乎没有明暗变化 => 视为空画面，交给调用方降级。
# 有文字的深色窗口（黑底终端）明暗变化大，方差大，不会被误判。
function Test-BlankCapture {
    param([System.Drawing.Bitmap]$Bmp)

    try {
        $w = $Bmp.Width; $h = $Bmp.Height
        if ($w -le 0 -or $h -le 0) { return $true }

        $pf = $Bmp.PixelFormat
        if ($pf -eq [System.Drawing.Imaging.PixelFormat]::Format24bppRgb) { $bpp = 3 }
        elseif ($pf -eq [System.Drawing.Imaging.PixelFormat]::Format32bppRgb -or
                $pf -eq [System.Drawing.Imaging.PixelFormat]::Format32bppArgb -or
                $pf -eq [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb) { $bpp = 4 }
        else { return $false }  # 不认识的格式不拦截，宁可放行原图

        $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
        $data = $Bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $pf)
        $bytes = $null
        try {
            $stride = [Math]::Abs($data.Stride)
            $bytes = New-Object byte[] ($stride * $h)
            [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
        } finally {
            $Bmp.UnlockBits($data)
        }
        if ($null -eq $bytes) { return $false }

        # 采样上限约 1600 个点：足够稳定，又不至于拖慢 genie 动画的取图
        $side = [Math]::Sqrt(1600.0)
        $stepX = [Math]::Max(1, [int][Math]::Floor($w / $side))
        $stepY = [Math]::Max(1, [int][Math]::Floor($h / $side))
        $sum = 0.0; $sumSq = 0.0; $n = 0
        for ($y = 0; $y -lt $h; $y += $stepY) {
            $rowOff = $y * $stride
            for ($x = 0; $x -lt $w; $x += $stepX) {
                $i = $rowOff + $x * $bpp
                if ($i + 2 -ge $bytes.Length) { continue }
                # 24/32bpp 内存布局均为 B,G,R(,A)
                $l = 0.2126 * [double]$bytes[$i + 2] +
                     0.7152 * [double]$bytes[$i + 1] +
                     0.0722 * [double]$bytes[$i]
                $sum += $l; $sumSq += $l * $l; $n++
            }
        }
        if ($n -lt 8) { return $true }

        $avg = $sum / $n
        $var = ($sumSq / $n) - ($avg * $avg)
        if ($var -lt 0) { $var = 0 }
        if ($avg -lt 10 -and $var -lt 25) { return $true }    # 全黑
        if ($avg -gt 248 -and $var -lt 25) { return $true }   # 全白
        return $false
    } catch {
        return $false  # 判定过程出错时放行原图，不因检测逻辑误伤正常截图
    }
}

# window-thumb / window-shot 共用：PrintWindow(PW_RENDERFULLCONTENT) 抓窗口内容，
# 等比缩到宽 <= MaxWidth 的 PNG。抓到空画面时抛 'blank-capture'，由调用方降级，
# 不把黑窗直接呈现给用户。失败一律抛异常，返回值为 @{ png; w; h }。
function Get-WindowCapture {
    param([string]$HwndStr, [double]$MaxWidth)

    $h = [IntPtr][long]([double]::Parse($HwndStr))
    $rc = New-Object NativeOps+RECT
    [void][NativeOps]::GetWindowRect($h, [ref]$rc)
    $w = $rc.R - $rc.L; $ht = $rc.B - $rc.T
    if ($w -le 0 -or $ht -le 0 -or $w -gt 10000 -or $ht -gt 10000) { throw 'bad-rect' }

    $bmp = New-Object System.Drawing.Bitmap($w, $ht)
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $ok = $false
        try {
            $hdc = $g.GetHdc()
            $ok = [NativeOps]::PrintWindow($h, $hdc, 2)
            $g.ReleaseHdc($hdc)
        } finally {
            $g.Dispose()
        }
        if (-not $ok) { throw 'printwindow-failed' }

        $scale = [Math]::Min(1.0, $MaxWidth / [double]$w)
        $tw = [int][Math]::Max(1, [Math]::Round($w * $scale))
        $th = [int][Math]::Max(1, [Math]::Round($ht * $scale))

        $out = New-Object System.Drawing.Bitmap($tw, $th)
        try {
            $g2 = [System.Drawing.Graphics]::FromImage($out)
            try {
                $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $g2.DrawImage($bmp, 0, 0, $tw, $th)
            } finally {
                $g2.Dispose()
            }
            if (Test-BlankCapture $out) { throw 'blank-capture' }

            $ms = New-Object System.IO.MemoryStream
            try {
                $out.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
                $b64 = [Convert]::ToBase64String($ms.ToArray())
            } finally {
                $ms.Dispose()
            }
        } finally {
            $out.Dispose()
        }
    } finally {
        $bmp.Dispose()
    }

    if ($b64.Length -lt 100) { throw 'empty-capture' }
    return @{ png = $b64; w = $tw; h = $th }
}

function Invoke-WindowRect($cid, $argsObj) {
    try {
        $h = [IntPtr][long]([double]::Parse([string]$argsObj.h))
        $rc = New-Object NativeOps+RECT
        [void][NativeOps]::GetWindowRect($h, [ref]$rc)
        Emit $cid $true @{ x = $rc.L; y = $rc.T; w = ($rc.R - $rc.L); h = ($rc.B - $rc.T) }
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}

function Invoke-WindowPid($cid, $argsObj) {
    try {
        $h = [IntPtr][long]([double]::Parse([string]$argsObj.h))
        $wpid = [uint32]0
        [void][NativeOps]::GetWindowThreadProcessId($h, [ref]$wpid)
        Emit $cid $true @{ pid = $wpid }
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}

function Invoke-ProcessesRunning($cid, $argsObj) {
    # 修正「运行中」判定：托盘/后台应用可能没有可见窗口但仍属运行中。
    try {
        $in = @($argsObj.names)
        $out = @{}
        foreach ($n in $in) {
            $nm = [string]$n
            if (-not $nm) { continue }
            $bn = ($nm -replace '\\', '/') -split '/' | Select-Object -Last 1
            $bn = $bn -replace '\.exe$', ''
            $out[$nm] = [bool](Get-Process -Name $bn -ErrorAction SilentlyContinue)
        }
        Emit $cid $true @{ running = $out }
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}

function Invoke-WindowThumb($cid, $argsObj) {
    # 窗口缩略图（悬停预览面板用）：等比缩到宽<=320 的 PNG
    try {
        $r = Get-WindowCapture ([string]$argsObj.h) 320.0
        Emit $cid $true $r
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}

function Invoke-WindowShot($cid, $argsObj) {
    # 与 window-thumb 同源，但保留到宽<=900，供 genie 最小化动画使用
    try {
        $r = Get-WindowCapture ([string]$argsObj.h) 900.0
        Emit $cid $true $r
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}

# 前台窗口信息缓存（dock-occluded 用）；$script: 作用域经 dot-source 归主文件
$script:lastFgHwnd = [IntPtr]::Zero
$script:lastFgInfo = @{ e = ''; t = ''; c = ''; h = '' }

function Invoke-DockOccluded($cid, $argsObj) {
    # 前台窗口矩形是否完全覆盖 Dock 窗口矩形（物理坐标，纯 Win32 比较，规避 DPI 换算误差）
    # 顺带返回前台窗口的 exe/标题，供主进程做「最近使用」跟踪
    try {
        $dockH = [IntPtr][long]([double]::Parse([string]$argsObj.hwnd))
        $fg = [NativeOps]::GetForegroundWindow()
        $covered = $false
        $full = $false
        $fgInfo = $script:lastFgInfo
        # 全局光标位置 + Dock 物理矩形：主进程据此兜底判定指针是否真的还在 Dock 上
        # （透明窗口在穿透切换瞬间可能收不到 mouseleave，渲染层会卡在放大态）
        $cursor = @{ x = -1; y = -1 }
        $cpt = New-Object NativeOps+PT
        if ([NativeOps]::GetCursorPos([ref]$cpt)) { $cursor = @{ x = $cpt.X; y = $cpt.Y } }
        $drc = New-Object NativeOps+RECT
        [void][NativeOps]::GetWindowRect($dockH, [ref]$drc)
        $dockRect = @{ l = $drc.L; t = $drc.T; r = $drc.R; b = $drc.B }
        if ($fg -ne [IntPtr]::Zero -and $fg -ne $dockH -and
            [NativeOps]::IsWindowVisible($fg) -and -not [NativeOps]::IsIconic($fg)) {
            $rc = New-Object NativeOps+RECT
            $fr = New-Object NativeOps+RECT
            [void][NativeOps]::GetWindowRect($dockH, [ref]$rc)
            [void][NativeOps]::GetWindowRect($fg, [ref]$fr)
            if ($argsObj.bar) {
                $bl = [double]$argsObj.bar.l; $bt = [double]$argsObj.bar.t
                $br = [double]$argsObj.bar.r; $bb = [double]$argsObj.bar.b
                $ixL = [Math]::Max($bl, [double]$fr.L); $ixR = [Math]::Min($br, [double]$fr.R)
                $ixT = [Math]::Max($bt, [double]$fr.T); $ixB = [Math]::Min($bb, [double]$fr.B)
                $iw = $ixR - $ixL; $ih = $ixB - $ixT
                $covered = ($iw -gt 0) -and ($ih -gt 0)
            } else {
                $covered = ($fr.L -le $rc.L) -and ($fr.T -le $rc.T) -and
                            ($fr.R -ge $rc.R) -and ($fr.B -ge $rc.B)
            }
            # 真全屏（窗口铺满所在显示器且非最大化）：macOS 全屏应用让位的判据
            try { $full = [NativeOps]::IsFullScreen($fg) } catch { $full = $false }
            $winPid = [uint32]0
            [void][NativeOps]::GetWindowThreadProcessId($fg, [ref]$winPid)
            if ($fg -eq $script:lastFgHwnd -and $script:lastFgHwnd -ne [IntPtr]::Zero) {
                $fgInfo = $script:lastFgInfo
            } else {
                $fgInfo = @{
                    e = [string][NativeOps]::GetExeForPid($winPid)
                    t = [string][NativeOps]::GetWindowTextSafe($fg)
                    c = [string][NativeOps]::GetClassNameSafe($fg)
                    h = [string]$fg.ToInt64()
                }
                $script:lastFgHwnd = $fg
                $script:lastFgInfo = $fgInfo
            }
        }
        Emit $cid $true @{ covered = $covered; full = $full; fg = $fgInfo; cursor = $cursor; dockRect = $dockRect }
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}
