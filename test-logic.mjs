// dryrun 逻辑测试：验证"什么情况才推送"
process.env.DSH_NOTIFY_DRYRUN = '1'
const { apply } = await import('./index.js')

const handlers = []
apply({ on: (_name, fn) => handlers.push(fn) }, {})
const fire = (session, event) => handlers[0](session, event)

const session = { id: 's-test', header: {}, events: [] }
let n = 0
const show = label => console.log(`\n### ${label}`)

show('场景1：短问答（4 秒）→ 不该推')
n++
fire(session, { type: 'turn/start', time: 1000, data: { turn: n } })
fire(session, { type: 'turn/end', time: 5000, data: { turn: n, reason: { kind: 'completed' } } })

show('场景2：长任务轮次（10 分钟）→ 该推')
n++
fire(session, { type: 'turn/start', time: 10000, data: { turn: n } })
fire(session, { type: 'turn/end', time: 610000, data: { turn: n, reason: { kind: 'completed' } } })

show('场景3：出错 → 该推')
fire(session, { type: 'turn/end', time: 620000, data: { reason: { kind: 'error', error: { code: 'E_TEST', message: '示例错误' } } } })

show('场景4：目标完成 → 该推')
fire(session, { type: 'goal/change', time: 630000, data: { kind: 'goal/change', goal: { phase: 'active', objective: '把实验9报告做出来' } } })
fire(session, { type: 'goal/change', time: 900000, data: { kind: 'goal/change', goal: { phase: 'complete', objective: '把实验9报告做出来' } } })

show('场景5：目标完成后立刻又来一个目标完成 → 该推（目标通知不去抖）')
fire(session, { type: 'goal/change', time: 901000, data: { kind: 'goal/change', goal: { phase: 'active', objective: '第二个目标' } } })
fire(session, { type: 'goal/change', time: 905000, data: { kind: 'goal/change', goal: { phase: 'complete', objective: '第二个目标' } } })

show('场景6：两个长任务轮次紧挨着（相隔 3 秒）→ 第二个该被去抖')
n++
fire(session, { type: 'turn/start', time: 1000000, data: { turn: n } })
fire(session, { type: 'turn/end', time: 1400000, data: { turn: n, reason: { kind: 'completed' } } })
n++
fire(session, { type: 'turn/start', time: 1401000, data: { turn: n } })
fire(session, { type: 'turn/end', time: 1800000, data: { turn: n, reason: { kind: 'completed' } } })

console.log('\n=== 测试结束 ===')
