/**
 * 失败策略（2026-11-12）：下载/播放取链失败时，按用户排序自动重试。
 *
 * 三步（用户可在「设置 → 失败策略」里排序、单独开关）：
 *   platform — 切换平台重试：按 failureStrategy.platformPriority 的顺序，
 *              逐个试其它平台的同名歌曲（候选来自 getOtherSource 跨平台搜索）。
 *   quality  — 换音质重试：按 failureStrategy.qualityDirection，从首选档位
 *              一档一档往下降 / 往上升，只试该歌曲 _qualitys 里有的档位。
 *   source   — 更换音源重试：临时借用另一自定义音源脚本（user_api_xxx）
 *              试一次，事后自动切回原指定音源；只有导入了 ≥2 个脚本时生效。
 *
 * 约束（与旧有重试行为对齐，见 utils.ts 的换源/降质实现）：
 *   - 429 限流直通、不进策略循环（否则一次限流会被放大成 N 倍请求）。
 *   - 策略全部跑完仍失败，才按原有终态处理（播放跳歌 / 下载标错）。
 *   - 总开关关 = 只试首选一次，不跑任何策略步。
 *
 * 本模块只含纯函数 + 配置读取，不 import ./utils（utils.ts 要 import 本模块
 * 驱动策略引擎，反向 import 会形成循环依赖）。需要音质阶梯的地方由调用方
 * 把 QUALITY_RANK 传进来。
 */
import settingState from '@/store/setting/state'

export const FAILURE_STEPS = ['platform', 'quality', 'source'] as const
export type FailureStepId = (typeof FAILURE_STEPS)[number]

/** 可参与平台切换的 5 个平台：bilibili 被 searchMusic 排除、qs 无搜索，天然不参与 */
export const PLATFORM_PRIORITY_SOURCES: readonly LX.OnlineSource[] = ['kw', 'kg', 'tx', 'wy', 'mg']

export const DEFAULT_FAILURE_ORDER: readonly FailureStepId[] = ['platform', 'quality', 'source']

export interface FailureStrategyConfig {
  enabled: boolean
  /** 清洗后的完整顺序：已知步骤去重 + 缺失步骤按默认追加 */
  order: FailureStepId[]
  stepEnabled: Record<FailureStepId, boolean>
  /** 清洗后的完整平台优先级：已知平台去重 + 缺失平台按默认追加 */
  platformPriority: LX.OnlineSource[]
  qualityDirection: 'down' | 'up'
}

const sanitizeIdList = <T extends string>(value: unknown, all: readonly T[]): T[] => {
  const list = Array.isArray(value) ? value.filter((v): v is T => (all as readonly string[]).includes(v as string)) : []
  const seen = new Set<T>()
  const out: T[] = []
  for (const v of list) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  for (const v of all) {
    if (!seen.has(v)) out.push(v)
  }
  return out
}

export const getFailureStrategyConfig = (): FailureStrategyConfig => {
  const setting = settingState.setting
  const rawStepEnabled = setting['failureStrategy.stepEnabled'] as unknown as Record<string, unknown> | null | undefined
  return {
    enabled: setting['failureStrategy.enabled'] !== false,
    order: sanitizeIdList(setting['failureStrategy.order'], FAILURE_STEPS),
    stepEnabled: {
      platform: rawStepEnabled?.platform !== false,
      quality: rawStepEnabled?.quality !== false,
      source: rawStepEnabled?.source !== false,
    },
    platformPriority: sanitizeIdList(setting['failureStrategy.platformPriority'], PLATFORM_PRIORITY_SOURCES),
    qualityDirection: setting['failureStrategy.qualityDirection'] === 'up' ? 'up' : 'down',
  }
}

/** 按用户顺序返回启用的策略步（总开关关时返回空数组） */
export const getEnabledStepsInOrder = (config: FailureStrategyConfig): FailureStepId[] => {
  if (!config.enabled) return []
  return config.order.filter(step => config.stepEnabled[step])
}

/**
 * 音质阶梯：从 fromQuality 出发沿 rank 按 direction 走一档一档，只含
 * available 里的档位，不含 fromQuality 本身（首选档已试过）。
 * fromQuality 不在 rank 里时返回空数组（调用方退化为只试首选档）。
 */
export const buildQualityLadder = (
  fromQuality: LX.Quality,
  direction: 'down' | 'up',
  available: LX.Quality[],
  rank: readonly LX.Quality[],
): LX.Quality[] => {
  const start = rank.indexOf(fromQuality)
  if (start === -1) return []
  const availableSet = new Set(available)
  const out: LX.Quality[] = []
  if (direction === 'down') {
    for (let i = start + 1; i < rank.length; i++) {
      if (availableSet.has(rank[i])) out.push(rank[i])
    }
  } else {
    for (let i = start - 1; i >= 0; i--) {
      if (availableSet.has(rank[i])) out.push(rank[i])
    }
  }
  return out
}

/**
 * 候选歌曲按平台优先级稳定排序（未知平台排最后、保持原相对顺序）。
 * 返回新数组，不动入参数组（调用方有的会 shift 消费）。
 */
export const sortCandidatesByPriority = <T extends { source: string }>(
  musicInfos: T[],
  priority: LX.OnlineSource[],
): T[] => {
  const rank = new Map<string, number>(priority.map((s, i) => [s, i]))
  const fallback = priority.length
  return [...musicInfos].sort((a, b) => (rank.get(a.source) ?? fallback) - (rank.get(b.source) ?? fallback))
}

/**
 * 引擎错误后的下一档音质（供 controller 降质步用，替代只往下的
 * getNextTryQuality）：从上次试过的档位按用户设定的方向走一档，
 * 只含该歌曲 _qualitys 里有的档位；无下一档时返回 null。
 */
export const getNextStrategyQuality = (
  lastQuality: LX.Quality,
  direction: 'down' | 'up',
  musicInfo: LX.Music.MusicInfoOnline,
  rank: readonly LX.Quality[],
): LX.Quality | null => {
  const available = Object.keys(musicInfo.meta?._qualitys ?? {}) as LX.Quality[]
  const ladder = buildQualityLadder(lastQuality, direction, available, rank)
  return ladder[0] ?? null
}
