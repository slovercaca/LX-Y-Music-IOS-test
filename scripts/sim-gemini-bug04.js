/**
 * sim-gemini-bug04.js
 *
 * Gemini Bug 4（真实）：initPlayInfo 异步恢复与用户/deeplink 起播竞态覆盖。
 *
 * 成因：await getPlayInfo() → await getListMusics(...) → playList(...) 全程
 * 无"恢复进行中"标志或代际校验，init/player/index.ts 为 fire-and-forget。
 * deeplink/用户起播先发生，恢复后到的 playList 会覆盖回上次的歌；反向则
 * 用户起播的歌会消费旧歌的恢复信息被错误 seek。
 *
 * 修法（src/core/init/player/playInfo.ts，只改此文件，不碰 player.ts）：
 *   每次 await 后检查 playerState.playMusicInfo.musicInfo || playerState.isPlay
 *   则 return，与 startupAutoPlay 守卫同口径。
 *
 * 运行：node scripts/sim-gemini-bug04.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = 'src/core/init/player/playInfo.ts'
const real = fs.readFileSync(path.join(ROOT, FILE), 'utf8').replace(/\r\n/g, '\n')

const GUARD = 'if (playerState.playMusicInfo.musicInfo || playerState.isPlay) return'

const invariants = (src) => {
  const reasons = []
  const getPlayInfoAt = src.indexOf('const info = await getPlayInfo()')
  const getListAt = src.indexOf('const list = await getListMusics(info.listId)')
  const playListAt = src.indexOf('await playList(info.listId, info.index)')
  if (getPlayInfoAt < 0 || getListAt < 0 || playListAt < 0) {
    reasons.push('playInfo.ts 结构已变（找不到三段 await 锚点）')
    return reasons
  }
  // 守卫 1：getPlayInfo 之后、getListMusics 之前
  const guard1 = src.indexOf(GUARD, getPlayInfoAt)
  if (guard1 < 0 || guard1 > getListAt) {
    reasons.push('getPlayInfo() 之后缺少竞态守卫（用户起播后恢复仍会继续）')
  }
  // 守卫 2：getListMusics 之后、playList 之前
  const guard2 = src.indexOf(GUARD, getListAt)
  if (guard2 < 0 || guard2 > playListAt) {
    reasons.push('getListMusics() 之后缺少竞态守卫（迟到的 playList 会覆盖用户正在听的歌）')
  }
  // 守卫必须在 restorePlayInfo 赋值之前（否则恢复信息已污染）
  const restoreAt = src.indexOf('global.lx.restorePlayInfo = info')
  if (guard2 < 0 || restoreAt < 0 || guard2 > restoreAt) {
    reasons.push('守卫没有排在 restorePlayInfo 赋值之前')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 行为模型：1:1 复刻恢复流程 + 两道守卫（await 用可控 deferred 模拟，
// 以便在 await 期间精确插入"用户起播"）
// ---------------------------------------------------------------------------
const makeState = () => ({ musicInfo: null, isPlay: false, playedList: null, restored: null })
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
const initPlayInfo = async(state, { info, list, getPlayInfoGate, getListMusicsGate }) => {
  await getPlayInfoGate.promise // getPlayInfo()
  if (state.musicInfo || state.isPlay) return 'aborted-after-getPlayInfo'
  if (!info?.listId || info.index < 0) return 'no-info'
  await getListMusicsGate.promise // getListMusics()
  if (state.musicInfo || state.isPlay) return 'aborted-after-getListMusics'
  if (!list[info.index]) return 'no-song'
  state.restored = info
  state.playedList = info.listId
  return 'restored'
}

const runModels = async() => {
  const models = []
  {
    const state = makeState()
    const g1 = deferred()
    const g2 = deferred()
    const p = initPlayInfo(state, { info: { listId: 'L1', index: 0 }, list: [{ id: 'A' }], getPlayInfoGate: g1, getListMusicsGate: g2 })
    g1.resolve()
    await Promise.resolve()
    g2.resolve()
    const r = await p
    models.push(['无干扰：恢复正常完成', r === 'restored' && state.playedList === 'L1' && state.restored?.listId === 'L1'])
  }
  {
    const state = makeState()
    const g1 = deferred()
    const g2 = deferred()
    const p = initPlayInfo(state, { info: { listId: 'L1', index: 0 }, list: [{ id: 'A' }], getPlayInfoGate: g1, getListMusicsGate: g2 })
    state.musicInfo = { id: 'S' } // getPlayInfo 期间用户起播（deeplink/点歌）
    g1.resolve()
    const r = await p
    models.push(['getPlayInfo 期间用户起播：恢复放弃，不覆盖用户歌曲',
      r === 'aborted-after-getPlayInfo' && state.playedList === null && state.restored === null])
  }
  {
    const state = makeState()
    const g1 = deferred()
    const g2 = deferred()
    const p = initPlayInfo(state, { info: { listId: 'L1', index: 0 }, list: [{ id: 'A' }], getPlayInfoGate: g1, getListMusicsGate: g2 })
    g1.resolve()
    await Promise.resolve()
    await Promise.resolve() // 让恢复流程推进到第二个 await
    state.musicInfo = { id: 'S' } // getListMusics 期间用户起播
    g2.resolve()
    const r = await p
    models.push(['getListMusics 期间用户起播：恢复放弃，restorePlayInfo 不被污染',
      r === 'aborted-after-getListMusics' && state.playedList === null && state.restored === null])
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

  // 两道守卫文本相同：只删第一道（getPlayInfo 后的那道）
  const firstGuardAt = real.indexOf(GUARD)
  checkCase('C1 删第一道守卫（getPlayInfo 之后）',
    real.slice(0, firstGuardAt) + real.slice(firstGuardAt + GUARD.length),
    'getPlayInfo() 之后缺少竞态守卫')
  // 只删第二道（getListMusics 后的那道）
  const secondGuardAt = real.indexOf(GUARD, firstGuardAt + GUARD.length)
  checkCase('C2 删第二道守卫（getListMusics 之后）',
    real.slice(0, secondGuardAt) + real.slice(secondGuardAt + GUARD.length),
    'getListMusics() 之后缺少竞态守卫')
  checkCase('C3 守卫只判 isPlay（漏 musicInfo）',
    tamper(real, GUARD, 'if (playerState.isPlay) return'),
    '缺少竞态守卫')

  const missed = cases.filter(([, ok]) => !ok)

  console.log('行为模型（启动恢复竞态守卫）')
  for (const [name, ok] of models) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log('')
  console.log('反例自检')
  for (const [name, ok, detail] of cases) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} —— ${detail}`)
  console.log('')

  let failed = 0
  const realReasons = invariants(real)
  if (realReasons.length) {
    console.error(`FAIL  Bug 4 契约未通过（${realReasons.length} 项）：`)
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
    console.log(`PASS  Bug 4 契约通过（结构不变量 3 项 + 行为模型 ${models.length} 例 + 反例 ${cases.length} 例）`)
    process.exit(0)
  }
  process.exit(1)
}

void main()
