# 项目改动总说明

## 1. 项目目标

这个项目的起点很明确：给 `Codex CLI` 在 macOS 上补齐日常使用中最容易错过的两类提醒。

- 一类是任务执行完成后的提醒
- 一类是 Codex 请求你批准命令、文件改动或额外输入时的提醒

随着实际使用场景逐步明确，项目又向前扩展了一步：在 `Ghostty` 的多标签页环境下，只要你已经离开运行 Codex 的那个标签页，即使 Ghostty 仍然是前台应用，也能收到审批类通知。

## 2. 这次一共做了哪些改动

整个项目目前可以分成三个阶段。

### 阶段一：完成基础版 macOS 通知器

第一阶段完成了基础通知能力，对应提交：

- `71ab564 Initial commit: Codex CLI macOS notifier`

这一阶段新增了两个核心文件：

- `codex-notify.mjs`
- `codex-with-notify`

实现方式是一个混合方案：

- `任务完成` 走 Codex 官方 `notify` hook
- `权限请求` 和 `用户输入请求` 走 Codex TUI 通知通道

这里的关键配置思路是：

```toml
notify = ["node", "/path/to/codex-notify.mjs"]

[tui]
notifications = ["approval-requested", "user-input-requested"]
notification_method = "auto"
```

`codex-notify.mjs` 的职责很克制：

1. 接收 Codex 传来的原始 JSON payload
2. 安全解析事件
3. 归一化出合适的标题和正文
4. 可选写入本地 JSON 日志
5. 通过 `osascript` 发出 macOS 原生桌面通知

这个阶段解决的是最基础、最通用的场景：只要终端整体失焦，完成提醒和大部分审批提醒都能工作。

### 阶段二：补齐中英文文档

第二阶段主要解决文档可读性和中文使用门槛问题，对应提交：

- `a6a1d97 Add Chinese documentation`

这一阶段补充了：

- `README.zh-CN.md`
- `IMPLEMENTATION_NOTES.zh-CN.md`

目的不是简单翻译，而是把这个小工具背后的原理、限制、验证方式、以及最常见的误区写清楚，避免后续使用时把“模型在对话里问要不要批准”和“Codex CLI 真的发出了审批事件”混为一谈。

### 阶段三：增加 Ghostty 标签页感知通知

第三阶段解决的是一个更具体但很重要的问题，对应提交：

- `ecfcbf7 Add Ghostty tab-aware notification wrapper`

在 Ghostty 里，Codex 原生的 TUI 通知语义更接近“终端应用是否失焦”，而不是“当前标签页是不是运行 Codex 的那个标签页”。

这会导致一个实际问题：

- 如果你把 Ghostty 整个应用放在前台
- 但切换到了另一个 tab
- 运行 Codex 的那个 tab 出现了审批请求

这时候原生 TUI 通知通常不会弹，因为从终端角度看，它还处在前台。

为了解决这个问题，这一阶段新增了：

- `codex-ghostty-notify`
- `codex-ghostty-notify.mjs`

它的设计原则是：

- `不改动原生 codex`
- `通过显式包装命令提供更强行为`

也就是说：

- 你继续直接运行 `codex`，行为保持原来的简单方案
- 你运行 `codex-ghostty-notify`，则启用 Ghostty 标签页感知增强逻辑

## 3. Ghostty 增强版的实现原理

Ghostty 包装器不是简单再套一层 shell，而是一个本地桥接流程。

它大致做了下面几件事：

1. 启动时记录当前 Ghostty 的窗口和标签页信息
2. 启动本地 `codex app-server`
3. 启动一个本地 WebSocket 代理
4. 让交互式 `codex --remote` 连到这个代理，而不是直接连 app-server
5. 从 app-server 协议里直接监听这些真实运行时事件：
   - `item/commandExecution/requestApproval`
   - `item/fileChange/requestApproval`
   - `item/permissions/requestApproval`
   - `item/tool/requestUserInput`
6. 当检测到这些请求仍在挂起时，通过 Ghostty 的 AppleScript 接口轮询当前选中的 tab
7. 如果发现你已经不在启动 Codex 的那个 tab 上，就调用现有的 `codex-notify.mjs` 发出 macOS 原生通知

这样做的好处有两个：

- 复用了原来的通知脚本，不需要再造一套通知样式和日志逻辑
- 把“标签页感知”限定在 Ghostty 专用包装器里，不会污染原生 `codex` 的使用路径

## 4. 现在项目里各文件的职责

- `codex-notify.mjs`
  基础通知脚本，负责解析事件并调用 macOS 通知
- `codex-with-notify`
  传统包装器，用于快速带通知配置启动 `codex`
- `codex-ghostty-notify`
  Ghostty 多标签场景下的增强入口命令
- `codex-ghostty-notify.mjs`
  Ghostty 标签页感知核心实现，本地 app-server 代理和事件拦截逻辑都在这里
- `README.md`
  英文说明
- `README.zh-CN.md`
  中文使用说明
- `IMPLEMENTATION_NOTES.md`
  英文实现说明和经验总结
