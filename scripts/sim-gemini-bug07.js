/**
 * sim-gemini-bug07.js
 *
 * Gemini Bug 7（真实）：userApi handleStateChange 未校验音源归属前先覆写 status。
 *
 * 成因：setUserApiStatus(status, errorMessage) 在归属校验之前；其余部分
 * （apis/qualitys 注册、失败弹窗、apiInitPromise resolve）都在校验之后，
 * 唯独状态写漏在前面。快速连续切源 A→B 时，A 的迟到 init 事件会先把 status
 * 写成 A 的结果（仅状态显示错误，不影响实际取链）。
 *
 * 修法（src/core/init/userApi/index.ts:150-154）：
 *   把归属检查提到 setUserApiStatus 之前；细化为仅当 info 存在且 id 不匹配
 *   时跳过（if (info && info.id !== apiSource) return），保留无 info 事件
 *   的现有语义。
 *
 * 运行：node scripts/sim-gemini-bug07.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = 'src/core/init/userApi/index.ts'
const real = fs.readFileSync(path.join(ROOT, FILE), 'utf8').replace(/\r\n/g, '\n')

const windowBetween = (src, startAnchor, endAnchor, fallback = 2000) => {
  const start = src.indexOf(startAnchor)
  if (start < 0) return ''
  const end = src.indexOf(endAnchor, start + startAnchor.length)
  return end < 0 ? src.slice(start, start + fallback) : src.slice(start, end)
}

const invariants = (src) => {
  const reasons = []
  const fn = windowBetween(src, 'const handleStateChange = ({ status, errorMessage, info }: InitParams) => {', 'const handleUserApiResponse')
  if (!fn) {
    reasons.push('handleStateChange 结构已变（找不到函数锚点）')
    return reasons
  }
  const guardAt = fn.indexOf("if (info && info.id !== settingState.setting['common.apiSource']) return")
  const setStatusAt = fn.indexOf('setUserApiStatus(status, errorMessage)')
  if (guardAt < 0) {
    reasons.push('缺少细化的归属检查（if (info && info.id !== apiSource) return）')
  }
  if (setStatusAt < 0) {
    reasons.push('找不到 setUserApiStatus 调用（结构已变）')
  }
  if (guardAt >= 0 && setStatusAt >= 0 && guardAt > setStatusAt) {
    reasons.push('归属检查仍在 setUserApiStatus 之后（迟到事件会先覆写状态）')
  }
  // 旧的"先写状态后校验"顺序不得残留：setUserApiStatus 之前不得有其他状态写
  // （细化检查必须是 info 存在且不匹配时才跳过——无 info 事件仍要写状态）
  if (/if \(!info \|\| info\.id !== settingState\.setting\['common\.apiSource'\]\) return\n    setUserApiStatus/.test(fn)) {
    reasons.push('仍是旧顺序：setUserApiStatus 在归属校验之前')
  }
  // 后续的 !info 守卫仍保留（无 info 事件不做注册）
  const laterGuardAt = fn.indexOf("if (!info || info.id !== settingState.setting['common.apiSource']) return", setStatusAt)
  if (laterGuardAt < 0) {
    reasons.push('setUserApiStatus 之后的 !info 守卫丢失（无 info 事件会继续走注册流程）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 行为模型：1:1 复刻检查顺序（切源 / 迟到事件 / 无 info 事件）
// ---------------------------------------------------------------------------
const makeState = () => ({ apiSource: 'B', statusWrites: [], registered: [] })
const handleStateChange = (state, { status, errorMessage, info }) => {
  if (info && info.id !== state.apiSource) return 'skipped-stale'
  state.statusWrites.push({ status, errorMessage })
  if (!info || info.id !== state.apiSource) return 'status-only'
  state.registered.push(info.id)
  return 'registered'
}

const models = []
{
  const state = makeState()
  const r = handleStateChange(state, { status: false, errorMessage: 'A failed', info: { id: 'A' } })
  models.push(['切源 A→B 后 A 的迟到失败事件：状态不被覆写',
    r === 'skipped-stale' && state.statusWrites.length === 0 && state.registered.length === 0])
}
{
  const state = makeState()
  const r = handleStateChange(state, { status: true, errorMessage: '', info: { id: 'B' } })
  models.push(['当前音源 B 的事件：正常写状态并注册',
    r === 'registered' && state.statusWrites.length === 1 && state.registered[0] === 'B'])
}
{
  const state = makeState()
  const r = handleStateChange(state, { status: false, errorMessage: 'init failed', info: null })
  models.push(['无 info 事件：保留现有语义，仍写状态，但不做注册',
    r === 'status-only' && state.statusWrites.length === 1 && state.registered.length === 0])
}
{
  const state = makeState()
  handleStateChange(state, { status: false, errorMessage: 'A failed', info: { id: 'A' } })
  handleStateChange(state, { status: true, errorMessage: '', info: { id: 'B' } })
  models.push(['迟到 A 事件 + 正常 B 事件：最终状态是 B 的',
    state.statusWrites.length === 1 && state.statusWrites[0].status === true])
}

const failedModels = models.filter(([, ok]) => !ok)

// ---------------------------------------------------------------------------
// 反例自检
// ---------------------------------------------------------------------------
const tamper = (src, find, replace) => {
  if (!src.includes(find)) throw new Error(`tamper 锚点未命中: ${find}`)
  return src.split(find).join(replace)
}
const cases = []
const checkCase = (name, src, expectSubstr) => {
  let reasons = []
  try {
    reasons = invariants(src)
  } catch (err) {
    cases.push([name, false, `抛异常: ${err.message}`])
    return
  }
  const hit = reasons.some((r) => r.includes(expectSubstr))
  cases.push([name, hit, hit ? '已拦下' : `未拦下（reasons=${JSON.stringify(reasons)}）`])
}

checkCase('C1 恢复旧顺序（先写状态后校验）',
  tamper(real,
    "    if (info && info.id !== settingState.setting['common.apiSource']) return\n    setUserApiStatus(status, errorMessage)\n",
    "    setUserApiStatus(status, errorMessage)\n"),
  '缺少细化的归属检查')
checkCase('C2 细化检查改成 !info 也跳过（无 info 事件不再写状态）',
  tamper(real,
    "if (info && info.id !== settingState.setting['common.apiSource']) return",
    "if (!info || info.id !== settingState.setting['common.apiSource']) return",
    ),
  '缺少细化的归属检查')

const missed = cases.filter(([, ok]) => !ok)

console.log('行为模型（音源归属检查顺序）')
for (const [name, ok] of models) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
console.log('')
console.log('反例自检')
for (const [name, ok, detail] of cases) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} —— ${detail}`)
console.log('')

let failed = 0
const realReasons = invariants(real)
if (realReasons.length) {
  console.error(`FAIL  Bug 7 契约未通过（${realReasons.length} 项）：`)
  for (const r of realReasons) console.error(`        - ${r}`)
  failed += 1
}
if (failedModels.length) {
  console.error(`FAIL  行为模型未通过（${failedModels.length} 项）`)
  failed += 1
}
if (missed.length) {
  console.error(`FAIL  有反例未被拦下（${missed.length} 项，断言无区分力）`)
  failed += 1
}
if (!failed) {
  console.log(`PASS  Bug 7 契约通过（结构不变量 4 项 + 行为模型 ${models.length} 例 + 反例 ${cases.length} 例）`)
  process.exit(0)
}
process.exit(1)
