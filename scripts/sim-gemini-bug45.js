/**
 * sim-gemini-bug45.js
 *
 * Bug 45（真实）：网易云专辑搜索 handleAlbumResult 未对 item.artist 判空——
 * 合辑/无歌手专辑 artist 为 null 时 .map 内抛 TypeError，整页专辑搜索失败。
 * 顺带 guard item 本身为 null 的情况。
 *
 * 钉住的修复不变量：artistName/artistId 用 item.artist?.xxx ?? ''；null 条目先滤掉。
 *
 * 运行：node scripts/sim-gemini-bug45.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { musicSearch: read('src/utils/musicSdk/wy/musicSearch.js') }

const structuralReasons = (files) => {
  const reasons = []
  const code = files.musicSearch
  if (!code.includes("artistName: item.artist?.name ?? ''")) {
    reasons.push('handleAlbumResult 的 artistName 未判空（artist 为 null 时整页崩溃）')
  }
  if (!code.includes("artistId: item.artist?.id ?? ''")) {
    reasons.push('handleAlbumResult 的 artistId 未判空')
  }
  if (!code.includes('rawList.filter(item => item != null).map(')) {
    reasons.push('handleAlbumResult 未滤掉 null 条目（item 本身为 null 时 item.id 抛错）')
  }
  if (/artistName: item\.artist\.name/.test(code) || /artistId: item\.artist\.id/.test(code)) {
    reasons.push('handleAlbumResult 还有裸读 item.artist.xxx')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型：专辑结果转换（与修复后代码同逻辑）
const models = []
const handleAlbumResult = (rawList) => {
  if (!rawList) return []
  return rawList.filter(item => item != null).map(item => ({
    id: item.id,
    name: item.name,
    artistName: item.artist?.name ?? '',
    artistId: item.artist?.id ?? '',
  }))
}
{
  const list = handleAlbumResult([
    { id: 1, name: '合辑', artist: null },
    null,
    { id: 2, name: '单曲', artist: { name: '歌手', id: 9 } },
  ])
  models.push(['模型：artist 为 null 的专辑不崩溃、名字为空串', list.length === 2 && list[0].artistName === '' && list[0].artistId === ''])
  models.push(['模型：null 条目被滤掉', list.length === 2 && list[1].id === 2])
  models.push(['模型：正常专辑原样提取', list[1].artistName === '歌手' && list[1].artistId === 9])
  models.push(['模型：rawList 为空时返回 []', handleAlbumResult(null).length === 0 && handleAlbumResult(undefined).length === 0])
  // 反面：旧逻辑遇 null artist 抛 TypeError
  let oldThrew = false
  try { [{ artist: null }].map(item => ({ artistName: item.artist.name })) } catch (e) { oldThrew = e instanceof TypeError }
  models.push(['反面教材：旧逻辑遇 null artist 抛 TypeError', oldThrew === true])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, musicSearch: REAL.musicSearch.replace("artistName: item.artist?.name ?? ''", 'artistName: item.artist.name') }
  cases.push(['artistName 的 ?. 判空被删', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, musicSearch: REAL.musicSearch.replace('rawList.filter(item => item != null).map(', 'rawList.map(') }
  cases.push(['null 条目过滤被删', structuralReasons(tampered).length > 0])
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
