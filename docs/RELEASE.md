# 发布流程

本页是构建和发布操作说明。当前版本分渠道状态、构建来源、测试与未完成事项统一见 [0.7.10 修复与验收记录](REPAIR-0.7.10.md)；本页命令不构成发布授权。

## 发布前门禁

1. 核对待交付提交、工作区差异及 `package.json`、主锁文件、Win7 锁文件版本。确认包内根模块白名单与实际运行依赖一致。
2. 使用锁定来源恢复引擎，检查资产 SHA256、[CI 引擎清单](../ci-engines-v1.json)、[结构引擎锁](../docstructure-engine-lock.json) 与实际文件一致。按目标平台运行对应的恢复和校验脚本，不能因文件存在就略过版本校验。
3. 安装锁定依赖，运行项目要求的测试与依赖审计。修改原生结构引擎时同时运行其 Python 测试和真实原生转换；跳过项单列原因，不计为通过。
4. 检查真实样本：原生与混合 PDF 正文、旋转/倾斜扫描件、多页 TIFF、表格单元格和合并区域、金额及标识符、Markdown 数学与图片、Office 往返及字幕时间轴。表格质量门槛和拒绝不可靠输出的行为必须保留，不能用降低阈值换取“转换成功”。
5. 整体重建目标程序，校验包内版本、EXE/ASAR、必需模块与引擎，再执行对应 profile 的真实 CLI/GUI 转换。保存最终产物哈希及证据路径。
6. 任何必要门禁失败时保持候选状态。源码测试、可运行目录、安装器容器、实际安装、Store 认证和公开发布分别记录。

结构引擎本地重建成功不能推导远程 CI 可复现。上传匹配引擎资产、更新资产名称及哈希后，还须回读远程资产并运行锁校验；禁止放宽锁校验迁就旧远程包。0.7.1 的引擎差异留在所属历史记录，当前状态见本页开头的现役记录。

## Windows 10/11 x64

默认完整版：

```powershell
npm run dist
```

默认生成 `dist/FlyingMouse Format-Setup-<version>-x64.exe`。可选轻量版：

```powershell
npm run dist:lite
```

轻量版默认输出到 `dist/lite`；也可通过 `node scripts/build-windows-lite.js <输出目录>` 指定其他磁盘。其构建 profile 保留 Office、普通 PDF、轻量 OCR、音视频与字幕，移除高级 `docstructure` 资源，并在包内设置 `engineProfile: "lite"`。需要分别验证完整版和轻量版的能力展示、转换与缺失引擎提示。这两个本地构建命令均使用 `--publish never`。

任何运行代码变化都要整体重建 Electron 程序，禁止仅替换旧可执行程序旁的 ASAR。无安装校验可测试 NSIS 外层与内层载荷，并提取 EXE/ASAR 与已测 `win-unpacked` 比对；这不证明安装、卸载、升级及快捷方式流程通过。实际安装验证应单独记录目标版本和安装前后的状态。

- Apple Silicon 与 Intel 使用不同的 SHA-256 锁定引擎，不得交叉打包或使用 Rosetta 掩盖错误架构。
- 两个原生 runner 都必须执行完整转换、生产审计、DMG 构建、挂载检查、Mach-O 架构检查和 12 秒启动冒烟。
- macOS DMG 当前未签名且未公证；Release 必须披露 Gatekeeper 风险和真实 Mac 设备待验收。
- 非 Microsoft Store 桌面版支持普通格式及 NCM/KGG/mflac/mgg/kgma/mmp4/KWM 输入；Microsoft Store 版隐藏并拒绝特殊音频转换。AV3A（Audio Vivid）是 Windows 专属能力，不得在 macOS 能力矩阵中宣传；部分 QQ Music musicex 输入需要已有授权和在线密钥服务。

## Microsoft Store APPX

恢复完整 Windows 引擎与固定 Pandoc 后运行：

```powershell
npm run restore:pandoc
npm run dist:appx
```

[build-appx.ps1](../scripts/build-appx.ps1) 整体构建 Electron，创建独立布局，生成四段版本与商店身份，检查鼠鼠 Logo、PE 证书目录和保留名，并执行 MakeAppx 与包校验。可用 `-StageDirectory` 指定其他磁盘的任务专用布局；备份与旧程序目录不能混入该布局。`-SkipBuild` 只用于明确对应当前源码且已验证的完整程序目录，不用于绕过 EXE/ASAR 重建。

`beforePack` 校验 Pandoc 许可与恢复收据，并生成 LibreOffice 完整性清单。APPX 验证至少检查 ZIP/CRC、Manifest 身份与版本、必需条目、非空体积及包内 ASAR 与已测程序一致；转换样本必须实际使用包中资源，覆盖 Markdown→Word/PDF、PDF→Word、Office→PDF，以及 Store 可写缓存准备。

本地提交候选 APPX 保持未签名，不能以其容器校验推导用户已安装或商店已接受。Partner Center 上传、包验证、认证和公开可见状态须在获准操作后分别现场回读。旧版本的 Submission 状态不得沿用到新版本。鼠鼠图标、身份、渠道材料和第三方组件说明另见 [微软商店上架清单](微软商店上架清单.md) 与 [分发与合规规范](分发与合规规范.md)；其中旧版本快照只作历史参考。

