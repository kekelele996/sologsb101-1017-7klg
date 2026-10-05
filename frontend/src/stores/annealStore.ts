/**
 * 退火窑位与曲线状态管理（Pinia）
 * 维护窑位占用表与退火曲线段；窑位冲突时禁止提交，出炉即回写作品状态。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Anneal, AnnealDraft, AnnealState, CurveSeg } from '../types/anneal'
import { ANNEAL_STATE_FLOW } from '../types/anneal'
import type { Piece } from '../types/piece'
import {
  ROW_REVISION,
  advanceAnnealState,
  db,
  initDatabase,
  putAnneal,
  removeAnneal,
} from '../utils/db'
import {
  annealWindow,
  checkSlotConflict,
  evaluateSlotAvailability,
  formatHours,
  kilnSlots,
  segmentHours,
  totalAnnealHours,
  windowRangeText,
  windowRelation,
  type SlotAvailability,
  type SlotConflict,
  type SlotWindowRelation,
} from '../utils/thermal'
import { nowIso, nowLocalInput, uuid } from '../utils/id'

/** 退火筛选条件 */
export interface AnnealFilters {
  keyword: string
  state: AnnealState | 'all'
  curveSeg: CurveSeg | 'all'
  kilnCode: string | 'all'
}

/** 窑位占用行（已按窑位、入窑时间排序） */
export interface SlotOccupancy {
  kilnSlot: string
  annealId: string
  pieceId: string
  pieceName: string
  curveSeg: CurveSeg
  inAt: string
  outAt: string
  state: AnnealState
  /** 该窑位当前是否被未出炉记录占用 */
  occupied: boolean
  /** 占用时间窗 [起, 止]（毫秒时间戳，未出炉时止点为临时推算） */
  window: [number, number]
  /** 出炉时间是否为「入窑 + 该段理论时长」的临时推算 */
  endEstimated: boolean
  /** 占用时段文本 */
  rangeText: string
  /** 与同窑位上一条记录的衔接关系（首条为 null） */
  prevRelation: SlotWindowRelation | null
  /** 与同窑位下一条记录的衔接关系（末条为 null） */
  nextRelation: SlotWindowRelation | null
  /** 与任一相邻记录时间重叠（需高亮） */
  overlap: boolean
}

const EMPTY_FILTERS: AnnealFilters = { keyword: '', state: 'all', curveSeg: 'all', kilnCode: 'all' }

let subscribed = false

