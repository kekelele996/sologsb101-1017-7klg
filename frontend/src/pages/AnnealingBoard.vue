<script setup lang="ts">
/**
 * /annealing 退火窑位分配与曲线编排
 * 选好作品、入窑时间与曲线段后，先把所选退火窑的窑位逐个判一遍：
 * 能排的排前面标可用，排不了的写清被哪件作品的哪条记录挡住、占哪一段；
 * 未出炉记录按「入窑时间 + 该段理论时长」临时推算出炉时间（沿用 thermal 换算）。
 * 一个能排的窑位都没有时说明原因并挡住保存。窑位冲突同样禁止提交。
 * 出炉即回写作品状态为「已退火」。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import StageTag from '@/components/common/StageTag.vue'
import { useAnnealStore } from '@/stores/annealStore'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import { ANNEAL_STATE_OPTIONS, CURVE_SEG_OPTIONS, type Anneal, type AnnealDraft, type AnnealState, type CurveSeg } from '@/types/anneal'
import {
  ANNEAL_CURVE,
  annealWindow,
  formatHours,
  formatWindowRange,
  kilnSlots,
  parseAt,
  segmentHours,
  totalAnnealHours,
  type SlotAvailability,
} from '@/utils/thermal'
import { nowLocalInput } from '@/utils/id'

const annealStore = useAnnealStore()
const pieceStore = usePieceStore()
const furnaceStore = useFurnaceStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
/** 弹窗内当前选中的退火窑（窑号） */
const formKilnCode = ref('')

const form = reactive<AnnealDraft>({
  pieceId: '',
  kilnSlot: '',
  curveSeg: '缓冷' as CurveSeg,
  inAt: nowLocalInput(),
  outAt: '',
  state: '待入窑',
})

const rules: FormRules<AnnealDraft> = {
  pieceId: [{ required: true, message: '请选择作品', trigger: 'change' }],
  kilnSlot: [{ required: true, message: '请选择窑位', trigger: 'change' }],
  curveSeg: [{ required: true, message: '请选择曲线段', trigger: 'change' }],
  inAt: [{ required: true, message: '请选择入窑时间', trigger: 'change' }],
  state: [{ required: true, message: '请选择退火状态', trigger: 'change' }],
}

const pieceName = computed<Record<string, string>>(() =>
  Object.fromEntries(pieceStore.pieces.map((row) => [row.id, `${row.name} · ${row.craft}`]))
)

/** 可选退火窑：窑炉台账里的退火窑 + 已有退火记录里出现过的窑号 */
const kilnCodeOptions = computed<string[]>(() => {
  const codes = [...furnaceStore.annealingFurnaces.map((row) => row.code), ...annealStore.kilnCodes]
  return Array.from(new Set(codes)).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
})

const effectiveKilnCodes = computed<string[]>(() => (kilnCodeOptions.value.length > 0 ? kilnCodeOptions.value : ['AN-01']))

function kilnCodeOf(slot: string): string {
  const matched = effectiveKilnCodes.value.find((code) => slot.startsWith(`${code}-`))
  if (matched !== undefined) return matched
  return slot.split('-').slice(0, -1).join('-')
}

function shortSlot(slot: string): string {
  const code = kilnCodeOf(slot)
  return slot.startsWith(`${code}-`) ? slot.slice(code.length + 1) : slot
}

/** 当前所选退火窑的 9 个窑位 */
const currentKilnSlots = computed<string[]>(() => (formKilnCode.value === '' ? [] : kilnSlots(formKilnCode.value)))

/** 候选排产（编辑时带自身 id 以便排除） */
const candidate = computed(() => ({
  id: editingId.value ?? '',
  kilnSlot: form.kilnSlot,
  inAt: form.inAt,
  outAt: form.outAt,
  curveSeg: form.curveSeg,
  pieceId: form.pieceId,
}))

/** 判排前置条件：作品、入窑时间（合法）、曲线段齐备 */
const formReady = computed(
  () => form.pieceId !== '' && form.inAt !== '' && !Number.isNaN(parseAt(form.inAt)) && formKilnCode.value !== '',
)

const currentPiece = computed(() => pieceStore.pieces.find((row) => row.id === form.pieceId) ?? null)
const currentThickness = computed(() => currentPiece.value?.wallThicknessMm ?? 4)

