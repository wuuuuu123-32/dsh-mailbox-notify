// 验证"新通知自动删旧通知"这条链路
import { readFileSync } from 'node:fs'
import { sendMail, dropOldMails, } from './index.js'

const file = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'))
const full = {
  mail: { ...file.mail, timeoutMs: 25000 },
  imap: file.imap ?? { host: 'imap.qq.com', port: 993 },
  mailTag: file.mailTag ?? '[dsh]',
  timeoutMs: 25000,
}
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64')

console.log('1) 发一封带前缀的测试通知')
await sendMail(
  full.mail,
  `${full.mailTag} =?UTF-8?B?${b64('清理功能测试')}?=`,
  '这封马上会被下一条通知自动删掉，邮箱里不会留痕。',
)
console.log('   已发送')

console.log('2) 搜索并删除带前缀的旧通知')
const removed = await dropOldMails(full)
console.log(`   删除了 ${removed} 封`)

console.log('3) 再搜一次确认已清空')
const left = await dropOldMails(full)
console.log(`   剩余 ${left} 封`)
