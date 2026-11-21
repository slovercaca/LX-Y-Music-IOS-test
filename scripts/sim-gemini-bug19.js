/**
 * sim-gemini-bug19.js
 *
 * Bug 19（部分真实）：download.ts 写封面直调 online getPicUrl，绕过了 local
 * 内嵌/sidecar/缓存封面与 qs 跨平台匹配——纯本地文件即使音频内嵌有封面，
 * 下载写封面也确定性失败。
 *
 * 钉住的修复不变量：
 *   - 三处调用点统一走 @/core/music 的 getPicPath，不再直调 online getPicUrl。
 *   - http URL 下载到 picture/<fileName>.<ext>（落盘即缓存，校验状态码/字节数）。
 *   - 本地路径剥离 file:// 前缀后直接传 writePic，不再下载。
 *   - 无封面时抛错（handleMetadata toast + 记 fail，retryMetadata 只记 fail）。
 *   - cacheDownloadedCover 拿到本地路径时复制到 picture/ 作同名缓存。
 *
 * 运行：node scripts/sim-gemini-bug19.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { download: read('src/core/download.ts') }

const structuralReasons = (files) => {
  const reasons = []
  const code = files.download
  if (!code.includes("import { getMusicUrl, getMusicUrlWithQuality, getLyricInfo, getPicPath } from '@/core/music'")) {
    reasons.push('download.ts 未从 @/core/music 导入 getPicPath')
  }
  if (code.includes("from '@/core/music/online'")) {
    reasons.push('download.ts 还在导入 @/core/music/online 的 getPicUrl（应统一走 getPicPath）')
  }
  if (!code.includes('const resolveCoverPicPath = async(task: DownloadTask): Promise<string>')) {
    reasons.push('download.ts 缺少 resolveCoverPicPath（封面解析统一入口）')
  }
  if (!code.includes("throw new Error('未能获取到封面')")) {
    reasons.push('resolveCoverPicPath 无封面时未抛错（调用方无法按各自语义记 fail）')
  }
  if (!code.includes('downloadFile(pic, picPath)')) {
    reasons.push('resolveCoverPicPath 的 http 分支未下载到 picture/')
  }
  const stripCount = (code.match(/replace\(\/\^file:/g) || []).length
  if (stripCount < 2) {
    reasons.push(`file:// 前缀剥离只有 ${stripCount} 处，应至少 2 处（resolveCoverPicPath + cacheDownloadedCover）`)
  }
  const resolveCalls = (code.match(/await resolveCoverPicPath\(task\)/g) || []).length
  if (resolveCalls < 2) {
    reasons.push(`resolveCoverPicPath 调用点只有 ${resolveCalls} 处，应为 2 处（handleMetadata + retryMetadata）`)
  }
  if (!code.includes('cacheCoverToLibrary(task.fileName, pic)')) {
    reasons.push('cacheDownloadedCover 的 http 分支未走 cacheCoverToLibrary')
  }
  if (!code.includes('copyFile(localPath, target)')) {
    reasons.push('cacheDownloadedCover 拿到本地封面时未复制到 picture/ 作同名缓存')
  }
  if (!code.includes('if (localPath !== target)')) {
    reasons.push('cacheDownloadedCover 复制本地封面前未判同路径（自复制）')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型：封面解析路由（与 resolveCoverPicPath 同逻辑）
const models = []
const route = (pic) => {
  if (!pic) return 'throw'
  if (pic.startsWith('http')) return 'download'
  return 'local:' + pic.replace(/^file:\/\//, '')
}
models.push(['路由：http URL 走下载', route('http://x/y.jpg') === 'download' && route('https://x/y.jpg') === 'download'])
models.push(['路由：file:// 本地路径剥离前缀后直传 writePic', route('file:///a/b.jpg') === 'local:/a/b.jpg'])
models.push(['路由：裸本地路径同样直传 writePic', route('/a/b.jpg') === 'local:/a/b.jpg'])
models.push(['路由：空串抛错（调用方记 fail）', route('') === 'throw'])
// cacheDownloadedCover 的本地复制：已在目标位置不复制，否则复制
{
  const needCopy = (localPath, target) => localPath !== target
  models.push(['缓存：本地封面已在 picture/ 同名位置时不复制', needCopy('/p/a.jpg', '/p/a.jpg') === false])
  models.push(['缓存：内嵌提取路径与目标不同时复制', needCopy('/cache/a.jpg', '/p/a.jpg') === true])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, download: REAL.download.replace('getPicPath', 'getPicUrlX') }
  cases.push(['getPicPath 导入被改回 getPicUrl', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, download: REAL.download.replace("throw new Error('未能获取到封面')", "return ''") }
  cases.push(['无封面不再抛错（调用方拿空串调 writePic）', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, download: REAL.download.replace('copyFile(localPath, target)', '/* no copy */') }
  cases.push(['本地封面不再复制到 picture/ 缓存', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, download: REAL.download.replace('await resolveCoverPicPath(task)', 'await resolveCoverPicPathX(task)') }
  cases.push(['handleMetadata/retryMetadata 不再走统一入口', structuralReasons(tampered).length > 0])
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
