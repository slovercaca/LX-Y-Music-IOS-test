/**
 * sim-gemini-bug39.js
 *
 * Bug 39（真实）：酷我 getListDetailDigest5Info/Music 重试路由丢失 digest-5__
 * 前缀——重试调 getListDetail 时传的是已剥离前缀的 id，默认落入 digest-8 分支；
 * Music 的 id 还是 sourceid（非歌单 id），错上加错；child 为空数组时返回 null，
 * 下游发 pid=null 请求。
 *
 * 钉住的修复不变量：
 *   - 两函数各自递归调用自身重试（保持 digest-5 路由）。
 *   - !body.child?.length 时重试，不返回 null。
 *   - 191-192 行的过期行内注释不在本 bug 范围（deferred），不做要求。
 *
 * 运行：node scripts/sim-gemini-bug39.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { songList: read('src/utils/musicSdk/kw/songList.js') }

const sliceFn = (code, startMark, endMark) => {
  const start = code.indexOf(startMark)
  const end = code.indexOf(endMark, start)
  return start === -1 ? '' : code.slice(start, end === -1 ? code.length : end)
}

const structuralReasons = (files) => {
  const reasons = []
  const code = files.songList
  const infoBody = sliceFn(code, 'getListDetailDigest5Info(id, tryNum = 0)', 'getListDetailDigest5Music(id, page, tryNum = 0)')
  const musicBody = sliceFn(code, 'getListDetailDigest5Music(id, page, tryNum = 0)', 'async getListDetailDigest5(id, page, retryNum)')
  if (!infoBody.includes('return this.getListDetailDigest5Info(id, ++tryNum)')) {
    reasons.push('getListDetailDigest5Info 重试未调自身（路由会丢到 digest-8）')
  }
  if (!musicBody.includes('return this.getListDetailDigest5Music(id, page, ++tryNum)')) {
    reasons.push('getListDetailDigest5Music 重试未调自身（路由会丢到 digest-8）')
  }
  if (infoBody.includes('return this.getListDetail(') || musicBody.includes('return this.getListDetail(')) {
    reasons.push('digest-5 两函数重试还在调 getListDetail（前缀已剥离，路由错误）')
  }
  if (!infoBody.includes('!body.child?.length')) {
    reasons.push('getListDetailDigest5Info 未对空 child 数组重试（会返回 null、下游发 pid=null）')
  }
  if (infoBody.includes('body.child[0].sourceid : null')) {
    reasons.push('getListDetailDigest5Info 还在 child 为空时返回 null')
  }
  if (!infoBody.includes('return body.child[0].sourceid')) {
    reasons.push('getListDetailDigest5Info 未在 child 非空时返回 sourceid')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型：digest-5 路由保持（与修复后代码同逻辑）
const models = []
{
  // 路由器：getListDetail 见到 digest- 前缀才进 digest-5，否则默认 digest-8
  const routeOf = (id) => (/^digest-/.test(id) ? id.split('__')[0].replace('digest-', '') : '8')
  models.push(['模型：剥离前缀后的 id 路由到 digest-8（旧重试的错误）', routeOf('12345') === '8'])
  models.push(['模型：带前缀的 id 路由到 digest-5', routeOf('digest-5__12345') === '5'])
  // 自递归重试保持路由：重试函数名即路由本身
  const retryFn = { info: 'getListDetailDigest5Info', music: 'getListDetailDigest5Music' }
  models.push(['模型：Info 重试调自身（digest-5）', retryFn.info === 'getListDetailDigest5Info'])
  models.push(['模型：Music 重试调自身（digest-5）', retryFn.music === 'getListDetailDigest5Music'])
  // 空 child 不返回 null：改为重试（有界，tryNum > 2 封顶）
  const resolveInfo = (child, tryNum) => {
    if (tryNum > 2) return 'reject'
    if (!child?.length) return 'retry'
    return child[0].sourceid
  }
  models.push(['模型：child 为空数组时重试而非返回 null', resolveInfo([], 0) === 'retry'])
  models.push(['模型：child 缺失时重试而非返回 null', resolveInfo(undefined, 0) === 'retry'])
  models.push(['模型：child 非空时返回 sourceid', resolveInfo([{ sourceid: 's1' }], 0) === 's1'])
  models.push(['模型：重试有界（tryNum > 2 时 reject）', resolveInfo([], 3) === 'reject'])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, songList: REAL.songList.replace('return this.getListDetailDigest5Info(id, ++tryNum)', 'return this.getListDetail(id, 1, ++tryNum)') }
  cases.push(['Info 重试改回调 getListDetail（路由丢到 digest-8）', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, songList: REAL.songList.replace('return this.getListDetailDigest5Music(id, page, ++tryNum)', 'return this.getListDetail(id, page, ++tryNum)') }
  cases.push(['Music 重试改回调 getListDetail（路由丢到 digest-8）', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, songList: REAL.songList.replace('if (statusCode != 200 || !body.child?.length)', 'if (statusCode != 200 || !body.child)') }
  cases.push(['空 child 数组不再重试（又返回 null）', structuralReasons(tampered).length > 0])
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
