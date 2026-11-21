/**
 * sim-gemini-bug01.js
 *
 * Gemini Bug 1（真实）：setProgress 异步回调缺少切歌与 seekGen 代际校验。
 *
 * 成因：setProgress 内 setCurrentTime 的稳定化轮询最长约 1.5s，回调返回时
 * 可能已切歌或用户又发起了新 seek；旧回调只判 musicInfo.id 非空，直接把旧
 * 落点写进新歌进度条并以旧落点重开 2s 锁窗（拦截新歌真实位置更新）。
 *
 * 修法（src/core/init/player/playProgress.ts 的 setProgress）：
 *   回调内捕获 genAtCall = ++seekGen，校验 musicId 与 seekGen，过期丢弃；
 *   与 syncFromEngine 已有模式同口径。
 *
 * 运行：node scripts/sim-gemini-bug01.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = 'src/core/init/player/playProgress.ts'
const real = fs.readFileSync(path.join(ROOT, FILE), 'utf8').replace(/\r\n/g, '\n')

/** 取某个函数到下一个锚点之间的窗口 */
const windowBetween = (src, startAnchor, endAnchor, fallback = 3000) => {
  const start = src.indexOf(startAnchor)
  if (start < 0) return ''
  const end = src.indexOf(endAnchor, start + startAnchor.length)
  return end < 0 ? src.slice(start, start + fallback) : src.slice(start, end)
}

const invariants = (src) => {
  const reasons = []
  const fn = windowBetween(src, 'const setProgress = (time: number, maxTime?: number) => {', 'const handlePlay = () => {')

  if (!/const genAtCall = \+\+seekGen/.test(fn)) {
    reasons.push('setProgress 未捕获本次 seek 的代际（genAtCall = ++seekGen）')
  }
  const cb = windowBetween(fn, 'void setCurrentTime(time).then((targetPosition) => {', 'syncFromEngine(musicId)', 800)
  if (!/if \(playerState\.musicInfo\.id != musicId \|\| genAtCall != seekGen\) return/.test(cb)) {
    reasons.push('setProgress 回调缺少 musicId + seekGen 双重校验（过期回调会写旧落点）')
  }
  // 旧的裸判空不得残留（它挡不住切歌/二次 seek）
  if (/if \(!playerState\.musicInfo\.id\) return/.test(cb)) {
    reasons.push('setProgress 回调仍用旧的裸判空，未换成代际校验')
  }
  // 校验必须在写进度之前
  const guardAt = cb.indexOf('genAtCall != seekGen')
  const writeAt = cb.indexOf('setNowPlayTime(targetPosition)')
  if (guardAt < 0 || writeAt < 0 || guardAt > writeAt) {
    reasons.push('代际校验没有排在 setNowPlayTime 写进度之前')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 行为模型：1:1 复刻代际校验（seek 发起 / 回调返回 / 切歌 / 二次 seek）
// ---------------------------------------------------------------------------
const makeState = () => ({ seekGen: 0, musicId: 'A', nowPlayTime: 0 })
const setProgress = (state, time) => {
  const musicId = state.musicId
  const genAtCall = ++state.seekGen
  // 返回回调（模拟 setCurrentTime 异步 resolve）
  return (targetPosition) => {
    if (state.musicId !== musicId || genAtCall !== state.seekGen) return 'dropped'
    state.nowPlayTime = targetPosition
    return 'applied'
  }
}

const models = []
{
  const state = makeState()
  const cb = setProgress(state, 120)
  models.push(['正常 seek：回调应用落点', cb(120) === 'applied' && state.nowPlayTime === 120])
}
{
  const state = makeState()
  const cb = setProgress(state, 120)
  state.musicId = 'B' // 回调返回前切歌
  models.push(['seek 未 resolve 时切歌：旧回调丢弃，不写新歌进度', cb(120) === 'dropped' && state.nowPlayTime === 0])
}
{
  const state = makeState()
  const cb1 = setProgress(state, 120)
  const cb2 = setProgress(state, 200) // 同歌快速二次 seek
  models.push([
    '同歌快速连续两次 seek：旧回调丢弃，新回调应用',
    cb1(120) === 'dropped' && cb2(200) === 'applied' && state.nowPlayTime === 200,
  ])
}
{
  const state = makeState()
  const cb = setProgress(state, 120)
  state.seekGen++ // handleStop 的 seekGen++ 使在途回调失效
  models.push(['停播后旧回调返回：代际已变，丢弃', cb(120) === 'dropped'])
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

checkCase('C1 回调去掉代际校验（只留 musicId 校验）',
  tamper(real, 'if (playerState.musicInfo.id != musicId || genAtCall != seekGen) return', 'if (playerState.musicInfo.id != musicId) return'),
  '双重校验')
checkCase('C2 回调去掉 musicId 校验（只留代际校验）',
  tamper(real, 'if (playerState.musicInfo.id != musicId || genAtCall != seekGen) return', 'if (genAtCall != seekGen) return'),
  '双重校验')
checkCase('C3 setProgress 不捕获代际',
  tamper(real, 'const genAtCall = ++seekGen', 'seekGen++'),
  '未捕获本次 seek 的代际')

const missed = cases.filter(([, ok]) => !ok)

console.log('行为模型（seek 代际校验）')
for (const [name, ok] of models) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
console.log('')
console.log('反例自检')
for (const [name, ok, detail] of cases) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} —— ${detail}`)
console.log('')

let failed = 0
const realReasons = invariants(real)
if (realReasons.length) {
  console.error(`FAIL  Bug 1 契约未通过（${realReasons.length} 项）：`)
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
  console.log(`PASS  Bug 1 契约通过（结构不变量 4 项 + 行为模型 ${models.length} 例 + 反例 ${cases.length} 例）`)
  process.exit(0)
}
process.exit(1)
