# FlyingMouse Format 架构说明

本文说明当前源码的运行机制。0.7.10 的源码、产物、测试、安装与分渠道发布状态统一记录在 [修复与发布记录](REPAIR-0.7.10.md)，用户变化见[发布说明](release-notes-0710.md)；旧版验证结果不作为本次构建的证据。

## 运行结构

```text
Electron 主进程
  ├─ 单实例锁、独立临时目录、引擎路径配置
  ├─ 127.0.0.1 随机端口上的 Express 服务
  ├─ BrowserWindow → 本地页面 → 转换 API → 各转换模块
  ├─ Store Office helper → 可写缓存 → Office 就绪状态
  └─ preload 受限 IPC → 保存对话框 → 校验后保存结果
```

窗口开启后启动 Store Office 准备工作，复制和验证在可取消的独立子进程中执行。转换文件留在本机；渲染进程启用 `contextIsolation` 和沙箱，关闭 `nodeIntegration`。修改状态的转换请求及 IPC 校验可信本地页面来源；下载只允许访问登记的结果及关联资源。

## 主要模块

| 模块 | 职责 |
| --- | --- |
| [electron-main.js](../electron-main.js)、[preload.js](../preload.js)、[electron-security.js](../electron-security.js) | 桌面生命周期、隔离边界、保存与诊断 |
| [desktop-shutdown.js](../desktop-shutdown.js)、[owned-tasks.js](../owned-tasks.js) | 退出状态、所属转换进程停止、带目录身份校验的临时清理 |
| [server.js](../server.js)、[config.js](../config.js)、[utils.js](../utils.js) | 本地 API、引擎能力、格式与目标路由 |
| [conversion-progress.js](../conversion-progress.js)、[resource-policy.js](../resource-policy.js)、[upload-budget.js](../upload-budget.js) | 请求阶段计量、有限资源预算、上传空间与半成品归属 |
| [office-readiness.js](../office-readiness.js)、[store-engine-worker.js](../store-engine-worker.js)、[store-engine-cache.js](../store-engine-cache.js) | Office 准备状态、后台复制、缓存完整性 |
| [pdf.js](../pdf.js)、[pdf-classifier.js](../pdf-classifier.js)、[ocr.js](../ocr.js) | PDF 分类、正文完整性、OCR 与降级输出 |
| [pdf-table-extractor.js](../pdf-table-extractor.js)、[pdf-table-runtime.js](../pdf-table-runtime.js) | 原生 PDF 的空间表格提取与工作簿生成 |
| [pdf-structure-engine.js](../pdf-structure-engine.js)、[pdf-structure-contract.js](../pdf-structure-contract.js)、[pdf-structure-score.js](../pdf-structure-score.js) | 高级结构引擎边界、结果校验与表格评分 |
| [pdf-office-docx.js](../pdf-office-docx.js)、[pdf-office-xlsx.js](../pdf-office-xlsx.js) | 结构化 Word/Excel、参考图与待核对内容 |
| [markdown-document.js](../markdown-document.js)、[markdown-math.js](../markdown-math.js)、[text-conversion.js](../text-conversion.js) | Markdown 文档树、数学公式及文本格式 |
| [ebook.js](../ebook.js)、[text-encoding.js](../text-encoding.js) | EPUB/MOBI 读取、EPUB 顺序写入、源文本严格解码 |
| [subtitles.js](../subtitles.js)、[ofd-convert.js](../ofd-convert.js) | 字幕转换与 OFD 专用路径 |
| [ncm-format.js](../ncm-format.js)、[ncm-metadata.js](../ncm-metadata.js)、[av3a-format.js](../av3a-format.js)、[audio-format-utils.js](../audio-format-utils.js) | NCM 解包、标签与 AV3A 辅助解码、特殊音频字节上限 |
| [kgg-format.js](../kgg-format.js)、[mflac-format.js](../mflac-format.js)、[kgma-format.js](../kgma-format.js)、[kwm-format.js](../kwm-format.js) | KGG、MFLAC/MGG/MMP4、KGMA 与 KWM 输入处理 |
| [settings-store.js](../settings-store.js)、[save-download.js](../save-download.js)、[save-converted-result.js](../save-converted-result.js) | 设置降级、结果完整性与关联资源保存 |
| [public/app.js](../public/app.js)、[public/conversion-preferences.js](../public/conversion-preferences.js)、[public/i18n.js](../public/i18n.js) | 队列交互、能力刷新、偏好与双语提示 |

