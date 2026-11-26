# Voxel NBT Studio

在 VS Code 里用 3D 界面查看和编辑 Minecraft Java 的结构 `.nbt`。

[下载 VSIX](https://github.com/KiralasuKi/voxel-nbt-studio/releases/latest)

![Voxel NBT Studio 编辑界面](https://raw.githubusercontent.com/KiralasuKi/voxel-nbt-studio/main/docs/screenshots/overview.png)

兼容测试范围：Java 版 **1.21（含）至 26.3 的 17 个正式版**，不含快照。旧版实体为简化静态预览，部分类型显示占位框。

## 安装并打开结构

1. 下载 `.vsix`，在 VS Code 的扩展面板菜单中选择 **从 VSIX 安装…**，安装后重载窗口。
2. 右键 `.nbt` 文件，选择 **用 Voxel NBT Studio 打开**。要从零开始，在命令面板运行 **Voxel NBT Studio: 新建 NBT 结构**。
3. 想看原版材质，打开 **设置 → 原版资源**，选择本机的 Minecraft **客户端 JAR**，或点 **使用官方源** 获取 Java 1.21–26.3 正式版。客户端下载到插件数据目录的 `versions/<版本>/<版本>.jar`，Java 依赖下载到同目录下的 `libraries/` 并跨版本复用。依赖和名称映射都校验后才完成下载。也可以先用色块编辑。建议选择与结构版本一致的 JAR。精确选取、原版状态掩码、实体功能和版本升级需要 Java 依赖和 JDK。使用官方源会补齐依赖，但不会安装 JDK：1.21 系列需要 21 或以上，26.x 需要 25 或以上。

打开结构时会先比较 DataVersion。已选 JAR 匹配就直接打开；不匹配时优先使用已下载的匹配官方 JAR（只对该结构生效），没有缓存才询问。选择**不使用**原版资源时仍可用色块模式。

用右上角的 **升级结构** 选择更高的正式版，再选择创建同目录副本 `原名_版本.nbt` 或覆盖原文件。确认不可降级后才会执行。已编辑的结构可直接升级副本；要覆盖原件，请先保存并关闭重开，以免破坏撤销历史。
4. 点 **保存** 或按 `Ctrl+S` 写入文件。误操作可用 `Ctrl+Z` 撤销。

## 看模型、改方块

- **看模型：** 拖动视角、滚轮缩放；右侧可以切层。按 `F` 进入第一人称飞行，`WASD` 移动、空格上升、`Shift` 下降、`Esc` 退出。鼠标习惯、亮度和快捷键可在 **设置** 调整。
- **放置／涂刷／擦除：** 在调色板或画笔栏选方块，按 `2` 放在相邻格、`3` 替换现有方块、`4` 擦除。可按住鼠标拖动；按 `5` 从结构中取样。常用画笔可保存成预设。
- **空气和空位：** 画布聚焦时按 `Tab` 显示隐形方块。红色是没有方块记录的空位，蓝紫色是已写入的空气。擦除会留下空位；想在游戏放置结构时清掉地形，要用空气填充。
- **调色板和尺寸：** 在 **方块 → 管理调色板变体** 增删调色板、更新槽位或清理未使用项；在 **工具 → 结构** 修改尺寸。只改某一格的状态时，用取样后的 **检查 → 单块状态**。

## 批量编辑和复制

1. 按 `B`，拖出范围或点两个对角；双击选单格。可用 `Alt` + 滚轮调整选区上边界，加 `Shift` 调下边界。
2. 点 **填充选区** 换方块，拖箭头移动、拖圆环旋转。要沿一个方向复制延伸，改用 `S` **挤出**。只想替换某些方块，就在 **编辑谓词…** 中设置掩码（需要 JAR）。
3. 按 `Ctrl+C` 复制选区，`Ctrl+V` 后点击落点。可移动或旋转半透明蓝图，再按 `Enter` 放置；模板列表也可将副本另存为 `.nbt`。覆盖和白名单在 **工具 → 移动与覆盖** 设置。

![框选及移动、旋转手柄](https://raw.githubusercontent.com/KiralasuKi/voxel-nbt-studio/main/docs/screenshots/box-tools.png)

## 编辑 NBT 和实体

- **箱子、拼图方块、刷怪笼等：** 按 `5` 取样，在 **检查** 里修改方块状态和方块实体 NBT。点蓝色 `+` 添加字段、`−` 删除字段，再点 **应用 NBT**。旧结构如果缺少数据，可以先点 **初始化方块实体**。
- **普通实体：** 在 **实体** 页选中或新增实体，可编辑 NBT、拖动平移、水平旋转、复制或删除。导入 JAR 后可预览支持的模型，包括玩家模型、画和展示框。批量复制时，可在框选里勾选 **包含实体**。
- **全文 SNBT：** 点击右上角 **SNBT** 编辑整个结构。字段控件和 SNBT 支持补全；应用后仍需保存。

![取样箱子并编辑字段](https://raw.githubusercontent.com/KiralasuKi/voxel-nbt-studio/main/docs/screenshots/block-nbt.png)

![实体预览与编辑](https://raw.githubusercontent.com/KiralasuKi/voxel-nbt-studio/main/docs/screenshots/entities.png)

## 用指令编辑

按 `/` 打开命令栏，支持 `/setblock` 放置、`/fill` 区域填充和 `/summon` 新增实体（需要 JAR）。`Tab` 补全，`Enter` 执行。可以直接输入坐标，也可以点 **取坐标** 后点画布；绿色边框显示目标格，按住 `Alt` 取命中面外侧一格。`/fill` 可连续点两个角。

![命令取坐标预览](https://raw.githubusercontent.com/KiralasuKi/voxel-nbt-studio/main/docs/screenshots/commands.png)

---

本项目主要由 GPT 6.2 Sol 生成式 AI 开发

[MIT License](LICENSE) · [第三方许可证](media/licenses/) · [开发指南](DEVELOPMENT.md) · [更新日志](CHANGELOG.md)
