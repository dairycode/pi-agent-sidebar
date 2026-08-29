# Pi Agent Sidebar 迭代规划

> 基线版本：`0.6.3` · 验证用 pi binary：`0.84.3` · 本文档被 `.gitignore` 忽略，是本地规划文档
>
> 与上一版的区别：上一版是纯设计方案，这一版记录**已交付的事实**、**live 验证过的协议行为**和**待决策项**。设计结论保留，但不再重复未实施的细节。

---

## 1. 当前状态

| 期 | 内容 | 状态 | 验证 |
| --- | --- | --- | --- |
| P0 | 协议契约 + session 元数据语义 | **完成** | typecheck / 145 unit / 生产构建可复现 / rpc smoke |
| P1 | Clone 当前会话 | **完成** | 同上 |
| P2 | Fork 从历史 prompt | **完成** | 同上 |
| P3 | 消息时间 + 用量详情 + 复制/引用 | **完成** | 同上 |
| P4 / M6 | 代码高亮 | **完成** | 同上 |
| P4 / M7 | 布局 + 附件 | **部分完成** | CSS 层需求已被现有代码满足；缩略图待决策 |
| P5 | 只读 tree 浏览 | 未开始 | — |
| Future | 同 session leaf navigation | 阻塞（上游） | — |

最后一次完整验证：`typecheck` 通过、`test:unit` **160 项全绿**、`check:generated` 生产构建可复现、`test:rpc` 通过。

M6 已完整交付（实现 + CSS 主题映射 + 12 项测试）。唯一待你确认的是语言集大小，见 2.1——那不影响功能正确性，只影响 bundle 体积。

---

## 2. 待你决策

### 2.1 代码高亮的语言集（不阻塞功能，只影响体积）

Shiki 已被 CSP 排除，不是主观取舍：当前 CSP 是 `style-src ${cspSource}` 且无 `unsafe-inline`，而 `style-src-attr` 缺省回退到 `style-src`，所以内联 `style=` 属性会被拦。Shiki 默认输出内联 style，即使换 CSS-variables 主题仍是内联 `style="color:var(--shiki-*)"`，要么放宽 CSP（本方案明确禁止），要么自写 transformer 转 class。highlight.js 输出纯 `class="hljs-*"`，不动 CSP 即可用。

真正需要你定的是**语言集大小**。实测数据：

| 方案 | 独立 bundle | webview 生产 bundle | 增量 |
| --- | --- | --- | --- |
| baseline（无高亮） | — | 140.4 kb | — |
| hljs core only | 27.5 kb | 未测 | — |
| lean 8 语言 | 61.1 kb | 约 203 kb（估算） | 约 +45% |
| 当前实现 26 语言 | 未单测 | **270.5 kb（实测）** | **+130.1 kb / +93%** |

lean 8 语言 = `bash` `diff` `javascript` `json` `python` `typescript` `xml` `yaml`。

三个选项：

1. **保留 26 语言**（当前状态）：覆盖最广，webview bundle 翻倍。
2. **收到 lean 8 语言**：覆盖 pi 日常输出的绝大多数场景，增量约 45%。未命中的语言退化为纯文本（降级路径已实现且有测试，不会报错）。
3. **放弃高亮**：回滚 highlight.js 依赖，bundle 回到 140.4 kb。

我按 1 交付了，因为功能完整可用；改成 2 只需删 `highlight.ts` 顶部的 import 和 `LANGUAGES` / `ALIASES` 条目，几分钟的事。

我个人倾向 2：+130kb 换 18 种低频语言的性价比不高，而降级是无声的——未注册语言只是不上色。但这会让 Java/Go/Rust/C++ 失去高亮，取决于你实际写什么代码，所以留给你定。

`lean` 的 203 kb 是从独立 bundle 推算的，选定后实测确认。

### 2.2 Fork picker 的宿主（已按你的要求改回 webview）

P2 初版用了 VS Code 原生 QuickPick，现已按你的要求改为 webview 内列表。这项决策关闭。

附带的协议简化：`forkSession` 原先要携带 `hasDraft` 跨边界，唯一理由是"草稿在 webview、确认框在 host"。确认移进 webview 后这个理由消失，改为携带 `entryId`——host 不再做选择，只执行已定的决定。

### 2.3 `@vscode/vsce` 的 4 个 high 漏洞

`npm audit` 报 5 条，来源已查清：

