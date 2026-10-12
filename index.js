/**
 * dsh-notify —— 只在该打扰你的时候，把通知推到你手机。
 *
 * 触发条件（config.json 里的 notifyOn 决定宽严）：
 *   'errors'  只推异常：出错 / 中断
 *   'goals'   异常 + 目标完成 + 超长任务（默认，推荐）
 *   'all'     每一轮回答结束都推（最吵）
 *
 * 审批超时提醒（approvalTimeoutMs，默认 60 秒；**独立于 notifyOn**）：
 *   agent 弹出权限审批后如果一直没人点，任务就卡在那儿不动。等超过
 *   approvalTimeoutMs 还没被回答的审批，会单独发一封提醒，告诉你
 *   "哪个会话、在等你批准什么操作、已经等了多久"。
 *   判据是会话日志里成对的 approval/asked → approval/decided 事件：
 *   前者在开始等待用户之前写入，后者在用户作答之后写入 —— 两者之差
 *   就是真实等待时长，完全不用碰审批链本身（也就绝不会替用户做决定）。
 *   同一批（3 秒内）超时的多个审批合并成一封；每个请求只提醒一次。
 *
 * 提问超时提醒（questionTimeoutMs，默认 60 秒；**独立于 notifyOn**）：
 *   另一类更常见的"卡住"：agent 用 ask_user_question 弹出一道选择题问你，
 *   你人在外面没看见，它就干等着。等超过 questionTimeoutMs 还没回答的提问，
 *   会发一封提醒，正文里带上**问题原文和候选项**，手机上不用打开 GUI 也知道
 *   它想问什么，回去点一下就能继续。
 *   判据（2026-10-08 从真实会话日志里实测出来的）：
 *     - 开始等待：tool/call 且 data.name === 'ask_user_question'，取 data.callId
 *     - 用户作答：tool/result 且 data.message.source.callId === callId
 *       （注意不是 data.toolCallId，那个字段在日志里是 undefined；答案 JSON
 *        就在 data.message.content[0].text 里，形如 {"answers":[...]}）
 *   两者时间差就是真实等待时长（实测样本 16s / 34s / 64s / 323s / 1883s）。
 *   同样只起计时器、只看日志，绝不替你作答。
 *
 * 通知里怎么认出"是哪个任务"（多对话并行时）：
 *   每条通知都带会话标题（session/title 事件）、会话号（id 前 8 位）
 *   和所属工作区（cwd）；主题里也带一小段标题，手机邮件列表就能分辨。
 *
 * 通道（channel）：
 *   'mail'  用你自己的邮箱（SMTP）发通知邮件，不需要 VPN
 *   'ntfy'  POST 到 ntfy.sh，秒到，但国内需要能连 Google 推送 / VPN
 *   'both'  两个都发
 *
 * 邮件"阅后即焚"（cleanupOld）：通知邮件主题统一带 [dsh] 前缀，
 * 每次发新通知前先通过 IMAP 把上一封带该前缀的邮件删掉，
 * 这样邮箱里永远最多只有一封通知，不会堆积。只删带前缀的邮件。
 *
 * 零第三方依赖：SMTP / IMAP 用 node:tls 手写，ntfy 用 Node 自带的 fetch。
 * 不监听任何端口、不写任何文件（只读同目录的 config.json）。
 * 调试时设 DSH_NOTIFY_DRYRUN=1，只打印不真发。
 */

import { appendFileSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tls from 'node:tls'

export const name = 'dsh-mailbox-notify'
export const inject = []

const DEFAULTS = {
  channel: 'mail',
  notifyOn: 'goals',
  longTaskMs: 180000, // 判据①：耗时超过这个数（默认 3 分钟）算"正经干活"
  minToolCalls: 5, // 判据②：一轮里工具调用 ≥ 这个数（默认 5 次）也算 —— **不依赖 agent 建 goal**
  debounceMs: 60000, // 连续成功通知的合并窗口，防止刷屏
  cleanupOld: true, // 发新通知前删掉旧的同前缀通知（邮箱不堆积）
  mailTag: '[dsh-notify]', // 通知邮件的主题前缀，IMAP 靠它识别"自己的邮件"
  approvalTimeoutMs: 60000, // 审批挂起超过这个时间就提醒；0 = 关掉审批提醒
  approvalIncludeSubagents: true, // 子代理的审批同样会卡住整个任务，默认一并提醒
  questionTimeoutMs: 60000, // 提问（ask_user_question）挂起超过这个时间就提醒；0 = 关掉
  questionIncludeSubagents: true, // 子代理的提问同样会卡住整个任务，默认一并提醒
  link: '', // 邮件里附带回 DSH 的链接（如 Tailscale 地址），手机点开直接去点审批
  // starttls: false 用隐式 TLS（465，连上就握手）；
  //           true  用明文连接 + STARTTLS 升级（587，先 EHLO 再升级）。
  // 2026-10-12 实测：smtp.qq.com:465 直接 TLS 报 "wrong version number"
  // （465 端口回的是明文 220 问候语），587 + STARTTLS 正常，所以两种都要支持。
  // debugTrace: true 时，把"插件被挂载 / 收到哪个事件 / 某轮为什么发或不发 / 发信结果"
  // 逐行追加到包目录下的 _trace.log。默认关（插件设计上不写文件）。
  // 2026-10-12 加：排查"通知没到"时，光看邮箱分不清是没触发还是发信失败。
  debugTrace: false,
  mail: { host: '', port: 465, starttls: false, user: '', pass: '', to: '' },
  imap: { host: 'imap.qq.com', port: 993 },
  ntfy: { topic: '', server: 'https://ntfy.sh' },
  timeoutMs: 25000,
}

/** 同时超时的多个审批合并进同一封邮件的等待窗口。 */
const APPROVAL_MERGE_MS = 3000

const KINDS = {
  approval: { title: '🔐 等你审批', short: '🔐 等审批', tag: 'lock', priority: 'high' },
  question: { title: '⏳ 等你回答', short: '⏳ 待回答', tag: 'hourglass_flowing_sand', priority: 'high' },
  completed: { title: '✅ 任务完成', short: '✅ 完成', tag: 'white_check_mark', priority: 'default' },
  'goal-completed': { title: '🎯 目标完成', short: '🎯 目标完成', tag: 'tada', priority: 'default' },
  'goal-blocked': { title: '⚠️ 目标受阻', short: '⚠️ 目标受阻', tag: 'warning', priority: 'high' },
  error: { title: '❌ 任务出错', short: '❌ 出错', tag: 'rotating_light', priority: 'high' },
  aborted: { title: '⚠️ 任务中断', short: '⚠️ 中断', tag: 'warning', priority: 'high' },
}

/* ---------------------------------- 配置 ---------------------------------- */

/**
 * 配置文件查找顺序（先找到先用）：
 *   1. $DSH_MAILBOX_NOTIFY_CONFIG 指定的路径
 *   2. ~/.dsh/mailbox-notify.json   ← 推荐，用户装到 node_modules 后改这个
 *   3. 包目录内的 config.json       ← 本地开发用
 */
function configCandidates() {
  const list = []
  if (process.env.DSH_MAILBOX_NOTIFY_CONFIG) list.push(process.env.DSH_MAILBOX_NOTIFY_CONFIG)
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  list.push(join(dshHome, 'mailbox-notify.json'))
  list.push(fileURLToPath(new URL('./config.json', import.meta.url)))
  return list
}

function readConfigFile() {
  for (const path of configCandidates()) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // 不存在或不是合法 JSON，试下一个
    }
  }
  return {}
}

function toInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())
}

function pick(...values) {
  for (const v of values) if (v !== undefined && v !== null && v !== '') return v
  return undefined
}

function resolveConfig(cliConfig = {}) {
  const file = readConfigFile()
  const env = process.env
  const mail = file.mail ?? {}
  const imap = file.imap ?? {}
  const ntfy = file.ntfy ?? {}
  const notifyOn = String(pick(env.DSH_NOTIFY_ON, cliConfig.notifyOn, file.notifyOn, DEFAULTS.notifyOn))
  return {
    channel: String(pick(env.DSH_NOTIFY_CHANNEL, cliConfig.channel, file.channel, DEFAULTS.channel)),
    notifyOn: ['errors', 'goals', 'all'].includes(notifyOn) ? notifyOn : DEFAULTS.notifyOn,
    longTaskMs: toInt(pick(env.DSH_NOTIFY_LONG_MS, cliConfig.longTaskMs, file.longTaskMs), DEFAULTS.longTaskMs),
    minToolCalls: toInt(pick(env.DSH_NOTIFY_MIN_TOOLS, cliConfig.minToolCalls, file.minToolCalls), DEFAULTS.minToolCalls),
    debounceMs: toInt(pick(env.DSH_NOTIFY_DEBOUNCE_MS, cliConfig.debounceMs, file.debounceMs), DEFAULTS.debounceMs),
    cleanupOld: toBool(pick(env.DSH_NOTIFY_CLEANUP_OLD, cliConfig.cleanupOld, file.cleanupOld), DEFAULTS.cleanupOld),
    mailTag: String(pick(env.DSH_NOTIFY_MAIL_TAG, cliConfig.mailTag, file.mailTag, DEFAULTS.mailTag)),
    approvalTimeoutMs: toInt(
      pick(env.DSH_NOTIFY_APPROVAL_MS, cliConfig.approvalTimeoutMs, file.approvalTimeoutMs),
      DEFAULTS.approvalTimeoutMs,
    ),
    approvalIncludeSubagents: toBool(
      pick(env.DSH_NOTIFY_APPROVAL_SUBAGENTS, cliConfig.approvalIncludeSubagents, file.approvalIncludeSubagents),
      DEFAULTS.approvalIncludeSubagents,
    ),
    questionTimeoutMs: toInt(
      pick(env.DSH_NOTIFY_QUESTION_MS, cliConfig.questionTimeoutMs, file.questionTimeoutMs),
      DEFAULTS.questionTimeoutMs,
    ),
    questionIncludeSubagents: toBool(
      pick(env.DSH_NOTIFY_QUESTION_SUBAGENTS, cliConfig.questionIncludeSubagents, file.questionIncludeSubagents),
      DEFAULTS.questionIncludeSubagents,
    ),
    link: String(pick(env.DSH_NOTIFY_LINK, cliConfig.link, file.link, DEFAULTS.link)),
    debugTrace: toBool(pick(env.DSH_NOTIFY_DEBUG_TRACE, cliConfig.debugTrace, file.debugTrace), DEFAULTS.debugTrace),
    timeoutMs: toInt(pick(env.DSH_NOTIFY_TIMEOUT_MS, file.timeoutMs), DEFAULTS.timeoutMs),
    mail: {
      host: String(pick(env.DSH_NOTIFY_SMTP_HOST, mail.host, DEFAULTS.mail.host)),
      port: toInt(pick(mail.port, DEFAULTS.mail.port), DEFAULTS.mail.port),
      starttls: toBool(pick(env.DSH_NOTIFY_SMTP_STARTTLS, mail.starttls), DEFAULTS.mail.starttls),
      user: String(pick(env.DSH_NOTIFY_SMTP_USER, mail.user, DEFAULTS.mail.user)),
      pass: String(pick(env.DSH_NOTIFY_SMTP_PASS, mail.pass, DEFAULTS.mail.pass)),
      to: String(pick(env.DSH_NOTIFY_MAIL_TO, mail.to, mail.user, DEFAULTS.mail.to)),
    },
    imap: {
      host: String(pick(env.DSH_NOTIFY_IMAP_HOST, imap.host, DEFAULTS.imap.host)),
      port: toInt(pick(imap.port, DEFAULTS.imap.port), DEFAULTS.imap.port),
    },
    ntfy: {
      topic: String(pick(env.DSH_NOTIFY_TOPIC, ntfy.topic, DEFAULTS.ntfy.topic)).trim(),
      server: String(pick(env.DSH_NOTIFY_SERVER, ntfy.server, DEFAULTS.ntfy.server)).replace(/\/+$/, ''),
    },
  }
}

