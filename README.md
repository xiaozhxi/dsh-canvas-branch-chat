# 画布分叉聊天 · Branching Canvas

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一个把 DSH 对话变成「可自由分叉的画布」的插件。每个回答是一张卡片，卡片之间用线连接；你可以从任意一张卡片继续追问、拖动画布、缩放、发散出新的方向，而不是被锁在一条上下滚动的聊天记录里。

- GitHub：<https://github.com/xiaozhxi/dsh-canvas-branch-chat>
- 包名：`dsh-canvas-branch-chat`（尚未发布到 npm；请从 GitHub 安装）
- DSH 插件 id：`dsh-canvas-branch-chat`

## 它和普通聊天的区别

- **不是一条线**：每张卡片保存一个问题 + 一个回答，卡片之间记录父子关系。
- **任意分叉**：在任意卡片底部点「从这里继续」，就会从该卡片长出一个新分支。
- **自由布置**：拖动卡片顶部、拖动空白画布、滚轮缩放，画布会记住你的视角。卡片移动后，连接线会从两张卡片相对最近的上、下、左、右侧重新引出，不会被拉成长长的绕圈线；临时对话使用暖色点线，和主分支区分。
- **可回看**：放大阅读完整回答，代码块、表格、列表都会渲染。
- **图片、文本和 Office 文档**：可以给任意一条消息附加图片、txt / md / csv / json / 代码等文本文件，或 Word（`.docx`）、PowerPoint（`.pptx`）文档。Word / PPT 会提取正文、表格和幻灯片备注，作为当前问题的上下文。
- **导出 Word / PPT**：卡片底部的「导出」可以把当前回答、整条分支或一段已保存的临时对话整理成新的 Word 文档或 16:9 PPT。
- **多张画布**：每张画布是一棵独立的树，适合按主题分开。
- **多个画布并行生成**：在画布 A 发起回答后可以立刻切到画布 B；生成在后台继续，完成后自动保存回画布 A，不会因为切换而丢失。顶部的「N 个生成中」会显示后台任务数量。
- **临时追问**：选中任意回答里的一段文字，可以直接「针对这段提问」/「翻译」/「解释」。临时追问会带上原回答的完整语境，默认不写入画布；回答后可以点面板右上角的「保存到画布」，把它变成一张暖色虚线卡片，与主分支独立。之后可以随时点卡片上的「继续追问」接着问。
- **大画布导航**：`Ctrl/Cmd + F` 搜索所有问题与回答；卡片上的聚焦按钮只展示当前分支的路径和下游，其他节点淡化；顶部面包屑显示当前节点所在路径；小地图和 1:1 缩放帮助定位。
- **文档进出**：上传 `.docx` / `.pptx` 作为上下文；也可以把一条回答或整条分支导出成新的 Word / PPT。第一版只读取文字和新建文档，不修改原文件的版式。
- **真正接入 DSH**：模型列表、默认模型、服务商和密钥全部来自 DSH 自己的 `llm` 服务；插件不复制、不保存任何 API Key 或 Base URL。

## 安装

### 从 GitHub 安装

需要已经安装 DSH，并且是带 Web UI 的版本。

```bash
git clone https://github.com/xiaozhxi/dsh-canvas-branch-chat.git
cd dsh-canvas-branch-chat
npm ci
```

然后在 DSH 的插件管理里，把这个目录作为**本地 bundle** 安装。安装后刷新 DSH Web 页面，左侧面板会出现「画布分叉聊天」。

> 不要把 `node_modules/` 提交到 Git 仓库；它只用于本地运行，`package-lock.json` 会锁定依赖版本。
>
> 如果只克隆而不执行 `npm ci`，Word / PPT 相关的 `docx`、`mammoth`、`pptxgenjs` 等依赖会缺失，插件启动时会报模块找不到。

### 本机开发安装

当前开发目录也可以直接作为本地 bundle 安装：

