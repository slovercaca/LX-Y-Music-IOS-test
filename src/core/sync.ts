import { dismissOverlay, onModalDismissed, showSyncModeModal } from '@/navigation'
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
    showSyncModeModal()

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

    let removeEvent: (() => void) | null = () => {
      removeListeners()
      reject(new Error('cancel'))
    }

    global.app_event.on('selectSyncMode', handleSelectMode)

    // 2026-10-05 fix（P1-12）：componentId 在 modal 挂载后的 useEffect 才设置，
    // 同步注册时还是空字符串。轮询等待 ID 就绪后再注册 dismiss 监听。
    const waitForId = () => {
      if (settled) return
      const id = syncState.syncModeComponentId
      if (id) {
        removeListener = onModalDismissed(id, () => {
          syncActions.setSyncModeComponentId('')
          removeEvent?.()
        })
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
