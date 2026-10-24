import state, { type InitState } from './state'

export default {
  setAnnouncementInfo(info: Partial<InitState>) {
    if (info.showModal !== undefined) state.showModal = info.showModal
    if (info.announcementInfo !== undefined) state.announcementInfo = info.announcementInfo
    if (info.localAnnouncementId !== undefined) state.localAnnouncementId = info.localAnnouncementId
    if (info.status !== undefined) state.status = info.status
    global.state_event.announcementUpdated({ ...state })
  },
  setShowModal(visible: boolean) {
    state.showModal = visible
    // 低：此前只改 state 不广播，hook 副本会过期（与 setAnnouncementInfo 对齐）
    global.state_event.announcementUpdated({ ...state })
  },
  setLocalAnnouncementId(id: string | null) {
    state.localAnnouncementId = id
    global.state_event.announcementUpdated({ ...state })
  },
}
