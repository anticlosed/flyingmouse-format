# FlyingMouse Format 交接

更新时间：2026-08-15（v0.6.1 全平台发布完成——Windows 10/11 x64 + Windows 7 兼容版 + macOS arm64/x64 DMG）

## 当前状态

- **版本**：v0.6.1（合规版，部分格式已下架）。GitHub Release 已发布：https://github.com/LaoFeng-mouse/flyingmouse-format/releases/tag/v0.6.1（7 资产：win x64 标准版 + win7 兼容版 + mac arm64/x64 DMG + blockmap + latest.yml）
- **main**：HEAD c00fb42，已同步 origin/main；full-version 分支 = 满血版（含解锁模块，匿名，自留）
- **CI 引擎基建已打通**：ci-engines-v1 Release（win32 双分卷 core+docstructure + darwin arm64/x64 四资产），release.yml 支持 workflow_dispatch 指定 tag 全平台自动构建发布；prepare-macos-engines 生成 darwin 引擎
- **本机**：D1（%LOCALAPPDATA%\Programs\FlyingMouse Format）与 D2（C:\Users\34615\飞鼠格式\FlyingMouse Format）app.asar md5 一致（27ba6ce3，v0.6.1）；桌面满血版匿名 zip 已重打（含 ICO 增强）
- **测试基线**：438 = 437 过 + 0 失败 + 1 跳过（main）；496 = 492 过 + 0 失败（full-version）

## 最近完成的修复（v0.6.0 → v0.6.1）

- 合规阉割：移除 NCM/KGG/mflac 等音乐平台加密格式解锁 + 自动更新；公开版仅支持普通格式（README/AGENTS/docs/分发与合规规范.md 已同步）；GitHub 版保留打赏，内部版匿名
- 单词书分类修复：pdf-classifier 多数派判定（scanned 占比 <20% 按 native 走 docengine），修「单词之间：低频词.pdf」PARSE_FAILED
- PDF 引擎（docengine.exe md5 1d2d12e6）：页眉/页脚擦除（含罗马页码）、标题独立成段、封面标签/值分行、目录/文献独立、表单检测收紧（FORM_ROW_X_GAP=40/FORM_SHORT_MAX=20/图注排除）、RawPage 离群检测加同行伙伴检查（修 1101 缺「二维码」）
- ICO 增强：PNG→ICO 尺寸自适应（小源图不再上采样模糊）+ extractAllFrames 多帧提取
- CI 全平台打通过程修复（11 轮）：manifest repository OWNER、docstructure lock 重建、bin/avs3 入库兼容、probe 退出码 20 + stderr 捕获（bash + set +e）、mac /var 符号链接（trustedRoot/isTrustedEntry realpath 自洽）、测试硬编码本机路径、8.3 短名（realpathSync.native）、ZIP 时间戳确定性

## 待办（下一窗口）

- ① **AppX/MSIX 打包未完成**：C:\appx-build 已备好（证书 flyingmouse-code.pfx/openssl2 空密码、AppxManifest MinVersion 17763、Logo 资产已生成）；卡 MakeAppx 0x8007007b——已二分定位到 docengine/_internal/docx/templates/default-docx-template（含 [Content_Types].xml / _rels 保留名），移走嫌疑文件后仍失败，需继续逐文件定位或用 -v verbose 观察；或从包排除 docx/templates 验证引擎运行依赖。打包成功后 signtool 签名
- ② 真实 Win7 / Mac 物理设备验收（Win7 兼容版 + mac DMG 均已发布但未真机实测）
- ③ Partner Center 微软商店上架：v0.5.1 认证/发布状态现场回读；v0.6.1 是否走商店（APPX 未成是前置）
- ④ PyMuPDF AGPL 合规说明（docengine 含 PyMuPDF，许可页附文本 + 源码链接）
- ⑤ 评定表模板 97.2% 缺 7 字（表格 cell 类，与 1101 不同根因，未排查）
- ⑥ 清理：bin/ 备份目录（docengine.bak-* ×3 + docengine.old + docstructure.bad-old-005744 ≈ 4G）、cert/（AppX 证书密钥，勿入库）、C:\appx-build（AppX 收尾后删）

## 已知约定

- GitHub remote：https://github.com/LaoFeng-mouse/flyingmouse-format.git；gh 账号 LI-2004-feng
- 公开发布物署名「牢蜂（LaoFeng）」，非商用（禁止销售/转卖/套壳）；对外措辞「部分格式已下架/合规版」，禁「阉割/破解/解锁/VIP」
- 引擎 env（测试/转换必需）：FLYINGMOUSE_FFMPEG_PATH / LIBREOFFICE / PDFTOPPM / TESSDATA 指向 D1 resources
- Win7 构建需 Node 18–22（本机已备 C:\Users\34615\.tools\node-v22.14.0-win-x64）
- 多窗口并行操作同一仓库易冲突（曾致 package.json 被误重写）；发现文件莫名被改先怀疑并行会话
