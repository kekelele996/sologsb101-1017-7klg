<script setup lang="ts">
/**
 * /annealing 退火窑位分配与曲线编排
 * 窑位冲突时禁用提交；出炉即回写作品状态为「已退火」。
 * 消费模型：Anneal、Piece、Furnace；复用组件：<FilterBar>、<StatBadge>、<StageTag>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import StageTag from '@/components/common/StageTag.vue'
import { useAnnealStore, type SlotOccupancy } from '@/stores/annealStore'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import { ANNEAL_STATE_OPTIONS, CURVE_SEG_OPTIONS, type Anneal, type AnnealDraft, type AnnealState, type CurveSeg } from '@/types/anneal'
import { ANNEAL_CURVE, annealWindow, formatHours, segmentHours, totalAnnealHours, windowsOverlap, type SlotAvailability } from '@/utils/thermal'
import { nowLocalInput } from '@/utils/id'

const annealStore = useAnnealStore()
const pieceStore = usePieceStore()
const furnaceStore = useFurnaceStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
/** 表单当前选中的退火窑号（窑位 = 窑号 + 位号），用于列出该窑的窑位 */
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

/** 退火窑号选项：优先取退火窑台账，兜底用已有记录推导的窑号 */
const kilnCodeOptions = computed<string[]>(() => {
  const codes = furnaceStore.annealingFurnaces.map((row) => row.code)
  return codes.length > 0 ? codes : annealStore.kilnCodes
})

/** 当前候选时间窗下，所选退火窑各窑位的可用情况（可用优先排序） */
const slotAvailability = computed<SlotAvailability[]>(() => {
  if (formKilnCode.value === '' || form.pieceId === '' || form.inAt === '') return []
  return annealStore.slotAvailabilityOf(
    {
      id: editingId.value ?? '',
      inAt: form.inAt,
      outAt: form.outAt,
      curveSeg: form.curveSeg,
      pieceId: form.pieceId,
    },
    formKilnCode.value,
  )
})

const availableSlots = computed<SlotAvailability[]>(() => slotAvailability.value.filter((row) => row.available))
const firstAvailableSlot = computed<string>(() => availableSlots.value[0]?.kilnSlot ?? '')
/** 该退火窑在候选时间窗内一个能排的窑位都没有 */
const noSlotAvailable = computed<boolean>(() => slotAvailability.value.length > 0 && availableSlots.value.length === 0)

/** 当前表单的窑位冲突检测结果，冲突时禁用提交 */
const conflict = computed(() =>
  annealStore.conflictOf({
    id: editingId.value ?? '',
    kilnSlot: form.kilnSlot,
    inAt: form.inAt,
    outAt: form.outAt,
    curveSeg: form.curveSeg,
    pieceId: form.pieceId,
  })
)

/** 窑位占用表：同一窑位按入窑时间排序，相邻记录标「接续 / 重叠」 */
type SlotRecordRow = SlotOccupancy & { relation: '首条' | '接续' | '重叠' }
const slotGroups = computed<Record<string, SlotRecordRow[]>>(() => {
  const groups: Record<string, SlotOccupancy[]> = {}
  for (const row of annealStore.occupancy) {
    ;(groups[row.kilnSlot] ??= []).push(row)
  }
  const result: Record<string, SlotRecordRow[]> = {}
  for (const [slot, rows] of Object.entries(groups)) {
    result[slot] = rows.map((row, index, arr) => {
      if (index === 0) return { ...row, relation: '首条' as const }
      const prev = arr[index - 1]
      const prevWindow = annealWindow(prev, annealStore.wallThicknessOf(prev.pieceId))
      const currWindow = annealWindow(row, annealStore.wallThicknessOf(row.pieceId))
      const overlap = windowsOverlap(prevWindow, currWindow)
      return { ...row, relation: overlap ? ('重叠' as const) : ('接续' as const) }
    })
  }
  return result
})