## Win7 Legacy 与 macOS

`npm run dist:win7` 使用独立 Legacy profile 和锁文件，要求 Node 18–22。构建脚本验证 staging 归属并拒绝重解析点；在隔离目录安装 Electron 22.3.27、Sharp 0.32.6 和 PDF.js 2.16.105，不能覆盖根项目依赖。检查内部 EXE 版本，不能从 NSIS 外壳版本推断运行时版本。Win7 真实设备验收与标准 Windows 验收分开记录。

macOS 分别运行 `npm run dist:mac:arm64`、`npm run dist:mac:x64`，先校验各架构原生引擎，不能把 Rosetta 当作原生引擎覆盖。对应 runner 验证转换、依赖、DMG 挂载、架构与持续启动。签名、公证、Gatekeeper 和物理设备验证均需独立证据。

仓库存在这些构建路径或旧版曾通过 CI，不代表当前版本已重新构建并通过这些平台；本轮范围以修复记录为准。

## GitHub 工作流与发布顺序

当前工作流的触发和影响：

| 操作 | 实际行为 |
| --- | --- |
| 推送普通修复分支 | 本身不触发 `ci.yml` 或 `release.yml` |
| 向仓库提交 PR，或推送 `main` | 触发 [ci.yml](../.github/workflows/ci.yml) |
| 推送 `v*` 标签，或手动运行 Release validation | 触发 [release.yml](../.github/workflows/release.yml)；Windows 与 macOS 构建通过后会上传资产并公开设为 Latest |

发布工作流不止生成草稿：Publish job 会覆盖同名资产并将 release 设为公开 Latest。手动输入的 `release_tag` 默认仍是旧版本，执行前必须明确指定正确标签，并核对工作流检出的源码提交；不能把手动运行当作无发布副作用的测试。现有工作流没有自动交付轻量版或 Store APPX 的步骤。

获准发布后按顺序完成：匹配的引擎远程资产与哈希 → 目标提交的 CI 和评审 → 合并 → 新版本标签或明确指定的发布执行 → 声明交付的平台门禁（自动工作流要求 Windows 与 macOS）→ 远程 release、标签提交、资产与哈希回读。不要移动旧标签或把上传修复分支当作合并、部署或发布。

### 0.7.10：仅 Windows 的精确资产发布

本次只交付经过 Windows 11 原生 CLI/GUI、内容和资源验证的 Windows 10/11 x64 完整版；不将 macOS CI 通过写成 macOS 安装器发布，也不包含 Lite、Win7 或 Store 交付。NSIS 容器及其已测载荷通过校验；没有据此声称所有机器的安装/升级均已验证。

以下是 0.7.10 已执行的发布流程，供未来版本复核；不可再次执行建同名标签或覆盖同名资产。保留原安装器，不触发另一轮构建覆盖它：

1. 记录并临时禁用 `release.yml` 的仓库工作流状态，再创建新的 `v0.7.10` 标签；不改工作流源码，不移动旧标签。
2. 创建 draft release，将已验收安装器以精确名称 `FlyingMouse-Format-Setup-0.7.10-x64.exe` 上传；禁止 `--clobber` 或覆盖既有远程资产。
3. 通过 `gh release view --json databaseId` 获取草稿 ID，再按 ID 回读 draft、标签提交、远程文件名、状态、字节数和 SHA-256；不能依赖按 tag 查询公开 Release 的接口读取草稿。核对安装器与现役记录中的已验收文件一致；上传不使用 `--clobber`。
4. 上传步骤无论成功与否都恢复之前记录的工作流状态，并确认没有该标签的构建在运行。全部一致且发布提交 CI 通过后再公开 release 并设为 Latest，重新回读公开状态和下载资产。若失败，保持草稿，不用未经验证的替代包完成发布。

包内生产代码来自 `5d90f84`，后续 `830c4d8` 的两个测试变动被打包排除；合并与发布文档不改变安装器。记录构建提交、验证提交与发布标签各自含义，不声称文档提交重新生成了二进制。Store 的上传、认证、推送必须走独立授权和回读流程。

本次还提供由相同安装器生成并验证的 `.blockmap`、`latest.yml` 和 `SHA256SUMS.txt`。这些文件不表示当前应用启用了自动更新，也不构成旧版自动升级实测；当前公开版的程序内自动更新模块仍已移除。使用公开下载链接手动获取新安装器。

发布说明解析器优先读取 `docs/release-notes-<去点版本>.md`，缺失时会退回本页。真正发布前准备面向用户的对应版本说明并检查解析结果，避免把操作手册当作 release notes；候选修复记录不自动等于已发布说明。

## 历史记录

[v0.3.5 发布说明](releases/v0.3.5.md)、[0.6.10 稳定性修复](release-notes-0.6.10.md)、[0.7.0 发布说明](release-notes-070.md) 保留各自版本背景。旧 CI 运行号、资产哈希和 Partner Center 快照可从对应历史文档及 Git 历史追溯，不作为当前状态。
