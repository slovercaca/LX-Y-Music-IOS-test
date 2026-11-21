/**
 * sim-gemini-bug03.js
 *
 * Gemini Bug 3（真实）：pauseResumePosition 长暂停恢复意图缺少 musicId 绑定。
 *
 * 成因：暂停恢复意图只有位置+时间戳，无 track 绑定；消费处（playing 事件）
 * 无任何歌曲校验。姊妹机制 restorePlayTime 已有 restorePlayTimeTrack 绑定，
 * 本变量是同类修复的遗漏。暂停在线歌 A ≥5 秒 → 切歌且 stopped 事件被吞 →
 * 新在线歌 B 一出声就被 seek 到 A 的暂停位置（B 不从头播）。
 *
 * 修法（src/core/init/player/playProgress.ts）：
 *   照 restorePlayTimeTrack 模式加 pauseResumeTrack 绑定，消费时比对、
 *   不匹配丢弃；并在 handleSetPlayInfo（切歌）处清空。
 *
 * 运行：node scripts/sim-gemini-bug03.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = 'src/core/init/player/playProgress.ts'
const real = fs.readFileSync(path.join(ROOT, FILE), 'utf8').replace(/\r\n/g, '\n')

const windowBetween = (src, startAnchor, endAnchor, fallback = 3000) => {
  const start = src.indexOf(startAnchor)
  if (start < 0) return ''
  const end = src.indexOf(endAnchor, start + startAnchor.length)
  return end < 0 ? src.slice(start, start + fallback) : src.slice(start, end)
}

const invariants = (src) => {
  const reasons = []

  if (!/let pauseResumeTrack: string \| null = null/.test(src)) {
    reasons.push('缺 pauseResumeTrack 绑定（长暂停恢复意图无歌曲归属）')
  }

  // ① 记录时绑定当前歌曲
  const pausedCase = windowBetween(src, "      case 'paused':", "      case 'buffering':")
  if (!/pauseResumeTrack = pauseResumePosition == null \? null : musicId/.test(pausedCase)) {
    reasons.push('暂停记录意图时未绑定当前歌曲（pauseResumeTrack 未赋值）')
  }

  // ② 消费时比对，不匹配丢弃
  const playingCase = windowBetween(src, "      case 'playing': {", "      case 'buffering':")
  const recovery = windowBetween(playingCase, 'if (pauseResumePosition != null) {', 'break', 1200)
  if (!/const recoveryTrack = pauseResumeTrack/.test(recovery)) {
    reasons.push('消费意图时未取出绑定的歌曲（recoveryTrack）')
  }
  if (!/recoveryTrack == musicId/.test(recovery)) {
    reasons.push('长暂停恢复未校验意图歌曲与当前歌曲一致（切歌后残留意图会打到新歌）')
  }
  if (!/pauseResumeTrack = null/.test(recovery)) {
    reasons.push('消费意图时未清空 pauseResumeTrack')
  }

  // ③ 各清除路径同步清 track
  const setProgressWindow = windowBetween(src, 'const setProgress = (time: number, maxTime?: number) => {', 'void setCurrentTime(time).then(', 1600)
  if (!/pauseResumeTrack = null/.test(setProgressWindow)) {
    reasons.push('用户自己 seek 后未清 pauseResumeTrack')
  }
  const stopWindow = windowBetween(src, 'const handleStop = () => {', 'const handleError = () => {', 1600)
  if (!/pauseResumeTrack = null/.test(stopWindow)) {
    reasons.push('切歌/停播（handleStop）未清 pauseResumeTrack')
  }
  const toggledWindow = windowBetween(src, 'const handleSetPlayInfo = () => {', 'const handleConfigUpdated', 1600)
  if (!/pauseResumeTrack = null/.test(toggledWindow)) {
    reasons.push('handleSetPlayInfo（切歌）未清 pauseResumeTrack')
  }
  const stoppedBranch = windowBetween(src, "} else if (event.state === 'stopped') {", 'break', 400)
  if (!/pauseResumeTrack = null/.test(stoppedBranch)) {
    reasons.push('stopped 分支未清 pauseResumeTrack')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 行为模型：1:1 复刻绑定 / 消费 / 清除
// ---------------------------------------------------------------------------
const makeState = () => ({ pauseResumePosition: null, pauseResumeAt: 0, pauseResumeTrack: null })
const recordPause = (state, position, at, track) => {
  state.pauseResumePosition = position > 0 ? position : null
  state.pauseResumeAt = state.pauseResumePosition == null ? 0 : at
  state.pauseResumeTrack = state.pauseResumePosition == null ? null : track
}
const handlePlaying = (state, { now, musicId, minMs = 5000 }) => {
  let seek = null
  if (state.pauseResumePosition != null) {
    const recoveryTime = state.pauseResumePosition
    const recoveryTrack = state.pauseResumeTrack
    const pauseDurationMs = now - state.pauseResumeAt
    state.pauseResumeTrack = null
    state.pauseResumePosition = null
    state.pauseResumeAt = 0
    if (pauseDurationMs >= minMs && recoveryTime > 0 && recoveryTrack === musicId) seek = recoveryTime
  }
  return seek
}
const clearIntent = (state) => {
  state.pauseResumePosition = null
  state.pauseResumeAt = 0
  state.pauseResumeTrack = null
}

const models = []
{
  // 核心回归：暂停 A ≥5s → 切歌到 B（stopped 事件被吞，意图残留）→ B 出声
  const state = makeState()
  recordPause(state, 120, 1000, 'A')
  const seek = handlePlaying(state, { now: 61000, musicId: 'B' })
  models.push(['暂停 A 后切歌到 B（stopped 被吞）：B 出声不被拉回 A 的暂停位置', seek === null])
}
{
  const state = makeState()
  recordPause(state, 120, 1000, 'A')
  const seek = handlePlaying(state, { now: 61000, musicId: 'A' })
  models.push(['同歌长暂停恢复：仍精确拉回暂停位置', seek === 120])
}
{
  const state = makeState()
  recordPause(state, 120, 1000, 'A')
  clearIntent(state) // handleSetPlayInfo（切歌）清空
  const seek = handlePlaying(state, { now: 61000, musicId: 'A' })
  models.push(['切歌时意图已清空：后续 playing 不再拉回', seek === null && state.pauseResumeTrack === null])
}
{
  const state = makeState()
  recordPause(state, 120, 1000, 'A')
  const first = handlePlaying(state, { now: 61000, musicId: 'B' }) // 不匹配丢弃并消费
  const second = handlePlaying(state, { now: 61500, musicId: 'A' }) // 迟到的 A playing 也不再有意图
  models.push(['不匹配的意图被消费掉，不留给后续事件', first === null && second === null])
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

checkCase('C1 消费时去掉歌曲比对',
  tamper(real, 'recoveryTime > 0 && recoveryTrack == musicId && event.driver', 'recoveryTime > 0 && event.driver'),
  '未校验意图歌曲')
checkCase('C2 记录时不绑定歌曲',
  tamper(real, '          pauseResumeTrack = pauseResumePosition == null ? null : musicId\n', ''),
  '未绑定当前歌曲')
checkCase('C3 切歌时不清意图',
  tamper(real, '    pauseResumePosition = null\n    pauseResumeAt = 0\n    pauseResumeTrack = null\n    // Skip the startup restore transition', '    // Skip the startup restore transition'),
  'handleSetPlayInfo')

const missed = cases.filter(([, ok]) => !ok)

console.log('行为模型（长暂停恢复意图绑定）')
for (const [name, ok] of models) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
console.log('')
console.log('反例自检')
for (const [name, ok, detail] of cases) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} —— ${detail}`)
console.log('')

let failed = 0
const realReasons = invariants(real)
if (realReasons.length) {
  console.error(`FAIL  Bug 3 契约未通过（${realReasons.length} 项）：`)
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
  console.log(`PASS  Bug 3 契约通过（结构不变量 8 项 + 行为模型 ${models.length} 例 + 反例 ${cases.length} 例）`)
  process.exit(0)
}
process.exit(1)
