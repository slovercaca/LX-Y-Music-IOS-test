/**
 * sim-gemini-bug10.js
 *
 * Gemini Bug 10（真实）：PactModal 直接调用裸 Navigation.dismissOverlay，
 * 缺少重试与异常捕获。
 *
 * 成因：handleConfirm 内 void Navigation.dismissOverlay(componentId) 裸调用，
 * 无 .catch、无重试。同仓已有带重试+捕获的封装 src/navigation/utils.ts:9-23
 * （注释明确承认该 API 偶发失败，透明 overlay 残留会因 interceptTouchOutside
 * 拦截全屏触摸致"假死"），其他调用点都遵守该口径，唯独 PactModal 用裸调用。
 * 快速双击"接受"、或 overlay 已被其他路径关掉时 reject → 未处理 rejection；
 * 关闭失败则协议弹窗残留且拦截全屏触摸，且 isAgreePact 已写 true。
 *
 * 修法（src/navigation/components/PactModal.tsx）：
 *   改调 @/navigation 的 dismissOverlay 封装（自带一次重试+捕获）；顺手对
 *   按钮加防双击（ref 同步拦截 + disabled 视觉反馈）。
 *   注：全仓其他裸 dismissOverlay 调用点是 deferred 项，不在本脚本范围。
 *
 * 运行：node scripts/sim-gemini-bug10.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = 'src/navigation/components/PactModal.tsx'
const real = fs.readFileSync(path.join(ROOT, FILE), 'utf8').replace(/\r\n/g, '\n')

const windowBetween = (src, startAnchor, endAnchor, fallback = 2000) => {
  const start = src.indexOf(startAnchor)
  if (start < 0) return ''
  const end = src.indexOf(endAnchor, start + startAnchor.length)
  return end < 0 ? src.slice(start, start + fallback) : src.slice(start, end)
}

const invariants = (src) => {
  const reasons = []
  if (!/import \{ dismissOverlay \} from '@\/navigation'/.test(src)) {
    reasons.push('未从 @/navigation 引入带重试+捕获的 dismissOverlay 封装')
  }
  const fn = windowBetween(src, 'const handleConfirm = () => {', 'const confirmBtn = useMemo')
  if (!/void dismissOverlay\(componentId\)/.test(fn)) {
    reasons.push('handleConfirm 未调用封装的 dismissOverlay(componentId)')
  }
  // 裸调用不得残留在可执行代码里（注释行除外）
  const codeLines = src.split('\n').filter((line) => !line.trim().startsWith('//'))
  const code = codeLines.join('\n')
  if (/Navigation\.dismissOverlay\(componentId\)/.test(code)) {
    reasons.push('仍有裸 Navigation.dismissOverlay(componentId) 调用残留')
  }
  if (/import \{ Navigation \} from 'react-native-navigation'/.test(src)) {
    reasons.push('react-native-navigation 的 Navigation 导入已无用（应随裸调用一并移除）')
  }
  // 防双击
  if (!/const confirmingRef = useRef\(false\)/.test(src)) {
    reasons.push('缺防双击 ref（confirmingRef）')
  }
  if (!/if \(confirmingRef\.current\) return/.test(fn)) {
    reasons.push('handleConfirm 缺 ref 同步防双击拦截')
  }
  if (!/disabled=\{confirmBtn\.disabled \|\| confirming\}/.test(src)) {
    reasons.push('确认按钮的 disabled 未接入 confirming 状态')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 行为模型：1:1 复刻防双击 + 封装调用
// ---------------------------------------------------------------------------
const makeFooter = () => {
  const state = { confirmingRef: false, dismissCalls: 0, agreed: false }
  const dismissOverlay = () => { state.dismissCalls++ }
  const handleConfirm = () => {
    if (state.confirmingRef) return 'blocked'
    state.confirmingRef = true
    state.agreed = true
    dismissOverlay()
    return 'confirmed'
  }
  return { state, handleConfirm }
}

const models = []
{
  const { state, handleConfirm } = makeFooter()
  const r1 = handleConfirm()
  const r2 = handleConfirm() // 同一 tick 内快速双击
  const r3 = handleConfirm()
  models.push(['快速双击/三击"接受"：只调一次 dismissOverlay',
    r1 === 'confirmed' && r2 === 'blocked' && r3 === 'blocked' && state.dismissCalls === 1])
}
{
  const { state, handleConfirm } = makeFooter()
  handleConfirm()
  models.push(['确认后 isAgreePact 写入与关闭同时发生', state.agreed === true && state.dismissCalls === 1])
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

checkCase('C1 改回裸 Navigation.dismissOverlay',
  tamper(real, 'void dismissOverlay(componentId)', 'void Navigation.dismissOverlay(componentId)'),
  '裸 Navigation.dismissOverlay')
checkCase('C2 去掉防双击拦截',
  tamper(real, '    if (confirmingRef.current) return\n    confirmingRef.current = true\n    setConfirming(true)\n', ''),
  '缺 ref 同步防双击拦截')
checkCase('C3 按钮 disabled 不接 confirming',
  tamper(real, 'disabled={confirmBtn.disabled || confirming}', 'disabled={confirmBtn.disabled}'),
  '未接入 confirming')

const missed = cases.filter(([, ok]) => !ok)

console.log('行为模型（PactModal 确认关闭）')
for (const [name, ok] of models) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
console.log('')
console.log('反例自检')
for (const [name, ok, detail] of cases) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} —— ${detail}`)
console.log('')

let failed = 0
const realReasons = invariants(real)
if (realReasons.length) {
  console.error(`FAIL  Bug 10 契约未通过（${realReasons.length} 项）：`)
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
  console.log(`PASS  Bug 10 契约通过（结构不变量 7 项 + 行为模型 ${models.length} 例 + 反例 ${cases.length} 例）`)
  process.exit(0)
}
process.exit(1)
