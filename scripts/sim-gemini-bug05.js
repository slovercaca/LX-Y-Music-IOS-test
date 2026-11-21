/**
 * sim-gemini-bug05.js
 *
 * Gemini Bug 5（部分真实）：playStatus.ts 播放/暂停/停止异步状态同步竞态。
 *
 * 属实部分：handlePlay/handlePause 均为 await syncNowPlayingState(...) 后写
 * buttons.play，无代际/序号校验；handleStop 同步写 buttons.play = false 但
 * 不 await，在途的 handlePlay 链随后 resolve 会把它改回 true。
 *
 * 不成立部分（不修）：报告称"覆写系统控制中心状态"——setButtons() 传的是
 * playerState.isPlay 真实状态而非 buttons.play，过期回调不会把错误状态推给
 * 控制中心。实际影响只限于本地 buttons.play 闭包变量错写。
 *
 * 修法（src/core/init/player/playStatus.ts）：加单调序号 syncGen，await 后
 * 过期链丢弃；handleStop 同步递增代际，使在途链失效。
 *
 * 运行：node scripts/sim-gemini-bug05.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = 'src/core/init/player/playStatus.ts'
const real = fs.readFileSync(path.join(ROOT, FILE), 'utf8').replace(/\r\n/g, '\n')

const windowBetween = (src, startAnchor, endAnchor, fallback = 1500) => {
  const start = src.indexOf(startAnchor)
  if (start < 0) return ''
  const end = src.indexOf(endAnchor, start + startAnchor.length)
  return end < 0 ? src.slice(start, start + fallback) : src.slice(start, end)
}

const invariants = (src) => {
  const reasons = []
  if (!/let syncGen = 0/.test(src)) {
    reasons.push('缺单调序号 syncGen（handlePlay/handlePause 异步链无代际校验）')
  }
  const playFn = windowBetween(src, 'const handlePlay = () => {', 'const handlePause = () => {')
  if (!/const gen = \+\+syncGen/.test(playFn)) reasons.push('handlePlay 未捕获代际')
  if (!/await syncNowPlayingState\('play'\)/.test(playFn)) reasons.push('handlePlay 结构已变（找不到 await 锚点）')
  if (!/if \(gen != syncGen\) return/.test(playFn)) reasons.push('handlePlay await 后未丢弃过期链')
  const playAwaitAt = playFn.indexOf("await syncNowPlayingState('play')")
  const playGuardAt = playFn.indexOf('if (gen != syncGen) return')
  const playWriteAt = playFn.indexOf('buttons.play = true')
  if (playGuardAt < 0 || playWriteAt < 0 || playGuardAt < playAwaitAt || playGuardAt > playWriteAt) {
    reasons.push('handlePlay 的代际校验没有排在 await 之后、写 buttons.play 之前')
  }
  const pauseFn = windowBetween(src, 'const handlePause = () => {', 'const handleStop = () => {')
  if (!/const gen = \+\+syncGen/.test(pauseFn)) reasons.push('handlePause 未捕获代际')
  if (!/if \(gen != syncGen\) return/.test(pauseFn)) reasons.push('handlePause await 后未丢弃过期链')
  const stopFn = windowBetween(src, 'const handleStop = () => {', 'const handleSetPlayInfo = () => {')
  if (!/syncGen\+\+/.test(stopFn)) {
    reasons.push('handleStop 未递增代际（在途的 play 链 resolve 后会把 buttons.play 改回 true）')
  }
  const stopGenAt = stopFn.indexOf('syncGen++')
  const stopWriteAt = stopFn.indexOf('buttons.play = false')
  if (stopGenAt < 0 || stopWriteAt < 0 || stopGenAt > stopWriteAt) {
    reasons.push('handleStop 的代际递增没有排在写 buttons.play = false 之前')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 行为模型：1:1 复刻代际校验（事件 + 异步 resolve 交错）
// ---------------------------------------------------------------------------
const makeState = () => ({ buttons: { play: false }, syncGen: 0 })
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
const handlePlay = (state) => {
  const gen = ++state.syncGen
  const d = deferred()
  const done = d.promise.then(() => {
    if (gen !== state.syncGen) return 'dropped'
    if (state.buttons.play) return 'noop'
    state.buttons.play = true
    return 'applied'
  })
  return { resolve: d.resolve, done }
}
const handlePause = (state) => {
  const gen = ++state.syncGen
  const d = deferred()
  const done = d.promise.then(() => {
    if (gen !== state.syncGen) return 'dropped'
    if (!state.buttons.play) return 'noop'
    state.buttons.play = false
    return 'applied'
  })
  return { resolve: d.resolve, done }
}
const handleStop = (state) => {
  state.syncGen++
  state.buttons.play = false
}

const runModels = async() => {
  const models = []
  {
    // 报告的核心场景：play 在途时 stop，play 链随后 resolve
    const state = makeState()
    const play = handlePlay(state)
    handleStop(state)
    play.resolve()
    const r = await play.done
    models.push(['play 在途时 stop：迟到的 play 链丢弃，buttons.play 保持 false',
      r === 'dropped' && state.buttons.play === false])
  }
  {
    // 快速 play → pause：旧 play 链不得覆盖 pause 的结果
    const state = makeState()
    const play = handlePlay(state)
    const pause = handlePause(state)
    play.resolve()
    pause.resolve()
    const [r1, r2] = await Promise.all([play.done, pause.done])
    models.push(['快速 play→pause：旧 play 链丢弃，pause 链生效',
      r1 === 'dropped' && (r2 === 'applied' || r2 === 'noop') && state.buttons.play === false])
  }
  {
    const state = makeState()
    const play = handlePlay(state)
    play.resolve()
    const r = await play.done
    models.push(['正常 play：链应用，buttons.play 置 true', r === 'applied' && state.buttons.play === true])
  }
  {
    const state = makeState()
    state.buttons.play = true
    const pause = handlePause(state)
    pause.resolve()
    const r = await pause.done
    models.push(['正常 pause：链应用，buttons.play 置 false', r === 'applied' && state.buttons.play === false])
  }
  return models
}

// ---------------------------------------------------------------------------
// 反例自检
// ---------------------------------------------------------------------------
const tamper = (src, find, replace) => {
  if (!src.includes(find)) throw new Error(`tamper 锚点未命中: ${find}`)
  return src.split(find).join(replace)
}

const main = async() => {
  const models = await runModels()
  const failedModels = models.filter(([, ok]) => !ok)

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

  checkCase('C1 handlePlay await 后去掉代际校验',
    tamper(real, "      await syncNowPlayingState('play')\n      if (gen != syncGen) return\n", "      await syncNowPlayingState('play')\n"),
    'handlePlay await 后未丢弃过期链')
  checkCase('C2 handleStop 不递增代际',
    tamper(real, '  const handleStop = () => {\n    syncGen++\n', '  const handleStop = () => {\n'),
    'handleStop 未递增代际')
  checkCase('C3 handlePause 不捕获代际',
    tamper(real, "  const handlePause = () => {\n    const gen = ++syncGen\n", '  const handlePause = () => {\n'),
    'handlePause 未捕获代际')

  const missed = cases.filter(([, ok]) => !ok)

  console.log('行为模型（playStatus 代际校验）')
  for (const [name, ok] of models) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log('')
  console.log('反例自检')
  for (const [name, ok, detail] of cases) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} —— ${detail}`)
  console.log('')

  let failed = 0
  const realReasons = invariants(real)
  if (realReasons.length) {
    console.error(`FAIL  Bug 5 契约未通过（${realReasons.length} 项）：`)
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
    console.log(`PASS  Bug 5 契约通过（结构不变量 7 项 + 行为模型 ${models.length} 例 + 反例 ${cases.length} 例）`)
    process.exit(0)
  }
  process.exit(1)
}

void main()
