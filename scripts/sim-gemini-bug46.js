/**
 * sim-gemini-bug46.js
 *
 * Bug 46（真实）：网易云歌词 getIntv 分钟权重误按小时计算——m 是分钟（LRC 标签
 * [mm:ss.xx]），却乘了 3600000（1 小时的毫秒数）；跨分钟边界的翻译/罗马音配对
 * 差值被算成约 59 分钟，过不了 100ms 判定，行被丢弃。
 *
 * 钉住的修复不变量：分钟乘 60000。毫秒部分 parseInt("05") 得 5 的问题两侧一致、
 * 对差值影响有限，超出本 bug 范围，不动。
 *
 * 运行：node scripts/sim-gemini-bug46.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { lyric: read('src/utils/musicSdk/wy/lyric.js') }

const sliceFn = (code, startMark, endMark) => {
  const start = code.indexOf(startMark)
  const end = code.indexOf(endMark, start)
  return start === -1 ? '' : code.slice(start, end === -1 ? code.length : end)
}

const structuralReasons = (files) => {
  const reasons = []
  const code = files.lyric
  const getIntvBody = sliceFn(code, 'getIntv(interval) {', 'fixTimeTag(lrc, targetlrc) {')
  if (!getIntvBody.includes('parseInt(m) * 60000')) {
    reasons.push('getIntv 的分钟权重不是 60000')
  }
  // 只查代码行（注释里提 3600000 是交代旧值，不算残留）
  const codeLines = getIntvBody.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  if (codeLines.includes('3600000')) {
    reasons.push('getIntv 还有 3600000（分钟被当小时算）')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型：getIntv（与修复后代码同逻辑）
const models = []
const getIntv = (interval) => {
  if (!interval) return 0
  if (!interval.includes('.')) interval += '.0'
  const arr = interval.split(/:|\./)
  while (arr.length < 3) arr.unshift('0')
  const [m, s, ms] = arr
  return parseInt(m) * 60000 + parseInt(s) * 1000 + parseInt(ms)
}
models.push(['模型：01:00.00 = 60000ms', getIntv('01:00.00') === 60000])
models.push(['模型：02:30.50 = 150050ms', getIntv('02:30.50') === 150050])
models.push(['模型：00:00.00 = 0ms', getIntv('00:00.00') === 0])
models.push(['模型：跨分钟同毫秒配对差值 1000ms（00:59.50 对 01:00.50）', Math.abs(getIntv('01:00.50') - getIntv('00:59.50')) === 1000])
{
  // 反面：旧 3600000 权重下跨分钟差值约 59 分钟
  const getIntvOld = (interval) => {
    if (!interval) return 0
    if (!interval.includes('.')) interval += '.0'
    const arr = interval.split(/:|\./)
    while (arr.length < 3) arr.unshift('0')
    const [m, s, ms] = arr
    return parseInt(m) * 3600000 + parseInt(s) * 1000 + parseInt(ms)
  }
  models.push(['反面教材：旧权重下 01:00.05 与 00:59.95 差值约 3540910ms', Math.abs(getIntvOld('01:00.05') - getIntvOld('00:59.95')) === 3540910])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, lyric: REAL.lyric.replace('parseInt(m) * 60000', 'parseInt(m) * 3600000') }
  cases.push(['分钟权重改回 3600000', structuralReasons(tampered).length > 0])
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
