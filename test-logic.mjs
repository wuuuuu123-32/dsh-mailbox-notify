// dryrun 逻辑测试：验证"什么情况才推送"
// 注意：去抖基于真实墙上时间，测试里关掉（debounceMs: 0），才能逐个验证判据。
// 审批超时用的是毫秒级短阈值；合并窗口（APPROVAL_MERGE_MS = 3 秒）是内部常量，
// 所以审批用例要真的等一会儿 —— 整个脚本约 8 秒跑完。
process.env.DSH_NOTIFY_DRYRUN = '1'
const { apply } = await import('./index.js')

const handlers = []
apply({ on: (_name, fn) => handlers.push(fn) }, { debounceMs: 0, approvalTimeoutMs: 40 })
const fire = (session, event) => handlers[0](session, event)

const show = label => console.log(`\n### ${label}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const plain = { id: 's-test', header: {}, events: [] }
let n = 0

show('① 短问答：4 秒、没调工具 → 不该推')
n++
fire(plain, { type: 'turn/start', time: 1000, data: { turn: n } })
fire(plain, { type: 'turn/end', time: 5000, data: { turn: n, reason: { kind: 'completed' } } })

show('② 长任务：10 分钟（超过 3 分钟阈值）→ 该推')
n++
fire(plain, { type: 'turn/start', time: 10000, data: { turn: n } })
fire(plain, { type: 'turn/end', time: 610000, data: { turn: n, reason: { kind: 'completed' } } })

// 新判据：工具调用次数（不依赖 agent 建 goal）
const toolSession = (id, names, base) => ({
  id,
  header: {},
  events: [
    { type: 'turn/start', time: base, data: { turn: 1 } },
    ...names.map((name, i) => ({ type: 'tool/call', time: base + 100 * (i + 1), data: { turn: 1, step: 1, name } })),
  ],
})

show('③ 只花 0.6 秒，但调了 5 次工具 → 该推【客观判据】')
const many = toolSession('s-many', ['read', 'grep', 'write', 'edit', 'pwsh'], 20000)
fire(many, { type: 'turn/start', time: 20000, data: { turn: 1 } })
fire(many, { type: 'turn/end', time: 20600, data: { turn: 1, reason: { kind: 'completed' } } })

show('④ 只调 2 次工具、又不到 3 分钟 → 不该推')
const few = toolSession('s-few', ['read', 'read'], 30000)
fire(few, { type: 'turn/start', time: 30000, data: { turn: 1 } })
fire(few, { type: 'turn/end', time: 30300, data: { turn: 1, reason: { kind: 'completed' } } })

show('⑤ 出错 → 该推')
fire(plain, { type: 'turn/end', time: 70000, data: { reason: { kind: 'error', error: { code: 'E_TEST', message: '示例错误' } } } })

show('⑥ 目标完成 → 该推')
fire(plain, { type: 'goal/change', time: 80000, data: { kind: 'goal/change', goal: { phase: 'active', objective: '把实验9报告做出来' } } })
fire(plain, { type: 'goal/change', time: 90000, data: { kind: 'goal/change', goal: { phase: 'complete', objective: '把实验9报告做出来' } } })

/* ------------------------- 需求 1：认出"是哪个任务" ------------------------- */

show('⑦ 完成通知带上会话标题 / 工作区 → 该推')
const titled = toolSession('s-titled', ['read', 'grep', 'write', 'edit', 'pwsh'], 100000)
titled.header = { cwd: 'D:\\dsh\\config' }
fire(titled, { type: 'session/title', time: 99000, data: { title: '优化邮件提醒插件', messageSeqs: [1], source: { kind: 'fallback' } } })
fire(titled, { type: 'turn/start', time: 100000, data: { turn: 1 } })
fire(titled, { type: 'turn/end', time: 106000, data: { turn: 1, reason: { kind: 'completed' } } })

/* --------------------------- 需求 2：审批超时提醒 --------------------------- */

const appr = { id: 's-approval-1', header: { cwd: 'D:\\dsh\\config' }, events: [] }
fire(appr, { type: 'session/title', time: 1, data: { title: '把数据整理成表格', messageSeqs: [1], source: { kind: 'fallback' } } })

show('⑧ 审批挂起超过 40ms 没人点 → 该推（列出等的是哪个会话、什么操作）')
fire(appr, {
  type: 'approval/asked',
  time: Date.now(),
  data: { id: 'req-1', toolName: 'pwsh', reason: 'escalate sandbox to danger-full-access: 需要写入工作区之外的文件' },
})
await sleep(3600)

show('⑨ 审批 20ms 内就被点掉 → 不该推（屏幕上没人被卡住）')
fire(appr, { type: 'approval/asked', time: Date.now(), data: { id: 'req-2', toolName: 'edit', reason: '写工作区外的文件' } })
await sleep(20)
fire(appr, { type: 'approval/decided', time: Date.now(), data: { id: 'req-2', outcome: 'allowed-once' } })
await sleep(200)
console.log('（上面这一段没有输出 = 正确）')

show('⑩ 两个审批同时挂住 → 合并进同一封邮件（而不是刷两封）')
fire(appr, { type: 'approval/asked', time: Date.now(), data: { id: 'req-3', toolName: 'pwsh', reason: '需要提权执行 git push' } })
fire(appr, { type: 'approval/asked', time: Date.now(), data: { id: 'req-4', toolName: 'write', reason: '写入 C:\\Users\\123\\.dsh\\AGENTS.md' } })
await sleep(3600)

show('⑪ 子代理会话的普通完成通知 → 不该推（避免被 subagent 刷屏）')
const child = toolSession('s-child', ['read', 'grep', 'write', 'edit', 'pwsh'], 200000)
child.header = { parentSession: 's-test', delegationDepth: 1 }
fire(child, { type: 'turn/start', time: 200000, data: { turn: 1 } })
fire(child, { type: 'turn/end', time: 206000, data: { turn: 1, reason: { kind: 'completed' } } })

console.log('\n=== 测试结束 ===')
console.log('（去抖场景需要真实时间流逝，不在此测试中验证）')