- 4 条 high（`brace-expansion` / `fast-uri` / `js-yaml` / `undici`）全部来自 `@vscode/vsce`，仅打包时使用，**不进产物**。我没有动它，避免为审计噪音升 vsce 主版本。
- 1 条 moderate 来自 `dompurify`（IN_PLACE hook 残留可执行子树导致 XSS）。这条我升了：`3.4.12` → `3.4.14`，在 `^3.2.6` 范围内。理由是高亮让更多 HTML 经过 DOMPurify，它的正确性比之前更吃重。

需要你决定是否为那 4 条 high 升 vsce 主版本。

### 2.4 composer 图片缩略图的实现路径（阻塞 M7）

现状：附件只显示图标 + 文件名。`AttachmentRef` 只带 `id` / `path` / `label` / `kind`，没有像素数据。

要出缩略图，host 必须把图像数据送过 `postMessage`，三个选项：

1. **直传原图 base64，CSS 缩放**。不加依赖，但每次 `syncAttachments()` 最多推 4 张 × 10 MB = 40 MB（base64 编码后约 53 MB）。这个量级不可接受。
2. **只为小图生成预览**（例如 < 256 KiB）。不加依赖且量级可控，但绝大多数截图超过这个阈值，功能大部分时间不生效——价值很低。
3. **引入图像缩放依赖**（sharp / jimp）真正降采样。效果正确，但 sharp 带 native 二进制（影响 vsix 体积和跨平台打包），jimp 是纯 JS 但体积和速度差。

我没自己选：新增运行时依赖（尤其 native）会改变打包和发布约束，超出了“完成 P4”应该包含的范围。若你觉得缩略图优先级不高，直接删掉这一项也是合理的——现在的图标 + 文件名已能说清附了什么。

---

## 3. 已验证的协议事实

这是 P0 最有价值的产出。全部由 pi `0.84.3` 的隔离 live 探针确认（临时 `--session-dir`，未触碰真实 session）。升级 pi 后应重跑探针并更新本节与 fixture。

### 3.1 取消 ≠ 失败

`new_session` / `switch_session` / `clone` / `fork` 被 extension 取消时：

```json
{ "success": true, "data": { "cancelled": true } }
```

`success: false` 才是真失败。两者必须在 UI 上区分：取消是中性结果，不显示错误 toast。

已落地为 `ActionResult.cancelled`，host 侧用 `SessionMutationCancelledError` 映射成 `ok: true, cancelled: true`。

### 3.2 各命令的真实响应形状

| 命令 | 响应 | 备注 |
| --- | --- | --- |
| `get_fork_messages` | `{ messages: [{ entryId, text }] }` | 空 session 返回 `[]` |
| `get_entries` | `{ entries: [...], leafId }` | entry 带 ISO `timestamp`、`id`、`parentId` |
| `get_tree` | `{ tree: [{ entry, children }], leafId }` | 递归结构 |
| `clone` | `{ cancelled: false }` | **不含** `sessionId` / `sessionFile` |
| `fork` | `{ text, cancelled }` | `text` 是被 fork 的 prompt 原文 |

`clone` 不返回新 session 标识这一点很关键：必须轮询 `get_state` 才能确认 session 已被替换。已落地为 `waitForSessionReplacement()`（5s 超时、50ms 轮询）。

### 3.3 错误形状与能力降级

- 未知命令 → `success: false, error: "Unknown command: <name>"`
- `fork` 传无效 entryId → `success: false, error: "Invalid entry ID for forking"`

第一种是"这个 pi 不支持"，第二种是支持的命令参数错了。二者必须区分：把后者当成能力缺失会永久隐藏 fork 入口。已落地为 `isUnsupportedCommandError()`，只匹配 `unknown/unsupported/unrecognized command`。

capability 一律**乐观初始化**，只被真实响应降级；进程重启时 `reset()`，因为换 binary 后旧结论无效。

### 3.4 `get_session_stats` 会失败

offline 或无可用 model 时返回 `success: false, error: "Cannot read properties of undefined (reading 'input')"`。snapshot 必须容忍它缺失（已有 `parseOptionalSnapshot` 路径）。

`contextUsage.tokens` / `percent` 在 compaction 后为 `null`，直到新的 assistant 响应提供有效 usage。`null` 必须显示为"暂不可用"，不能显示 0%。

### 3.5 highlight.js 的代价是单行长度，不是总字节数

M6 实测发现，并已修掉。原本只设了 64 KiB 的块上限，实测数据：

| 输入（均 64 KiB 总量） | 耗时 |
| --- | --- |
| 真实代码（80 列） | 22 ms |
| 1000 字符行 | 140 ms |
| 8000 字符行 | 1200 ms |
| 单行 | **9645 ms** |

