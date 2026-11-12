# 05 · WebDAV 子系统：把自己的云盘当曲库

> 本章讲 `src/core/webdavMusic/` 及其 UI。这个子系统让用户把自己的 WebDAV 服务器当作「云端曲库」：扫描远端目录建成可搜索的歌曲库，支持在线点播（下载到本地缓存后播放）、封面/歌词拉取、把云盘歌曲下载并导入本地歌单，以及把本地音频/歌词/封面批量上传回服务器。
>
> 阅读前建议先看 [02 · 启动流程与运行时](02-启动流程与运行时.md) 了解全局结构；本子系统与 [06 · 数据同步](06-数据同步.md) 共用同一套服务器凭据，两章建议连着读。

---

## 5.1 先记住三件事

1. **凭据只有一份真相**：WebDAV 地址、用户名、密码存在设置键 `sync.webdav.url / username / password` 里，云盘听歌与数据同步**完全共用**。改了这里，两边一起变。
2. **分层是单向的**：连接层 → 文件原语层 → 歌曲库层/上传引擎层 → 队列层 → UI 层。下层不懂上层的概念（文件原语层只懂「路径与字节」，不懂什么是歌曲）。
3. **这个子系统里到处是「被服务器坑过之后」的防御代码**：原子下载、毒缓存判定、按大小放宽超时、先删后传……每一处防御都对应一次真实事故，本章会逐一点名。

## 5.2 文件地图

### 核心层 `src/core/webdavMusic/`

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `client.ts` | 连接层：凭据读取、单例客户端、认证头、直链 URL 构造、远端目录语义 | `readWebDAVCredentials`、`getClient`、`resetClient`、`testConnection`、`getWebDAVAuthHeaders`、`extractOrigin`、`isWebDAVServerOrigin`、`getWebDAVRemoteUrl`、`getWebDAVMusicDir` / `getWebDAVLrcDir` / `getWebDAVPictureDir` |
| `files.ts` | 文件原语层：目录列举、建目录、stat、文本下载、二进制上传、原子下载、毒缓存判定 | `listRemoteEntries`、`ensureRemoteDir`、`getStat`、`describeWebDAVError`、`checkWebDAVRemoteState`、`downloadFile`、`putTimeoutForSize`、`uploadFile`、`uploadBinaryFile`、`isPoisonedCache`、`downloadToFileAtomic` |
| `library.ts` | 歌曲库域逻辑：配置读写、扫描建库、去重、元信息回写、封面/歌词/音频拉取 | `getWebDAVConfig`、`saveWebDAVConfig`、`scanWebDAVSongs`、`updateWebDAVMusicMeta`、`fetchWebDAVPic`、`fetchWebDAVLrc`、`downloadWebDAVMusic`、`uploadWebDAVMusicFile`、`contentTypeForExt`（`dedupeWebDAVSongs` 为模块内部函数，未导出） |
| `upload.ts` | 单文件上传引擎：原生/降级双通道、同路径锁、远端大小校验 | `putFileWithProgress`、`buildUploadRemotePath`、`findLocalLyricFile`、`findLocalCoverFile`、类型 `WebDAVUploadQueueItem` / `WebDAVUploadHistoryItem`、错误类 `UploadAbortedError` / `RemoteDirNotFoundError` |
| `profiles.ts` | 多服务器配置档案（切换、故障转移候选池） | `getWebDAVServerProfiles`、`saveWebDAVServerProfile`、`deleteWebDAVServerProfile`、`applyWebDAVServerProfile`、`findActiveWebDAVProfile`、`getFailoverCandidates` |
| `logger.ts` | 子系统日志门面 `webDAVLog`（info/warn/error），受设置 `common.isEnableWebDAVLog` 门控 | `webDAVLog` |
| `drive.ts` | 兼容聚合层：`export *` 转发 client/files/library/upload 四个模块 | —（历史调用方零改动） |

另有 `src/utils/webdav.ts`（13 行兼容层）：把旧路径 `@/utils/webdav` 的引用转发到 `core/webdavMusic`，同步层只经它访问远端文件原语。

### 原生层

