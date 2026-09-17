// 彻底清理所有文件夹里主题含 "dsh" 的通知邮件，然后发一封新的
import tls from 'node:tls'
import { readFileSync } from 'node:fs'
import { sendMail } from './index.js'

const file = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'))
const USER = file.mail.user
const PASS = file.mail.pass
const IMAP_HOST = file.imap?.host ?? 'imap.qq.com'
const IMAP_PORT = file.imap?.port ?? 993
const TAG = file.mailTag ?? '[dsh-notify]'

const quote = s => `"${String(s).replace(/([\\"])/g, '\\$1')}"`

function makeReader(socket) {
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

const socket = tls.connect({ host: IMAP_HOST, port: IMAP_PORT, servername: IMAP_HOST })
await new Promise((resolve, reject) => {
  socket.once('secureConnect', resolve)
  socket.once('error', reject)
})
const wait = makeReader(socket)
const say = line => socket.write(`${line}\r\n`)

await wait('*')
say(`t1 LOGIN ${quote(USER)} ${quote(PASS)}`)
const login = await wait('t1')
if (!/\bt1 OK/i.test(login.join('\n'))) {
  console.log('IMAP 登录失败：' + login[login.length - 1])
  process.exit(1)
}
console.log('IMAP 登录成功')

say('t2 LIST "" "*"')
const listed = await wait('t2')
const folders = listed
  .filter(l => l.startsWith('* LIST'))
  .map(l => {
    const m = /(?:"([^"]*)"|(\S+))\s*$/.exec(l)
    return m ? (m[1] ?? m[2]) : null
  })
  .filter(Boolean)

console.log(`发现 ${folders.length} 个文件夹\n`)

let total = 0
for (const folder of folders) {
  say(`t3 SELECT ${quote(folder)}`)
  const sel = await wait('t3')
  if (!/\bt3 OK/i.test(sel.join('\n'))) {
    console.log(`  [跳过] ${folder}`)
    continue
  }
  say('t4 SEARCH SUBJECT "dsh"')
  const res = await wait('t4')
  const hit = res.find(l => l.startsWith('* SEARCH'))
  const ids = hit ? hit.slice('* SEARCH'.length).trim().split(/\s+/).filter(Boolean) : []
  if (ids.length === 0) continue
  say(`t5 STORE ${ids.join(',')} +FLAGS (\\Deleted)`)
  await wait('t5')
  say('t6 EXPUNGE')
  await wait('t6')
  console.log(`  [已删 ${ids.length} 封] ${folder}`)
  total += ids.length
}
say('t9 LOGOUT')
socket.end()
console.log(`\n合计删除 ${total} 封`)

// 再发一封新的（新的前缀）
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64')
await sendMail(
  { ...file.mail, timeoutMs: 25000 },
  `${TAG} =?UTF-8?B?${b64('清理完成，这是一封新通知')}?=`,
  [
    '旧的 [dsh] 测试邮件已从所有文件夹彻底删除。',
    '',
    '这是新规则下的第一封通知，特征是主题以 [dsh-notify] 开头。',
    '以后每发一封新的，上一封会被自动删掉，邮箱里最多只会有一封。',
    '',
    `发送时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
  ].join('\n'),
)
console.log('新通知已发送 ✓')