新根模块必须登记到 `package.json` 的 `build.files` 白名单。源码可运行不代表模块已进入安装包。

## 本地接口与状态

| 接口 | 用途 |
| --- | --- |
| `GET /api/capabilities` | 引擎能力、Office 准备状态、格式分组及资源限制 |
| `POST /api/targets` | 根据扩展名与当前能力查询可选目标 |
| `POST /api/convert` | 单文件转换 |
| `POST /api/convert-images-to-pdf` | 图片队列合并 PDF |
| `POST /api/merge-pdfs` | PDF 合并 |
| `GET /api/conversion-progress/:id` | 查询本次转换的实际阶段、计数与状态；同源、禁止缓存 |
| `GET /downloads/:id` | 下载当前实例登记的结果 |
| `POST /api/downloads/release` | 按精确结果 ID 丢弃产物；不接受客户端文件路径 |

语言、主题、各源格式目标偏好与默认保存目录统一写入 Electron `userData/settings.json`，旧浏览器存储仅用于迁移。存储失败时保留内存状态并提示；跨卷 `EXDEV` 复制前保留完整恢复副本，主文件损坏时可重新读取。转换文件与诊断报告先写本次独占临时文件，再发布；不支持硬链接的文件系统用排他复制完成不覆盖保存。每个实例拥有独立临时目录；启动残留清理只处理精确 PID 后缀且进程已退出的目录。无退出收据的目录须超过既有过期阈值；退出清理留下的收据须与目录身份匹配，才能提前回收。

桌面退出先设置取消屏障、释放单实例锁并关闭窗口，异步停止本应用登记的进程树/Worker，再按目录真实路径和文件身份删除临时内容。停止阶段的 JavaScript 总预算为 5 秒，任务结束后的清理最多 1.5 秒且不超总预算；Windows 单次 taskkill 最多等待 4 秒。预算不是操作系统故障下的绝对退出保证。未完成删除时保留收据，供后续启动重试；拒绝链接或已替换目录。CLI 成功与失败也停止所属后台任务并保留原退出码，避免无需 Office 的命令结束后留下准备进程。

桌面窗口由 `desktop-recovery.js` 设置应用会话直连本地服务，记录主页面加载、就绪超时、preload 错误及渲染崩溃。只有可信主框架的 `renderer-ready` 通知确认界面就绪，加载错误页触发的 `did-finish-load` 不算成功。故障提示与重试由主进程原生对话框提供，不依赖失效网页；恢复中的转换由用户确认后重新选择。

转换期间冻结选择/清空和转换参数，以开始时的文件及参数快照处理整批任务。文件识别和目录扫描通过选择版本丢弃过期异步结果，防止旧请求覆盖新队列。

转换请求通过 UUID v4 的 `X-FlyingMouse-Progress-Id` 关联进度，服务端只保留有界的内存记录。阶段包括上传、准备、排队、识别、转换、合并与输出校验；已完成量和总量由真实字节、页、文件、媒体秒数或章节事件提供。阶段切换清空旧计数；ZIP 打包和文件写入不沿用页面处理的满额计数。服务端在输出就绪且成功响应完成后记录成功，前端仍以实际 POST 结果决定可保存状态，不凭轮询结果提前完成。

界面明确显示“当前阶段进度”：总量已知才显示阶段百分比，满额显示“阶段完成”，未知总量显示静止条和无法估算。批次已处理/失败文件数独立展示。“本次已耗时”从点击转换计时，包含上传、排队及校验，成功或失败后冻结，不含保存时间；切换语言保留状态。轮询绑定活动请求，结束时停止轮询和计时，旧响应不能覆盖新任务。

