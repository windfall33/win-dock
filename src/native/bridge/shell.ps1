# mac-dock bridge — shell 集成（图标提取 / 快捷方式解析 / 开始菜单扫描 / 打开与显示）
# 由 bridge.ps1 dot-source 加载；图标提取链与 UWP 稳定键在 types.ps1 的 C# 内。

function Invoke-Icon($cid, $argsObj) {
    $p = [string]$argsObj.path
    $b64 = ''
    try { $b64 = [string][NativeOps]::ExtractIconPng($p) } catch { $b64 = '' }
    if ([string]::IsNullOrEmpty($b64)) { Emit $cid $false @{ err = 'noicon' } }
    else { Emit $cid $true @{ png = $b64 } }
}

function Invoke-ListStartMenu($cid, $argsObj) {
    # 枚举公共 + 用户开始菜单 Programs 下全部 .lnk，一次解析返回
    try {
        # 显式构建，避免 @() 多行逗号在 PS 5.1 中的解析歧义
        $dirs = @()
        $dirs += [Environment]::GetFolderPath('CommonStartMenu') + '\Programs'
        $dirs += [Environment]::GetFolderPath('StartMenu') + '\Programs'
        $apps = New-Object System.Collections.Generic.List[object]
        $sh = New-Object -ComObject WScript.Shell
        foreach ($d in $dirs) {
            if ([string]::IsNullOrEmpty($d) -or -not [System.IO.Directory]::Exists($d)) { continue }
            foreach ($f in [System.IO.Directory]::EnumerateFiles($d, '*.lnk', [System.IO.SearchOption]::AllDirectories)) {
                try {
                    $sc = $sh.CreateShortcut($f)
                    $target = [string]$sc.TargetPath
                    if ([string]::IsNullOrEmpty($target)) { continue }
                    $apps.Add(@{
                        name = [System.IO.Path]::GetFileNameWithoutExtension($f)
                        target = $target
                        args = [string]$sc.Arguments
                        iconLocation = [string]$sc.IconLocation
                    })
                } catch {}
            }
        }
        # PS 5.1 ConvertTo-Json 对 @($list)（object[] 内含 hashtable）抛
        # ArgumentException，经管道重建的数组才能正常序列化
        Emit $cid $true @{ apps = @($apps | ForEach-Object { $_ }) }
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}

function Invoke-ResolveShortcut($cid, $argsObj) {
    try {
        $p = [string]$argsObj.path
        $name = [System.IO.Path]::GetFileNameWithoutExtension($p)
        if ([System.IO.File]::Exists($p) -and $p -match '\.lnk$') {
            $sh = New-Object -ComObject WScript.Shell
            $sc = $sh.CreateShortcut($p)
            Emit $cid $true @{
                target = [string]$sc.TargetPath
                name = $name
                iconLocation = [string]$sc.IconLocation
                arguments = [string]$sc.Arguments
            }
        } else {
            Emit $cid $true @{ target = $p; name = $name; iconLocation = ''; arguments = '' }
        }
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}

function Invoke-Reveal($cid, $argsObj) {
    try {
        # 剥离路径中的引号再拼接，防止畸形路径破坏 explorer /select 参数结构
        $rp = ([string]$argsObj.path).Replace('"', '')
        if ([string]::IsNullOrWhiteSpace($rp)) {
            Emit $cid $false @{ err = 'empty path' }
        } else {
            Start-Process explorer.exe -ArgumentList ("/select,`"" + $rp + "`"")
            Emit $cid $true @{}
        }
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}

function Invoke-Open($cid, $argsObj) {
    try {
        $t = [string]$argsObj.target
        $argStr = $null
        $a = @()
        try {
            if ($argsObj.args -is [string]) { $argStr = [string]$argsObj.args }
            else { $a = @($argsObj.args) | ForEach-Object { [string]$_ } }
        } catch { $a = @() }
        if ($t -like 'shell:*') {
            # shell 命名空间（回收站等）用 explorer 打开
            if ($null -ne $argStr -and $argStr.Length -gt 0) { Start-Process explorer.exe -ArgumentList @($t, $argStr) | Out-Null }
            elseif ($a.Count -gt 0) { Start-Process explorer.exe -ArgumentList ($a + @($t)) | Out-Null }
            else { Start-Process explorer.exe -ArgumentList @($t) | Out-Null }
        } else {
            # 真实文件/快捷方式：用系统 ShellExecute 打开，工作目录跟随目标所在文件夹（对齐资源管理器）。
            # .lnk 不覆盖工作目录，让快捷方式内部自带的 WorkingDirectory/RunAs/UWP 注册生效。
            $startArgs = @{ FilePath = $t }
            $tl = [string]$t
            $tl = $tl.ToLower()
            if ($tl -notlike '*.lnk' -and (Test-Path -LiteralPath $t -PathType Leaf)) {
                $startArgs['WorkingDirectory'] = Split-Path -Parent $t
            }
            if ($null -ne $argStr -and $argStr.Length -gt 0) {
                # 快捷方式原始参数字符串原样传给目标程序
                Start-Process @startArgs -ArgumentList $argStr | Out-Null
            } elseif ($a.Count -gt 0) {
                # 数组参数：对含空格/引号元素加引号，避免被目标程序错误拆分
                $argLine = ($a | ForEach-Object {
                    $s = [string]$_
                    if ($s -match '[\s"]') { '"' + ($s -replace '"', '""') + '"' } else { $s }
                }) -join ' '
                Start-Process @startArgs -ArgumentList $argLine | Out-Null
            } else {
                Start-Process @startArgs | Out-Null
            }
        }
        Emit $cid $true @{}
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}
