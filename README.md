# dsh-mailbox-notify

**任务跑完，邮件到你手机；审批卡住了，也邮件到你手机；新通知一到，上一封自动消失。**

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的任务通知插件。零依赖、零构建、不监听端口。

---

## 为什么又做了一个通知插件

跑长任务时最烦的是不知道跑完没有，得时不时切回窗口瞄一眼。dsh 生态里已有的通知方案各有门槛：

| 方案 | 门槛 |
|---|---|
| 系统 Toast | 人得在电脑前 |
| Web Push / PWA | 要公网隧道 + HTTPS，还有把 dsh 暴露到公网的风险 |
| 第三方推送（PushPlus / Bark / ntfy / Telegram） | 要注册、要实名、或者要 VPN |

**邮箱是唯一一个"人人都有、全球可达、不需要任何第三方账号"的通道。** 但邮件做通知有个通病：挂一晚上任务，早上起来收件箱几十封，全是"任务完成"。

所以这个插件做了三件事：

1. 任务结束时给你发邮件
2. **每次发新通知前，自动把上一封删掉** —— 邮箱里永远最多只有一封
3. **审批卡住时单独提醒你** —— agent 弹出权限确认后没人点，它就一直停在那儿，这种"最需要你介入"的时刻必须能被推到手机上

## 特性

- **邮件通知** —— 任意 SMTP 邮箱（QQ / 163 / Gmail / Outlook / 自建都行）。不需要 VPN、不需要装 App、不需要注册任何第三方服务
- **审批超时提醒** —— 权限审批挂起超过 60 秒（可配）就发一封，告诉你**是哪个会话、在等你批准什么操作、已经等了多久**
- **多对话可分辨** —— 每条通知都带会话标题、会话号和工作区，**邮件主题里直接带一段会话标题**（40 字以内），并行跑几个任务时在手机邮件列表一眼看出是哪个
- **旧通知自动清理** —— 通知邮件主题统一带 `[dsh-notify]` 前缀，每发一封新的就用 IMAP 删掉上一封。**只删带这个前缀的邮件**，绝不碰你其它邮件
- **不刷屏** —— 只在值得打扰的时候发（见下表）
- **可选 ntfy** —— 想让通知秒到锁屏，可以同时开 ntfy 通道（需要手机能连 Google 推送 / VPN）
- **零依赖** —— SMTP 和 IMAP 都用 `node:tls` 手写，不依赖 nodemailer 之类的库，装完即用
- **不监听端口、不写文件** —— 只读一份配置文件

## 触发规则

默认档（`notifyOn: "goals"`）下会发通知的情况：

| 情况 | 发不发 |
|---|---|
| 出错 / 中断 | ✅ 必发，高优先级 |
| 目标（goal）完成 / 受阻 | ✅ 必发 |
| 单轮耗时 ≥ `longTaskMs`（默认 3 分钟） | ✅ 发 |
| 单轮工具调用 ≥ `minToolCalls`（默认 5 次） | ✅ 发 |
| 审批挂起 ≥ `approvalTimeoutMs`（默认 60 秒）没人点 | ✅ 发（**独立于 `notifyOn`**） |
| 普通问答、闲聊、几秒钟的小活儿 | ❌ 不发 |

想更安静就设 `notifyOn: "errors"`（只报错，审批提醒照旧）；想每轮都收就设 `"all"`。

> **后两条是客观判据，不依赖 agent 有没有建 goal。** 早期版本的 `goals` 档靠 `create_goal` 触发，agent 忘了建 goal 就不发通知；现在只要"这一轮干得够久"或"动手够多"就会发。建 goal 依然有用 —— 通知里会带上目标原文。

### 审批提醒是怎么判定的

dsh 的权限审批在会话日志里留下一对事件：

```
approval/asked    ← 开始等待用户（工具名、原因都记在这里）
      ……          用户没点，任务就停在这里
approval/decided  ← 用户真的点了（批准 / 拒绝 / 取消）
```

插件在收到 `approval/asked` 时起一个计时器，收到配对的 `approval/decided` 就取消：

- 60 秒内点了 → 什么都不发（你在电脑前，不用打扰）
- 超过 60 秒还没点 → 发一封提醒
- 同一批（3 秒内）超时的多个审批**合并进同一封邮件**，不刷屏
- 每个请求只提醒一次；子代理的审批同样会卡住整个任务，所以默认也提醒

**这个机制只是"看着"，不参与审批本身** —— 插件绝不会替你点同意或拒绝，你没点之前它就一直等着。

## 安装

```bash
dsh plugin --profile web add dsh-mailbox-notify
```

装完重启 `dsh web`。

从 GitHub 安装（开发版）：

```bash
dsh plugin --profile web add github:<你的用户名>/dsh-mailbox-notify
```

## 配置

把 `config.example.json` 复制到 **`~/.dsh/mailbox-notify.json`**（Windows 是 `C:\Users\你的名字\.dsh\mailbox-notify.json`），填上你的邮箱：

```json
{
  "channel": "mail",
  "mail": {
    "host": "smtp.qq.com",
    "port": 465,
    "user": "你的邮箱@qq.com",
    "pass": "你的SMTP授权码",
    "to": "你的邮箱@qq.com"
  },
  "imap": {
    "host": "imap.qq.com",
    "port": 993
  },
  "link": "https://你的-dsh-地址/"
}
```

`link` 填上你平时打开 dsh 的地址（比如 Tailscale 域名），邮件末尾就会多一行「处理：…」，在手机上点一下就能去点审批。

### 怎么拿 SMTP 授权码

授权码不是你的登录密码，是邮箱服务商发给第三方程序的专用密码。以 QQ 邮箱为例：