export const useAnnealStore = defineStore('anneal', () => {
  const anneals = ref<Anneal[]>([])
  const pieces = ref<Piece[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<AnnealFilters>({ ...EMPTY_FILTERS })

  const kilnCodes = computed<string[]>(() => {
    const set = new Set<string>()
    anneals.value.forEach((row) => {
      const code = row.kilnSlot.split('-').slice(0, -1).join('-')
      if (code !== '') set.add(code)
    })
    return Array.from(set).sort()
  })

  const wallThicknessOf = (pieceId: string): number =>
    pieces.value.find((row) => row.id === pieceId)?.wallThicknessMm ?? 4

  /** 作品解析：壁厚用于理论时长换算，名称用于占用说明 */
  const resolvePiece = (pieceId: string): { name: string; wallThicknessMm: number } => {
    const piece = pieces.value.find((row) => row.id === pieceId)
    return { name: piece?.name ?? '（作品已删除）', wallThicknessMm: piece?.wallThicknessMm ?? 4 }
  }

  /** 全部窑位（按已有退火记录推导窑号，兜底 AN-01） */
  const allSlots = computed<string[]>(() => {
    const codes = kilnCodes.value.length > 0 ? kilnCodes.value : ['AN-01']
    return codes.flatMap((code) => kilnSlots(code))
  })

  /**
   * 窑位占用表：同一窑位的记录按入窑时间排序，
   * 首尾相接标「接续」，时间窗叠住标「重叠」并由行内标记驱动高亮。
   */
  const occupancy = computed<SlotOccupancy[]>(() => {
    const rows = anneals.value.map((row) => {
      const piece = pieces.value.find((item) => item.id === row.pieceId)
      const thickness = piece?.wallThicknessMm ?? 4
      return {
        kilnSlot: row.kilnSlot,
        annealId: row.id,
        pieceId: row.pieceId,
        pieceName: piece?.name ?? '（作品已删除）',
        curveSeg: row.curveSeg,
        inAt: row.inAt,
        outAt: row.outAt,
        state: row.state,
        occupied: row.state !== '已出炉',
        window: annealWindow(row, thickness),
        endEstimated: row.outAt === '',
        rangeText: windowRangeText(row, thickness),
      }
    })
    rows.sort((a, b) => a.kilnSlot.localeCompare(b.kilnSlot) || a.window[0] - b.window[0] || a.inAt.localeCompare(b.inAt))

    return rows.map((row, index) => {
      const prev = rows[index - 1]
      const next = rows[index + 1]
      const prevRelation =
        prev && prev.kilnSlot === row.kilnSlot ? windowRelation(prev.window[1], row.window[0]) : null
      const nextRelation =
        next && next.kilnSlot === row.kilnSlot ? windowRelation(row.window[1], next.window[0]) : null
      return {
        ...row,
        prevRelation,
        nextRelation,
        overlap: prevRelation === '重叠' || nextRelation === '重叠',
      }
    })
  })

  const occupiedSlotCount = computed<number>(() => new Set(occupancy.value.filter((row) => row.occupied).map((row) => row.kilnSlot)).size)
  const occupancyRate = computed<number>(() => {
    const total = allSlots.value.length
    return total === 0 ? 0 : Math.round((occupiedSlotCount.value / total) * 1000) / 10
  })

  const visibleAnneals = computed<Anneal[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return anneals.value.filter((row) => {
      if (filters.state !== 'all' && row.state !== filters.state) return false
      if (filters.curveSeg !== 'all' && row.curveSeg !== filters.curveSeg) return false
      if (filters.kilnCode !== 'all' && !row.kilnSlot.startsWith(filters.kilnCode)) return false
      if (keyword === '') return true
      const piece = pieces.value.find((item) => item.id === row.pieceId)
      return (
        row.kilnSlot.toLowerCase().includes(keyword) ||
        (piece?.name ?? '').toLowerCase().includes(keyword) ||
        row.inAt.includes(keyword)
      )
    })
  })

  /** 某件作品的窑位冲突检测（编辑时排除自身） */
  function conflictOf(
    candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId'>,
  ): SlotConflict {
    return checkSlotConflict(anneals.value, candidate, wallThicknessOf, candidate.id, resolvePiece)
  }

  /** 单个窑位的可排评估：可用或被哪些记录挡住（编辑时排除自身） */
  function slotAvailability(
    candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId'>,
  ): SlotAvailability {
    return evaluateSlotAvailability(anneals.value, candidate, resolvePiece, candidate.id)
  }

  /** 某件作品的退火时长汇总 */
  function durationOf(pieceId: string): { hours: number; text: string } {
    const thickness = wallThicknessOf(pieceId)
    const hours = totalAnnealHours(thickness)
    return { hours, text: formatHours(hours) }
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [annealRows, pieceRows] = await Promise.all([db.anneals.toArray(), db.pieces.toArray()])
          return { annealRows, pieceRows }
        }).subscribe({
          next: ({ annealRows, pieceRows }) => {
            anneals.value = [...annealRows].sort((a, b) => a.inAt.localeCompare(b.inAt))
            pieces.value = pieceRows
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取退火数据失败'
            loading.value = false
          },
        })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<AnnealFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  async function createAnneal(draft: AnnealDraft): Promise<Anneal | null> {
    const conflict = conflictOf({
      id: '',
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
    })
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return null
    }
    const stamp = nowIso()
    const row: Anneal = {
      id: uuid('anneal'),
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putAnneal(row)
    revision.value += 1
    lastMessage.value = `已分配窑位 ${row.kilnSlot}，理论时长 ${formatHours(segmentHours(row.curveSeg, wallThicknessOf(row.pieceId)))}`
    return row
  }

  async function updateAnneal(annealId: string, draft: AnnealDraft): Promise<boolean> {
    const conflict = conflictOf({
      id: annealId,
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
    })
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return false
    }
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    await putAnneal({
      ...existing,
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
    })
    revision.value += 1
    lastMessage.value = '退火编排已更新'
    return true
  }

  async function deleteAnneal(annealId: string): Promise<void> {
    await removeAnneal(annealId)
    revision.value += 1
    lastMessage.value = '退火记录已删除'
  }

  /** 推进退火状态；「已出炉」写回出炉时间并同步作品状态 */
  async function advance(annealId: string): Promise<AnnealState | null> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return null
    const index = ANNEAL_STATE_FLOW.indexOf(existing.state)
    if (index < 0 || index >= ANNEAL_STATE_FLOW.length - 1) return null
    const next = ANNEAL_STATE_FLOW[index + 1]
    await advanceAnnealState(annealId, next, nowLocalInput())
    revision.value += 1
    lastMessage.value =
      next === '已出炉' ? '已登记出炉，作品状态已回写为「已退火」' : `退火状态已推进为「${next}」`
    return next
  }

  return {
    anneals,
    pieces,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    revision,
    kilnCodes,
    allSlots,
    occupancy,
    occupiedSlotCount,
    occupancyRate,
    visibleAnneals,
    wallThicknessOf,
    conflictOf,
    slotAvailability,
    durationOf,
    loadAll,
    setFilters,
    resetFilters,
    createAnneal,
    updateAnneal,
    deleteAnneal,
    advance,
  }
})
