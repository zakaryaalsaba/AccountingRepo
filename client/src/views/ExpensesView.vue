<script setup>
import { ref, onMounted, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();

const expenses = ref([]);
const accounts = ref([]);
const loading = ref(false);
const error = ref('');

const form = ref({
  account_id: '',
  amount: '',
  description: '',
  expense_date: new Date().toISOString().slice(0, 10),
});

const expenseAccounts = computed(() => accounts.value.filter((a) => a.type === 'EXPENSE'));

async function load() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const [ex, acc] = await Promise.all([
      api.get('/api/expenses'),
      api.get('/api/accounts'),
    ]);
    expenses.value = ex.data.expenses || [];
    accounts.value = acc.data.accounts || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  } finally {
    loading.value = false;
  }
}

async function add() {
  error.value = '';
  try {
    await api.post('/api/expenses', {
      account_id: form.value.account_id,
      amount: Number(form.value.amount),
      description: form.value.description || null,
      expense_date: form.value.expense_date,
    });
    form.value = {
      account_id: '',
      amount: '',
      description: '',
      expense_date: new Date().toISOString().slice(0, 10),
    };
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function remove(id) {
  if (!confirm('OK?')) return;
  try {
    await api.delete(`/api/expenses/${id}`);
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

onMounted(load);
watch(() => company.currentCompanyId, load);
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('expenses.title') }}</h1>
      <p class="ui-page-desc">{{ t('expenses.add') }}</p>
    </div>

    <div class="ui-card ui-card-pad">
      <h2 class="ui-card-title mb-5">{{ t('expenses.add') }}</h2>
      <form class="grid gap-4 sm:grid-cols-2" @submit.prevent="add">
        <div>
          <label class="ui-label">{{ t('expenses.account') }}</label>
          <select v-model="form.account_id" required class="ui-select">
            <option value="">{{ t('company.none') }}</option>
            <option v-for="a in expenseAccounts" :key="a.id" :value="a.id">{{ a.code }} — {{ a.name }}</option>
          </select>
        </div>
        <div>
          <label class="ui-label">{{ t('expenses.amount') }}</label>
          <input v-model="form.amount" type="number" step="0.01" min="0" required class="ui-input" />
        </div>
        <div class="sm:col-span-2">
          <label class="ui-label">{{ t('expenses.description') }}</label>
          <input v-model="form.description" type="text" class="ui-input" />
        </div>
        <div>
          <label class="ui-label">{{ t('expenses.date') }}</label>
          <input v-model="form.expense_date" type="date" class="ui-input" />
        </div>
        <div class="flex items-end">
          <button type="submit" class="ui-btn-primary">{{ t('common.save') }}</button>
        </div>
      </form>
      <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
        {{ error }}
      </p>
    </div>

    <div class="ui-table-wrap">
      <table class="ui-table">
        <thead>
          <tr>
            <th>{{ t('expenses.date') }}</th>
            <th>{{ t('expenses.account') }}</th>
            <th>{{ t('expenses.amount') }}</th>
            <th>{{ t('expenses.description') }}</th>
            <th>{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ex in expenses" :key="ex.id">
            <td class="whitespace-nowrap font-medium text-slate-900">{{ ex.expense_date }}</td>
            <td>
              <span class="font-mono text-xs font-semibold text-brand-800">{{ ex.account_code }}</span>
              <span class="ms-1.5 text-slate-700">{{ ex.account_name }}</span>
            </td>
            <td class="font-semibold tabular-nums">{{ Number(ex.amount).toFixed(2) }}</td>
            <td class="text-slate-600">{{ ex.description || '—' }}</td>
            <td>
              <button type="button" class="ui-btn-danger !px-2 !py-1.5 text-sm" @click="remove(ex.id)">
                {{ t('accounts.delete') }}
              </button>
            </td>
          </tr>
          <tr v-if="loading">
            <td colspan="5" class="py-12 text-center text-slate-500">{{ t('common.loading') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
