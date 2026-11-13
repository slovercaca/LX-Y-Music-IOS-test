#!/usr/bin/env node
/**
 * 实际平台/音质展示契约（2026-11-13）：
 *   播放时失败策略换了平台或音质，详情页的徽章行要显示「原平台 原音质 →
 *   实际平台 实际音质」；没换时保持原样。
 *
 * 链路：resolveMusicUrl 回传的 musicInfo.source（换源成功时即目标平台的歌）
 *   → getMusicUrlInfo 返回 source → getMusicPlayUrl/PlayUrlInfo 透传
 *   → setMusicUrl 交给 setResource → playerState.actualSource + quality
 *   → playStreamInfoChanged 广播 → SourceQualityBadge 对比原值后展示。
 *
 * 本脚本钉住的不变量：
 *   - getMusicUrlInfo 的在线路径返回 resolved.source（resolveMusicUrl 回传
 *     的实际平台），非在线路径返回歌曲自身平台（不换源）。
 *   - PlayUrlInfo 含 source；setMusicUrl 把 result.source 传给 setResource。
 *   - setResource 写 actualSource 并广播 playStreamInfoChanged。
 *   - 切歌时 setPlayMusicInfo 把 quality/actualSource 清零并广播（防新歌
 *     取链完成前显示上一首的实际值）。
 *   - 徽章只在实际值与原值不同时展示实际徽章（箭头 + 差异项）。
 *   - M-1：URL 缓存值带实际平台（JSON {"u", "s"}），缓存命中路径返回缓存
 *     里记的平台而非请求歌的平台；存点一律传实际平台。
 *   - S-1：徽章的请求档位按引擎首试口径（buildSourceFallbackQualities 首项），
 *     不直接用 getPlayQuality 的 128k 兜底值。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const INDEX = path.join(ROOT, 'src/core/music/index.ts')
const ONLINE = path.join(ROOT, 'src/core/music/online.ts')
const MUSIC_UTILS = path.join(ROOT, 'src/core/music/utils.ts')
const DATA = path.join(ROOT, 'src/utils/data.ts')
const PLAYER = path.join(ROOT, 'src/core/player/player.ts')
const PLUGIN_UTILS = path.join(ROOT, 'src/plugins/player/utils.ts')
const P_STATE = path.join(ROOT, 'src/store/player/state.ts')
const P_ACTION = path.join(ROOT, 'src/store/player/action.ts')
const P_HOOK = path.join(ROOT, 'src/store/player/hook.ts')
const STATE_EVENT = path.join(ROOT, 'src/event/stateEvent.ts')
const BADGE = path.join(ROOT, 'src/screens/PlayDetail/components/SourceQualityBadge.tsx')

let failures = 0
const check = (ok, msg) => {
  console.log(ok ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!ok) failures++
}

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    check(false, `读取失败：${p}`)
    return ''
  }
}

console.log('实际平台/音质展示契约：')

const indexSrc = read(INDEX)
const onlineSrc = read(ONLINE)
const musicUtilsSrc = read(MUSIC_UTILS)
const dataSrc = read(DATA)
const playerSrc = read(PLAYER)
const pluginSrc = read(PLUGIN_UTILS)
const pStateSrc = read(P_STATE)
const pActionSrc = read(P_ACTION)
const pHookSrc = read(P_HOOK)
const stateEventSrc = read(STATE_EVENT)
const badgeSrc = read(BADGE)

// --- 取链层：实际平台回传 ---
check(
  /Promise<\{ url: string, quality: LX\.Quality \| null, source: LX\.Source \| null \}>/.test(indexSrc),
  'getMusicUrlInfo 返回类型含 source',
)
check(
  /source: resolved\.source/.test(indexSrc),
  '在线路径的 source 取 resolveMusicUrl 回传的 source（非 musicInfo.source）',
)
check(
  /return \{ url, quality: quality \?\? null, source: originalSource \}/.test(indexSrc),
  '非在线路径回传歌曲自身平台',
)

// --- M-1：URL 缓存带实际平台 ---
check(
  /export const getCachedMusicUrlWithSource/.test(dataSrc) &&
  /JSON\.stringify\(\{ u: url, s: source \}\)/.test(dataSrc),
  'URL 缓存值含实际平台（JSON {"u", "s"}）+ 新读函数已导出',
)
check(
  /parseCachedMusicUrl/.test(dataSrc) && /return \{ url: raw, source: null \}/.test(dataSrc),
  '旧纯字符串缓存值解析为 source: null（向后兼容）',
)
check(
  /export const getMusicUrl = async[\s\S]{0,300}parseCachedMusicUrl\(raw\)\.url/.test(dataSrc),
  'getMusicUrl 仍只返回 URL 字符串（旧调用方不受影响）',
)
check(
  /source: LX\.Source \}>/.test(onlineSrc) &&
  /getStoreMusicUrlWithSource\(currentMusicInfo, targetQuality\)/.test(onlineSrc),
  'resolveMusicUrl 返回类型含 source，缓存检查用带 source 的读函数',
)
check(
  /source: cached\.source \?\? currentMusicInfo\.source/.test(onlineSrc),
  'resolveMusicUrl 缓存命中返回缓存记的平台（旧值回退请求歌平台）',
)
check(
  /const actualSource = result\.source \?\? result\.musicInfo\.source/.test(onlineSrc) &&
  /saveMusicUrl\(currentMusicInfo, result\.quality, result\.url, actualSource\)/.test(onlineSrc),
  '自定义 API 路径：存点传实际平台（result.source 优先）',
)
check(
  /const actualSource = resolvedSource \?\? targetMusicInfo\.source/.test(onlineSrc) &&
  /saveMusicUrl\(currentMusicInfo, resolvedQuality, url, actualSource\)/.test(onlineSrc),
  '兜底路径：存点传实际平台',
)
check(
  (musicUtilsSrc.match(/getStoreMusicUrlWithSource\(musicInfo, /g) || []).length >= 2,
  'handleGetOnlineMusicUrl 与换源候选的缓存检查都用带 source 的读函数',
)
check(
  /return \{ url: cached\.url, musicInfo, quality: targetQuality, isFromCache: true, source: cached\.source \?\? musicInfo\.source \}/.test(musicUtilsSrc),
  '在线取链缓存命中回传缓存记的平台',
)
check(
  /return \{ url: cached\.url, musicInfo, quality: itemQuality, isFromCache: true, source: cached\.source \?\? musicInfo\.source \}/.test(musicUtilsSrc),
  '换源候选缓存命中回传缓存记的平台（二阶换源）',
)

// --- 播放器：透传到 setResource ---
check(
  /interface PlayUrlInfo \{[\s\S]{0,200}source: LX\.Source \| null/.test(playerSrc),
  'PlayUrlInfo 含 source',
)
check(
  /setResource\(musicInfo, result\.url, currentTime, result\.quality, result\.source\)/.test(playerSrc),
  'setMusicUrl 把 result.source 传给 setResource',
)

// --- 装载点：写 state 并广播 ---
check(
  /playerState\.actualSource = source \?\? null/.test(pluginSrc),
  'setResource 写 playerState.actualSource',
)
check(
  /global\.state_event\.playStreamInfoChanged\(\{ quality: playerState\.quality, actualSource: playerState\.actualSource \}\)/.test(pluginSrc),
  'setResource 广播 playStreamInfoChanged',
)

// --- state / 事件 / hook ---
check(
  /actualSource: LX\.Source \| null/.test(pStateSrc) && /actualSource: null,/.test(pStateSrc),
  'player state 有 actualSource 字段（初始 null）',
)
check(
  /playStreamInfoChanged\(streamInfo: \{ quality: PlayerState\['quality'\], actualSource: PlayerState\['actualSource'\] \}\)/.test(stateEventSrc),
  'stateEvent 有 playStreamInfoChanged 方法',
)
check(
  /setPlayMusicInfo\([\s\S]{0,600}state\.quality = null[\s\S]{0,100}state\.actualSource = null/.test(pActionSrc),
  '切歌时 setPlayMusicInfo 清零 quality 与 actualSource',
)
check(
  /setPlayMusicInfo\([\s\S]{0,600}playStreamInfoChanged\(\{ quality: null, actualSource: null \}\)/.test(pActionSrc),
  '切歌时广播清零后的流信息',
)
check(
  /export const usePlayStreamInfo/.test(pHookSrc) &&
  /global\.state_event\.on\('playStreamInfoChanged'/.test(pHookSrc),
  'usePlayStreamInfo 订阅 playStreamInfoChanged',
)

// --- 详情页徽章 ---
check(
  /usePlayStreamInfo\(\)/.test(badgeSrc),
  '徽章读取 usePlayStreamInfo',
)
check(
  /streamInfo\.actualSource !== musicInfo\.source/.test(badgeSrc),
  '徽章对比实际平台与原平台',
)
check(
  /streamInfo\.quality !== requestedQuality/.test(badgeSrc),
  '徽章对比实际音质与请求音质',
)
check(
  /showActual/.test(badgeSrc) && />→</.test(badgeSrc),
  '仅变化时显示箭头与实际徽章',
)
check(
  /buildSourceFallbackQualities\(target, getFailureStrategyConfig\(\)\.qualityDirection, available\)\[0\]/.test(badgeSrc),
  'S-1：徽章请求档位按引擎首试口径（非 getPlayQuality 128k 兜底）',
)

// 反例自检：setResource 丢掉 source 参数后检查能发现
{
  const stripped = playerSrc.replace(
    'setResource(musicInfo, result.url, currentTime, result.quality, result.source)',
    'setResource(musicInfo, result.url, currentTime, result.quality)',
  )
  check(
    !/setResource\(musicInfo, result\.url, currentTime, result\.quality, result\.source\)/.test(stripped),
    '反例自检：setResource 丢掉 source 参数时检查能发现',
  )
}

// 反例自检：缓存命中改回原平台后检查能发现（M-1 回归）
{
  const stripped = onlineSrc.replace(
    'source: cached.source ?? currentMusicInfo.source',
    'source: currentMusicInfo.source',
  )
  check(
    !/source: cached\.source \?\? currentMusicInfo\.source/.test(stripped),
    '反例自检：缓存命中改回原平台时检查能发现',
  )
}

if (failures > 0) {
  console.log(`失败：${failures} 项`)
  process.exit(1)
}
console.log('全部通过')
