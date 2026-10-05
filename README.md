<h1 align="center">LX-Y Music 移动版（修改版）</h1>

<p align="center">
  <img src="doc/images/app-icon.png" width="160" alt="LX-Y Music 图标">
</p>

<p align="center">
  <a href="https://github.com/slovercaca/LX-Y-Music-IOS-test/releases"><img src="https://img.shields.io/github/release/slovercaca/LX-Y-Music-IOS-test" alt="Release version"></a>
  <a href="https://github.com/slovercaca/LX-Y-Music-IOS-test/actions/workflows/ios-ipa.yml"><img src="https://github.com/slovercaca/LX-Y-Music-IOS-test/workflows/Build%20iOS%20IPA/badge.svg" alt="Build status"></a>
</p>

<p align="center">一个基于 React Native 开发的音乐软件（LX-Y Music）</p>

> **本仓库说明**：本项目是 [1970905901/LX-Y-Music-IOS](https://github.com/1970905901/LX-Y-Music-IOS)（`ios-adaptation` 分支）的部分功能修改版，在原项目基础上修复了一批 bug 并新增了若干功能（详见下方「本分支修改内容」）。原项目本身基于 [Q-1515/lx-music-mobile](https://github.com/Q-1515/lx-music-mobile) 的 `ios-adaptation` 分支，重点支持 iOS 平台。
>
> **本项目不做维护**：这是一次性的个人修改存档，不接受 Issue / PR，不会跟进上游更新、不修复新出现的 bug、不回答使用问题。如需持续维护的版本，请使用原项目或自行 fork 修改。

<p align="center">
  <img src="doc/images/screenshot-home.jpg" width="300" alt="LX-Y Music 首页（推荐）界面预览">
  <br>
  <sub>首页 · 推荐</sub>
</p>

## 说明

所用技术栈：

- React Native
- Redux

本分支基于 [1970905901/LX-Y-Music-IOS](https://github.com/1970905901/LX-Y-Music-IOS) 的 `ios-adaptation` 分支修改（原项目基于 [@Q-1515/lx-music-mobile](https://github.com/Q-1515/lx-music-mobile/tree/ios-adaptation)，**重点支持 iOS 平台**，并发布未签名（unsigned）IPA 供自签安装使用）。

## 版本功能说明（对比上游）

本仓库是上游 [1970905901/LX-Y-Music-IOS](https://github.com/1970905901/LX-Y-Music-IOS)（`ios-adaptation` 分支）的修改版。以下按版本号列出相对上游的新增与变更。

### Test-v1（当前版本）

#### 功能移除
- 移除 GitCode 音源

#### WebDAV（重写增强）
- 架构重写
- 播放修复：断点校验、毒缓存清理、NAS 中文路径 404 修复、中文密码支持
- 多服务器配置 + 故障转移
- 上传管理器：队列、进度、暂停/重试、并发可调、409 自动建目录、后缀自动补全
- 目录浏览：下拉刷新、点击进入
- 歌曲多选：批量下载、批量加到歌单
- 同步进度条、测试连接弹窗、封面歌词管理、Cookie 同步

#### 液态玻璃（iOS）
- 全局玻璃效果，主题可开关

软件基础信息：

- **软件名称**：LX-Y Music
- **软件 ID（包名 / Bundle ID）**：`com.LX-YMusic.shuhao`
- **版本号**：随构建日期变化，格式为 `YYYYMMDD`（例如 `20260825`）

已支持的平台：

- iOS（通过 GitHub Actions 自动构建未签名 IPA）

## 致谢（上游项目）

本项目的构建离不开以下上游项目的支持与启发，特此感谢：

- [1970905901/LX-Y-Music-IOS](https://github.com/1970905901/LX-Y-Music-IOS)（ios-adaptation 分支）——本分支的直接上游
- [@Q-1515/lx-music-mobile](https://github.com/Q-1515/lx-music-mobile/tree/ios-adaptation)（ios-adaptation 分支）
- [@WalnutBai/lx-lxwalnut-music-mobile](https://github.com/WalnutBai/lx-lxwalnut-music-mobile/tree/main-debug)（main-debug 分支）

## 下载与构建

- 未签名 IPA 由 GitHub Actions 自动构建。日常提交的构建产物（文件名 `LX-Y Music-v<YYYYMMDD>-ios-unsigned.ipa`）发布在仓库 **Releases** 的滚动 `latest` 预发布中，供测试使用。
- **正式版**：打 tag 发布，tag 格式为 `<代号>-v<数字>`（例如 `Ocean-v1`），构建后产物改名为：

  ```
  LX-Y-Test.Music-<代号>-v<数字>.ipa
  ```

  例如 `LX-Y-Test.Music-Ocean-v1.ipa`。工作流会自动创建 draft Release 并生成更新日志草稿，发布者在网页端写清楚本版更新内容后手动 Publish。
- 使用说明与常见问题请参阅上游项目的移动版文档。

> 注意：本分支**已移除软件内的「检查更新」功能**，不会在应用内提示版本更新。

目前本项目的原始发布地址只有 **GitHub**，其他渠道均为第三方转载发布，与本项目无关！

## 目录结构

```
LX-Y-Music-IOS/
├── .github/
│   ├── ISSUE_TEMPLATE/          # bug / feature 提交模板
│   └── workflows/               # CI：ios-ipa.yml（自动构建）、build-test、publish-version-info
├── config/
├── doc/images/
├── ios/                         # iOS 原生工程
│   ├── LxMusicMobile/           # 主工程源码（含 AppDelegate.mm 及全部原生模块）
│   │   └── Images.xcassets/AppIcon.appiconset/
│   ├── LxMusicMobile.xcodeproj/
│   ├── LxMusicMobileTests/
│   └── Vendor/LXLibFLAC/        # FLAC 解码静态库（include/src）
├── patches/ios/
├── publish/
│   └── utils/
├── scripts/
├── src/                         # RN 主源码（TS/TSX/JS）
│   ├── components/              # 通用组件（CheckBox、ChoosePath、PlayerBar 等）
│   ├── config/
│   ├── core/                    # 核心逻辑
│   │   ├── baiduPan/ oneDrive/ webdavMusic/   # 网盘类
│   │   ├── music/ player/ search/ sync/        # 音乐 / 播放 / 搜索 / 同步
│   │   └── init/                # 初始化（deeplink / player / userApi）
│   ├── event/
│   ├── lang/
│   ├── navigation/              # 导航（react-native-navigation）
│   ├── plugins/
│   │   ├── player/              # 播放引擎 + 音效（drivers / adapters）
│   │   └── sync/client/         # 同步客户端
│   ├── resources/               # 字体 / 图片 / 媒体
│   ├── screens/
│   │   ├── Home/                # 首页
│   │   │   ├── Horizontal/ Vertical/
│   │   │   └── Views/           # 各功能页
│   │   │       ├── BaiduPan/ WebDAV/ OneDrive/    # 网盘
│   │   │       ├── Leaderboard/                   # 排行榜
│   │   │       ├── Search/ SongList/ Mylist/ ...
│   │   │       └── Setting/settings/              # 设置（Player / Download / Basic / ...）
│   │   ├── PlayDetail/          # 播放详情（Vertical / Horizontal）
│   │   └── AlbumDetail/ ArtistDetail/ SonglistDetail/ Comment/ DownloadManager/ SimilarSongs/
│   ├── store/                   # 状态管理（player / setting / list / user / theme / ...）
│   ├── theme/themes/
│   ├── types/
│   └── utils/
│       ├── musicSdk/            # 各平台 SDK（bd / kg / kw / mg / tx / wy / bilibili / qishui；本分支已移除 git）
│       ├── nativeModules/       # 原生桥接封装（cache.ts / utils.ts / ...）
│       └── data/ hooks/ simplify-chinese-main/
├── app.json  babel.config.js  metro.config.js  tsconfig.json
├── index.js  shim.js  test.js
├── package.json  package-lock.json  .nvmrc  .ncurc.js  .eslintrc.cjs
├── Gemfile                     # Ruby / CocoaPods 依赖
├── dependencies-patch.js
├── CHANGELOG.md  FAQ.md  README.md  LICENSE
```

## 数据同步服务

从 v1.0.0 起，上游发布了一个独立的[数据同步服务](https://github.com/lyswhut/lx-music-sync-server#readme)。如果你有服务器，可以将其部署到服务器上作为私人多端同步服务使用。

## 贡献代码

本项目不做维护，不接受 PR。如需改进，请自行 fork 修改。

## 项目协议

本项目基于 [Apache License 2.0](https://github.com/slovercaca/LX-Y-Music-IOS-test/blob/ios-adaptation/LICENSE) 许可证发行，以下协议是对于 Apache License 2.0 的补充，如有冲突，以以下协议为准。

---

*词语约定：本协议中的“本项目”指 LX-Y Music 移动版项目；“使用者”指签署本协议的使用者；“官方音乐平台”指对本项目内置的包括酷我、酷狗、咪咕等音乐源的官方平台统称；“版权数据”指包括但不限于图像、音频、名字等在内的他人拥有所属版权的数据。*

### 一、数据来源

1.1 本项目的各官方平台在线数据来源原理是从其公开服务器中拉取数据（与未登录状态在官方平台 APP 获取的数据相同），经过对数据简单地筛选与合并后进行展示，因此本项目不对数据的合法性、准确性负责。

1.2 本项目本身没有获取某个音频数据的能力，本项目使用的在线音频数据来源来自软件设置内“自定义源”设置所选择的“源”返回的在线链接。例如播放某首歌，本项目所做的只是将希望播放的歌曲名、艺术家等信息传递给“源”，若“源”返回了一个链接，则本项目将认为这就是该歌曲的音频数据而进行使用，至于这是不是正确的音频数据本项目无法校验其准确性，所以使用本项目的过程中可能会出现希望播放的音频与实际播放的音频不对应或者无法播放的问题。

1.3 本项目的非官方平台数据（例如“我的列表”内列表）来自使用者本地系统或者使用者连接的同步服务，本项目不对这些数据的合法性、准确性负责。

### 二、版权数据

2.1 使用本项目的过程中可能会产生版权数据。对于这些版权数据，本项目不拥有它们的所有权。为了避免侵权，使用者务必在 **24 小时内** 清除使用本项目的过程中所产生的版权数据。

### 三、音乐平台别名

3.1 本项目内的官方音乐平台别名为本项目内对官方音乐平台的一个称呼，不包含恶意。如果官方音乐平台觉得不妥，可联系本项目更改或移除。

### 四、资源使用

4.1 本项目内使用的部分包括但不限于字体、图片等资源来源于互联网。如果出现侵权可联系本项目移除。

### 五、免责声明

5.1 由于使用本项目产生的包括由于本协议或由于使用或无法使用本项目而引起的任何性质的任何直接、间接、特殊、偶然或结果性损害（包括但不限于因商誉损失、停工、计算机故障或故障引起的损害赔偿，或任何及所有其他商业损害或损失）由使用者负责。

### 六、使用限制

6.1 本项目完全免费，且开源发布于 GitHub 面向全世界人用作对技术的学习交流。本项目不对项目内的技术可能存在违反当地法律法规的行为作保证。

6.2 **禁止在违反当地法律法规的情况下使用本项目。** 对于使用者在明知或不知当地法律法规不允许的情况下使用本项目所造成的任何违法违规行为由使用者承担，本项目不承担由此造成的任何直接、间接、特殊、偶然或结果性责任。

### 七、版权保护

7.1 音乐平台不易，请尊重版权，支持正版。

### 八、非商业性质

8.1 本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。

### 九、接受协议

9.1 若你使用了本项目，即代表你接受本协议。

---

本项目不做维护，不接受 Issue / PR。如有问题请前往原项目 [1970905901/LX-Y-Music-IOS](https://github.com/1970905901/LX-Y-Music-IOS) 反馈，或自行 fork 修改。
