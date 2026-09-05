# mac-dock bridge — 文件系统操作（list-dir / 回收站 / 移动 / 清空 / 计数）
# 由 bridge.ps1 dot-source 加载；函数体自 switch case / 原函数逐行平移（P3-F1c）。

function TrashCount {
    try {
        $sh = New-Object -ComObject Shell.Application
        $ns = $sh.NameSpace(0xA)
        $items = @($ns.Items())
        return $items.Count
    } catch { return -1 }
}

function Invoke-ListDir($cid, $argsObj) {
    try {
        $p = [string]$argsObj.path
        if ([string]::IsNullOrEmpty($p) -or -not [System.IO.Directory]::Exists($p)) {
            throw 'not-a-directory'
        }
        $entries = New-Object System.Collections.Generic.List[object]
        foreach ($f in [System.IO.Directory]::EnumerateFileSystemEntries($p)) {
            try {
                $isDir = [System.IO.Directory]::Exists($f)
                # P1-F5：mtime（添加时间排序）/ ctime（创建时间排序），Unix 毫秒
                $mt = [DateTimeOffset]$([System.IO.Directory]::GetLastWriteTime($f))
                $ct = [DateTimeOffset]$([System.IO.Directory]::GetCreationTime($f))
                $entries.Add(@{
                    name = [System.IO.Path]::GetFileName($f)
                    isFolder = $isDir
                    iconPath = $f
                    mtime = [int64]$mt.ToUnixTimeMilliseconds()
                    ctime = [int64]$ct.ToUnixTimeMilliseconds()
                })
            } catch {}
        }
        Emit $cid $true @{ entries = @($entries | ForEach-Object { $_ }) }
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}

function Invoke-EmptyTrash($cid, $argsObj) {
    try {
        Clear-RecycleBin -Force -ErrorAction SilentlyContinue
        Emit $cid $true @{}
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}

function Invoke-Recycle($cid, $argsObj) {
    Add-Type -AssemblyName Microsoft.VisualBasic | Out-Null
    $failed = @()
    try {
        foreach ($p in @($argsObj.paths)) {
            try {
                if ([System.IO.Directory]::Exists([string]$p)) {
                    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
                        [string]$p,
                        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
                        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
                } elseif ([System.IO.File]::Exists([string]$p)) {
                    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
                        [string]$p,
                        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
                        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
                }
            } catch {
                $failed += [string]$p
            }
        }
        Emit $cid $true @{ failed = @($failed) }
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}

function Invoke-MoveFiles($cid, $argsObj) {
    # 把文件/文件夹移动进目标文件夹（Dock 文件夹 Stack 拖放归置）
    Add-Type -AssemblyName Microsoft.VisualBasic | Out-Null
    $failed = @()
    try {
        $dest = [string]$argsObj.dest
        if (-not [System.IO.Directory]::Exists($dest)) { throw 'not-a-directory' }
        foreach ($p in @($argsObj.paths)) {
            try {
                $name = [System.IO.Path]::GetFileName(([string]$p).TrimEnd('\'))
                if ([System.IO.Directory]::Exists([string]$p)) {
                    [Microsoft.VisualBasic.FileIO.FileSystem]::MoveDirectory(
                        [string]$p, (Join-Path $dest $name),
                        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs)
                } elseif ([System.IO.File]::Exists([string]$p)) {
                    [Microsoft.VisualBasic.FileIO.FileSystem]::MoveFile(
                        [string]$p, (Join-Path $dest $name),
                        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs)
                }
            } catch {
                $failed += [string]$p
            }
        }
        Emit $cid $true @{ failed = @($failed) }
    } catch { Emit $cid $false @{ err = $_.Exception.Message } }
}
