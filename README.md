# 🎨 dsh-canvas — 画布工作流

给 DSH 加一个**类 n8n / Dify 的可视化画布**：拖节点、连线、点运行、节点实时亮。
而且**对着画布说一句话，它就能自己画出一张工作流**。

> **核心思路**：画布只是外壳，**引擎已经有了** —— 内核自带 workflow 服务，本插件做的是给它配一个画布前端。外壳自研（自绘 SVG，零第三方依赖），引擎复用内核现成的 workflow 服务。

---

## 📦 安装

**前置**：DSH **0.2.x**（官方桌面端）+ Node.js。

1. 把本目录放到任意位置，例如 `~/.dsh/plugin-stash/dsh-canvas`

2. 在你用的 profile 的 `package.json` 的 `dependencies` 里加一行（路径按实际改）：

   ```json
   "dsh-canvas": "file:C:/Users/你/.dsh/plugin-stash/dsh-canvas"
   ```

3. 同一个 profile 的 `cordis.patch.yml`（**顶层数组**）末尾追加：

   ```yaml
   - insert:
       - id: canvas
         name: 'dsh-canvas'
   ```

4. 在该 profile 目录里跑 `pnpm install`（官方桌面端的 profile 由 pnpm 托管）。

5. **完全重启 DSH** —— 客户端插件按启动快照服务，按 F5 可能拿到过期 bundle。
   打开后页面**右下角出现 🎨 画布 浮动按钮**。

卸载：删掉上面那两处，再 `pnpm install` + 重启。

---

## 🧷 依赖与前置条件

| 依赖 | 说明 |
|---|---|
| DSH **0.2.x** | 引擎用的是**内核自带**的 `workflow` / `subagents` / `agents` 服务；本插件不自带引擎 |
| Node.js | 跑自检脚本，以及图像节点要调的外部脚本 |
| 图像 API 钥匙（仅图像节点需要）| 文生图要 `ZHIPU_API_KEY`，改图要 `DASHSCOPE_API_KEY`（或 `MODELSCOPE_API_KEY`）。**两个脚本已随本包分发**，不用自己准备 —— 见下「🔓 完整功能解锁」 |

- **产物缩略图白名单**：`/asset` 只允许读白名单目录里的图片，默认是
  `~/.dsh/plugin-data/dsh-canvas/images`、`D:\dsh-media\images`、`D:\dsh-media\edits`、`D:\dsh-work\qwen-image-edit\out`。
  你的产物目录不一样就用环境变量覆盖（多个路径用系统分隔符，Windows 是 `;`）：
  `DSH_CANVAS_ASSET_ROOTS=路径A;路径B`

---

## 🔓 完整功能解锁

**开箱可用**：装完就能拖节点、连线、点运行、对画布说话生成工作流、用人工审批门 —— 引擎是内核自带的，**这部分零配置**。

**只有「图像节点」需要解锁。** 它在编译期会被翻译成「让子代理去执行一个本机脚本」，所以得给脚本配钥匙：

| 节点 | 干什么 | 走哪个脚本 | 要哪把钥匙 |
|---|---|---|---|
| `image`（文生图）| 按提示词出图 | 包内 `lib/gen-image.mjs`（智谱 BigModel）| **`ZHIPU_API_KEY`** |
| `edit`（改图）| 拿参考图改 | 包内 `lib/image-edit.mjs` → `dashscope`（默认，快枪手）| **`DASHSCOPE_API_KEY`**（阿里百炼）|
| `edit` + 把 provider 改成 `modelscope` | 同上，免费但要排队 | 魔搭 `Qwen/Qwen-Image-Edit-2509` | `MODELSCOPE_API_KEY` |

**两个脚本已经随插件分发**（旧版要你自己往 `~/.dsh/` 放 —— 现在不用了）：

- 插件**优先用你自己那份** `~/.dsh/image-edit.mjs` / `~/.dsh/gen-image.mjs`，没有才用**包内副本** —— 不会覆盖或绕过你改过的东西。
- 包内副本做过**可移植化**：默认产物目录是 `~/.dsh/plugin-data/dsh-canvas/images`（不再是写死的 `D:\dsh-media\images`），可用 `DSH_IMAGE_DIR` 覆盖。

**配钥匙**（Windows 用户级环境变量，配一次长期有效）：

```powershell
setx ZHIPU_API_KEY "你的智谱 key"        # 文生图节点必需
setx DASHSCOPE_API_KEY "你的百炼 key"    # 改图节点必需（默认 provider）
```

