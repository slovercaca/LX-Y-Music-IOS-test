/**
 * sim-gemini-bug13.js
 *
 * Bug 13（Gemini 全量审查 2026-11-21，核实：真实）：
 * src/core/lyric.ts 的 toggleTranslation / toggleRoma 暂停态切换后未重锚。
 *
 * 机制：两者均为 `lrcToggleTranslation(...); if (playerState.isPlay) play()`——
 * 暂停时不重锚。而 lrc.setLyric() 重解析+自动暂停 ticker，插件层 onSetLyric 把
 * 当前行重置为 0 并触发 hook(-1, '')，UI 置为 {line: 0, text: ''}。播放态 play()
 * 会异步重锚（短暂闪回顶部后恢复）；暂停态没有任何重锚，高亮停在顶部直到下次
 * 恢复播放。暂停后在设置页切换翻译/罗马音开关即复现。
 *
 * 修法（core 层，改动最小）：切换后无论播放/暂停都取实时位置调
 * anchorLyric(position * 1000, playerState.isPlay)——anchorLyric 本身就是
 * "暂停只落行不推进、播放继续推进"语义，无需再分流。
 *
 * 本脚本复刻 anchorLyric 的双态语义并模拟暂停态切换流程，验证 4 个断言；
 * 另用内容锚点钉住真实源码里的两处重锚调用。
 *
 * 运行：node scripts/sim-gemini-bug13.js
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'src/core/lyric.ts'), 'utf8')
const PLUGIN_SRC = fs.readFileSync(path.join(ROOT, 'src/plugins/lyric.ts'), 'utf8')

// ---------------------------------------------------------------------------
// 模型：复刻 anchorLyric 语义 + 切换流程
// ---------------------------------------------------------------------------

// 假 lrc-file-parser：play 启动 ticker 并落行，pause 停 ticker 但保留当前行
const makeLrc = () => {
  const lines = [0, 5000, 12000, 20000, 30000] // 行起点（ms）
  return {
    tickerRunning: false,
    currentLine: 0,
    play(timeMs) {
      this.tickerRunning = true
      this.currentLine = lines.reduce((acc, t, i) => (t <= timeMs ? i : acc), 0)
    },
    pause() { this.tickerRunning = false },
    setLyric() { this.tickerRunning = false; this.currentLine = 0 }, // 重解析：暂停 + 行归零
  }
}

// 复刻插件层 anchorLyric（src/plugins/lyric.ts）
const anchorLyric = (lrc, timeMs, isPlaying) => {
  lrc.play(timeMs)
  if (!isPlaying) lrc.pause()
}

// 复刻修复后的 core 层 toggle 流程（src/core/lyric.ts）
// getReliableLyricPosition 简化为直接返回引擎位置（秒）
const toggleAfterFix = async(lrc, isPlay, enginePositionSec) => {
  lrc.setLyric() // lrcToggleTranslation / lrcToggleRoma 内部：重解析，行归零
  const position = enginePositionSec
  anchorLyric(lrc, position * 1000, isPlay)
}

// 复刻修复前的 core 层 toggle 流程（仅播放态重锚）
const toggleBeforeFix = async(lrc, isPlay, enginePositionSec) => {
  lrc.setLyric()
  if (isPlay) lrc.play(enginePositionSec * 1000)
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
  console.log('sim-gemini-bug13：暂停态切换翻译/罗马音重锚\n')

  // 断言1（主害复现·反例）：修复前，暂停态切换后高亮停在顶部（行 0）
  {
    const lrc = makeLrc()
    lrc.play(25000) // 正在第 3 行（20000 起）
    lrc.pause() // 用户暂停
    await toggleBeforeFix(lrc, false, 25)
    check('修复前·暂停态切换：高亮停在行 0（缺陷存在，反例）',
      lrc.currentLine === 0 && lrc.tickerRunning === false,
      `行=${lrc.currentLine}，ticker=${lrc.tickerRunning}`)
  }

  // 断言2（修复验证，断言1的反例）：修复后，暂停态切换后落到正确行且不推进
  {
    const lrc = makeLrc()
    lrc.play(25000)
    lrc.pause()
    await toggleAfterFix(lrc, false, 25)
    check('修复后·暂停态切换：落到正确行（第 3 行）且 ticker 不启动',
      lrc.currentLine === 3 && lrc.tickerRunning === false,
      `行=${lrc.currentLine}，ticker=${lrc.tickerRunning}`)
  }

  // 断言3（播放态回归）：修复后，播放态切换仍重锚并继续推进
  {
    const lrc = makeLrc()
    lrc.play(25000)
    await toggleAfterFix(lrc, true, 25)
    check('修复后·播放态切换：落到正确行且 ticker 继续推进',
      lrc.currentLine === 3 && lrc.tickerRunning === true,
      `行=${lrc.currentLine}，ticker=${lrc.tickerRunning}`)
  }

  // 断言4（内容锚点）：真实源码里两处 toggle 都无条件重锚
  {
    const toggleBlock = CORE_SRC.slice(
      CORE_SRC.indexOf('export const toggleTranslation'),
      CORE_SRC.indexOf('export const play ='),
    )
    const anchorCalls = (toggleBlock.match(/lrcAnchorLyric\(position \* 1000, playerState\.isPlay\)/g) || []).length
    const noPlayGate = !toggleBlock.includes('if (playerState.isPlay) play()')
    const hasImport = CORE_SRC.includes('anchorLyric as lrcAnchorLyric')
    check('源码锚点：两处 toggle 均调 anchorLyric(pos, isPlay)，旧的播放态门控已除',
      anchorCalls === 2 && noPlayGate && hasImport,
      `重锚调用=${anchorCalls} 处，无旧门控=${noPlayGate}，有导入=${hasImport}`)
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main()
