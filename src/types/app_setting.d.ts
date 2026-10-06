declare global {
  namespace LX {
    type AddMusicLocationType = 'top' | 'bottom'
    type DownloadFileNameFormat = '歌名 - 歌手' | '歌手 - 歌名' | '歌名'

    /**
     * Home 内嵌的「分界面」状态（目前只有歌单详情）：退出软件后再次进入时恢复。
     * navId 限定写入方（推荐 / 歌单），搜索 / 我的 / 设置只恢复 Tab 主界面。
     */
    interface HomeSubView {
      navId: string
      info: Record<string, any>
    }

    interface AppSetting {
      // 索引签名：lx-music 的设置键为点分字符串（如 'common.wy_cookie'），
      // 新增加设置项常未同步声明到该接口，导致调用方用字符串键索引时报 TS7053 /
      // keyof 错误，并级联引发下游（如 Animated style 的 textAlign）类型错误。
      // 允许任意字符串键索引（值为 any），清除历史既有类型错误且不引入新报错；
      // 已显式声明的键仍保留精确类型。
      [key: string]: any
      version: string
      'version.autoCheckUpdate': boolean

      /**
       * 播放详情页-封面大小
       */
      'playDetail.style.coverSize': number

      /**
       * 播放详情页-封面形状。
       * 'circle'：圆形封面，可随「封面旋转效果」开关旋转；
       * 'square'：方形封面，**强制不旋转**（方形旋转后四角会甩出容器，
       * 即使容器裁切也无法观感自洽，故方形与旋转互斥）。
       */
      'playDetail.style.coverShape': 'circle' | 'square'

      /**
       * 歌词水平对齐方式
       */
      'playDetail.style.align': 'left' | 'center' | 'right'
      /**
       * 竖屏歌词字体大小
       */
      'playDetail.vertical.style.lrcFontSize': number

      /**
       * 横屏歌词字体大小
       */
      'playDetail.horizontal.style.lrcFontSize': number

      /**
       * 播放详情页-是否允许通过歌词调整播放进度
       */
      'playDetail.isShowLyricProgressSetting': boolean

      /**
       * 显示蓝牙歌词。
       *
       * 开：把当前歌词行推送到系统媒体信息（`MPNowPlayingInfoCenter` 的 artist 字段），
       * 控制中心 / 锁屏 / 车机 / 蓝牙音箱读的都是同一份系统媒体信息，因此一处开关
       * 同时覆盖「车机歌词」与「音箱歌词」。
       * 关：媒体信息只显示「歌名 · 歌手」，不推送歌词行。
       *
       * 生效范围（两处共同门控，缺一不可）：
       * 1) JS 逐行钩子（`core/init/player/lyric.ts` 的 onLyricPlay）不再发布歌词行；
       * 2) 原生歌词时间轴（`setNowPlayingLyrics`）被清空，原生 tick 不会再把歌词写进 artist。
       * 默认开，保持既有行为。
       */
      'player.isShowBluetoothLyric': boolean

      /**
       * 是否允许拖动播放进度条跳转（关闭后进度条仅展示，不可 seek）
       */
      'common.allowProgressBarSeek': boolean

      /**
       * 各平台 Cookie（默认空字符串 = 未登录）
       */
      'common.wy_cookie': string
      'common.kg_cookie': string
      'common.tx_cookie': string
      'common.yt_cookie': string

      /**
       * 推荐页平台按钮顺序（平台 id 数组，空数组表示使用默认顺序）
       */
      'common.discoveryPlatformOrder': string[]

      /**
       * 是否显示热门搜索
       */
      'search.isShowHotSearch': boolean

      /**
       * 是否显示搜索历史
       */
      'search.isShowHistorySearch': boolean

      /**
       * 启用的搜索平台
       */
      'search.enabledSources': Record<string, boolean>

      /**
       * 是否启用双击列表里的歌曲时自动切换到当前列表播放（仅对歌单、排行榜有效）
       */
      'list.isClickPlayList': boolean

      /**
       * 是否显示歌曲来源（仅对我的列表有效）
       */
      'list.isShowSource': boolean

      /**
       * 是否显示歌曲专辑名
       */
      'list.isShowAlbumName': boolean

      /**
       * 是否显示歌曲时长
       */
      'list.isShowInterval': boolean
      'list.isShowCover': boolean

      /**
       * 是否自动恢复列表滚动位置（仅对我的列表有效）
       */
      'list.isSaveScrollLocation': boolean

      /**
       * 添加歌曲到我的列表时的方式
       */
      'list.addMusicLocationType': AddMusicLocationType

      'list.isAutoSaveDailyRec': boolean

      /**
       * “我的”页列表卡片显示状态（未配置的列表默认显示）
       */
      'list.myListVisibility': Record<string, boolean>

      'menu.playLater': boolean
      'menu.addTo': boolean
      'menu.dislike': boolean

      'menu.moveTo': boolean
      'menu.changePosition': boolean
      'menu.changeSource': boolean

      'artistDetail.albumViewMode': 'grid' | 'list'
      /**
       * 是否启用下载
       */
      'download.enable': boolean

      'download.path': string
      /**
       * 文件命名方式
       */
      'download.fileName': '歌名 - 歌手' | '歌手 - 歌名' | '歌名'

      /**
       * 是否写入歌词
       */
      'download.writeLyric': boolean
      /**
         * 是否写入罗马音歌词
       */
      'download.writeRomaLyric': boolean
      /**
       * 是否内嵌歌词到音频文件
       */
      'download.writeEmbedLyric': boolean
      /**
       * 是否写入封面
       */
      'download.writePicture': boolean

      /**
       * 是否写入元数据
       */
      'download.writeMetadata': boolean
      'download.writeAlias': boolean
      'download.quality': LX.Quality

      /**
       * 是否启用同步
       */
      'sync.enable': boolean
      'sync.webdav.enable': boolean
      'sync.webdav.syncLists': boolean
      'sync.webdav.syncPlayHistory': boolean
      'sync.webdav.syncDownloadTasks': boolean
      'sync.webdav.url': string
      'sync.webdav.username': string
      'sync.webdav.password': string
      'webdav.downloadPath': string
      /** 上传并发线程数（1-6） */
      'webdav.uploadConcurrency': number

      /**
       * 封面歌词来源（2026-10-04）：'file' = 从歌曲文件，'online' = 从云端插件在线匹配。
       */
      'webdav.mediaSource': 'file' | 'online'
      'sync.webdav.path': string
      'sync.webdav.lastSyncTimeLists': number
      /**
       * 多服务器故障转移：备份/同步时当前服务器无法连接，自动按配置列表顺序
       * 换一台可用的服务器重试。默认关闭，需用户手动开启。
       */
      'sync.webdav.failoverEnabled': boolean
      /**
       * 故障转移发生时是否 toast 提示。关闭后静默切换。
       */
      'sync.webdav.failoverNotify': boolean

      /**
       * 同步平台 cookie（2026-10-04）：开 = WebDAV 同步设置时包含各平台 cookie；
       * 关 = 保持原有行为（cookie 不上传、不下载）。默认关（敏感凭证）。
       */
      'sync.webdav.syncCookies': boolean

      /**
       * 液态玻璃（vendored LiquidGlassKit 的 Metal 折射）开关，仅 iOS 14~26.1
       * 生效；关闭走系统磨砂。「玻璃不透明度」设置只对磨砂形态有意义。
       * **iOS 26.2+ 强制磨砂**（2026-09-30 定案）：开关从设置页隐藏、本值在
       * 各消费点与 LiquidGlass 组件内被门控（UIGlassEffect 白底/图底切换闪烁）。
       */
      'theme.liquidGlass': boolean

      /**
       * 内容玻璃（2026-10-04）：列表项、首页卡片等内容区也用玻璃背景。
       * 开 = ContentGlass 走 LiquidGlass；关 = 各组件原来的纯色背景。
       */
      'theme.glassContent': boolean

      /**
       * 浮动工具玻璃（2026-10-04）：多选模式悬浮条、「…」菜单等浮动工具 UI。
       * 开 = 玻璃；关 = 各组件原来的纯色背景。与内容区玻璃独立控制。
       */
      'theme.glassUtility': boolean

      /**
       * 上次动态背景 URL（P1-3 2026-10-06）：冷启动时先同步恢复，避免白屏闪烁。
       */
      'theme.lastDynamicBgPic': string

      /**
       * 「底边不透明度」（0~100）：全软件半透明底（排行榜按钮、设置页开关行与操作按钮、
       * 首页卡片等）的浓淡，统一作用于主题色令牌 c-primary-light-900-alpha-200。
       * 默认 80，与历史外观一致（主题自带 alpha 0.80）。
       */
      'theme.cardOpacity': number

      /**
       * 「Tab 栏距离」（0~100）：首页展开态迷你播放器与底部 Tab 栏之间的间距。
       * 100 = 当前间距（手机 12pt / iPad 横屏 8pt），0 = 贴在 Tab 栏上；
       * 与字体大小无关（间距为固定 token）。
       */
      'theme.tabBarDistance': number

      /**
       * 歌单封面列数：手机竖屏的歌单页封面网格 2 / 3 个一排（iPad 与大屏按宽度自适应）。
       * 默认 2（宽屏手机按宽度公式会误排 3 列，封面缩小且标题被截断，故默认两列）。
       */
      'theme.songlistColumns': 2 | 3

      // P2-2（2026-10-06）：补全缺失的类型声明（对照 defaultSetting.ts）。
      // 有索引签名 [key: string]: any 兜底，缺失不阻塞编译，此处为文档完整性。
      'common.isAutoTheme': boolean
      'common.isDarkMode': boolean
      'common.langId': any
      'common.apiSource': string
      'common.sourceNameType': string
      'common.shareType': string
      'common.isAgreePact': boolean
      'common.autoHidePlayBar': boolean
      'common.drawerLayoutPosition': string
      'common.showBackBtn': boolean
      'common.showExitBtn': boolean
      'common.wy_serpapi_key': string
      'common.isEnableLog': boolean
      'common.isEnableSyncLog': boolean
      'common.isEnableUserApiLog': boolean
      'common.isEnableWebDAVLog': boolean
      'common.isEnableSearchLog': boolean
      'common.isEnablePlayerLog': boolean
      'common.logMaxLines': number
      'common.bilibili_multi_page': boolean
      'common.quality_show_highest': boolean
      'common.navStatus': Record<string, any>
      'common.navOrder': any[]
      'common.navFlatOrder': any[]
      'common.sectionExpandedStatus': Record<string, any>
      'player.startupPushPlayDetailScreen': boolean
      'player.togglePlayMethod': string
      'player.playQuality': string
      'player.isSavePlayTime': boolean
      'player.volume': number
      'player.playbackRate': number
      'player.cacheLimit': number
      'player.timeoutExit': string
      'player.timeoutExitPlayed': boolean
      'player.isAutoCleanPlayedList': boolean
      'player.autoSkipOnError': boolean
      'player.soundEffect.enabled': boolean
      'player.soundEffect.preset': string
      'player.soundEffect.convolution.fileName': string
      'player.soundEffect.convolution.mainGain': number
      'player.soundEffect.convolution.sendGain': number
      'player.soundEffect.eq.31': number
      'player.soundEffect.eq.62': number
      'player.soundEffect.eq.125': number
      'player.soundEffect.eq.250': number
      'player.soundEffect.eq.500': number
      'player.soundEffect.eq.1000': number
      'player.soundEffect.eq.2000': number
      'player.soundEffect.eq.4000': number
      'player.soundEffect.eq.8000': number
      'player.soundEffect.eq.16000': number
      'player.isHandleAudioFocus': boolean
      'player.isEnableAudioPreload': boolean
      'player.cacheSize': string
      'player.isEnableAudioOffload': boolean
      'player.useNativeFlacPlayer': boolean
      'player.isShowLyricTranslation': boolean
      'player.isShowLyricRoma': boolean
      'player.isShowNotificationImage': boolean
      'player.isS2t': boolean
      'player.startupAutoPlay': boolean
      'playDetail.isCoverSpin': boolean
      'playDetail.style.miniLyricAlign': string
      'webdav.uploadResume': boolean
      'webdav.uploadChunked': boolean
      'webdav.uploadChunkSizeMB': number
      'sync.webdav.syncSettings': boolean
      'sync.webdav.lastSyncTimeSettings': number
      'sync.webdav.lastSyncSettingsHash': string
      'sync.webdav.syncUserApis': boolean
      'sync.webdav.lastSyncTimeUserApis': number
      'sync.webdav.lastSyncUserApisHash': string
      'theme.id': string
      'theme.lightId': string
      'theme.darkId': string
      'theme.dynamicBg': boolean
      'theme.blur': number
      'theme.fontShadow': boolean
      'theme.glassOpacity': number
      'theme.isLandscapeStretch': boolean
      'theme.customBgPicPath': string
      'theme.picOpacity': number
      'theme.subContainerOpacity': number
      'theme.lastDynamicBgPic': string
    }
  }
}

// 保持本文件为外部模块（否则 declare global 在全局脚本下非法，LX 命名空间扩充失效）
export {}
