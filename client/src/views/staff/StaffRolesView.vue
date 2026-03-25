<script setup>
import { ref, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();

const roles = ref([]);
const loading = ref(false);
const error = ref('');
const formError = ref('');

const DEFAULT_JSON = '{\n  "staff.manage": true,\n  "roles.manage": true\n}';

const createForm = ref({
  role_name: '',
  permissions_json: DEFAULT_JSON,
});

const editingId = ref(null);
const editForm = ref({
  role_name: '',
  permissions_json: '',
});

function parsePermissionsJson(str) {
  const trimmed = String(str || '').trim();
  if (!trimmed) return { ok: true, value: {} };
  try {
    const v = JSON.parse(trimmed);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return { ok: false, error: t('staff.validationJson') };
    }
    return { ok: true, value: v };
  } catch {
    return { ok: false, error: t('staff.validationJson') };
  }
}

async function loadRoles() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/api/roles');
    roles.value = data.roles || [];
  } catch (e) {
    if (e.response?.status === 403) {
      error.value = t('staff.rolesAccessDenied');
    } else {
      error.value = e.response?.data?.error || t('common.error');
    }
    roles.value = [];
  } finally {
    loading.value = false;
  }
}

function resetCreate() {
  formError.value = '';
  createForm.value = { role_name: '', permissions_json: DEFAULT_JSON };
}

async function submitCreate() {
  formError.value = '';
  if (!createForm.value.role_name?.trim()) {
    formError.value = t('staff.validationRoleName');
    return;
  }
  const parsed = parsePermissionsJson(createForm.value.permissions_json);
  if (!parsed.ok) {
    formError.value = parsed.error;
    return;
  }
  try {
    await api.post('/api/roles', {
      role_name: createForm.value.role_name.trim(),
      permissions: parsed.value,
    });
    resetCreate();
    await loadRoles();
  } catch (e) {
    formError.value = e.response?.data?.error || t('common.error');
  }
}

function startEdit(r) {
  formError.value = '';
  editingId.value = r.id;
  editForm.value = {
    role_name: r.role_name,
    permissions_json: JSON.stringify(r.permissions || {}, null, 2),
  };
}

function cancelEdit() {
  editingId.value = null;
  editForm.value = { role_name: '', permissions_json: '' };
}

async function submitEdit() {
  if (!editingId.value) return;
  formError.value = '';
  if (!editForm.value.role_name?.trim()) {
    formError.value = t('staff.validationRoleName');
    return;
  }
  const parsed = parsePermissionsJson(editForm.value.permissions_json);
  if (!parsed.ok) {
    formError.value = parsed.error;
    return;
  }
  try {
    await api.put(`/api/roles/${editingId.value}`, {
      role_name: editForm.value.role_name.trim(),
      permissions: parsed.value,
    });
    cancelEdit();
    await loadRoles();
  } catch (e) {
    formError.value = e.response?.data?.error || t('common.error');
  }
}

async function removeRole(id) {
  if (!confirm(t('clinical.confirmDelete'))) return;
  formError.value = '';
  try {
    await api.delete(`/api/roles/${id}`);
    if (editingId.value === id) cancelEdit();
    await loadRoles();
  } catch (e) {
    formError.value = e.response?.data?.error || t('common.error');
  }
}

onMounted(loadRoles);
watch(() => company.currentCompanyId, async () => {
  cancelEdit();
  resetCreate();
  await loadRoles();
});
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('staff.rolesTitle') }}</h1>
      <p class="ui-page-desc">{{ t('staff.rolesSubtitle') }}</p>
    </div>

    <p v-if="error" class="mb-6 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-100">
      {{ error }}
    </p>

    <template v-if="!error || roles.length">
      <div class="ui-card ui-card-pad mb-8">
        <h2 class="ui-card-title mb-2">{{ t('staff.addRole') }}</h2>
        <p class="mb-4 text-sm text-slate-600">{{ t('staff.permissionsHint') }}</p>
        <p v-if="formError && !editingId" class="mb-3 text-sm text-rose-600">{{ formError }}</p>
        <div class="grid gap-4">
          <div>
            <label class="ui-label">{{ t('staff.roleName') }} *</label>
            <input v-model="createForm.role_name" class="ui-input max-w-md" />
          </div>
          <div>
            <label class="ui-label">{{ t('staff.permissionsJson') }}</label>
            <textarea v-model="createForm.permissions_json" class="ui-input min-h-[8rem] w-full max-w-2xl font-mono text-xs" spellcheck="false" />
          </div>
        </div>
        <button type="button" class="ui-btn-primary mt-4" @click="submitCreate">{{ t('staff.addRole') }}</button>
      </div>

      <div v-if="editingId" class="ui-card ui-card-pad mb-8 border-2 border-brand-200/60">
        <h2 class="ui-card-title mb-4">{{ t('staff.editRole') }}</h2>
        <p v-if="formError" class="mb-3 text-sm text-rose-600">{{ formError }}</p>
        <div class="grid gap-4">
          <div>
            <label class="ui-label">{{ t('staff.roleName') }} *</label>
            <input v-model="editForm.role_name" class="ui-input max-w-md" />
          </div>
          <div>
            <label class="ui-label">{{ t('staff.permissionsJson') }}</label>
            <textarea v-model="editForm.permissions_json" class="ui-input min-h-[8rem] w-full max-w-2xl font-mono text-xs" spellcheck="false" />
          </div>
        </div>
        <div class="mt-4 flex flex-wrap gap-2">
          <button type="button" class="ui-btn-primary" @click="submitEdit">{{ t('common.save') }}</button>
          <button type="button" class="ui-btn-secondary" @click="cancelEdit">{{ t('common.cancel') }}</button>
        </div>
      </div>

      <div class="ui-table-wrap">
        <table class="ui-table text-sm">
          <thead>
            <tr>
              <th>{{ t('staff.roleName') }}</th>
              <th>{{ t('staff.permissionsJson') }}</th>
              <th>{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in roles" :key="r.id">
              <td class="font-medium">{{ r.role_name }}</td>
              <td class="max-w-xl font-mono text-xs text-slate-600">
                <span class="line-clamp-2">{{ JSON.stringify(r.permissions) }}</span>
              </td>
              <td class="flex flex-wrap gap-2">
                <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="startEdit(r)">
                  {{ t('clinical.edit') }}
                </button>
                <button type="button" class="ui-btn-danger !px-2 !py-1 text-xs" @click="removeRole(r.id)">
                  {{ t('accounts.delete') }}
                </button>
              </td>
            </tr>
            <tr v-if="loading">
              <td colspan="3" class="py-12 text-center text-slate-500">{{ t('common.loading') }}</td>
            </tr>
            <tr v-else-if="!roles.length">
              <td colspan="3" class="py-12 text-center text-slate-500">{{ t('staff.none') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
