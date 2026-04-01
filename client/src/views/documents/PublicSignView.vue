<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { fetchSignSession, submitSignatures } from '@/api/esignPublic';
import SignaturePad from '@/components/documents/SignaturePad.vue';
import { publicSignErrorMessage } from '@/utils/documentsErrors';

const { t, locale } = useI18n();
const route = useRoute();

const padRef = ref(null);
const loading = ref(true);
const submitting = ref(false);
const error = ref('');
const session = ref(null);
const done = ref(false);

const token = computed(() => String(route.params.token || ''));

async function load() {
  loading.value = true;
  error.value = '';
  session.value = null;
  done.value = false;
  if (!token.value) {
    error.value = t('documents.publicError.invalid_token');
    loading.value = false;
    return;
  }
  try {
    const data = await fetchSignSession(token.value);
    session.value = data;
  } catch (e) {
    error.value = publicSignErrorMessage(e, t);
    if (e.payload?.your_signing_order != null && e.payload?.current_signing_order != null) {
      error.value += ` (${t('documents.publicWrongOrderHint', {
        yours: e.payload.your_signing_order,
        current: e.payload.current_signing_order,
      })})`;
    }
  } finally {
    loading.value = false;
  }
}

function buildSignatures(dataUrl) {
  const fields = session.value?.fields;
  const list = Array.isArray(fields) ? fields : [];
  if (list.length) {
    return list.map((f) => ({
      page: Math.max(1, parseInt(String(f.page), 10) || 1),
      x: Number(f.x) || 0,
      y: Number(f.y) || 0,
      signature_data: dataUrl,
    }));
  }
  return [
    {
      page: 1,
      x: 72,
      y: 720,
      signature_data: dataUrl,
    },
  ];
}

async function submit() {
  if (!session.value || !padRef.value) return;
  if (padRef.value.isBlank()) {
    error.value = t('documents.publicSignEmpty');
    return;
  }
  error.value = '';
  submitting.value = true;
  try {
    const dataUrl = padRef.value.toDataURL();
    const signatures = buildSignatures(dataUrl);
    await submitSignatures(token.value, signatures);
    done.value = true;
  } catch (e) {
    error.value = publicSignErrorMessage(e, t);
    if (e.payload?.your_signing_order != null) {
      error.value += ` (${t('documents.publicWrongOrderHint', {
        yours: e.payload.your_signing_order,
        current: e.payload.current_signing_order ?? t('documents.valueNone'),
      })})`;
    }
  } finally {
    submitting.value = false;
  }
}

function clearPad() {
  padRef.value?.clear();
  error.value = '';
}

onMounted(load);
watch(token, load);
</script>

<template>
  <div class="flex min-h-screen flex-col bg-slate-100 px-4 py-8" :dir="locale === 'ar' ? 'rtl' : 'ltr'">
    <div class="mx-auto w-full max-w-3xl space-y-6">
      <div class="text-center">
        <p class="text-lg font-bold text-slate-900">{{ t('app.title') }}</p>
        <p class="text-xs text-slate-500">{{ t('app.tagline') }}</p>
      </div>

      <div v-if="loading" class="ui-card ui-card-pad text-center text-slate-600">
        {{ t('documents.loading') }}
      </div>

      <div
        v-else-if="error && !session"
        role="alert"
        aria-live="polite"
        class="rounded-xl border border-rose-200 bg-rose-50 px-4 py-4 text-center text-sm text-rose-800"
      >
        {{ error }}
      </div>

      <div v-else-if="done" class="ui-card ui-card-pad text-center">
        <h1 class="text-xl font-bold text-emerald-800">{{ t('documents.publicThankYou') }}</h1>
        <p class="mt-2 text-sm text-slate-600">{{ t('documents.publicThankYouSub') }}</p>
      </div>

      <template v-else-if="session">
        <section class="ui-card ui-card-pad">
          <h1 class="ui-card-title">{{ t('documents.publicTitle') }}</h1>
          <p class="mt-1 text-lg font-semibold text-slate-900">{{ session.document?.title }}</p>
          <p class="text-sm text-slate-600">
            {{ t('documents.publicSignAs', { name: session.recipient?.name || t('documents.publicRecipientAnonymous') }) }}
          </p>
        </section>

        <section class="ui-card ui-card-pad">
          <h2 class="mb-2 text-sm font-semibold text-slate-800">{{ t('documents.previewSection') }}</h2>
          <div class="aspect-[3/4] w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
            <iframe
              v-if="session.document?.file_url"
              :title="session.document.title"
              class="h-full min-h-[20rem] w-full md:min-h-[28rem]"
              :src="session.document.file_url"
            />
          </div>
        </section>

        <section class="ui-card ui-card-pad space-y-3">
          <h2 class="text-sm font-semibold text-slate-800">{{ t('documents.publicDrawSignature') }}</h2>
          <p class="text-xs text-slate-500">{{ t('documents.publicDrawHint') }}</p>
          <div class="flex justify-center" :dir="locale === 'ar' ? 'rtl' : 'ltr'">
            <SignaturePad ref="padRef" :width="420" :height="180" />
          </div>
          <p v-if="error" role="alert" aria-live="polite" class="text-sm text-rose-700">{{ error }}</p>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="ui-btn-primary" :disabled="submitting" @click="submit">
              {{ submitting ? t('documents.publicSubmitting') : t('documents.publicSubmit') }}
            </button>
            <button type="button" class="ui-btn-secondary" @click="clearPad">{{ t('documents.publicClear') }}</button>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>
