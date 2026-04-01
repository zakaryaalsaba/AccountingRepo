<script setup>
import { ref, computed } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { uploadDocument } from '@/api/documentsApi';
import { documentsApiErrorMessage } from '@/utils/documentsErrors';

const { t } = useI18n();
const router = useRouter();
const company = useCompanyStore();

const title = ref('');
const file = ref(null);
const fileInput = ref(null);
const submitting = ref(false);
const error = ref('');

const canManage = computed(() => {
  const r = company.currentCompanyRole;
  return r === 'owner' || r === 'admin' || r === 'accountant';
});

function onFileChange(e) {
  const f = e.target?.files?.[0];
  file.value = f || null;
  error.value = '';
}

async function submit() {
  if (!canManage.value) return;
  if (!file.value) {
    error.value = t('documents.uploadFileRequired');
    return;
  }
  submitting.value = true;
  error.value = '';
  try {
    const data = await uploadDocument(file.value, title.value);
    const id = data?.document?.id;
    if (id) {
      await router.push({ name: 'document-detail', params: { id } });
    } else {
      error.value = t('documents.uploadUnexpected');
    }
  } catch (e) {
    error.value = documentsApiErrorMessage(e, t);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <RouterLink to="/documents" class="text-sm font-medium text-brand-600 hover:text-brand-700">
        {{ t('documents.navBack') }}
      </RouterLink>
      <h1 class="mt-3 text-2xl font-bold text-slate-900">{{ t('documents.navUpload') }}</h1>
      <p class="mt-1 text-sm text-slate-600">{{ t('documents.uploadSubtitle') }}</p>
    </div>

    <p v-if="!canManage" class="ui-badge-amber inline-block text-sm">
      {{ t('documents.uploadNoPermission') }}
    </p>

    <form v-else class="ui-card ui-card-pad max-w-xl space-y-4" @submit.prevent="submit">
      <label class="flex flex-col gap-1">
        <span class="ui-label">{{ t('documents.fieldTitle') }}</span>
        <input v-model="title" type="text" class="ui-input" :placeholder="t('documents.fieldTitlePlaceholder')" maxlength="500" />
      </label>

      <label class="flex flex-col gap-1">
        <span class="ui-label">{{ t('documents.fieldFile') }}</span>
        <input
          ref="fileInput"
          type="file"
          accept="application/pdf,.pdf"
          class="text-sm text-slate-700 file:me-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-800 hover:file:bg-brand-100"
          @change="onFileChange"
        />
        <span class="text-xs text-slate-500">{{ t('documents.uploadPdfOnly') }}</span>
      </label>

      <p v-if="error" role="alert" aria-live="polite" class="text-sm text-rose-700">{{ error }}</p>

      <div class="flex flex-wrap gap-2">
        <button type="submit" class="ui-btn-primary" :disabled="submitting">
          {{ submitting ? t('documents.uploading') : t('documents.uploadSubmit') }}
        </button>
        <RouterLink to="/documents" class="ui-btn-secondary">{{ t('documents.cancel') }}</RouterLink>
      </div>
    </form>
  </div>
</template>
