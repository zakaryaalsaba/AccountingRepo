<script setup>
import { ref, onMounted, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t, locale } = useI18n();
const company = useCompanyStore();

const accounts = ref([]);
const tree = ref([]);
const loading = ref(false);
const error = ref('');

const form = ref({ name: '', type: 'ASSET', parent_id: '' });
const types = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];

function expansionStorageKey() {
  const cid = company.currentCompanyId || 'none';
  return `coa_expanded_roots:${cid}`;
}

const expandedRoots = ref(new Set());

function isExpanded(rootId) {
  return expandedRoots.value.has(rootId);
}

function toggleExpanded(rootId) {
  const s = new Set(expandedRoots.value);
  if (s.has(rootId)) s.delete(rootId);
  else s.add(rootId);
  expandedRoots.value = s;
  try {
    localStorage.setItem(expansionStorageKey(), JSON.stringify(Array.from(s)));
  } catch {
    // ignore
  }
}

function expandAll(roots) {
  const s = new Set((roots || []).map((r) => r.id));
  expandedRoots.value = s;
  try {
    localStorage.setItem(expansionStorageKey(), JSON.stringify(Array.from(s)));
  } catch {
    // ignore
  }
}

function collapseAll() {
  expandedRoots.value = new Set();
  try {
    localStorage.setItem(expansionStorageKey(), JSON.stringify([]));
  } catch {
    // ignore
  }
}

function loadExpandedFromStorage() {
  try {
    const raw = localStorage.getItem(expansionStorageKey());
    if (!raw) return false;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return false;
    expandedRoots.value = new Set(arr.filter(Boolean));
    return true;
  } catch {
    return false;
  }
}

async function load() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const [flat, treeResp] = await Promise.all([api.get('/api/accounts'), api.get('/api/accounts/tree')]);
    accounts.value = flat.data.accounts || [];
    tree.value = treeResp.data.tree || [];

    // Default: expand all root groups unless user saved a preference.
    const hadSaved = loadExpandedFromStorage();
    if (!hadSaved) expandAll(tree.value || []);
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  } finally {
    loading.value = false;
  }
}

async function add() {
  error.value = '';
  try {
    await api.post('/api/accounts', {
      name: form.value.name,
      type: form.value.type,
      parent_id: form.value.parent_id || null,
    });
    form.value = { name: '', type: 'ASSET', parent_id: '' };
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

const parentOptions = computed(() =>
  accounts.value.map((a) => ({
    id: a.id,
    label: `${a.account_code} - ${a.name}`,
    type: a.type,
    level: a.level,
  }))
);

const canSubmit = computed(() => form.value.name.trim().length > 0 && form.value.type);

const selectedParent = computed(() => accounts.value.find((a) => a.id === form.value.parent_id) || null);
watch(
  selectedParent,
  (p) => {
    if (p) form.value.type = p.type;
  },
  { immediate: false }
);

function flattenTree(nodes, depth = 0, out = []) {
  for (const n of nodes || []) {
    out.push({ ...n, depth });
    if (n.children?.length) flattenTree(n.children, depth + 1, out);
  }
  return out;
}

const groupedTreeRows = computed(() =>
  (tree.value || []).map((root) => ({
    root: { ...root, depth: 0 },
    children: flattenTree(root.children || [], 1, []),
  }))
);
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
        <select v-model="form.parent_id" class="ui-select">
          <option value="">{{ t('accounts.rootAccount') }}</option>
          <option v-for="p in parentOptions" :key="p.id" :value="p.id">
            {{ p.label }}
          </option>
        </select>
        <button type="submit" class="ui-btn-primary sm:col-span-4" :disabled="!canSubmit">
          {{ t('accounts.save') }}
        </button>
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
            <th>{{ t('accounts.level') }}</th>
            <th>{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="groupedTreeRows.length" class="bg-white">
            <td colspan="5">
              <div class="flex flex-wrap items-center justify-end gap-2 py-2">
                <button type="button" class="ui-btn-secondary !px-3 !py-1.5 text-sm" @click="expandAll(tree)">
                  {{ locale === 'ar' ? 'توسيع الكل' : 'Expand all' }}
                </button>
                <button type="button" class="ui-btn-secondary !px-3 !py-1.5 text-sm" @click="collapseAll">
                  {{ locale === 'ar' ? 'طي الكل' : 'Collapse all' }}
                </button>
              </div>
            </td>
          </tr>
          <template v-for="group in groupedTreeRows" :key="group.root.id">
            <tr class="bg-slate-50/80">
              <td class="font-mono text-sm font-bold text-brand-900">{{ group.root.account_code }}</td>
              <td class="font-semibold text-slate-900">
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    class="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                    :title="isExpanded(group.root.id) ? (locale === 'ar' ? 'طي' : 'Collapse') : (locale === 'ar' ? 'توسيع' : 'Expand')"
                    @click="toggleExpanded(group.root.id)"
                  >
                    <span v-if="isExpanded(group.root.id)">−</span>
                    <span v-else>+</span>
                  </button>
                  <span>{{ group.root.name }}</span>
                </div>
              </td>
              <td>
                <span class="ui-badge-slate">{{ t(`accounts.types.${group.root.type}`) }}</span>
              </td>
              <td class="text-slate-600">{{ group.root.level }}</td>
              <td>
                <button type="button" class="ui-btn-danger !px-2 !py-1.5 text-sm" @click="remove(group.root.id)">
                  {{ t('accounts.delete') }}
                </button>
              </td>
            </tr>
            <tr v-for="a in (isExpanded(group.root.id) ? group.children : [])" :key="a.id">
              <td class="font-mono text-sm font-semibold text-brand-800">{{ a.account_code }}</td>
              <td class="font-medium text-slate-900">
                <span :style="{ paddingInlineStart: `${a.depth * 20}px` }">
                  └ {{ a.name }}
                </span>
              </td>
              <td>
                <span class="ui-badge-slate">{{ t(`accounts.types.${a.type}`) }}</span>
              </td>
              <td class="text-slate-500">{{ a.level }}</td>
              <td>
                <button type="button" class="ui-btn-danger !px-2 !py-1.5 text-sm" @click="remove(a.id)">
                  {{ t('accounts.delete') }}
                </button>
              </td>
            </tr>
          </template>
          <tr v-if="loading">
            <td colspan="5" class="py-12 text-center text-slate-500">{{ t('common.loading') }}</td>
          </tr>
          <tr v-if="!loading && !groupedTreeRows.length">
            <td colspan="5" class="py-12 text-center text-slate-500">{{ t('accounts.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
