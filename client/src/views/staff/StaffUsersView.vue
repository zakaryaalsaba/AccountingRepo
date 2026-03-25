<script setup>
import { ref, onMounted, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();

const staff = ref([]);
const roles = ref([]);
const loading = ref(false);
const error = ref('');
const formError = ref('');

const createForm = ref({
  email: '',
  password: '',
  full_name: '',
  role: 'accountant',
  staff_role_ids: [],
});

const editing = ref(null);
/** @type {import('vue').Ref<null | Record<string, unknown>>} */
const editForm = ref(null);

const systemRoles = computed(() => [
  { value: 'accountant', label: t('staff.roleAccountant') },
  { value: 'admin', label: t('staff.roleAdmin') },
  { value: 'doctor', label: t('staff.roleDoctor') },
  { value: 'receptionist', label: t('staff.roleReceptionist') },
]);

function roleLabel(role, isOwner) {
  if (isOwner) return t('staff.owner');
  return systemRoles.value.find((r) => r.value === role)?.label || role;
}

/** Accepts a Vue ref or a plain form object (template auto-unwraps refs). */
function toggleRoleId(formRefOrObj, id) {
  const f = formRefOrObj && 'value' in formRefOrObj ? formRefOrObj.value : formRefOrObj;
  if (!f?.staff_role_ids) return;
  const a = f.staff_role_ids;
  const i = a.indexOf(id);
  if (i >= 0) a.splice(i, 1);
  else a.push(id);
}

function isRoleChecked(arr, id) {
  return arr.includes(id);
}

async function loadRoles() {
  if (!company.currentCompanyId) return;
  try {
    const { data } = await api.get('/api/roles');
    roles.value = data.roles || [];
  } catch {
    roles.value = [];
  }
}

async function loadStaff() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/api/staff');
    staff.value = data.staff || [];
  } catch (e) {
    if (e.response?.status === 403) {
      error.value = t('staff.accessDenied');
    } else {
      error.value = e.response?.data?.error || t('common.error');
    }
    staff.value = [];
  } finally {
    loading.value = false;
  }
}

function resetCreate() {
  formError.value = '';
  createForm.value = {
    email: '',
    password: '',
    full_name: '',
    role: 'accountant',
    staff_role_ids: [],
  };
}

async function submitCreate() {
  formError.value = '';
  if (!createForm.value.email?.trim()) {
    formError.value = t('staff.validationEmail');
    return;
  }
  try {
    await api.post('/api/staff', {
      email: createForm.value.email.trim(),
      password: createForm.value.password || undefined,
      full_name: createForm.value.full_name || undefined,
      role: createForm.value.role,
      staff_role_ids: createForm.value.staff_role_ids,
    });
    resetCreate();
    await loadStaff();
  } catch (e) {
    formError.value = e.response?.data?.error || t('common.error');
  }
}

function startEdit(row) {
  formError.value = '';
  editing.value = row.user_id;
  editForm.value = {
    full_name: row.full_name || '',
    email: row.email || '',
    role: row.role === 'owner' ? 'admin' : row.role,
    new_password: '',
    is_active: row.is_active !== false,
    staff_role_ids: (row.staff_roles || []).map((r) => r.id),
    is_owner: row.is_owner,
  };
}

function cancelEdit() {
  editing.value = null;
  editForm.value = null;
}

async function submitEdit() {
  if (!editing.value || !editForm.value) return;
  formError.value = '';
  const uid = editing.value;
  const f = editForm.value;
  try {
    if (f.is_owner) {
      await api.put(`/api/staff/${uid}`, {
        email: f.email || undefined,
        full_name: f.full_name || null,
        new_password: f.new_password || undefined,
      });
    } else {
      await api.put(`/api/staff/${uid}`, {
        email: f.email || undefined,
        full_name: f.full_name || null,
        new_password: f.new_password || undefined,
        role: f.role,
        is_active: f.is_active,
        staff_role_ids: f.staff_role_ids,
      });
    }
    cancelEdit();
    await loadStaff();
  } catch (e) {
    formError.value = e.response?.data?.error || t('common.error');
  }
}

async function deactivateUser(row) {
  if (row.is_owner) return;
  if (!confirm(t('staff.confirmDeactivate'))) return;
  formError.value = '';
  try {
    await api.delete(`/api/staff/${row.user_id}`);
    if (editing.value === row.user_id) cancelEdit();
    await loadStaff();
  } catch (e) {
    formError.value = e.response?.data?.error || t('common.error');
  }
}

async function reactivateUser(row) {
  if (row.is_owner) return;
  formError.value = '';
  try {
    await api.put(`/api/staff/${row.user_id}`, { is_active: true });
    await loadStaff();
  } catch (e) {
    formError.value = e.response?.data?.error || t('common.error');
  }
}

