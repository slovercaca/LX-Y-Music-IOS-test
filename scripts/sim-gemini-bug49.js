/**
 * sim-gemini-bug49.js
 *
 * Bug 49（部分真实，潜伏风险）：utils/request.js 对已序列化的 JSON 字符串体
 * 二次 JSON.stringify——字符串 body 会被包一层引号并转义内部引号；当前库内
 * 暂无触发调用方（全部字符串 body 都显式用 form-urlencoded，全部 json 调用方
 * 传的都是对象），属潜伏风险修复。
 *
 * 钉住的修复不变量：application/json 的 stringify 分支加
 * typeof options.body !== 'string' 条件；对象 body 行为不变。
 * 注意：同型代码在 src/core/init/userApi/request.js:58-59 也有一份，归一号工人，
 * 本脚本只钉 src/utils/request.js。
 *
 * 运行：node scripts/sim-gemini-bug49.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { request: read('src/utils/request.js') }

const structuralReasons = (files) => {
  const reasons = []
  const code = files.request
  if (!code.includes("typeof options.body !== 'string'")) {
    reasons.push('request.js 的 JSON stringify 分支缺少 typeof body !== \'string\' 条件')
  }
  if (!code.includes("contentType.startsWith('application/json') && options.body && typeof options.body !== 'string'")) {
    reasons.push('request.js 的 stringify 条件不完整（须同时含 json 判定、body 存在与非字符串判定）')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型：body 序列化（与修复后代码同逻辑）
const models = []
const maybeStringify = (contentType, body) => {
  if (typeof contentType === 'string' && contentType.startsWith('application/json') && body && typeof body !== 'string') {
    return JSON.stringify(body)
  }
  return body
}
{
  models.push(['模型：已序列化的 JSON 字符串不再二次 stringify', maybeStringify('application/json', '{"a":1}') === '{"a":1}'])
  models.push(['模型：带 charset 的 json Content-Type 下字符串同样不二次转义', maybeStringify('application/json; charset=utf-8', '{"a":1}') === '{"a":1}'])
  models.push(['模型：对象 body 仍被 stringify', maybeStringify('application/json', { a: 1 }) === '{"a":1}'])
  models.push(['模型：非 json Content-Type 下对象 body 不动', maybeStringify('application/x-www-form-urlencoded', { a: 1 }) && typeof maybeStringify('application/x-www-form-urlencoded', { a: 1 }) === 'object'])
  models.push(['模型：空 body 不动', maybeStringify('application/json', '') === '' && maybeStringify('application/json', null) === null])
  // 反面：旧逻辑对字符串二次转义
  const oldStringify = (contentType, body) => {
    if (typeof contentType === 'string' && contentType.startsWith('application/json') && body) {
      return JSON.stringify(body)
    }
    return body
  }
  models.push(['反面教材：旧逻辑把 \'{"a":1}\' 包成 \'"{"a":1}"\'', oldStringify('application/json', '{"a":1}') === '"{\\"a\\":1}"'])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, request: REAL.request.replace(" && typeof options.body !== 'string'", '') }
  cases.push(['typeof body !== \'string\' 条件被删', structuralReasons(tampered).length > 0])
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
