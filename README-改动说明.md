# Vela 改动说明

## 概述

本次改动聚焦三个核心目标：

1. **一键完成流水线** — 从写稿到定稿全自动执行，并自动续写下一章
2. **蓝图保存可靠性修复** — 解决蓝图生成后无法写入数据库的问题
3. **字数控制强化** — 强制 LLM 遵守目标字数限制

---

## 一、一键完成流水线

### 新增 `createOneClickCompleteWorkflow()` (chapter-workflow.ts)

6 步全自动流水线，一键触发：

| 步骤 | 名称 | 说明 |
|------|------|------|
| 1 | 写草稿 | 调用 `GenerateDraftCommand`，设置 `autoMode=true` 跳过 UI 打开 |
| 2 | AI 修稿 | 调用 `RefineDraftCommand`，完成后自动合并 revision |
| 3 | AI 审稿 | 调用 `ReviewChapterCommand`，获取审稿报告 |
| 4 | 审稿修复 | 调用 `RefineFromReviewCommand`，完成后自动合并 revision |
| 5 | 定稿 | 调用 `FinalizeChapterCommand`，写入 manuscript，执行后处理流水线 |
| 6 | 进入下一章 | **自动读取下一章蓝图，2 秒延迟后启动下一章的一键完成** |

### 新增 `autoMergeRevision()` 辅助函数

修稿和审稿修复产生的 revision 无需用户手动确认合并，自动标记 merged 并更新草稿内容。

### UI 入口

以下位置新增"一键完成"按钮：

- **ChapterCardEditor** — 工具栏和每章编辑区（从写稿到定稿全流程）
- **DraftEditor** — 工具栏（从修稿到定稿，适用于已有草稿的章节）
- **ChapterCreationDialog** — 底栏（从写稿到定稿，参数可配置）

### 关键设计

- `context.data.autoMode = true` 标志在各 Command 中跳过文件 Tab 打开
- 每章之间 **2 秒间隔**，防止主进程因连续数据库操作和 LLM 调用过载
- 当下一章蓝图不存在时自动停止

---

## 二、蓝图保存可靠性修复

### 问题

蓝图生成后无法写入数据库，表现为"卡死"或"保存不成功"。

### 修复

1. **修正 `ipc.invoke` 泛型参数** — 之前的代码传入了错误的泛型类型参数，导致类型推断混乱
2. **恢复逐批次保存** — `GenerateDirectoryCommand` 的 while 循环中每生成一批蓝图立即调用 `saveAllBlueprints()` 写入数据库，而非等所有批次生成完毕后再统一保存
3. **步骤3改为校验** — 工作流步骤3由"保存全部蓝图"改为"校验第一笔数据已存在"+刷新文件树，避免重复保存大数据量
4. **增加 30 秒超时** — `saveAllBlueprints()` 使用 `Promise.race` 加超时保护，防止 IPC 调用挂起
5. **增加调试日志** — 每批次显示章节号和 LLM 返回内容的前 200 字符

---

## 三、字数控制强化

### 问题

LLM 无视模板中的"大约 {{word_number}} 字左右"建议，写稿时常产出 1.4 万字。

### 修复（三层强制）

| 层级 | 修改位置 | 措辞变化 |
|------|----------|----------|
| 模板 | prompt-templates.ts | "大约 3000 字左右" → "不得超过 3000 字！你只被允许写最多 3000 字！" |
| 写稿 | generate-draft.command.ts | 在 prompt 末尾追加字数硬限制段落 |
| 修稿 | refine-draft.command.ts | 同样在 prompt 末尾追加字数硬限制 |

字数控制提示会显示在 AI Output Panel：
```
调用 AI 生成章节草稿 (目标字数: 3000)...
```

---

## 四、后处理超时保护

### 问题

后处理流水线（章节要点提取、角色状态更新、文风学习）中的 LLM 调用没有超时保护，一旦卡住会阻塞整条定稿流程。

### 修复

`callLLMForPostProcess()` 增加 **5 分钟超时**，超时后 reject 并触发重试机制。

---

## 五、LLM 调用全局超时

### 问题

`base-command.ts` 中的 `callLLM()` 方法没有超时保护，模型配置错误或 API 连接异常时 Promise 永远 pending。

### 修复

`callLLM()` 增加 **5 分钟超时**，超时后 reject 并清理定时器。

---

## 修改的文件

| 文件 | 改动 |
|------|------|
| src/services/workflows/chapter-workflow.ts | 新增一键完成工作流 + autoMergeRevision |
| src/services/workflows/commands/directory.command.ts | 恢复逐批次保存 + 调试日志 |
| src/services/workflows/commands/generate-draft.command.ts | autoMode 跳过 UI + 字数硬限制 + context 传参 |
| src/services/workflows/commands/refine-draft.command.ts | autoMode 跳过 UI + 字数硬限制 + context 传参 |
| src/services/workflows/commands/review-chapter.command.ts | autoMode 跳过 UI + context 参数 |
| src/services/workflows/commands/refine-from-review.command.ts | autoMode 跳过 UI + context 参数 |
| src/services/workflows/commands/finalize-chapter.command.ts | 后处理超时保护 |
| src/services/workflows/commands/base-command.ts | callLLM 5 分钟超时保护 |
| src/services/workflows/directory-workflow.ts | saveAllBlueprints 30s 超时 + 步骤3改为校验 |
| src/services/prompt-templates.ts | 字数限制措辞强化 |
| src/shared/ipc-channels.ts | 新增 db:blueprint-delete 通道 |
| electron/controllers/db-controller.ts | 新增 db:blueprint-delete 处理器 + 日志 |
| electron/repositories/blueprint-repository.ts | 增加错误抛出（取代静默返回） |
| src/components/dialogs/ChapterCreationDialog.tsx | 新增一键完成按钮 |
| src/components/editor/ChapterCardEditor.tsx | 新增一键完成按钮 |
| src/components/editor/DraftEditor.tsx | 新增一键完成按钮 |
