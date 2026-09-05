# mac-dock native bridge
# Persistent helper process. Speaks NDJSON over stdin/stdout.
# Request : {"id":"n","cmd":"...","args":{...}}
# Response: {"id":"n","ok":true/false,"data":{...}}
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Drawing | Out-Null

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public struct SHFILEINFO {
    public IntPtr hIcon;
    public int iIcon;
    public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
}

public class NativeOps {
    // ---- window enumeration ----
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int val, int size);
    [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    // ---- window activation / state ----
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    // P1-F6 无响应检测：纯内部状态查询（不发消息），对阻塞式桥接主循环安全
    [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hWnd);

    public struct RECT { public int L; public int T; public int R; public int B; }
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    // ---- work area (SPI) ----
    public const uint SPI_GETWORKAREA = 0x0048;
    public const uint SPI_SETWORKAREA = 0x002F;
    public const uint SPIF_UPDATEINIFILE = 0x01;
    public const uint SPIF_SENDCHANGE   = 0x02;
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref RECT pvParam, uint fWinIni);

    public struct PT { public int X; public int Y; }
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out PT pt);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    // ---- UWP AppUserModelId（窗口属性）----
    // UWP 商店应用由 ApplicationFrameHost 宿主，进程名全是同一个，真实身份
    // 挂在窗口属性的 AppUserModelId 上（如 Microsoft.WindowsCalculator_8wekyb3d8bbwe!App）。
    // 它是稳定的 —— 不像窗口标题会随页面切换变化。用 SHGetPropertyStoreForWindow
    // 读 PKEY_AppUserModel_ID，COM 接口手工声明（PowerShell 里没有现成封装）。
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PROPERTYKEY pkey);
        void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        void Commit();
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY { public Guid fmtid; public uint pid; }
    // 只声明本场景用到的头部（vt + 保留 + union 指针），VT_LPWSTR 的值在 ptr 里
    [StructLayout(LayoutKind.Sequential)]
    public struct PROPVARIANT {
        public ushort vt;
        public ushort reserved1;
        public ushort reserved2;
        public ushort reserved3;
        public IntPtr ptr;
    }
    [DllImport("shell32.dll", PreserveSig = true)]
    public static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ppv);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }
    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    // Same-coordinate fullscreen check (GetWindowRect vs GetMonitorInfo, both from this process).
    // IsZoomed filters out maximized windows: when the taskbar is hidden, a maximized
    // window also covers the whole monitor rect, but a true fullscreen window is never zoomed.
    public static bool IsFullScreen(IntPtr h) {
        try {
            if (IsZoomed(h)) return false;
            IntPtr mon = MonitorFromWindow(h, 2);
            if (mon == IntPtr.Zero) return false;
            MONITORINFO mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (!GetMonitorInfo(mon, ref mi)) return false;
            RECT rc;
            GetWindowRect(h, out rc);
            return rc.L <= mi.rcMonitor.L && rc.T <= mi.rcMonitor.T &&
                   rc.R >= mi.rcMonitor.R && rc.B >= mi.rcMonitor.B;
        } catch { return false; }
    }

    // ---- process image path ----
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryFullProcessImageNameW", ExactSpelling = true)]
    public static extern bool QueryFullProcessImageName(IntPtr hProc, uint flags, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder sb, ref uint size);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

    // ---- icon extraction ----
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SHGetFileInfo(string pszPath, uint attr, ref SHFILEINFO sfi, uint cbSize, uint uFlags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int PrivateExtractIcons(string szFileName, int nIconIndex, int cxIcon, int cyIcon,
        IntPtr[] phicon, IntPtr[] piconid, int nIcons, int flags);

    [DllImport("user32.dll")]
    public static extern IntPtr ExtractAssociatedIcon(IntPtr hInst, string lpIconPath, ref int lpiIcon);

    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);

    // ---- shell item icon factory（UWP/别名的 256px 资产通道） ----
    // 注：不用 SHGetImageList(SHIL_JUMBO) 路线 —— 常驻无头进程的 jumbo image list
    // 懒加载为空，GetIcon 对任何索引都返回 E_INVALIDARG（实测 diag-icon4）。
    // IShellItemImageFactory 走 shell item 图标处理器按需合成，不依赖进程内状态。
    [StructLayout(LayoutKind.Sequential)]
    public struct SZSIZE { public int cx; public int cy; public SZSIZE(int w, int h) { cx = w; cy = h; } }

    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItemImageFactory {
        [PreserveSig] int GetHBitmap(SZSIZE size, int flags, out IntPtr phbm);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern int SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr hObject);

    // BITMAP struct（GetObjectW 填充用；bmBits 对 DDB 无意义，不直接寻址）
    [StructLayout(LayoutKind.Sequential)]
    public struct GdiBitmap {
        public int bmType; public int bmWidth; public int bmHeight; public int bmWidthBytes;
        public short bmPlanes; public short bmBitsPixel; public IntPtr bmBits;
    }

    [DllImport("gdi32.dll", EntryPoint = "GetObjectW", CharSet = CharSet.Unicode)]
    public static extern int GetObjectBitmapInfo(IntPtr hb, int cb, ref GdiBitmap bm);

    [StructLayout(LayoutKind.Sequential)]
    public struct BmiHeader {
        public int biSize; public int biWidth; public int biHeight;
        public short biPlanes; public short biBitCount; public int biCompression;
        public int biSizeImage; public int biXPels; public int biYPels; public int biClrUsed; public int biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct BitmapInfoFull {
        public BmiHeader bmiHeader;
        public int bmiColors;
    }

    [DllImport("gdi32.dll")]
    public static extern int GetDIBits(IntPtr hdc, IntPtr hbmp, uint start, uint lines, byte[] bits, ref BitmapInfoFull bmi, uint usage);

    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    const int SIIGBF_BIGGERSIZEOK = 0x1;
    const int SIIGBF_ICONONLY = 0x4;

    // 取 shell item 图标为 GDI+ 位图（默认 256px，alpha 保留）。
    // GetHBitmap 返回预乘 BGRA 的 HBITMAP；用 GetDIBits 拉出字节后逐像素还原预乘，
    // 不能走 Image.FromHbitmap（不识别 alpha，透明底会变黑）。
    public static System.Drawing.Bitmap ShellItemIconBitmap(string path, int size) {
        Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
        IShellItemImageFactory f;
        int hr = SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out f);
        if (hr != 0 || f == null) return null;
        IntPtr hbmp;
        hr = f.GetHBitmap(new SZSIZE(size, size), SIIGBF_BIGGERSIZEOK | SIIGBF_ICONONLY, out hbmp);
        if (hr != 0 || hbmp == IntPtr.Zero) return null;
        try {
            GdiBitmap gb = new GdiBitmap();
            if (GetObjectBitmapInfo(hbmp, Marshal.SizeOf(typeof(GdiBitmap)), ref gb) == 0) return null;
            int w = gb.bmWidth, h = Math.Abs(gb.bmHeight);
            if (w <= 0 || h <= 0) return null;
            IntPtr hdc = GetDC(IntPtr.Zero);
            if (hdc == IntPtr.Zero) return null;
            try {
                BitmapInfoFull bmi = new BitmapInfoFull();
                bmi.bmiHeader.biSize = Marshal.SizeOf(typeof(BmiHeader));
                bmi.bmiHeader.biWidth = w;
                bmi.bmiHeader.biHeight = -h;   // 负高度 = top-down
                bmi.bmiHeader.biPlanes = 1;
                bmi.bmiHeader.biBitCount = 32;
                bmi.bmiHeader.biCompression = 0; // BI_RGB
                byte[] buf = new byte[w * h * 4];
                if (GetDIBits(hdc, hbmp, 0, (uint)h, buf, ref bmi, 0) == 0) return null;
                var bmp = new System.Drawing.Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                var rect = new System.Drawing.Rectangle(0, 0, w, h);
                var bd = bmp.LockBits(rect, System.Drawing.Imaging.ImageLockMode.WriteOnly,
                    System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                try {
                    for (int y = 0; y < h; y++) {
                        int rowOff = y * w * 4;
                        for (int x = 0; x < w; x++) {
                            int b = buf[rowOff + x * 4], g = buf[rowOff + x * 4 + 1];
                            int r = buf[rowOff + x * 4 + 2], a = buf[rowOff + x * 4 + 3];
                            if (a > 0 && a < 255) { // 预乘 → 直通 alpha
                                b = Math.Min(255, b * 255 / a);
                                g = Math.Min(255, g * 255 / a);
                                r = Math.Min(255, r * 255 / a);
                            }
                            Marshal.WriteInt32(bd.Scan0, y * bd.Stride + x * 4,
                                (a << 24) | (r << 16) | (g << 8) | b);
                        }
                    }
                } finally { bmp.UnlockBits(bd); }
                return bmp;
            } finally { ReleaseDC(IntPtr.Zero, hdc); }
        } finally { try { DeleteObject(hbmp); } catch {} }
    }

    const uint SHGFI_SYSICONINDEX = 0x000004000;
    const int SHIL_JUMBO = 0x4;
    const int ILD_TRANSPARENT = 0x00000001;

    [DllImport("shell32.dll")]
    public static extern int SHGetImageList(int iImageList, ref Guid riid, out IntPtr ppv);

    // IImageList 只声明到 GetIcon（vtable 第 7 槽）为止，后续方法用不到不必声明；
    // 槽位对齐只看声明顺序，未调用的方法用 IntPtr 占位保持槽序。
    [ComImport, Guid("46EB5926-582E-4017-9FDF-E8998DAA0950"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IImageList {
        [PreserveSig] int Add(IntPtr hbmImage, IntPtr hbmMask, ref int pi);
        [PreserveSig] int ReplaceIcon(int i, IntPtr hicon, ref int pi);
        [PreserveSig] int SetOverlayImage(int iImage, int iOverlay);
        [PreserveSig] int AddMasked(IntPtr hbmImage, int crMask, ref int pi);
        [PreserveSig] int Draw(IntPtr pimldp);
        [PreserveSig] int Remove(int i);
        [PreserveSig] int GetIcon(int i, int flags, ref IntPtr picon);
    }

    // shell 图像列表 JUMBO（256px）图标：WindowsApps 别名 / UWP / shell 缓存大尺寸资产
    // 的应用，PrivateExtractIcons 直取不到大图标，走这里补齐；失败返回 IntPtr.Zero，
    // 调用方继续原有回退链。
    public static IntPtr GetJumboShellIcon(string path) {
        try {
            SHFILEINFO sfi = new SHFILEINFO();
            IntPtr r = SHGetFileInfo(path, 0, ref sfi, (uint)Marshal.SizeOf(typeof(SHFILEINFO)), SHGFI_SYSICONINDEX);
            if (r == IntPtr.Zero) return IntPtr.Zero;
            Guid iid = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950");
            IntPtr pImgl;
            if (SHGetImageList(SHIL_JUMBO, ref iid, out pImgl) != 0 || pImgl == IntPtr.Zero) return IntPtr.Zero;
            IntPtr hIcon = IntPtr.Zero;
            try {
                IImageList il = (IImageList)Marshal.GetObjectForIUnknown(pImgl);
                il.GetIcon(sfi.iIcon, ILD_TRANSPARENT, ref hIcon);
            } finally {
                Marshal.Release(pImgl);
            }
            return hIcon;
        } catch { return IntPtr.Zero; }
    }

    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint SHGFI_ICON = 0x000000100;
    const uint SHGFI_LARGEICON = 0x000000000;
    const uint SHGFI_SMALLICON = 0x000000001;
    const int GWL_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int DWMWA_CLOAKED = 14;
    const byte VK_MENU = 0x12;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const int SW_RESTORE = 9;
    const int SW_SHOW = 5;
    const int SW_MINIMIZE = 6;

    public static string GetExeForPid(uint pid) {
        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return "";
        try {
            var sb = new StringBuilder(1024);
            uint size = 1024;
            if (QueryFullProcessImageName(h, 0, sb, ref size)) return sb.ToString();
            return "";
        } finally { CloseHandle(h); }
    }

    public static string GetWindowTextSafe(IntPtr h) {
        try {
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            return sb.ToString();
        } catch { return ""; }
    }

    public static string GetClassNameSafe(IntPtr h) {
        try {
            var sb = new StringBuilder(256);
            GetClassName(h, sb, 256);
            return sb.ToString();
        } catch { return ""; }
    }

    // 读窗口的 AppUserModelId（UWP 应用稳定标识）。任何失败返回空串，
    // 调用方（主进程分组）回退到旧的标题前缀方案 —— 本方法绝不抛出。
    public static string GetAppUserModelIdSafe(IntPtr h) {
        try {
            Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); // IPropertyStore
            IPropertyStore store;
            int hr = SHGetPropertyStoreForWindow(h, ref iid, out store);
            if (hr != 0 || store == null) return "";
            var key = new PROPERTYKEY();
            key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); // PKEY_AppUserModel_ID
            key.pid = 5;
            PROPVARIANT pv;
            store.GetValue(ref key, out pv);
            string s = (pv.vt == 31 && pv.ptr != IntPtr.Zero) ? Marshal.PtrToStringUni(pv.ptr) : ""; // 31 = VT_LPWSTR
            if (pv.ptr != IntPtr.Zero) Marshal.FreeCoTaskMem(pv.ptr);
            return s ?? "";
        } catch { return ""; }
    }

    // UWP frame 窗口的直接 child 是真实 UWP 进程的 CoreWindow —— 从它拿真实
    // 进程 pid（如 SystemSettings.exe），比 AUMID 更直接稳定。找不到返回 0。
    public static uint GetUwpAppPidSafe(IntPtr frameHwnd) {
        try {
            IntPtr cw = FindWindowEx(frameHwnd, IntPtr.Zero, "Windows.UI.Core.CoreWindow", null);
            if (cw == IntPtr.Zero) return 0;
            uint pid = 0;
            GetWindowThreadProcessId(cw, out pid);
            return pid;
        } catch { return 0; }
    }

    // UWP 稳定键缓存：enum-windows 每 1.4s 全量跑一次，对同一 frame hwnd 反复做
    // FindWindowEx + COM 取值会累积成桥接单线程队列的偶发拥堵（dock-occluded 超时）。
    // 同一 hwnd 的稳定键不会变 —— 查一次缓存复用；超 256 条整体清空（窗口数量级远小于此）。
    private static readonly System.Collections.Generic.Dictionary<long, string> _uwpIdCache =
        new System.Collections.Generic.Dictionary<long, string>();
    private static readonly object _uwpIdLock = new object();

    public static string GetUwpStableIdSafe(IntPtr frameHwnd) {
        long k = frameHwnd.ToInt64();
        lock (_uwpIdLock) {
            string cached;
            if (_uwpIdCache.TryGetValue(k, out cached)) return cached;
        }
        string id = "";
        try {
            uint appPid = GetUwpAppPidSafe(frameHwnd);
            if (appPid != 0) id = GetExeForPid(appPid);
            if (String.IsNullOrEmpty(id)) id = GetAppUserModelIdSafe(frameHwnd);
        } catch { id = ""; }
        lock (_uwpIdLock) {
            if (_uwpIdCache.Count > 256) _uwpIdCache.Clear();
            _uwpIdCache[k] = id;
        }
        return id;
    }

    public static string LastErr = "";
    private static EnumProc _cb;

    public static object Enumerate(uint excludePid) {
        LastErr = "";
        var list = new StringBuilder();
        list.Append('[');
        bool[] firstFlag = new bool[1];
        firstFlag[0] = true;
        _cb = new EnumProc(delegate(IntPtr h, IntPtr lp) {
            try {
                if (!IsWindowVisible(h)) return true;
                int cloaked;
                DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, sizeof(int));
                if (cloaked != 0) return true;

                var cls = new StringBuilder(256);
                GetClassName(h, cls, 256);
                string c = cls.ToString();
                if (c == "Windows.UI.Core.CoreWindow" || c == "Shell_TrayWnd" ||
                    c == "Progman" || c == "WorkerW" || c == "Shell_SecondaryTrayWnd" ||
                    c == "XamlExplorerHostIslandWindow") return true;

                var ex = GetWindowLong(h, GWL_EXSTYLE);
                if ((ex & WS_EX_TOOLWINDOW) != 0) return true;

                var titleSb = new StringBuilder(512);
                GetWindowText(h, titleSb, 512);
                string title = titleSb.ToString();
                if (String.IsNullOrWhiteSpace(title)) return true;
                if (c.StartsWith("tooltips_class")) return true;

                uint pid = 0;
                GetWindowThreadProcessId(h, out pid);
                if (excludePid != 0 && pid == excludePid) return true;

                string exe = GetExeForPid(pid);

                // UWP 宿主窗口才做取值（普通窗口零开销），稳定键随 "a" 字段输出：
                // ① frame 的 child CoreWindow 属于真实 UWP 进程 —— 直接用它的进程名；
                // ② 退回窗口属性 AppUserModelId；③ 都取不到为空串，主进程分组回退
                // 旧的标题前缀方案。走 hwnd 缓存（GetUwpStableIdSafe），每窗口只查一次。
                string appId = "";
                if (exe.EndsWith("applicationframehost.exe", StringComparison.OrdinalIgnoreCase)) {
                    appId = GetUwpStableIdSafe(h);
                }

                if (!firstFlag[0]) list.Append(',');
                firstFlag[0] = false;

                list.Append("{\"h\":\"");
                list.Append(h.ToInt64().ToString());
                list.Append("\",\"t\":");
                list.Append(JsonStr(title));
                list.Append(",\"c\":");
                list.Append(JsonStr(c));
                list.Append(",\"p\":\"");
                list.Append(pid.ToString());
                list.Append("\",\"e\":");
                list.Append(JsonStr(exe));
                list.Append(",\"a\":");
                list.Append(JsonStr(appId));
                list.Append(",\"m\":");
                list.Append(IsIconic(h) ? "true" : "false");
                list.Append(",\"f\":");
                list.Append((GetForegroundWindow() == h) ? "true" : "false");
                // P1-F6 无响应标记：仅可见应用主窗口走到这里（工具窗口/不可见已被上方过滤）
                list.Append(",\"hung\":");
                list.Append(IsHungAppWindow(h) ? "true" : "false");

                RECT rc;
                GetWindowRect(h, out rc);
                list.Append(",\"rect\":{\"x\":");
                list.Append(rc.L);
                list.Append(",\"y\":");
                list.Append(rc.T);
                list.Append(",\"w\":");
                list.Append(rc.R - rc.L);
                list.Append(",\"h\":");
                list.Append(rc.B - rc.T);
                list.Append("}");
                list.Append(",\"fs\":");
                list.Append(IsFullScreen(h) ? "true" : "false");
                list.Append("}");
            } catch (Exception ex) {
                LastErr = ex.Message;
            }
            return true;
        });
        EnumWindows(_cb, IntPtr.Zero);
        list.Append(']');
        return list.ToString();
    }

    public static string JsonStr(string s) {
        if (s == null) s = "";
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char ch in s) {
            switch (ch) {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < 32) sb.AppendFormat("\\u{0:x4}", (int)ch);
                    else sb.Append(ch);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    public static void ForceActivate(IntPtr h) {
        try {
            keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
            SetForegroundWindow(h);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        } catch {}
        try {
            IntPtr fg = GetForegroundWindow();
            uint fgPid = 0;
            uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
            uint myThread = (uint)GetCurrentThreadId();
            bool attached = false;
            if (fgThread != 0 && fgThread != myThread) {
                attached = AttachThreadInput(myThread, fgThread, true);
            }
            ShowWindow(h, SW_SHOW);
            if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
            BringWindowToTop(h);
            SetForegroundWindow(h);
            if (attached) AttachThreadInput(myThread, fgThread, false);
        } catch {}
    }

    // Returns base64 PNG of the largest available icon for the file, or ""
    public static object ExtractIconPng(string path) {
        // 支持 "文件路径,索引" 形式（快捷方式 IconLocation），逗号后为图标索引
        int iconIndex = 0;
        int comma = path.LastIndexOf(',');
        if (comma > 0) {
            string suffix = path.Substring(comma + 1).Trim();
            int n;
            if (int.TryParse(suffix, out n) && n >= 0) {
                iconIndex = n;
                path = path.Substring(0, comma);
            }
        }
        IntPtr[] bestIcons = null;
        int count = 0;
        int[] sizes = new int[] { 256, 128, 96, 48 };
        foreach (int sz in sizes) {
            IntPtr[] icons = new IntPtr[1];
            IntPtr[] ids = new IntPtr[1];
            int n = PrivateExtractIcons(path, iconIndex, sz, sz, icons, ids, 1, 0);
            if (n > 0 && icons[0] != IntPtr.Zero) {
                bestIcons = icons; count = 1; break;
            }
        }
        // 回退 ①：shell item 图标工厂（UWP/别名的 256px 正规通道；位图已按请求尺寸合成）
        if (bestIcons == null) {
            System.Drawing.Bitmap fb = ShellItemIconBitmap(path, 256);
            if (fb != null) {
                using (var ms = new System.IO.MemoryStream()) {
                    fb.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                    fb.Dispose();
                    return Convert.ToBase64String(ms.ToArray());
                }
            }
        }
        // 回退 ②：SHGetFileInfo 走 shell 关联图标（无内嵌图标资源的 exe 也能拿到，仅 32px）
        if (bestIcons == null) {
            SHFILEINFO sfi = new SHFILEINFO();
            IntPtr r = SHGetFileInfo(path, 0, ref sfi, (uint)Marshal.SizeOf(typeof(SHFILEINFO)), SHGFI_ICON | SHGFI_LARGEICON);
            if (r != IntPtr.Zero && sfi.hIcon != IntPtr.Zero) {
                bestIcons = new IntPtr[1]; bestIcons[0] = sfi.hIcon; count = 1;
            }
        }
        if (bestIcons == null && (path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))) {
            int idx = 0;
            IntPtr h = ExtractAssociatedIcon(IntPtr.Zero, path, ref idx);
            if (h != IntPtr.Zero) {
                bestIcons = new IntPtr[1]; bestIcons[0] = h; count = 1;
            }
        }
        if (bestIcons == null || count == 0) return "";

        using (System.Drawing.Icon icon = System.Drawing.Icon.FromHandle(bestIcons[0])) {
            using (var bmp = icon.ToBitmap()) {
                // pad to square, transparent
                int side = Math.Max(bmp.Width, bmp.Height);
                using (var square = new System.Drawing.Bitmap(side, side, System.Drawing.Imaging.PixelFormat.Format32bppArgb)) {
                    using (var g = System.Drawing.Graphics.FromImage(square)) {
                        g.Clear(System.Drawing.Color.Transparent);
                        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                        g.DrawImage(bmp, (side - bmp.Width) / 2, (side - bmp.Height) / 2, bmp.Width, bmp.Height);
                    }
                    using (var ms = new System.IO.MemoryStream()) {
                        square.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                        return Convert.ToBase64String(ms.ToArray());
                    }
                }
            }
        }
    }
}
"@ -ReferencedAssemblies System.Drawing | Out-Null