```text
<你克隆下来的仓库目录>
```

在 DSH 的插件管理里选择该目录即可；修改 Client 代码后刷新页面，修改 Host 代码后让插件重新加载。

> 需要 DSH Web 环境。插件注册了一个受 DSH 浏览器会话保护的本机 HTTP 路由，因此必须通过 DSH 页面访问。
>
> 如果从旧包名 `@local/dsh-canvas-chat` 升级，安装新包后请重启一次 DSH；旧标签页的启动清单可能缓存旧包名，重启后会消失。

## 使用

1. 打开左侧「画布分叉聊天」。
2. 在中央输入框输入第一个问题，按 Enter 或点「发送」。
3. 回答完成后：
   - 点卡片底部的「从这里继续」，从该卡片继续追问；
   - 点卡片右上角的「放大阅读」，看完整回答；
   - 拖动卡片顶部移动卡片；
   - 拖动空白处平移，滚轮缩放；
   - 双击空白处，在指定位置新建一个独立话题。
4. 选中回答中的一段文字，会弹出「针对这段提问 / 翻译 / 解释」；选择后右侧出现暖色的「临时追问」面板。它继承原路径的完整上下文，但默认只留在面板里，不写入画布。回答后若想留下，点面板右上角「保存到画布」；它会变成一张独立的暖色虚线卡片。之后点卡片上的「继续追问」，面板会带着已保存的全部临时问答重新打开，继续问完再点「更新画布」即可。
5. `Ctrl/Cmd + F` 搜索画布；点击结果会定位到对应卡片。卡片右上角的聚焦按钮可以只保留当前分支的路径与下游，其他内容淡化。
6. 顶部「新话题」会新建一个不继承任何上下文的起点。
7. 顶部画布名称可以切换 / 重命名 / 删除画布。切到另一张画布时，未完成的生成会继续在后台运行，完成后自动保存。
8. 输入框左侧的回形针按钮可以添加图片、文本文件、Word 或 PPT；也可以直接把图片粘贴进输入框。添加后会显示缩略图 / 文件名 / 文档页数或字数，发送前可以移除。
9. 点卡片底部的「导出」，选择 Word 或 PowerPoint、导出范围（仅这条回答 / 整条分支）和标题，生成后点「下载」。已保存的临时对话卡片也可以单独导出。

### 图片、文本和 Word / PPT

- 图片支持 PNG、JPEG、WebP、GIF，单张不超过 8 MB，每条消息最多 4 个附件。
- 文本文件支持 `txt`、`md`、`csv`、`json`、`yaml`、`log` 和常见代码后缀，单个不超过 2 MB；文本需要是 UTF-8 编码。
- Word 支持 `.docx`，PPT 支持 `.pptx`，单个不超过 16 MB；旧版 `.doc` / `.ppt` 请先另存为新格式。PDF、Excel 暂不支持。
- Word 会提取段落、标题、列表和表格；PPT 会按幻灯片提取标题、正文和演讲者备注。文档里的图片不会被识别，扫描件或纯图片 PPT 提取不到文字。
- 文档原文会保存在 `$DSH_HOME/canvas-chat/files/`，刷新页面后仍能看到附件；提取出的文字会随当前问题进入上下文，过长内容会截断。
- 图片会存入 DSH 的附件服务，并随消息发送。**只有模型本身支持图片输入时才有用**；可在 DSH 的模型配置里确认 `input` 包含 `image`。
- 导出会生成新的 `.docx` / `.pptx`，不会改动原文件。临时文件保存在 `$DSH_HOME/canvas-chat/exports/`，只保留最近 40 份。

快捷键：输入框内 `Enter` 发送，`Shift+Enter` 换行；`Ctrl/Cmd + F` 搜索画布；`Esc` 关闭输入框、搜索或弹窗；缩放条上的 `1:1` 回到实际大小。

### 临时追问与并行生成

