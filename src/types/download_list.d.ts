// interface DownloadList {

// }

declare namespace LX {
  namespace Download {
    type DownloadTaskStatus = 'run' | 'waiting' | 'pause' | 'error' | 'completed'

    type FileExt = 'mp3' | 'flac' | 'wav' | 'ape'

    interface ProgressInfo {
      progress: number
      speed: string
      downloaded: number
      total: number
    }

    interface DownloadTaskActionBase<A> {
      action: A
    }
    interface DownloadTaskActionData<A, D> extends DownloadTaskActionBase<A> {
      data: D
    }
    type DownloadTaskAction<A, D = undefined> = D extends undefined
      ? DownloadTaskActionBase<A>
      : DownloadTaskActionData<A, D>

    type DownloadTaskActions =
      | DownloadTaskAction<'start'>
      | DownloadTaskAction<'complete'>
      | DownloadTaskAction<'refreshUrl'>
      | DownloadTaskAction<'statusText', string>
      | DownloadTaskAction<'progress', ProgressInfo>
      | DownloadTaskAction<
      'error',
      {
        error?: string
        message?: string
      }
      >

    interface ListItem {
      id: string
      isComplate: boolean
      status: DownloadTaskStatus
      statusText: string
      downloaded: number
      total: number
      progress: number
      speed: string
      metadata: {
        musicInfo: LX.Music.MusicInfoOnline
        url: string | null
        quality: LX.Quality
        ext: FileExt
        fileName: string
        filePath: string
        /** 实际下载平台（失败策略换源下载时与 musicInfo.source 不同）；未换源/旧任务无此字段 */
        actualSource?: LX.OnlineSource
      }
    }

    interface saveDownloadMusicInfo {
      list: ListItem[]
      addMusicLocationType: LX.AddMusicLocationType
    }
  }
}
