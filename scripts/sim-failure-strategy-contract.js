/**
 * sim-failure-strategy-contract.js
 *
 * 「失败策略」契约（2026-11-12）。
 *
 * 背景（用户需求）：
 *   下载/播放失败时自动按用户排序重试，功能名「失败策略」，三步：
 *   ① 切换平台重试（用户定平台优先级）；② 换音质重试（用户定往下降/往上升）；
 *   ③ 更换音源重试（切一次后自动切回原指定音源——第 3 步引擎待用户拍板，
 *   本批只留注册表插槽 + 跳过日志，不实现）。另整合项目里已有的分散重试实现。
 *
 * 本脚本钉住的修复不变量：
 *   - 策略引擎在取链层（handleGetOnlineMusicUrl）：首选档试一次 → 按用户顺序
 *     跑启用的步；429 全程直通不进策略循环；allowToggleSource=false 时跳过
 *     换平台步；总开关关时只试首选一次。
 *   - 两处降质闭包抽成共享原语 tryMusicUrlWithFallback；只往下的
 *     getTryQualityList / getNextTryQuality 已删除（controller 改用方向感知）。
 *   - 换源候选按用户平台优先级重排（不改调用方数组）；音质回退表按方向走。
 *   - player.ts 在线歌曲不再原样重试一次（策略已覆盖）；setMusicUrl 终态与
 *     controller 对齐查 autoSkipOnError。
 *   - localPlay 候选排序改读用户平台优先级；URL_SOURCES 直连兜底不动。
 *   - 三个非原始值设置键在 DEEP_KEYS 里（否则 updateSetting 静默丢弃）。
 *   - resolveMusicUrl / getMusicUrlWithQuality 回传实际解析到的歌曲（供下载
 *     写回 actualSource）。
 *
 * 运行：node scripts/sim-failure-strategy-contract.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

const FILES = {
  strategy: 'src/core/music/failureStrategy.ts',
  utils: 'src/core/music/utils.ts',
  online: 'src/core/music/online.ts',
  musicIndex: 'src/core/music/index.ts',
  localPlay: 'src/core/music/localPlay.ts',
  player: 'src/core/player/player.ts',
  controller: 'src/plugins/player/controller.ts',
  defaultSetting: 'src/config/defaultSetting.ts',
  settingInit: 'src/config/setting.ts',
  appSettingTypes: 'src/types/app_setting.d.ts',
  settingMain: 'src/screens/Home/Views/Setting/Main.tsx',
  strategyIndex: 'src/screens/Home/Views/Setting/settings/FailureStrategy/index.tsx',
  strategyOrder: 'src/screens/Home/Views/Setting/settings/FailureStrategy/StrategyOrder.tsx',
  platformPriority: 'src/screens/Home/Views/Setting/settings/FailureStrategy/PlatformPriority.tsx',
  qualityDirection: 'src/screens/Home/Views/Setting/settings/FailureStrategy/QualityDirection.tsx',
  langZh: 'src/lang/zh-cn.json',
}

const read = (rel) => {
  const full = path.join(ROOT, rel)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') : ''
}
const REAL = Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, read(rel)]))

const structuralReasons = (files) => {
  const reasons = []

  // ① 策略模块：纯函数 + 配置读取，不 import utils（防循环依赖）
  for (const name of ['getFailureStrategyConfig', 'getEnabledStepsInOrder', 'buildQualityLadder', 'sortCandidatesByPriority', 'getNextStrategyQuality', 'FAILURE_STEPS', 'PLATFORM_PRIORITY_SOURCES']) {
    if (!files.strategy.includes(`export const ${name}`) && !files.strategy.includes(`export type ${name}`) && !files.strategy.includes(`export interface ${name}`)) {
      reasons.push(`failureStrategy.ts 缺少导出 ${name}`)
    }
  }
  if (files.strategy.includes("from './utils'") || files.strategy.includes('from "@/core/music/utils"')) {
    reasons.push('failureStrategy.ts 反向 import utils.ts（循环依赖）')
  }
  if (!files.strategy.includes('!== false')) {
    reasons.push('策略配置读取没有用 !== false 缺键默认开')
  }

  // ② 设置键 + 类型 + DEEP_KEYS
  for (const key of ["'failureStrategy.enabled': true", "'failureStrategy.order': ['platform', 'quality', 'source']", "'failureStrategy.stepEnabled': { platform: true, quality: true, source: true }", "'failureStrategy.platformPriority': ['kw', 'kg', 'tx', 'wy', 'mg']", "'failureStrategy.qualityDirection': 'down'", 'setting_failure_strategy: true']) {
    if (!files.defaultSetting.includes(key)) reasons.push(`defaultSetting 缺少 ${key}`)
  }
  for (const key of ["'failureStrategy.enabled': boolean", "'failureStrategy.order': Array<'platform' | 'quality' | 'source'>", "'failureStrategy.stepEnabled': Record<'platform' | 'quality' | 'source', boolean>", "'failureStrategy.platformPriority': LX.OnlineSource[]", "'failureStrategy.qualityDirection': 'down' | 'up'"]) {
    if (!files.appSettingTypes.includes(key)) reasons.push(`app_setting.d.ts 缺少类型 ${key}`)
  }
  for (const key of ["'failureStrategy.order'", "'failureStrategy.stepEnabled'", "'failureStrategy.platformPriority'"]) {
    if (!files.settingInit.includes(key)) reasons.push(`DEEP_KEYS 缺少 ${key}（updateSetting 会静默丢弃该键）`)
  }

  // ③ 共享取链原语 + 旧闭包已删
  if (!files.utils.includes('const tryMusicUrlWithFallback = async(')) {
    reasons.push('utils.ts 缺少共享的 tryMusicUrlWithFallback 原语')
  }
  if (/const tryGetMusicUrlWithFallback = async/.test(files.utils)) {
    reasons.push('utils.ts 还有旧的 tryGetMusicUrlWithFallback 闭包（未整合）')
  }
  if (/export const getTryQualityList|export const getNextTryQuality/.test(files.utils)) {
    reasons.push('utils.ts 还有只往下的 getTryQualityList / getNextTryQuality（应已删除）')
  }
  if (!files.utils.includes('buildSourceFallbackQualities')) {
    reasons.push('utils.ts 缺少 buildSourceFallbackQualities（方向感知回退表）')
  }

  // ④ 策略编排：首选一次 → 按序跑步；429 直通；防递归门
  if (!files.utils.includes('getEnabledStepsInOrder(strategyConfig)')) {
    reasons.push('handleGetOnlineMusicUrl 没有按用户顺序取启用的策略步')
  }
  if (!files.utils.includes("tryMusicUrlWithFallback(musicInfo, [targetQuality], '[在线播放]')")) {
    reasons.push('handleGetOnlineMusicUrl 首选档没有先单独试一次')
  }
  if (!files.utils.includes("if (step === 'quality')") || !files.utils.includes("if (step === 'platform')") || !files.utils.includes("if (step === 'source')")) {
    reasons.push('handleGetOnlineMusicUrl 没有三步分支（quality/platform/source）')
  }
  if (!files.utils.includes('if (!allowToggleSource) continue')) {
    reasons.push('platform 步没有 allowToggleSource 防递归门')
  }
  const tooManyCount = (files.utils.match(/requestMsg\.tooManyRequests/g) || []).length
  if (tooManyCount < 3) {
    reasons.push(`429 直通检查不足（utils.ts 里只有 ${tooManyCount} 处 tooManyRequests，应至少 3 处：原语 + 首选 + 步骤循环）`)
  }

  // ⑤ 换源候选按优先级重排 + 不改调用方数组
  if (!files.utils.includes('sortCandidatesByPriority(musicInfos, strategyConfig.platformPriority)')) {
    reasons.push('getOnlineOtherSourceMusicUrl 没有按用户平台优先级重排候选')
  }
  if (!files.utils.includes('candidateQueue.shift()')) {
    reasons.push('换源循环没有从排序后的拷贝取候选（可能改了调用方数组）')
  }
  if (!files.utils.includes('musicInfos: candidateQueue')) {
    reasons.push('换源递归没有传剩余队列（会重排已消费的候选）')
  }

  // ⑥ player.ts 整合
  if (!files.player.includes('isOnlineSong')) {
    reasons.push('player.ts 没有区分在线/非在线歌曲的重试范围（在线歌曲会整条重跑策略）')
  }
  if (!files.player.includes("if (!isRetryed && !isOnlineSong) return getMusicPlayUrl(musicInfo, isRefresh, true, quality)")) {
    reasons.push('player.ts 原样重试一次没有限定为非在线路径')
  }
  if (!files.player.includes("settingState.setting['player.autoSkipOnError']")) {
    reasons.push('player.ts setMusicUrl 终态没有查 autoSkipOnError（与 controller 不一致）')
  }

  // ⑦ controller 方向感知
  if (!files.controller.includes('getNextStrategyQuality(')) {
    reasons.push('controller 降质步没有改用方向感知的 getNextStrategyQuality')
  }
  if (files.controller.includes('getNextTryQuality(')) {
    reasons.push('controller 还在用只往下的 getNextTryQuality')
  }

  // ⑧ localPlay 候选排序改读用户优先级；直连兜底不动
  if (!files.localPlay.includes('getFailureStrategyConfig().platformPriority')) {
    reasons.push('localPlay 候选排序没有改读用户平台优先级')
  }
  if (files.localPlay.includes('SOURCE_PRIORITY')) {
    reasons.push('localPlay 还有写死的 SOURCE_PRIORITY（应已删除）')
  }
  if (!files.localPlay.includes("const URL_SOURCES = ['wy', 'bilibili']")) {
    reasons.push('localPlay 的 URL_SOURCES 直连兜底被动过（与用户优先级无关，应不动）')
  }

  // ⑨ 实际解析歌曲回传（供下载写回 actualSource）
  if (!files.online.includes('musicInfo: LX.Music.MusicInfoOnline')) {
    reasons.push('resolveMusicUrl 返回类型没有 musicInfo')
  }
  const musicInfoReturns = (files.online.match(/musicInfo: (currentMusicInfo|result\.musicInfo|targetMusicInfo)/g) || []).length
  if (musicInfoReturns < 4) {
    reasons.push(`resolveMusicUrl 回传 musicInfo 的返回点只有 ${musicInfoReturns} 处，应为 4 处（缓存/preferApi/cookie/回退）`)
  }
  if (!files.musicIndex.includes('musicInfo: LX.Music.MusicInfoOnline')) {
    reasons.push('getMusicUrlWithQuality 返回类型没有 musicInfo')
  }

  // ⑩ 设置页注册 + 文案
  if (!files.settingMain.includes("'failure_strategy'") || !files.settingMain.includes('FailureStrategy')) {
    reasons.push('设置页 Main 没有注册 failure_strategy 分组')
  }
  if (!files.strategyIndex.includes('FailureStrategyEnabled') || !files.strategyIndex.includes('StrategyOrder') || !files.strategyIndex.includes('PlatformPriority') || !files.strategyIndex.includes('QualityDirection')) {
    reasons.push('失败策略设置页缺少四个子组件之一')
  }
  if (!files.strategyOrder.includes("t(`setting_failure_strategy_step_${id}`)")) {
    reasons.push('策略顺序行没有按步骤 id 取文案')
  }
  if (!files.platformPriority.includes("t(`source_${id}`)")) {
    reasons.push('平台优先级行没有按平台 id 取文案')
  }
  for (const key of ['setting_failure_strategy', 'setting_failure_strategy_enabled', 'setting_failure_strategy_order', 'setting_failure_strategy_step_platform', 'setting_failure_strategy_step_quality', 'setting_failure_strategy_step_source', 'setting_failure_strategy_platform_priority', 'setting_failure_strategy_quality_direction', 'setting_failure_strategy_quality_down', 'setting_failure_strategy_quality_up']) {
    if (!files.langZh.includes(`"${key}"`)) reasons.push(`zh-cn.json 缺少文案键 ${key}`)
  }

  return reasons
}

const realReasons = structuralReasons(REAL)

// ---------------------------------------------------------------------------
// 行为模型（与 failureStrategy.ts 的纯函数同逻辑，JS 重实现）
const QUALITY_RANK = ['master', 'atmos_plus', 'atmos', 'hires', 'flac24bit', 'flac', '320k', '192k', '128k']
const FAILURE_STEPS = ['platform', 'quality', 'source']
const PLATFORM_PRIORITY_SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg']

const sanitizeIdList = (value, all) => {
  const list = Array.isArray(value) ? value.filter(v => all.includes(v)) : []
  const seen = new Set()
  const out = []
  for (const v of list) { if (!seen.has(v)) { seen.add(v); out.push(v) } }
  for (const v of all) { if (!seen.has(v)) out.push(v) }
  return out
}
const buildQualityLadder = (from, direction, available, rank) => {
  const start = rank.indexOf(from)
  if (start === -1) return []
  const set = new Set(available)
  const out = []
  if (direction === 'down') { for (let i = start + 1; i < rank.length; i++) if (set.has(rank[i])) out.push(rank[i]) }
  else { for (let i = start - 1; i >= 0; i--) if (set.has(rank[i])) out.push(rank[i]) }
  return out
}
const sortCandidatesByPriority = (list, priority) => {
  const rank = new Map(priority.map((s, i) => [s, i]))
  const fallback = priority.length
  return [...list].sort((a, b) => (rank.get(a.source) ?? fallback) - (rank.get(b.source) ?? fallback))
}
const getEnabledStepsInOrder = (config) => {
  if (!config.enabled) return []
  return config.order.filter(s => config.stepEnabled[s])
}
const buildSourceFallbackQualities = (startQuality, direction, available) => {
  const sortedAvailable = available.filter(q => QUALITY_RANK.includes(q)).sort((a, b) => QUALITY_RANK.indexOf(a) - QUALITY_RANK.indexOf(b))
  if (sortedAvailable.includes(startQuality)) {
    return [startQuality, ...buildQualityLadder(startQuality, direction, available, QUALITY_RANK)]
  }
  const ordered = direction === 'down' ? sortedAvailable : [...sortedAvailable].reverse()
  return ordered.length ? ordered : [startQuality]
}

const models = []
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// 配置清洗
models.push(['order 清洗：去重 + 补齐缺项', eq(sanitizeIdList(['quality', 'platform', 'platform', 'bogus'], FAILURE_STEPS), ['quality', 'platform', 'source'])])
models.push(['order 清洗：非法输入（非数组）回退默认', eq(sanitizeIdList('nope', FAILURE_STEPS), ['platform', 'quality', 'source'])])
models.push(['平台优先级清洗：缺项补齐', eq(sanitizeIdList(['mg', 'wy'], PLATFORM_PRIORITY_SOURCES), ['mg', 'wy', 'kw', 'kg', 'tx'])])
// 音质阶梯
models.push(['阶梯往下降：320k → 192k/128k', eq(buildQualityLadder('320k', 'down', ['flac', '320k', '192k', '128k'], QUALITY_RANK), ['192k', '128k'])])
models.push(['阶梯往上升：320k → flac', eq(buildQualityLadder('320k', 'up', ['flac', '320k', '128k'], QUALITY_RANK), ['flac'])])
models.push(['阶梯往上升：已是最高档 → 空', eq(buildQualityLadder('master', 'up', ['master', 'flac'], QUALITY_RANK), [])])
models.push(['阶梯：起始档不在 rank 里 → 空', eq(buildQualityLadder('bogus', 'down', ['flac'], QUALITY_RANK), [])])
models.push(['阶梯不含起始档本身', !buildQualityLadder('320k', 'down', ['320k', '128k'], QUALITY_RANK).includes('320k')])
// 回退表（含 getPlayQuality 兜底 128k 但歌无 128k 的场景）
models.push(['回退表：起始档可用时以它开头', eq(buildSourceFallbackQualities('320k', 'down', ['flac', '320k', '128k']), ['320k', '128k'])])
models.push(['回退表：起始档不可用、往下走全部可用档（高→低）', eq(buildSourceFallbackQualities('128k', 'down', ['flac', 'hires']), ['hires', 'flac'])])
models.push(['回退表：起始档不可用、往上走全部可用档（低→高）', eq(buildSourceFallbackQualities('128k', 'up', ['flac', 'hires']), ['flac', 'hires'])])
models.push(['回退表：无任何可用档 → 只试起始档', eq(buildSourceFallbackQualities('320k', 'down', []), ['320k'])])
// 候选排序
models.push(['候选排序：按优先级重排', eq(sortCandidatesByPriority([{ source: 'mg' }, { source: 'kw' }, { source: 'tx' }], ['kw', 'kg', 'tx', 'wy', 'mg']).map(c => c.source), ['kw', 'tx', 'mg'])])
models.push(['候选排序：未知源排最后且保原序', eq(sortCandidatesByPriority([{ source: 'zzz' }, { source: 'kw' }, { source: 'yyy' }], ['kw', 'kg', 'tx', 'wy', 'mg']).map(c => c.source), ['kw', 'zzz', 'yyy'])])
models.push(['候选排序：不改入参数组', (() => { const arr = [{ source: 'mg' }, { source: 'kw' }]; sortCandidatesByPriority(arr, ['kw', 'kg', 'tx', 'wy', 'mg']); return arr[0].source === 'mg' })()])
// 步骤编排
models.push(['编排：总开关关 → 无步骤', eq(getEnabledStepsInOrder({ enabled: false, order: ['platform', 'quality', 'source'], stepEnabled: { platform: true, quality: true, source: true } }), [])])
models.push(['编排：按用户顺序 + 跳过关闭的步', eq(getEnabledStepsInOrder({ enabled: true, order: ['quality', 'platform', 'source'], stepEnabled: { platform: false, quality: true, source: true } }), ['quality', 'source'])])
const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检：把关键实现改坏，结构检查必须拦下
const cases = []
{
  const tampered = { ...REAL, settingInit: REAL.settingInit.replace("'failureStrategy.order', ", '') }
  cases.push(['DEEP_KEYS 丢了 failureStrategy.order', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, utils: REAL.utils.replace('sortCandidatesByPriority(musicInfos, strategyConfig.platformPriority)', 'musicInfos') }
  cases.push(['换源候选不再按优先级排序', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, utils: REAL.utils.replace('if (!allowToggleSource) continue', 'if (false) continue') }
  cases.push(['platform 步丢了防递归门', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, player: REAL.player.replace('if (!isRetryed && !isOnlineSong) return getMusicPlayUrl(musicInfo, isRefresh, true, quality)', 'if (!isRetryed) return getMusicPlayUrl(musicInfo, isRefresh, true, quality)') }
  cases.push(['player 在线歌曲又原样重试一次', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, controller: REAL.controller.replace('getNextStrategyQuality(', 'getNextTryQuality(') }
  cases.push(['controller 又用只往下的降质', structuralReasons(tampered).length > 0])
}
{
  const tampered = { ...REAL, localPlay: REAL.localPlay.replace('getFailureStrategyConfig().platformPriority', 'META_SOURCES') }
  cases.push(['localPlay 又用写死平台顺序', structuralReasons(tampered).length > 0])
}
{
  // replaceAll：文件里有 4 处 !== false（总开关 + 3 个分开关），只换一处拦不住
  const tampered = { ...REAL, strategy: REAL.strategy.replaceAll('!== false', '=== true') }
  cases.push(['策略开关改回 === true（缺键静默关）', structuralReasons(tampered).length > 0])
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