单行输入 8→16→32→64 KiB 是 160→619→2318→9227 ms，标准二次增长。highlight.js 是**同步**的，这会把 webview 主线程冻住 9 秒。

关键结论：**字节上限区分不了这两者**。它放过了 9.6 秒的单行输入，同时又没必要拦住只要 22ms 的正常大文件。所以加了独立的单行上限 `MAX_HIGHLIGHT_LINE_BYTES = 2 KiB`（2 KiB 单行实测 9.5ms，8 KiB 单行 146ms）。minified 或单行代码块降级为纯文本。

缓存命中 0.005 ms（冷 0.21 ms），LRU 对 snapshot 重建有效。

### 3.6 时间语义

- `get_messages` 的 message `timestamp` 是 **epoch milliseconds**。
- session entry 的 `timestamp` 是 **ISO 字符串**。
- pi 自己计算 session 最后活动时间的算法是：遍历 **user/assistant message** 的 timestamp 取最大值，而不是取最后一行 entry 的时间。tool result 不算会话活动。

第三点我对齐了 pi 的 `buildSessionInfo`，否则 `lastActivityAt` 会和 pi 的 `/resume` 列表不一致。

---

## 4. 已交付明细

### P0：协议契约与 session 元数据

**shared/protocol.ts**
- 新增 `PiSessionEntry` / `PiSessionEntries` / `PiSessionTreeNode` / `PiSessionTree` / `ForkCandidate` / `PiCapabilities` / `PiTimeContext` / `PiSessionChangeResult`
- `SessionSummary.timestamp` → `createdAt` + `lastActivityAt` + `firstActivityAt?` + `messageCount?`
- `ActionResult` 加 `cancelled?`
- `PiCapabilities` 刻意**不**继承 `JsonRecord`：索引签名会把 `keyof` 退化成 `string`，丢掉逐项类型

**src/rpc/rpcValidation.ts**
- `parseForkMessagesResponse` / `parseSessionEntriesResponse` / `parseSessionTreeResponse`
- entry id 去重、tree 深度上限 200、节点数上限 20000、entryId 长度上限独立
- message timestamp 强校验为非负安全整数（ISO 字符串在此处是错误输入）

**src/rpc/piRpcClient.ts**
- response 的 `id` / `success` / `command` 一致性校验；command 与 pending 请求不匹配时拒绝而非错配 resolve
- 缺失 `id` 的 response 记为协议错误并忽略，不按位置猜测归属

**src/services/sessionStore.ts**
- `readSessionText` → `readSessionLines`：按行边界读取，head/tail 窗口截断的半行不再当有效 entry
- `readBytes` 循环读满，不假设单次 `read` 返回全部字节
- 活动时间按 user/assistant message 计算；截断读取时**省略** `messageCount`（部分读无法给出可信总数）
- 排序改为按 `lastActivityAt`，其次 `createdAt`，最后 path

**src/provider/sessionMutation.ts**（新）
- `sessionMutationBlockReason` / `assertSessionMutationAllowed` / `assertSessionMutationIdle`
- workspace 切换的优先级高于其他所有原因：结果绝不能写进另一个 workspace

**src/provider/piViewProvider.ts**
- `enqueueSessionMutation` / `assertSessionMutationContext` / `waitForSessionReplacement` / `sessionIdentity`
- `SessionMutationCancelledError`

### P1：Clone

- `src/rpc/piCapabilities.ts`（新）：`isUnsupportedCommandError` / `PiCapabilityTracker`
- `cloneSession()` / `requestCapability()` / `postCapabilities()`
- webview：clone 按钮，能力缺失时**隐藏**而非禁用；streaming/compacting 时禁用
- composer 草稿、附件、references 一律保留——clone 不消费用户正在输入的内容

### P2：Fork

- `sendForkCandidates()`：只读，**不进** mutation queue——列表在读者犹豫期间不该占住队列
- `forkSession(entryId)`：进 queue，先用实时 fork 列表复核 entryId（面板是早先构建的，会话可能已推进），再执行
- webview 内列表：搜索过滤、上下键导航、Enter 确认、`aria-activedescendant` 挂在搜索框（焦点所在处）
- 草稿警告**前置**在面板内，而非选中后弹确认：选完再警告已经来不及影响决定
- Enter 在无高亮时不动作——首行不是显然的默认值，且 fork 不可静默撤销
- 面板在断连、开始新回合、能力消失时自动关闭：entryId 只对取列表时的那个会话有效
- picker 和确认对话框在**队列外**执行：持锁等用户犹豫会阻塞所有其他 session 操作
- 进队后重新拉 `get_fork_messages` 校验 entryId 仍在 active branch（picker 期间 session 可能已变）
- `hasDraft` 由 webview 上报：草稿状态只有 webview 知道，对话框只有 host 能弹