> 脚本从**进程环境变量**或**用户级环境变量**读取，**不回显、不落盘**；凭据属于你自己的环境，**不要写进插件目录**。
> 配完要**重启 DSH**（它启动时才读环境变量）。

**自检**（确认钥匙通了）：

```bash
node lib/image-edit.mjs providers     # 打印哪家钥匙在、端点通不通
```

**顶多再调一处**：产物缩略图白名单 `DSH_CANVAS_ASSET_ROOTS`（见上一节）—— 只有当你把图像节点产物输出到别的目录时才需要。

---

## 🚀 怎么打开

DSH 页面**右下角有个「🎨 画布」浮动按钮**，点它。

面板可以**拖边界调大小**（四边四角，鼠标移到边缘会变双向箭头），**画布会跟着面板一起长大**。

---

## 🧩 八种节点

编译器 `NODE_TYPES` 支持 8 种类型：

| 节点 | 颜色 | 干什么 | 关键字段 |
|---|---|---|---|
| **起点 `trigger`** | 绿 | 流程的初始输入。**它本身不执行任何东西**，只把一段文本作为起点（全图恰好一个）| `data.prompt` |
| **子代理 `agent`** | 蓝 | 起一个子代理干活、产出文本。可设「只输出结果」与「失败重试 N 次」| `data.prompt`、`label`、`terse`、`retry`(0-5) |
| **代码 `code`** | 黄 | 内联 JS 片段。上游放在 `inputs` 对象里，`return` 什么就是本节点的值 | `data.code` |
| **判断 `condition`** | 红 | 多路分支。**每条出边自己带一个条件**，从上往下试，全不中走兜底；条件是 **JS 表达式** | 节点 `data.expr` 或出边 `edge.expr` |
| **并行 `parallel`** | 青 | 它的每条分叉**同时**执行，全部完成才继续；出边即分叉 | 出边即分叉 |
| **审批 `approval`** | 青绿 | **跑到这里停下**，弹一张审批卡片等人点「通过 / 拒绝」，通过才继续 | `data.note` |
| **图像 `image`** | 粉 | 带固定剧本的子代理，调用本机脚本出图 / 改图 | `data.prompt`、`image`、`provider`、`model`、`out` |
| **输出 `output`** | 紫 | 工作流的返回值（至少一个）| 无 |

> AI 生成侧（`generate.js` 的 `TYPES`）只允许 `trigger / agent / code / condition / output` **5 种**，且提示词要求节点不超过 8 个。

### 值怎么在节点间传

- 提示词里写 `{{节点id}}` → 引用任意上游的值
- **没写引用**时自动把「数据上游」的结果拼到提示词后面（形如 `【上游 nX】`）
- `code` / `condition` / `parallel` 的 `inputs` 里能拿到**所有祖先**的值（判断里引用写成 `inputs.<id>`）
- **控制流节点会被穿透**：判断/并行不是数据源，拼上游时会跳过它们、用它们的数据上游顶上

---

## 🖱 画布操作

| 操作 | 怎么做 |
|---|---|
| 加节点 | 工具条 `＋起点 / ＋子代理 / ＋代码 / ＋判断 / ＋并行 / ＋审批 / ＋输出` |
| 移动节点 | 直接拖 |
| 连线 | 从节点**右侧圆点**拖到目标节点 |
| 选 / 删连线 | 点连线（变红虚线）→ 按「删除连线」；或**双击直接删** |
| 删节点 | 点中节点 → 「删除选中」（连带它的边一起删） |
| 改内容 | 点中节点 → 下方属性条改（提示词 / 条件 / 代码 / 审批说明 / 重试次数 / 只输出结果） |
| 调分支顺序 | 点选判断的出边 → 属性条里 `↑上移` `↓下移` |
| 删存盘 | 「📂 载入」列表里每项右边有 🗑 |

---

## 🛠 工具条

| 按钮 | 作用 |
|---|---|
| `📋 模板` | 四个**能直接跑**的现成流程：一句话问答 / 三档分级 / 并行写手 / 链式判断 |
| `💾 存盘` | 存到 `~/.dsh/plugin-data/dsh-canvas/graphs/` |
| `📤 导出` / `📥 导入` | 下载 / 上传 `.json`，可以分享给别人 |
| `🕘 历史` | 最近 30 次运行（时间 · 状态 · 结果摘要 · 节点数），可清空 |
| `📂 载入` | 读回存过的画布 |
| `✨ AI 生成` | **写一句话，它画一张图** |
| `▶ 运行` / `■ 停止` | 跑 / 停 |
| `重置` / `收起` | 恢复默认演示图 / 收起面板 |

---

## ✨ AI 生成

