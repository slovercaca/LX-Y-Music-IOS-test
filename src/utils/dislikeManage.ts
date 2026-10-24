import { SPLIT_CHAR } from '@/config/constant'
import { getDislikeListRules } from './data'

const dislikeInfo: LX.Dislike.DislikeInfo = {
  names: new Set(),
  musicNames: new Set(),
  singerNames: new Set(),
  rules: '',
}

export const getDislikeInfo = async() => {
  updateDislikeInfo(await getDislikeListRules())
  return dislikeInfo
}

const updateDislikeInfo = (rules: string) => {
  dislikeInfo.names.clear()
  dislikeInfo.musicNames.clear()
  dislikeInfo.singerNames.clear()
  const list: string[] = []
  for (const item of rules.split('\n')) {
    if (!item) continue
    let [name, singer] = item.split(SPLIT_CHAR.DISLIKE_NAME)
    if (name) {
      name = name
        .replaceAll(SPLIT_CHAR.DISLIKE_NAME, SPLIT_CHAR.DISLIKE_NAME_ALIAS)
        .toLocaleLowerCase()
        .trim()
      if (singer) {
        singer = singer
          .replaceAll(SPLIT_CHAR.DISLIKE_NAME, SPLIT_CHAR.DISLIKE_NAME_ALIAS)
          .toLocaleLowerCase()
          .trim()
        const rule = `${name}${SPLIT_CHAR.DISLIKE_NAME}${singer}`
        dislikeInfo.names.add(rule)
        list.push(rule)
      } else {
        dislikeInfo.musicNames.add(name)
        list.push(name)
      }
    } else if (singer) {
      singer = singer
        .replaceAll(SPLIT_CHAR.DISLIKE_NAME, SPLIT_CHAR.DISLIKE_NAME_ALIAS)
        .toLocaleLowerCase()
        .trim()
      dislikeInfo.singerNames.add(singer)
      list.push(`${SPLIT_CHAR.DISLIKE_NAME}${singer}`)
    }
  }
  dislikeInfo.rules = Array.from(new Set(list)).join('\n')
}

export const addDislikeInfo = async(infos: LX.Dislike.DislikeMusicInfo[]) => {
  updateDislikeInfo(
    dislikeInfo.rules +
      '\n' +
      infos
        // 中：写入前先把名/歌手里的 @ 转义为 #（与查询侧 hasDislike 口径
        // 一致）——此前裸 @ 写进规则串，解析时按 @ 切分丢掉第 3 段起的
        // 内容：歌名 A@B+歌手 C 被存成 a@b，目标歌永远命中不了（不喜欢
        // 静默失效），还会误杀真名为 A、歌手为 B 的另一首
        .map((info) => `${(info.name ?? '').replaceAll(SPLIT_CHAR.DISLIKE_NAME, SPLIT_CHAR.DISLIKE_NAME_ALIAS)}${SPLIT_CHAR.DISLIKE_NAME}${(info.singer ?? '').replaceAll(SPLIT_CHAR.DISLIKE_NAME, SPLIT_CHAR.DISLIKE_NAME_ALIAS)}`)
        .join('\n'),
  )
  return dislikeInfo
}

export const overwirteDislikeInfo = async(rules: string) => {
  updateDislikeInfo(rules)
  return dislikeInfo
}

export const clearDislikeInfo = async() => {
  updateDislikeInfo('')
  return dislikeInfo
}
