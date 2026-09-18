// dryrun 逻辑测试：验证"什么情况才推送"
// 注意：去抖基于真实墙上时间，测试里关掉（debounceMs: 0），才能逐个验证判据。
process.env.DSH_NOTIFY_DRYRUN = '1'
const { apply } = await import('./index.js')

const handlers = []
apply({ on: (_name, fn) => handlers.push(fn) }, { debounceMs: 0 })
const fire = (session, event) => handlers[0](session, event)

const show = label => console.log(`\n### ${label}`)
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

show('③ 只花 0.6 秒，但调了 5 次工具 → 该推【新增判据】')
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

console.log('\n=== 测试结束 ===')
console.log('（去抖场景需要真实时间流逝，不在此测试中验证）')
