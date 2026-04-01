<script setup>
import { ref, onMounted, watch } from 'vue';

const props = defineProps({
  width: { type: Number, default: 400 },
  height: { type: Number, default: 160 },
});

const canvasRef = ref(null);
let ctx = null;
const drawing = ref(false);
let lastX = 0;
let lastY = 0;

function posFromEvent(e) {
  const el = canvasRef.value;
  if (!el) return { x: 0, y: 0 };
  const r = el.getBoundingClientRect();
  const scaleX = el.width / r.width;
  const scaleY = el.height / r.height;
  if (e.touches?.[0]) {
    const t = e.touches[0];
    return { x: (t.clientX - r.left) * scaleX, y: (t.clientY - r.top) * scaleY };
  }
  return { x: (e.clientX - r.left) * scaleX, y: (e.clientY - r.top) * scaleY };
}

function start(e) {
  e.preventDefault();
  drawing.value = true;
  const { x, y } = posFromEvent(e);
  lastX = x;
  lastY = y;
}

function draw(e) {
  if (!drawing.value || !ctx) return;
  e.preventDefault();
  const { x, y } = posFromEvent(e);
  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(x, y);
  ctx.stroke();
  lastX = x;
  lastY = y;
}

function end(e) {
  e?.preventDefault?.();
  drawing.value = false;
}

function setupCtx() {
  const el = canvasRef.value;
  if (!el) return;
  ctx = el.getContext('2d');
  if (!ctx) return;
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

function clear() {
  if (!canvasRef.value || !ctx) return;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, props.width, props.height);
}

function isBlank() {
  const el = canvasRef.value;
  if (!el || !ctx) return true;
  const { data } = ctx.getImageData(0, 0, el.width, el.height);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r < 248 || g < 248 || b < 248) return false;
  }
  return true;
}

function toDataURL() {
  return canvasRef.value?.toDataURL('image/png') || '';
}

defineExpose({ clear, isBlank, toDataURL });

onMounted(() => {
  setupCtx();
  clear();
});

watch(
  () => [props.width, props.height],
  () => {
    setupCtx();
    clear();
  }
);
</script>

<template>
  <canvas
    ref="canvasRef"
    dir="ltr"
    class="touch-none max-w-full cursor-crosshair rounded-lg border border-slate-300 bg-white"
    :width="width"
    :height="height"
    :style="{ width: 'min(100%, ' + width + 'px)' }"
    @mousedown="start"
    @mousemove="draw"
    @mouseup="end"
    @mouseleave="end"
    @touchstart="start"
    @touchmove="draw"
    @touchend="end"
  />
</template>
