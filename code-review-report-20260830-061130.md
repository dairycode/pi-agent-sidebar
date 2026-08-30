# Code Review 报告：feat/v7 vs main

- **分支**：`feat/v7`（领先 origin 10 个提交）
- **基准**：`main`
- **规模**：40 个文件，+5798 / -665
- **主题**：会话 clone / fork、消息时间显示与日期分隔、代码高亮、工具调用渲染重做（pi 风格）、主题令牌（pi-theme.css）
- **验证**：`npm run verify`（typecheck + 166 单测 + 产物可复现检查）全绿；本次审查中的死代码删除后复跑仍全绿

---

## 一、变更概览

| 模块 | 文件 | 内容 |
| --- | --- | --- |
| 协议 | `shared/protocol.ts` | `PiCapabilities`/`ForkCandidate`/`PiTimeContext`/`PiSessionChangeResult`；`SessionSummary.timestamp` → `createdAt`+`lastActivityAt`；`forkSession`/`cloneSession` 消息 |
| host | `src/provider/piViewProvider.ts` (+499) | clone/fork 流程、`enqueueSessionMutation` 世代守卫、`waitForSessionReplacement` 轮询、能力跟踪降级 |
| host | `src/provider/sessionMutation.ts`（新） | 突变前置条件断言（workspace/client/streaming/compacting） |
| host | `src/rpc/piCapabilities.ts`（新） | 乐观初始化、仅被 "unknown command" 降级的能力跟踪 |
| host | `src/rpc/piRpcClient.ts` | 响应字段校验（id 长度、success 布尔、command 匹配、error 长度） |
| host | `src/rpc/rpcValidation.ts` | `parseForkMessagesResponse`、时间戳/非负整数校验 |
| host | `src/services/sessionStore.ts` | head/tail 部分读取重构、`lastActivityAt` 排序 |
| webview | `webview/transcript/highlight.ts`（新） | highlight.js 按需注册、双上限（64KiB 块 / 2KiB 行）、LRU memo |
| webview | `webview/transcript/messageTime.ts`（新） | 纯函数时间格式化，显式传 `nowMs`（时钟偏移可测） |
| webview | `webview/transcript/renderer.ts` | `<details>` → div 展开块、分节 hash + 增量 patch、代码高亮接入 marked |
| webview | `webview/main.ts` (+861) | fork picker、usage 面板、相对时间单定时器、流式消息分节 patch |
| 样式 | `webview/styles/*` | pi 主题令牌、终端风 transcript、forced-colors 修正 |

架构符合项目定位（thin client）：fork 的 `entryId` 全程来自 pi（`get_fork_messages`），webview 只选择、host 只执行；能力判定完全靠对真实 pi 响应的探测，不依赖 pi 内部实现。ROADMAP 记录了 0.84.3 live 探针的协议事实，与代码一一对应。

---

## 二、问题清单

### P1-1 `waitForSessionReplacement`：「从无到有」的身份变化会被误判为失败

- **位置**：`src/provider/piViewProvider.ts:1059-1078`
- **类型**：BUG（边界条件）
- **描述**：三个成功条件为 `expectedPathMatches || identityChanged || noIdentityToCompare`。其中 `identityChanged` 要求**前后都有**身份才成立；`noIdentityToCompare = !hadIdentity && !next.sessionId && !next.sessionFile` 只覆盖「前后都没有」。若变更前 pi 尚无 session（`get_state` 无 `sessionId`/`sessionFile`——扩展刚启动、尚未发消息时 `sessionFile` 确实可为空，`switchSession` 对 `activePath` 的可空处理即为佐证），而命令成功后 pi 建立了 session，则三个条件全不满足：空转 5 秒（50ms × 100 次 `get_state` 轮询）后抛出 "Pi did not create a replacement session."，**但新 session 实际已创建**，且 `this.state` 未更新。
- **影响**：`newSession` / `cloneSession` / `forkSession` 在该状态下出现假失败 toast；错误分支已污染 UI。
- **建议修复**：`hadIdentity` 为 false 时没有任何基线可比，任何终态都应直接接受——

```ts
const noIdentityToCompare = !hadIdentity;
```

（cancelled 路径在此之前已提前返回，走到轮询即代表 pi 接受了命令；「无→有」只可能是命令的效果。）

### P1-2 `cloneSession` 缺少双击防护，快速双击会克隆出两个副本

- **位置**：`src/provider/piViewProvider.ts:560-562`（case 分支）；对照 `assertNoSessionMutationPending`（`piViewProvider.ts:1035-1039`）
- **类型**：BUG（竞态）
- **描述**：`newSession` 的 handler 专门调用 `assertNoSessionMutationPending()` 防双击（注释写明了 `> 1` 形式会放行第二次点击的原因）。`cloneSession` 走完全相同的入队路径，却没有这个防护。webview 侧的 `ui.busy` 只在快照刷新后才变 true，双击窗口内两次 `cloneSession` 都会入队：第一次完成后新 session 激活，第二次会**克隆这个克隆**，产生两个副本。
- **影响**：多余的 session 副本；用户需手动清理。
- **建议修复**（与 newSession 同型）：

```ts
case "cloneSession": {
    await this.respondToAction(message.actionId, async () => {
        this.assertNoSessionMutationPending();
        await this.cloneSession();
    });
    break;
}
```

