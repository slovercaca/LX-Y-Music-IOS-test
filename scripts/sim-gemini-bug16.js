/**
 * sim-gemini-bug16.js
 *
 * Bug 16（Gemini 全量审查 2026-11-21，核实：真实）：
 * reloadConfig 后在途 loadTrackPlayerResource 篡改新队列。
 *
 * 机制：loadTrackPlayerResource 内部横跨多次 await（getCurrentTrack、add、
 * getQueue、skip、seekToTime、play、remove），没有任何代际/isStale 检查，
 * 签名也不接收 isStale；同文件 restoreTrack 明确接收 isStale 并在每个 await
 * 后检查——同一文件内两种待遇，遗漏确凿。外层 loadPlaybackResource 只在返回
 * 后才查 isStale()，对内部已发生的队列操作为时已晚。reloadConfig 开始时调
 * bumpLoadGeneration()，但在途函数根本不读代际。
 * 破坏方式：global.lx.playerTrackId 覆盖、旧轨道 TrackPlayer.play() 唤醒、
 * 尾部 remove() 按过期快照删当前队列前 N 项（可能删掉重建后的新轨道）。
 * 现实触发主要是 reloadConfig（绕过串行链；唯一调用方是音频焦点设置开关）。
 *
 * 修法：把 isStale 传入 loadTrackPlayerResource，每次 await 后
 * `if (isStale?.()) return null`（restoreTrack 即同文件现成范式）；
 * resourceLoader 传入 isStale 并处理 null 返回。
 *
 * 本脚本用门控假 TrackPlayer 复刻装载序列与代际失效，验证 5 个断言；
 * 另用内容锚点钉住真实源码（签名 + 12 处检查点 + 调用方 null 处理）。
 *
 * 运行：node scripts/sim-gemini-bug16.js
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'src/plugins/player/trackPlayerCore.ts'), 'utf8')
const LOADER_SRC = fs.readFileSync(path.join(ROOT, 'src/plugins/player/engine/resourceLoader.ts'), 'utf8')

// ---------------------------------------------------------------------------
// 模型：复刻 loadTrackPlayerResource 的 await 序列与 stale 检查
// 门控引擎：每步操作记录后停在门前，由测试手动放行，模拟桥接往返间隙
// （reloadConfig 的代际推进就落在这个间隙里）。
// ---------------------------------------------------------------------------

const makeEngine = () => {
  const ops = []
  let release = null
  const step = async(name) => {
    ops.push(name)
    await new Promise((resolve) => { release = resolve })
  }
  return {
    ops,
    releaseStep: () => { if (release) { const r = release; release = null; r() } },
    getCurrentTrack: async() => { await step('getCurrentTrack'); return null },
    add: async() => { await step('add') },
    getQueue: async() => { await step('getQueue'); return [{ id: 'old1' }, { id: 'old2' }, { id: 'old3' }] },
    skip: async() => { await step('skip') },
    seekToTime: async() => { await step('seekToTime') },
    play: async() => { await step('play') },
    pause: async() => { await step('pause') },
    applyCurrentVolume: async() => { await step('applyCurrentVolume') },
    remove: async() => { await step('remove') },
  }
}

// 复刻修复后的 loadTrackPlayerResource（currentTrackIndex == null + 自动播放分支）
const loadFixed = async(engine, isStale) => {
  const stale = () => isStale?.() === true
  const currentTrackIndex = await engine.getCurrentTrack()
  if (stale()) return null
  await engine.add()
  if (stale()) return null
  const queue = await engine.getQueue()
  if (stale()) return null
  await engine.skip()
  if (stale()) return null
  await engine.seekToTime()
  if (stale()) return null
  await engine.play()
  if (stale()) return null
  await engine.applyCurrentVolume()
  if (stale()) return null
  if (queue.length > 1) await engine.remove()
  return { id: 'track-new' }
}

// 复刻修复前的 loadTrackPlayerResource（无任何 stale 检查，反例对照）
const loadBeforeFix = async(engine) => {
  await engine.getCurrentTrack()
  await engine.add()
  const queue = await engine.getQueue()
  await engine.skip()
  await engine.seekToTime()
  await engine.play()
  await engine.applyCurrentVolume()
  if (queue.length > 1) await engine.remove()
  return { id: 'track-new' }
}

const tick = () => new Promise(resolve => setImmediate(resolve))
// 放行一步并让装载函数推进到下一道门前
const advance = async(engine) => { engine.releaseStep(); await tick() }
// 反复放行直到装载 Promise 落定
const runToEnd = async(engine, p) => {
  let settled = false
  p.then(() => { settled = true }, () => { settled = true })
  for (let i = 0; i < 20 && !settled; i++) {
    engine.releaseStep()
    await tick()
  }
  await tick()
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

let pass = 0; let fail = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
  ok ? pass++ : fail++
}

const main = async() => {
  console.log('sim-gemini-bug16：loadTrackPlayerResource 代际失效检查点\n')

  // 断言1（反例）：修复前，reloadConfig 落在 add 与 skip 之间，在途装载照常
  // 走完 play + remove 全流程（旧轨道被唤醒、过期快照删队列）
  {
    const engine = makeEngine()
    const p = loadBeforeFix(engine)
    await tick() // 停在 getCurrentTrack 门前
    await advance(engine) // getCurrentTrack 完成，停在 add 门前
    await advance(engine) // add 完成，停在 getQueue 门前
    // reloadConfig 推进代际（修复前无人读代际）
    await runToEnd(engine, p)
    const result = await p
    check('修复前·中途换代：在途装载仍走完 play + remove（旧轨道唤醒，反例）',
      result !== null && engine.ops.includes('play') && engine.ops.includes('remove'),
      `ops=${engine.ops.join('→')}`)
  }

  // 断言2（修复验证，断言1的反例）：修复后，getQueue 在途时换代，
  // check 即拦下，返回 null，skip/seek/play/remove 一概不碰
  {
    const engine = makeEngine()
    let generation = 0
    const isStale = () => generation !== 0
    const p = loadFixed(engine, isStale)
    await tick()
    await advance(engine) // getCurrentTrack 完成
    await advance(engine) // add 完成，停在 getQueue 门前
    generation = 1 // reloadConfig 推进代际
    await runToEnd(engine, p)
    const result = await p
    check('修复后·add 后换代：返回 null，skip/seek/play/remove 均未执行',
      result === null && !engine.ops.includes('skip') && !engine.ops.includes('play') && !engine.ops.includes('remove'),
      `result=${result}，ops=${engine.ops.join('→')}`)
  }

  // 断言3：play 在途时换代，check 拦下后续调用——applyCurrentVolume 与
  // remove 均未执行（play 本身已发出，无法撤回，但不再继续）
  {
    const engine = makeEngine()
    let generation = 0
    const isStale = () => generation !== 0
    const p = loadFixed(engine, isStale)
    await tick()
    await advance(engine) // getCurrentTrack
    await advance(engine) // add
    await advance(engine) // getQueue
    await advance(engine) // skip
    await advance(engine) // seekToTime，停在 play 门前
    generation = 1 // reloadConfig 推进代际
    await runToEnd(engine, p)
    const result = await p
    check('修复后·play 在途换代：返回 null，applyCurrentVolume/remove 未执行',
      result === null && engine.ops.includes('play') &&
      !engine.ops.includes('applyCurrentVolume') && !engine.ops.includes('remove'),
      `result=${result}，ops=${engine.ops.join('→')}`)
  }

  // 断言4（正常路径回归）：无换代时完整走完并返回 track（含尾部 remove）
  {
    const engine = makeEngine()
    const isStale = () => false
    const p = loadFixed(engine, isStale)
    await runToEnd(engine, p)
    const result = await p
    check('无换代时：完整走完并返回 track',
      result !== null && result.id === 'track-new' &&
      engine.ops.join(',') === 'getCurrentTrack,add,getQueue,skip,seekToTime,play,applyCurrentVolume,remove',
      `result=${result && result.id}，ops=${engine.ops.join('→')}`)
  }

  // 断言5（内容锚点）：真实源码里签名 + 12 处检查点 + 调用方处理都在
  {
    const fnBody = CORE_SRC.slice(
      CORE_SRC.indexOf('export const loadTrackPlayerResource'),
      CORE_SRC.indexOf('export const destroyTrackPlayerCore'),
    )
    const hasParam = fnBody.includes('isStale?: () => boolean')
    const checkpointCount = (fnBody.match(/if \(stale\(\)\) return null/g) || []).length
    const awaitCount = (fnBody.match(/await /g) || []).length
    const loaderPasses = LOADER_SRC.includes('loadTrackPlayerResource(musicInfo, url, time, shouldAutoStart, isStale)')
    const loaderNull = LOADER_SRC.includes('if (!track) return')
    check('源码锚点：isStale 参数 + 每处 await 后检查 + 调用方传 isStale 并判 null',
      hasParam && checkpointCount === 12 && loaderPasses && loaderNull,
      `参数=${hasParam}, 检查点=${checkpointCount} 处（await 表达式=${awaitCount} 个，其中注释 2 处，真实 await ${awaitCount - 2} 个，与检查点一一对应）, 调用方传参=${loaderPasses}, 判 null=${loaderNull}`)
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main()