- `IMPLEMENTATION_NOTES.zh-CN.md`
  中文实现说明和经验总结

## 5. 现在应该怎么用

你现在有两条使用路径。

### 路径一：继续用原生 `codex`

适用场景：

- 你只需要基础完成通知
- 你接受审批通知主要依赖终端整体失焦
- 你不关心 Ghostty 同一窗口内不同 tab 的细粒度提醒

这种情况下，直接运行：

```bash
codex
```

它仍然沿用原来的全局配置方案。

### 路径二：用 Ghostty 标签页感知包装器

适用场景：

- 你使用 Ghostty
- 你经常开很多 tab
- 你希望只要离开运行 Codex 的那个 tab，就能在审批请求时收到通知

直接运行：

```bash
/Users/liufei/Downloads/VibeCoding/codex-desktop-notify/codex-ghostty-notify
```

更推荐加一个 alias：

```bash
alias cg='/Users/liufei/Downloads/VibeCoding/codex-desktop-notify/codex-ghostty-notify'
```

以后就直接：

```bash
cg
```

## 6. 验证方式

这次实现做过几类验证。

### 基础通知脚本验证

通过向 `codex-notify.mjs` 注入模拟 JSON payload，确认：

- 事件能被正确解析
- 日志能被写入
- 通知内容能被归一化

### 原生 `codex` 回退逻辑验证

对于 `--help` 或非交互式场景，Ghostty 包装器会自动退回到原生 `codex`，避免把代理逻辑错误地套到所有命令上。

### Ghostty 能力验证

确认了 Ghostty 本地脚本字典中确实存在：

- `front window`
- `selected tab`
- `tab id`

这说明 Ghostty 的 AppleScript 接口具备实现“当前 tab 是否还是启动 tab”判断的基础能力。

### Codex app-server 协议验证

通过本地 schema 确认了审批和输入请求确实会通过 app-server 的 server-request 机制暴露出来，这样代理层监听运行时事件是有官方协议依据的，不是猜测。

## 7. 这次实现过程中最重要的经验

### 经验一：“模型在对话里问你”不等于“CLI runtime 真的发起审批”

这是这次实现里最关键的一条。

如果模型在聊天内容里输出：

> 是否批准我现在执行某个命令？

这只是 assistant 文本，不代表 Codex runtime 真的进入了审批流程。

真正能触发通知逻辑的，是运行时的审批事件，而不是长得像审批请求的一段文字。

### 经验二：事件语义比界面外观更重要

两个界面看起来像不像，不决定它们是不是同一种事件。做通知系统时，必须挂在真正的 runtime 事件上，而不是挂在“看起来像”的 UI 提示上。

### 经验三：焦点判断需要分层

“终端应用不在前台”和“当前标签页不是这个会话”是两个完全不同的判断条件。

基础方案已经能覆盖前者；
Ghostty 增强版才覆盖后者。

### 经验四：最稳的方案不一定是单机制，而可能是分层组合

这个项目最后稳定下来的形态并不是“一个 hook 解决所有事情”，而是：

- 任务完成走官方 `notify` hook
- 通用审批提醒走 TUI 通知
- Ghostty 标签页感知提醒走 `app-server` 本地桥接

这是一个很典型的“覆盖优先、分层增强”方案。

### 经验五：日志非常重要

这类桌面通知问题如果没有日志，很难判断问题到底出在哪一层：

- 事件没发出来
- 代理没收到
- 脚本解析失败
- `osascript` 成功执行但系统没展示通知

所以保留 `CODEX_NOTIFY_LOG` 和 `CODEX_GHOSTTY_NOTIFY_LOG` 这类可选日志能力是必要的。

## 8. 当前限制

- 原生 `codex` 路径下，审批通知仍然依赖 TUI 语义，不会自动获得 Ghostty 标签页级别的感知能力
- `codex-ghostty-notify` 主要面向交互式场景；对于 `codex exec` 等非交互命令，会主动退回到原生 `codex`
- Ghostty 增强方案依赖 Ghostty 的 AppleScript 支持，因此它本质上是一个 Ghostty 专用增强，而不是通用终端方案

## 9. 未来可以继续做什么

如果后面还想继续增强，这个项目最值得继续扩展的方向有三个：

1. 做一个与终端无关的焦点检测桥接层，把现在 Ghostty 的能力推广到其他终端应用
2. 把通知链路扩展到 Slack、iPhone 推送等远程提醒渠道
3. 给审批事件加入更强的交互能力，而不仅仅是提醒

## 10. 当前项目状态

截至目前，仓库已经包含：

- 基础版 Codex CLI macOS 通知能力
- 中英文说明文档
- Ghostty 标签页感知增强包装器

对应的提交历史是：

- `71ab564 Initial commit: Codex CLI macOS notifier`
- `a6a1d97 Add Chinese documentation`
- `ecfcbf7 Add Ghostty tab-aware notification wrapper`

如果你只想稳定使用，当前这个状态已经足够日常使用。后续的改进空间主要集中在“把 Ghostty 专用增强推广成更通用的多终端方案”。
