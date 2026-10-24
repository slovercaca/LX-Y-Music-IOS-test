import { memo } from 'react'

import Section from '../../components/Section'
import IsWriteLyrics from './IsWriteLyrics'
import IsWriteRomaLyrics from './IsWriteRomaLyrics'
import IsWriteEmbedLyrics from './IsWriteEmbedLyrics'
import IsWriteTags from './IsWriteTags'
import IsWriteCover from './IsWriteCover'
import FileNameFormat from './FileNameFormat'
import { useI18n } from '@/lang'
import SubTitle from '../../components/SubTitle'
import DownloadPath from '@/screens/Home/Views/Setting/settings/Download/DownloadPath.tsx'
import IsWriteAlias from '@/screens/Home/Views/Setting/settings/Download/IsWriteAlias.tsx'
import DownloadQuality from '@/screens/Home/Views/Setting/settings/Download/DownloadQuality.tsx'
import IsEnable from './IsEnable'

export default memo(() => {
  const t = useI18n()

  return (
    <Section sectionId="setting_download">
      {/* 中：总开关此前被注释掉但逻辑仍依赖它——download.enable 为 false
          （旧版/备份导入/同步带入）时每次下载都被拦并提示「去下载设置打开」，
          而设置页根本没有这个开关，无任何途径恢复。恢复渲染。 */}
      <IsEnable />
      <DownloadPath />
      <DownloadQuality />
      <SubTitle title={t('setting_download_options_title')}>
        <IsWriteTags />
        <IsWriteAlias />
        <IsWriteLyrics />
        <IsWriteRomaLyrics />
        <IsWriteEmbedLyrics />
        <IsWriteCover />
      </SubTitle>
      <FileNameFormat />
    </Section>
  )
})
