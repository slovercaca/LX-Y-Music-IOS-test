#!/usr/bin/env node
/**
 * Bug 53 契约（Gemini 审查 2026-11-21）：
 *   日推相似歌曲预取在缓存变更早退时未复位 isFetching——processQueue 内
 *   唯一一处早退漏了复位：if (!currentCache || currentCache.dailyRecId !==
 *   currentDailyRecId) return。isFetching 是模块级单例锁，一旦卡住，同次挂载
 *   周期内所有后续预取都在入口被拦截（仅卸载时 cleanup 能解开）。
 *
 * 钉住的不变量：
 *   - 缓存变更早退分支 return 前有 similarSongsFetcher.isFetching = false。
 *   - processQueue 内 6 处早退/结束点全部复位（全文件共 8 处，另两处是
 *     卸载 cleanup 与「全部已获取」分支）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = path.join(ROOT, 'src/screens/Home/Views/DailyRec/RecSongs.tsx')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    check(false, `读取失败：${p}`)
    return ''
  }
}

console.log('Bug 53 日推预取 isFetching 复位契约：')

const src = read(FILE)

check(
  /if \(!currentCache \|\| currentCache\.dailyRecId !== currentDailyRecId\) \{[\s\S]*?similarSongsFetcher\.isFetching = false[\s\S]*?return\s*\}/.test(src),
  '缓存变更早退分支 return 前复位 isFetching',
)
check(
  !/if \(!currentCache \|\| currentCache\.dailyRecId !== currentDailyRecId\) return/.test(src),
  '不再有无复位的单行早退 return（旧代码）',
)
const processStart = src.indexOf('const processQueue')
const processBody = processStart >= 0 ? src.slice(processStart, src.indexOf('await processQueue()', processStart)) : ''
const resetsInQueue = (processBody.match(/similarSongsFetcher\.isFetching = false/g) || []).length
check(
  resetsInQueue === 6,
  `processQueue 内 isFetching 复位共 6 处（实际 ${resetsInQueue} 处）`,
)
const resetsTotal = (src.match(/similarSongsFetcher\.isFetching = false/g) || []).length
check(
  resetsTotal === 8,
  `全文件 isFetching 复位共 8 处（实际 ${resetsTotal} 处）`,
)

if (failures > 0) {
  console.log(`\n✗ ${failures} 项检查失败`)
  process.exit(1)
}
console.log('\n✓ 全部检查通过')
