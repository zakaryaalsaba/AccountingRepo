<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();

const loading = ref(false);
const error = ref('');
const cheques = ref([]);
const accounts = ref([]);
const selectedChequeId = ref('');
const events = ref([]);
const mode = ref('opening');
const direction = ref('incoming');

const form = ref({
  cheque_number: '',
  amount: '',
  issue_date: new Date().toISOString().slice(0, 10),
  due_date: new Date().toISOString().slice(0, 10),
  status: 'received',
  source_account_id: '',
  clearing_account_id: '',
  cash_account_id: '',
  counterparty_name: '',
  notes: '',
});

const filteredCheques = computed(() => {
  if (mode.value === 'opening') return cheques.value;
  return cheques.value.filter((c) => c.direction === mode.value);
});

async function load() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const [c, a] = await Promise.all([api.get('/api/cheques'), api.get('/api/accounts')]);
    cheques.value = c.data.cheques || [];
    accounts.value = a.data.accounts || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  } finally {
    loading.value = false;
  }
}

function syncStatus() {
  if (direction.value === 'incoming') form.value.status = 'received';
  if (direction.value === 'outgoing') form.value.status = 'issued';
}

async function createCheque() {
  error.value = '';
  try {
    await api.post('/api/cheques', {
      ...form.value,
      direction: mode.value === 'opening' ? direction.value : mode.value,
      amount: Number(form.value.amount || 0),
      counterparty_type: 'other',
    });
    form.value.cheque_number = '';
    form.value.amount = '';
    form.value.counterparty_name = '';
    form.value.notes = '';
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function transitionCheque(chequeId, toStatus) {
  try {
    const payload = {
      to_status: toStatus,
      event_date: new Date().toISOString().slice(0, 10),
      reason: ['bounced', 'cancelled'].includes(toStatus) ? 'status change' : null,
      attachment_reference: ['bounced', 'cancelled'].includes(toStatus) ? 'manual' : null,
    };
    if (toStatus === 'replaced') {
      payload.replacement_cheque_payload = {
        cheque_number: `R-${Date.now()}`,
        due_date: new Date().toISOString().slice(0, 10),
      };
    }
    await api.post(`/api/cheques/${chequeId}/transition`, payload);
    await load();
    if (selectedChequeId.value === chequeId) await loadEvents(chequeId);
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function loadEvents(chequeId) {
  selectedChequeId.value = chequeId;
  try {
    const { data } = await api.get(`/api/cheques/${chequeId}/events`);
    events.value = data.events || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

onMounted(load);
watch(() => company.currentCompanyId, load);
watch(direction, syncStatus);
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('cheques.title') }}</h1>
      <p class="ui-page-desc">{{ t('cheques.subtitle') }}</p>
    </div>

    <section class="ui-card ui-card-pad mb-6">
      <div class="mb-3 flex flex-wrap gap-2">
        <button type="button" class="ui-btn-secondary" :class="{ '!bg-brand-600 !text-white': mode === 'opening' }" @click="mode = 'opening'">{{ t('cheques.modeOpening') }}</button>
        <button type="button" class="ui-btn-secondary" :class="{ '!bg-brand-600 !text-white': mode === 'incoming' }" @click="mode = 'incoming'">{{ t('cheques.modeIncoming') }}</button>
        <button type="button" class="ui-btn-secondary" :class="{ '!bg-brand-600 !text-white': mode === 'outgoing' }" @click="mode = 'outgoing'">{{ t('cheques.modeOutgoing') }}</button>
      </div>
      <div class="grid gap-3 md:grid-cols-4">
        <select v-if="mode === 'opening'" v-model="direction" class="ui-select">
          <option value="incoming">{{ t('cheques.modeIncoming') }}</option>
          <option value="outgoing">{{ t('cheques.modeOutgoing') }}</option>
        </select>
        <input v-model="form.cheque_number" class="ui-input" :placeholder="t('cheques.chequeNumber')" />
        <input v-model="form.amount" type="number" class="ui-input" :placeholder="t('cheques.amount')" />
        <input v-model="form.issue_date" type="date" class="ui-input" />
        <input v-model="form.due_date" type="date" class="ui-input" />
        <select v-model="form.source_account_id" class="ui-select">
          <option value="">{{ t('cheques.sourceAccount') }}</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.account_code }} - {{ a.name }}</option>
        </select>
        <select v-model="form.clearing_account_id" class="ui-select">
          <option value="">{{ t('cheques.clearingAccount') }}</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.account_code }} - {{ a.name }}</option>
        </select>
        <select v-model="form.cash_account_id" class="ui-select">
          <option value="">{{ t('cheques.cashAccount') }}</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.account_code }} - {{ a.name }}</option>
        </select>
        <input v-model="form.counterparty_name" class="ui-input" :placeholder="t('cheques.counterparty')" />
        <input v-model="form.notes" class="ui-input md:col-span-2" :placeholder="t('cheques.notes')" />
      </div>
      <button type="button" class="ui-btn-primary mt-3" @click="createCheque">{{ t('cheques.create') }}</button>
    </section>

    <div class="grid gap-6 lg:grid-cols-2">
      <section class="ui-card ui-card-pad">
        <h2 class="ui-card-title mb-3">{{ t('cheques.listTitle') }}</h2>
        <p v-if="loading">{{ t('common.loading') }}</p>
        <p v-else-if="error" class="text-rose-600">{{ error }}</p>
        <div v-else class="ui-table-wrap">
          <table class="ui-table">
            <thead>
              <tr>
                <th>{{ t('cheques.chequeNumber') }}</th>
                <th>{{ t('cheques.direction') }}</th>
                <th>{{ t('cheques.status') }}</th>
                <th>{{ t('cheques.amount') }}</th>
                <th>{{ t('common.actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in filteredCheques" :key="c.id">
                <td>
                  <button type="button" class="text-brand-700 hover:underline" @click="loadEvents(c.id)">
                    {{ c.cheque_number }}
                  </button>
                </td>
                <td>{{ c.direction }}</td>
                <td>{{ c.status }}</td>
                <td>{{ Number(c.amount || 0).toFixed(2) }}</td>
                <td>
                  <div class="flex flex-wrap gap-1">
                    <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="transitionCheque(c.id, 'under_collection')">{{ t('cheques.toCollection') }}</button>
                    <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="transitionCheque(c.id, 'cleared')">{{ t('cheques.toCleared') }}</button>
                    <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="transitionCheque(c.id, 'bounced')">{{ t('cheques.toBounced') }}</button>
                    <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="transitionCheque(c.id, 'cancelled')">{{ t('cheques.toCancelled') }}</button>
                    <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="transitionCheque(c.id, 'replaced')">{{ t('cheques.toReplaced') }}</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="ui-card ui-card-pad">
        <h2 class="ui-card-title mb-3">{{ t('cheques.eventsTitle') }}</h2>
        <p v-if="!selectedChequeId">{{ t('cheques.selectForEvents') }}</p>
        <ul v-else class="space-y-2">
          <li v-for="ev in events" :key="ev.id" class="rounded-lg border border-slate-200 p-3">
            <div class="text-sm text-slate-700">
              {{ ev.from_status || '-' }} -> {{ ev.to_status }} ({{ ev.event_date?.slice(0, 10) }})
            </div>
            <div class="text-xs text-slate-500">
              {{ t('cheques.transactionId') }}: {{ ev.transaction_id || '-' }}
            </div>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
