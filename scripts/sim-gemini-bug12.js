/**
 * sim-gemini-bug12.js
 *
 * Bug 12（Gemini 全量审查 2026-11-21，核实：真实）：
 * src/plugins/lxLyricPlayer.ts 的 formatTimeLabel 误删小数点后前导零。
 *
 * 机制（两处，核实报告订正后）：
 *   ① 时间放大：tRxp3 = /\.0+(\d+)/ 把 [00:12.05] 归一成 '0:12.5'，msTime '5'
 *      再 padEnd(3,'0') 得 500ms（正确值 50ms）；.04→400 vs 40、.09→900 vs 90，
 *      均超过 buildWordsMap 的 300ms 对齐阈值，该行逐字丢失。仅 isMsTime=false
 *      时触发；被放大的是行时间戳小数部分（逐字 <start,duration> 不走这条路）。
 *   ② 键冲突（无条件，报告漏掉）：formatTimeLabel 同时是 linesMap 键归一化函数，
 *      '.05' 与 '.5' 会归一成同一个键，后出现的行被当作前一行的 extendedLyrics，
 *      整行从 lines 中消失。
 *
 * 修法：去掉 .replace(tRxp3, '.$1')；msTime 统一截断/右补 0 至 3 位解析
 * （.5→500、.05→50、.005→5、.123→123），不再按 isMsTime 分支；键冲突同时消除。
 *
 * 本脚本 1:1 复刻修复后的 formatTimeLabel + initLines 解析算法，逐条验证 8 个断言；
 * 另用内容锚点钉住真实源码（tRxp3 已删、统一解析已上）。
 *
 * 运行：node scripts/sim-gemini-bug12.js
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'src/plugins/lxLyricPlayer.ts'), 'utf8')

// ---------------------------------------------------------------------------
// 模型：复刻修复后的解析算法（与 src/plugins/lxLyricPlayer.ts 逐行对应）
// ---------------------------------------------------------------------------

const timeFieldExp = /^(?:\[[\d:.]+\])+/g
const timeExp = /\d{1,3}(:\d{1,3}){0,2}(?:\.\d{1,3})/g
const tRxp1 = /^0+(\d+)/
const tRxp2 = /:0+(\d+)/g
// 修复后：无 tRxp3，小数部分原样保留
const formatTimeLabel = (label) => {
  return label.replace(tRxp1, '$1')
    .replace(tRxp2, ':$1')
}

const parseLyric = (lyric) => {
  const lines = lyric.split(/\r\n|\n|\r/)
  const linesMap = {}
  for (const rawLine of lines) {
    const line = rawLine.trim()
    const result = timeFieldExp.exec(line)
    if (!result) continue
    const timeField = result[0]
    const text = line.replace(timeFieldExp, '').trim()
    if (!text) continue
    const times = timeField.match(timeExp)
    if (times == null) continue
    for (let time of times) {
      time = formatTimeLabel(time)
      if (linesMap[time]) {
        linesMap[time].extendedLyrics.push(text)
        continue
      }
      const timeArr = time.split(':')
      if (timeArr.length > 3) continue
      if (timeArr.length < 3) {
        for (let i = 3 - timeArr.length; i--;) timeArr.unshift('0')
      }
      if (timeArr[2].includes('.')) timeArr.splice(2, 1, ...timeArr[2].split('.'))
      const msTime = (timeArr[3] || '0').slice(0, 3).padEnd(3, '0')
      linesMap[time] = {
        time: parseInt(timeArr[0]) * 60 * 60 * 1000 + parseInt(timeArr[1]) * 60 * 1000 + parseInt(timeArr[2]) * 1000 + parseInt(msTime),
        text,
        extendedLyrics: [],
      }
    }
  }
  return Object.values(linesMap).sort((a, b) => a.time - b.time)
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

let pass = 0; let fail = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
  ok ? pass++ : fail++
}

console.log('sim-gemini-bug12：lxLyric 时间戳小数解析 + 键归一化\n')

// 断言1：前导零小数不再被放大（Bug 12① 主害）
{
  const lines = parseLyric('[00:12.05]第一行\n[00:20.04]第二行\n[00:30.09]第三行')
  check('[00:12.05] 解析为 12050ms（旧逻辑 12500ms，放大 450ms）',
    lines[0].time === 12050, `实际 ${lines[0].time}ms`)
  check('[00:20.04] 解析为 20040ms（旧逻辑 20400ms）',
    lines[1].time === 20040, `实际 ${lines[1].time}ms`)
  check('[00:30.09] 解析为 30090ms（旧逻辑 30900ms）',
    lines[2].time === 30090, `实际 ${lines[2].time}ms`)
}

// 断言2：一位/三位小数按十进制小数语义解析
{
  const lines = parseLyric('[00:10.5]半秒\n[00:11.50]半秒2\n[00:12.123]毫秒\n[00:13.005]五毫秒')
  check('[00:10.5] 与 [00:11.50] 均为 500ms 小数部分',
    lines[0].time === 10500 && lines[1].time === 11500,
    `实际 ${lines[0].time}ms / ${lines[1].time}ms`)
  check('[00:12.123] 解析为 12123ms，[00:13.005] 解析为 13005ms',
    lines[2].time === 12123 && lines[3].time === 13005,
    `实际 ${lines[2].time}ms / ${lines[3].time}ms`)
}

// 断言3：时:分:秒 三段 + 小数
{
  const lines = parseLyric('[01:02:03.45]长歌')
  check('[01:02:03.45] 解析为 3723450ms',
    lines[0].time === 3723450, `实际 ${lines[0].time}ms`)
}

// 断言4：键冲突消除（Bug 12②）——.05 与 .5 不再归一成同一个键
{
  const lines = parseLyric('[00:12.05]零五\n[00:12.5]零点五')
  check('.05 行与 .5 行各存一行（旧逻辑后者被吞成 extendedLyrics，整行消失）',
    lines.length === 2 && lines[0].time === 12050 && lines[1].time === 12500,
    `行数=${lines.length}，时间=${lines.map(l => l.time).join('/')}ms`)
}

// 断言5：同时间戳多行仍正常合并为 extendedLyrics（归一化本意保留）
// 注意：'.50' 与 '.5' 文本不同、键不同（旧逻辑亦然），不合并；
// 真正的归一化是 tRxp1/tRxp2 负责的整数部分前导零（00:12 与 0:12 同键）。
{
  const lines = parseLyric('[00:12.50]原文\n[0:12.50]同时间戳另一行')
  check('同一时刻 [00:12.50] 与 [0:12.50] 仍归一合并（extendedLyrics 机制保留）',
    lines.length === 1 && lines[0].extendedLyrics.length === 1 && lines[0].time === 12500,
    `行数=${lines.length}，extended=${lines[0].extendedLyrics.length}，时间=${lines[0].time}ms`)
}

// 断言6：内容锚点——真实源码里 tRxp3 已删、统一解析已上、isMsTime 分支已除
{
  const noTRxp3Code = !SRC.includes('const tRxp3') && !SRC.includes('.replace(tRxp3')
  const hasUnifiedParse = SRC.includes("(timeArr[3] || '0').slice(0, 3).padEnd(3, '0')")
  const noMsBranch = !SRC.includes('isMsTime ?') && !SRC.includes('const isMsTime')
  check('源码锚点：tRxp3 已删 + msTime 统一截断/右补 0 至 3 位 + isMsTime 分支已除',
    noTRxp3Code && hasUnifiedParse && noMsBranch,
    `无 tRxp3 代码=${noTRxp3Code}, 统一解析=${hasUnifiedParse}, 无 isMsTime 分支=${noMsBranch}`)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