/* -------------------------------- 小工具 --------------------------------- */

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64')
const quote = s => `"${String(s).replace(/([\\"])/g, '\\$1')}"`

/** 诊断日志：只在 cfg.debugTrace 打开时写包目录下的 _trace.log，写失败绝不影响通知。 */
const TRACE_FILE = fileURLToPath(new URL('./_trace.log', import.meta.url))
function traceLine(text) {
  try { appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${text}\n`) } catch { /* 忽略 */ }
}

/** HTTP 头只能安全携带 ASCII，中文按 RFC 2047 编码。 */
function headerText(text) {
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${b64(text)}?=`
}

function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 1) return '<1s'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 ? `${m}min` : `${m}min ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}min`
}

function clip(text, max = 90) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * 统计某一轮里的工具调用次数与工具名。
 * 事件结构：'tool/call': { turn, step, callId, name, arguments }
 * 这是"这一轮到底干了多少活"最客观的判据 —— 不依赖 agent 有没有建 goal。
 * @param session - 会话对象（含 events 数组）
 * @param turn - 轮次编号
 * @returns { count, names }
 */
function toolStats(session, turn) {
  const events = session?.events
  if (!Array.isArray(events)) return { count: 0, names: [] }
  const names = []
  let inTurn = false
  for (const e of events) {
    if (e?.type === 'turn/start' && e?.data?.turn === turn) { inTurn = true; continue }
    if (e?.type === 'turn/end' && e?.data?.turn === turn) break
    if (inTurn && e?.type === 'tool/call' && typeof e.data?.name === 'string') names.push(e.data.name)
  }
  return { count: names.length, names }
}

/** 取本轮任务的用户原文作为通知摘要。 */
function taskSnippet(session, turn, max = 90) {
  const events = session?.events
  if (!Array.isArray(events)) return ''
  let start = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/start' && events[i]?.data?.turn === turn) {
      start = i
      break
    }
  }
  if (start < 0) return ''
  for (let i = start; i < events.length; i++) {
    const e = events[i]
    if (e?.type !== 'user/message') continue
    const content = e.data?.content
    if (!Array.isArray(content)) continue
    let text = ''
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') text += block.text
    }
    const flat = clip(text, max)
    if (flat !== '') return flat
  }
  return ''
}

/* ------------------------------ 会话身份识别 ------------------------------- */

/**
 * 取会话标题。优先用监听期间缓存的 session/title，缓存未命中时折叠会话日志。
 * 多对话并行时，标题是"这条通知属于哪个任务"最有用的一条信息。
 * @param session - 会话对象
 * @param cache - Map<sessionId, title>，由 session/title 事件维护
 * @returns 标题文本，取不到返回空串
 */
function sessionTitleOf(session, cache) {
  const id = session?.id
  if (id !== undefined && id !== null && cache.has(id)) return cache.get(id)
  const events = session?.events
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e?.type === 'session/title' && typeof e.data?.title === 'string') return e.data.title
  }
  return ''
}

/** 会话短号：id 前 8 位，正文里用来对号入座。 */
function shortId(id) {
  const text = String(id ?? '')
  return text === '' ? '' : text.slice(0, 8)
}

/** 子会话（subagent / fork）判定。 */
function isChildSession(session) {
  const header = session?.header
  return Boolean(header?.parentSession) || (Number(header?.delegationDepth) || 0) > 0
}

/**
 * 会话身份行：标题（回退到调用方给的任务原文）+ 短号 + 工作区。
 * @param fallback - 没有标题时用的替代文本（一般是任务原文）
 */
function sessionLines(session, cache, fallback = '') {
  const title = clip(sessionTitleOf(session, cache) || fallback, 60)
  const id = shortId(session?.id)
  const cwd = clip(session?.header?.cwd ?? '', 80)
  const head = [title || '（无标题会话）', id ? `#${id}` : ''].filter(Boolean).join('  ')
  const lines = [`会话：${head}`]
  if (cwd !== '') lines.push(`工作区：${cwd}`)
  return lines
}

