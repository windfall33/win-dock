# Wave 5 —— 2026-09-11 迭代落账

> 范围：macOS 对齐（尺寸/最近区/常驻默认/每屏一条）、Windows 适配（512 图标/WinEvent）、
> 性能与稳定（自适应轮询/崩溃自拉起）、进度环、可观测（图标失败日志）。
> 验证：`npm test` 155/155；隔离 userData 真机启动；CDP 实拍 `shots/w5-full.png` / `shots/w5-large.png`。

## P0 修复

| 项 | 问题 | 修法 | 证据 |
| --- | --- | --- | --- |
| F1b 渲染层崩溃 | `state.js` 直接调用未定义的 `dockStayZone`，真机 Uncaught，整个 applyEnv 链路炸 | 改为 `hooks.dockStayZone()`（默认桩 + layout 注册） | 真机无 Uncaught；槽位齐全 |

## 功能与对齐

| # | 项 | 做法 |
| --- | --- | --- |
| W5-1 | 图标尺寸 24–128（原 36–72） | 设置滑块、分隔线拖宽、Settings 合法性钳制（非法回退 52） |
| W5-2 | 最近应用区开关 | `showRecents` 默认开；snapshot / 设置面板 / SETTING_KEYS / broadcast 全链路 |
| W5-3 | 自适应轮询 | 状态有变 450ms 快档 / 稳定 1600ms 慢档（`pollFastMs`/`pollIdleMs` 可调） |
| W5-4 | 图标失败日志 | `IconCache.logSafe` → `userData/icon-cache.log`，5s 节流 |
| W5-5 | 大图标观感 | 条 padding / 圆角 / 运行点随 iconSize 缩放 |
| W5-6 | 图标 512px | `PrivateExtractIcons` + ShellItem 提 512，治 1.8× 鱼眼发虚 |
| W5-7 | WinEvent 事件驱动 | 桥接独立线程 hook 前台/创建/销毁/显隐，主进程 200ms 节流触发 pollOnce |
| W5-8 | 主进程崩溃自拉起 | `uncaughtException`/`unhandledRejection` → log + `app.relaunch` |
| W5-9 | Dock 常驻默认 | `keepVisible` 默认 true；v3 迁移仅覆盖「从未设置过」的用户 |
| W5-10 | 每屏一条 Dock | `dockPerDisplay` 开关；多 BrowserWindow + 全量 state/env 广播 |
| W5-11 | 进度环 | 标题 `%` 启发式 → conic-gradient 环；签名含 progress |

## 测试

- 新增：`progress.test.js`（5）、`showRecents`（2）、`iconSize` 钳制、keepVisible v3 迁移
- 总数：142 → **155**，全过

## 真机证据

- 冷启动：`dock-bounds` 落日志（含 display id），渲染层无异常
- 默认 52px 与 88px 实拍：玻璃条 + 底板 + 倒影 + 运行点 + 分区正确

## 未做（有意）

- Liquid Glass / DWM Live Thumbnail / 系统级角标（平台天花板）
- 微信/QQ 托盘未读的逐应用适配（工程量大，标题启发式已覆盖有窗口场景）

## 工具

- `tools/smoke-bg.cjs`、`tools/shot-now.cjs`：隔离启动 + 透明窗截图（垫底色 + 压 hidden-away）