清空或替换结果只释放已丢弃的登记产物。前端保存引用、服务端传输引用与其他结果共享的资产仍受保护；可见未保存结果不因计时自动失效。清理逐项核对登记时的文件及父目录身份，拒绝链接、已替换对象和后来新增的内容；浏览器下载不能确认完成时保留本次会话引用，退出后由实例清理处理。

## Store Office 准备

Store 的安装目录只读，因此在加载服务配置前就确定每用户可写的 LibreOffice 路径。准备状态为 `pending`、`ready` 或 `failed`；Office 转换等待准备，图片、文本、字幕等独立路径可先工作。页面在准备期间刷新能力，失败显示原因和诊断入口。

Windows 会将 Store 应用的 LocalAppData 写入重定向到更深的 `Packages/<family>/LocalCache/Local`。旧根目录加完整十六进制哈希名可使 Office 原生组件的路径过长，校验成功也无法启动。默认逻辑根现为 `%LOCALAPPDATA%/FMF/e`，目录名为 `lo-` 加内容摘要的前 32 个十六进制字符；完整 64 字符内容键、51 项清单规定的哈希或大小及缓存快照仍用于验证，不凭短目录名接受内容，也不将只有大小的清单项称为哈希校验。旧根/其他代际缓存保留，避免影响旧实例；不保证任意超长用户目录可用。

缓存名称依据引擎内容标识确定。冷缓存先复制到 staging，校验构建期完整性清单并执行真实 CSV→PDF 冒烟，成功后再发布。内容标识、验证收据和文件快照一致的暖缓存可复用；旧包没有内容标识时仍需冒烟。损坏缓存重新构建，失败不会发布残缺目录或提前回收可用旧缓存。

缓存准备与发布共用跨 Worker/进程锁。发布前将已有缓存保留为同目录唯一备份；发布失败恢复旧路径，回滚失败保留最后副本并在下次准备时恢复、重新验证。保留其他内容代际缓存，避免删除旧实例仍在使用的引擎；代价是这些缓存继续占盘。此流程支持中断后恢复，不宣称两次目录改名具备断电事务原子性。

`office-runtime.js` 为转换与 Store 验证共用短、独占、已验证可写的配置目录。Windows 过深的 TEMP 回退到当前用户 LocalAppData；无法创建时仅让 Office 任务失败。`office-process.js` 在期限到达后仅终止本次启动的原生进程树，记录超时、清理状态和有界原生输出。Store helper 通过包内 `office-smoke-runner.js` 复用相同执行器。

## PDF 与 OCR 路由

- **原生 PDF→Word**：优先使用 docengine；检查 DOCX 容器、引用资源、可编辑内容及原生文字覆盖。失败时按错误类型尝试结构引擎或重建文字，降级结果附带版式提示。
- **扫描或混合 PDF→Word/Excel**：使用 PP-StructureV3 结构识别。部分引擎缺失、解析或正文覆盖错误允许 Word 回落 OCR 段落；Excel 没有可靠表格时明确失败。无效结构、资源超限和低质量表格不会作为成功结果输出。
- **原生 PDF→Excel**：使用 PDF.js 文字坐标、线条和空间关系形成表格模型，按表格分工作表并处理可判断的跨页续表；逐页检查覆盖，保留已成功表格并补识别缺失扫描页，无法恢复时明确失败。未成表内容的原始行工作表属于原生文字路径，不是扫描表格识别失败的兜底。
- **PDF→TXT/HTML/Markdown 及 Word 文字回落**：逐页检查正文，包括只有原生标题或印章、正文仍在图片中的页面；补充 OCR 并合并原生文字，保留原生标点，真正空白页跳过 OCR。Markdown 保留可判断的标题和简单表格，不保证原版式或插图还原。
- **图片 OCR**：Tesseract 先校正方向和倾斜，质量不足时尝试其他布局或旋转。质量过低失败，需复核的文字、金额和方向校正返回双语提示；多页 TIFF 逐页识别。图片→DOCX/Markdown 输出可编辑文字，不承诺重建原图版式。