### P3：时间与用量

- `webview/transcript/messageTime.ts`（新）：全部纯函数，`nowMs` 显式传入
  - `normalizeEpochMs` 同时接受 epoch ms 和 ISO 字符串
  - `nextRelativeBoundaryMs` / `nextRefreshDelayMs`：只在标签**即将变化**时唤醒，不固定轮询；已成静态日期的时间戳返回 `undefined`，永不再刷新
  - `formatDuration` 明确是墙钟跨度，不是 compute time
- host 传 `timeContext: { locale: vscode.env.language, hostNowMs }`；webview 记录 `clockSkewMs`，相对时间按 host 时钟算（Remote SSH 下两端时钟不一致）
- 日期分隔线是**独立 transcript entry**：跨天不会导致相邻消息节点重建
- `<time>` 挂在 `.message` 内部而非 `.message-slot`——slot 是 `display: contents`，挂上去会变成 `.messages` 的 flex item 并吃掉 20px gap
- `refreshRelativeTimes()` 只改 time 节点的 `textContent` / `title`，绕过 `TranscriptView`，不触发 markdown 重解析
- webview 隐藏时不排定时器，重新可见时立即补刷
- `runtime-meta` 从 `<div>` 改为 `<button>`，打开用量详情面板

### P3 / M5：复制与引用

- `messagePlainText()`：从**原始 message** 提取，不从渲染后 DOM 抓——后者会带上按钮标签、时间和 tool chrome
  - 只保留 `text` block（丢弃 thinking / toolCall），并剥除 `<pi-context>` 前缀（那是 extension 注入的，不是用户写的）
- `quotedText()`：空行给裸 `>` 而非真空行——真空行会终止 block quote，把余下的内容变成普通文本
- 引用**追加**而非覆盖草稿：读者可能已经写了那个要配引文的问题
- 无正文的消息（纯图片 / 纯 tool call）不显示操作按钮
- 按钮默认 `visibility: hidden`，hover 或 `:focus-within` 才显示；行高始终保留，否则 hover 会改变消息高度并抽动底部锚定的 transcript
- `:focus-visible` 强制可见：Tab 可到达的控件不能在获得焦点时不可见
- 测试 3 项（`message-actions.test.mjs`）

### P4 / M6：代码高亮

- `webview/transcript/highlight.ts`（新）：`CodeHighlighter` 接口 + `HighlightJsHighlighter`
  - 显式注册语言（非全量包），当前 26 种
  - `resolveLanguage` 别名表；**无自动语言检测**——短片段上开销大且易错，标错比不标更糟
  - 双上限：单块 64 KiB + **单行 2 KiB**（见 3.5，单行才是真正的 DoS 面）
  - `withinHighlightLimits` 单次遍历同时校验两个上限，超限立即返回
  - LRU 缓存 256 条 / 2 MiB；重新 insert 刷新 recency，使淘汰是 LRU 而非 FIFO
  - 自实现 `byteLength`，避免每个代码块分配 TextEncoder
- `renderer.ts` 接入 `marked.use({ renderer: { code } })`
  - `highlightEnabled` 模块级 flag：marked 不给 code renderer 传用户上下文；`marked.parse()` 同步，flag 不会被另一次解析观察到
  - `markdown(text, highlight = false)`，streaming 默认**不**高亮
  - `try/finally` 无条件复位 flag，抛错不会让高亮遗留为开启
  - 未高亮时仍输出 `language-*` class，块自身仍向 DOM 和辅助技术报告语言
- CSS：hljs token → VS Code 主题变量（`symbolIcon-*` 主色 → `charts-*` 兜底 → `editor-foreground`）
  - 注释斜体、关键字加粗、diff 加背景色：**不只靠色相区分**，高对比主题和色觉障碍下仍可读
- 测试 12 项：`highlight.test.mjs` 6 项（别名解析 / 无内联 style / 降级 / 单行上限及拒绝耗时 / LRU / 同码不同语言分别缓存）+ `highlight-integration.test.mjs` 6 项（用**真实** marked 验证 settled 高亮、streaming 绕过、未知语言、三条路径的转义、超长行降级、flag 不跨渲染泄漏）
- `transcript.test.mjs` 的 marked mock 补 `use()`——这是接入 `marked.use()` 带来的真实回归

---

## 5. 剩余工作

### M6 剩余（可选）

1. 按 2.1 的决定调整语言集并实测 bundle。
2. `npm run preview` 人工验收 light / dark / high-contrast 下的 token 配色。这一项无法自动化，需要眼睛看。

