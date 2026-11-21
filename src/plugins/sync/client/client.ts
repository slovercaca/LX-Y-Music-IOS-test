import { encryptMsg, decryptMsg, createSerialSendQueue } from './utils'
import { callObj } from './sync'
// import { action as commonAction } from '@/store/modules/common'
// import { getStore } from '@/store'
// import registerSyncListHandler from './syncList'
import log from '../log'
import { aesEncrypt } from '../utils'
import { setSyncStatus } from '@/core/sync'
import { dateFormat } from '@/utils/common'
import { createMsg2call } from 'message2call'
import { toast } from '@/utils/tools'
import { SYNC_CLOSE_CODE, SYNC_CODE } from '../constants'

let status: LX.Sync.Status = {
  status: false,
  message: '',
}

export const sendSyncStatus = (newStatus: Omit<LX.Sync.Status, 'address'>) => {
  status.status = newStatus.status
  status.message = newStatus.message
  setSyncStatus(status)
}

export const sendSyncMessage = (message: string) => {
  status.message = message
  setSyncStatus(status)
}

const heartbeatTools = {
  failedNum: 0,
  maxTryNum: 100000,
  stepMs: 3000,
  connectTimeout: null as NodeJS.Timeout | null,
  pingTimeout: null as NodeJS.Timeout | null,
  delayRetryTimeout: null as NodeJS.Timeout | null,
  handleOpen() {
    console.log('open')
    // this.failedNum = 0
    this.heartbeat()
  },
  heartbeat() {
    if (this.pingTimeout) clearTimeout(this.pingTimeout)

    // Use `WebSocket#terminate()`, which immediately destroys the connection,
    // instead of `WebSocket#close()`, which waits for the close timer.
    // Delay should be equal to the interval at which your server
    // sends out pings plus a conservative assumption of the latency.
    this.pingTimeout = setTimeout(() => {
      client?.close()
    }, 30000 + 1000)
  },
  reConnnect() {
    this.clearTimeout()
    // client = null
    if (!client) return

    if (++this.failedNum > this.maxTryNum) {
      this.failedNum = 0
      sendSyncStatus({
        status: false,
        message: 'Connect error',
      })
      // Bug 30：异步回调里直接 throw 是未捕获异常（maxTryNum 极大、
      // 实际不可达，属防御性清理），记日志后返回，不再抛错。
      log.error('connect error: max retry reached')
      return
    }

    const waitTime = Math.min(2000 + Math.floor(this.failedNum / 2) * this.stepMs, 30000)

    // sendSyncStatus({
    //   status: false,
    //   message: `Waiting ${waitTime / 1000}s reconnnect...`,
    // })

    // 3-10(a)：记下调度时的连接代际——回调触发前若已有新连接建立
    //（如用户手动重连），本次延迟重连作废，不再创建第三个 socket
    // 踩掉正在工作的连接。
    const gen = connectGen
    this.delayRetryTimeout = setTimeout(() => {
      this.delayRetryTimeout = null
      if (!client) return
      if (gen !== connectGen) return
      console.log(dateFormat(new Date()), 'reconnnect...')
      sendSyncStatus({
        status: false,
        message: `Try reconnnect... (${this.failedNum})`,
      })
      connect(client.data.urlInfo, client.data.keyInfo)
    }, waitTime)
  },
  clearTimeout() {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout)
      this.connectTimeout = null
    }
    if (this.delayRetryTimeout) {
      clearTimeout(this.delayRetryTimeout)
      this.delayRetryTimeout = null
    }
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout)
      this.pingTimeout = null
    }
  },
  connect(socket: LX.Sync.Socket) {
    console.log('heartbeatTools connect')
    this.connectTimeout = setTimeout(
      () => {
        this.connectTimeout = null
        if (client) {
          try {
            client.close(SYNC_CLOSE_CODE.failed)
          } catch {}
        }
        if (++this.failedNum > this.maxTryNum) {
          this.failedNum = 0
          sendSyncStatus({
            status: false,
            message: 'Connect error',
          })
          // Bug 30：同 reConnnect——超时回调里 throw 是未捕获异常，
          // 记日志后返回。
          log.error('connect error: max retry reached')
          return
        }
        sendSyncStatus({
          status: false,
          message: 'Connect timeout, try reconnect...',
        })
        this.reConnnect()
      },
      2 * 60 * 1000,
    )
    socket.addEventListener('open', () => {
      if (this.connectTimeout) {
        clearTimeout(this.connectTimeout)
        this.connectTimeout = null
      }
      this.handleOpen()
    })
    socket.addEventListener('message', ({ data }) => {
      if (data == 'ping') this.heartbeat()
    })
    socket.addEventListener('close', (event) => {
      // Bug 28/30：旧 socket 的迟到 close 不能动新连接——其 close 监听
      // 若照常跑 reConnnect，会清掉新连接的定时器并按当前代际再排一次
      // 重连（代际检查拦不住，因为 gen 取的是调用时的 connectGen）。
      if (socket !== client) return
      // console.log(event.code)
      switch (event.code) {
        case SYNC_CLOSE_CODE.normal:
        case SYNC_CLOSE_CODE.failed:
          // Bug 30：先清定时器——socket 在 open 前以 failed 码关闭时，
          // 残留的 2 分钟 connectTimeout 会误触发一次重连（与"failed
          // 不重连"意图相悖）；normal 关闭后残留的 pingTimeout 也一并清掉。
          this.clearTimeout()
          return
      }
      this.reConnnect()
    })
  },
}

