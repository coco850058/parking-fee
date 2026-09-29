<template>
  <div class="plate-input" :class="{ 'has-error': error }">
    <div class="plate-input-head">
      <span class="plate-label">车牌号</span>
      <span class="plate-help">前两位默认{{ defaultPrefix }}，点击任意格可修改</span>
    </div>

    <div class="plate-kind" role="radiogroup" aria-label="车牌类型">
      <button type="button" :class="{ active: !newEnergy }" role="radio" :aria-checked="!newEnergy" @click="switchType(false)">
        普通车牌 · 7位
      </button>
      <button type="button" :class="{ active: newEnergy }" role="radio" :aria-checked="newEnergy" @click="switchType(true)">
        新能源车牌 · 8位
      </button>
    </div>

    <div ref="plateSlotsRef" class="plate-slots" role="group" aria-label="输入车牌号">
      <template v-for="index in slotCount" :key="index">
        <span v-if="index === 3" class="plate-separator" aria-hidden="true">·</span>
        <button
          type="button"
          class="plate-slot"
          :class="{ filled: Boolean(characters[index - 1]), energy: newEnergy && index === 8 }"
          :aria-label="`车牌第${index}位，${characters[index - 1] || '未填写'}`"
          @click="openAt(index - 1)"
        >
          {{ characters[index - 1] || '—' }}
        </button>
      </template>
    </div>
    <p v-if="error" class="plate-error" role="alert">{{ error }}</p>
    <p v-else class="plate-tip">{{ newEnergy ? '新能源车牌请输入完整的 8 位；切换类型会保留前两位' : '普通车牌请输入完整的 7 位；切换类型会保留前两位' }}</p>

    <van-popup
      v-model:show="keyboardVisible"
      position="bottom"
      round
      safe-area-inset-bottom
      :lock-scroll="false"
      class="plate-popup"
      @opened="onKeyboardOpened"
      @closed="stopViewportWatch"
    >
      <div class="keyboard-head">
        <div>
          <strong>{{ keyboardTitle }}</strong>
          <span>当前车牌 {{ modelValue || '未填写' }}</span>
        </div>
        <button type="button" class="keyboard-done" @click="keyboardVisible = false">完成</button>
      </div>
      <div class="keyboard-grid" :class="{ 'province-grid': activeIndex === 0 }">
        <button
          v-for="key in keyboardKeys"
          :key="key"
          type="button"
          class="keyboard-key"
          :class="{ 'energy-key': newEnergy && (key === 'D' || key === 'F') }"
          @click="selectKey(key)"
        >
          {{ key }}
        </button>
      </div>
      <div v-if="activeIndex >= 2" class="keyboard-actions">
        <button type="button" @click="clearSuffix">清空后几位</button>
        <button type="button" @click="backspace"><van-icon name="delete-o" /> 删除</button>
      </div>
    </van-popup>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { normalizePlate, plateLetters, plateProvinces } from '../utils';

const props = defineProps<{
  modelValue: string;
  newEnergy: boolean;
  defaultPrefix: string;
  error?: string;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: string];
  'update:newEnergy': [value: boolean];
}>();

const digits = Array.from('0123456789');
const suffixKeys = [...digits, ...plateLetters];

const keyboardVisible = ref(false);
const activeIndex = ref(2);
const plateSlotsRef = ref<HTMLElement | null>(null);
let revealFrame: number | undefined;
const slotCount = computed(() => props.newEnergy ? 8 : 7);
const characters = computed(() => Array.from(normalizePlate(props.modelValue)).slice(0, slotCount.value));
const keyboardKeys = computed(() => {
  if (activeIndex.value === 0) return plateProvinces;
  if (activeIndex.value === 1) return plateLetters;
  if (!props.newEnergy) return suffixKeys;
  if (activeIndex.value === 2) return [...digits, 'D', 'F'];
  const smallPlate = ['D', 'F'].includes(characters.value[2] || '');
  if (activeIndex.value === 3 && smallPlate) return suffixKeys;
  if (activeIndex.value === 7 && !smallPlate) return ['D', 'F'];
  return digits;
});
const keyboardTitle = computed(() => activeIndex.value === 0 ? '选择省份简称' : activeIndex.value === 1 ? '选择车牌字母' : `输入第 ${activeIndex.value + 1} 位`);

function revealPlateSlots() {
  if (!keyboardVisible.value || !plateSlotsRef.value) return;
  const popup = document.querySelector<HTMLElement>('.plate-popup');
  if (!popup) return;
  const gap = 16;
  const overlap = plateSlotsRef.value.getBoundingClientRect().bottom - popup.getBoundingClientRect().top + gap;
  if (overlap > 0) window.scrollBy(0, Math.ceil(overlap));
}

function scheduleReveal() {
  if (!keyboardVisible.value) return;
  if (revealFrame !== undefined) window.cancelAnimationFrame(revealFrame);
  revealFrame = window.requestAnimationFrame(() => {
    revealFrame = undefined;
    revealPlateSlots();
  });
}

