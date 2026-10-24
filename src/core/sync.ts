import { dismissOverlay, onComponentDidDisappear, onModalDismissed, showSyncModeModal } from '@/navigation'
import syncState from '@/store/sync/state'
import syncActions from '@/store/sync/action'

type RemoveListener = (() => void) | null
let removeEvent: RemoveListener

export const setSyncStatus = (status: LX.Sync.Status) => {
  syncActions.setStatus(status)
}

export const setSyncMessage = (message: LX.Sync.Status['message']) => {
  syncActions.setMessage(message)
}

export const setSyncModeComponentId = (id: string) => {
  syncActions.setSyncModeComponentId(id)
}

const closeSyncModeModal = () => {
  if (syncState.syncModeComponentId) {
    void dismissOverlay(syncState.syncModeComponentId)
    syncActions.setSyncModeComponentId('')
  }
}
export const selectSyncMode = async <T extends keyof LX.Sync.ModeTypes>(
  serverName: string,
  type: T,
) =>
  new Promise<LX.Sync.ModeTypes[T]>((resolve, reject) => {
    removeSyncModeEvent()
    syncActions.setServerInfo(serverName, type)

    let removeListener: RemoveListener | null = null
    let settled = false

    const removeListeners = () => {
      settled = true
      if (removeListener) {
        removeListener()
        removeListener = null
      }
      removeEvent = null
      global.app_event.off('selectSyncMode', handleSelectMode)
    }

    const handleSelectMode = ({ mode }: LX.Sync.ModeType) => {
      removeListeners()
      closeSyncModeModal()
      resolve(mode as LX.Sync.ModeTypes[T])
    }

    // 高：此前这里用 let 声明了同名局部变量，遮蔽模块级 removeEvent——
    // 导出的 removeSyncModeEvent() 读到的永远是 undefined，外部取消
    // （socket 同步关闭时）永不生效，Promise 与监听泄漏
    removeEvent = () => {
      removeListeners()
      reject(new Error('cancel'))
    }

    global.app_event.on('selectSyncMode', handleSelectMode)

    // 中：弹窗展示失败（重试后仍失败）时取消等待，不再无声悬挂
    showSyncModeModal(() => {
      if (!settled) removeEvent?.()
    })

    // 2026-10-05 fix（P1-12）：componentId 在 modal 挂载后的 useEffect 才设置，
    // 同步注册时还是空字符串。轮询等待 ID 就绪后再注册 dismiss 监听。
    // 低：轮询加 5 秒上限——弹窗异常未挂载时此前 50ms 永久空转+监听泄漏
    let waitAttempts = 0
    const waitForId = () => {
      if (settled) return
      if (++waitAttempts > 100) {
        removeEvent?.()
        return
      }
      const id = syncState.syncModeComponentId
      if (id) {
        removeListener = onModalDismissed(id, () => {
          syncActions.setSyncModeComponentId('')
          removeEvent?.()
        })
        // 中：overlay 被外部关闭时 modalDismissed 不触发（见 event.ts 注释），
        // 用 componentDidDisappear 兜底取消等待中的同步
        const removeDisappear = onComponentDidDisappear(id, () => {
          syncActions.setSyncModeComponentId('')
          removeEvent?.()
        })
        const prevRemove = removeListener
        removeListener = () => {
          prevRemove()
          removeDisappear()
        }
      } else {
        setTimeout(waitForId, 50)
      }
    }
    waitForId()
  })

export const removeSyncModeEvent = () => {
  if (!removeEvent) return
  removeEvent()
  removeEvent = null
  closeSyncModeModal()
}