`pdf-ocr-regions.js` 对完全可见且不与原生文字重叠的内嵌扫描图保留原像素比例识别，避免 PDF 非等比缩放破坏字形。裁剪、遮挡、透明蒙版、隐藏内容及无法安全判断的绘制操作回退页面渲染；单图 50MP、单页合计 100MP 预算限制原图提取。OCR 同时检查局部低质量文字，避免整页清晰英文掩盖中文乱码。

Markdown 保存由 `markdown-asset-references.js` 解析 CommonMark/GFM 与真实 HTML 图片/链接的原文位置。仅改写附件目的地址，不重排 AST，代码、正文、换行和转义保持原样。缺失真实附件仍拒绝保存并保留旧产物。

结构表格按空间与文字对应分配 OCR 内容，置信度只评估有文字的单元格。空白格保持空白，Excel 不把空白格计入低置信度待核对项。网格覆盖、非空比例、候选冲突与质量门槛仍生效；详细常量以评分模块为准。

## OFD 与特殊音频边界

OFD（国标 GB/T 33190）输入注册在 document 类别，但 `targetsForExt` 对其提前返回只暴露 `pdf`/`zip`：
`ofd-convert.js`（`@miconvert/ofd-to-pdf`，纯 JS）转出 PDF 后自动复用现有 PDF→图片/文字/Word 全链路。
LibreOffice 无法打开 OFD，因此 OFD 分支在 server.js 的 document 分发最前拦截，不经 LO。

`ncm-format.js`、`kgg-format.js`、`mflac-format.js`、`kgma-format.js`、`kwm-format.js`、`av3a-format.js` 与 `audio-format-utils.js`
组成特殊音频输入链路：先按格式解包到临时文件，再交给统一 FFmpeg 转换。同一时刻只允许一个特殊音频任务占用内存槽位，
输入与输出均受字节上限约束。Microsoft Store 版通过 `unlockAudioInputs` 隐藏并拒绝这些输入。

## 文本与电子书

普通文本（含 CSV/TSV）转 EPUB 由 `text-encoding.js` 读取，输入按设备内存预算限制且最多 64 MiB，流式累计并可取消；该读取预算不表示后续无需保留解码文本。自动模式接受 UTF-8 和带 BOM 的 UTF-16，也可明确选择 UTF-8、GBK/GB18030、UTF-16LE/BE。无法严格解码、编码与 BOM 冲突或含 XML 非法控制字符时明确拒绝，不猜测 GBK、不静默替换或截断；其他转换目标不受此编码选项改变。

`ebook.js` 按字符边界限制普通文本章节大小，保留正文与空行；Markdown 按标题、HTML 保持标签结构。XHTML 惰性生成并顺序压缩，避免密集短段落同时创建大量压缩任务。进度按实际处理完成的章节计数，目标流写完并关闭后才进入校验；取消或写入失败清理本次自有半成品。EPUB 读取遵循 spine 顺序，缺章、缺图、加密及不支持的 MOBI 编码/压缩明确失败；支持内容的 CSS 与固定版式简化另有提示，不承诺任意电子书无损还原。

## 引擎与资源边界

FFmpeg 负责普通音视频及部分图片编码，Sharp 负责图片处理，LibreOffice 负责 Office，Poppler 负责 PDF 栅格化，Tesseract 负责轻量 OCR，Pandoc 负责 Markdown 文档生成，qpdf 负责 PDF 密码操作。OFD 走纯 JavaScript 转 PDF，再按需使用 PDF 转换链路。格式清单和实验性标记以 `config.js` 与能力接口为准；非 Microsoft Store 桌面版额外开放 NCM / KGG / mflac / mgg / kgma / mmp4 / KWM 输入，Microsoft Store 版只开放普通音频格式，旧版音乐平台特殊格式文档不表示当前支持。

