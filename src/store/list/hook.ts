import { useEffect, useState } from 'react'
import state, { type InitState } from './state'
import { getListMusics } from '@/core/list'

export const useMyList = () => {
  const [lists, setList] = useState(state.allList)
  lists[0].name = global.i18n.t('list_name_default')
  lists[1].name = global.i18n.t('list_name_love')

  useEffect(() => {
    const handleConfigUpdate = (keys: Array<keyof LX.AppSetting>) => {
      if (!keys.includes('common.langId')) return
      setList((lists) => {
        lists[0].name = global.i18n.t('list_name_default')
        lists[1].name = global.i18n.t('list_name_love')
        return [...lists]
      })
    }
    global.state_event.on('mylistUpdated', setList)
    global.state_event.on('configUpdated', handleConfigUpdate)
    return () => {
      global.state_event.off('mylistUpdated', setList)
      global.state_event.off('configUpdated', handleConfigUpdate)
    }
  }, [])

  return lists
}

export const useActiveListId = () => {
  const [id, setId] = useState(state.activeListId)

  useEffect(() => {
    global.state_event.on('mylistToggled', setId)
    return () => {
      global.state_event.off('mylistToggled', setId)
    }
  }, [])

  return id
}

export const useMusicList = () => {
  const [list, setList] = useState<LX.List.ListMusics>([])

  useEffect(() => {
    const handleToggle = (activeListId: string) => {
      void getListMusics(activeListId).then((list) => {
        // P1（2026-10-06）：过期异步覆盖防护。快速连切 A→B 时，
        // A 的读取可能晚于 B 返回，无条件 setList 会显示 A 的歌但当前是 B。
        if (activeListId !== state.activeListId) return
        setList([...list])
      })
    }
    const handleChange = (ids: string[]) => {
      if (!ids.includes(state.activeListId)) return
      const requestId = state.activeListId
      void getListMusics(requestId).then((list) => {
        // P1（2026-10-06）：同上，返回时校验 id 未变
        if (requestId !== state.activeListId) return
        setList([...list])
      })
    }
    global.state_event.on('mylistToggled', handleToggle)
    global.app_event.on('myListMusicUpdate', handleChange)

    handleToggle(state.activeListId)

    return () => {
      global.state_event.off('mylistToggled', handleToggle)
      global.app_event.off('myListMusicUpdate', handleChange)
    }
  }, [])

  return list
}

export const useMusicExistsList = (list: LX.List.MyListInfo, musicInfo: LX.Music.MusicInfo) => {
  const [isExists, setExists] = useState(false)

  useEffect(() => {
    // 存疑修复：快速切歌/切单时旧请求后到会把「已存在」标错；卸载后 setState 亦无谓
    let ignore = false
    void getListMusics(list.id).then((musics) => {
      if (ignore) return
      setExists(musics.some((s) => s.id == musicInfo.id))
    })
    return () => { ignore = true }
  }, [list.id, musicInfo.id])

  return isExists
}

export const useListFetching = (listId: string) => {
  const [fetching, setFetching] = useState(!!state.fetchingListStatus[listId])

  useEffect(() => {
    // 中：切换 listId 时先按新 id 同步一次当前状态并重置 prevStatus——
    // 此前只换订阅不换值，加载指示会永久卡在旧歌单的状态上
    setFetching(!!state.fetchingListStatus[listId])
    let prevStatus = state.fetchingListStatus[listId]
    const handleUpdate = (status: InitState['fetchingListStatus']) => {
      let currentStatus = status[listId]
      if (currentStatus == null || prevStatus == status[listId]) return
      setFetching((prevStatus = currentStatus))
    }
    global.state_event.on('fetchingListStatusUpdated', handleUpdate)
    return () => {
      global.state_event.off('fetchingListStatusUpdated', handleUpdate)
    }
  }, [listId])

  return fetching
}
