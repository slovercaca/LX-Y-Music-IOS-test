import { compareVer } from '@/utils'

export default (setting: any): Partial<LX.AppSetting> => {
  setting = { ...setting }

  if (compareVer(setting.version as string, '2.0') < 0) {
    setting['player.togglePlayMethod'] = setting.player?.togglePlayMethod
    setting['player.isSavePlayTime'] = setting.player?.isSavePlayTime
    setting['player.timeoutExit'] = setting.player?.timeoutExit
    setting['player.timeoutExitPlayed'] = setting.player?.timeoutExitPlayed
    setting['player.isHandleAudioFocus'] = setting.player?.isHandleAudioFocus
    setting['player.isShowLyricTranslation'] = setting.player?.isShowLyricTranslation
    setting['player.isShowLyricRoma'] = setting.player?.isShowLyricRoma
    setting['player.isShowNotificationImage'] = setting.player?.isShowNotificationImage
    setting['player.isS2t'] = setting.player?.isS2t
    // P1-2（2026-10-06）：运行时读的是 playDetail.vertical/horizontal，
    // 原先写到 playDetail.portrait/landscape 的键从未被读取，歌词字号迁移失效。
    setting['playDetail.vertical.style.lrcFontSize'] = setting.player?.portrait?.style?.lrcFontSize
    setting['playDetail.horizontal.style.lrcFontSize'] =
      setting.player?.landscape?.style?.lrcFontSize
    setting['list.isClickPlayList'] = setting.list?.isClickPlayList
    setting['list.isShowSource'] = setting.list?.isShowSource
    setting['list.isSaveScrollLocation'] = setting.list?.isSaveScrollLocation
    setting['list.addMusicLocationType'] = setting.list?.addMusicLocationType
    setting['common.themeId'] = setting.themeId
    setting['common.isAutoTheme'] = setting.isAutoTheme
    setting['common.langId'] = setting.langId
    setting['common.apiSource'] = setting.apiSource
    setting['common.sourceNameType'] = setting.sourceNameType
    setting['common.shareType'] = setting.shareType
    setting['common.isAgreePact'] = setting.isAgreePact
    setting['sync.enable'] = setting.sync?.enable
    setting['theme.id'] = setting.themeId
  }

  return setting
}
