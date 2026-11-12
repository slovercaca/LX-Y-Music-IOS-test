/**
 * sim-media-cache-contract.js
 *
 * 「本地与下载歌词/封面指示 + 歌词封面缓存策略」契约（2026-11-12）。
 *
 * 背景（用户反馈）：
 *   ① 本地与下载里的「有歌词/有封面」有时明明本地缓存到了、却显示没有。
 *      根因：旧 scanLibrary 只读 lrc/、picture/ 顶层 + music/、根目录、
 *      旧「本地」夹顶层的散落文件，漏掉了播放查找三级口径覆盖的位置
 *      （音频目录的 lrc/、picture/ 子目录、父目录兄弟目录、用户自建子目录）。
 *   ② 歌词没有缓存：在线歌词只在内存里，封面有 picture/ 缓存、歌词没有
 *      对等的 lrc/ 缓存。
 *   ③ 缺少缓存策略设置：用户要总开关（关 = 不缓存、显示一次后自动删除）+
 *      分开关（缓存歌词至本地 / 缓存封面至本地），放在基础设置里。
 *
 * 本脚本钉住的修复不变量：
 *   - 指示：本地列表的 hasLyric/hasCover 只由递归扫描 lrc/、picture/（含各
 *     级子目录）的结果判定；每次点「刷新」重新扫一次；在线封面地址不算有封面。
 *   - 歌词缓存：在线歌词（在线链路 + localPlay 跨平台匹配）落盘 lrc/，与
 *     封面缓存对称；已存在不覆盖；受总开关 + 歌词开关约束。
 *   - 封面缓存：全部写盘入口统一走 isPicCacheEnabled（总开关 + 封面开关）；
 *     旧键 player.autoCacheOnlinePic 已由 mediaCachePic 取代，启动时迁移旧值。
 *   - 清理孤立文件与指示同一口径：递归扫出的歌词/封面里，找不到递归音频
 *     基名对应的才是孤立（子目录歌曲的歌词/封面不能被误判孤立删掉）。
 *   - 下载产物（按下载设置写入的 .lrc、内嵌封面中间文件）不受缓存开关控制。
 *
 * 运行：node scripts/sim-media-cache-contract.js
 * 退出码：不变量全过、且反例被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

const FILES = {
  localLibrary: 'src/utils/localLibrary.ts',
  localPage: 'src/screens/Home/Views/LocalDownload/index.tsx',
  musicIndex: 'src/core/music/index.ts',
  musicOnline: 'src/core/music/online.ts',
  localPlay: 'src/core/music/localPlay.ts',
  downloadCore: 'src/core/download.ts',
  defaultSetting: 'src/config/defaultSetting.ts',
  settingInit: 'src/config/setting.ts',
  appSettingTypes: 'src/types/app_setting.d.ts',
  basicIndex: 'src/screens/Home/Views/Setting/settings/Basic/index.tsx',
  mediaCacheSettings: 'src/screens/Home/Views/Setting/settings/Basic/MediaCacheSettings.tsx',
  playerIndex: 'src/screens/Home/Views/Setting/settings/Player/index.tsx',
  langZh: 'src/lang/zh-cn.json',
}

const read = (rel) => {
  const full = path.join(ROOT, rel)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') : ''
}
const REAL = Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, read(rel)]))
const OLD_PIC_SETTING_FILE = 'src/screens/Home/Views/Setting/settings/Player/IsAutoCacheOnlinePic.tsx'

const structuralReasons = (files, oldPicSettingExists) => {
  const reasons = []

  // ① 指示：递归扫描判定
  if (!files.localPage.includes('scanLibraryMediaFiles')) {
    reasons.push('本地列表没有用递归扫描判定歌词/封面有无')
  }
  if (!files.localPage.includes('const { lrcBases, picBases } = await scanLibraryMediaFiles()')) {
    reasons.push('本地列表没有从递归扫描结果取 lrcBases/picBases')
  }
  if (/for \(const f of await readDir\(lrcDir\)/.test(files.localPage)) {
    reasons.push('本地列表又在只读 lrc/ 顶层（子目录缓存会漏判）')
  }
  if (/for \(const f of await readDir\(pictureDir\)/.test(files.localPage)) {
    reasons.push('本地列表又在只读 picture/ 顶层（子目录缓存会漏判）')
  }
  if (files.localPage.includes('hasCover: picBases.has(base) ||')) {
    reasons.push('封面指示又把在线地址算作有封面（与扫描口径不一致）')
  }
  if (!files.localPage.includes('void scanLibrary()') || !files.localPage.includes('onPress={handleRefresh}')) {
    reasons.push('刷新按钮没有触发重新扫描')
  }
  // 递归扫描本身：进子目录 + 深度上限 + 防环
  if (!files.localLibrary.includes('entry.isDirectory && depth < maxDepth')) {
    reasons.push('递归扫描没有进子目录或没有深度上限')
  }
  if (!files.localLibrary.includes('visited.has(dir)')) {
    reasons.push('递归扫描没有 visited 防环')
  }
  if (!files.localLibrary.includes('audioBases')) {
    reasons.push('递归扫描没有收集音频基名（孤立判定会误伤子目录歌曲）')
  }

  // ② 歌词缓存
  if (!files.localLibrary.includes('export const cacheLyricToLibrary')) {
    reasons.push('缺少 cacheLyricToLibrary（歌词缓存入口）')
  }
  if (!files.localLibrary.includes('isLyricCacheEnabled()')) {
    reasons.push('歌词缓存没有受歌词开关约束')
  }
  if (!files.localLibrary.includes('lyricInflight')) {
    reasons.push('歌词缓存没有并发去重（播放与预取会同时写同一文件）')
  }
  if (!files.musicOnline.includes('cacheLyricToLibrary(')) {
    reasons.push('在线歌词链路没有落盘缓存')
  }
  if (!files.musicOnline.includes('mergeLyrics(')) {
    reasons.push('在线歌词缓存没有合并翻译/罗马音（与下载写 lrc 口径不一致）')
  }
  if (!files.localPlay.includes('cacheLyricToLibrary(')) {
    reasons.push('localPlay 跨平台匹配的歌词没有落盘缓存')
  }
  // 歌词缓存写的是原始文本（buildLyricInfo 转换前）：调用点直接传 mergeLyrics
  // 合并的原始 lyric/tlyric/rlyric，而不是 buildLyricInfo 的返回值（繁体转换后
  // 的文本落盘后读回会再转一次，且关掉繁体开关后文件仍是繁体）
  if (!files.musicOnline.includes('cacheLyricToLibrary(coverBaseForSong(musicInfo.name, musicInfo.singer), mergeLyrics(')) {
    reasons.push('在线歌词缓存没有用 buildLyricInfo 转换前的原始文本')
  }

  // ③ 封面缓存统一走策略
  if (!files.localLibrary.includes('isPicCacheEnabled()')) {
    reasons.push('缺少封面缓存策略判断')
  }
  if (!files.localLibrary.includes('if (!isPicCacheEnabled()) return null')) {
    reasons.push('cacheCoverToLibrary 内部没有策略总门（调用方会绕过开关）')
  }
  if (!files.musicIndex.includes('isPicCacheEnabled()')) {
    reasons.push('在线封面自动缓存没有受封面开关约束')
  }
  if (files.musicIndex.includes("player.autoCacheOnlinePic")) {
    reasons.push('在线封面还在读旧键 player.autoCacheOnlinePic')
  }
  if (!files.downloadCore.includes('if (!isPicCacheEnabled()) return')) {
    reasons.push('下载完成补封面缓存没有在开关关闭时提前返回')
  }

  // ④ 策略开关定义：!== false（缺键默认开，保持现行行为）
  for (const key of ['player.mediaCacheEnabled', 'player.mediaCacheLyric', 'player.mediaCachePic']) {
    if (!files.defaultSetting.includes(`'${key}': true`)) {
      reasons.push(`默认设置缺少 ${key}（默认开）`)
    }
    if (!files.appSettingTypes.includes(`'${key}': boolean`)) {
      reasons.push(`设置类型缺少 ${key}`)
    }
  }
  // 用整行精确匹配：松散的正则会在 isLyricCacheEnabled/isPicCacheEnabled
  // 的定义行上误命中（它们也含 isMediaCacheEnabled() 与 !== false），
  // 导致总开关被改回 === true 时检查漏报
  if (!files.localLibrary.includes("export const isMediaCacheEnabled = (): boolean => settingState.setting['player.mediaCacheEnabled'] !== false")) {
    reasons.push('总开关判断没有用 !== false（老设置缺键时会静默关掉缓存）')
  }
  if (!files.localLibrary.includes("export const isLyricCacheEnabled = (): boolean => isMediaCacheEnabled() && settingState.setting['player.mediaCacheLyric'] !== false")) {
    reasons.push('歌词开关没有同时受总开关约束')
  }
  if (!files.localLibrary.includes("export const isPicCacheEnabled = (): boolean => isMediaCacheEnabled() && settingState.setting['player.mediaCachePic'] !== false")) {
    reasons.push('封面开关没有同时受总开关约束')
  }
  if (files.defaultSetting.includes("'player.autoCacheOnlinePic':")) {
    reasons.push('默认设置还留着旧键 player.autoCacheOnlinePic（应由 mediaCachePic 取代）')
  }
  if (files.appSettingTypes.includes("'player.autoCacheOnlinePic'")) {
    reasons.push('设置类型还留着旧键 player.autoCacheOnlinePic')
  }

  // ⑤ 旧键迁移：启动时把旧值带到 mediaCachePic，迁完删旧键
  if (!files.settingInit.includes("setting['player.mediaCachePic'] = (setting as Record<string, any>)['player.autoCacheOnlinePic']")) {
    reasons.push('启动迁移没有把旧键值带到 player.mediaCachePic')
  }
  if (!files.settingInit.includes("delete (setting as Record<string, any>)['player.autoCacheOnlinePic']")) {
    reasons.push('启动迁移没有删除旧键（设置文件会长期留着死键）')
  }

  // ⑥ 基础设置 UI：三开关都在，分开关随总开关置灰
  if (!files.basicIndex.includes('<MediaCacheSettings />')) {
    reasons.push('基础设置没有注册缓存策略组件')
  }
  for (const key of ['player.mediaCacheEnabled', 'player.mediaCacheLyric', 'player.mediaCachePic']) {
    if (!files.mediaCacheSettings.includes(`'${key}'`)) {
      reasons.push(`缓存策略组件缺少 ${key} 开关`)
    }
  }
  if ((files.mediaCacheSettings.match(/disabled=\{!mediaCacheEnabled\}/g) || []).length !== 2) {
    reasons.push('两个分开关没有在总开关关闭时置灰')
  }
  for (const key of [
    'setting_basic_media_cache_enabled',
    'setting_basic_media_cache_enabled_tip',
    'setting_basic_media_cache_lyric',
    'setting_basic_media_cache_lyric_tip',
    'setting_basic_media_cache_pic',
    'setting_basic_media_cache_pic_tip',
  ]) {
    if (!files.langZh.includes(`"${key}"`)) reasons.push(`中文文案缺少 ${key}`)
  }
  if (files.langZh.includes('setting_player_auto_cache_online_pic')) {
    reasons.push('中文文案还留着旧封面缓存开关的文案')
  }

  // ⑦ 旧开关组件下线
  if (files.playerIndex.includes('IsAutoCacheOnlinePic')) {
    reasons.push('播放设置还在注册旧的自动缓存封面开关（与新策略重复）')
  }
  if (oldPicSettingExists) {
    reasons.push('旧的自动缓存封面开关组件文件还在（应删除）')
  }

  // ⑧ 清理孤立文件与指示同一口径
  if (!files.localPage.includes('const { lrcFiles, picFiles, audioBases } = await scanLibraryMediaFiles()')) {
    reasons.push('清理孤立文件没有用递归扫描结果（子目录孤立文件清不到/会误判）')
  }
  if (/for \(const dir of \[getLrcDir\(\), getPictureDir\(\)\]\)/.test(files.localPage)) {
    reasons.push('清理孤立文件又在只读 lrc/、picture/ 顶层')
  }

  // ⑨ 下载产物不受缓存开关控制（download.writeLyric 仍是唯一门）
  if (!files.downloadCore.includes("if (!settingState.setting['download.writeLyric']) return")) {
    reasons.push('下载歌词文件失去了 download.writeLyric 门（或被缓存开关误接管）')
  }

  return reasons
}

const realReasons = structuralReasons(REAL, fs.existsSync(path.join(ROOT, OLD_PIC_SETTING_FILE)))

// ---------------------------------------------------------------------------
// 行为模型
// ---------------------------------------------------------------------------
const models = []
const check = (name, pass) => models.push([name, pass])

// 策略真值表（含缺键默认开）
{
  const isMaster = (s) => s['player.mediaCacheEnabled'] !== false
  const isLyric = (s) => isMaster(s) && s['player.mediaCacheLyric'] !== false
  const isPic = (s) => isMaster(s) && s['player.mediaCachePic'] !== false
  check('三开关全开：歌词/封面都缓存', isLyric({ 'player.mediaCacheEnabled': true, 'player.mediaCacheLyric': true }) && isPic({ 'player.mediaCacheEnabled': true, 'player.mediaCachePic': true }))
  check('总开关关：歌词/封面都不缓存', !isLyric({ 'player.mediaCacheEnabled': false, 'player.mediaCacheLyric': true }) && !isPic({ 'player.mediaCacheEnabled': false, 'player.mediaCachePic': true }))
  check('只关歌词：封面仍缓存', !isLyric({ 'player.mediaCacheEnabled': true, 'player.mediaCacheLyric': false }) && isPic({ 'player.mediaCacheEnabled': true, 'player.mediaCachePic': true }))
  check('只关封面：歌词仍缓存', isLyric({ 'player.mediaCacheEnabled': true, 'player.mediaCacheLyric': true }) && !isPic({ 'player.mediaCacheEnabled': true, 'player.mediaCachePic': false }))
  check('老设置缺键：默认开（不静默关缓存）', isLyric({}) && isPic({}))
}

// 递归扫描匹配模型：子目录里的缓存文件也要能点亮指示
{
  const baseNameOf = (n) => n.replace(/\.[^/.]+$/, '')
  // 模拟库结构：顶层 lrc/、music/lrc/ 子目录、用户自建子目录
  const files = [
    'lrc/晴天 - 周杰伦.lrc',
    'music/lrc/夜曲 - 周杰伦.lrc',
    'music/歌手A/lrc/稻香 - 周杰伦.lrc',
    'picture/晴天 - 周杰伦.jpg',
    'music/picture/夜曲 - 周杰伦.png',
    'music/歌手A/picture/稻香 - 周杰伦.webp',
    'music/晴天 - 周杰伦.flac',
    'music/夜曲 - 周杰伦.flac',
    'music/歌手A/稻香 - 周杰伦.flac',
  ]
  const lrcBases = new Set()
  const picBases = new Set()
  for (const f of files) {
    const name = f.split('/').pop()
    if (name.endsWith('.lrc')) lrcBases.add(baseNameOf(name).toLowerCase())
    else if (/\.(jpg|png|webp)$/.test(name)) picBases.add(baseNameOf(name).toLowerCase())
  }
  check('顶层 lrc/ 命中', lrcBases.has('晴天 - 周杰伦'.toLowerCase()))
  check('music/lrc/ 子目录命中（旧顶层扫描会漏）', lrcBases.has('夜曲 - 周杰伦'.toLowerCase()))
  check('深层子目录 lrc 命中', lrcBases.has('稻香 - 周杰伦'.toLowerCase()))
  check('music/picture/ 子目录封面命中', picBases.has('夜曲 - 周杰伦'.toLowerCase()))
  check('深层子目录封面命中', picBases.has('稻香 - 周杰伦'.toLowerCase()))
  check('大小写不一致仍命中', lrcBases.has('晴天 - 周杰伦'.toUpperCase().toLowerCase()))
  check('无对应文件的歌不亮指示', !lrcBases.has('七里香 - 周杰伦'.toLowerCase()) && !picBases.has('七里香 - 周杰伦'.toLowerCase()))
}

// 孤立判定模型：子目录歌曲的歌词/封面不是孤立
{
  const audioBases = new Set(['晴天 - 周杰伦', '稻香 - 周杰伦'].map(s => s.toLowerCase()))
  const mediaFiles = [
    'lrc/晴天 - 周杰伦.lrc',
    'music/歌手A/lrc/稻香 - 周杰伦.lrc',
    'lrc/已删的歌.lrc',
    'picture/已删的歌.jpg',
  ]
  const orphans = mediaFiles.filter(p => !audioBases.has(p.split('/').pop().replace(/\.[^/.]+$/, '').toLowerCase()))
  check('子目录歌曲的歌词不被当孤立', !orphans.includes('music/歌手A/lrc/稻香 - 周杰伦.lrc'))
  check('真正孤立的文件被找出', orphans.length === 2 && orphans.includes('lrc/已删的歌.lrc') && orphans.includes('picture/已删的歌.jpg'))
}

// 歌词缓存跳过已存在模型
{
  const disk = new Set(['lrc/晴天 - 周杰伦.lrc'])
  const shouldWrite = (base) => !disk.has(`lrc/${base}.lrc`)
  check('已有同名 lrc 不覆盖', !shouldWrite('晴天 - 周杰伦'))
  check('没有同名 lrc 才写', shouldWrite('夜曲 - 周杰伦'))
}

// 旧键迁移模型
{
  const migrate = (setting) => {
    const s = { ...setting }
    if (s['player.mediaCachePic'] === undefined && typeof s['player.autoCacheOnlinePic'] === 'boolean') {
      s['player.mediaCachePic'] = s['player.autoCacheOnlinePic']
    }
    delete s['player.autoCacheOnlinePic']
    return s
  }
  check('旧键 false 迁移到新键 false', migrate({ 'player.autoCacheOnlinePic': false })['player.mediaCachePic'] === false)
  check('旧键 true 迁移到新键 true', migrate({ 'player.autoCacheOnlinePic': true })['player.mediaCachePic'] === true)
  check('新键已有值时不被旧值覆盖', migrate({ 'player.mediaCachePic': false, 'player.autoCacheOnlinePic': true })['player.mediaCachePic'] === false)
  check('迁移后旧键被删除', !('player.autoCacheOnlinePic' in migrate({ 'player.autoCacheOnlinePic': false })))
}

const failedModels = models.filter(([, pass]) => !pass)

// ---------------------------------------------------------------------------
// 反例自检：篡改后的源码必须被结构检查拦下
// ---------------------------------------------------------------------------
const cases = []
{
  const tampered = { ...REAL, localPage: REAL.localPage.replace('scanLibraryMediaFiles()', 'Promise.resolve({ lrcBases: new Set(), picBases: new Set() })') }
  cases.push(['本地列表不用递归扫描', structuralReasons(tampered, false).length > 0])
}
{
  const tampered = { ...REAL, localPage: REAL.localPage.replace('hasCover: picBases.has(base),', 'hasCover: picBases.has(base) || !!task.musicInfo.meta.picUrl,') }
  cases.push(['封面指示又算在线地址', structuralReasons(tampered, false).length > 0])
}
{
  const tampered = { ...REAL, localLibrary: REAL.localLibrary.replace('if (!isPicCacheEnabled()) return null', 'if (false) return null') }
  cases.push(['封面缓存总门被绕过', structuralReasons(tampered, false).length > 0])
}
{
  const tampered = { ...REAL, localLibrary: REAL.localLibrary.replace("settingState.setting['player.mediaCacheEnabled'] !== false", "settingState.setting['player.mediaCacheEnabled'] === true") }
  cases.push(['总开关改回 === true（缺键静默关缓存）', structuralReasons(tampered, false).length > 0])
}
{
  const tampered = { ...REAL, mediaCacheSettings: REAL.mediaCacheSettings.replaceAll('disabled={!mediaCacheEnabled}', 'disabled={false}') }
  cases.push(['分开关不再随总开关置灰', structuralReasons(tampered, false).length > 0])
}
{
  const tampered = { ...REAL, musicOnline: REAL.musicOnline.replaceAll('cacheLyricToLibrary(', 'void ((') }
  cases.push(['在线歌词不再落盘缓存', structuralReasons(tampered, false).length > 0])
}
{
  cases.push(['旧开关组件文件复活', structuralReasons(REAL, true).length > 0])
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