- 临时追问默认是**纯客户端临时状态**：不进画布、不进节点树、不写入画布 JSON；关闭面板或刷新页面后消失。
- 点「保存到画布」后，会把它作为一张 `kind: "aside"` 的独立卡片写入画布；卡片带暖色虚线边框和虚线连接线，不进入主对话的父子路径，也不影响从原节点继续分支。
- 保存后的卡片可以随时点「继续追问」：面板会载入已保存的全部临时问答，并继续沿用原节点的主对话上下文；问完点「更新画布」覆盖同一张卡片，不会重复生成。
- 已保存的临时对话也可以聚焦、拖动、查看全文或删除；删除它不会影响主分支。
- 每一次临时追问都会把「原节点到根节点的完整上下文 + 已选片段 + 面板内历史」一起发送，因此可以围绕一个词连续追问，同时不污染主对话。
- 临时追问使用当前顶部选中的模型；和主对话一样，模型和密钥来自 DSH 的 `llm` 服务。
- 切换画布不会中断后台生成。后台完成的画布会单独保存，不会把流式内容串到当前画布；页面刷新或关闭才会中断尚未完成的流。
- 并行生成的数量显示在顶部；每个画布各自保存，互不覆盖。

## 模型

- 首次打开会读取 DSH 当前配置的模型列表和默认模型。
- 顶部模型按钮可以切换服务商 / 模型；搜索框支持按模型名或服务商过滤。
- 每张卡片记录自己使用的服务商和模型，因此不同分支可以使用不同模型。
- 如果 DSH 里更新了模型配置，重新打开画布或刷新页面即可看到。

## 数据保存在哪里

画布是普通 JSON 文件，保存在：

```text
$DSH_HOME/canvas-chat/boards/<board-id>.json
$DSH_HOME/canvas-chat/files/<attachment-id>.<ext>
$DSH_HOME/canvas-chat/exports/<export-id>.<docx|pptx>
```