### P2-1 fork 键盘导航：无高亮时按 ↑ 会跳过最后一行

- **位置**：`webview/main.ts:2519-2526`（`moveActiveFork`）
- **类型**：轻微 UX
- **描述**：`(current + delta + length) % length`，`current = -1`、`delta = -1` 时落在 `length - 2`。↓ 正确落在第一行，↑ 却落在倒数第二行。
- **建议**：`delta < 0 && current < 0` 时落到 `length - 1`。

### P2-2 协议字段已解析但无消费者（防御性面，非缺陷，提示知悉）

- `PiSessionChangeResult.sessionId` / `sessionFile`：`parseSessionChangeResult` 校验之，但全仓无读取点；ROADMAP 3.2 探针实测 `clone` 响应**不含**这两个字段。
- `PiStats.userMessages` / `assistantMessages` / `toolResults`：仅被 `parsePiStats` 校验 + 解析测试覆盖，webview 的 usage 面板未展示。
- 按 thin-client 原则它们属于「对 pi 响应形状的完整防御性校验」，与同文件其他字段的处理一致，故保留；若想收紧协议面可删，功能无影响。

### P2-3（已顺手修正）pi-theme.css 头注释失实

注释称 “This file only declares variables. Nothing consumes them yet.”，但 `transcript.css` 已大量消费 `--pi-theme-*`。死注释已更正（见下节）。

---

## 三、死代码清理（已执行）

审查过程中确认以下符号仅在声明模块内部使用、无任何跨模块/测试引用，已删除其多余的导出面；均为本分支新增代码，删除零风险：

| 位置 | 处理 |
| --- | --- |
| `webview/transcript/messageTime.ts:47` | `formatShortDate` 去掉 `export`（仅 `formatRelativeTime` 内部调用） |
| `webview/transcript/highlight.ts:163` | `MAX_CACHE_BYTES` 去掉 `export`（仅 LRU 内部使用；`MAX_HIGHLIGHT_BYTES` 等被测试引用，保留导出） |
| `src/rpc/rpcValidation.ts:17-18` | `MAX_FORK_CANDIDATES` / `MAX_SESSION_ENTRY_ID_LENGTH` 去掉 `export`（仅模块内使用） |
| `webview/styles/pi-theme.css:29` | 失实注释更正 |

**排查过但确认非死代码**（有真实引用，勿删）：`sessionMutationBlockReason`、`isUnsupportedCommandError`、`MAX_HIGHLIGHT_BYTES`、`MAX_HIGHLIGHT_LINE_BYTES`、`MAX_CACHE_ENTRIES`、`nextRelativeBoundaryMs`（均被测试直接引用）；`PiState.contextPercent`（状态栏 tooltip）。`<details>` → div 重构后 CSS 无残留死选择器（`starts-with-activity`、`thinking-summary`、`activity-marker` 等已随重构清除，`.tool-execution` 仅出现在注释中）。

---

## 四、审查中确认无误的关键点

1. **marked 模块级 `highlightEnabled` 标志**：依赖 `marked.parse()` 同步性，`finally` 无条件复位，不会把高亮泄漏到下一轮流式渲染（`renderer.ts:595-609`）。
2. **DOMPurify 与分节标记**：`ALLOW_DATA_ATTR` 默认放行，`data-section-key/hash` 在整建与分节 patch 两条路径都能存活（`main.ts:3203`）。
3. **能力降级精度**：只匹配 `unknown/unsupported/unrecognized command`；`fork` 传错 entryId 的 "Invalid entry ID for forking" 不会误伤能力位（有测试钉住）。
4. **highlight.js 双上限**：块 64KiB + 单行 2KiB，防二次复杂度冻结主线程；LRU 有条目数与字节数双界。
5. **sessionStore 部分读取**：head/tail 行边界（读 tail 前一字节判断）、CRLF、截断行丢弃、多字节边界处理正确。
6. **取消语义贯通**：host `SessionMutationCancelledError` → `ActionResult{ok:true, cancelled:true}` → webview 对 `!cancelled` 的守卫，new/fork/clone/switch 四条路径一致。
7. **相对时间单定时器**：下一边界唤醒、隐藏页清零、`hostNow()` 校准 Remote SSH 时钟偏移。
8. **无调试残留**：diff 中无 `console.*`、`debugger`、TODO/FIXME。

---

## 五、测试建议

1. **P1-1**：模拟 `get_state` 先返回无身份、`new_session` 后返回有身份的 fake-rpc，断言不超时不误报。
2. **P1-2**：连续两次 `cloneSession` 消息，断言第二次收到 "A session operation is already in progress."。
3. **P2-1**：fork 列表 ≥2 行、无高亮时按 ↑，断言高亮落在最后一行。
4. 既有 166 个单测覆盖了分节 patch、高亮上限、时间格式化、能力降级，回归面良好；建议补一条「`forkCandidates` 迟到且 picker 已关闭」的防串扰测试（当前逻辑已处理，值得钉住）。

## 六、结论

整体质量高：协议事实先行（live 探针 → ROADMAP → 代码）、防御面完整、注释解释「为什么」而非「做了什么」。**未发现 P0**；两个 P1 均为边界/竞态，触发窗口窄但真实，建议合并前修复（各约 1-3 行改动）。死代码已按要求直接删除并验证（typecheck + 166 测试 + 产物复现全绿）。
