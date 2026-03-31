<script setup>
import { onMounted, ref, watch } from 'vue';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const company = useCompanyStore();
const events = ref([]);
const approvals = ref([]);
const loading = ref(false);
const error = ref('');

async function load() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const [e, a] = await Promise.all([
      api.get('/api/audit/events', { params: { limit: 200 } }),
      api.get('/api/audit/journal-approvals'),
    ]);
    events.value = e.data.events || [];
    approvals.value = a.data.approvals || [];
  } catch (err) {
    error.value = err.response?.data?.error || 'Failed to load audit trail';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => company.currentCompanyId, load);
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">Audit trail</h1>
      <p class="ui-page-desc">Immutable event log and journal approvals.</p>
    </div>

    <div class="grid gap-6 lg:grid-cols-2">
      <section class="ui-card ui-card-pad">
        <h2 class="ui-card-title mb-4">Recent events</h2>
        <ul class="max-h-[28rem] space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-white p-3">
          <li v-for="ev in events" :key="ev.id" class="rounded-lg border border-slate-100 p-3 text-sm">
            <p class="font-semibold text-slate-900">{{ ev.event_type }}</p>
            <p class="text-xs text-slate-500">{{ ev.entity_type }} · {{ ev.entity_id || '—' }}</p>
            <p class="mt-1 text-xs text-slate-500">{{ ev.created_at }}</p>
          </li>
        </ul>
      </section>

      <section class="ui-card ui-card-pad">
        <h2 class="ui-card-title mb-4">Journal approvals</h2>
        <ul class="max-h-[28rem] space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-white p-3">
          <li v-for="a in approvals" :key="a.id" class="rounded-lg border border-slate-100 p-3 text-sm">
            <p class="font-semibold text-slate-900">{{ a.status }} · {{ a.entry_date }}</p>
            <p class="text-xs text-slate-500">{{ a.description || '—' }}</p>
            <p class="text-xs text-slate-500">{{ a.reference || '—' }}</p>
          </li>
        </ul>
      </section>
    </div>

    <p v-if="loading" class="mt-4 text-sm text-slate-500">Loading...</p>
    <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">{{ error }}</p>
  </div>
</template>