DOMPurify 放行 `hljs-*` class 已确认：`class` 在其默认 URI-safe 属性表内，且整个 transcript 的样式本来就依赖 class 穿过 sanitize。

### M7 布局与附件（部分完成）

逐项核对现状后，上一版 ROADMAP 列的多数项**已被现有代码满足**：

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 代码块横向滚动、长标识符不拆碎 | 已满足 | `.assistant-text pre` 的 `overflow: auto` + `white-space: pre` |
| tool result 最大高度 | 已满足 | `.tool-output` 280px、`.tool-diff` 320px，均带 `overflow: auto` |
| tool result 错误态 | 已满足 | `.tool-call.error .activity-marker` |
| tool result 展开状态 | 已满足 | `<details>` + `restoreDisclosureState()` 跨重建保持 |
| composer 图片缩略图 | **待决策** | 见 2.4 |
| 单附件失败只报该项 | 未做 | 见下 |
| 多宽度 / 多主题验收 | **需人工** | `npm run preview` |

关于“移除时释放 object URL”：上一版写了这一条，但实际代码中没有任何 `createObjectURL` 调用——图片用 base64 data URL，不存在这个泄漏。该项作废。

关于单附件错误态：当前 `storePastedImages()` 是**原子**语义——任一图片无效则整批拒绝，但**不会**清空已有附件（校验全部先于存储）。所以“不清空其他有效附件”这个安全属性已经成立。真正的差异是部分成功：粘 4 张其中 1 张坏了，是否该存下剩下 3 张。原子语义也是可辩护的（用户意图是整批，默默存 3 张可能让他没注意到缺了一张），我没有改它——这是产品取舍，不是 bug。

### M5 剩余

无。用量详情、复制整条消息、引用到 composer 均已交付。

### P5 / M8：只读 tree 浏览

- 侧栏内轻量树列表，默认只展开 active path 和分支点
- 子节点懒加载，设最大 entry 数和深度
- user 节点提供 fork 入口
- `branch_summary` 只展示 pi 提供的 summary，不自行生成
- **不**把点击节点描述成"回退"

### Future / M9：同 session leaf navigation

阻塞（上游）。当前公开 RPC 有 `get_entries` / `get_tree` / `fork` / `clone` / `get_fork_messages`，但**没有**与 TUI `/tree` 等价的"移动当前 leaf"命令。

不通过发送 `/tree` prompt 模拟——RPC 文档明确说内置 TUI 命令不经 `get_commands` 暴露，也不保证可作为 prompt 执行。不把 `fork` 包装成"回退"——它会创建新 session 文件。

接入前提：公开的命令名/参数/response schema、明确的取消与 session replacement 行为、稳定的 entry id 语义、可用 fixture 和 live smoke 验证。

---

## 6. 不做的事

- 不直接改写、拼接或修复 session JSONL
- 不自行计算 diff、token cost、context usage 或 agent 状态
- 不为历史会话启动额外 pi 进程来获取统计
- 不引入网络资源、远程主题或需要放宽 CSP 的脚本
- 不自动调用有副作用的 `clone` / `fork` 做能力探测

---

## 7. 必须保持的不变量

### 性能

- 一条 streaming message 的普通 delta 最多重建自己的 DOM 节点
- 历史消息不因每帧更新而重新 markdown parse / sanitize / linkify
- 相对时间刷新只改 time 节点
- 高亮不在 streaming path 中运行
- session switch 可以清空重建 transcript，但必须显式发生在 session identity 改变之后

### 安全

- 保留 `resolveContainedPath` 和 workspace session 归属校验
- 不根据 webview 传来的路径直接读写文件
- webview 传来的 entry id 只作 opaque identifier，host 仍需验证它属于当前 active session 的 fork candidates
- 保持 `default-src 'none'`、无 `unsafe-inline`、无外部网络资源
- 所有 markdown 和高亮 HTML 都经 DOMPurify

### 可访问性

- 操作按钮有 tooltip、焦点样式和 accessible name
- 时间标签不每分钟触发 screen reader 广播
- light / dark / high-contrast / 窄侧栏 / 键盘导航纳入验收

---

## 8. 验证

```bash
npm run typecheck
npm run test:unit
npm run check:generated
npm run test:rpc      # 需要本机 pi
npm run preview       # 视觉验收，需人工看
```

`npm run verify` = 前三项。

运行 live RPC 测试时记录 pi binary 版本和使用的临时 session directory。live 探针必须用隔离的 `--session-dir`，不得触碰真实 session。
