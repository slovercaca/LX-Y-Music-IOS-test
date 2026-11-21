/**
 * sim-gemini-bug02.js
 *
 * Gemini Bug 2（真实）：getMaxTime 异步 getDuration() 缺少切歌/停播校验。
 *
 * 成因：await getDuration() 前后无 musicId 快照/比对，返回后直接用当时
 * playMusicInfo + 旧歌 duration 计算并 setMaxplayTime；更严重的是
 * updateListMusics 会把旧时长持久化写进新歌的歌单条目（interval 字段）。
 *
 * 修法（src/core/init/player/playProgress.ts 的 getMaxTime）：
 *   入口快照 musicId/musicInfo/listId，await 后比对 musicId 且校验 isPlay，
 *   不一致返回；updateListMusics 用快照的 musicInfo/listId。
 *
 * 运行：node scripts/sim-gemini-bug02.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = 'src/core/init/player/playProgress.ts'
const real = fs.readFileSync(path.join(ROOT, FILE), 'utf8').replace(/\r\n/g, '\n')

const windowBetween = (src, startAnchor, endAnchor, fallback = 2000) => {
  const start = src.indexOf(startAnchor)
  if (start < 0) return ''
  const end = src.indexOf(endAnchor, start + startAnchor.length)
  return end < 0 ? src.slice(start, start + fallback) : src.slice(start, end)
}

const invariants = (src) => {
  const reasons = []
  const fn = windowBetween(src, 'const getMaxTime = async() => {', 'const clearUpdateTimeout = () => {')
  const awaitAt = fn.indexOf('const duration = await getDuration()')
  if (awaitAt < 0) {
    reasons.push('getMaxTime 结构已变（找不到 await getDuration() 锚点）')
    return reasons
  }
  const before = fn.slice(0, awaitAt)
  const after = fn.slice(awaitAt)

  // ① 入口快照（await 之前）
  if (!/const musicId = playerState\.musicInfo\.id/.test(before)) reasons.push('入口未快照 musicId')
  if (!/const musicInfo = playerState\.playMusicInfo\.musicInfo/.test(before)) reasons.push('入口未快照 musicInfo')
  if (!/const listId = playerState\.playMusicInfo\.listId/.test(before)) reasons.push('入口未快照 listId')

  // ② await 后守卫（切歌 + 停播）
  if (!/if \(!playerState\.isPlay \|\| playerState\.musicInfo\.id != musicId\) return/.test(after)) {
    reasons.push('await 后缺少 isPlay + musicId 比对守卫')
  }
  // 守卫必须在 setMaxplayTime 之前
  const guardAt = after.indexOf('playerState.musicInfo.id != musicId')
  const setAt = after.indexOf('setMaxplayTime(timelineDuration)')
  if (guardAt < 0 || setAt < 0 || guardAt > setAt) {
    reasons.push('守卫没有排在 setMaxplayTime 之前')
  }

  // ③ 写回用快照，不再读当时的 playMusicInfo
  if (/playerState\.playMusicInfo/.test(after)) {
    reasons.push('await 后仍在读 playerState.playMusicInfo（应全用快照）')
  }
  if (!/id: listId/.test(after) || !/\.\.\.musicInfo/.test(after)) {
    reasons.push('updateListMusics 未用快照的 listId/musicInfo')
  }
  if (!/getTimelineDuration\(musicInfo, duration\)/.test(after)) {
    reasons.push('getTimelineDuration 未用快照的 musicInfo')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 行为模型：1:1 复刻快照 + await 后校验
// ---------------------------------------------------------------------------
const makeState = () => ({
  isPlay: true,
  musicId: 'A',
  playMusicInfo: { musicInfo: { id: 'A', interval: '' }, listId: 'list-1' },
  maxPlayTime: 0,
  listWrites: [],
})
const getMaxTime = async(state, duration) => {
  const musicId = state.musicId
  const musicInfo = state.playMusicInfo.musicInfo
  const listId = state.playMusicInfo.listId
  await Promise.resolve() // 模拟 getDuration() 桥往返
  if (!state.isPlay || state.musicId !== musicId) return 'dropped'
  const timelineDuration = duration
  state.maxPlayTime = timelineDuration
  if (musicInfo && !musicInfo.interval && listId) {
    state.listWrites.push({ id: listId, interval: timelineDuration })
  }
  return 'applied'
}

const runModels = async() => {
  const models = []
  {
    const state = makeState()
    const r = await getMaxTime(state, 200)
    models.push(['正常起播：总时长写入，歌单条目补 interval',
      r === 'applied' && state.maxPlayTime === 200 && state.listWrites.length === 1 && state.listWrites[0].id === 'list-1'])
  }
  {
    const state = makeState()
    const p = getMaxTime(state, 200)
    state.musicId = 'B' // await 期间切歌
    state.playMusicInfo = { musicInfo: { id: 'B', interval: '' }, listId: 'list-2' }
    const r = await p
    models.push(['起播后极短时间切歌：旧时长丢弃，不污染新歌、不写歌单',
      r === 'dropped' && state.maxPlayTime === 0 && state.listWrites.length === 0])
  }
  {
    const state = makeState()
    const p = getMaxTime(state, 200)
    state.isPlay = false // await 期间停播
    const r = await p
    models.push(['起播后极短时间停播：丢弃，不写总时长',
      r === 'dropped' && state.maxPlayTime === 0 && state.listWrites.length === 0])
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

  checkCase('C1 await 后去掉守卫',
    tamper(real, 'if (!playerState.isPlay || playerState.musicInfo.id != musicId) return', 'if (false) return'),
    '缺少 isPlay + musicId 比对守卫')
  checkCase('C2 updateListMusics 改回读当时 playMusicInfo',
    tamper(real, 'id: listId,\n          musicInfo: {\n            ...musicInfo,', 'id: playerState.playMusicInfo.listId,\n          musicInfo: {\n            ...playerState.playMusicInfo.musicInfo,'),
    '仍在读 playerState.playMusicInfo')
  checkCase('C3 入口不快照 musicId',
    tamper(real, '    const musicId = playerState.musicInfo.id\n', ''),
    '未快照 musicId')

  const missed = cases.filter(([, ok]) => !ok)

  console.log('行为模型（getMaxTime 快照校验）')
  for (const [name, ok] of models) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log('')
  console.log('反例自检')
  for (const [name, ok, detail] of cases) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} —— ${detail}`)
  console.log('')

  let failed = 0
  const realReasons = invariants(real)
  if (realReasons.length) {
    console.error(`FAIL  Bug 2 契约未通过（${realReasons.length} 项）：`)
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
    console.log(`PASS  Bug 2 契约通过（结构不变量 7 项 + 行为模型 ${models.length} 例 + 反例 ${cases.length} 例）`)
    process.exit(0)
  }
  process.exit(1)
}

void main()
