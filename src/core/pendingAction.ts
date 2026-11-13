interface PendingAction {
  // 1-21③：searchDeepLink 带 data { keyword, source, type }，由 Search 页在
  // 切入/挂载时消费并转发明 searchDeepLink 事件，替代 100ms 盲等定时
  type: 'searchFocus' | 'songlistImport' | 'localDownloadTab' | 'searchDeepLink'
  data?: any
}

type PendingActionType = PendingAction['type']

// D-6：按类型分槽——原单槽模块级变量下 setPendingAction 直接覆盖，
// 1-21③ 把 searchDeepLink 也改走待办后，DownloadBall 的 localDownloadTab
// 与 deeplink 快速连续到达时后者覆盖前者、丢一个动作。分槽后各类型互不
// 干扰；同类型仍是「后来者覆盖」（新 deeplink 取代未消费的旧 deeplink，
// searchFocus/songlistImport 的 data: true 本就是幂等标志）。
// 消费侧只按自己的类型取（consume/has 均带 type 参数），接口、返回值与
// M-2/S-1 的 data: true 真值检查语义均不变；各槽用 in/delete 判断存在，
// data 为 undefined 时行为与原版一致（consume 返回 undefined、has 为 true）。
const pendingActions: Partial<Record<PendingActionType, any>> = {}

export const setPendingAction = (action: PendingAction) => {
  pendingActions[action.type] = action.data
}

export const consumePendingAction = (type: PendingActionType): any | null => {
  if (type in pendingActions) {
    const data = pendingActions[type]
    delete pendingActions[type]
    return data
  }
  return null
}

export const hasPendingAction = (type: PendingActionType): boolean => {
  return type in pendingActions
}
