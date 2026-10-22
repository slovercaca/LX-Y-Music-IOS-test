import { useRef, useState, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react'
import kwTipSearch from '@/utils/musicSdk/kw/tipSearch'
import txTipSearch from '@/utils/musicSdk/tx/tipSearch'
import kgTipSearch from '@/utils/musicSdk/kg/tipSearch'
import wyTipSearch from '@/utils/musicSdk/wy/tipSearch'
import mgTipSearch from '@/utils/musicSdk/mg/tipSearch'

// 搜索联想（S-N2）：各源的 tipSearch 模块（index.js 里大多被注释未导出，这里直引模块）
// 任一源不可用/失败时静默无联想，不影响回车搜索
const TIP_SEARCH_MAP: Record<string, { search: (str: string) => Promise<string[]> }> = {
  kw: kwTipSearch as any,
  tx: txTipSearch as any,
  kg: kgTipSearch as any,
  wy: wyTipSearch as any,
  mg: mgTipSearch as any,
}
import { ScrollView, TouchableOpacity, View } from 'react-native'

// import music from '@/utils/musicSdk'
import { designSpacing } from '@/theme/DesignTokens'
// import InsetShadow from 'react-native-inset-shadow'
import SearchInput, { type SearchInputType, type SearchInputProps } from './SearchInput'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { useStatusbarHeight } from '@/store/common/hook'
import { useI18n } from '@/lang'
import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import { type Source as MusicSource } from '@/store/search/music/state'
import { type Source as SonglistSource } from '@/store/search/songlist/state'

type Sources = Readonly<Array<MusicSource | SonglistSource>>

export interface HeaderBarProps {
  sources: Sources
  source: MusicSource | SonglistSource
  onSourceChange: (source: MusicSource | SonglistSource) => void
  onSearch: SearchInputProps['onSubmit']
  onCancelSearch: () => void
}

export interface HeaderBarType {
  setText: SearchInputType['setText']
  focus: SearchInputType['focus']
  blur: SearchInputType['blur']
}

export default forwardRef<HeaderBarType, HeaderBarProps>(
  ({
    sources,
    source,
    onSourceChange,
    onSearch,
    onCancelSearch,
  }, ref) => {
    const searchInputRef = useRef<SearchInputType>(null)
    const theme = useTheme()
    const statusBarHeight = useStatusbarHeight()
    const t = useI18n()
    // 输入框当前是否有内容：空输入时不显示「取消」（用户要求：没有输入任何内容时不要
    // 多出一个可以点的取消）；输入内容后出现，点它清空并复位搜索。
    const [hasText, setHasText] = useState(false)
    // 搜索联想词（S-N2）：输入防抖 300ms 后向当前平台取词，点击即搜
    const [tips, setTips] = useState<string[]>([])
    const tipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const tipGenRef = useRef(0)

    useEffect(() => {
      setTips([])
    }, [source])

    const handleChangeText = useCallback<SearchInputProps['onChangeText']>((text) => {
      const kw = text.trim()
      setHasText(kw.length > 0)
      if (tipTimerRef.current) clearTimeout(tipTimerRef.current)
      if (!kw) {
        setTips([])
        return
      }
      const gen = ++tipGenRef.current
      tipTimerRef.current = setTimeout(() => {
        const tipSearch = TIP_SEARCH_MAP[source as string]
        if (!tipSearch?.search) {
          setTips([])
          return
        }
        void tipSearch.search(kw)
          .then((list) => {
            if (gen !== tipGenRef.current) return
            setTips(Array.isArray(list) ? [...new Set(list.filter(Boolean))].slice(0, 8) : [])
          })
          .catch(() => {
            if (gen === tipGenRef.current) setTips([])
          })
      }, 300)
    }, [source])

    const handleSelectTip = useCallback((tip: string) => {
      setTips([])
      onSearch(tip)
    }, [onSearch])

    useImperativeHandle(
      ref,
      () => ({
        setText(text) {
          // 父级预填/清空（例如从歌单菜单「搜索同名歌曲」、返回时复位）也要同步取消按钮
          setHasText(text.trim().length > 0)
          searchInputRef.current?.setText(text)
        },
        focus() {
          searchInputRef.current?.focus()
        },
        blur() {
          searchInputRef.current?.blur()
        },
      }),
      [],
    )

    return (
      <View style={[styles.container, { paddingTop: Math.max(designSpacing.sm, statusBarHeight - designSpacing.md) }]}>
        <View style={styles.openHeader}>
          <View
            style={{
              ...styles.searchBar,
              flexShrink: 1,
              backgroundColor: theme['c-primary-light-900-alpha-300'],
              borderColor: theme['c-border-background'],
            }}
          >
            <View style={styles.searchIcon}>
              <Icon name="search-2" size={17} color={theme['c-font-label']} />
            </View>
            <SearchInput
              ref={searchInputRef}
              onChangeText={handleChangeText}
              onSubmit={onSearch}
            />
          </View>
          {hasText ? (
            <Text style={styles.cancelButton} color={theme['c-primary']} onPress={onCancelSearch}>
              取消
            </Text>
          ) : null}
        </View>
        {hasText && tips.length > 0 ? (
          <View style={{ ...styles.tipList, borderColor: theme['c-border-background'], backgroundColor: theme['c-content-background'] }}>
            {tips.map((tip) => (
              <TouchableOpacity key={tip} style={styles.tipRow} onPress={() => { handleSelectTip(tip) }}>
                <Icon name="search-2" size={13} color={theme['c-font-label']} />
                <Text size={14} color={theme['c-font']} numberOfLines={1} style={styles.tipText}>{tip}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
        <View style={styles.platformHeader}>
          <Text size={17} color={theme['c-font']}>搜索平台</Text>
          <Text size={13} color={theme['c-primary']}>{t(`source_${source}`)}</Text>
        </View>
        <ScrollView
          style={styles.platformScroll}
          contentContainerStyle={styles.platformContent}
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
        >
          {sources.map((sourceId) => {
            const isActive = sourceId == source
            return (
              <TouchableOpacity
                key={sourceId}
                style={{
                  ...styles.platformItem,
                  backgroundColor: isActive
                    ? theme['c-primary']
                    : theme['c-primary-light-900-alpha-200'],
                }}
                onPress={() => {
                  onSourceChange(sourceId)
                }}
              >
                <Text
                  size={15}
                  color={isActive ? theme['c-primary-light-1000'] : theme['c-font']}
                >
                  {t(`source_${sourceId}`)}
                </Text>
              </TouchableOpacity>
            )
          })}
        </ScrollView>
      </View>
    )
  },
)

const styles = createStyle({
  container: {
    zIndex: 2,
    marginBottom: designSpacing.xs,
  },
  tipList: {
    marginHorizontal: designSpacing.lg,
    marginBottom: designSpacing.sm,
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  tipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  tipText: {
    flexShrink: 1,
  },
  openHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: designSpacing.lg,
    // 与搜索框的间距挂在**行**上（原来挂在搜索框的 marginBottom 上：那样搜索框盒高
    // 比文字高 8pt，行内居中的「取消」看起来比搜索框中心低 4pt，用户反馈偏下）。
    paddingBottom: designSpacing.sm,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    marginRight: designSpacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    zIndex: 2,
  },
  searchIcon: {
    paddingLeft: designSpacing.sm,
    paddingRight: 4,
    justifyContent: 'center',
  },
  cancelButton: {
    fontWeight: '700',
  },
  platformHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: designSpacing.lg,
    marginTop: designSpacing.xs,
  },
  platformScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  platformContent: {
    paddingHorizontal: designSpacing.lg,
    paddingVertical: designSpacing.sm,
  },
  platformItem: {
    minHeight: 38,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: designSpacing.md,
    marginRight: designSpacing.sm,
    borderRadius: 999,
  },
})
