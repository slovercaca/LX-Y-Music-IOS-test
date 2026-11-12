// import { generateKeyPair } from 'crypto'
import { gzipString, unGzipString } from '@/utils/fs'

export const request = async(
  url: string,
  { timeout = 10000, ...options }: RequestInit & { timeout?: number } = {},
) => {
  const controller = new AbortController()
  // 普通 setTimeout：这里只是请求超时后的 abort 兜底，不需要在 App 被挂起时唤醒；
  // 用 BackgroundTimer 会为整段请求申请后台任务断言（阻止挂起 = 净耗电）。
  let id: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    id = null
    controller.abort()
  }, timeout)
  return fetch(url, {
    ...options,
    signal: controller.signal,
  })
    .then(async(response) => {
      const text = await response.text()
      return {
        text,
        code: response.status,
      }
    })
    .catch((err) => {
      // console.log(err, err.code, err.message)
      throw err
    })
    .finally(() => {
      if (id == null) return
      clearTimeout(id)
    })
}

// export const aesEncrypt = (text: string, key: string, iv: string) => {
//   const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'base64'), Buffer.from(iv, 'base64'))
//   return Buffer.concat([cipher.update(Buffer.from(text)), cipher.final()]).toString('base64')
// }

// export const aesDecrypt = (text: string, key: string, iv: string) => {
//   const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key, 'base64'), Buffer.from(iv, 'base64'))
//   return Buffer.concat([decipher.update(Buffer.from(text, 'base64')), decipher.final()]).toString()
// }

export { generateRsaKey } from '@/utils/nativeModules/crypto'
// export const generateRsaKey = async() => new Promise<{ publicKey: string, privateKey: string }>((resolve, reject) => {
//   generateKeyPair(
//     'rsa',
//     {
//       modulusLength: 2048, // It holds a number. It is the key size in bits and is applicable for RSA, and DSA algorithm only.
//       publicKeyEncoding: {
//         type: 'spki', // Note the type is pkcs1 not spki
//         format: 'pem',
//       },
//       privateKeyEncoding: {
//         type: 'pkcs8', // Note again the type is set to pkcs1
//         format: 'pem',
//         // cipher: "aes-256-cbc", //Optional
//         // passphrase: "", //Optional
//       },
//     },
//     (err, publicKey, privateKey) => {
//       if (err) {
//         reject(err)
//         return
//       }
//       resolve({
//         publicKey,
//         privateKey,
//       })
//     },
//   )
// })

export const encryptMsg = async(keyInfo: LX.Sync.KeyInfo, msg: string): Promise<string> => {
  return msg.length > 1024 ? 'cg_' + (await gzipString(msg)) : msg
  // if (!keyInfo) return ''
  // return aesEncrypt(msg, keyInfo.key, keyInfo.iv)
}

/**
 * 3-9：串行发送队列。encryptMsg 对 >1024 的消息多一次 gzip 微任务 hop，
 * 同一 tick 内连续两次 send 时小消息会先发出、顺序颠倒；经此队列串行化
 * 后按调用顺序发出。上一项无论成功失败都继续下一项，不让一次失败堵死
 * 后续发送。
 */
export const createSerialSendQueue = () => {
  let chain: Promise<void> = Promise.resolve()
  return (task: () => Promise<void>): void => {
    chain = chain.then(task, task)
  }
}

export const decryptMsg = async(keyInfo: LX.Sync.KeyInfo, enMsg: string): Promise<string> => {
  return enMsg.substring(0, 3) == 'cg_' ? unGzipString(enMsg.replace('cg_', '')) : enMsg
  // if (!keyInfo) return ''
  // let msg = ''
  // try {
  //   msg = aesDecrypt(enMsg, keyInfo.key, keyInfo.iv)
  // } catch (err) {
  //   console.log(err)
  // }
  // return msg
}

export const parseUrl = (href: string): LX.Sync.UrlInfo => {
  href = href.trim().replace(/\/+$/, '')
  const httpProtocol = /^https:/i.test(href) ? 'https:' : 'http:'
  const hostPath = href.replace(/^https?:\/\//i, '')
  const normalizedHref = `${httpProtocol}//${hostPath}`

  console.log({
    wsProtocol: httpProtocol == 'https:' ? 'wss:' : 'ws:',
    httpProtocol,
    hostPath,
    href: normalizedHref,
  })

  return {
    wsProtocol: httpProtocol == 'https:' ? 'wss:' : 'ws:',
    httpProtocol,
    hostPath,
    href: normalizedHref,
  }
}

export const sendStatus = (_status: LX.Sync.Status) => {
  // syncLog.log(JSON.stringify(status))
}
