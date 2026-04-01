<script setup>
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();
const tree = ref([]);
const error = ref('');

async function load() {
  if (!company.currentCompanyId) return;
  error.value = '';
  try {
    const r = await api.get('/api/accounts/tree');
    tree.value = r.data.tree || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('accountTreeView.loadFailed');
  }
}

onMounted(load);
watch(() => company.currentCompanyId, load);
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('accountTreeView.title') }}</h1>
      <p class="ui-page-desc">{{ t('accountTreeView.subtitle') }}</p>
    </div>
    <section class="ui-card ui-card-pad">
      <ul class="space-y-2">
        <li v-for="root in tree" :key="root.id" class="rounded-xl border border-slate-100 p-3">
          <p class="font-semibold">{{ root.account_code }} — {{ root.name }}</p>
          <ul class="ms-4 mt-2 list-disc space-y-1 text-sm text-slate-700">
            <template v-for="c1 in root.children || []" :key="c1.id">
              <li>{{ c1.account_code }} — {{ c1.name }}</li>
              <li v-for="c2 in c1.children || []" :key="c2.id" class="ms-4 list-[circle]">
                {{ c2.account_code }} — {{ c2.name }}
              </li>
            </template>
          </ul>
        </li>
      </ul>
      <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">{{ error }}</p>
    </section>
  </div>
</template>

