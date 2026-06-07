import type { WorkflowDefinition } from '../../stores/workflow-store'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../ipc-client'
import type { BlueprintData } from '../../../electron/repositories/blueprint-repository'
import { stripThinkingTags } from './workflow-utils'

// ==========================================
// 1. 结构与类型导出 (保留对外的向后兼容)
// ==========================================

export type ChapterBlueprint = BlueprintData

const EMPTY_BLUEPRINT: ChapterBlueprint = {
  chapterNumber: 0,
  title: '',
  role: '发展',
  purpose: '',
  keyEvents: '',
  characters: [],
  suspenseHook: '',
  userGuidance: '',
  notes: '',
  notesUpdatedAt: '',
}

export interface DirectoryWorkflowParams {
  mode: 'full' | 'append'
  startChapter?: number
  count?: number
  /** 节奏/风格指导（可选） */
  pacingGuidance?: string
}

// ==========================================
// 2. 蓝图文件访问与工具函数
// ==========================================

/**
 * 尝试修复常见 JSON 格式错误：key 与 value 之间漏了冒号
 * 例如 "keyEvents陈渡趁夜色..." → "keyEvents":"陈渡趁夜色..."
 */
function tryRepairJSON(text: string): string {
  // 修复对象属性 key 与 value 之间缺失冒号的情况
  // 匹配模式: "keyName"后面紧跟着文本（没有冒号）
  let repaired = text.replace(/"([a-zA-Z_]\w*)"(?=\s*[\["{a-zA-Z一-鿿])/g, '"$1":')
  // 修复 key 没有引号的情况
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z_]\w*)(\s*:\s*)/g, '$1"$2"$3')
  return repaired
}

export function parseTextBlueprints(content: string, startNum: number, endNum: number): ChapterBlueprint[] {
  let result: ChapterBlueprint[] = []

  const tryParse = (jsonStr: string): ChapterBlueprint[] | null => {
    const startIndex = jsonStr.indexOf('{')
    const endIndex = jsonStr.lastIndexOf('}')

    if (startIndex === -1 || endIndex === -1) return null

    const arrayStr = jsonStr.substring(startIndex, endIndex + 1)
    let parsed
    try {
      parsed = JSON.parse(arrayStr)
    } catch {
      return null // 需要修复
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.blueprints) {
      parsed = parsed.blueprints
    }
    if (!Array.isArray(parsed)) return null

    return parsed
      .filter((p: Record<string, unknown>) => {
        const n = Number(p.chapterNumber || p.chapter_number)
        return n >= startNum && n <= endNum
      })
      .map((p: Record<string, unknown>) => ({
        ...EMPTY_BLUEPRINT,
        chapterNumber: Number(p.chapterNumber || p.chapter_number || 0),
        title: String(p.title || `第${p.chapterNumber}章`),
        role: String(p.role || '发展'),
        purpose: String(p.purpose || ''),
        keyEvents: String(p.keyEvents || p.key_events || ''),
        characters: Array.isArray(p.characters) ? p.characters : [],
        suspenseHook: String(p.suspenseHook || p.suspense_hook || ''),
        userGuidance: '',
      }))
  }

  try {
    const cleanContent = stripThinkingTags(content)
    const jsonStr = cleanContent.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim()

    // 第一次尝试：直接解析
    let parsed = tryParse(jsonStr)
    if (parsed) {
      result = parsed
    } else {
      // 第二次尝试：修复常见 JSON 格式错误后重试
      console.log('[parseTextBlueprints] 初次解析失败，尝试修复 JSON 格式...')
      const repaired = tryRepairJSON(jsonStr)
      parsed = tryParse(repaired)
      if (parsed) {
        console.log('[parseTextBlueprints] 修复后解析成功')
        result = parsed
      } else {
        console.error('[parseTextBlueprints] 修复后仍解析失败', jsonStr.slice(0, 500))
      }
    }
  } catch {
    console.error('[parseTextBlueprints] 意外异常', content.slice(0, 500))
  }

  const distinctMap = new Map<number, ChapterBlueprint>()
  for (const item of result) {
    if (!distinctMap.has(item.chapterNumber)) distinctMap.set(item.chapterNumber, item)
  }

  return Array.from(distinctMap.values()).sort((a, b) => a.chapterNumber - b.chapterNumber)
}

export async function loadDirectoryBlueprints(): Promise<ChapterBlueprint[]> {
  try {
    const blueprints = await ipc.invoke('db:blueprint-get-all')
    return blueprints.sort((a, b) => a.chapterNumber - b.chapterNumber)
  } catch {
    return []
  }
}

export async function saveChapterBlueprint(blueprint: ChapterBlueprint): Promise<void> {
  const result = await ipc.invoke('db:blueprint-upsert', blueprint)
  if (!result.success) {
    throw new Error(result.error || '保存蓝图失败')
  }
}

export async function saveAllBlueprints(blueprints: ChapterBlueprint[]): Promise<void> {
  console.log(`[saveAllBlueprints] 保存 ${blueprints.length} 章`, blueprints.map(b => `ch${b.chapterNumber}`).join(','))

  const result = await ipc.invoke('db:blueprint-upsert-many', blueprints) as { success: boolean; error?: string }

  console.log(`[saveAllBlueprints] 结果:`, result)
  if (!result.success) {
    throw new Error(result.error || '批量保存蓝图失败')
  }
}

export async function deleteChapterBlueprint(chapterNumber: number): Promise<void> {
  const result = await ipc.invoke('db:blueprint-delete', chapterNumber)
  if (!result.success) {
    throw new Error(result.error || '删除蓝图失败')
  }
}

export async function getBlueprintCount(): Promise<number> {
  try {
    const blueprints = await ipc.invoke('db:blueprint-get-all')
    return blueprints.length
  } catch {
    return 0
  }
}

// ==========================================
// 3. 工作流定义映射工厂 (Command 调度层)
// ==========================================

export function createDirectoryWorkflow(params: DirectoryWorkflowParams = { mode: 'full' }): WorkflowDefinition {
  return {
    type: 'directory',
    title: params.mode === 'append' ? `📋 续写章节蓝图${params.startChapter ? `（从第 ${params.startChapter} 章）` : ''}` : '📋 生成章节蓝图（全量）',
    steps: [
      {
        name: '读取架构',
        description: `从 SQLite 加载项目架构信息`,
        executor: async (_step, context, callbacks) => {
          const project = useProjectStore.getState().currentProject
          if (!project) throw new Error('未打开项目')

          callbacks.log('读取项目架构信息...')
          const core = await ipc.invoke('db:project-core-get')
          if (!core) throw new Error('项目核心数据未初始化')

          const parts: string[] = []
          if (core.premise && core.premise.length > 50) parts.push(core.premise)
          if (core.charactersArch && core.charactersArch.length > 50) parts.push(core.charactersArch)
          if (core.worldbuilding && core.worldbuilding.length > 50) parts.push(core.worldbuilding)
          if (core.synopsis && core.synopsis.length > 50) parts.push(core.synopsis)

          if (parts.length === 0) throw new Error('项目主要架构均未生成')

          context.data.architecture = parts.join('\n\n---\n\n')
          // 注入节奏指导到 context，供 Command 读取
          if (params.pacingGuidance) context.data.pacingGuidance = params.pacingGuidance
          if (params.mode === 'append') {
            const existing = await loadDirectoryBlueprints()
            context.data.existingBlueprints = existing
            callbacks.log(`已加载 ${existing.length} 章已有蓝图`)
          }
          return `架构加载完成（${parts.length} 段）`
        },
      },
      {
        name: '生成蓝图',
        description: '基于架构文件生成全书章节蓝图',
        executor: async (_step, context, callbacks) => {
          const { GenerateDirectoryCommand } = await import('./commands/directory.command')
          const cmd = new GenerateDirectoryCommand(params)
          const blueprints = await cmd.execute({ step: _step, context, callbacks })
          // 返回可读摘要字符串（step.result 必须是 string，否则 AIOutputPanel 渲染会崩溃）
          return `已生成 ${blueprints.length} 章蓝图`
        },
      },
      {
        name: '保存蓝图',
        description: `将章节蓝图写入 SQLite 数据库`,
        executor: async (_step, context, callbacks) => {
          const project = useProjectStore.getState().currentProject
          if (!project) throw new Error('未打开项目')

          const newBlueprints = context.data.newBlueprints as ChapterBlueprint[]
          const existingBlueprints = context.data.existingBlueprints as ChapterBlueprint[]

          if (!newBlueprints || newBlueprints.length === 0) {
            throw new Error('没有新生成的蓝图需要保存')
          }

          // 如果是追加模式，合并新旧蓝图
          let merged: ChapterBlueprint[]
          if (params.mode === 'full') {
            merged = newBlueprints
          } else {
            const existingMap = new Map(existingBlueprints.map(b => [b.chapterNumber, b]))
            for (const nb of newBlueprints) existingMap.set(nb.chapterNumber, nb)
            merged = Array.from(existingMap.values()).sort((a, b) => a.chapterNumber - b.chapterNumber)
          }

          callbacks.log(`保存 ${merged.length} 章蓝图到数据库...`)

          try {
            await saveAllBlueprints(merged)
            callbacks.log(`✅ 蓝图保存成功`)
          } catch (err) {
            callbacks.log(`❌ 蓝图保存失败: ${err}`)
            throw err
          }
          useProjectStore.getState().refreshFileTree()
          return `已保存 ${merged.length} 章蓝图`
        },
      },
    ],
    onComplete: {
      mode: 'silent',
      message: params.mode === 'append' ? '✅ 续写蓝图生成完成' : '✅ 全书章节蓝图已生成完成！',
    },
  }
}
