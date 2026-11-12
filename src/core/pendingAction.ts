interface PendingAction {
  // 1-21③：searchDeepLink 带 data { keyword, source, type }，由 Search 页在
  // 切入/挂载时消费并转发明 searchDeepLink 事件，替代 100ms 盲等定时
  type: 'searchFocus' | 'songlistImport' | 'localDownloadTab' | 'searchDeepLink'
  data?: any
}

let pendingAction: PendingAction | null = null

export const setPendingAction = (action: PendingAction) => {
  pendingAction = action
}

export const consumePendingAction = (type: PendingAction['type']): any | null => {
  if (pendingAction && pendingAction.type === type) {
    const data = pendingAction.data
    pendingAction = null
    return data
  }
  return null
}

export const hasPendingAction = (type: PendingAction['type']): boolean => {
  return pendingAction?.type === type
}