/* ------------------------------- 连接与读取 -------------------------------- */

function connectTls(host, port, timeoutMs) {
  const socket = tls.connect({ host, port, servername: host })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('连接超时')) }, timeoutMs)
    socket.once('secureConnect', () => { clearTimeout(timer); resolve(socket) })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

/** SMTP 读取器：累积到「三位数字 + 空格」结尾的那一行才算完整响应。 */
function makeSmtpReader(socket) {
  let pending = ''
  let acc = []
  let waiter = null
  const pump = () => {
    while (waiter) {
      const idx = pending.indexOf('\r\n')
      if (idx < 0) return
      const line = pending.slice(0, idx)
      pending = pending.slice(idx + 2)
      acc.push(line)
      if (/^\d{3} /.test(line)) {
        const text = acc.join('\n')
        acc = []
        const done = waiter
        waiter = null
        done(text)
      }
    }
  }
  socket.on('data', chunk => { pending += chunk.toString('utf8'); pump() })
  return () => new Promise(resolve => { waiter = resolve; pump() })
}

/** IMAP 读取器：等到出现以指定 tag 开头的行，把这一批响应行一起交出去。 */
function makeImapReader(socket) {
  let pending = ''
  let lines = []
  let waiter = null
  const pump = () => {
    while (waiter) {
      const idx = pending.indexOf('\r\n')
      if (idx < 0) return
      const line = pending.slice(0, idx)
      pending = pending.slice(idx + 2)
      lines.push(line)
      if (line.startsWith(`${waiter.tag} `)) {
        const done = waiter
        waiter = null
        const batch = lines
        lines = []
        done.resolve(batch)
      }
    }
  }
  socket.on('data', chunk => { pending += chunk.toString('utf8'); pump() })
  return tag => new Promise(resolve => { waiter = { tag, resolve }; pump() })
}

/** 明文 TCP 连接（STARTTLS 的第一段）。 */
function connectPlain(host, port, timeoutMs) {
  const socket = net.connect({ host, port })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('连接超时')) }, timeoutMs)
    socket.once('connect', () => { clearTimeout(timer); resolve(socket) })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

/**
 * STARTTLS 通道（587 常用）：明文连上 → 读 220 → EHLO → STARTTLS → 220
 * → 把同一个 socket 升级成 TLS，返回升级后的 socket。
 * 升级后必须**再 EHLO 一次**（TLS 层内的会话重新开始），这一步由 sendMail 负责。
 */
async function connectStarttls(host, port, timeoutMs) {
  const raw = await connectPlain(host, port, timeoutMs)
  const read = makeSmtpReader(raw)
  const first = async () => (await read()).split('\n')[0]

  let line = await first()
  if (!line.startsWith('220')) throw new Error(`SMTP 未返回 220：${line}`)
  raw.write('EHLO dsh-notify\r\n')
  const ehlo = await read()
  line = ehlo.split('\n')[0]
  if (!line.startsWith('250')) throw new Error(`EHLO 失败：${line}`)
  if (!/STARTTLS/i.test(ehlo)) throw new Error('服务器没有广告 STARTTLS（这个端口可能要用隐式 TLS）')
  raw.write('STARTTLS\r\n')
  line = await first()
  if (!line.startsWith('220')) throw new Error(`STARTTLS 被拒绝：${line}`)

  return await new Promise((resolve, reject) => {
    const socket = tls.connect({ socket: raw, servername: host })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('TLS 握手超时')) }, timeoutMs)
    socket.once('secureConnect', () => { clearTimeout(timer); resolve(socket) })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

/* --------------------------------- 邮件通道 -------------------------------- */

export async function sendMail(cfg, subject, text) {
  if (!cfg.host || !cfg.user || !cfg.pass || !cfg.to) throw new Error('邮件配置不完整')

  const useStarttls = cfg.starttls === true
  const socket = useStarttls
    ? await connectStarttls(cfg.host, cfg.port, cfg.timeoutMs)
    : await connectTls(cfg.host, cfg.port, cfg.timeoutMs)
  const read = makeSmtpReader(socket)
  const expect = async code => {
    const raw = await read()
    const first = raw.split('\n')[0]
    if (!first.startsWith(String(code))) throw new Error(`SMTP 未返回 ${code}：${first}`)
  }
  const say = line => socket.write(`${line}\r\n`)

  try {
    // 隐式 TLS：服务器先给 220 问候语；STARTTLS 那一段在 connectStarttls 里已经消费掉了
    if (!useStarttls) await expect(220)
    say('EHLO dsh-notify')
    await expect(250)
    say('AUTH LOGIN')
    await expect(334)
    say(b64(cfg.user))
    await expect(334)
    say(b64(cfg.pass))
    await expect(235)
    say(`MAIL FROM:<${cfg.user}>`)
    await expect(250)
    say(`RCPT TO:<${cfg.to}>`)
    await expect(250)
    say('DATA')
    await expect(354)

    const headers = [
      `From: =?UTF-8?B?${b64('dsh 通知')}?= <${cfg.user}>`,
      `To: <${cfg.to}>`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ].join('\r\n')
    const body = b64(text).replace(/(.{76})/g, '$1\r\n')
    socket.write(`${headers}\r\n\r\n${body}\r\n.\r\n`)
    await expect(250)
    say('QUIT')
  } finally {
    socket.end()
  }
}