let client: LX.Sync.Socket | null
// 3-10(a)：连接代际——每次 connect() 递增，延迟重连回调凭它判断自己是否已过期
let connectGen = 0
// let listSyncPromise: Promise<void>
export const connect = (urlInfo: LX.Sync.UrlInfo, keyInfo: LX.Sync.KeyInfo, options?: { silent?: boolean }) => {
  connectGen++
  // 3-10(a)：新建连接前先关闭旧 socket、清掉旧心跳定时器——此前
  // connect() 从不清理旧连接，旧 socket 泄漏且其 close/message 监听
  // 继续生效；旧 ping/connect 超时定时器还可能误关新连接。
  // 用 normal 码关闭：心跳的 close 监听对 normal 码直接返回，不会
  // 再触发一轮重连；旧连接自身的 close 监听仍会跑清理（destroy 等）。
  if (client) {
    try { client.close(SYNC_CLOSE_CODE.normal) } catch { /* 忽略 */ }
    client = null
  }
  heartbeatTools.clearTimeout()
  client = new WebSocket(
    `${urlInfo.wsProtocol}//${urlInfo.hostPath}/socket?i=${encodeURIComponent(keyInfo.clientId)}&t=${encodeURIComponent(aesEncrypt(SYNC_CODE.msgConnect, keyInfo.key))}`,
  ) as LX.Sync.Socket
  // 3-9：本连接的 socket 引用——排队的发送必须发到发出它的那条连接上，
  // 不能走模块级 client（重连后 client 已指向新 socket）
  const socket = client
  client.data = {
    keyInfo,
    urlInfo,
  }
  heartbeatTools.connect(client)

  let closeEvents: Array<(err: Error) => void | Promise<void>> = []
  let disconnected = true

  // 3-9：本连接的串行发送队列（见 utils.ts createSerialSendQueue）
  const sendQueue = createSerialSendQueue()

  const message2read = createMsg2call<LX.Sync.ServerSyncActions>({
    funcsObj: {
      ...callObj,
      finished() {
        // Bug 28：旧连接的迟到 finished 不能动新连接的状态——回调内统一
        // 用本连接的闭包 socket，状态更新前检查 socket 是否仍是当前连接；
        // 此前用模块级 client，disconnect() 置 null 后还会抛空指针。
        if (socket !== client) return
        // 仅对真实（手动/重连）连接成功弹 toast；App 冷启动的自动连接不弹，
        // 避免"每次杀死后台再打开都显示 sync connected"的骚扰。
        if (!options?.silent) toast('Sync connected')
        socket.isReady = true
        sendSyncStatus({
          status: true,
          message: '',
        })
        heartbeatTools.failedNum = 0
      },
    },
    timeout: 120 * 1000,
    sendMessage(data) {
      if (disconnected) throw new Error('disconnected')
      // 3-9：走串行发送队列——encryptMsg 对 >1024 的消息多一次 gzip
      // 微任务 hop，同一 tick 内连续两次 send 会颠倒顺序；串行化后
      // 按调用顺序发出。发送前再查 disconnected，避免断连后把旧连接
      // 的消息发到新 socket 上。
      sendQueue(async() => {
        if (disconnected) return
        try {
          const encrypted = await encryptMsg(keyInfo, JSON.stringify(data))
          if (disconnected) return
          socket.send(encrypted)
        } catch (err) {
          log.error('encrypt msg error: ', err)
          try { socket.close(SYNC_CLOSE_CODE.failed) } catch { /* 忽略 */ }
        }
      })
    },
    onCallBeforeParams(rawArgs) {
      // Bug 28：消息解密是异步的，解密完成到分发之间若发生重连，读模块级
      // client 会把旧连接的 RPC 发到新 socket 上（各 handler 都依赖首参
      // socket 的身份：moduleReadys、onClose、registerEvent）。用本连接
      // 的闭包 socket，与 3-9 的发送队列同口径。
      return [socket, ...rawArgs]
    },
    onError(error, path, groupName) {
      const name = groupName ?? ''
      log.r_error(`sync call ${name} ${path.join('.')} error:`, error)
      // if (groupName == null) return
      // client?.close(SYNC_CLOSE_CODE.failed)
      // sendSyncStatus({
      //   status: false,
      //   message: error.message,
      // })
    },
  })

  client.remote = message2read.remote
  client.remoteQueueList = message2read.createQueueRemote('list')
  client.remoteQueueDislike = message2read.createQueueRemote('dislike')

  client.addEventListener('message', ({ data }) => {
    if (data == 'ping') return
    if (typeof data === 'string') {
      void decryptMsg(keyInfo, data)
        .then((data) => {
          let syncData: LX.Sync.ServerSyncActions
          try {
            syncData = JSON.parse(data)
          } catch (err) {
            log.error('parse msg error: ', err)
            try { socket.close(SYNC_CLOSE_CODE.failed) } catch { /* 忽略 */ }
            return
          }
          message2read.message(syncData)
        })
        .catch((error) => {
          log.error('decrypt msg error: ', error)
          try { socket.close(SYNC_CLOSE_CODE.failed) } catch { /* 忽略 */ }
        })
    }
  })
  client.onClose = function(handler: (typeof closeEvents)[number]) {
    closeEvents.push(handler)
    return () => {
      const idx = closeEvents.indexOf(handler)
      if (idx >= 0) closeEvents.splice(idx, 1)
    }
  }

  const initMessage = 'Wait syncing...'
  client.addEventListener('open', () => {
    // Bug 28：旧 socket 在 close-during-connect 后迟到的 open 不能动
    // 新连接的状态（RN WebSocket 该时序是否还触发 open 未定，静态防御）。
    if (socket !== client) return
    log.info('connect')
    // const store = getStore()
    // global.lx.syncKeyInfo = keyInfo
    socket.isReady = false
    socket.moduleReadys = {
      list: false,
      dislike: false,
    }
    disconnected = false
    sendSyncStatus({
      status: false,
      message: initMessage,
    })
  })
  client.addEventListener('close', ({ code }) => {
    const err = new Error('closed')
    try {
      for (const handler of closeEvents) void handler(err)
    } catch (err: any) {
      log.error(err?.message)
    }
    closeEvents = []
    disconnected = true
    message2read.destroy()
    // Bug 28：本地清理（closeEvents、destroy）属于本连接闭包，照常跑；
    // 但状态上报要 gate——旧 socket 的迟到 close 会把新连接的状态显示
    // 覆写为断开（通常随后被新 socket 的 open/finished 覆盖，多为瞬时）。
    if (socket !== client) return
    switch (code) {
      case SYNC_CLOSE_CODE.normal:
        // case SYNC_CLOSE_CODE.failed:
        sendSyncStatus({
          status: false,
          message: '',
        })
        break
      case SYNC_CLOSE_CODE.failed:
        if (!status.message || status.message == initMessage) {
          sendSyncStatus({
            status: false,
            message: 'failed',
          })
        }
        break
    }
  })
  client.addEventListener('error', ({ message }) => {
    // Bug 28：同 close——旧 socket 的迟到 error 不覆写新连接状态。
    if (socket !== client) return
    sendSyncStatus({
      status: false,
      message,
    })
  })
}

export const disconnect = async() => {
  if (!client) return
  log.info('disconnecting...')
  client.close(SYNC_CLOSE_CODE.normal)
  client = null
  heartbeatTools.clearTimeout()
  heartbeatTools.failedNum = 0
}

export const getStatus = (): LX.Sync.Status => status
