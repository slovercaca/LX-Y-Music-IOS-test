import { Linking } from 'react-native'
import { errorDialog } from './utils'
import { handleMusicAction } from './musicAction'
import { handlePlayerAction, type PlayerAction } from './playerAction'
import { handleSonglistAction } from './songlistAction'
import { handleSearchAction } from './searchAction'
import { setNavActiveId } from '@/core/common'
import { setPendingAction } from '@/core/pendingAction'
import commonState from '@/store/common/state'
import { extname, stat } from '@/utils/fs'
import { handleFileMusicAction, handleFileJSAction, handleFileLXMCAction } from './fileAction'

// 1-21：单参数解码失败返回 null，调用方跳过该参数，不让整个 deeplink 失败
const safeDecode = (value: string): string | null => {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

const handleLinkAction = async(link: string) => {
  // console.log(link)
  // 低：只在第一个 '#' 切分——此前 split('#') 取前两段，链接里出现
  // 第二个 '#' 时其后参数被静默丢弃
  const hashIdx = link.indexOf('#')
  const url = hashIdx >= 0 ? link.substring(0, hashIdx) : link
  const hash = hashIdx >= 0 ? link.substring(hashIdx + 1) : ''
  const [type, action, ...paths] = url.replace('lxmusic://', '').split('/')
  const params: {
    paths: string[]
    data?: string
    [key: string]: any
  } = {
    paths: [],
  }
  if (hash) {
    const kwMatch = /(?:^|&)keyword=/.exec(hash)
    if (kwMatch) {
      const kwStart = kwMatch.index + kwMatch[0].length
      // 1-21：keyword 取到下一个 & 为止——此前只认 &platform=/&type= 两个边界，
      // 其余参数（如 &source=）跟在 keyword 后会被吞进 keyword 值
      const kwEnd = hash.indexOf('&', kwStart)
      const decodedKeyword = safeDecode(kwEnd === -1 ? hash.substring(kwStart) : hash.substring(kwStart, kwEnd))
      if (decodedKeyword != null) params.keyword = decodedKeyword
    }
    const paramRegex = /([^&=]+)=([^&]*)/g
    let match
    while ((match = paramRegex.exec(hash)) !== null) {
      if (match[1] !== 'keyword') {
        const decoded = safeDecode(match[2] || '')
        if (decoded != null) params[match[1]] = decoded
      }
    }
  }
  // 中：params 循环里已 decodeURIComponent 过一次——此前这里再解一次，
  // 发送方只编码一次时 data 内嵌的 % 会被二次解码损坏或抛 URIError
  if (params.data) {
    try {
      params.data = JSON.parse(params.data)
    } catch {
      // 1-21：data 解析失败则跳过该参数（删除），不让整个 deeplink 失败
      delete params.data
    }
  }
  // 1-21：路径段解码失败时保留原文（丢段会错位 paths[0] 的解析）
  params.paths = paths.map((p) => safeDecode(p) ?? p)
  console.log(params)
  switch (type) {
    case 'music':
      await handleMusicAction(action, params)
      break
    case 'songlist':
      await handleSonglistAction(action, params)
      break
    case 'player':
      await handlePlayerAction(action as PlayerAction)
      break
    case 'search':
      await handleSearchAction(action, params)
      break
    case 'setting':
      setNavActiveId('nav_setting')
      break
    case 'nav':
      if (action === 'search' || params.target === 'search') {
        // 1-21③：不再 100ms 盲等——keyword 经 pendingAction 由 Search 页在切入/
        // 挂载时消费并转发明 searchDeepLink 事件（见 Search/index.tsx）；已在
        // 搜索页时立即发事件（页面已挂载、监听在册；setNavActiveId 同值短路，
        // 不发导航事件，pendingAction 会滞留）。聚焦由 handleSearchDeepLink
        // 内的 300ms focus 负责，不再另设 searchFocus
        const keyword = params.keyword || ''
        const searchType = params.type || ''
        if (commonState.navActiveId === 'nav_search') {
          global.app_event.searchDeepLink(keyword, '', searchType)
        } else {
          setPendingAction({ type: 'searchDeepLink', data: { keyword, source: '', type: searchType } })
          setNavActiveId('nav_search')
        }
      } else if (action === 'songlist' || params.target === 'songlist') {
        // M-2：必须带 data: true——consumePendingAction 返回的是 data，
        // 不带时消费侧真值检查恒假（见 SongList/Content.tsx:172/178），
        // 「不在歌单页 / 冷启动」两路径的导入弹窗永不打开
        setPendingAction({ type: 'songlistImport', data: true })
        // 1-21：不再 100ms 盲等——已在歌单页时立即发事件（页面已挂载、监听在册）；
        // 否则靠 pendingAction，页面在切入（navActiveIdUpdated）或挂载时消费
        // （见 SongList/Content.tsx）；setNavActiveId 同值短路，已在目标页时不发导航事件
        if (commonState.navActiveId === 'nav_songlist') {
          global.app_event.openSonglistImport()
        } else {
          setNavActiveId('nav_songlist')
        }
      } else if (action === 'setting' || params.target === 'setting') {
        setNavActiveId('nav_setting')
      }
      break
    // default: throw new Error('Unknown type: ' + type)
  }
}

const handleFileAction = async(link: string) => {
  const file = await stat(link)
  // console.log(file)
  switch (extname(file.name)) {
    case 'json':
    case 'lxmc':
      await handleFileLXMCAction(file)
      break
    case 'js':
      await handleFileJSAction(file)
      break
    case 'ogg':
    case 'flac':
    case 'wav':
    case 'mp3':
    case 'm4a':
    case 'aac':
    case 'opus':
    case 'wma':
    case 'ape':
      await handleFileMusicAction(file)
      break
    default:
      if (!file.mimeType?.startsWith('audio/')) throw new Error('Unknown file type')
      await handleFileMusicAction(file)
      break
  }
}

// const handleHttpAction = async(link: string) => {
// }

const runLinkAction = async(link: string) => {
  if (link.startsWith('lxmusic://')) {
    try {
      await handleLinkAction(link)
    } catch (err: any) {
      errorDialog(err.message)
      // focusWindow()
    }
  } else if (link.startsWith('file://') || link.startsWith('content://')) {
    try {
      await handleFileAction(link)
    } catch (err: any) {
      errorDialog(err.message)
      // focusWindow()
    }
  }
  //  else if (/^https?:\/\//.test(link)) {
  //   try {
  //     await handleHttpAction(link)
  //   } catch (err: any) {
  //     errorDialog(err.message)
  //     // focusWindow()
  //   }
  // }
}

// 1-3：模块级幂等守卫——重复调用不再叠加 Linking 监听/重复消费冷启动链接
let deeplinkInitialized = false
export const initDeeplink = async() => {
  if (deeplinkInitialized) return
  deeplinkInitialized = true
  Linking.addEventListener('url', ({ url }) => {
    void runLinkAction(url)
    console.log('deeplink', url)
  })
  const initialUrl = await Linking.getInitialURL()
  if (initialUrl == null) return
  console.log('deeplink', initialUrl)
  void runLinkAction(initialUrl)
}
