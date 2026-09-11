# win-dock native bridge
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
        // 512 优先：大倍率鱼眼（iconSize 128 × 1.8 ≈ 230）时 256 仍会发虚；
        // 资源里没有 512 时 PrivateExtractIcons 会自行落到下一档，不会失败。
        int[] sizes = new int[] { 512, 256, 128, 96, 48 };
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
            System.Drawing.Bitmap fb = ShellItemIconBitmap(path, 512);
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

    // ---- Mission Control：唤起 Windows 任务视图（Win+Tab 等价）----
    const byte VK_LWIN_MC = 0x5B;
    const byte VK_TAB_MC = 0x09;
    public static void OpenTaskView() {
        try {
            keybd_event(VK_LWIN_MC, 0, 0, UIntPtr.Zero);
            keybd_event(VK_TAB_MC, 0, 0, UIntPtr.Zero);
            System.Threading.Thread.Sleep(40);
            keybd_event(VK_TAB_MC, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            keybd_event(VK_LWIN_MC, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        } catch {}
    }

    // 把窗口移到指定显示器工作区中央偏下（分配到显示器）
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int X, int Y, int cx, int cy, uint uFlags);
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_SHOWWINDOW = 0x0040;
    public static bool MoveWindowToRect(IntPtr h, int x, int y, int w, int hgt) {
        try { return SetWindowPos(h, IntPtr.Zero, x, y, w, hgt, SWP_NOZORDER | SWP_SHOWWINDOW); }
        catch { return false; }
    }

    // ---- WinEvent：窗口创建/销毁/前台变化，事件驱动主进程尽快刷新 ----
    public static readonly object OutLock = new object();
    public delegate void WinEventProc(IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
        int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);
    [DllImport("user32.dll")]
    public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc,
        WinEventProc lpfnWinEventProc, uint idProcess, uint idThread, uint flags);
    [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hWinEventHook);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG lpMsg);
    public struct MSG {
        public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
        public uint time; public int pt_x; public int pt_y;
    }
    const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    const uint EVENT_OBJECT_CREATE = 0x8000;
    const uint EVENT_OBJECT_DESTROY = 0x8001;
    const uint EVENT_OBJECT_SHOW = 0x8002;
    const uint EVENT_OBJECT_HIDE = 0x8003;
    static WinEventProc _winEventProc; // 防 GC
    static bool _winEventsStarted;

    public static void StartWinEvents() {
        if (_winEventsStarted) return;
        _winEventsStarted = true;
        _winEventProc = (hook, eventType, hwnd, idObject, idChild, thread, time) => {
            // 仅顶层窗口（OBJID_WINDOW=0）
            if (idObject != 0 || hwnd == IntPtr.Zero) return;
            int kind = 0;
            if (eventType == EVENT_SYSTEM_FOREGROUND) kind = 1;
            else if (eventType == EVENT_OBJECT_CREATE) kind = 2;
            else if (eventType == EVENT_OBJECT_DESTROY) kind = 3;
            else if (eventType == EVENT_OBJECT_SHOW) kind = 4;
            else if (eventType == EVENT_OBJECT_HIDE) kind = 5;
            else return;
            string line = "{\"type\":\"win-event\",\"event\":" + kind + ",\"h\":\"" + hwnd.ToInt64() + "\"}";
            lock (OutLock) {
                try { Console.WriteLine(line); } catch {}
            }
        };
        var t = new System.Threading.Thread(() => {
            SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
                IntPtr.Zero, _winEventProc, 0, 0, WINEVENT_OUTOFCONTEXT);
            SetWinEventHook(EVENT_OBJECT_CREATE, EVENT_OBJECT_HIDE,
                IntPtr.Zero, _winEventProc, 0, 0, WINEVENT_OUTOFCONTEXT);
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) != 0) {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
        });
        t.IsBackground = true;
        t.Start();
    }
}
"@ -ReferencedAssemblies System.Drawing | Out-Null
