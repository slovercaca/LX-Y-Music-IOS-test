/**
 * sim-gemini-bug41.js
 *
 * Bug 41（真实，潜伏代码）：咪咕 leaderboard.js getDetailPageUrl 引用已删除的
 * item.webId——现行 boardList 各项只有 id/name/bangid/source，webId 只存在于
 * 被注释掉的旧榜单中；命中榜单时拼接出 .../top/undefined 坏链。
 *
 * 钉住的修复不变量：item.webId 缺失时返回 null（与无命中同口径）；不拿数字
 * bangid 代拼（webId 是英文 slug，如 jianjiao_newsong，拼出来也是错链）。
 *
 * 运行：node scripts/sim-gemini-bug41.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const REAL = { leaderboard: read('src/utils/musicSdk/mg/leaderboard.js') }

const structuralReasons = (files) => {
  const reasons = []
  const code = files.leaderboard
  if (!code.includes('if (!item.webId) return null')) {
    reasons.push('getDetailPageUrl 缺少 webId 守卫（会拼出 .../top/undefined 坏链）')
  }
  if (!code.includes('return `https://music.migu.cn/v3/music/top/${item.webId}`')) {
    reasons.push('getDetailPageUrl 的 webId 拼链缺失')
  }
  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型：榜单详情页 URL（与修复后代码同逻辑）
const models = []
const getDetailPageUrl = (boardList, id) => {
  if (typeof id === 'string') id = id.replace('mg__', '')
  for (const item of boardList) {
    if (item.bangid == id) {
      if (!item.webId) return null
      return `https://music.migu.cn/v3/music/top/${item.webId}`
    }
  }
  return null
}
{
  const currentBoards = [{ id: 'mg__27553319', name: '新歌榜', bangid: '27553319', source: 'mg' }]
  models.push(['模型：现行榜单无 webId 时返回 null（不是坏链）', getDetailPageUrl(currentBoards, 'mg__27553319') === null])
  const legacyBoards = [{ id: 'mg__27553319', name: '尖叫新歌榜', bangid: '27553319', webId: 'jianjiao_newsong' }]
  models.push(['模型：有 webId 的旧榜单仍拼出正确链接', getDetailPageUrl(legacyBoards, 'mg__27553319') === 'https://music.migu.cn/v3/music/top/jianjiao_newsong'])
  models.push(['模型：无命中榜单返回 null', getDetailPageUrl(currentBoards, 'mg__00000000') === null])
  // 反面：旧逻辑对现行榜单拼出 undefined 坏链
  const getDetailPageUrlOld = (boardList, id) => {
    if (typeof id === 'string') id = id.replace('mg__', '')
    for (const item of boardList) {
      if (item.bangid == id) return `https://music.migu.cn/v3/music/top/${item.webId}`
    }
    return null
  }
  models.push(['反面教材：旧逻辑拼出 .../top/undefined 坏链', getDetailPageUrlOld(currentBoards, 'mg__27553319') === 'https://music.migu.cn/v3/music/top/undefined'])
}
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检
const cases = []
{
  const tampered = { ...REAL, leaderboard: REAL.leaderboard.replace('if (!item.webId) return null', '/* guard removed */') }
  cases.push(['webId 守卫被删', structuralReasons(tampered).length > 0])
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