- `ios/LxMusicMobile/WebDAVUploadModule.swift`（+ `.mm` 桥接）：原生上传模块。用 `URLSession` 发 raw PUT（RNFS 的 `uploadFiles` 是 multipart 表单，不适用于 WebDAV）；请求/资源超时都是 1800 秒；通过 `WebDAVUploadProgress` 事件回传进度；支持 Content-Range 分块与取消句柄。

### UI 层 `src/screens/Home/Views/WebDAV/`

页面由四个 Tab 组成（歌曲列表 / 目录 / 上传 / 配置），文件分工：

| 文件 | 职责 |
|---|---|
| `index.tsx` | 页面壳：挂载 `useWebDAVPage`，按 activeTab 渲染四个 Tab |
| `useWebDAVPage.ts`（972 行） | 页面总状态机：配置加载、扫描、筛选/搜索、多选、播放（写入临时列表）、批量下载/封面、事件监听（`webdavPicUpdated`、`jumpWebDAVPosition`） |
| `useUploadManager.ts`（1087 行） | 上传队列状态机：入队与歌词/封面配对、启动预检、并发泵、看门狗、自动重试、历史持久化 |
| `WebDAVListAction.ts`（785 行） | 列表批量动作：下载并导入歌单（两段式）、批量获取在线封面并回传远端、菜单动作分发 |
| `WebDAVListMenu.tsx` | 歌曲长按/更多菜单的菜单项构建（`buildMenus`）与定位浮层 |
| `format.ts` | 尺寸/时间格式化、文件夹名提取等纯函数 |
| `components/TabsHeader.tsx` | 顶部四 Tab 栏 |
| `components/ListTab.tsx` | 歌曲列表：FlatList 固定行高 `getItemLayout`、选中态 ref 解耦、搜索、多选工具栏、下拉刷新即重扫 |
| `components/SongItem.tsx` | 歌曲行：封面、已下载徽标、歌手缺失时回退显示远端路径 |
| `components/FoldersTab.tsx` | 远端目录浏览器：逐级进入、选定扫描目录 |
| `components/UploadTab.tsx`（833 行） | 上传页：队列控制、并发/看门狗参数步进器、歌词/封面连带开关、队列与历史（只显示最近 20 条） |
| `components/ConfigTab.tsx` | 配置页：挂载服务器档案组件、媒体来源与下载路径设置 |
| `components/WebDAVDownloadPath.tsx` | 下载目录选择（自定义路径 / 私有目录） |

`src/components/common/WebDAVProfiles.tsx`（427 行）是多服务器档案编辑器（列表、新建/编辑对话框、一键切换、删除确认），WebDAV 页与设置页的同步模块共用它。

### 外部入口（谁在调用这个子系统）

- **播放链路**：`src/core/music/local.ts` 以动态 `import()` 懒加载 `drive.ts`，在取播放地址、取封面、取歌词时分别调用 `downloadWebDAVMusic` / `fetchWebDAVPic` / `fetchWebDAVLrc`。
- **数据同步**：`src/core/sync/webdavSync.ts` 直接用 `client.ts` 的凭据与客户端读写同步文件（见 [06 章](06-数据同步.md)）。
- **故障转移**：`src/core/sync/webdavFailover.ts` 调用 `profiles.ts` 的 `getFailoverCandidates` 与 `applyWebDAVServerProfile(id, { silent: true })`。

## 5.3 远端目录语义

扫描目录选定后，目录约定是：

- 所选目录下的 `music/` 存音频；
- `lrc/`（歌词）与 `picture/`（封面）是 `music/` 的**兄弟目录**（与 music 同级），不是 music 的子目录；
- `client.ts` 的 `getWebDAVMusicDir / getWebDAVLrcDir / getWebDAVPictureDir` 负责这套语义：当前路径已在 music 目录内时不会重复追加。

注意这与「本地下载目录」的布局一致：本地库根目录下同样分 `music/ lrc/ picture/` 三个子目录（见 [03 章](03-状态管理与数据持久化.md) 的本地库部分）。

## 5.4 四条核心链路

### 5.4.1 扫描建库

```
FoldersTab 选定目录
  → library.scanWebDAVSongs
  → 递归 scanFolder，经 files.listRemoteEntries 列举
      （子目录列举失败记入 skippedDirs，不中断整次扫描）
  → 同目录匹配同名歌词；music 兄弟目录匹配 lrc/picture；
    多个通用封面按 genericPicPriority 取舍
  → toMusicInfo 生成条目（id = webdav_<条目 id>），按 mtime 倒序
  → 与旧库合并（只保留白名单本地字段，见 5.6 第 7 条）
  → dedupeWebDAVSongs 去重
  → 落盘 @webdav_music_config
```

