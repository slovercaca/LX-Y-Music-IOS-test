import { bootLog } from '@/utils/bootLog'

export const withTimeout = async <T,>(
  promise: Promise<T>,
  label: string,
  fallback: T,
  timeoutMs = 3000,
  // 1-4：超时回调——调用方用它标记原 promise 已过期，晚到结果直接丢弃
  // （withTimeout 本身不取消原 promise，超时后它仍会继续跑到结算）
  onTimeout?: () => void,
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      bootLog(`${label} timeout, using fallback.`)
      onTimeout?.()
      resolve(fallback)
    }, timeoutMs)
    promise.then(
      value => {
        clearTimeout(timeoutId)
        resolve(value)
      },
      error => {
        clearTimeout(timeoutId)
        reject(error)
      },
    )
  })
}