| 能力 | 主要引擎 |
|---|---|
| 音视频 | FFmpeg |
| AV3A / Audio Vivid | AVS3 解码器 + FFmpeg |
| Office / WPS 文档 | LibreOffice |
| OFD 版式文档 | @miconvert/ofd-to-pdf（纯 JS，随依赖打包，无外部二进制） |
| PDF 渲染 | Poppler |
| OCR | Tesseract |
| 图片 | Sharp |

这些大型二进制不提交到 Git 仓库；正式安装包通过 `extraResources` 打入应用。

`resource-policy.js` 在进程加载时按总内存和可用内存计算有限的普通图片像素、合并图像与 PDF 页数预算，并设有限的批次字节、单文件和上传数量上限；Sharp 保留解码像素保护。`upload-budget.js` 按临时盘实际空间限制本次累计输入、保留输出余量并在写入期间复查，失败或断流只移除本次成功创建且身份仍匹配的半成品。超预算明确报错，不自动降采样、跳页或修改源文件；这些准入检查不是任意引擎的峰值内存保证。

高级结构识别在同一应用进程中串行执行完整请求（含输出消费和清理），排队任务支持取消；每个原生进程启动前将 OMP/MKL 线程预算设为可用逻辑处理器数的一半，至少 1、最多 4。请求出队后和每批启动前要求至少 5 GiB 当前可用物理内存，不足或无法读取时以 `PDF_STRUCTURE_MEMORY_INSUFFICIENT` 明确失败，不静默回退低质量输出。该门槛不影响 TXT→EPUB 等独立路径，也不是内存预留或任意文件的峰值上限。

高级结构识别另有输入预算：最多 500 页，按 144 DPI 渲染时单边最多 16,384 像素、单页 5,000 万像素、每批最多 8 页且累计 1 亿像素。JavaScript 先检查整份 PDF，再保留 Catalog、页面对象和可选图层设置，移除本批以外页面，按原清晰度串行调用原生引擎；每批临时 PDF 可能接近源文件体积，处理后及时移除。整份输出总量和累计清单大小分别限制为 512 MiB，内容数量预算不因分批扩大。批次结果重新校验页序、资源路径和全局预算。原生预检先于 Paddle 导入和模型初始化。

结构引擎可用性检查可执行文件及 11 组必需模型的非空图、权重和配置文件，并验证路径归属；仅存在模型目录不足以判定可用。原生退出码区分模型缺失、解析失败、结构无效和资源超限。Windows 原生引擎使用 UTF-8 进程代码页；不支持时在 ASCII 路径下暂存模型，必要时使用已存在且指向同一每用户目录的 NTFS 短路径，不创建公共模型缓存。

大引擎通过 `extraResources` 打包，不作为普通源码提交。完整版保留高级结构引擎；可选 Windows 轻量版只移除 `docstructure` 资源并写入 `engineProfile: "lite"`，保留普通 PDF、轻量 OCR、Office、音视频、字幕及图片文字输出。轻量版明确提示高级扫描表格需要完整版，Word 可按上述规则回落 OCR。Windows Tesseract WASM 去除重复副本，保留所需 SIMD/LSTM 变体；macOS 使用独立配置，本轮未验证。

## 平台与产品边界

标准 Windows 构建使用根项目 Electron 运行时。Win7 是独立 Legacy profile，使用自己的 Electron 22.3.27、Sharp 0.32.6、PDF.js 2.16.105 与锁文件；其构建脚本要求 Node 18–22，在隔离 staging 安装依赖，不修改根运行时。两个运行时的 PDF.js 均随包自包含并禁用动态求值。macOS 使用各架构原生引擎包，平台是否完成本轮验证以修复记录为准。

飞鼠格式与鼠鼠打印是独立应用；图标和鼠鼠界面资产按项目约定维护，不因转换引擎修改而重绘。
