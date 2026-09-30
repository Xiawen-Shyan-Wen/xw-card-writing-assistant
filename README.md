# 卡片式写作案板 (Xw-Card Writing Assistant)

A card-based writing board for Obsidian: one card = one scene (INT/EXT + location + day/night, one-line action, +/- emotional shift, > < conflict). Cards can be dragged to swap or insert, batch-selected and moved, acts and columns are adjustable, and everything is written back as plain Markdown — always readable, always portable.

通用的**卡片式写作案板**：一块板分几幕，每幕钉若干张索引卡，一张卡 = 一个场景（内/外景＋地点＋日夜、一句话动作、＋/－ 情绪转变、＞＜ 冲突）。所有内容写回 Markdown 纯文本，文件永远可读、可迁移。

## 功能一览

- **15 张空白节拍卡**：不预设任何固定节奏，用什么节拍由你决定；另可在设置里**自定义节拍模板**（可增删、排序、配释义，如「角色卡」这类模块卡）
- **幕管理**：幕可改名、增删、上下移；「移动」下拉选另一幕后本幕整体移到它正下方；改名撞名时两幕**互换名字**（卡片的「幕」字段跟着对调）
- **幕折叠**：幕头 `˄` 一键把整幕收成**标题一行**（✕↑↓˄ 和「移动」跟随收进行内），再点 `˅` 展开；折叠状态随文件保存，下次打开保持原样
- **列**：每幕 1–4 列可调，每张卡自己记列号——加列不挪卡、可以拖进空列
- **卡片**：内/外景、地点、日夜、一句话「事」、＋/－ 情绪转变、＞＜ 冲突，未填的字段自动隐藏、点选填空；右上角圆点 = 状态灯兼编辑入口（墨绿 = 合规 / 桃红 = 缺项）
- **拖拽**：单卡或批量组，拖到目标卡**中腹 = 互换位置**、**靠边 = 插到前/后**（插入位置用两卡之间的线表示）；拖到空白处落到该列末尾
- **批量多选**：工具栏「批量」按钮进入，点选多张后整组拖走（互换 / 插入与单卡同款语义）
- **幕头备注**：幕名下可加多条备注，右上角悬停出现小手即可**拖动排序**（中腹=互换、靠边=插入）
- **格式刷**：先点一张基准卡，再点/框选其他卡一键统一尺寸；开着时支持拖框批量刷
- **宽/高锁定**：工具栏「锁宽」「锁高」开关——锁定后拖拽把手不能改这一维（锁宽→拖拽只能改高；锁高→只能改宽）；格式刷与弹窗手填不受限
- **汇总导出**：一键把全板「事」按编号汇成一篇；每幕可用开关选择是否参与汇总
- **自检**：一键检查缺项、节拍与幕的归属、行末铰链对位
- **色彩编码**：按人物/线索给卡上色，颜色可增删
- **新建卡尺寸**：跟随**同幕同列最后一张卡**（以案板文件为准，拖拽/弹窗/格式刷/手改文件都自动一致）；空列新卡用默认 300×176
- **统一编号**：卡片编号 = 板面视觉顺序（幕→列→从上到下），挪卡、改列数后编号自动按新位置重排，历史文件顺序不影响；导语类卡固定 00、不占号；汇总导出同一套编号

## 安装

### 方式一：社区插件商城（上架后）

Obsidian → 设置 → 第三方插件 → 浏览 → 搜索「**卡片式写作案板**」→ 安装并启用。

### 方式二：手动安装（当前版本）

1. 把 `Xw-Card-Writing-Assistant` 文件夹（含 `manifest.json`、`main.js`、`styles.css` 三个文件）放进你的库：
   `<你的库>/.obsidian/plugins/Xw-Card-Writing-Assistant/`
2. 重启 Obsidian（或 Ctrl+P 执行「重新加载应用」）
3. 设置 → 第三方插件 → 关闭「安全模式」（如未关）→ 在已安装插件里启用「卡片式写作案板」

## 快速上手

1. 左侧 ribbon 点**案板图标**，或 Ctrl+P 搜「打开案板面板」→ 新建或选择案板文件
2. 也可以把 ```xw-card-board``` 代码块嵌进任意笔记，阅读模式下笔记里直接渲染案板
3. 点「插入 15 张空白节拍卡」快速起板，或点某列末尾的「＋」逐张加卡
4. 点卡面空白处直接写「事」；点圆点补全细节
5. 写完点「汇总」导出全文，点「自检」查缺项

## 特型节拍卡：导语 / 衔接点

本插件**不预设任何节拍体系**，但有两个通用概念只要节拍名对上就会自动生效（设置 →「节拍模板」里自建同名模板即可）：

### 「导语」（开篇引子卡）

- **编号固定 00、不占号**：无论这张卡放在哪个幕、哪一列，编号永远是 00，其余卡跳过它连续排 01、02…
- **汇总导出时自动排全文最前**（编号 0）
- **自检豁免**：导语是引子卡，不参与「一场戏 / 情绪转变 / 冲突」四条硬要求检查，状态灯不会因它缺项报警
- 建议：释义可填「开篇引子：几句话把读者勾进来，垫定全篇的语气」

