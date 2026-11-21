import { httpFetch } from '../../request'
import getSongId from './songId'

export default {
  // Bug 40：去掉 async——函数体内无 await，同步返回 requestObj；此前标 async 时
  // 重试分支拿到的 tryRequestObj 是 Promise，.cancelHttp 为 undefined，调 .bind 必崩。
  getPicUrl(songId, tryNum = 0) {
    let requestObj = httpFetch(
      `http://music.migu.cn/v3/api/music/audioPlayer/getSongPic?songId=${songId}`,
      {
        headers: {
          Referer: 'http://music.migu.cn/v3/music/player/audio?from=migu',
        },
      },
    )
    // 高：变换后的 promise 必须赋回——此前调用方拿到原始响应对象而非
    // 图片 URL，咪咕封面整体失效；失败重试还误调 getPic（应为 getPicUrl）
    requestObj.promise = requestObj.promise.then(({ body }) => {
      if (body.returnCode !== '000000') {
        if (tryNum > 5) return Promise.reject(new Error('图片获取失败'))
        let tryRequestObj = this.getPicUrl(songId, ++tryNum)
        requestObj.cancelHttp = tryRequestObj.cancelHttp.bind(tryRequestObj)
        return tryRequestObj.promise
      }
      let url = body.largePic || body.mediumPic || body.smallPic
      if (!/https?:/.test(url)) url = 'http:' + url
      return url
    })
    return requestObj
  },
  async getPic(songInfo) {
    const songId = await getSongId(songInfo)
    // Bug 40：契约是 Promise<string>——此前直接返回 requestObj，调用方当作 URL
    // 字符串用（真值对象），不触发换源兜底，下游图片加载失败；改为返回解包后的 promise。
    return this.getPicUrl(songId).promise
  },
}
