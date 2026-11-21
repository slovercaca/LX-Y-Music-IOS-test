/**
 * sim-gemini-bug48.js
 *
 * Bug 48（真实）：storage.ts buildData 在 value === undefined 时崩溃——
 * JSON.stringify(undefined) 返回 undefined（非字符串），.length 必抛 TypeError；
 * saveData/saveDataMultiple 的 catch 末尾都 throw e，异常继续向上传播。
 *
 * 钉住的修复不变量：valueStr 用 ?? 'null' 兜底（同时覆盖 function/symbol 等
 * 同样返回 undefined 的输入）；读回 'null' 时 getData 返回 null，与键缺失一致。
 *
 * 运行：node scripts/sim-gemini-bug48.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { storage: read('src/plugins/storage.ts') }

const structuralReasons = (files) => {
  const reasons = []
  const code = files.storage
  if (!code.includes("const valueStr = JSON.stringify(value) ?? 'null'")) {
    reasons.push('buildData 未用 ?? \'null\' 兜底（undefined/function/symbol 输入会崩）')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型：buildData 的序列化（与修复后代码同逻辑）
const models = []
const buildValueStr = (value) => JSON.stringify(value) ?? 'null'
{
  models.push(['模型：undefined 序列化为 \'null\'，.length 可用', buildValueStr(undefined) === 'null' && buildValueStr(undefined).length === 4])
  models.push(['模型：function 序列化为 \'null\'', buildValueStr(() => {}) === 'null'])
  models.push(['模型：symbol 序列化为 \'null\'', buildValueStr(Symbol('x')) === 'null'])
  models.push(['模型：正常对象不受影响', buildValueStr({ a: 1 }) === '{"a":1}'])
  models.push(['模型：字符串不受影响', buildValueStr('abc') === '"abc"'])
  models.push(['模型：null 本身序列化为 \'null\'', buildValueStr(null) === 'null'])
  models.push(['模型：读回 \'null\' 得 null，与键缺失一致', JSON.parse(buildValueStr(undefined)) === null])
  // 反面：旧逻辑对 undefined 取 .length 抛 TypeError
  let oldThrew = false
  try { const s = JSON.stringify(undefined); void s.length } catch (e) { oldThrew = e instanceof TypeError }
  models.push(['反面教材：旧逻辑对 undefined 取 .length 抛 TypeError', oldThrew === true])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, storage: REAL.storage.replace("const valueStr = JSON.stringify(value) ?? 'null'", 'let valueStr = JSON.stringify(value)') }
  cases.push(['?? \'null\' 兜底被删', structuralReasons(tampered).length > 0])
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
