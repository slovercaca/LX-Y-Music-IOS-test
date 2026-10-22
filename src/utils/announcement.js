// 公告数据（本地固定，不联网）
//
// 原实现从 GitHub 远程 announcement.json 拉取，但远程已换成「多页 + 分页按钮」的新格式
// （content 是数组、按钮改用 action 描述行为），与本 App 的单页公告弹窗不兼容；公告内容也
// 不再需要联网下发，因此改为固定维护在本文件里，取数据不再发任何网络请求。
//
// 展示时机：首次安装启动、且用户签署「许可协议」之后弹一次（见 core/init 的注释与
// PactModal 的 scheduleAnnouncementCheckAfterPact）。
// 「只弹一次」由 announcementId 与本地已展示 ID 比对保证（见 core/announcement）。
// 修改内容时请一并修改 announcementId，否则已经看过旧公告的机器不会再弹新内容。

// ===== 调试开关 =====
// DEBUG_MODE = true: 调试模式，忽略「本地已展示 ID」比对，每次启动都弹
// DEBUG_MODE = false: 正常模式，只在本地没有展示过该 announcementId 时弹
export const DEBUG_MODE = false

const localAnnouncement = {
  // 内容有更新时改这里，用于让已看过旧公告的机器也能看到新公告
  announcementId: 'local-welcome-sea-20261022-v2',
  title: '🎉 欢迎使用 LX-Y Music（Sea 二改版）',
  content: [
    '本软件完全免费且开源，如果你是付费购买的，请注意辨别。',
    '',
    '本版本基于 LX-Y Music 二次修改：液态玻璃界面、WebDAV 音乐库、下载与本地文件统一管理（music / lrc / picture）、离线模式等。',
    '',
    '在「设置 → 播放」中可开启封面自动缓存；本地歌曲在「本地与下载」页统一管理。祝听歌愉快。',
  ].join('\n'),
  buttons: [
    {
      text: '关闭',
      enabled: true,
      url: '',
    },
  ],
}

export const getAnnouncementInfo = async() => {
  // 每次都返回新对象，避免调用方改到共享数据
  return {
    ...localAnnouncement,
    buttons: localAnnouncement.buttons.map((btn) => ({ ...btn })),
  }
}
