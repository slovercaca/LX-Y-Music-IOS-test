import { type EmitterSubscription } from 'react-native'
import { Navigation } from 'react-native-navigation'

export const onModalDismissed = (id: string, handler: () => void) => {
  let modalDismissedListener: EmitterSubscription | null =
    Navigation.events().registerModalDismissedListener(({ componentId, modalsDismissed: _modalsDismissed }) => {
      if (componentId != id || !modalDismissedListener) return
      handler()
      modalDismissedListener.remove()
      modalDismissedListener = null
    })
  return () => {
    if (!modalDismissedListener) return
    modalDismissedListener.remove()
    modalDismissedListener = null
  }
}

/**
 * 中：SyncModeModal 是 overlay 展示，RNN 的 modalDismissed 事件永不触发
 * （全仓从未调用 showModal）——同步等待方靠它取消是死代码。overlay 的
 * 关闭信号是 componentDidDisappear，用这个监听兜底取消。
 */
export const onComponentDidDisappear = (id: string, handler: () => void) => {
  let listener: EmitterSubscription | null =
    Navigation.events().registerComponentDidDisappearListener(({ componentId }) => {
      if (componentId != id || !listener) return
      handler()
      listener.remove()
      listener = null
    })
  return () => {
    if (!listener) return
    listener.remove()
    listener = null
  }
}
