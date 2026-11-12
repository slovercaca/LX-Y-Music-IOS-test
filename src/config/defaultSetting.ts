const defaultSetting: LX.AppSetting = {
  version: '2.0',
  'version.autoCheckUpdate': true,
  'common.isAutoTheme': false,
  'common.isDarkMode': false,
  'common.langId': null,
  'common.apiSource': '',
  'common.sourceNameType': 'alias',
  'common.shareType': 'system',
  // 默认 false：首次安装启动时弹出协议弹窗（PactModal），同意后写入 true 不再弹出
  'common.isAgreePact': false,
  'common.autoHidePlayBar': true,
  'common.drawerLayoutPosition': 'left',
  // 「启用竖屏首页横向滚动」设置已移除：首页固定，仅通过底部 tab / 侧边栏切换页面。
  // 该键不再被读取；旧安装里残留的 true 值为死数据，无任何代码引用。
  'common.allowProgressBarSeek': true,
  'common.showBackBtn': false,
  'common.showExitBtn': false,
  'common.wy_cookie': '',
  'common.wy_serpapi_key': '',
  'common.tx_cookie': '',
  'common.kg_cookie': '',
  'common.yt_cookie': '',
  'common.isEnableLog': true,
  'common.isEnableSyncLog': false,
  'common.isEnableUserApiLog': false,
  'common.isEnableWebDAVLog': false,
  'common.isEnableSearchLog': false,
  'common.isEnablePlayerLog': false,
  // 错误日志查看器的显示阈值（条）：原来只是页面内 useState，离开设置页就回到 2000，
  // 用户改过的值不保存。
  'common.logMaxLines': 2000,
  'common.bilibili_multi_page': false,
  'common.quality_show_highest': false,

  'common.navStatus': {
    nav_discovery: true,
    nav_songlist: true,
    nav_top: true,
    nav_love: true,
    nav_daily_rec: true,
    nav_my_playlist: true,
    nav_followed_artists: true,
    nav_subscribed_albums: true,
    nav_webdav: true,
    nav_tx_daily_rec: true,
    nav_play_history: true,
  },

  'common.navOrder': [
    'nav_discovery',
    'nav_search',
    'nav_play_history',
    'nav_songlist',
    'nav_top',
    'nav_love',
    'nav_daily_rec',
    'nav_kg_daily_rec',
    'nav_tx_daily_rec',
    'nav_kg_playlist',
    'nav_tx_playlist',
    'nav_followed_artists',
    'nav_subscribed_albums',
    'nav_my_playlist',
    'nav_webdav',
    'nav_local_download',
    'nav_setting',
  ],

  'common.navFlatOrder': [],

  // 推荐页平台按钮顺序（平台 id 数组）。空数组 = 按默认顺序显示；
  // 排在第一位的平台为进入推荐页时的默认选中平台。
  'common.discoveryPlatformOrder': [],

  'common.sectionExpandedStatus': {
    setting_player: true,
    setting_download: true,
    setting_theme: true,
    setting_sync: true,
    setting_search: true,
    setting_list: true,
    setting_basic: true,
    setting_other: true,
    setting_backup: true,
    setting_about: true,
    setting_version: true,
    setting_basic_nav_menu: true,
    setting_basic_source_user_api: true,
    setting_failure_strategy: true,
  },

  'player.startupPushPlayDetailScreen': false,
  'player.togglePlayMethod': 'listLoop',
  'player.playQuality': '320k',
  'player.isSavePlayTime': true,
  'player.volume': 1,
  'player.playbackRate': 1,
  'player.cacheLimit': 0,
  'player.timeoutExit': '',
  'player.timeoutExitPlayed': true,
  // 2026-10-18：离线模式。开启后播放时优先使用本地已下载文件，封面优先用本地缓存
  'player.offlineMode': false,
  // 2026-11-12：歌词/封面缓存策略（设置：基础设置）。总开关关 = 不进行任何
  // 歌词封面缓存，在线获取的只在内存里显示一次、用完即删；分开关分别控制
  // 歌词（lrc/）与封面（picture/）的自动落盘。旧键 player.autoCacheOnlinePic
  // 已由 player.mediaCachePic 取代（见 config/setting.ts 的迁移）。
  'player.mediaCacheEnabled': true,
  'player.mediaCacheLyric': true,
  'player.mediaCachePic': true,
  'player.isAutoCleanPlayedList': false,
  'player.autoSkipOnError': true,
  'player.soundEffect.enabled': false,
  'player.soundEffect.preset': 'none',
  'player.soundEffect.convolution.fileName': '',
  'player.soundEffect.convolution.mainGain': 10,
  'player.soundEffect.convolution.sendGain': 0,
  'player.soundEffect.eq.31': 0,
  'player.soundEffect.eq.62': 0,
  'player.soundEffect.eq.125': 0,
  'player.soundEffect.eq.250': 0,
  'player.soundEffect.eq.500': 0,
  'player.soundEffect.eq.1000': 0,
  'player.soundEffect.eq.2000': 0,
  'player.soundEffect.eq.4000': 0,
  'player.soundEffect.eq.8000': 0,
  'player.soundEffect.eq.16000': 0,
  'player.isHandleAudioFocus': true,
  'player.isEnableAudioPreload': false,
  'player.cacheSize': '1024',
  'player.isEnableAudioOffload': false,
  'player.useNativeFlacPlayer': false,
  'player.isShowLyricTranslation': true,
  'player.isShowLyricRoma': false,
  'player.isShowNotificationImage': true,
  'player.isS2t': true,
  // 启动软件自动播放（前提：启动时恢复出一首「暂停中」的歌曲）
  'player.startupAutoPlay': false,
  // 蓝牙歌词：开 = 把当前歌词行推送到系统媒体信息（控制中心 / 锁屏 / 车机 / 蓝牙音箱
  // 读的都是同一份 MPNowPlayingInfoCenter，artist 字段承载歌词行）；
  // 关 = 只显示歌名·歌手，不推送歌词行。默认开，保持既有行为。
  'player.isShowBluetoothLyric': true,

  // 2026-11-12：失败策略（设置：失败策略）。下载/播放取链失败时，按 order
  // 依次自动重试：platform = 切换平台重试（按 platformPriority 顺序逐个试
  // 其它平台的同名歌曲）；quality = 换音质重试（按 qualityDirection 从首选
  // 档位一档一档往下降/往上升）；source = 更换音源重试（临时借用另一自定义
  // 音源脚本试一次，事后自动切回原音源；只有 ≥2 个 user_api 脚本时才生效）。
  // 429 限流直通、不进策略循环；策略跑完仍失败才按原有终态处理（播放跳歌 /
  // 下载标错）。order / platformPriority / stepEnabled 三个非原始值键已登记
  // 在 config/setting.ts 的 DEEP_KEYS 里，否则 updateSetting 会静默丢弃。
  'failureStrategy.enabled': true,
  'failureStrategy.order': ['platform', 'quality', 'source'],
  'failureStrategy.stepEnabled': { platform: true, quality: true, source: true },
  'failureStrategy.platformPriority': ['kw', 'kg', 'tx', 'wy', 'mg'],
  'failureStrategy.qualityDirection': 'down',

  'playDetail.isCoverSpin': false,
  'playDetail.style.align': 'center',
  'playDetail.style.miniLyricAlign': 'center',
  'playDetail.style.coverSize': 100,
  'playDetail.style.coverShape': 'circle',
  'playDetail.vertical.style.lrcFontSize': 200,
  'playDetail.horizontal.style.lrcFontSize': 220,
  'playDetail.isShowLyricProgressSetting': true,

  'search.isShowHotSearch': false,
  'search.isShowHistorySearch': true,
  'search.enabledSources': { kw: true, kg: true, tx: true, wy: true, mg: true, bilibili: true, all: true },

  'list.isClickPlayList': false,
  'list.isShowSource': true,
  'list.isShowAlbumName': true,
  'list.isShowInterval': true,
  'list.isSaveScrollLocation': true,
  'list.addMusicLocationType': 'top',
  'list.isAutoSaveDailyRec': true,
  'list.myListVisibility': {},
  'list.isShowCover': true,

  'menu.playLater': true,
  'menu.addTo': true,
  'menu.dislike': true,

  'menu.moveTo': true,
  'menu.changePosition': true,
  'menu.changeSource': true,
  'artistDetail.albumViewMode': 'grid',

  'download.enable': true,
  'download.path': '',
  'download.fileName': '歌名 - 歌手',
  'download.writeLyric': false,
  'download.writeRomaLyric': false,
  'download.writeEmbedLyric': true,
  'download.writeMetadata': true,
  'download.writePicture': true,
  'download.writeAlias': false,
  'download.quality': '128k',
  // 同时下载数量（2026-11-12）：下载队列 worker 数，1-6，默认 3。
  // 1 = 旧行为（严格串行一次下一首）；改大后排队的任务会立即并行启动。
  'download.concurrency': 3,

  'sync.enable': false,
  'sync.webdav.enable': false,
  'sync.webdav.syncLists': false,
  'sync.webdav.syncPlayHistory': true,
  'sync.webdav.syncDownloadTasks': true,
  'sync.webdav.url': '',
  'sync.webdav.username': '',
  'sync.webdav.password': '',
  'webdav.downloadPath': '',
  // 上传并发线程数（2026-10-05）：上传 tab 可调，1-6，默认 2
  'webdav.uploadConcurrency': 2,
  // S-8：'webdav.uploadResume' 已删除（见 UploadTab）——零逻辑消费方，
  // 存储残留旧键由 mergeSetting 的未知键丢弃规则自动清除。
  // 分块上传（Test-v2）：大文件切块逐块传，单块失败只重传该块。默认开。
  'webdav.uploadChunked': true,
  // 分块大小 MB（Test-v2）：默认 5
  'webdav.uploadChunkSizeMB': 5,
  // 上传看门狗超时秒数（2026-10-06）：无进度超过此秒数则中断重试。
  // 0 = 关闭看门狗（永不中断）。默认 15。
  'webdav.uploadStallTimeoutSec': 15,
  // 封面歌词来源（2026-10-04）：'file' = 从歌曲文件（同目录同名/通用封面、内嵌标签），
  // 'online' = 从云端插件（按歌名/歌手在线匹配）。默认 file。
  'webdav.mediaSource': 'file',
  'sync.webdav.path': '/LX_Music/',
  'sync.webdav.lastSyncTimeLists': 0,
  'sync.webdav.failoverEnabled': false,
  'sync.webdav.failoverNotify': true,
  // 同步平台 cookie（2026-10-04）：默认关。开 = WebDAV 同步设置时包含各平台
  // cookie（common.wy_cookie / yt / tx / kg），换设备后无需重新登录；
  // 关 = 保持原有行为（cookie 不上传、不下载）。
  // 注意：cookie 是敏感凭证，开启后会以明文存放在你的 WebDAV 服务器上。
  'sync.webdav.syncCookies': false,
  // 自动同步设置（2026-10-06）：默认开。开 = 自动同步时顺带同步设置（settings.json），
  // 本地改设置后自动上传，云端更新后自动下载（last-write-wins）。
  'sync.webdav.syncSettings': true,
  'sync.webdav.lastSyncTimeSettings': 0,
  'sync.webdav.lastSyncSettingsHash': '',
  // 自动同步自定义音源/插件（2026-10-06）：默认开。开 = 自动同步时顺带同步
  // 自定义音源（user_apis.json），本地装插件后自动上传，云端更新后自动下载。
  'sync.webdav.syncUserApis': true,
  'sync.webdav.lastSyncTimeUserApis': 0,
  'sync.webdav.lastSyncUserApisHash': '',

  'theme.id': 'green',
  'theme.lightId': 'green',
  'theme.darkId': 'black',
  'theme.dynamicBg': true,
  'theme.blur': 18,
  'theme.fontShadow': false,
  'theme.glassOpacity': 40,
  // 「底边不透明度」（0~100）：全软件半透明底（排行榜按钮 / 设置页开关行、操作按钮 /
  // 首页卡片等）统一取自主题色令牌 c-primary-light-900-alpha-200，这里给出它的基础浓度。
  // 80 = 与历史外观一致（主题自带 alpha 0.80）。
  'theme.cardOpacity': 80,
  // 「Tab 栏距离」（0~100）：首页展开态迷你播放器与底部 Tab 栏之间的间距，
  // 100 = 当前间距（手机 12pt / iPad 横屏 8pt），0 = 贴在 Tab 栏上。
  // 与字体大小无关（间距是固定 token），滑杆只在 0~当前值之间缩放。
  'theme.tabBarDistance': 100,
  // 液态玻璃（vendored LiquidGlassKit Metal 折射）开关，仅 iOS 14~26.1 生效；
  // 关闭走系统磨砂。「玻璃不透明度」设置只对磨砂形态有意义（见 ThemeScreen）。
  // 26.2+ 强制磨砂（开关已隐藏、消费点门控，2026-09-30 定案）
  'theme.liquidGlass': true,
  // 内容玻璃（2026-10-04）：列表项、首页卡片等内容区也用玻璃背景（与 tab 栏/
  // 弹窗同一套 LiquidGlass）。默认开；关 = 恢复各组件原来的纯色背景。
  // 性能说明：液态模式下每个玻璃都是持续渲染的 Metal 视图，长列表同时挂载约
  // 十几个（虚拟列表只渲染可见行），磨砂模式则是系统合成、成本可忽略。
  // 若低端机卡顿，关掉本开关即可。
  'theme.glassContent': true,
  // 浮动工具玻璃（2026-10-04）：多选模式悬浮条、「…」菜单等浮动工具 UI 的玻璃开关。
  // 与内容区玻璃独立，默认开；关 = 恢复各组件原来的纯色背景。
  'theme.glassUtility': true,
  'theme.isLandscapeStretch': false,
  // P1-3（2026-10-06）：上次动态背景 URL，冷启动时先同步恢复，避免白屏闪烁。
  // 原先不在 defaults 里，靠 updateSetting 全量写入才持久化，属定时炸弹。
  'theme.lastDynamicBgPic': '',
  // 歌单页封面列数（手机竖屏）：2 / 3 个一排，默认 2。
  // iPad 与大屏仍在 List.tsx 里按可用宽度自适应多列。
  'theme.songlistColumns': 2,
  'theme.customBgPicPath': '',
  'theme.picOpacity': 76,
  'theme.subContainerOpacity': 50,
}

// 新年彩蛋：1-2 月【新安装】的默认主题为新年主题（仅默认值，用户改过即以用户设置
// 为准，不会覆盖已有用户的选择）
if (new Date().getMonth() < 2) {
  defaultSetting['theme.id'] = 'happy_new_year'
}

export default defaultSetting
