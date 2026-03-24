# Codex CLI macOS Notifier

这是一个给 `Codex CLI` 用的 macOS 桌面通知工具，重点解决两个最影响日常体验的时刻：

- 一轮任务执行完成
- Codex 需要你批准命令，或需要你额外输入

## 这个项目做了什么

这个项目采用了双通道通知方案，因为当前 Codex CLI 的事件出口并不统一：

- `agent-turn-complete` 可以通过官方 `notify` hook 捕获
- `approval-requested` 和 `user-input-requested` 通过 TUI 通知通道暴露，而不是走 `notify` hook

所以最终实现分成两部分：

- `codex-notify.mjs`
  负责处理任务完成事件，并通过 `osascript` 转发到 macOS 通知中心
- Codex 的 TUI 配置
  负责在终端窗口失焦时，提醒权限请求和用户输入请求

## 仓库内容

- `codex-notify.mjs`
  接收 Codex 传来的 JSON payload，做简要归一化处理，可选写入本地日志，并发送 macOS 通知
- `codex-with-notify`
  用于带通知配置启动 `codex` 的包装脚本
- `codex-ghostty-notify`
  面向 Ghostty 多标签场景的交互式包装命令。它会记录启动会话的 Ghostty 标签页，只要审批或输入请求仍然挂起，而你已经不在那个标签页上，就会发通知。
- `codex-ghostty-notify.mjs`
  本地 WebSocket 代理，位于 `codex --remote` 和本地 `codex app-server` 之间，用来拦截审批事件并套用 Ghostty 标签页感知逻辑
- `IMPLEMENTATION_NOTES.md`
  英文版实现说明
- `IMPLEMENTATION_NOTES.zh-CN.md`
  中文版实现说明

## 工作原理

### 1. 任务完成通知

Codex 支持通过 `notify` 配置在任务完成后调用一个本地程序。这个程序会收到一段 JSON payload，描述刚刚完成的 turn。这个项目使用的是：

```toml
notify = ["node", "/path/to/codex-notify.mjs"]
```

脚本内部会做以下几步：

1. 解析事件 payload
2. 生成简洁的通知标题和正文
3. 可选地写一条本地 JSON 日志
4. 调用 `/usr/bin/osascript` 发送原生 macOS 通知

### 2. 权限请求和输入请求通知

当前 Codex 版本里，这两类事件更适合通过 TUI 通知机制处理。项目启用了：

```toml
[tui]
notifications = ["approval-requested", "user-input-requested"]
notification_method = "auto"
```

这意味着：

- 当终端窗口不在前台时，终端应用有机会把事件作为系统通知展示出来
- 当终端窗口就在前台时，提示会直接出现在 CLI 界面里，不需要额外通知

## 安装方式

### 方式一：通过包装器启动

```bash
/Users/liufei/Downloads/codex-desktop-notify/codex-with-notify
```

也可以直接传 prompt：

```bash
/Users/liufei/Downloads/codex-desktop-notify/codex-with-notify "explain this repo"
```

### 方式二：Ghostty 标签页感知包装器

如果你用的是 Ghostty，并且希望在 Ghostty 仍然是前台应用、但你已经切到了别的 tab 时，审批请求依然能提醒你，请使用：

```bash
/Users/liufei/Downloads/codex-desktop-notify/codex-ghostty-notify
```

推荐给它加一个 alias：

```bash
alias cg='/Users/liufei/Downloads/codex-desktop-notify/codex-ghostty-notify'
```

以后直接运行：

```bash
cg
```

这个包装器会：

- 启动本地 `codex app-server`
- 让 `codex --remote` 通过本地代理连接过去
- 从 app-server 协议里直接拦截审批请求和输入请求
- 用 Ghostty 的 AppleScript 接口读取当前选中的 tab
- 只要请求还挂着，而你已经不在启动 Codex 的那个 tab 上，就发 macOS 原生通知

而直接运行原生 `codex` 时，行为仍然保持你之前的老逻辑，不会被这个包装器影响。

### 方式三：写入全局 Codex 配置

如果你想以后直接运行 `codex` 就生效，可以把下面内容写入 `~/.codex/config.toml`：

```toml
notify = ["node", "/Users/liufei/Downloads/codex-desktop-notify/codex-notify.mjs"]

[tui]
notifications = ["approval-requested", "user-input-requested"]
notification_method = "auto"
```

## 验证方法

### 完成 hook 的冒烟测试

```bash
CODEX_NOTIFY_LOG=/tmp/codex-notify.log \
CODEX_NOTIFY_DISABLE_OSASCRIPT=1 \
node /Users/liufei/Downloads/codex-desktop-notify/codex-notify.mjs \
  '{"type":"agent-turn-complete","turn-id":"demo-1","cwd":"/Users/liufei/Downloads","last-assistant-message":"Done."}'
```

预期结果：

- `/tmp/codex-notify.log` 中追加一条 JSON 日志
- 事件类型是 `agent-turn-complete`

### 在真实 CLI 中验证

运行：

```bash
CODEX_NOTIFY_LOG=/tmp/codex-notify.log codex
```

然后：

- 触发一个普通任务，在结束前切走终端窗口
- 触发一个需要批准的命令，在出现批准提示前切走终端窗口

预期结果：

- 任务完成通过 hook 脚本触发通知
- 权限请求和输入请求通过 TUI 通道触发通知

## 当前限制

- `approval-requested` 目前不会稳定进入 `notify` hook，所以审批通知还不能和完成通知完全走同一条脚本链路
- 审批类通知依赖终端应用和 macOS 对失焦通知的支持
- `codex-ghostty-notify` 已经在 Ghostty 交互式场景里用了本地 `app-server` 桥接，但直接运行原生 `codex` 时仍然沿用更简单的 hook + TUI 方案
- 如果你希望把这种标签页感知行为推广到 Ghostty 之外的终端，下一步应该做一个更通用的 `app-server` 桥接层，用来判断不同终端里的真实会话焦点
- `codex-ghostty-notify` 主要面向交互式 Ghostty 会话；对于 `codex exec` 这类非交互命令，它会自动退回到原生 `codex`
- Ghostty 包装器依赖 Ghostty 的 AppleScript 支持；Ghostty 中对应配置是 `macos-applescript`，默认值是 `true`