/**
 * 通过 IMAP 删掉收件箱里主题带 [dsh] 前缀的旧通知。
 * 只删带前缀的，绝不碰其它邮件；失败也不影响本次发送。
 * @returns 删掉的封数
 */
export async function dropOldMails(cfg) {
  if (!cfg.imap.host || !cfg.mail.user || !cfg.mail.pass) return 0

  const socket = await connectTls(cfg.imap.host, cfg.imap.port, cfg.timeoutMs)
  const wait = makeImapReader(socket)
  const say = line => socket.write(`${line}\r\n`)

  try {
    await wait('*') // 服务器问候
    say(`a1 LOGIN ${quote(cfg.mail.user)} ${quote(cfg.mail.pass)}`)
    const login = await wait('a1')
    if (!/\ba1 OK/i.test(login.join('\n'))) throw new Error(`IMAP 登录失败：${login[login.length - 1]}`)

    say('a2 SELECT INBOX')
    await wait('a2')

    say(`a3 SEARCH SUBJECT ${quote(cfg.mailTag)}`)
    const search = await wait('a3')
    const hit = search.find(l => l.startsWith('* SEARCH'))
    const ids = hit ? hit.slice('* SEARCH'.length).trim().split(/\s+/).filter(Boolean) : []
    if (ids.length === 0) {
      say('a9 LOGOUT')
      return 0
    }

    say(`a4 STORE ${ids.join(',')} +FLAGS (\\Deleted)`)
    await wait('a4')
    say('a5 EXPUNGE')
    await wait('a5')
    say('a9 LOGOUT')
    return ids.length
  } finally {
    try { socket.end() } catch { /* 忽略 */ }
  }
}

/* --------------------------------- ntfy 通道 ------------------------------- */

function sendNtfy(cfg, meta, body) {
  fetch(`${cfg.ntfy.server}/${cfg.ntfy.topic}`, {
    method: 'POST',
    headers: { Title: headerText(meta.title), Tags: meta.tag, Priority: meta.priority },
    body,
  })
    .then(r => { if (!r.ok) console.warn(`[dsh-notify] ntfy 推送失败 HTTP ${r.status}`) })
    .catch(e => console.warn(`[dsh-notify] ntfy 推送失败: ${String(e?.message ?? e)}`))
}

/* ---------------------------------- 入口 ---------------------------------- */

