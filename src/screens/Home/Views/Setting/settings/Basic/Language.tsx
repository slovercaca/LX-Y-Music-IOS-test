import { memo, useMemo } from 'react'

import { StyleSheet, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import CheckBox from '@/components/common/CheckBox'
import type { I18n } from '@/lang'
import { useI18n, langList } from '@/lang'
import { setLanguage } from '@/core/common'
import { useSettingValue } from '@/store/setting/hook'

const useActive = (id: I18n['locale']) => {
  const activeLangId = useSettingValue('common.langId')
  const isActive = useMemo(() => activeLangId == id, [activeLangId, id])
  return isActive
}

const Item = ({ id, name }: { id: I18n['locale'], name: string }) => {
  const isActive = useActive(id)
  // const [toggleCheckBox, setToggleCheckBox] = useState(false)
  return (
    <CheckBox
      marginRight={8}
      check={isActive}
      label={name}
      onChange={() => {
        setLanguage(id)
      }}
      need
    />
  )
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()

  return (
    <SubTitle title={t('setting_basic_lang')}>
      <View style={styles.list}>
        {langList.map(({ locale, name }) => (
          <Item name={name} id={locale} key={locale} />
        ))}
      </View>
      {langList.length <= 1 ? (
        <Text size={12} color={theme['c-font-label']} style={styles.note}>
          目前仅提供简体中文
        </Text>
      ) : null}
    </SubTitle>
  )
})

const styles = StyleSheet.create({
  list: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  note: {
    marginTop: 6,
  },
})