扫描带取消令牌：用户取消时直接不落盘，避免半成品覆盖好库。条目落盘时把扫描派生字段（`picPath`/`lrcPath` 等）从 `meta` 里剥掉——它们每次扫描都会重新解析，存下来只会变成下次合并时的「假本地状态」。

### 5.4.2 在线点播：原子下载 + 毒缓存

点播一首云盘歌时并不会直接流播远端 URL，而是先整首下载到本地缓存再播：

1. `core/music/local.ts` 的 `getMusicUrl` 识别 `meta.webdav === true`，懒加载 drive，调 `library.downloadWebDAVMusic`。
2. 缓存路径为 `Caches/WebDAV/music/<md5(remotePath)>.<ext>`。先用 `files.isPoisonedCache` 验缓存：**0 字节、与 `meta.size` 不符、首字节为 `<`、读取失败，任一命中即判「毒缓存」**（典型成因：某次服务器返回的 HTML 错误页被当音频存了下来）。
3. 未命中走 `files.downloadToFileAtomic`：
   - 下到同目录唯一临时文件 `.tmp-<随机>`；
   - **同源判断用 `client.isWebDAVServerOrigin`（纯字符串比对）决定是否带 Authorization**——同源才带，跨源（重定向到 CDN）剥离，防凭据外泄；
   - 先验 HTTP 状态码，拒绝 206 分段响应（防拿到半截文件冒充整首）；
   - 落盘后用 stat 大小与 expectedSize **精确比对**，通过才 rename 到正式路径；
   - rename 失败时，仅当已有同名文件且大小一致，才视为「并发下载了同一首歌」的成功。
4. 回写 `meta.filePath`，并按设置 `player.cacheLimit` 执行 `enforceCacheLimit` 清理最旧缓存。

### 5.4.3 封面与歌词拉取

- **封面** `fetchWebDAVPic`：先 `getStat` 取远端 expectedSize，缓存 `Caches/WebDAV/covers/<md5(picPath)>` 同样过毒缓存判定；远端大小变了就重下。批量场景（页面批量同步封面、批量获取在线封面）一律**并发 4**。
- **歌词** `fetchWebDAVLrc`：不用 webdav 客户端，用原生 `fetch` 直拉（30 秒 AbortController 超时）；**首字符为 `<` 直接拒收**——这是毒缓存防线在文本侧的版本，防 HTML 错误页冒充歌词。
- **在线封面回传**：当媒体来源设为 online（`webdav.mediaSource='online'`）时，批量获取到的在线封面经私有目录 `cover_upload_tmp` 中转，用 `uploadBinaryFile` 回传到远端 `picture/`，并回写 `meta.picPath`。

### 5.4.4 上传：双通道 + 看门狗

单文件上传入口是 `upload.ts` 的 `putFileWithProgress`：

1. `withUploadPathLock` 对同一远端路径串行化（同路径并发上传会互相覆盖）；
2. **先 DELETE 再 PUT**（见 5.6 第 2 条）；
3. 优先原生通道 `putViaNative`：调 Swift 模块拿真实进度；错误码 `E_HTTP_<码>` 还原成 HTTP 状态码、`E_CANCELLED` 转取消语义；
4. 原生不可用或失败则降级 webdav 客户端通道：文件 base64 全量读入内存 PUT，硬超时 `max(600s, putTimeoutForSize(size))`；降级通道没有真实进度，心跳只报 0，**不伪造百分比**；
5. 两条通道收尾都用 `verifyRemoteSize` 校验远端大小；校验失败整文件重传一次；
6. 远端返回 409（父目录不存在）转成 `RemoteDirNotFoundError` 交队列层处理。

队列层（`useUploadManager.ts`）把单文件上传编排成批量队列：