/** 当前表单的窑位冲突检测结果，冲突时禁用提交 */
const conflict = computed(() => annealStore.conflictOf(candidate.value))

/** 候选时间窗与理论时长说明（未出炉时出炉时间为临时推算） */
const candidatePlan = computed(() => {
  const thickness = currentThickness.value
  const window = annealWindow(form, thickness)
  return {
    segment: formatHours(segmentHours(form.curveSeg, thickness)),
    total: formatHours(totalAnnealHours(thickness)),
    hint: ANNEAL_CURVE[form.curveSeg].hint,
    range: Number.isNaN(window[0]) ? '' : formatWindowRange(window, form.outAt === ''),
  }
})

/** 当前退火窑各窑位的可排评估：能排的排前面，排不了的带挡住记录 */
const currentKilnAvailability = computed<SlotAvailability[]>(() => {
  if (!formReady.value) return []
  const rows = currentKilnSlots.value.map((slot) =>
    annealStore.slotAvailability({ ...candidate.value, kilnSlot: slot }),
  )
  return rows.sort(
    (a, b) =>
      Number(b.available) - Number(a.available) ||
      currentKilnSlots.value.indexOf(a.kilnSlot) - currentKilnSlots.value.indexOf(b.kilnSlot),
  )
})

/** 跨全部退火窑找到的首个可用窑位（按窑号、窑位顺序） */
const firstAvailableSlot = computed<string>(() => {
  if (!formReady.value) return ''
  for (const code of effectiveKilnCodes.value) {
    for (const slot of kilnSlots(code)) {
      if (annealStore.slotAvailability({ ...candidate.value, kilnSlot: slot }).available) return slot
    }
  }
  return ''
})

/** 所有退火窑都排不了（含别的窑），需说明原因并挡住保存 */
const noSlotAnywhere = computed(() => formReady.value && firstAvailableSlot.value === '')

/** 当前选中窑位的评估（编辑时选中窑位可能属于其他窑，直接单查兜底） */
const selectedAvailability = computed<SlotAvailability | null>(() => {
  if (!formReady.value || form.kilnSlot === '') return null
  return (
    currentKilnAvailability.value.find((row) => row.kilnSlot === form.kilnSlot) ??
    annealStore.slotAvailability(candidate.value)
  )
})

const selectedBlockerLines = computed<string[]>(() =>
  (selectedAvailability.value?.blockers ?? []).map((blocker) => blocker.message),
)

/** 一个能排的都没有时，逐窑位列明挡住原因 */
const noSlotReasonLines = computed<string[]>(() => {
  if (!noSlotAnywhere.value) return []
  const lines: string[] = []
  effectiveKilnCodes.value.forEach((code) => {
    kilnSlots(code).forEach((slot) => {
      const result = annealStore.slotAvailability({ ...candidate.value, kilnSlot: slot })
      if (!result.available) {
        const blocker = result.blockers[0]
        lines.push(blocker ? `${slot} 排不了：${blocker.message}` : `${slot} 排不了：入窑时间不完整。`)
      }
    })
  })
  return lines
})

/** 保存拦截：信息不全 / 选中窑位被挡 / 所有窑位都排不了 */
const saveDisabled = computed(() => !formReady.value || conflict.value.conflict || noSlotAnywhere.value)

const stats = computed(() => ({
  total: annealStore.anneals.length,
  waiting: annealStore.anneals.filter((row) => row.state === '待入窑').length,
  firing: annealStore.anneals.filter((row) => row.state === '退火中').length,
  done: annealStore.anneals.filter((row) => row.state === '已出炉').length,
}))

onMounted(() => {
  void annealStore.loadAll()
  void pieceStore.loadAll()
  void furnaceStore.loadAll()
})

function openCreate(): void {
  editingId.value = null
  const code = kilnCodeOptions.value[0] ?? 'AN-01'
  formKilnCode.value = code
  Object.assign(form, {
    pieceId: pieceStore.currentPieceId ?? pieceStore.pieces[0]?.id ?? '',
    kilnSlot: '',
    curveSeg: '缓冷' as CurveSeg,
    inAt: nowLocalInput(),
    outAt: '',
    state: '待入窑' as AnnealState,
  })
  // 默认挑首个可排窑位（全部排不了时退回该窑首位，保存仍会被挡住）
  form.kilnSlot = firstAvailableSlot.value || kilnSlots(code)[0] || ''
  dialogVisible.value = true
}