const formDuration = computed(() => {
  const piece = pieceStore.pieces.find((row) => row.id === form.pieceId)
  const thickness = piece?.wallThicknessMm ?? 4
  return {
    segment: formatHours(segmentHours(form.curveSeg, thickness)),
    total: formatHours(totalAnnealHours(thickness)),
    hint: ANNEAL_CURVE[form.curveSeg].hint,
  }
})

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
  formKilnCode.value = kilnCodeOptions.value[0] ?? 'AN-01'
  Object.assign(form, {
    pieceId: pieceStore.currentPieceId ?? pieceStore.pieces[0]?.id ?? '',
    kilnSlot: '',
    curveSeg: '缓冷' as CurveSeg,
    inAt: nowLocalInput(),
    outAt: '',
    state: '待入窑' as AnnealState,
  })
  dialogVisible.value = true
}

function openEdit(row: Anneal): void {
  editingId.value = row.id
  formKilnCode.value = row.kilnSlot.split('-').slice(0, -1).join('-') || kilnCodeOptions.value[0] || 'AN-01'
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

/** 切换退火窑时清空已选窑位（窑位列表随窑号重算） */
function onKilnCodeChange(): void {
  form.kilnSlot = ''
}

/** 从可用窑位列表中点选；不可用窑位不可选 */
function selectSlot(row: SlotAvailability): void {
  if (!row.available) return
  form.kilnSlot = row.kilnSlot
}

/** 挑选首个可用窑位；一个都没有时说明原因 */
function pickFirstAvailable(): void {
  if (firstAvailableSlot.value === '') {
    ElMessage.warning('该退火窑在所选时间窗内没有可用窑位，请调整入窑时间或曲线段后再试。')
    return
  }
  form.kilnSlot = firstAvailableSlot.value
  ElMessage.success(`已挑选首个可用窑位 ${firstAvailableSlot.value}`)
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  if (noSlotAvailable.value) {
    ElMessage.error('该退火窑在所选时间窗内没有可用窑位，请调整入窑时间或曲线段后再保存。')
    return
  }
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
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
        <span class="card-header__title">窑位占用表</span>
      </template>
      <div class="slot-grid">
        <div
          v-for="slot in annealStore.allSlots"
          :key="slot"
          class="slot-cell"
          :class="{
            'is-occupied': (slotGroups[slot] ?? []).some((row) => row.occupied),
            'is-overlap': (slotGroups[slot] ?? []).some((row) => row.relation === '重叠'),
          }"
        >
          <div class="slot-name">{{ slot }}</div>
          <template v-for="row in slotGroups[slot] ?? []" :key="row.annealId">
            <div class="slot-detail" :class="{ 'is-overlap': row.relation === '重叠' }">
              <el-tag
                v-if="row.relation !== '首条'"
                size="small"
                :type="row.relation === '重叠' ? 'danger' : 'success'"
                effect="dark"
                class="slot-relation"
              >
                {{ row.relation }}
              </el-tag>
              <span>{{ row.pieceName }} · {{ row.curveSeg }} · {{ row.state }}</span>
            </div>
          </template>
          <div v-if="(slotGroups[slot] ?? []).length === 0" class="slot-detail is-free">
            空闲
          </div>
        </div>
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '分配退火窑位' : '编辑退火编排'" width="660px">
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
              <el-select v-model="formKilnCode" style="width: 100%" @change="onKilnCodeChange">
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

        <el-form-item label="选择窑位" prop="kilnSlot">
          <div class="slot-picker">
            <div class="slot-picker__bar">
              <el-button size="small" type="primary" plain @click="pickFirstAvailable">
                <el-icon><Check /></el-icon>
                <span>挑首个可用窑位</span>
              </el-button>
              <span v-if="form.kilnSlot !== ''" class="slot-picker__current">已选：{{ form.kilnSlot }}</span>
              <span v-else class="slot-picker__hint">从下方列表点选可用窑位，或点击按钮自动挑选</span>
            </div>

            <div v-if="slotAvailability.length === 0" class="slot-picker__empty">
              请先选择作品、入窑时间与曲线段，系统将列出该退火窑的窑位并标注可用情况。
            </div>
            <div v-else class="slot-picker__list">
              <div
                v-for="row in slotAvailability"
                :key="row.kilnSlot"
                class="slot-option"
                :class="{
                  'is-available': row.available,
                  'is-selected': form.kilnSlot === row.kilnSlot,
                  'is-blocked': !row.available,
                }"
                @click="selectSlot(row)"
              >
                <div class="slot-option__head">
                  <span class="slot-option__name">{{ row.kilnSlot }}</span>
                  <el-tag v-if="row.available" size="small" type="success" effect="dark">可用</el-tag>
                  <el-tag v-else size="small" type="danger" effect="dark">不可用</el-tag>
                </div>
                <div v-if="!row.available" class="slot-option__blockers">
                  <div v-for="b in row.blockers" :key="b.annealId" class="slot-option__blocker">
                    被「{{ b.pieceName }}」{{ b.inAt.replace('T', ' ') }} 入窑的{{ b.curveSeg }}段挡住
                    <span class="slot-option__blocker-time">
                      （{{ b.state === '已出炉' ? '出炉' : '临时出炉' }}至 {{ b.effectiveOutAt.replace('T', ' ') }}）
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </el-form-item>

        <el-alert
          v-if="noSlotAvailable"
          type="error"
          show-icon
          :closable="false"
          title="该退火窑在所选时间窗内没有可用窑位"
          description="请调整入窑时间、出炉时间或曲线段后再保存；未出炉记录按「入窑 + 该段理论时长」估算临时出炉时间。"
        />
        <el-alert
          v-else-if="conflict.conflict"
          type="error"
          show-icon
          :closable="false"
          title="窑位冲突，无法提交"
          :description="conflict.message"
        />
        <el-alert
          v-else
          type="success"
          show-icon
          :closable="false"
          title="窑位可用，可以提交"
          :description="`当前曲线段「${form.curveSeg}」理论时长 ${formDuration.segment}，该作品全流程退火 ${formDuration.total}。${formDuration.hint}`"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="conflict.conflict || noSlotAvailable" @click="handleSubmit">
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
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 10px;
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