- **入队配对**：按开关自动把同名歌词/封面配成独立队列项；
- **四段预检**：等配对落定 → 本地 stat（10 秒超时）→ `testConnection` 30 秒竞速 → `checkWebDAVRemoteState` 三态冲突预检（exists 弹覆盖确认、unknown 一律跳过防误覆盖）；文件 >100MB 再二次确认；
- **并发泵**：并发数取设置 `webdav.uploadConcurrency`（钳制 1–6，默认 2）；
- **看门狗**：每 5 秒轮询，只认「真实进度」（loaded 字节数变化），心跳不算；10 秒无真实进度标 stalled，超过 `webdav.uploadStallTimeoutSec`（默认 15 秒，0 为关闭）且存在 abort 句柄才中断；排队等待（waiting）阶段豁免；
- **重试**：网络类错误自动重试 3 次（退避 5/10/20 秒）；409 经 `askCreateRemoteDir` 询问建目录（同一目录只问一次）后重试一次；
- **历史**：结果写入 `@webdav_upload_history_v1`（上限 100 条，500ms 防抖落盘；队列本身只在内存，重启不恢复队列——这是有意为之，见数据同步章对「半成品对账风险」的同一取舍）。

## 5.5 配置与持久化清单

**凭据与路径（设置键，与同步共用）**

| 键 | 含义 |
|---|---|
| `sync.webdav.url` | 服务器地址 |
| `sync.webdav.username` | 用户名 |
| `sync.webdav.password` | 密码（明文存本机设置；不随同步上传，见 06 章） |
| `sync.webdav.path` | 同步目录，默认 `/LX_Music/`；`testConnection` 在根目录 403 时会改试此目录 |

**云盘专属设置（默认值出处：`src/config/defaultSetting.ts`）**

| 键 | 默认 | 含义 |
|---|---|---|
| `webdav.mediaSource` | `'file'` | 封面/歌词来源：file（用云盘文件）/ online（用在线音源） |
| `webdav.downloadPath` | `''` | 主动下载目录，空则用 App 私有目录 |
| `webdav.uploadConcurrency` | `2` | 上传并发（1–6） |
| `webdav.uploadResume` | — | ~~断点续传开关~~（2026-11-12 已删除：开关承诺的行为从未生效，见 5.6 第 4 条） |
| `webdav.uploadChunked` | `true` | 原生通道分块上传 |
| `webdav.uploadChunkSizeMB` | `5` | 分块大小 |
| `webdav.uploadStallTimeoutSec` | `15` | 看门狗停滞超时，0 关闭 |

**本地存储键**

| 键 | 内容 |
|---|---|
| `@webdav_music_config` | 整个歌曲库：`{ selectedFolder, songs, scannedAt, filterPath }` |
| `@webdav_server_profiles` | 多服务器档案数组（`{ id, name, url, username, password, path?, createdAt, updatedAt }`，密码明文存本机） |
| `@webdav_server_profiles_active_id` | 当前生效档案 id |
| `@webdav_upload_history_v1` | 上传历史（上限 100 条） |

**本地目录**

| 目录 | 内容 |
|---|---|
| `Caches/WebDAV/music/` | 点播缓存 `<md5(remotePath)>.<ext>` |
| `Caches/WebDAV/covers/` | 封面缓存 `<md5(picPath)>` |
| 私有目录 `WebDAV/`（或 `webdav.downloadPath` 指定目录） | 用户主动下载，下分 `music/ lrc/ picture/`；另有在线封面中转 `cover_upload_tmp/` |

原子下载的 `.tmp-<随机>` 临时文件与正式文件同目录；`files.ts` 在模块加载时即清理 covers/music 两处目录的残留 tmp。主动下载的本地文件名由 `WebDAVListAction` 的 `resolveLocalFileName` 生成：以父目录名作前缀防同名覆盖（music 目录除外，并兼容旧裸名文件）。

## 5.6 设计决策与历史教训（全部有代码/提交证据）