export function apply(ctx, cliConfig = {}) {
  const cfg = resolveConfig(cliConfig)
  const useMail = cfg.channel === 'mail' || cfg.channel === 'both'
  const useNtfy = cfg.channel === 'ntfy' || cfg.channel === 'both'
  const dryRun = process.env.DSH_NOTIFY_DRYRUN === '1'
  const trace = cfg.debugTrace ? traceLine : () => {}
  trace(`apply · notifyOn=${cfg.notifyOn} channel=${cfg.channel} mail=${cfg.mail.host}:${cfg.mail.port} starttls=${cfg.mail.starttls} to=${cfg.mail.to}`)

  const startedAt = new Map()
  const goalStarted = new Map()
  /**
   * Map<"sessionId\0turn", number>：**自己数**这一轮调了几次工具。
   * 2026-10-12 实测：不能再靠 session.events 里翻（在运行时读出来是 0 —— trace 里
   * 写着 "39s 且 0 次工具"，而那一轮实际调了 6 次），所以改成从 session/event 流里累加。
   */
  const toolCounts = new Map()
  /** Map<sessionId, title>：session/title 事件随手缓存，通知时直接取。 */
  const titleCache = new Map()
  /** Map<"sessionId\0requestId", entry>：正在等用户点的那几个审批。 */
  const pendingApprovals = new Map()
  /** Map<"sessionId\0callId", entry>：正在等用户回答的那几个提问。 */
  const pendingQuestions = new Map()
  let approvalFlushTimer = null
  let questionFlushTimer = null
  let lastSentAt = 0

  const deliverMail = async (meta, body) => {
    if (dryRun) {
      console.log(`[dsh-notify][dryrun] ${cfg.mailTag} ${meta.title}\n${body}\n---`)
      return
    }
    if (cfg.cleanupOld) {
      try {
        const removed = await dropOldMails(cfg)
        if (removed > 0) console.log(`[dsh-notify] 已清理 ${removed} 封旧通知邮件`)
      } catch (error) {
        console.warn(`[dsh-notify] 清理旧邮件失败（不影响本次发送）: ${String(error?.message ?? error)}`)
      }
    }
    // 前缀留明文（IMAP 靠它搜索），标题本体按 RFC 2047 编码，避免邮件头出现裸非 ASCII
    trace(`sendMail → ${cfg.mail.host}:${cfg.mail.port} (starttls=${cfg.mail.starttls}) title=${meta.title}`)
    try {
      await sendMail({ ...cfg.mail, timeoutMs: cfg.timeoutMs }, `${cfg.mailTag} ${headerText(meta.title)}`, body)
      trace(`sendMail OK`)
      console.log(`[dsh-notify] 邮件已发送 → ${cfg.mail.to}`)
    } catch (error) {
      trace(`sendMail FAIL ${String(error?.message ?? error)}`)
      throw error
    }
  }

  /**
   * 发一条通知。去抖在调用方判断 —— 不同类别的通知互不干扰。
   * @param meta - KINDS 里的类型（title / short / tag / priority）
   * @param lines - 正文行（空串保留为段落分隔）
   * @param subject - 主题里附加的会话标识，手机邮件列表靠它区分多对话
   */
  const emit = (meta, lines, subject = '') => {
    const tail = cfg.link === '' ? [] : ['', `处理：${cfg.link}`]
    const body = [
      ...lines,
      ...tail,
      '',
      `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ]
      .filter(l => l !== undefined && l !== null)
      .join('\n')
    const title = [meta.short ?? meta.title, clip(subject, 40)].filter(Boolean).join(' · ')
    trace(`emit ${meta.title} · ${title}`)
    if (useMail) {
      deliverMail({ ...meta, title }, body).catch(e => {
        const msg = String(e?.message ?? e)
        // 2026-10-12：smtp.qq.com:465 曾回明文 220（wrong version number），
        // 排查时最容易误判成"插件没触发"，所以这里把可能的方向直接打出来。
        const hint = /wrong version number|handshake|ECONNRESET|超时/i.test(msg)
          ? `（连接方式可能不对：试 mail.port=587 + mail.starttls=true，或 mail.port=465 + mail.starttls=false）`
          : ''
        console.warn(`[dsh-notify] 邮件发送失败: ${msg}${hint}`)
        trace(`emit FAILED ${msg}`)
      })
    }
    if (!dryRun && useNtfy) sendNtfy(cfg, { ...meta, title }, body)
  }

  /* ------------------------------ 审批超时提醒 ------------------------------ */

  /** 把一批已超时的审批渲染成正文。 */
  const approvalLines = entries => {
    const now = Date.now()
    const lines = []
    for (const entry of entries) {
      const title = clip(sessionTitleOf(entry.session, titleCache), 50) || '（无标题会话）'
      const cwd = clip(entry.session?.header?.cwd ?? '', 80)
      lines.push(`【${shortId(entry.sessionId)}】${title}`)
      lines.push(`  工具：${entry.toolName}`)
      if (entry.reason !== '') lines.push(`  原因：${entry.reason}`)
      lines.push(`  已等待：${formatDuration(now - entry.askedAt)}`)
      if (cwd !== '') lines.push(`  工作区：${cwd}`)
      lines.push('')
    }
    if (lines[lines.length - 1] === '') lines.pop()
    return lines
  }

  /** 同一批超时的审批合并成一封；每个卡住你的请求只提醒一次。 */
  const scheduleApprovalNotice = () => {
    if (approvalFlushTimer !== null) return
    approvalFlushTimer = setTimeout(() => {
      approvalFlushTimer = null
      const fresh = [...pendingApprovals.values()].filter(entry => entry.timedout && !entry.notified)
      if (fresh.length === 0) return
      for (const entry of fresh) entry.notified = true
      const subject = fresh.length === 1 ? sessionTitleOf(fresh[0].session, titleCache) : `${fresh.length} 项同时等待`
      emit(KINDS.approval, approvalLines(fresh), subject)
    }, APPROVAL_MERGE_MS)
    approvalFlushTimer.unref?.()
  }

  /** approval/asked 在开始等待用户之前写入 —— 用它起计时器。 */
  const onApprovalAsked = (session, event) => {
    if (cfg.approvalTimeoutMs <= 0) return
    if (!cfg.approvalIncludeSubagents && isChildSession(session)) return
    const requestId = event.data?.id
    if (requestId === undefined || requestId === null) return
    const key = `${session.id}\u0000${requestId}`
    if (pendingApprovals.has(key)) return
    const entry = {
      session,
      sessionId: session.id,
      toolName: clip(event.data?.toolName ?? '未知工具', 40),
      reason: clip(event.data?.reason ?? '', 120),
      askedAt: event.time ?? Date.now(),
      timedout: false,
      notified: false,
      timer: null,
    }
    entry.timer = setTimeout(() => {
      entry.timer = null
      entry.timedout = true
      scheduleApprovalNotice()
    }, cfg.approvalTimeoutMs)
    entry.timer.unref?.()
    pendingApprovals.set(key, entry)
  }

  /** approval/decided 在用户作答之后写入 —— 用它取消计时器。 */
  const onApprovalDecided = (session, event) => {
    const requestId = event.data?.id
    if (requestId === undefined || requestId === null) return
    const key = `${session.id}\u0000${requestId}`
    const entry = pendingApprovals.get(key)
    if (entry === undefined) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    pendingApprovals.delete(key)
  }

  /* ------------------------------ 提问超时提醒 ------------------------------ */

  /**
   * 从 ask_user_question 的参数里抠出「问题原文 + 候选项」，供提醒正文使用。
   * 参数一般是对象；个别 provider 会塞成 JSON 字符串，这里顺着解一下。
   * @returns { questions: string[], options: string[] }
   */
  const questionBrief = args => {
    let parsed = args
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed) } catch { parsed = null }
    }
    const list = Array.isArray(parsed?.questions) ? parsed.questions : []
    const questions = []
    const options = []
    for (const item of list.slice(0, 3)) {
      const text = clip(item?.question ?? item?.header ?? '', 120)
      if (text !== '') questions.push(text)
      for (const option of (Array.isArray(item?.options) ? item.options : []).slice(0, 3)) {
        const label = clip(option?.label ?? '', 30)
        if (label !== '' && !options.includes(label) && options.length < 6) options.push(label)
      }
    }
    return { questions, options }
  }

  /** 把一批已超时的提问渲染成正文（同一会话的多个提问共用一行标题）。 */
  const questionLines = entries => {
    const now = Date.now()
    const grouped = new Map()
    for (const entry of entries) {
      if (!grouped.has(entry.sessionId)) grouped.set(entry.sessionId, { session: entry.session, items: [] })
      grouped.get(entry.sessionId).items.push(entry)
    }
    const lines = []
    for (const { session, items } of grouped.values()) {
      const title = clip(sessionTitleOf(session, titleCache), 50) || '（无标题会话）'
      const cwd = clip(session?.header?.cwd ?? '', 80)
      lines.push(`【${shortId(session?.id)}】${title}`)
      for (const entry of items) {
        for (const q of entry.questions) lines.push(`  问：${q}`)
        if (entry.options.length > 0) lines.push(`  选项：${clip(entry.options.join(' ／ '), 150)}`)
        lines.push(`  已等待：${formatDuration(now - entry.askedAt)}`)
      }
      if (cwd !== '') lines.push(`  工作区：${cwd}`)
      lines.push('')
    }
    if (lines[lines.length - 1] === '') lines.pop()
    return lines
  }

  /** 同一批超时的提问合并成一封；每个卡住你的提问只提醒一次。 */
  const scheduleQuestionNotice = () => {
    if (questionFlushTimer !== null) return
    questionFlushTimer = setTimeout(() => {
      questionFlushTimer = null
      const fresh = [...pendingQuestions.values()].filter(entry => entry.timedout && !entry.notified)
      if (fresh.length === 0) return
      for (const entry of fresh) entry.notified = true
      const subject = fresh.length === 1
        ? clip(fresh[0].questions[0] ?? sessionTitleOf(fresh[0].session, titleCache), 40)
        : `${fresh.length} 个提问在等你回答`
      emit(KINDS.question, questionLines(fresh), subject)
    }, APPROVAL_MERGE_MS)
    questionFlushTimer.unref?.()
  }

  /** tool/call(ask_user_question) 在开始等用户输入之前写入 —— 用它起计时器。 */
  const onQuestionAsked = (session, event) => {
    if (cfg.questionTimeoutMs <= 0) return
    if (!cfg.questionIncludeSubagents && isChildSession(session)) return
    const callId = event.data?.callId
    if (callId === undefined || callId === null || callId === '') return
    const key = `${session.id}\u0000${callId}`
    if (pendingQuestions.has(key)) return
    const { questions, options } = questionBrief(event.data?.arguments)
    const entry = {
      session,
      sessionId: session.id,
      questions: questions.length > 0 ? questions : ['（问题内容没解析出来，回去看一眼）'],
      options,
      askedAt: event.time ?? Date.now(),
      timedout: false,
      notified: false,
      timer: null,
    }
    entry.timer = setTimeout(() => {
      entry.timer = null
      entry.timedout = true
      scheduleQuestionNotice()
    }, cfg.questionTimeoutMs)
    entry.timer.unref?.()
    pendingQuestions.set(key, entry)
  }

  /**
   * tool/result 里的 callId 藏在 data.message.source 下（data.toolCallId 是空的）
   * —— 用它认出"用户已经作答"，取消计时器。非提问的结果在这里查不到 key，直接放过。
   */
  const onQuestionAnswered = (session, event) => {
    if (pendingQuestions.size === 0) return
    const callId = event.data?.message?.source?.callId
    if (callId === undefined || callId === null || callId === '') return
    const key = `${session.id}\u0000${callId}`
    const entry = pendingQuestions.get(key)
    if (entry === undefined) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    pendingQuestions.delete(key)
  }

  ctx.on('session/event', (session, event) => {
    try {
      const id = session?.id
      if (id === undefined || id === null) return

      if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'goal/change') {
        trace(`event ${event.type} session=${String(id).slice(0, 8)} turn=${event.data?.turn ?? '-'}`)
      }

      /* ---- 会话标题：先缓存下来，任何通知都用得上（子会话也要） ---- */
      if (event.type === 'session/title') {
        const title = event.data?.title
        if (typeof title === 'string' && title !== '') titleCache.set(id, title)
        return
      }

      /* ---- 审批：等太久没人点就提醒（子会话的审批同样会卡住整个任务） ---- */
      if (event.type === 'approval/asked') return onApprovalAsked(session, event)
      if (event.type === 'approval/decided') return onApprovalDecided(session, event)

      /* ---- 提问：等太久没人回答就提醒（同样是"你不动它就不动"的卡点） ---- */
      if (event.type === 'tool/call' && event.data?.name === 'ask_user_question') onQuestionAsked(session, event)
      if (event.type === 'tool/result') onQuestionAnswered(session, event)

      // 子代理 / fork 出来的会话，除上面几类之外的事件都不进通知
      if (isChildSession(session)) return

      /* ---- 轮次 ---- */
      if (event.type === 'turn/start') {
        startedAt.set(id, event.time)
        toolCounts.delete(`${id}\u0000${event.data?.turn ?? ''}`)
        return
      }

      /* ---- 工具调用：只用来数次数（ask_user_question 上面已单独处理） ---- */
      if (event.type === 'tool/call') {
        const key = `${id}\u0000${event.data?.turn ?? ''}`
        toolCounts.set(key, (toolCounts.get(key) ?? 0) + 1)
        return
      }

      /* ---- 目标 ---- */
      if (event.type === 'goal/change') {
        const change = event.data
        if (!change || change.kind !== 'goal/change') return
        const goal = change.goal
        if (!goal) return
        if (goal.phase === 'active') {
          goalStarted.set(id, event.time)
          return
        }
        if (cfg.notifyOn === 'errors') return
        const durationMs = Math.max(0, event.time - (goalStarted.get(id) ?? event.time))
        if (goal.phase === 'complete') {
          goalStarted.delete(id)
          emit(
            KINDS['goal-completed'],
            [...sessionLines(session, titleCache), `目标：${clip(goal.objective, 120)}`, `耗时 ${formatDuration(durationMs)}`],
            clip(goal.objective, 24),
          )
          return
        }
        if (goal.phase === 'blocked') {
          goalStarted.delete(id)
          const reason = goal.blockedReason
          emit(
            KINDS['goal-blocked'],
            [
              ...sessionLines(session, titleCache),
              `目标：${clip(goal.objective, 120)}`,
              clip(reason?.message ?? reason?.kind ?? '目标被阻塞', 60),
            ],
            clip(goal.objective, 24),
          )
        }
        return
      }

      if (event.type !== 'turn/end') return

      const kind = event.data?.reason?.kind
      const begin = startedAt.get(id)
      startedAt.delete(id)
      const durationMs = begin === undefined ? 0 : Math.max(0, event.time - begin)

      const meta = KINDS[kind]
      if (meta === undefined) return

      const turn = event.data?.turn
      const turnKey = `${id}\u0000${turn ?? ''}`
      const counted = toolCounts.get(turnKey) ?? 0
      toolCounts.delete(turnKey)
      const fromEvents = toolStats(session, turn)
      const stats = { count: Math.max(counted, fromEvents.count), names: fromEvents.names }
      trace(
        `tools: counted=${counted} fromEvents=${fromEvents.count} eventsArray=` +
          `${Array.isArray(session?.events) ? session.events.length : 'n/a'}`,
      )
      const label = sessionTitleOf(session, titleCache) || taskSnippet(session, turn)

      if (kind === 'completed') {
        if (cfg.notifyOn === 'errors') return trace('skip: notifyOn=errors')
        // 两个**客观**判据，都不依赖 agent 是否建了 goal：
        //   ① 这一轮干得够久（longTaskMs）  ② 这一轮动手够多（工具调用次数）
        if (cfg.notifyOn !== 'all' && durationMs < cfg.longTaskMs && stats.count < cfg.minToolCalls) {
          return trace(`skip: ${Math.round(durationMs / 1000)}s 且 ${stats.count} 次工具，都没到阈值`)
        }
        // 只有"长任务轮次完成"这类可重复的通知才走去抖；目标完成 / 异常 / 审批一律立刻发
        const now = Date.now()
        if (now - lastSentAt < cfg.debounceMs) return trace(`skip: 去抖窗口内（${cfg.debounceMs}ms）`)
        lastSentAt = now
        trace(`pass: ${Math.round(durationMs / 1000)}s / ${stats.count} 次工具 → 发通知`)
      }

      const lines = [...sessionLines(session, titleCache, taskSnippet(session, event.data?.turn))]
      if (stats.count > 0) lines.push(`调用了 ${stats.count} 次工具`)
      if (durationMs >= 1000) lines.push(`用时 ${formatDuration(durationMs)}`)
      if (kind === 'error') {
        const err = event.data?.reason?.error ?? {}
        lines.push(`${err.code ?? 'UNKNOWN'}: ${err.message ?? '未知错误'}`)
      }
      if (lines.filter(Boolean).length === 0) lines.push('（无摘要）')
      emit(meta, lines, label)
    } catch (error) {
      console.warn(`[dsh-notify] 处理会话事件失败: ${String(error?.message ?? error)}`)
    }
  })

  const target = [useMail ? `邮件 ${cfg.mail.to}` : '', useNtfy ? `ntfy ${cfg.ntfy.topic}` : ''].filter(Boolean).join(' + ')
  const policy = {
    errors: '仅异常',
    goals: `目标完成 / 异常 / 超 ${Math.round(cfg.longTaskMs / 60000)} 分钟 或 工具调用 ≥ ${cfg.minToolCalls} 次的轮次`,
    all: '每轮都推',
  }[cfg.notifyOn]
  const approvalPolicy = cfg.approvalTimeoutMs > 0
    ? ` · 审批超时 ${cfg.approvalTimeoutMs < 1000 ? `${cfg.approvalTimeoutMs}ms` : `${Math.round(cfg.approvalTimeoutMs / 1000)}s`} 提醒`
    : ' · 审批提醒已关闭'
  const questionPolicy = cfg.questionTimeoutMs > 0
    ? ` · 提问超时 ${cfg.questionTimeoutMs < 1000 ? `${cfg.questionTimeoutMs}ms` : `${Math.round(cfg.questionTimeoutMs / 1000)}s`} 提醒`
    : ' · 提问提醒已关闭'
  console.log(
    `[dsh-notify] 已启用 · 通道 ${cfg.channel} → ${target} · 触发 ${policy}${approvalPolicy}${questionPolicy}` +
      ` · 去抖 ${cfg.debounceMs}ms` +
      `${cfg.cleanupOld && useMail ? ` · 旧通知自动清理(${cfg.mailTag})` : ''}${dryRun ? ' · dryrun' : ''}`,
  )
  trace(`apply ready · debugTrace 已开，事件与发信结果都写进 _trace.log`)
}
