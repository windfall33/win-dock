# 实拍 / 回归工具

对运行中的 Dock 做真机截图，用于视觉回归对比。配合
`docs/iteration-plan-2026-09-04.md` 的验收节奏使用。

## 前置

启动带调试端口的实例：

```bash
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
```

## 用法

```bash
# 静置全宽
node tools/shot.js shots/idle.png 0 1

# 悬停触发鱼眼（hoverX 为 bar 内横坐标）
node tools/shot.js shots/fisheye.png 0.3 0.45 479

# 采样 slot 宽度，验证放大倍率与衰减
node tools/diag-fisheye.js

# 读取渲染层当前状态（root class / bar rect / slot 数）——排障第一步
node tools/diag-state.js

# Exposé 全链路自检：合成中键 → 窗口打开 → 缩略图加载 → Esc 关闭
node tools/diag-expose.js
```

`shot.js` 参数：`<out.png> <xRatio0-1> <widthRatio0-1> [hoverBarX]`，输出为 3x 放大的裁剪图。

## 两个必须绕开的坑

1. **CDP 的 `clip` 参数在 Electron 33 无效** —— 带 clip 的输出与全窗截图字节完全一致。
   必须整窗截图后在页面内用 canvas 裁剪放大（本脚本已这么做）。
2. **主进程两条链路会把 Dock 收回去**（实测 trace 4.8s 确认）：
   - 智能收起：`autohidePoll` 在前台应用激活时 240ms 就 invoke('request-hide')，
     与 autohide 设置无关（`want = autohide || appActiveNow`）
   - 全屏让位误判：遮挡循环用「真实光标」算 cursorNear，光标不在 Dock 附近时
     `occludeAway && occ.full` 立即生效（`renderer.js:183` 的 letHide）→ hidden-away
   对策（本脚本已内置）：
   a. hook `window.dock.invoke` 丢弃 `request-hide`（contextBridge 可重写，恢复时还原）
   b. `set-setting occludeAway=false` 关掉让位误判
   c. `request-show` + `autohide=false`，截图后全部恢复
   d. CDP `Input.dispatchMouseEvent` 也会被 350ms 兜底复位压制，
      鱼眼输入必须用**合成 `document.dispatchEvent(mousemove)`**

## 基线

- 静置全宽：`.workbuddy/shots/full-idle.png`（改前）/ `w1-full.png`（Wave 1 后）/ `w2-full.png`（Wave 2-4 后，白底板+玻璃层次）/ `v3-full.png`（256px 图标管线后）
- 鱼眼态：`.workbuddy/shots/fe4.png`（改前）/ `w1-fisheye.png` / `w2-fisheye.png` / `v3-fisheye.png`
- 深色图标问题：`.workbuddy/shots/p2.png` / `p3.png`
- 图标提取尺寸验证：`node tools/diag-icon.ps1`（应输出 256x256；32x32 说明 factory 回退失效）

## 运行环境坑（2026-09-05 补充）

3. **启动 Dock 必须用托管后台方式**（如 `run_in_background`），shell `&` 方式会随终端会话退出被收割——表现为启动几秒后 electron 进程全部消失且日志无错误。
4. **`#dock-root` 初始 class 带 `hidden` 但 CSS 无此规则**，起作用的是 `hidden-away`（env.dockHidden 驱动）；截图全黑先跑 `diag-state.js` 看 class，再跑 `trace.js` 看 request-show 后是否被藏回。
5. **bridge.ps1 引用 Add-Type 嵌套类型必须写 `NativeOps+RECT`**——裸 `New-Object RECT` 会报「找不到类型」，此类错误只在命令真正被调用时暴露（如 set-workarea），语法检查不报错。
6. **修改 bridge.ps1 / main.js / preload.js 后必须重启 Dock**（桥接是 spawn 的常驻子进程，渲染层 JS 不热更）。
