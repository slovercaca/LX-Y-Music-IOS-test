import apiSourceInfo from './api-source-info'
// import api_mobi_kw from './kw/api-mobi'
import settingState from '@/store/setting/state'
import bilibili from './bilibili'

const apiList = {
  // mobi_api_kw: api_mobi_kw,
}
const supportQuality = {}

for (const api of apiSourceInfo) {
  supportQuality[api.id] = api.supportQualitys
}

const getAPI = (source) => apiList[`${settingState.setting['common.apiSource']}_api_${source}`]

const apis = (source) => {
  if (source === 'bilibili') {
    return bilibili
  }
  // 低：user_api 模式未实现某源时此前返回 undefined，调用方以难懂的 TypeError 崩溃（内置路径会 throw 'Api is not found'）
  if (/^user_api/.test(settingState.setting['common.apiSource'])) {
    const userApi = global.lx.apis?.[source]
    if (userApi) return userApi
    throw new Error('Api is not found')
  }
  const api = getAPI(source)
  if (api) return api
  throw new Error('Api is not found')
}

export { apis, supportQuality }
