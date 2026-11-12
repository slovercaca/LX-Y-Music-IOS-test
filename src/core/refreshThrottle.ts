/**
 * 「本次运行首次点击必刷新，之后距上次刷新满 1 小时才刷新」闸门。
 *
 * 规则（用户定义）：冷启动后的**第一次**点击（进入某处）一定联网刷新；
 * 之后每次点击，只有距离上次刷新满 1 小时才再次联网刷新，未满则直接用已有数据。
 * 冷启动 = 进程重启 → 内存表清空 → 首次必刷新。
 */
export const REFRESH_TTL_MS = 60 * 60 * 1000

const lastRefreshAt = new Map<string, number>()

/**
 * 该键是否应当刷新（纯判定，不记时刻）。
 *
 * 4-16：此前返回 true 时即记时刻，请求失败也占掉 1 小时 TTL。改为请求成功后
 * 由调用方调 markRefreshed 补记；失败不占 TTL，下次点击可再试。
 */
export const shouldRefreshByTtl = (key: string, ttlMs: number = REFRESH_TTL_MS): boolean => {
  const last = lastRefreshAt.get(key)
  return last == null || Date.now() - last >= ttlMs
}

/** 手动刷新 / 首次取数后补记时刻，避免紧接着的点击又触发一次刷新 */
export const markRefreshed = (key: string) => {
  lastRefreshAt.set(key, Date.now())
}