Windows 默认是 `C:\Users\<你>\.dsh\canvas-chat\boards\`。

> 数据目录和 HTTP API 路由仍沿用 `canvas-chat`，所以从旧包名升级到 `dsh-canvas-branch-chat` 不会迁移或丢失已有画布。

- 每个画布一个文件，删除画布就是删除对应文件。
- 临时追问默认只在当前页面内存中，不写入画布文件；点「保存到画布」后会作为独立节点写入对应画布 JSON，刷新后仍保留。
- 后台生成期间的中间结果在浏览器内存里，完成后才写入对应画布；刷新页面会中断尚未完成的流。
- 保存采用临时文件 + rename 的原子写入，避免半截文件。
- 上传的附件副本在 `files/`；删除节点或画布时目前不会自动清理孤儿附件。
- 导出的文档在 `exports/`，每次导出后只保留最近 40 份；下载到本地后与画布数据无关。
- 卸载 / 重装插件不会删除这些数据。

## 安全边界

- 所有 `/canvas-chat/api/*` 请求都会先经过 DSH 的 `connection.admit()` 校验，未携带 DSH 会话凭证的请求返回 `401`。
- 插件不读取、不转发、不落盘模型密钥。
- 模型调用由 Host 侧的 `ctx.llm` 发起，密钥只在 DSH 进程内使用。
- 画布内容只保存在本机数据目录，不会上传到插件作者或第三方。

## 结构

```text
dsh-canvas-branch-chat/
├─ package.json          bundle 清单与 dsh.client 声明
├─ cordis.patch.yml      插入 dsh-canvas-branch-chat 插件行
├─ index.js              Host：HTTP API、画布读写、ctx.llm 流式调用
├─ documents.js          DOCX / PPTX 解析与 Word / PPT 生成
├─ client.js             Client：React 画布、节点、模型选择、Markdown
├─ icon.svg              侧边栏图标
├─ locale/zh.json        中文元信息
├─ locale/en.json        英文元信息
├─ LICENSE               MIT 许可证
├─ .gitignore            排除 node_modules 等本地文件
└─ .gitattributes        统一文本换行
```

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/canvas-chat/api/health` | 存活检查 |
| GET | `/canvas-chat/api/bootstrap` | 模型目录 + 画布列表 |
| GET | `/canvas-chat/api/models` | 刷新模型目录 |
| GET | `/canvas-chat/api/board?id=` | 读取一张画布 |
| POST/PUT | `/canvas-chat/api/board` | 保存画布 |
| DELETE | `/canvas-chat/api/board?id=` | 删除画布 |
| POST | `/canvas-chat/api/upload` | 上传图片 / 文本 / Word / PPT |
| GET | `/canvas-chat/api/file?id=` | 读取已上传附件 |
| POST | `/canvas-chat/api/export` | 生成 Word / PPT |
| GET | `/canvas-chat/api/export-file?id=` | 下载生成的文档 |
| POST | `/canvas-chat/api/chat` | NDJSON 流式对话 |

`/chat` 返回 `application/x-ndjson`，事件类型包括 `start`、`text`、`reasoning`、`usage`、`finish`、`error`、`aborted`、`done`。

## 开发

- Host 侧是普通 ESM，`node --check index.js` 可做语法检查。
- Client 侧通过 `window.__ModuleLoader__.load({ id, factory })` 动态加载，React 从宿主模块表取得。
- 修改 `client.js` 后刷新页面即可；修改 `index.js` 后需要让插件重新加载（或在插件管理里关闭再开启）。
- 画布节点上限 600 个，单个回答上限 120k 字符，画布文件上限 1.5 MB。
- 图片附件上限 8 MB，文本附件上限 2 MB，Word / PPT 上限 16 MB；文本内容最多 50k 字符进入上下文，跨分支总文本预算约 90k 字符。
- 文档解析成 Markdown 后进入上下文；Word 使用 `mammoth` + `turndown`，PPT 使用 `jszip` 读取 OOXML；导出使用 `docx` 和 `pptxgenjs`。全部为纯 JS，不依赖 LibreOffice 或 Office。

## 已知限制

- 仅支持 DSH Web；不提供独立网页或 iframe。
- 画布是单机文件存储，不做多端实时同步。
- 一张画布内的节点是树状父子关系；暂不支持把两个已有分支合并成一个节点。
- 搜索和聚焦只作用于当前画布，不跨画布检索。
- 临时追问只在当前页面保留；除非点「保存到画布」，否则刷新后不会恢复。保存后的临时对话是独立卡片，可以继续追问，但不会生成主分支节点，也不会进入其他分支的上下文。
- 超大画布缩小到最低 28% 时文字会很小，建议用 `Ctrl/Cmd + F` 搜索定位，或用聚焦按钮只看一条分支。
- 超长代码在窄卡片里会自动换行；需要完整阅读时请用「放大阅读」。
- 图片需要模型本身支持视觉输入；不支持时 DSH 会用占位文本替代。
- 暂不支持 PDF、Excel、旧版 `.doc` / `.ppt`；请先转成 `.docx` / `.pptx` 或文本。
- Word / PPT 只提取文字、表格和演讲者备注，不识别文档里的图片；扫描件和纯图片幻灯片会读不到内容。
- 导出会新建文档，不保留原 Office 文件的版式；适合把对话整理成可继续编辑的文字稿或演示稿。
- 删除节点或画布不会清理 `canvas-chat/files/` 里的孤儿附件；导出文件只保留最近 40 份。

## 许可证

本项目使用 [MIT License](LICENSE)。

你可以自由使用、修改、分发和商用，但需要保留版权声明和许可证文本；软件按“原样”提供，不附带担保。

## 仓库

- GitHub：<https://github.com/xiaozhxi/dsh-canvas-branch-chat>
- 问题反馈：<https://github.com/xiaozhxi/dsh-canvas-branch-chat/issues>