/**
 * sim-gemini-bug11.js
 *
 * Bug 11（Gemini 全量审查 2026-11-21，核实：真实）：
 * src/plugins/lyric.ts 的 setLyric 异步重锚竞态。
 *
 * 机制：setLyric 捕获 wasPlaying 后 `void getPosition().then(pos => anchorLyric(pos, wasPlaying))`，
 * 回调返回时可能已切歌/暂停/另有一次重锚——
 *   ① 冻结方向：捕获 wasPlaying=false 后 core play() 先启动 ticker，插件回调后返回
 *      anchorLyric(pos, false) 把刚启动的 ticker 杀掉，歌词冻结；
 *   ② 错误推进方向：捕获 wasPlaying=true 后用户暂停，回调在暂停态重启 ticker，
 *      歌词无声推进（探针只在 playing 时运行，不自愈）。
 * 另有两条并发重锚链：core/lyric.setLyric() 在调完插件层后立即调 play()。
 *
 * 修法：递增代际 lyricAnchorGen（与 setMusicUrlGen / loadGeneration 同款范式）。
 * setLyric 入口捕获本轮代际，异步 .then/.catch 回调校验代际、过期丢弃；
 * play()/pause()/anchorLyric() 均为显式重锚，各自推进代际（最新一次重锚胜出）。
 *
 * 本脚本 1:1 复刻代际逻辑（假 ticker + 可控异步 getPosition），逐条验证 8 项检查；
 * 另用内容锚点钉住真实源码里的代际声明、捕获与校验。
 *
 * 运行：node scripts/sim-gemini-bug11.js
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'src/plugins/lyric.ts'), 'utf8')

// ---------------------------------------------------------------------------
// 模型：复刻修复后的代际逻辑（与 src/plugins/lyric.ts 逐行对应）
// ---------------------------------------------------------------------------

const makeModel = () => {
  // 假 lrc-file-parser：ticker 状态 + 最后一次 play 的时间
  const lrc = {
    tickerRunning: false,
    lastPlayTime: null,
    play(time) { this.tickerRunning = true; this.lastPlayTime = time },
    pause() { this.tickerRunning = false },
  }
  let lyricAnchorGen = 0
  let isPlay = false
  // 可控的 getPosition：每次调用入队一个待决 Promise，调用方按下标手动 resolve/reject
  //（连续两次 setLyric 会产生两个在途 Promise，须分别控制）
  const pendings = []
  const getPosition = () => new Promise((resolve, reject) => { pendings.push({ resolve, reject }) })

  // 复刻 anchorLyric：显式重锚推进代际
  const anchorLyric = (timeMs, isPlaying) => {
    lyricAnchorGen++
    lrc.play(timeMs)
    if (!isPlaying) lrc.pause()
    isPlay = isPlaying
  }
  // 复刻 play / pause：显式重锚推进代际
  const play = (time) => { lyricAnchorGen++; isPlay = true; lrc.play(time ?? 0) }
  const pause = () => { lyricAnchorGen++; isPlay = false; lrc.pause() }
  // 复刻 setLyric：捕获代际，异步回调校验
  const setLyric = () => {
    const wasPlaying = isPlay
    const gen = ++lyricAnchorGen
    isPlay = false
    lrc.pause() // lrc-file-parser 的 setLyric() 会自动暂停内部 ticker
    void getPosition()
      .then((position) => {
        if (gen !== lyricAnchorGen) return
        try { anchorLyric((position || 0) * 1000, wasPlaying) } catch {}
      })
      .catch(() => {
        if (gen !== lyricAnchorGen) return
        isPlay = wasPlaying
      })
  }
  return {
    lrc,
    get isPlay() { return isPlay },
    get gen() { return lyricAnchorGen },
    play, pause, anchorLyric, setLyric,
    resolvePosition: (pos, index = 0) => { pendings[index].resolve(pos) },
    rejectPosition: (index = 0) => { pendings[index].reject(new Error('bridge fail')) },
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

let pass = 0; let fail = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
  ok ? pass++ : fail++
}

const main = async() => {
  console.log('sim-gemini-bug11：setLyric 异步重锚代际校验\n')

  // 断言1（冻结方向，Bug 11①）：暂停态 setLyric（wasPlaying=false 在途），
  // core play() 先启动 ticker → 旧回调必须丢弃，ticker 保持运行
  {
    const m = makeModel()
    m.setLyric() // wasPlaying=false，gen=1
    m.play(30000) // core 第二条重锚链，gen=2，ticker 启动
    m.resolvePosition(30)
    await tick(); await tick()
    check('冻结方向：play() 后旧 setLyric 回调丢弃，ticker 保持运行',
      m.lrc.tickerRunning === true && m.lrc.lastPlayTime === 30000,
      `tickerRunning=${m.lrc.tickerRunning}, lastPlayTime=${m.lrc.lastPlayTime}`)
  }

  // 断言2（错误推进方向，Bug 11②）：播放态 setLyric（wasPlaying=true 在途），
  // 用户暂停 → 旧回调必须丢弃，ticker 保持暂停
  {
    const m = makeModel()
    m.play(10000)
    m.setLyric() // wasPlaying=true，gen=2（setLyric 内先暂停 ticker）
    m.pause() // gen=3
    m.resolvePosition(10)
    await tick(); await tick()
    check('错误推进方向：pause() 后旧 setLyric 回调丢弃，ticker 保持暂停',
      m.lrc.tickerRunning === false && m.isPlay === false,
      `tickerRunning=${m.lrc.tickerRunning}, isPlay=${m.isPlay}`)
  }

  // 断言3（正常路径·播放）：无干预时回调正常重锚，ticker 从引擎位置继续推进
  {
    const m = makeModel()
    m.play(5000)
    m.setLyric() // wasPlaying=true
    m.resolvePosition(42.5)
    await tick(); await tick()
    check('正常路径·播放：无干预时回调重锚并重启 ticker',
      m.lrc.tickerRunning === true && m.lrc.lastPlayTime === 42500,
      `tickerRunning=${m.lrc.tickerRunning}, lastPlayTime=${m.lrc.lastPlayTime}`)
  }

  // 断言4（正常路径·暂停）：暂停态 setLyric，无干预时回调只落行不推进
  {
    const m = makeModel()
    m.setLyric() // wasPlaying=false
    m.resolvePosition(20)
    await tick(); await tick()
    check('正常路径·暂停：无干预时回调落行且不启动 ticker',
      m.lrc.tickerRunning === false && m.lrc.lastPlayTime === 20000 && m.isPlay === false,
      `tickerRunning=${m.lrc.tickerRunning}, lastPlayTime=${m.lrc.lastPlayTime}`)
  }

  // 断言5（连续两次 setLyric）：第二轮 supersedes 第一轮，旧回调丢弃
  {
    const m = makeModel()
    m.play(1000)
    m.setLyric() // gen=2，产生第 0 个在途 getPosition
    m.setLyric() // gen=3，产生第 1 个在途 getPosition，旧回调应作废
    m.resolvePosition(99, 0) // 第一轮回调返回 99s（陈旧位置）
    await tick(); await tick()
    check('连续两次 setLyric：第一轮回调丢弃，不用陈旧位置重锚',
      m.lrc.lastPlayTime !== 99000,
      `lastPlayTime=${m.lrc.lastPlayTime}（≠99000）`)
    m.resolvePosition(7, 1) // 第二轮回调返回
    await tick(); await tick()
    // 注意：第二轮 setLyric 入口时 isPlay 已被第一轮同步置 false，故其捕获的
    // wasPlaying=false，回调按暂停语义落行不启动 ticker——与真实代码逐行一致；
    // 真实流程里 core 的 play() 链（playerState.isPlay 仍为 true）随后会重启 ticker。
    check('连续两次 setLyric：第二轮回调正常生效（落到 7s，语义跟随捕获时的暂停态）',
      m.lrc.lastPlayTime === 7000 && m.lrc.tickerRunning === false && m.isPlay === false,
      `lastPlayTime=${m.lrc.lastPlayTime}, tickerRunning=${m.lrc.tickerRunning}, isPlay=${m.isPlay}`)
  }

  // 断言6（catch 分支代际）：getPosition reject 且已换代时，不恢复陈旧的 isPlay
  {
    const m = makeModel()
    m.play(1000)
    m.setLyric() // wasPlaying=true，isPlay 暂置 false
    m.pause() // 用户暂停，gen 推进，isPlay=false（真实状态）
    m.rejectPosition()
    await tick(); await tick()
    check('catch 分支：已换代时不把 isPlay 恢复成陈旧的 wasPlaying=true',
      m.isPlay === false,
      `isPlay=${m.isPlay}`)
  }

  // 断言7（内容锚点）：真实源码里的代际声明、捕获与校验都在
  {
    const hasDecl = SRC.includes('let lyricAnchorGen = 0')
    const hasCapture = SRC.includes('const gen = ++lyricAnchorGen')
    const guardCount = (SRC.match(/if \(gen !== lyricAnchorGen\) return/g) || []).length
    const bumpCount = (SRC.match(/lyricAnchorGen\+\+/g) || []).length
    check('源码锚点：代际声明 + 捕获 + 两处回调校验 + 三处推进都在',
      hasDecl && hasCapture && guardCount === 2 && bumpCount === 3,
      `声明=${hasDecl}, 捕获=${hasCapture}, 校验=${guardCount} 处（.then/.catch）, 推进=${bumpCount} 处（play/pause/anchorLyric，后缀++; setLyric 用前缀 ++ 捕获）`)
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main()
