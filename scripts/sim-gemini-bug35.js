/**
 * sim-gemini-bug35.js
 *
 * Bug 35（真实）：getListDetailAll 在 result.total === 0 时首屏短路无法翻页——
 * `list.length >= total` 在 total 为 0 时恒成立，下方「拿不到 total 时翻到没有
 * 新歌为止」的退化循环永远不可达。
 *
 * 钉住的修复不变量：
 *   - 首屏短路加 total > 0 前提。
 *   - 不加 Gemini 建议的 !result.list.length 子句（首屏偶发空页但后续源页有歌时
 *     会被提前截断）。
 *
 * 运行：node scripts/sim-gemini-bug35.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { songlist: read('src/core/songlist.ts') }

const structuralReasons = (files) => {
  const reasons = []
  const code = files.songlist
  if (!code.includes('if (result.total > 0 && result.list.length >= result.total) {')) {
    reasons.push('getListDetailAll 首屏短路缺少 total > 0 前提')
  }
  if (code.includes('if (result.list.length >= result.total) {')) {
    reasons.push('getListDetailAll 还有无 total 守卫的旧短路条件')
  }
  if (code.includes('!result.list.length')) {
    reasons.push('getListDetailAll 加了 !result.list.length 子句（首屏偶发空页会被提前截断）')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型：短路判定（与修复后代码同逻辑）
const models = []
const shouldShortCircuit = (total, len) => total > 0 && len >= total
models.push(['短路：total=0、首屏 5 首时不短路（继续翻页）', shouldShortCircuit(0, 5) === false])
models.push(['短路：total=0、首屏空时不短路（退化循环接手）', shouldShortCircuit(0, 0) === false])
models.push(['短路：total=10、首屏 10 首时短路', shouldShortCircuit(10, 10) === true])
models.push(['短路：total=10、首屏 5 首时不短路', shouldShortCircuit(10, 5) === false])
models.push(['短路：total 未给（undefined）时不短路', shouldShortCircuit(undefined, 5) === false])
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, songlist: REAL.songlist.replace('if (result.total > 0 && result.list.length >= result.total)', 'if (result.list.length >= result.total)') }
  cases.push(['total > 0 前提被删（total=0 歌单又丢后续页）', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, songlist: REAL.songlist.replace('if (result.total > 0 && result.list.length >= result.total)', 'if (!result.list.length || (result.total > 0 && result.list.length >= result.total))') }
  cases.push(['加了 !result.list.length 子句（空页提前截断）', structuralReasons(tampered).length > 0])
}
const failedCases = cases.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
console.log('== 结构不变量 ==')
if (realReasons.length === 0) console.log('  PASS 全部结构不变量成立')
else for (const r of realReasons) console.log(`  FAIL ${r}`)

console.log('== 行为模型 ==')
for (const [name, pass] of models) console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`)

console.log('== 反例自检（必须全部拦下） ==')
for (const [name, pass] of cases) console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`)

const failed = realReasons.length + failedModels.length + failedCases.length
console.log(failed === 0 ? '\n全部通过' : `\n共 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
