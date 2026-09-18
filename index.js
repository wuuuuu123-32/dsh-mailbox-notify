/**
 * dsh-notify —— 只在该打扰你的时候，把通知推到你手机。
 *
 * 触发条件（config.json 里的 notifyOn 决定宽严）：
 *   'errors'  只推异常：出错 / 中断
 *   'goals'   异常 + 目标完成 + 超长任务（默认，推荐）
 *   'all'     每一轮回答结束都推（最吵）
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

import { readFileSync } from 'node:fs'
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
  mail: { host: '', port: 465, user: '', pass: '', to: '' },
  imap: { host: 'imap.qq.com', port: 993 },
  ntfy: { topic: '', server: 'https://ntfy.sh' },
  timeoutMs: 25000,
}

const KINDS = {
  completed: { title: '✅ 任务完成', tag: 'white_check_mark', priority: 'default' },
  'goal-completed': { title: '🎯 目标完成', tag: 'tada', priority: 'default' },
  'goal-blocked': { title: '⚠️ 目标受阻', tag: 'warning', priority: 'high' },
  error: { title: '❌ 任务出错', tag: 'rotating_light', priority: 'high' },
  aborted: { title: '⚠️ 任务中断', tag: 'warning', priority: 'high' },
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
    timeoutMs: toInt(pick(env.DSH_NOTIFY_TIMEOUT_MS, file.timeoutMs), DEFAULTS.timeoutMs),
    mail: {
      host: String(pick(env.DSH_NOTIFY_SMTP_HOST, mail.host, DEFAULTS.mail.host)),
      port: toInt(pick(mail.port, DEFAULTS.mail.port), DEFAULTS.mail.port),
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

/* --------------------------------- 邮件通道 -------------------------------- */

export async function sendMail(cfg, subject, text) {
  if (!cfg.host || !cfg.user || !cfg.pass || !cfg.to) throw new Error('邮件配置不完整')

  const socket = await connectTls(cfg.host, cfg.port, cfg.timeoutMs)
  const read = makeSmtpReader(socket)
  const expect = async code => {
    const raw = await read()
    const first = raw.split('\n')[0]
    if (!first.startsWith(String(code))) throw new Error(`SMTP 未返回 ${code}：${first}`)
  }
  const say = line => socket.write(`${line}\r\n`)

  try {
    await expect(220)
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

  const startedAt = new Map()
  const goalStarted = new Map()
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
    await sendMail({ ...cfg.mail, timeoutMs: cfg.timeoutMs }, `${cfg.mailTag} ${headerText(meta.title)}`, body)
    console.log(`[dsh-notify] 邮件已发送 → ${cfg.mail.to}`)
  }

  /** 只有"长任务轮次完成"这类可重复的通知才走去抖；目标完成 / 异常一律立刻发。 */
  const emit = (meta, lines, debounce = false) => {
    if (debounce) {
      const now = Date.now()
      if (now - lastSentAt < cfg.debounceMs) return
      lastSentAt = now
    }
    const body = [...lines, '', `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`]
      .filter(l => l !== undefined && l !== null && l !== '')
      .join('\n')
    if (useMail) {
      deliverMail(meta, body).catch(e => console.warn(`[dsh-notify] 邮件发送失败: ${String(e?.message ?? e)}`))
    }
    if (!dryRun && useNtfy) sendNtfy(cfg, meta, body)
  }

  ctx.on('session/event', (session, event) => {
    try {
      const header = session?.header
      if (header?.parentSession || (Number(header?.delegationDepth) || 0) > 0) return
      const id = session?.id
      if (id === undefined || id === null) return

      /* ---- 轮次 ---- */
      if (event.type === 'turn/start') {
        startedAt.set(id, event.time)
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
          emit(KINDS['goal-completed'], [clip(goal.objective), `耗时 ${formatDuration(durationMs)}`])
          return
        }
        if (goal.phase === 'blocked') {
          goalStarted.delete(id)
          const reason = goal.blockedReason
          emit(KINDS['goal-blocked'], [clip(goal.objective), clip(reason?.message ?? reason?.kind ?? '目标被阻塞', 60)])
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

      const stats = toolStats(session, event.data?.turn)

      if (kind === 'completed') {
        if (cfg.notifyOn === 'errors') return
        // 两个**客观**判据，都不依赖 agent 是否建了 goal：
        //   ① 这一轮干得够久（longTaskMs）  ② 这一轮动手够多（工具调用次数）
        if (cfg.notifyOn !== 'all' && durationMs < cfg.longTaskMs && stats.count < cfg.minToolCalls) return
      }

      const lines = [taskSnippet(session, event.data?.turn)]
      if (stats.count > 0) lines.push(`调用了 ${stats.count} 次工具`)
      if (durationMs >= 1000) lines.push(`用时 ${formatDuration(durationMs)}`)
      if (kind === 'error') {
        const err = event.data?.reason?.error ?? {}
        lines.push(`${err.code ?? 'UNKNOWN'}: ${err.message ?? '未知错误'}`)
      }
      if (lines.filter(Boolean).length === 0) lines.push('（无摘要）')
      emit(meta, lines, kind === 'completed')
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
  console.log(
    `[dsh-notify] 已启用 · 通道 ${cfg.channel} → ${target} · 触发 ${policy} · 去抖 ${cfg.debounceMs}ms` +
      `${cfg.cleanupOld && useMail ? ` · 旧通知自动清理(${cfg.mailTag})` : ''}${dryRun ? ' · dryrun' : ''}`,
  )
}