function Test-Target ($p) { [bool]$p }

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

function TrashCount {
    try {
        $sh = New-Object -ComObject Shell.Application
        $ns = $sh.NameSpace(0xA)
        $items = @($ns.Items())
        return $items.Count
    } catch { return -1 }
}

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

$script:lastFgHwnd = [IntPtr]::Zero
$script:lastFgInfo = @{ e = ''; t = ''; c = ''; h = '' }

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

        'window-rect' {
            try {
                $h = [IntPtr][long]([double]::Parse([string]$argsObj.h))
                $rc = New-Object NativeOps+RECT
                [void][NativeOps]::GetWindowRect($h, [ref]$rc)
                Emit $cid $true @{ x = $rc.L; y = $rc.T; w = ($rc.R - $rc.L); h = ($rc.B - $rc.T) }
            } catch { Emit $cid $false @{ err = $_.Exception.Message } }
        }

        'window-pid' {
            try {
                $h = [IntPtr][long]([double]::Parse([string]$argsObj.h))
                $wpid = [uint32]0
                [void][NativeOps]::GetWindowThreadProcessId($h, [ref]$wpid)
                Emit $cid $true @{ pid = $wpid }
            } catch { Emit $cid $false @{ err = $_.Exception.Message } }
        }

        'processes-running' {
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

        'foreground' {
            $fg = [NativeOps]::GetForegroundWindow()
            Emit $cid $true @{ h = ('' + $fg.ToInt64()) }
        }

        'dock-occluded' {
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

        'icon' {
            $p = [string]$argsObj.path
            $b64 = ''
            try { $b64 = [string][NativeOps]::ExtractIconPng($p) } catch { $b64 = '' }
            if ([string]::IsNullOrEmpty($b64)) { Emit $cid $false @{ err = 'noicon' } }
            else { Emit $cid $true @{ png = $b64 } }
        }

        'window-thumb' {
            # 窗口缩略图（悬停预览面板用）：等比缩到宽<=320 的 PNG
            try {
                $r = Get-WindowCapture ([string]$argsObj.h) 320.0
                Emit $cid $true $r
            } catch { Emit $cid $false @{ err = $_.Exception.Message } }
        }

        'window-shot' {
            # 与 window-thumb 同源，但保留到宽<=900，供 genie 最小化动画使用
            try {
                $r = Get-WindowCapture ([string]$argsObj.h) 900.0
                Emit $cid $true $r
            } catch { Emit $cid $false @{ err = $_.Exception.Message } }
        }

        'list-start-menu' {
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

        'list-dir' {
            try {
                $p = [string]$argsObj.path
                if ([string]::IsNullOrEmpty($p) -or -not [System.IO.Directory]::Exists($p)) {
                    throw 'not-a-directory'
                }
                $entries = New-Object System.Collections.Generic.List[object]
                foreach ($f in [System.IO.Directory]::EnumerateFileSystemEntries($p)) {
                    try {
                        $isDir = [System.IO.Directory]::Exists($f)
                        $entries.Add(@{
                            name = [System.IO.Path]::GetFileName($f)
                            isFolder = $isDir
                            iconPath = $f
                        })
                    } catch {}
                }
                Emit $cid $true @{ entries = @($entries | ForEach-Object { $_ }) }
            } catch { Emit $cid $false @{ err = $_.Exception.Message } }
        }

        'resolve-shortcut' {
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

        'taskbar-state' {
            $blob = Get-TaskbarSettingsBlob
            if ($null -eq $blob) { Emit $cid $true @{ exists = $false; autohide = $false } }
            else { Emit $cid $true @{ exists = $true; autohide = (($blob[8] -band 0x02) -ne 0) } }
        }

        'taskbar-autohide' {
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

        'empty-trash' {
            try {
                Clear-RecycleBin -Force -ErrorAction SilentlyContinue
                Emit $cid $true @{}
            } catch { Emit $cid $false @{ err = $_.Exception.Message } }
        }

        'recycle' {
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

        'move-files' {
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

        'set-workarea' {
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

        'reveal' {
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

        'open' {
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

        default {
            Emit $cid $false @{ err = 'unknown-cmd' + $cmd }
        }
    }
}
