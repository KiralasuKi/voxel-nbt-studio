# Voxel NBT Studio 开发指南

## 开发环境与调试

- VS Code 桌面版、Node.js（建议使用项目测试过的 24）和 Python 3。
- 安装依赖：运行时不需要 npm 依赖；浏览器测试与截图另外需要 Playwright 和 Chrome/Chromium。
- 从仓库根目录执行 `code --extensionDevelopmentPath="$PWD"`，在扩展开发主机里右键一个**测试用**结构 NBT，用 Voxel NBT Studio 打开。前端报错可用 VS Code 的 **Developer: Open Webview Developer Tools** 检查；文件保存、JAR 和工作线程问题优先看扩展主机日志。
- 原版模型、碰撞箱和实体初始化需要本地客户端 JAR 与完整依赖。测试环境可通过 `VOXEL_LIBRARIES` 提供依赖目录（多个目录用系统路径分隔符）。JDK 从 `VOXEL_JAVA`、`JAVA_HOME` 或 `PATH` 选择，1.21 系列需 21+，26.x 需 25+。

## 修改从哪里开始

| 要改的内容 | 入口 |
| --- | --- |
| VS Code 扩展注册、资源选择、面板消息、撤销/重做条目 | `extension.js` 的 `Provider`；方块编辑和布局编辑分别在 `editDocument()`、`changeLayout()` |
| 文档工作线程、请求队列、保存冲突保护 | `lib/document.js`；实际执行编辑和恢复布局的是 `lib/worker.js` |
| Java 二进制 NBT、SNBT 与未知字段保留 | `lib/nbt-codec.js` 负责字节读写和 SNBT 输出，`lib/snbt.js` 负责 SNBT 输入 |
| 结构坐标、方块和调色板、复制粘贴 | `lib/nbt.js` 的 `Structure` |
| 实体 NBT、本地坐标、旋转和皮肤资料 | `lib/entity-data.js`；Mojang 皮肤查询在 `lib/player-skins.js`；画和展示框的 JAR 模型在 `media/hanging-models.js` |
| 工具、交互、画布状态、绘制顺序 | `media/editor.js`；指令、实体、掩码和 NBT 表格各有独立模块 |
| WebGL 着色器、顶点布局和区块缓冲 | `media/scene-renderer.js`；构建网格的是 `media/mesh.js`，加载材质的是 `media/materials.js` |
| 原版 JAR 的模型、碰撞箱与 `/summon` 初始化 | `lib/EntityModels.java`、`lib/SummonEntity.java`；Node 入口分别是 `lib/mask-java.js`、`lib/native-summon.js` |

## 两条数据流

1. **编辑与保存：** Webview 发送 `edit`（局部改动）或 `layout`（结构级改动）→ `Document.run()` 串行提交给 Node 工作线程 → `Provider` 广播 `patch`、`model` 或 `entityRows`，并为 VS Code 注册撤销/重做 → 向提交者返回 `ack` 或 `error`。预览和成功响应不等于已经写入磁盘；只有保存命令写文件。保存使用同目录临时文件并检查原文件的哈希，避免覆盖外部改动。
2. **渲染：** Webview 应用数据后，将网格所需的数据交给浏览器的网格 Worker。Worker 返回顶点，主线程负责 GPU 上传和绘制。`modelId` 区分文件快照，`epoch` 区分同一快照中的切层和材质重建；旧结果不能覆盖新视图。

几个容易改错的约定：

- 结构坐标是 `[x,y,z]`，网格索引为 `x + width * (z + depth * y)`。方块值 `0` 是无记录空位；已存方块是 `((stateId + 1) << 1) | hasNbt`，所以显式空气仍是记录。
- 局部编辑的增量包含修改前后的记录；裁剪尺寸、修改完整 SNBT 等操作用布局快照。改动一个编辑入口时检查预览、持久化和撤销是否一致。
- `media/mesh.js` 作为 Blob 形式的经典 Worker 加载，不能直接使用页面模块的静态 `import`。区块键使用 16 格的区块坐标，顶点按 `XYZ / RGB / UV` 共八个浮点数排列。
- `media/model-engine.js` 是随附第三方库，不手工重排。`scripts/build-nbt-catalog.cjs` 是 NBT 补全目录的生成脚本；生成结果和第三方许可都随插件打包。

## 验证与打包

运行时不需要安装 npm 依赖。使用 Node 执行基础测试：

```powershell
node --test test/*.test.js
```

运行核心回归测试时，用完整的 26.3 客户端 JAR 和 Java 25；不提交 JAR 或解包资源：

```powershell
$env:VOXEL_MASK_JAR = '<原版客户端 JAR 路径>'
$env:BROWSER_PLAYWRIGHT = '<Playwright 模块路径>'
# 非默认 Chrome 路径时同时设置 BROWSER_BIN
node --test test/*.test.js
node test/webview-smoke.cjs
python -X utf8 package.py
```

`test/webview-harness.cjs` 提供共用的本机测试服务器和浏览器启动配置。掩码的 Java 对照测试另外读取 `VOXEL_MASK_LIBS`：使用系统类路径分隔符（Windows 为 `;`）拼接 `lib/mask-java.json` 中 `libraries` 对应的本地 JAR 路径。单独运行界面测试可避免与其它 Java 测试抢启动资源。VSIX 输出到 `dist/`。测试使用临时结构，不需要启动游戏或写入现有存档。

## 多版本验证

`node scripts/test-java-releases.cjs <正式版客户端 JAR 目录>` 逐个检查该目录的 JAR。每个版本验证原版方块注册表、碰撞箱、掩码、旋转、实体模型、原版召唤以及 NBT 读写；未找到 JAR 或验证失败时退出非零。脚本不启动游戏、不引用用户存档。

26.3 使用完整的静态模型提交提取器；其他版本使用所选 JAR 烘焙的基础模型与贴图，不承诺完整覆盖变种、装备、动态部件或玩家头颅皮肤。未能加载原版碰撞数据时，界面提示并退回整格选取。

## 截图和发布

- 设置与浏览器测试同样的 `VOXEL_MASK_JAR`、`BROWSER_PLAYWRIGHT` 和可选的 `BROWSER_BIN`，再运行 `node scripts/capture-readme.cjs`。脚本生成工坊演示结构、启动本地 Webview 并操作真实控件，将 PNG 保存到 `docs/screenshots/`，不会打开用户存档。
- 发布时同步 `package.json`、README 的安装链接、`CHANGELOG.md` 和 Git 标签。运行测试后执行 `python -X utf8 package.py`，用 VS Code 的 **从 VSIX 安装…** 或 `code --install-extension` 验证安装，再将 `dist/` 中对应版本的 VSIX 附到 GitHub Release。
- Windows 打包时会编译 `lib/CenterCursor.cs` 以支持退出飞行后的鼠标回中；其他平台可运行其余功能，不会包含此 Windows 辅助程序。
- 只提交源码、文档、测试和演示截图，不提交本机路径、令牌、日志、游戏 JAR 或个人结构文件。`dist/` 中的旧安装包不纳入 Git。
