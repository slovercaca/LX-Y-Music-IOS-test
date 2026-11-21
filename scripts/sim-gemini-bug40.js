/**
 * sim-gemini-bug40.js
 *
 * Bug 40（真实）：咪咕 mg/pic.js 两处——① getPicUrl 被标 async，重试分支拿到的
 * tryRequestObj 是 Promise，.cancelHttp 为 undefined，调 .bind 必崩；② getPic
 * 直接返回 requestObj 对象而非 URL 字符串，调用方当作 URL 用（真值对象），
 * 不触发换源兜底。
 *
 * 钉住的修复不变量：
 *   - getPicUrl 去掉 async（体内无 await，同步返回 requestObj）。
 *   - getPic 返回 this.getPicUrl(songId).promise（契约 Promise<string>）。
 *
 * 运行：node scripts/sim-gemini-bug40.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { pic: read('src/utils/musicSdk/mg/pic.js') }

const structuralReasons = (files) => {
  const reasons = []
  const code = files.pic
  if (code.includes('async getPicUrl')) {
    reasons.push('getPicUrl 还是 async（重试分支拿到的 tryRequestObj 是 Promise，.cancelHttp 必崩）')
  }
  if (!code.includes('getPicUrl(songId, tryNum = 0) {')) {
    reasons.push('getPicUrl 签名缺失（应为同步函数）')
  }
  if (!code.includes('return this.getPicUrl(songId).promise')) {
    reasons.push('getPic 未返回解包后的 .promise（契约是 Promise<string>）')
  }
  if (!code.includes('requestObj.cancelHttp = tryRequestObj.cancelHttp.bind(tryRequestObj)')) {
    reasons.push('重试分支的 cancelHttp 绑定缺失')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型：同步 getPicUrl + 解包后的 getPic（与修复后代码同逻辑）
const models = []
{
  // 模拟修复后的模块：getPicUrl 同步返回 requestObj，重试时 .cancelHttp 可 bind
  const fakeModule = {
    getPicUrl(songId, tryNum = 0) {
      const requestObj = {
        cancelHttp: () => {},
        promise: Promise.resolve({ body: tryNum === 0 ? { returnCode: '999999' } : { returnCode: '000000', largePic: 'http://x/pic.jpg' } }),
      }
      requestObj.promise = requestObj.promise.then(({ body }) => {
        if (body.returnCode !== '000000') {
          if (tryNum > 5) return Promise.reject(new Error('图片获取失败'))
          const tryRequestObj = this.getPicUrl(songId, ++tryNum)
          requestObj.cancelHttp = tryRequestObj.cancelHttp.bind(tryRequestObj)
          return tryRequestObj.promise
        }
        return body.largePic
      })
      return requestObj
    },
    async getPic() {
      return this.getPicUrl('1').promise
    },
  }
  const reqObj = fakeModule.getPicUrl('1')
  models.push(['模型：getPicUrl 同步返回 requestObj（有 .promise 与 .cancelHttp）', typeof reqObj.promise?.then === 'function' && typeof reqObj.cancelHttp === 'function'])
  models.push(['模型：getPicUrl 返回的不是 Promise（否则重试必崩）', typeof reqObj.then !== 'function'])
  globalThis.__bug40AsyncCheck = fakeModule.getPic().then(
    (url) => typeof url === 'string' && url === 'http://x/pic.jpg',
    () => false,
  )
  // 反面：async 版 getPicUrl 返回 Promise，.cancelHttp 为 undefined
  const asyncModule = {
    async getPicUrl() {
      return { cancelHttp: () => {}, promise: Promise.resolve('x') }
    },
  }
  const asyncRet = asyncModule.getPicUrl()
  models.push(['反面教材：async 版返回 Promise，.cancelHttp 为 undefined', asyncRet.cancelHttp === undefined && typeof asyncRet.then === 'function'])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, pic: REAL.pic.replace('getPicUrl(songId, tryNum = 0) {', 'async getPicUrl(songId, tryNum = 0) {') }
  cases.push(['getPicUrl 又被标 async', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, pic: REAL.pic.replace('return this.getPicUrl(songId).promise', 'return this.getPicUrl(songId)') }
  cases.push(['getPic 又直接返回 requestObj', structuralReasons(tampered).length > 0])
}
const failedCases = cases.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
const finish = async() => {
  const asyncPass = await globalThis.__bug40AsyncCheck
  console.log('== 结构不变量 ==')
  if (realReasons.length === 0) console.log('  PASS 全部结构不变量成立')
  else for (const r of realReasons) console.log(`  FAIL ${r}`)

  console.log('== 行为模型 ==')
  for (const [name, pass] of models) console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`)
  console.log(`  ${asyncPass ? 'PASS' : 'FAIL'} 模型：首次失败重试后 getPic 解析为 URL 字符串`)

  console.log('== 反例自检（必须全部拦下） ==')
  for (const [name, pass] of cases) console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`)

  const failed = realReasons.length + failedModels.length + failedCases.length + (asyncPass ? 0 : 1)
  console.log(failed === 0 ? '\n全部通过' : `\n共 ${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}
void finish()