点 `✨ AI 生成` 写一句话，例如：

> 抓取一个网页，总结成三句话，如果里面有「降价」就再发一条提醒

十几秒后一张图就铺到画布上了 —— 可以直接 ▶运行，也可以拖拖改改。

**它背后做的**：把你的话交给一个子代理 → 要它吐出图 JSON → 抠出来 → 补 id、剔悬空边、缺坐标自动排版 → **再用编译器验一遍**（不合格当场报错，不让你点了运行才发现坏）。

对应接口：`POST /generate` → `buildGenerateScript()` → `tools.execute` 跑一次 `agent()` → `extractGraph` 抠 JSON → `normalizeGraph` 规整排层 → 再 `compile` 预校验。

---

## ⏸ 人工审批怎么用

```
起点 → 子代理(写草稿) → ＋审批(填"草稿行不行？") → 子代理(润色) → 输出
```

点运行之后：

1. **第一段**跑到审批点、产出结果
2. **停下** —— 画布显示「⏸ 等待审批中」，**会话里弹出一张审批卡片**（带待审内容预览）
3. 点「**通过**」→ 第二段接着跑（拿第一段的结果当起点）；点「**拒绝**」→ 整个流程标记为被拒
4. 全程进运行历史

**它为什么能停住**：内核的 workflow 脚本**没有暂停机制**（实测确认：worker 只注入 6 个全局、宿主↔worker 无数据通道、stopReason 是封闭三值）。所以插件把图**按审批点切成两段**，让"等待"发生在**段与段之间** —— 那时没有 worker 存在，**等多久都不会被杀，也不烧 token**。

用的就是 `exit_plan_mode` 那套内核级机制（`ctx.userQuestions.ask()`）。

---

## 🔧 运行结果怎么看

跑完之后，画布和日志之间会出现一块**结果面板**：

```
┌──────────────────────────────────────┐
│ ✅ 运行结果                      [收起] │
│ 深海并非黑暗的渊薮，而是这颗星球…       │   ← 大字、可选中复制
│ 走了 n1 → b · 1 个子代理               │
└──────────────────────────────────────┘
```

失败时是**红框 + 错误信息**；原始返回值仍完整留在底部日志里。

**节点高亮**：跑的时候子代理节点变黄（脉冲），完成变绿、失败变红 —— 靠轮询内核的 `subagents` 服务实现（因为 `workflow/*` 事件在 agent realm 内发出，realm 外的插件收不到）。

---

## 🧬 技术内幕（三个关键决定）

| 决定 | 为什么 |
|---|---|
| **借道 `tools.execute` 跑工作流** | `workflowEngine` 服务在**每个 agent 会话自己的 realm** 里，全局插件既 `ctx.get` 不到、`inject` 也等不到。而 `tools` 是全局的，workflow 工具本身也在那个 realm 里注册 —— "借道工具"就能把脚本送进引擎 |
| **审批用 `userQuestions.ask()`** | 它**恰好全局可见**（不在 isolate 组里），而且那正是 `exit_plan_mode` 在用的机制 |
| **切段 / 模板 / AI 生成最后都交给同一个 `compile()`** | 不另写生成器 → agent / 判断 / 并行 / 重试 / terse 的行为**只有一份实现**，不会两边走偏 |

Host 用**两层 `inject`**：第一层只依赖 `webServer`（基础路由永远挂得上），第二层才等 `workflowEngine`；`ctx.get('workflowEngine')` 因惰性激活会返回 `undefined`，故不能拿它当判据。

---

## 🏗 编译 / 执行流程

1. **`compile(graph)`**：校验图（非空、id 唯一、类型合法、变量名不撞、恰 1 个 trigger、≥1 个 output、无悬空边/自环、Kahn 拓扑排序查环、可达性），再把每个节点生成成一行行 JS，输出 `{ script, meta, order, warnings, nodesById, imageTmp }`。`meta.phases` 与脚本里的 `phase()` 逐字对应，供前端高亮。
2. **含审批时改走 `compileSplit`（单门）/ `compileSplits`（多门）**：按审批门把图切成 N+1 段，段间用一个临时 `trigger`/`output` 串起，等待发生在段与段之间（无 worker）。
3. **执行 `handleRun`**：**路线 A** 拿得到 `workflowEngine` 时 `engine.start({ script, meta, parent, maxTotalAgents })`；**路线 B** 拿不到时借道 `tools.execute({ name:'workflow', ... })`。审批运行在后台循环「跑一段 → `userQuestions.ask` 问人 → 段间传意见」。
4. **事件**：`workflow/*` 事件（start / phase / log / agent-start / agent-end / end）由 host 转成 SSE，客户端按 `nodeId` 点灯；图像产物另有落盘回传与轮询。