### 「衔接点」（转场卡）

- 自动带**「转折点」标记**（卡面节拍旁出现标签）
- 建议：释义可填「通用转场卡：标记故事从一个段落进入下一个段落」

> 注：名字必须**一字不差**（「导语」两个字，不要带【】或其他前后缀）。配合「插入 15 张空白节拍卡」起板时，把其中一张的节拍改成「导语」就是引子卡。

## 文件格式说明

案板文件是普通 Markdown。卡片就是标准小节，插件用几行 **HTML 注释**记录板面元信息，都不影响正常阅读：

| 注释行 | 含义 |
|---|---|
| `<!-- stc:acts: ... -->` | 各幕的幕名（顺序即板面顺序） |
| `<!-- stc:cols: ... -->` | 每幕的列数 |
| `<!-- stc:hinge: ... -->` | 每幕**行末铰链**（该行最后一张卡预期的节拍），供「自检」对位用 |
| `<!-- stc:actnotes: ... -->` | 幕头备注 |
| `<!-- stc:summary: ... -->` | 哪些幕不参与汇总（有才写） |

> 注：这些 `stc:` 注释是插件的历史内部标记，不影响使用，也不指向任何第三方作品。

## 常见问题

- **改幕名提示重名？** 幕名是卡片「幕」字段的关联键，不能有两幕同名。改成已存在的名字时会**自动两幕互换名字**——例如「第二幕」移到第三位后改名「第三幕」，原第三幕自动变回「第二幕」。
- **节拍下拉里是什么？** 15 张空白节拍（节拍01–节拍15），不预设任何写作流派的具体节奏；想要自己的节拍体系，在设置的「节拍模板」里添加即可。
- **幕移动后卡号会乱吗？** 不会。挪幕时卡片编号按板面显示顺序即时重排（导语类卡固定 00、不占号）。
- **想要「导语」卡（开篇引子）？** 在设置 →「节拍模板」里自建一个名字精确为「导语」的模板，之后把卡的节拍选成它即可——编号固定 00、不占号、汇总导出自动排全文最前、自检豁免。详见上方「特型节拍卡」一节。

## English

**About.** A card-based writing board for outlining stories. One card = one scene
(INT/EXT + location + day/night, a one-line action, a +/- emotional shift, a > < conflict).
Everything is written back into the note as plain Markdown, so your files stay readable,
diff-able and portable — no proprietary format, no lock-in.

**Features**

- **Cards = scenes**: card face holds the scene header, the one-line action, the emotional shift and the conflict; empty fields hide themselves.
- **Drag & drop**: drag a single card onto another to swap, or to its edge to insert (insertion point is shown as a line between two cards); batch-select several cards and move them as a group.
- **Acts & columns**: rename, add, remove, reorder or collapse acts; 1–4 columns per act; drag-sortable notes under each act name.
- **Beat cards**: 15 blank beat cards — no built-in story system; define your own beat templates in settings. Two special names work automatically: 「导语」 (prologue card, always number 00, exported first) and 「衔接点」 (transition card, marked as a turning point).
- **Format painter, width/height locks**, new cards inherit the size of the last card in the same act/column.
- **Unified numbering** by board order (act → column → top to bottom), renumbered automatically when cards move.
- **Summary export** (all "action" lines in order) and a **self-check** panel for missing fields, hinge alignment and stray cards.
- **Colour coding** per character/thread, editable in settings.
- Mobile supported; light and dark themes; **no network access, no telemetry, no analytics**.

**Install (manual)**

1. Put the `Xw-Card-Writing-Assistant` folder (`manifest.json`, `main.js`, `styles.css`) into `<your vault>/.obsidian/plugins/`.
2. Reload Obsidian, then enable "卡片式写作案板" in Settings → Community plugins.

**Usage**

1. Click the board icon in the ribbon (or run the "打开案板面板" command) and pick a board file, or embed a ```` ```xw-card-board ```` code block in any note.
2. Use "插入 15 张空白节拍卡" to start, or the `＋` at the end of a column to add cards one by one.
3. Click a card to write its action text; click the dot in its top-right corner to edit all fields.
4. Use "汇总" to export the whole board as text and "自检" to check for missing pieces.

## 更新日志（V1.0.01）

- 首个公开发布版本。
- 卡片式写作案板：一张卡 = 一个场景，支持拖拽互换/插入（插入位置用线表示）、批量多选整组移动、幕/列数可调、幕折叠、幕头备注拖动排序。
- 格式刷刷尺寸、宽/高锁定、新建卡跟随最近调整的尺寸、卡片统一编号（板面视觉顺序）。
- 15 张空白节拍卡 + 自定义节拍模板；「导语」「衔接点」特型节拍卡。
- 状态灯提示缺项、汇总导出与一键自检；全部写回 Markdown 纯文本。

## 许可证

MIT