function stopViewportWatch() {
  window.visualViewport?.removeEventListener('resize', scheduleReveal);
  window.removeEventListener('resize', scheduleReveal);
  if (revealFrame !== undefined) window.cancelAnimationFrame(revealFrame);
  revealFrame = undefined;
}

function onKeyboardOpened() {
  window.visualViewport?.addEventListener('resize', scheduleReveal);
  window.addEventListener('resize', scheduleReveal);
  scheduleReveal();
}

watch(activeIndex, async () => {
  if (!keyboardVisible.value) return;
  await nextTick();
  scheduleReveal();
});
onBeforeUnmount(stopViewportWatch);

function switchType(energy: boolean) {
  if (props.newEnergy === energy) return;
  emit('update:newEnergy', energy);
  emit('update:modelValue', Array.from(normalizePlate(props.modelValue)).slice(0, 2).join(''));
  activeIndex.value = 2;
}

function openAt(index: number) {
  const length = characters.value.length;
  activeIndex.value = index < length ? index : Math.min(length, slotCount.value - 1);
  keyboardVisible.value = true;
}

function selectKey(key: string) {
  const chars = [...characters.value];
  const index = Math.min(activeIndex.value, chars.length);
  chars[index] = key;
  emit('update:modelValue', chars.slice(0, slotCount.value).join(''));
  if (index === slotCount.value - 1) {
    keyboardVisible.value = false;
  } else {
    activeIndex.value = index + 1;
  }
}

function backspace() {
  const chars = [...characters.value];
  if (chars.length <= 2) return;
  const index = Math.min(activeIndex.value, chars.length - 1);
  chars.splice(index, 1);
  emit('update:modelValue', chars.join(''));
  activeIndex.value = Math.max(2, index);
}

function clearSuffix() {
  emit('update:modelValue', characters.value.slice(0, 2).join(''));
  activeIndex.value = 2;
}
</script>

<style scoped>
.plate-input {
  padding: 17px 0 4px;
  border-top: 1px solid var(--line);
}

.plate-input-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 10px;
  margin-bottom: 13px;
}

.plate-label {
  color: #3f4145;
  font-size: 14px;
  font-weight: 650;
}

.plate-help,
.plate-tip {
  color: var(--muted);
  font-size: 12px;
}

.plate-kind {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 14px;
}

.plate-kind button {
  min-height: 42px;
  padding: 7px 5px;
  border: 1px solid var(--line);
  border-radius: 11px;
  color: var(--muted);
  background: #fff;
  font-size: 12px;
  font-weight: 650;
}

.plate-kind button.active {
  border-color: var(--brand);
  color: var(--brand-dark);
  background: var(--brand-soft);
}

.plate-slots {
  display: flex;
  align-items: center;
  gap: 4px;
}

.plate-separator {
  margin: 0 -1px;
  color: var(--muted);
  font-weight: 700;
}

.plate-slot {
  flex: 1 1 0;
  min-width: 0;
  height: 44px;
  padding: 0;
  border: 1px solid #d5d9dd;
  border-radius: 8px;
  color: #a9afb5;
  background: #fff;
  font-size: 17px;
  font-weight: 700;
  text-align: center;
}

.plate-slot.filled {
  color: var(--ink);
}

.plate-slot.energy {
  border-color: #7bbd86;
  background: #f0faf1;
}

.plate-slot:focus-visible,
.keyboard-key:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}

.plate-tip,
.plate-error {
  margin: 9px 0 0;
  font-size: 12px;
}

.plate-error,
.has-error .plate-slot {
  color: var(--danger);
}

.has-error .plate-slot {
  border-color: var(--danger);
}

.plate-popup {
  max-height: calc(100vh - 80px);
  max-height: calc(100dvh - 80px);
  padding: 0 12px 12px;
  overflow-y: auto;
}

.keyboard-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 68px;
  gap: 12px;
}

.keyboard-head div {
  display: grid;
  gap: 3px;
}

.keyboard-head strong {
  font-size: 16px;
}

.keyboard-head span {
  color: var(--muted);
  font-size: 12px;
}

.keyboard-done {
  min-width: 58px;
  min-height: 40px;
  border: 0;
  color: var(--brand);
  background: none;
  font-weight: 700;
}

.keyboard-grid {
  display: grid;
  grid-template-columns: repeat(9, minmax(0, 1fr));
  gap: 5px;
}

.keyboard-grid.province-grid {
  grid-template-columns: repeat(8, minmax(0, 1fr));
}

.keyboard-key {
  min-width: 0;
  min-height: 42px;
  padding: 0;
  border: 1px solid #e0e4e7;
  border-radius: 7px;
  color: var(--ink);
  background: #fff;
  font-size: 16px;
  font-weight: 650;
}

.keyboard-key.energy-key {
  color: var(--success);
  background: #eaf7eb;
}

.keyboard-actions {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
}

.keyboard-actions button {
  min-height: 42px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  color: var(--brand-dark);
  background: var(--brand-soft);
  font-size: 13px;
  font-weight: 650;
}

@media (max-width: 355px) {
  .plate-slots {
    gap: 2px;
  }
  .plate-slot {
    font-size: 15px;
  }
  .keyboard-grid {
    gap: 3px;
  }
}
</style>
