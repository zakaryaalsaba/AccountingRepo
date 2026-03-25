<script setup>
import { ref, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();

const accounts = ref([]);
const loading = ref(false);
const error = ref('');

const form = ref({ code: '', name: '', type: 'ASSET' });
const types = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];

async function load() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/api/accounts');
    accounts.value = data.accounts || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  } finally {
    loading.value = false;
  }
}

async function add() {
  error.value = '';
  try {
    await api.post('/api/accounts', form.value);
    form.value = { code: '', name: '', type: 'ASSET' };
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function remove(id) {
  if (!confirm('OK?')) return;
  try {
    await api.delete(`/api/accounts/${id}`);
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
      <h1 class="ui-page-title">{{ t('accounts.title') }}</h1>
      <p class="ui-page-desc">{{ t('accounts.add') }}</p>
    </div>

    <div class="ui-card ui-card-pad">
      <h2 class="ui-card-title mb-5">{{ t('accounts.add') }}</h2>
      <form class="grid gap-3 sm:grid-cols-4" @submit.prevent="add">
        <input v-model="form.code" required :placeholder="t('accounts.code')" class="ui-input" />
        <input
          v-model="form.name"
          required
          :placeholder="t('accounts.name')"
          class="ui-input sm:col-span-2"
        />
        <select v-model="form.type" class="ui-select">
          <option v-for="tp in types" :key="tp" :value="tp">
            {{ t(`accounts.types.${tp}`) }}
          </option>
        </select>
        <button type="submit" class="ui-btn-primary sm:col-span-4">{{ t('accounts.save') }}</button>
      </form>
      <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
        {{ error }}
      </p>
    </div>

    <div class="ui-table-wrap">
      <table class="ui-table">
        <thead>
          <tr>
            <th>{{ t('accounts.code') }}</th>
            <th>{{ t('accounts.name') }}</th>
            <th>{{ t('accounts.type') }}</th>
            <th>{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in accounts" :key="a.id">
            <td class="font-mono text-sm font-semibold text-brand-800">{{ a.code }}</td>
            <td class="font-medium text-slate-900">{{ a.name }}</td>
            <td>
              <span class="ui-badge-slate">{{ t(`accounts.types.${a.type}`) }}</span>
            </td>
            <td>
              <button type="button" class="ui-btn-danger !px-2 !py-1.5 text-sm" @click="remove(a.id)">
                {{ t('accounts.delete') }}
              </button>
            </td>
          </tr>
          <tr v-if="loading">
            <td colspan="4" class="py-12 text-center text-slate-500">{{ t('common.loading') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