.slot-name {
  font-size: 13px;
  font-weight: 600;
  color: #1d2b3a;
}

.slot-detail {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: #5b6b7a;
}

.slot-detail.is-free {
  color: #a8b0b8;
}

.slot-cell.is-overlap {
  border-color: #f56c6c;
  background: #fff1f0;
}

.slot-detail.is-overlap {
  color: #c45656;
  font-weight: 600;
}

.slot-relation {
  margin-right: 6px;
}

/* 分配 / 编辑弹窗内的窑位选择器 */
.slot-picker {
  width: 100%;
}

.slot-picker__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.slot-picker__current {
  font-size: 13px;
  font-weight: 600;
  color: #24405e;
}

.slot-picker__hint {
  font-size: 12px;
  color: #8b95a1;
}

.slot-picker__empty {
  padding: 18px 12px;
  border: 1px dashed #d4dbe3;
  border-radius: 8px;
  text-align: center;
  font-size: 13px;
  color: #8b95a1;
  background: #fafcff;
}

.slot-picker__list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
  max-height: 280px;
  overflow-y: auto;
  padding-right: 2px;
}

.slot-option {
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 8px 10px;
  background: #fafcff;
  cursor: pointer;
  transition: all 0.15s ease;
}

.slot-option.is-available:hover {
  border-color: #67c23a;
  background: #f0f9eb;
}

.slot-option.is-selected {
  border-color: #24405e;
  background: #eaf1f8;
  box-shadow: 0 0 0 1px #24405e inset;
}

.slot-option.is-blocked {
  cursor: not-allowed;
  border-color: #fbc4c4;
  background: #fff5f5;
  opacity: 0.92;
}

.slot-option__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.slot-option__name {
  font-size: 13px;
  font-weight: 600;
  color: #1d2b3a;
}

.slot-option__blockers {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.slot-option__blocker {
  font-size: 12px;
  line-height: 1.5;
  color: #c45656;
}

.slot-option__blocker-time {
  color: #e6a23c;
}

.mt-14 {
  margin-top: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
