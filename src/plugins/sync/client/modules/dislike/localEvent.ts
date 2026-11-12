import { SYNC_CLOSE_CODE } from '@/plugins/sync/constants'
import { registerDislikeActionEvent } from '../../../dislikeEvent'

let unregisterLocalListAction: (() => void) | null
// 3-10(c)：记录本次注册所属的 socket——旧 socket 的迟到 close 事件
// 不能注销新 socket 的监听（此前注销句柄是模块级单例，不绑定身份）。
let registeredSocket: LX.Sync.Socket | null = null

export const registerEvent = (socket: LX.Sync.Socket) => {
  // socket = _socket
  // socket.onClose(() => {
  //   unregisterLocalListAction?.()
  //   unregisterLocalListAction = null
  // })
  unregisterEvent()
  registeredSocket = socket
  unregisterLocalListAction = registerDislikeActionEvent((action) => {
    if (!socket.moduleReadys?.dislike) return
    void socket.remoteQueueDislike.onDislikeSyncAction(action).catch((err) => {
      // TODO send status
      socket.moduleReadys.dislike = false
      socket.close(SYNC_CLOSE_CODE.failed)
      console.log(err.message)
    })
  })
}

export const unregisterEvent = (socket?: LX.Sync.Socket) => {
  // 3-10(c)：带 socket 身份时只注销属于该 socket 的监听；不带身份
  //（registerEvent 接管时）无条件注销旧监听。
  if (socket && registeredSocket && registeredSocket !== socket) return
  unregisterLocalListAction?.()
  unregisterLocalListAction = null
  registeredSocket = null
}
