import { readFileSync } from 'node:fs'
import { sendMail } from './index.js'

const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'))

// 1) 邮件通道实测
try {
  await sendMail(
    { ...cfg.mail, timeoutMs: 25000 },
    'dsh 邮件通道测试',
    [
      '如果你收到这封邮件，说明邮件通道打通了。',
      '',
      '以后每次我这边一轮任务结束，插件都会自动发一封，不需要谁去"记得"。',
      '出错和中断也会发，标题里带 ❌ / ⚠️。',
      '',
      `测试时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ].join('\n'),
  )
  console.log('邮件: 已发送 ✓')
} catch (error) {
  console.log('邮件: 失败 ✗ ' + (error?.message ?? error))
}

// 2) 看看 ntfy 主题里到底有哪些消息（含插件自动发的）
try {
  const r = await fetch('https://ntfy.sh/' + cfg.ntfy.topic + '/json?poll=1')
  const text = await r.text()
  const rows = text.trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean).filter(m => m.event === 'message')
  console.log(`\nntfy 历史消息 ${rows.length} 条：`)
  for (const m of rows) {
    const t = m.time ? new Date(m.time * 1000).toLocaleString('zh-CN', { hour12: false }) : '?'
    const title = m.title ? Buffer.from(String(m.title), 'base64').toString('utf8') : '(无标题)'
    const shown = /[\u4e00-\u9fa5]/.test(title) ? title : (m.title ?? '(无标题)')
    console.log(`  [${t}] ${shown} | ${String(m.message ?? '').replace(/\n/g, ' / ').slice(0, 70)}`)
  }
} catch (error) {
  console.log('ntfy 历史: 读取失败 ' + (error?.message ?? error))
}
