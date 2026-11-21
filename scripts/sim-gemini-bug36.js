/**
 * sim-gemini-bug36.js
 *
 * Bug 36（真实）：酷狗 filterMusicInfoList 的 meta 内三处直接读
 * item.album_info.xxx——外层已用 ?.（此前修过一半），meta 内漏网；任一无专辑
 * 信息曲目会在 forEach 内抛 TypeError，整批转换中断。
 *
 * 钉住的修复不变量：meta 内三处与外层同口径用 ?.，全文件无裸读 album_info 字段。
 *
 * 运行：node scripts/sim-gemini-bug36.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { musicInfo: read('src/utils/musicSdk/kg/musicInfo.js') }

const structuralReasons = (files) => {
  const reasons = []
  const code = files.musicInfo
  const guarded = (code.match(/item\.album_info\?\./g) || []).length
  if (guarded < 6) {
    reasons.push(`item.album_info?. 只有 ${guarded} 处，应至少 6 处（外层 3 + meta 内 3）`)
  }
  if (/item\.album_info\.(album_name|album_id)/.test(code)) {
    reasons.push('仍有裸读 item.album_info.album_name/album_id（无专辑信息曲目会使整批转换崩溃）')
  }
  // sizable_cover 的裸读只允许出现在同行已有 ?. 条件守卫的三元真分支里
  //（img/picUrl 两处：条件 item.album_info?.sizable_cover 为 falsy 时不进分支）
  for (const line of code.split('\n')) {
    if (line.includes('item.album_info.sizable_cover') && !line.includes('item.album_info?.sizable_cover ?')) {
      reasons.push(`裸读 item.album_info.sizable_cover 缺少同行 ?. 守卫：${line.trim()}`)
    }
  }
  if (!code.includes('albumName: decodeName(item.album_info?.album_name)')) {
    reasons.push('meta.albumName 未加 ?.')
  }
  if (!code.includes('albumId: item.album_info?.album_id')) {
    reasons.push('meta.albumId 未加 ?.')
  }
  if (!code.includes('picUrl: item.album_info?.sizable_cover ?')) {
    reasons.push('meta.picUrl 未加 ?.')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型：meta 提取（与修复后代码同逻辑）
const models = []
const metaOf = (item) => ({
  albumName: item.album_info?.album_name,
  albumId: item.album_info?.album_id,
  picUrl: item.album_info?.sizable_cover ? item.album_info.sizable_cover.replace('{size}', '400') : null,
})
{
  let threw = false
  let meta = null
  try { meta = metaOf({}) } catch { threw = true }
  models.push(['模型：album_info 缺失时不抛错', threw === false])
  models.push(['模型：album_info 缺失时 meta 字段为空', meta && meta.albumName === undefined && meta.albumId === undefined && meta.picUrl === null])
  const meta2 = metaOf({ album_info: { album_name: 'A', album_id: 7, sizable_cover: 'x{size}y' } })
  models.push(['模型：album_info 存在时正常提取', meta2.albumName === 'A' && meta2.albumId === 7 && meta2.picUrl === 'x400y'])
  // 整批转换：混入无专辑曲目也不中断
  const batch = [{ album_info: { album_name: 'A' } }, {}, { album_info: { album_name: 'B' } }]
  const converted = batch.map(metaOf)
  models.push(['模型：整批转换遇无专辑曲目不中断', converted.length === 3 && converted[1].albumName === undefined && converted[2].albumName === 'B'])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, musicInfo: REAL.musicInfo.replace('item.album_info?.album_name', 'item.album_info.album_name') }
  cases.push(['某处 ?. 被改回裸读', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, musicInfo: REAL.musicInfo.replace('picUrl: item.album_info?.sizable_cover ?', 'picUrl: item.album_info.sizable_cover ?') }
  cases.push(['meta.picUrl 的 ?. 被删', structuralReasons(tampered).length > 0])
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