1. **同源判定弃用 `new URL()`**（`client.ts` 的 `extractOrigin` / `isWebDAVServerOrigin` 用纯字符串切分）。2026-11-07 真机事故（提交 `fc60ff1d`）：Hermes 的 `new URL().origin` 把用户自家服务器误判为跨源，`downloadToFileAtomic` 据此剥掉 Authorization，未认证请求被服务器直接断开（日志报 RNFS -1005），表现为云盘歌曲全部播不了。同理，`getWebDAVRemoteUrl` 手工逐段编码 query/hash、档案编辑器的地址校验用前缀正则——本项目所有 URL 判断都不用 `new URL()`，这是第三次同类事故后的统一口径。
2. **DELETE-before-PUT**。已核对 webdav 库源码：它的 DELETE 不带任何 If 条件头，412 是服务器自己的前置条件策略；部分服务器（CloudDrive 类后端）不接受对已存在文件的无条件覆盖 PUT。策略：上传前先删（`files.ts` 与 `upload.ts` **各有一份模块本地的 `deleteRemoteFileOrAbort`**，未互相导出）、404 忽略、409 抛错中止以保住旧文件。
3. **超时一律按大小放宽**。`putTimeoutForSize` 按 50KB/s 保守估算、钳制在 120 秒–1800 秒之间。Swift 模块原来的 `timeoutIntervalForRequest=60` 是「与文件大小无关的硬顶」：PUT 的响应要等 body 传完才返回，慢速上行下 10MB 以上必超时——这就是「大文件传不上」的真凶，已改为 1800/1800 与 JS 侧上限对齐，真停滞交给看门狗判断。
4. **断点续传：开关已删除（2026-11-12，S-8）**。`upload.ts` 注释明示：跨会话续传无法验证远端残片与本地文件内容是同一份，一律从 0 重传。开关默认开但实现有意停用，且 3-3 删掉最后一个消费点后全仓零逻辑消费方，文案承诺的是不存在的行为，故删开关与设置键（存储残留旧键由 `mergeSetting` 显式丢弃）。上传中断后一律从头重传。
5. **毒缓存防线全线共享**。`isPoisonedCache` 被音频、封面两条下载链共用；歌词侧的「首字符 `<` 拒收」是同一思想。防的是服务器错误页被当成媒体永久缓存——这类缓存不校验就会「这首歌永远播不了」且用户无从下手。
6. **以服务器返回路径为权威**。`files.ts` 的条目路径用服务器返回的 filename 而非本地拼接，避免 NFC/NFD 规范化与 URL 编码差异导致莫名 404。
7. **扫描防丢白名单收紧过**。扫描合并旧库时，「扫描期间本地新增」的防丢判定只认 `filePath / customPicPath / customLrcPath` 三个字段；`picPath/lrcPath` 是扫描派生字段，曾被算作本地状态，导致改过路径的旧条目永生、与新条目并存出现「同歌双份」（2026-11-07 修复，提交 `fc60ff1d`）。配套的 `dedupeWebDAVSongs` 在配置读取时再兜底去重：同名 + 同大小 + 路径整段后缀才判同一文件，保留优先级按「已下载 8 > 位于同步目录下 4 > 自定义封面/歌词 2 > picUrl 1」打分。
8. **元信息回写串行化**。`updateWebDAVMusicMeta` 用 promise 链串行化整份配置的读-改-写，防止并发回写互相覆盖丢更新。
9. **客户端单例按凭据指纹缓存**。`getClient` 以 `url\nusername\npassword` 为键缓存 webdav client，凭据变更自动失效；档案切换再叠加显式 `resetClient()`。
10. **空密码也发 Authorization 头**。`getWebDAVAuthHeaders` 对空密码照样生成 Basic 头（兼容把「无头」与「空密码」区别对待的服务器）；头内 User-Agent 写死为一串 Android Chrome UA（动机代码未注明，不臆测）。

## 5.7 已知不一致（写指南时如实记录，未修）

- `components/FoldersTab.tsx` 的头注释称点已扫描目录行是「筛选列表」，实际代码行为是进入目录浏览（仅「全部歌曲」行走筛选 + 跳列表）。
- `WebDAVListMenu.tsx` 的 `buildMenus` 没有生成 `play` 菜单项，但 `useWebDAVPage` 的 `handleMenuPress` 里有 `case 'play'` 分支——该分支当前从菜单不可达（是否有其他入口未确认）。

## 5.8 上手改码提示

- 改凭据/切换逻辑：只动 `client.ts` 与 `profiles.ts`，不要在 UI 里直接拼认证头。
- 改上传：注意 files.ts 与 upload.ts 各有一份 `deleteRemoteFileOrAbort`，改策略要两处一起改。
- 新增一种「下载校验」：优先复用 `isPoisonedCache` 的判定口径，保持三条链一致。
- 任何涉及 origin/URL 的判断：用 `extractOrigin` 等字符串工具，不要引入 `new URL()`。
