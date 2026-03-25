<script setup>
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const company = useCompanyStore();

const name = ref('');
const industry = ref('');
const error = ref('');
const creating = ref(false);

onMounted(async () => {
  await company.loadCompanies();
  const redirect = route.query.redirect;
  if (redirect && company.currentCompanyId) {
    await router.replace(String(redirect));
  }
});

async function create() {
  error.value = '';
  if (!name.value.trim()) return;
  creating.value = true;
  try {
    await company.createCompany(name.value.trim(), industry.value.trim() || undefined);
    name.value = '';
    industry.value = '';
    const redirect = route.query.redirect;
    if (redirect) await router.replace(String(redirect));
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('company.list') }}</h1>
      <p class="ui-page-desc">{{ t('company.selectHint') }}</p>
    </div>

    <div class="ui-card ui-card-pad">
      <h2 class="ui-card-title mb-5">{{ t('company.create') }}</h2>
      <form class="grid gap-4 sm:grid-cols-2" @submit.prevent="create">
        <div class="sm:col-span-2 md:col-span-1">
          <label class="ui-label">{{ t('company.name') }}</label>
          <input v-model="name" type="text" required class="ui-input" />
        </div>
        <div>
          <label class="ui-label">{{ t('company.industry') }}</label>
          <input v-model="industry" type="text" class="ui-input" />
        </div>
        <div class="sm:col-span-2 flex items-end">
          <button type="submit" class="ui-btn-primary" :disabled="creating">
            {{ creating ? t('common.loading') : t('common.save') }}
          </button>
        </div>
      </form>
      <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
        {{ error }}
      </p>
    </div>

    <div class="ui-table-wrap">
      <table class="ui-table min-w-0">
        <thead>
          <tr>
            <th>{{ t('company.name') }}</th>
            <th>{{ t('company.industry') }}</th>
            <th>{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in company.companies" :key="c.id">
            <td class="font-medium text-slate-900">{{ c.name }}</td>
            <td class="text-slate-500">{{ c.industry || '—' }}</td>
            <td>
              <button type="button" class="ui-btn-ghost ui-btn !px-2 !py-1.5 text-brand-700" @click="company.setCurrentCompany(c.id)">
                {{ t('company.switcher') }}
              </button>
            </td>
          </tr>
          <tr v-if="!company.companies.length">
            <td colspan="3" class="py-12 text-center text-slate-500">{{ t('company.selectHint') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