function openEdit(row: Anneal): void {
  editingId.value = row.id
  formKilnCode.value = kilnCodeOf(row.kilnSlot)
  Object.assign(form, {
    pieceId: row.pieceId,
    kilnSlot: row.kilnSlot,
    curveSeg: row.curveSeg,
    inAt: row.inAt,
    outAt: row.outAt,
    state: row.state,
  })
  dialogVisible.value = true
}

/** 切换退火窑：优先选该窑首个可排窑位，都排不了取首位并交由保存拦截 */
function handleKilnChange(): void {
  const slots = formKilnCode.value === '' ? [] : kilnSlots(formKilnCode.value)
  const firstAvailable = formReady.value
    ? slots.find((slot) => annealStore.slotAvailability({ ...candidate.value, kilnSlot: slot }).available)
    : undefined
  form.kilnSlot = firstAvailable ?? slots[0] ?? ''
}

/** 挑首个可用窑位：跨全部退火窑查找，没有则说明原因 */
function pickFirstAvailable(): void {
  const slot = firstAvailableSlot.value
  if (slot === '') {
    ElMessage.warning('所有退火窑在该时间窗下都没有可排窑位，请调整入窑时间或曲线段')
    return
  }
  formKilnCode.value = kilnCodeOf(slot)
  form.kilnSlot = slot
  ElMessage.success(`已选择首个可用窑位 ${slot}`)
}

function recordsOfSlot(slot: string) {
  return annealStore.occupancy.filter((item) => item.kilnSlot === slot)
}

