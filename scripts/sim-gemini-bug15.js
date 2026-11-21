/**
 * sim-gemini-bug15.js
 *
 * Bug 15（Gemini 全量审查 2026-11-21，核实：部分真实）：
 * src/core/player/player.ts 的 playNext 无条件消费 randomNextMusicInfo.info。
 *
 * 机制：消费前不查是否仍为 random 模式、不查 listId 是否等于当前列表、
 * 不查歌曲是否仍在 currentList 中。
 *   - 删歌触发：完全成立，无任何防御——删掉被缓存的歌后仍会播放已删歌曲；
 *   - 切模式触发：成立但有窗口限制——preloadNextMusic 的 handleConfigUpdated
 *     已在模式变化时重置缓存，但守卫要求 preloadMusicInfo.info 非空（仅剩余
 *     <20s 预加载跑过时才重置），track 前半程切模式时重置被跳过；
 *   - 同源点：getNextPlayMusicInfo:444 也无条件返回过期缓存。
 *
 * 修法：消费前校验"仍为 random 模式 + 同列表 + 歌曲仍在 currentList 中"，
 * 否则重置缓存并走正常计算；两处消费点（playNext 与 getNextPlayMusicInfo）同修。
 *
 * 本脚本复刻校验函数与消费流程，验证 6 个断言；另用内容锚点钉住真实源码。
 *
 * 运行：node scripts/sim-gemini-bug15.js
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'src/core/player/player.ts'), 'utf8')

// ---------------------------------------------------------------------------
// 模型：复刻校验函数与消费流程（与 player.ts 逐行对应）
// ---------------------------------------------------------------------------

const makeModel = () => {
  const state = {
    togglePlayMethod: 'random',
    currentListId: 'listA',
    currentList: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
  }
  const randomNextMusicInfo = { info: null }
  const resetRandomNextMusicInfo = () => { randomNextMusicInfo.info = null }
  // 复刻 isRandomNextMusicInfoValid
  const isValid = (currentListId, currentList) => {
    const info = randomNextMusicInfo.info
    if (!info) return false
    if (state.togglePlayMethod !== 'random') return false
    if (info.listId !== currentListId) return false
    return currentList.some(m => m.id === info.musicInfo.id)
  }
  // 复刻修复后的消费流程（playNext / getNextPlayMusicInfo 共用语义）：
  // 有效则消费缓存，否则重置并走正常计算（模型以 'normal-compute' 表示）
  const consume = () => {
    if (randomNextMusicInfo.info) {
      if (isValid(state.currentListId, state.currentList)) return { via: 'cache', info: randomNextMusicInfo.info }
      resetRandomNextMusicInfo()
    }
    return { via: 'normal-compute', info: null }
  }
  return { state, randomNextMusicInfo, consume }
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

let pass = 0; let fail = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
  ok ? pass++ : fail++
}

console.log('sim-gemini-bug15：随机下一首过期缓存校验\n')

// 断言1（正常路径）：random 模式 + 同列表 + 歌曲在列 → 消费缓存
{
  const m = makeModel()
  m.randomNextMusicInfo.info = { musicInfo: { id: 's2' }, listId: 'listA', isTempPlay: false }
  const r = m.consume()
  check('有效缓存：random 模式 + 同列表 + 歌曲在列 → 消费缓存',
    r.via === 'cache' && r.info.musicInfo.id === 's2',
    `via=${r.via}`)
}

// 断言2（主害·删歌）：缓存的歌已被删 → 不消费，重置并走正常计算
{
  const m = makeModel()
  m.randomNextMusicInfo.info = { musicInfo: { id: 's2' }, listId: 'listA', isTempPlay: false }
  m.state.currentList = [{ id: 's1' }, { id: 's3' }] // s2 已删
  const r = m.consume()
  check('删歌后：缓存的歌已不在列表 → 不播放已删歌曲，重置并走正常计算',
    r.via === 'normal-compute' && m.randomNextMusicInfo.info === null,
    `via=${r.via}，缓存已重置=${m.randomNextMusicInfo.info === null}`)
}

// 断言3（切模式·前半程）：track 前半程切到 listLoop，预加载重置未跑过 → 旧 pick 作废
{
  const m = makeModel()
  m.randomNextMusicInfo.info = { musicInfo: { id: 's2' }, listId: 'listA', isTempPlay: false }
  m.state.togglePlayMethod = 'listLoop' // 前半程切模式，preload 守卫跳过重置
  const r = m.consume()
  check('切模式后：不再是 random 模式 → 旧随机 pick 作废，走正常计算',
    r.via === 'normal-compute' && m.randomNextMusicInfo.info === null,
    `via=${r.via}，缓存已重置=${m.randomNextMusicInfo.info === null}`)
}

// 断言4（切列表）：缓存属于另一列表 → 作废
{
  const m = makeModel()
  m.randomNextMusicInfo.info = { musicInfo: { id: 's2' }, listId: 'listB', isTempPlay: false }
  const r = m.consume()
  check('切列表后：缓存 listId 与当前列表不符 → 作废，走正常计算',
    r.via === 'normal-compute' && m.randomNextMusicInfo.info === null,
    `via=${r.via}，缓存已重置=${m.randomNextMusicInfo.info === null}`)
}

// 断言5（无缓存回归）：无缓存时直接走正常计算
{
  const m = makeModel()
  const r = m.consume()
  check('无缓存时：直接走正常计算',
    r.via === 'normal-compute', `via=${r.via}`)
}

// 断言6（内容锚点）：真实源码里校验函数 + 两处消费点校验都在
{
  const hasHelper = SRC.includes('const isRandomNextMusicInfoValid = (currentListId: string, currentList: LX.Player.PlayMusic[]): boolean => {')
  const hasModeCheck = SRC.includes("settingState.setting['player.togglePlayMethod'] !== 'random'")
  const hasListCheck = SRC.includes('info.listId !== currentListId')
  const hasMemberCheck = SRC.includes('currentList.some(m => m.id === info.musicInfo.id)')
  const callSites = (SRC.match(/isRandomNextMusicInfoValid\(currentListId, currentList\)/g) || []).length
  const noBareConsume = !SRC.includes('if (randomNextMusicInfo.info) return randomNextMusicInfo.info') &&
    !SRC.includes('if (randomNextMusicInfo.info) {\n    await handlePlayNext(randomNextMusicInfo.info)')
  check('源码锚点：校验函数（三项全）+ 两处消费点校验 + 无条件消费已除',
    hasHelper && hasModeCheck && hasListCheck && hasMemberCheck && callSites === 2 && noBareConsume,
    `函数=${hasHelper}, 模式=${hasModeCheck}, 同列表=${hasListCheck}, 在列=${hasMemberCheck}, 调用点=${callSites} 处, 无裸消费=${noBareConsume}`)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
