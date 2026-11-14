import { memo, useMemo } from 'react'
import { View } from 'react-native'
import { usePlayMusicInfo, usePlayStreamInfo } from '@/store/player/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { getPlayQuality, buildSourceFallbackQualities } from '@/core/music/utils'
import { getFailureStrategyConfig } from '@/core/music/failureStrategy'
import Badge, { type BadgeType } from '@/components/common/Badge'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'

// 平台英文缩写映射（用户指定：酷狗=KG，网易=WY，企鹅=QQ，酷我=KW，咪咕=MG）
const SOURCE_ABBR: Record<string, string> = {
  kg: 'KG',
  wy: 'WY',
  tx: 'QQ',
  kw: 'KW',
  mg: 'MG',
  qs: 'QS',
  local: '本地',
  xm: 'XM',
  bilibili: 'BILI',
  gitee: 'GITEE',
}

function getQualityBadge(quality: string, t: (k: string) => string): { label: string, type: BadgeType } {
  switch (quality) {
    case 'master':
      return { label: t('quality_lossless_master'), type: 'vip' }
    case 'atmos_plus':
      return { label: t('quality_lossless_atmos_plus'), type: 'secondary' }
    case 'atmos':
      return { label: t('quality_lossless_atmos'), type: 'secondary' }
    case 'hires':
      return { label: t('quality_hires'), type: 'secondary' }
    case 'flac24bit':
      return { label: t('quality_lossless_24bit'), type: 'secondary' }
    case 'flac':
      return { label: t('quality_lossless'), type: 'sq' }
    case '320k':
      return { label: t('quality_high_quality'), type: 'hq' }
    case '192k':
      return { label: '192K', type: 'hq' }
    case '128k':
      return { label: '128K', type: 'tertiary' }
    default:
      return { label: quality.toUpperCase(), type: 'tertiary' }
  }
}

export default memo(() => {
  const t = useI18n()
  const playMusicInfo = usePlayMusicInfo()
  const playQuality = useSettingValue('player.playQuality')
  const streamInfo = usePlayStreamInfo()

  const musicInfo = playMusicInfo.musicInfo
    ? 'progress' in playMusicInfo.musicInfo
      ? playMusicInfo.musicInfo.metadata.musicInfo
      : playMusicInfo.musicInfo
    : null

  const abbr = musicInfo ? (SOURCE_ABBR[musicInfo.source] ?? musicInfo.source.toUpperCase()) : ''

  // 请求音质：按引擎首试口径——目标档位经 buildSourceFallbackQualities 取首项。
  // S-1：不能直接用 getPlayQuality 的返回值——它在全部可用档都高于偏好档时
  // 兜底返回 128k（该歌可能根本没有 128k），而引擎首试即最高可用档，徽章会
  // 显示虚假的「128K → SQ」升级箭头。目标档可用时首项即目标档，与原来一致。
  // qualityDirection 读当前配置（切歌时重新计算；同歌内改方向不重算，可接受）。
  const requestedQuality = useMemo(() => {
    if (!musicInfo || musicInfo.source === 'local') return null
    try {
      const target = getPlayQuality(playQuality as LX.Quality, musicInfo as LX.Music.MusicInfoOnline)
      const available = Object.keys((musicInfo as LX.Music.MusicInfoOnline).meta._qualitys ?? {}) as LX.Quality[]
      return buildSourceFallbackQualities(target, getFailureStrategyConfig().qualityDirection, available)[0] ?? target
    } catch {
      return null
    }
  }, [musicInfo, playQuality])

  const qualityBadge = requestedQuality ? getQualityBadge(requestedQuality, t) : null

  // 实际值（失败策略换源/换音质后）：箭头只在有变化时出现（平台变了或
  // 音质变了），未换源换音质时保持原样。取链完成前 actualSource/quality
  // 为 null（切歌时已清零），不显示上一首的残留实际值。
  // 2026-11-14：换平台后实际音质恒显示——用户要求格式「KG 128K → WY Master」：
  // 实际侧出现时，只要实际音质已知就一并显示；平台变了但音质没变时也显示
  // （如「KG 128K → WY 128K」），确认未降质。本地/下载歌 quality 为 null，
  // 不画音质徽章，只显示实际平台。
  const actualSourceDiffers = streamInfo.actualSource != null && musicInfo != null && streamInfo.actualSource !== musicInfo.source
  const actualQualityDiffers = streamInfo.quality != null && requestedQuality != null && streamInfo.quality !== requestedQuality
  const showActual = actualSourceDiffers || actualQualityDiffers
  const actualQualityBadge = showActual && streamInfo.quality != null ? getQualityBadge(streamInfo.quality, t) : null
  const actualAbbr = actualSourceDiffers ? (SOURCE_ABBR[streamInfo.actualSource!] ?? streamInfo.actualSource!.toUpperCase()) : ''

  if (!musicInfo) return null

  return (
    <View style={styles.row}>
      <Badge type="tertiary">{abbr}</Badge>
      {qualityBadge ? <Badge type={qualityBadge.type}>{qualityBadge.label}</Badge> : null}
      {showActual ? (
        <>
          <Text size={12} style={styles.arrow}>→</Text>
          {actualSourceDiffers ? <Badge type="tertiary">{actualAbbr}</Badge> : null}
          {actualQualityBadge ? <Badge type={actualQualityBadge.type}>{actualQualityBadge.label}</Badge> : null}
        </>
      ) : null}
    </View>
  )
})

const styles = createStyle({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: 4,
  },
  arrow: {
    marginHorizontal: 4,
    alignSelf: 'center',
  },
})
