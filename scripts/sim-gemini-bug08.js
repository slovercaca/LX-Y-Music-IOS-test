/**
 * sim-gemini-bug08.js
 *
 * Gemini Bug 8（真实，有界）：userApi/request.js fetchData 在 handleRequestData
 * 异常时泄漏 BackgroundTimer。
 *
 * 成因：BackgroundTimer.clearTimeout 只挂在内层 fetch 链的 .finally 上；
 * handleRequestData 一旦 reject（encodeURIComponent 遇孤 surrogates 抛
 * URIError、JSON.stringify 遇循环引用抛 TypeError、method.toLocaleLowerCase()
 * 抛 TypeError，入参来自不可信用户脚本），外层 .then 不执行，timer 得不到
 * 提前清理。abort() 同样不清 timer。泄漏有界（timer 自身在 timeout 后触发
 * 并置 null），此处是提前释放。
 *
 * 修法（src/core/init/userApi/request.js）：
 *   外层 promise 加 .finally 清 timer（幂等清理 clearTimer）；abort() 内
 *   顺手 clearTimeout。
 *
 * 附带（Bug 49 同型）：同文件 58-59 行对已序列化的 JSON 字符串体二次
 * JSON.stringify（用户自定义音源脚本可触发），加 typeof body !== 'string' 条件。
 *
 * 运行：node scripts/sim-gemini-bug08.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILE = 'src/core/init/userApi/request.js'
const real = fs.readFileSync(path.join(ROOT, FILE), 'utf8').replace(/\r\n/g, '\n')

const windowBetween = (src, startAnchor, endAnchor, fallback = 3000) => {
  const start = src.indexOf(startAnchor)
  if (start < 0) return ''
  const end = src.indexOf(endAnchor, start + startAnchor.length)
  return end < 0 ? src.slice(start, start + fallback) : src.slice(start, end)
}

const invariants = (src) => {
  const reasons = []

  // ① 幂等清理 helper
  if (!/const clearTimer = \(\) => \{/.test(src)) {
    reasons.push('缺幂等清理 helper clearTimer')
  }
  const helper = windowBetween(src, 'const clearTimer = () => {', 'return {')
  if (!/if \(id == null\) return/.test(helper) || !/BackgroundTimer\.clearTimeout\(id\)/.test(helper) || !/id = null/.test(helper)) {
    reasons.push('clearTimer 未做到"判空 + 清 timer + 置 null"幂等清理')
  }

  // ② 外层 .finally（handleRequestData 抛错时内层链不执行，全靠它兜底）
  const fetchData = windowBetween(src, 'export const fetchData', 'abort() {')
  if (!/\}\)\.finally\(clearTimer\)/.test(fetchData)) {
    reasons.push('外层 promise 缺 .finally(clearTimer)（handleRequestData 抛错时 timer 得不到清理）')
  }
  // ③ 内层 .finally 仍保留（正常路径提前清理）
  if (!/\.finally\(clearTimer\)/.test(fetchData)) {
    reasons.push('内层 fetch 链缺 .finally(clearTimer)')
  }
  // 外层 finally 必须出现两次（内层一次 + 外层一次）
  const finallyCount = (fetchData.match(/\.finally\(clearTimer\)/g) || []).length
  if (finallyCount < 2) {
    reasons.push(`.finally(clearTimer) 只出现 ${finallyCount} 次，应为 2 次（内层 + 外层）`)
  }

  // ④ abort() 清 timer
  const abortFn = windowBetween(src, 'abort() {', '}\n}')
  if (!/clearTimer\(\)/.test(abortFn)) {
    reasons.push('abort() 未清 timer')
  }

  // ⑤ Bug 49 同型：字符串 body 不二次 stringify
  if (!/typeof options\.body !== 'string'/.test(src)) {
    reasons.push('JSON body 缺 typeof !== \'string\' 条件（字符串体会被二次 stringify）')
  }
  const stringifyGuard = windowBetween(src, "if (headers['Content-Type'] === 'application/json'", 'return {')
  if (!/options\.body = JSON\.stringify\(options\.body\)/.test(stringifyGuard)) {
    reasons.push('JSON.stringify 调用丢失（结构已变）')
  }
  return reasons
}

// ---------------------------------------------------------------------------
// 行为模型：1:1 复刻 timer 生命周期 + body 序列化条件
// ---------------------------------------------------------------------------
const makeTimerEnv = () => {
  let alive = false
  let id = null
  return {
    setTimeout: () => { alive = true; id = 1; return id },
    clearTimeout: () => { alive = false; id = null },
    get alive() { return alive },
    get id() { return id },
  }
}
// 复刻 fetchData 的 timer 部分（handleRequestData 成功/失败两条路）
const fetchDataModel = async(env, { requestDataFails = false, abortEarly = false } = {}) => {
  let id = env.setTimeout()
  const clearTimer = () => {
    if (id == null) return
    env.clearTimeout(id)
    id = null
  }
  const abort = () => { clearTimer() }
  const request = (async() => {
    if (requestDataFails) throw new Error('bad input')
    await Promise.resolve() // fetch
    return { ok: true }
  })()
    .finally(clearTimer) // 内层
    .finally(clearTimer) // 外层（与实现同结构：外层 .finally 挂在链尾）
  if (abortEarly) abort()
  try {
    await request
    return 'resolved'
  } catch {
    return 'rejected'
  }
}
const stringifyBody = (body) => (typeof body !== 'string' ? JSON.stringify(body) : body)

const runModels = async() => {
  const models = []
  {
    const env = makeTimerEnv()
    const r = await fetchDataModel(env, { requestDataFails: true })
    models.push(['handleRequestData 抛错：外层 finally 仍清理 timer',
      r === 'rejected' && env.alive === false])
  }
  {
    const env = makeTimerEnv()
    const r = await fetchDataModel(env, { requestDataFails: false })
    models.push(['正常请求完成：timer 被清理', r === 'resolved' && env.alive === false])
  }
  {
    const env = makeTimerEnv()
    await fetchDataModel(env, { abortEarly: true })
    models.push(['abort()：timer 被清理', env.alive === false])
  }
  {
    const env = makeTimerEnv()
    // clearTimer 幂等：内层 + 外层 + abort 三次调用不抛错
    let id = env.setTimeout()
    const clearTimer = () => {
      if (id == null) return
      env.clearTimeout(id)
      id = null
    }
    clearTimer(); clearTimer(); clearTimer()
    models.push(['clearTimer 幂等：多次调用不抛错', env.alive === false])
  }
  models.push(['字符串 body 不二次 stringify',
    stringifyBody('{"a":1}') === '{"a":1}'])
  models.push(['对象 body 正常 stringify',
    stringifyBody({ a: 1 }) === '{"a":1}'])
  return models
}

// ---------------------------------------------------------------------------
// 反例自检
// ---------------------------------------------------------------------------
const tamper = (src, find, replace) => {
  if (!src.includes(find)) throw new Error(`tamper 锚点未命中: ${find}`)
  return src.split(find).join(replace)
}

const main = async() => {
  const models = await runModels()
  const failedModels = models.filter(([, ok]) => !ok)

  const cases = []
  const checkCase = (name, src, expectSubstr) => {
    let reasons = []
    try {
      reasons = invariants(src)
    } catch (err) {
      cases.push([name, false, `抛异常: ${err.message}`])
      return
    }
    const hit = reasons.some((r) => r.includes(expectSubstr))
    cases.push([name, hit, hit ? '已拦下' : `未拦下（reasons=${JSON.stringify(reasons)}）`])
  }

  checkCase('C1 去掉外层 .finally',
    tamper(real, '    }).finally(clearTimer),\n', '    }),\n'),
    '外层 promise 缺 .finally')
  checkCase('C2 abort() 不清 timer',
    tamper(real, '    abort() {\n      controller.abort()\n      clearTimer()\n    },', '    abort() {\n      controller.abort()\n    },'),
    'abort() 未清 timer')
  checkCase('C3 去掉 typeof !== \'string\' 条件',
    tamper(real, " && typeof options.body !== 'string'", ''),
    '缺 typeof')

  const missed = cases.filter(([, ok]) => !ok)

  console.log('行为模型（timer 清理 + body 序列化）')
  for (const [name, ok] of models) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log('')
  console.log('反例自检')
  for (const [name, ok, detail] of cases) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} —— ${detail}`)
  console.log('')

  let failed = 0
  const realReasons = invariants(real)
  if (realReasons.length) {
    console.error(`FAIL  Bug 8 契约未通过（${realReasons.length} 项）：`)
    for (const r of realReasons) console.error(`        - ${r}`)
    failed += 1
  }
  if (failedModels.length) {
    console.error(`FAIL  行为模型未通过（${failedModels.length} 项）`)
    failed += 1
  }
  if (missed.length) {
    console.error(`FAIL  有反例未被拦下（${missed.length} 项，断言无区分力）`)
    failed += 1
  }
  if (!failed) {
    console.log(`PASS  Bug 8 契约通过（结构不变量 6 项 + 行为模型 ${models.length} 例 + 反例 ${cases.length} 例）`)
    process.exit(0)
  }
  process.exit(1)
}

void main()