onMounted(async () => {
  await loadRoles();
  await loadStaff();
});
watch(
  () => company.currentCompanyId,
  async () => {
    cancelEdit();
    resetCreate();
    await loadRoles();
    await loadStaff();
  }
);
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('staff.usersTitle') }}</h1>
      <p class="ui-page-desc">{{ t('staff.usersSubtitle') }}</p>
    </div>

    <p v-if="error" class="mb-6 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-100">
      {{ error }}
    </p>

    <template v-if="!error || staff.length">
      <div class="ui-card ui-card-pad mb-8">
        <h2 class="ui-card-title mb-4">{{ t('staff.addUser') }}</h2>
        <p v-if="formError && !editing" class="mb-3 text-sm text-rose-600">{{ formError }}</p>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="ui-label">{{ t('staff.email') }} *</label>
            <input v-model="createForm.email" type="email" class="ui-input w-full" autocomplete="off" />
          </div>
          <div>
            <label class="ui-label">{{ t('staff.password') }}</label>
            <input v-model="createForm.password" type="password" class="ui-input w-full" autocomplete="new-password" />
          </div>
          <div class="sm:col-span-2">
            <label class="ui-label">{{ t('staff.fullName') }}</label>
            <input v-model="createForm.full_name" class="ui-input w-full" />
          </div>
          <div>
            <label class="ui-label">{{ t('staff.systemRole') }}</label>
            <select v-model="createForm.role" class="ui-select w-full">
              <option v-for="r in systemRoles" :key="r.value" :value="r.value">{{ r.label }}</option>
            </select>
          </div>
          <div class="sm:col-span-2">
            <p class="ui-label mb-2">{{ t('staff.customRoles') }}</p>
            <div class="flex flex-wrap gap-3">
              <label v-for="sr in roles" :key="sr.id" class="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  :checked="isRoleChecked(createForm.staff_role_ids, sr.id)"
                  @change="toggleRoleId(createForm, sr.id)"
                />
                {{ sr.role_name }}
              </label>
              <span v-if="!roles.length" class="text-sm text-slate-500">{{ t('staff.none') }}</span>
            </div>
          </div>
        </div>
        <button type="button" class="ui-btn-primary mt-4" @click="submitCreate">{{ t('staff.addUser') }}</button>
      </div>

      <div v-if="editing && editForm" class="ui-card ui-card-pad mb-8 border-2 border-brand-200/60">
        <h2 class="ui-card-title mb-4">{{ t('staff.editUser') }}</h2>
        <p v-if="formError" class="mb-3 text-sm text-rose-600">{{ formError }}</p>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="ui-label">{{ t('staff.email') }}</label>
            <input v-model="editForm.email" type="email" class="ui-input w-full" />
          </div>
          <div>
            <label class="ui-label">{{ t('staff.newPassword') }}</label>
            <input v-model="editForm.new_password" type="password" class="ui-input w-full" autocomplete="new-password" />
          </div>
          <div class="sm:col-span-2">
            <label class="ui-label">{{ t('staff.fullName') }}</label>
            <input v-model="editForm.full_name" class="ui-input w-full" />
          </div>
          <template v-if="!editForm.is_owner">
            <div>
              <label class="ui-label">{{ t('staff.systemRole') }}</label>
              <select v-model="editForm.role" class="ui-select w-full">
                <option v-for="r in systemRoles" :key="r.value" :value="r.value">{{ r.label }}</option>
              </select>
            </div>
            <div class="flex items-center gap-2 pt-6">
              <input id="active" v-model="editForm.is_active" type="checkbox" class="rounded border-slate-300" />
              <label for="active" class="text-sm font-medium text-slate-700">{{ t('staff.active') }}</label>
            </div>
            <div class="sm:col-span-2">
              <p class="ui-label mb-2">{{ t('staff.customRoles') }}</p>
              <div class="flex flex-wrap gap-3">
                <label v-for="sr in roles" :key="sr.id" class="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    :checked="isRoleChecked(editForm.staff_role_ids, sr.id)"
                    @change="toggleRoleId(editForm, sr.id)"
                  />
                  {{ sr.role_name }}
                </label>
              </div>
            </div>
          </template>
        </div>
        <div class="mt-4 flex flex-wrap gap-2">
          <button type="button" class="ui-btn-primary" @click="submitEdit">{{ t('staff.saveUser') }}</button>
          <button type="button" class="ui-btn-secondary" @click="cancelEdit">{{ t('common.cancel') }}</button>
        </div>
      </div>

      <div class="ui-table-wrap">
        <table class="ui-table text-sm">
          <thead>
            <tr>
              <th>{{ t('staff.email') }}</th>
              <th>{{ t('staff.fullName') }}</th>
              <th>{{ t('staff.systemRole') }}</th>
              <th>{{ t('staff.assignedRoles') }}</th>
              <th>{{ t('clinical.status') }}</th>
              <th>{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in staff"
              :key="row.user_id"
              :class="!row.is_active && !row.is_owner ? 'bg-slate-50 text-slate-500' : ''"
            >
              <td class="font-medium">{{ row.email }}</td>
              <td>{{ row.full_name || t('staff.none') }}</td>
              <td>{{ roleLabel(row.role, row.is_owner) }}</td>
              <td class="max-w-[14rem] text-slate-600">
                {{
                  row.staff_roles && row.staff_roles.length
                    ? row.staff_roles.map((r) => r.role_name).join(', ')
                    : t('staff.none')
                }}
              </td>
              <td>
                <span v-if="row.is_owner" class="ui-badge-amber text-[10px]">{{ t('staff.owner') }}</span>
                <span v-else-if="row.is_active" class="text-emerald-700">{{ t('staff.active') }}</span>
                <span v-else class="text-rose-600">{{ t('staff.inactive') }}</span>
              </td>
              <td class="flex flex-wrap gap-2">
                <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="startEdit(row)">
                  {{ t('clinical.edit') }}
                </button>
                <button
                  v-if="!row.is_owner && row.is_active"
                  type="button"
                  class="ui-btn-danger !px-2 !py-1 text-xs"
                  @click="deactivateUser(row)"
                >
                  {{ t('staff.deactivate') }}
                </button>
                <button
                  v-if="!row.is_owner && !row.is_active"
                  type="button"
                  class="ui-btn-primary !px-2 !py-1 text-xs"
                  @click="reactivateUser(row)"
                >
                  {{ t('staff.reactivate') }}
                </button>
              </td>
            </tr>
            <tr v-if="loading">
              <td colspan="6" class="py-12 text-center text-slate-500">{{ t('common.loading') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