1. 电脑登录 [mail.qq.com](https://mail.qq.com) → 设置 → 账户
2. 找到「POP3/IMAP/SMTP...服务」，开启 **SMTP 服务**（要短信验证）
3. 生成授权码，把那串 16 位字母填进 `pass`
4. IMAP 通常是同一个开关，一起开着的

163、Gmail、Outlook 类似，搜「你的邮箱 + SMTP 授权码」就有官方教程。

### 全部配置项

| key | 默认 | 说明 |
|---|---|---|
| `channel` | `"mail"` | `mail` / `ntfy` / `both` |
| `notifyOn` | `"goals"` | `errors` 只报错 / `goals` 默认 / `all` 每轮都发 |
| `longTaskMs` | `180000` | 超过这个毫秒数的轮次算"正经干活"，也会通知 |
| `minToolCalls` | `5` | 一轮里工具调用达到这个次数也会通知（不依赖 goal） |
| `debounceMs` | `60000` | 同类成功通知的最小间隔，防止刷屏 |
| `cleanupOld` | `true` | 发新通知前删掉旧的同前缀通知 |
| `mailTag` | `"[dsh-notify]"` | 通知邮件的主题前缀，IMAP 靠它识别自己的邮件 |
| `approvalTimeoutMs` | `60000` | 审批挂起多久后提醒；设 `0` 关掉审批提醒 |
| `approvalIncludeSubagents` | `true` | 子代理的审批要不要也提醒 |
| `link` | `""` | 邮件末尾附带回 dsh 的链接，留空则不附 |
| `mail.*` | — | SMTP 服务器、端口、账号、授权码、收件地址 |
| `imap.*` | `imap.qq.com:993` | 用来清理旧通知的 IMAP 服务器 |
| `ntfy.topic` | `""` | 填了才启用 ntfy 通道 |
| `timeoutMs` | `25000` | 网络操作超时 |

也可以用环境变量覆盖：`DSH_NOTIFY_CHANNEL`、`DSH_NOTIFY_ON`、`DSH_NOTIFY_APPROVAL_MS`、`DSH_NOTIFY_LINK`、`DSH_NOTIFY_SMTP_HOST`、`DSH_NOTIFY_SMTP_USER`、`DSH_NOTIFY_SMTP_PASS`、`DSH_NOTIFY_MAIL_TO` 等（完整列表见源码 `resolveConfig`）。

## 通知长什么样

```
[dsh-notify] ✅ 完成 · 优化邮件提醒插件的通知格式

会话：优化邮件提醒插件的通知格式  #8eda7b93
工作区：D:\dsh\config
调用了 12 次工具
用时 3min 20s

处理：https://你的-dsh-地址/

时间：2026-09-19 23:17:51
```

审批提醒则是：

```
[dsh-notify] 🔐 等审批 · 把数据整理成表格

【8eda7b93】把数据整理成表格
  工具：pwsh
  原因：escalate sandbox to danger-full-access: 需要写入工作区之外的文件
  已等待：3min 12s
  工作区：D:\dsh\config

处理：https://你的-dsh-地址/

时间：2026-09-19 23:17:51
```

## 工作原理

```
dsh 一个会话事件
      │
      ├─ approval/asked ─→ 起计时器（默认 60 秒）
      │        └─ approval/decided 到了？是 → 取消计时器，什么都不发
      │                       否 → 超时，发提醒
      │
      ├─ 是"值得打扰"的事件吗？  否 → 什么都不做
      │
      ▼ 是
   IMAP 连上你的邮箱，SEARCH SUBJECT "[dsh-notify]"
      → 把上一封通知标删 + EXPUNGE
      │
      ▼
   SMTP 用你的邮箱给自己发一封新通知
```

因为清理发生在发送之前，所以**任何时刻收件箱里最多只有一封** dsh 通知。

## 常见问题

**收不到邮件？**
先看 `dsh web` 的启动日志里有没有 `[dsh-mailbox-notify] 已启用`。有的话，检查是不是被邮箱判成垃圾邮件了（把发件人加白名单）。

**审批提醒为什么没来？**
三个可能：① `approvalTimeoutMs` 设成了 0；② 你在 60 秒内已经点掉了（那就不该打扰你）；③ 那次请求根本不需要你点 —— 比如权限预设是「完全权限」，审批会自动通过，`approval/asked` 和 `approval/decided` 几乎同时写入，计时器立刻被取消。

**收到提醒了，但回去看界面上没有审批框？**
说明它已经被处理（自动通过、被取消，或你在别处点了）。邮件是"那一刻还挂着"的快照，不代表现在仍然挂着。

**邮件里中文乱码？**
不应该发生——主题按 RFC 2047 编码、正文按 UTF-8 base64 编码。如果遇到了请开 issue 附上邮件原文。

**旧邮件没被删掉？**
两种可能：① `cleanupOld` 被关了；② 邮箱的 IMAP 删除有同步延迟（QQ 邮箱实测会有）。可以手动跑 `node clean-and-send.mjs` 全文件夹清理一遍。

**改了 `mailTag` 之后旧邮件还在？**
正常，前缀变了就搜不到旧的了。用工具脚本先清理一次。

**安全吗？**
授权码只存在你本机的配置文件里，不会上传到任何地方。它只能用来收发你自己的邮件，随时可以在邮箱设置里作废重发。插件本身不监听端口、不向任何第三方服务发送数据（除非你开了 ntfy）；审批提醒也只读事件日志，不会替你作答。

## 开发

```bash
node test-logic.mjs     # dryrun 验证"什么情况才推送"（含审批超时用例，约 8 秒）
node test-mail.mjs      # 实测邮件通道
node test-cleanup.mjs   # 实测"发新的+删旧的"链路
DSH_NOTIFY_DRYRUN=1 …   # 任何发送都只打印不执行
```

## License

[MIT](./LICENSE)