function slotCellClass(slot: string): Record<string, boolean> {
  const records = recordsOfSlot(slot)
  return {
    'is-occupied': records.some((row) => row.occupied),
    'is-overlap': records.some((row) => row.overlap),
  }
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  if (noSlotAnywhere.value) {
    ElMessage.error('所有退火窑在该时间窗下都没有可排窑位，请调整入窑时间或曲线段')
    return
  }
  if (conflict.value.conflict) {
    ElMessage.error(conflict.value.message)
    return
  }
  submitting.value = true
  try {
    if (editingId.value === null) {
      const row = await annealStore.createAnneal({ ...form })
      if (row === null) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success(`已分配窑位 ${row.kilnSlot}`)
    } else {
      const ok = await annealStore.updateAnneal(editingId.value, { ...form })
      if (!ok) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success('退火编排已更新')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Anneal): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除窑位 ${row.kilnSlot} 的退火记录？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await annealStore.deleteAnneal(row.id)
  ElMessage.success('退火记录已删除')
}

async function handleAdvance(row: Anneal): Promise<void> {
  const next = await annealStore.advance(row.id)
  if (next === null) {
    ElMessage.info('该记录已处于「已出炉」状态')
    return
  }
  ElMessage.success(annealStore.lastMessage)
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'state') annealStore.setFilters({ state: value as AnnealState | 'all' })
  if (key === 'curveSeg') annealStore.setFilters({ curveSeg: value as CurveSeg | 'all' })
  if (key === 'kilnCode') annealStore.setFilters({ kilnCode: value })
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="退火记录" :value="stats.total" suffix="条" tone="primary" icon="Histogram" />
      <StatBadge label="待入窑" :value="stats.waiting" suffix="条" tone="info" icon="DataLine" />
      <StatBadge label="退火中" :value="stats.firing" suffix="条" tone="warning" icon="TrendCharts" />
      <StatBadge label="已出炉" :value="stats.done" suffix="条" tone="success" icon="PieChart" />
      <StatBadge
        label="窑位占用率"
        :value="`${annealStore.occupancyRate}%`"
        :percent="annealStore.occupancyRate"
        tone="primary"
        icon="PieChart"
        :hint="`已占用 ${annealStore.occupiedSlotCount} / ${annealStore.allSlots.length} 个窑位`"
      />
    </div>

    <el-alert
      v-if="annealStore.lastMessage !== ''"
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      :title="annealStore.lastMessage"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">退火窑位分配与曲线编排</span>
          <el-button type="primary" @click="openCreate" :disabled="pieceStore.pieces.length === 0 || kilnCodeOptions.length === 0">
            <el-icon><Plus /></el-icon>
            <span>分配窑位</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="annealStore.filters.keyword"
        :fields="[
          { key: 'state', label: '退火状态', options: ANNEAL_STATE_OPTIONS as unknown as string[] },
          { key: 'curveSeg', label: '曲线段', options: CURVE_SEG_OPTIONS as unknown as string[] },
          { key: 'kilnCode', label: '退火窑', options: annealStore.kilnCodes },
        ]"
        :values="{
          state: annealStore.filters.state,
          curveSeg: annealStore.filters.curveSeg,
          kilnCode: annealStore.filters.kilnCode,
        }"
        :result-text="`命中 ${annealStore.visibleAnneals.length} / ${annealStore.anneals.length} 条`"
        @update:keyword="(value: string) => annealStore.setFilters({ keyword: value })"
        @change="handleFilterChange"
        @reset="annealStore.resetFilters()"
      />

      <EmptyPanel
        v-if="annealStore.ready && annealStore.anneals.length === 0"
        title="还没有退火编排"
        description="为已完成全部工序的作品分配退火窑位与曲线段；同一窑位在时间窗重叠时会禁止提交。"
        action-text="分配第一个窑位"
        @action="openCreate"
      />

      <el-table v-else v-loading="!annealStore.ready" :data="annealStore.visibleAnneals" row-key="id" stripe>
        <el-table-column label="作品" min-width="190">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="$router.push(`/pieces/${row.pieceId}/steps`)">
                {{ pieceName[row.pieceId] ?? '（作品已删除）' }}
              </el-link>
              <span class="cell-sub">
                壁厚 {{ annealStore.wallThicknessOf(row.pieceId) }} mm · 全流程
                {{ annealStore.durationOf(row.pieceId).text }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="阶段" width="150">
          <template #default="{ row }">
            <StageTag :stage="pieceStore.pieces.find((item) => item.id === row.pieceId)?.state ?? null" size="small" />
          </template>
        </el-table-column>
        <el-table-column prop="kilnSlot" label="窑位" width="130" />
        <el-table-column label="曲线段" width="120">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.curveSeg === '升温' ? 'warning' : row.curveSeg === '保温' ? 'primary' : 'success'"
            >
              {{ row.curveSeg }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="该段时长" width="120" align="right">
          <template #default="{ row }">
            {{ formatHours(segmentHours(row.curveSeg, annealStore.wallThicknessOf(row.pieceId))) }}
          </template>
        </el-table-column>
        <el-table-column label="入窑时间" width="160">
          <template #default="{ row }">{{ row.inAt.replace('T', ' ') }}</template>
        </el-table-column>
        <el-table-column label="出炉时间" width="160">
          <template #default="{ row }">
            <span v-if="row.outAt === ''" class="cell-sub">未出炉</span>
            <span v-else>{{ row.outAt.replace('T', ' ') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.state === '已出炉' ? 'success' : row.state === '退火中' ? 'warning' : 'info'"
              effect="dark"
            >
              {{ row.state }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" :disabled="row.state === '已出炉'" @click="handleAdvance(row)">
              推进状态
            </el-button>
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="mt-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">窑位占用表</span>
          <div class="slot-legend">
            <el-tag size="small" type="success" effect="plain">接续</el-tag>
            <span class="slot-legend__text">同一窑位前后记录首尾相接</span>
            <el-tag size="small" type="danger" effect="dark">重叠</el-tag>
            <span class="slot-legend__text">时间窗叠在一起（高亮）</span>
          </div>
        </div>
      </template>
      <div class="slot-grid">
        <div v-for="slot in annealStore.allSlots" :key="slot" class="slot-cell" :class="slotCellClass(slot)">
          <div class="slot-name">{{ slot }}</div>
          <template v-for="row in recordsOfSlot(slot)" :key="row.annealId">
            <div class="slot-detail" :class="{ 'is-overlap': row.overlap }">
              <div class="slot-detail__head">
                <span class="slot-piece">{{ row.pieceName }} · {{ row.curveSeg }}段</span>
                <el-tag
                  v-if="row.prevRelation === '重叠' || row.nextRelation === '重叠'"
                  size="small"
                  type="danger"
                  effect="dark"
                >
                  重叠
                </el-tag>
                <el-tag
                  v-else-if="row.prevRelation === '接续' || row.nextRelation === '接续'"
                  size="small"
                  type="success"
                  effect="plain"
                >
                  接续
                </el-tag>
              </div>
              <div class="slot-range">{{ row.rangeText }}</div>
              <div class="slot-sub">{{ row.state }} · 记录 {{ row.annealId }}</div>
            </div>
          </template>
          <div v-if="recordsOfSlot(slot).length === 0" class="slot-detail is-free">
            空闲
          </div>
        </div>
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '分配退火窑位' : '编辑退火编排'" width="760px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="作品" prop="pieceId">
              <el-select v-model="form.pieceId" filterable style="width: 100%">
                <el-option
                  v-for="item in pieceStore.pieces"
                  :key="item.id"
                  :value="item.id"
                  :label="`${item.name} · ${item.craft} · 壁厚 ${item.wallThicknessMm} mm`"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="退火窑">
              <el-select v-model="formKilnCode" style="width: 100%" @change="handleKilnChange">
                <el-option v-for="code in kilnCodeOptions" :key="code" :value="code" :label="code" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="曲线段" prop="curveSeg">
              <el-select v-model="form.curveSeg" style="width: 100%">
                <el-option v-for="item in CURVE_SEG_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="入窑时间" prop="inAt">
              <el-date-picker
                v-model="form.inAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="出炉时间">
              <el-date-picker
                v-model="form.outAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                placeholder="未出炉可留空"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="退火状态" prop="state">
          <el-select v-model="form.state" style="width: 100%">
            <el-option v-for="item in ANNEAL_STATE_OPTIONS" :key="item" :value="item" :label="item" />
          </el-select>
        </el-form-item>

        <el-form-item label="退火窑位" prop="kilnSlot">
          <div class="picker-panel">
            <div class="picker-toolbar">
              <span v-if="formReady" class="picker-summary">
                候选时间窗 {{ candidatePlan.range }}；该段理论时长 {{ candidatePlan.segment }}，全流程
                {{ candidatePlan.total }}
              </span>
              <span v-else class="picker-summary is-muted">选好作品、入窑时间与曲线段后即可判排</span>
              <el-button type="primary" link :disabled="!formReady" @click="pickFirstAvailable">
                <el-icon><Aim /></el-icon>
                <span>挑首个可用窑位</span>
              </el-button>
            </div>

            <div v-if="formReady" class="slot-picker">
              <div
                v-for="row in currentKilnAvailability"
                :key="row.kilnSlot"
                role="button"
                tabindex="0"
                class="slot-option"
                :class="{ 'is-available': row.available, 'is-blocked': !row.available, 'is-selected': form.kilnSlot === row.kilnSlot }"
                @click="form.kilnSlot = row.kilnSlot"
                @keydown.enter.prevent="form.kilnSlot = row.kilnSlot"
                @keydown.space.prevent="form.kilnSlot = row.kilnSlot"
              >
                <div class="slot-option__head">
                  <span class="slot-option__name">{{ shortSlot(row.kilnSlot) }}</span>
                  <el-tag size="small" :type="row.available ? 'success' : 'danger'" :effect="row.available ? 'dark' : 'plain'">
                    {{ row.available ? '可用' : '被挡住' }}
                  </el-tag>
                </div>
                <div v-if="row.available" class="slot-option__hint">该时间窗可排</div>
                <div v-else class="slot-option__blockers">
                  <div v-for="blocker in row.blockers" :key="blocker.annealId" class="slot-option__blocker">
                    <div>
                      「{{ blocker.pieceName }}」记录 {{ blocker.annealId }}（{{ blocker.curveSeg }}段·{{ blocker.state }}）
                    </div>
                    <div class="slot-option__range">占 {{ blocker.rangeText }}</div>
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="picker-empty">请先选好作品、入窑时间与曲线段，再查看窑位可排情况。</div>
          </div>
        </el-form-item>

        <el-alert
          v-if="!formReady"
          type="info"
          show-icon
          :closable="false"
          title="信息不全，暂无法判排"
          description="请选择作品与入窑时间，并确认曲线段；随后自动列出该退火窑各窑位的可排情况。"
        />
        <el-alert
          v-else-if="noSlotAnywhere"
          type="error"
          show-icon
          :closable="false"
          title="所有退火窑在该时间窗下都没有可排窑位，已挡住保存"
        >
          <div class="alert-lines">
            <div v-for="(line, index) in noSlotReasonLines" :key="index" class="alert-line">{{ line }}</div>
          </div>
        </el-alert>
        <el-alert
          v-else-if="conflict.conflict"
          type="error"
          show-icon
          :closable="false"
          title="所选窑位被挡住，无法保存"
        >
          <div class="alert-lines">
            <div v-for="(line, index) in selectedBlockerLines" :key="index" class="alert-line">{{ line }}</div>
          </div>
        </el-alert>
        <el-alert
          v-else
          type="success"
          show-icon
          :closable="false"
          title="窑位可用，可以保存"
          :description="`当前曲线段「${form.curveSeg}」理论时长 ${candidatePlan.segment}，该作品全流程退火 ${candidatePlan.total}。${candidatePlan.hint}`"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="saveDisabled" @click="handleSubmit">
          保存
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2b3a;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.slot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px;
}

.slot-legend {
  display: flex;
  align-items: center;
  gap: 6px;
}

.slot-legend__text {
  font-size: 12px;
  color: #8b95a1;
  margin-right: 8px;
}

.slot-cell {
  border: 1px solid #e4e7ed;
  border-radius: 10px;
  padding: 10px 12px;
  background: #fafcff;
}

.slot-cell.is-occupied {
  border-color: #f0b27a;
  background: #fff8f1;
}

.slot-cell.is-overlap {
  border-color: #e74c3c;
  background: #fef3f2;
  box-shadow: inset 0 0 0 1px rgba(231, 76, 60, 0.35);
}

.slot-name {
  font-size: 13px;
  font-weight: 600;
  color: #1d2b3a;
}

.slot-detail {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(36, 64, 94, 0.05);
  font-size: 12px;
  line-height: 1.6;
  color: #5b6b7a;
}

.slot-detail + .slot-detail {
  margin-top: 4px;
}

.slot-detail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.slot-piece {
  font-weight: 600;
  color: #1d2b3a;
}

.slot-range {
  color: #5b6b7a;
  font-variant-numeric: tabular-nums;
}

.slot-sub {
  color: #a8b0b8;
  font-size: 11px;
}

.slot-detail.is-overlap {
  background: #fde2df;
  border: 1px solid #e74c3c;
}

.slot-detail.is-overlap .slot-piece,
.slot-detail.is-overlap .slot-range {
  color: #9f2d20;
}

.slot-detail.is-free {
  color: #a8b0b8;
  background: transparent;
}

/* ---------------- 弹窗内窑位判排 ---------------- */
.picker-panel {
  width: 100%;
}

.picker-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.picker-summary {
  font-size: 12px;
  color: #5b6b7a;
}

.picker-summary.is-muted {
  color: #a8b0b8;
}

.slot-picker {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  width: 100%;
}

.picker-empty {
  border: 1px dashed #d8dee5;
  border-radius: 8px;
  padding: 14px;
  text-align: center;
  font-size: 12px;
  color: #a8b0b8;
}

.slot-option {
  text-align: left;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 8px 10px;
  background: #fff;
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}

.slot-option:focus-visible {
  outline: 2px solid rgba(36, 64, 94, 0.45);
  outline-offset: 1px;
}

.slot-option:hover {
  border-color: #24405e;
}

.slot-option.is-available {
  background: #f2faf4;
}

.slot-option.is-blocked {
  background: #fef3f2;
  border-color: #f3c2bc;
  cursor: pointer;
}

.slot-option.is-selected {
  border-color: #24405e;
  box-shadow: 0 0 0 2px rgba(36, 64, 94, 0.18);
}

.slot-option__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.slot-option__name {
  font-size: 13px;
  font-weight: 600;
  color: #1d2b3a;
}

.slot-option__hint {
  margin-top: 4px;
  font-size: 12px;
  color: #3f9d62;
}

.slot-option__blockers {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.slot-option__blocker {
  font-size: 11px;
  line-height: 1.5;
  color: #9f2d20;
}

.slot-option__range {
  color: #b85c50;
  font-variant-numeric: tabular-nums;
}

.alert-lines {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 168px;
  overflow-y: auto;
}

.alert-line {
  line-height: 1.6;
}

.mt-14 {
  margin-top: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