---

## 📁 文件构成

| 文件 | 角色 |
|---|---|
| `package.json` | 插件清单（`type: module`，入口 `lib/index.js`，peerDependency `@deepseek-ai/cordis`）|
| `lib/index.js` | **Host 半边**：编译画布图 → workflow 脚本 → 执行，并挂载全部 HTTP 路由 |
| `lib/generate.js` | 「✨ AI 生成工作流」的纯函数：提示词、脚本构造、抠 JSON、规整 + 自动布局 |
| `lib/client.js` | **浏览器半边**：classic-script bundle，经 `__ModuleLoader__.load` 注册的画布 UI |
| `cordis.patch.yml` | 给 DSH 的 **bundle patch**：把本插件 insert 进组合树（见「📦 安装」第 3 步）|
| `lib/image-edit.mjs` | 「出图 / 改图」脚本（**随包分发**）：`edit` 走百炼或魔搭，`gen` 转给下面那个 |
| `lib/gen-image.mjs` | 「文生图」脚本（**随包分发**）：走智谱 BigModel |

---

## 🌐 HTTP 路由（14 条）

前缀 `BASE = /api/dsh-canvas`：

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/run` | 编译并启动运行 |
| POST | `/stop` | 停止指定 `runId` |
| GET | `/events` | SSE 事件流（可按 `runId` 过滤、补发最近事件） |
| POST | `/report` | 外部/对话模式推进度（`start`/`node`/`end`） |
| POST | `/reveal` | 在资源管理器定位文件（仅 Windows） |
| POST | `/cleanup` | 手动清理画布自己的产物 |
| GET | `/asset` | 受控读取白名单目录里的图片（贴缩略图） |
| GET | `/probe` | 自检探针 |
| GET | `/dsh-canvas/probe` | 免鉴权探针别名 |
| POST | `/compile` | 只编译不执行 |
| GET | `/graphs` | 列出已存画布 |
| GET / POST | `/graph` | 读 / 存一张画布 |
| POST | `/generate` | 一句话需求 → 画布图 JSON |
| POST | `/graph/delete` | 删除画布 |

---

## ✅ 自检与验收

```bash
node verify-offline.mjs      # 198 项断言，离线，不用重启（在插件目录里跑）
```

浏览器里 `GET /dsh-canvas/probe`（免鉴权）→ 看三个服务在不在、`ctx.agents.get()` 能不能拿到 Agent。

---

## ⚠️ 已知限制与取舍

- **无暂停机制 / 单步调试做不了** —— 整段脚本一次性交给引擎，执行期间**没有暂停点**；人工审批只能靠「拆段」实现（要单步就得放弃引擎）。多门必须串在同一条链上，链中分叉、并行分支里的多个门会被直接拒绝。
- **一次只支持一个审批节点**（P3 范围）。
- **`parallel` 的每条分叉目前只能接子代理**（源码注释标为 P1 限制）。
- **`condition` 必须是合法 JS 表达式**，写中文句子会被拦下；首路必须带条件，无条件兜底只能放最后。
- **恰好 1 个 trigger，且 trigger 不能落在分支里**；变量名撞名（如 `a-b` 与 `a_b`）会报错。
- **workflow 沙箱无 `fetch/require/fs`**：图像节点只能走子代理执行本机 `~/.dsh/image-edit.mjs`。
- **多会话时子代理可能挂到别的会话**（host 取 `roots()` 最后一个；结果照样回画布，只是工具卡片显示在那边）。
- **路线 B（`tools.execute`）下 `workflow/*` 事件跨不了 realm**，改用 `subagents.listChildren` 轮询 + 产物文件轮询替代。
- **`/report` 与 `/asset` 是自注册 = 免鉴权路由**，仅因 DSH 只监听回环才安全；`/asset` 读取受白名单目录（`DSH_CANVAS_ASSET_ROOTS`）与图片扩展名双重限制。
- **客户端为 P0**：不做缩放、框选、吸附对齐、右键菜单、属性面板。
- **定时触发未做** —— 技术可行，但"定时跑 = 自动烧 token"，得先定上限策略。
- 画布历史存浏览器 `localStorage`；产物默认保留 7 天（`DSH_CANVAS_IMAGE_TTL_DAYS=0` 可关）。

---

*本 README 融合了面向用户的使用手册与面向开发者的技术说明，依据本目录 `package.json` 与 `lib/` 下源码整理；源码未体现的功能一律未写入。*
