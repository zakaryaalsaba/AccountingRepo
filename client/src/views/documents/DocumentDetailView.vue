<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { useAuthStore } from '@/stores/auth';
import { getDocument, patchDocument, sendDocument } from '@/api/documentsApi';
import { documentsApiErrorMessage } from '@/utils/documentsErrors';

const { t, locale } = useI18n();
const route = useRoute();
const company = useCompanyStore();
const auth = useAuthStore();

const loading = ref(true);
const saving = ref(false);
const sending = ref(false);
const error = ref('');
const doc = ref(null);
const title = ref('');
const recipients = ref([]);
const placements = ref([]);
const showLinksModal = ref(false);
const signingLinks = ref([]);
const copyHint = ref('');
let copyHintTimer = null;

const df = computed(() =>
  new Intl.DateTimeFormat(locale.value === 'ar' ? 'ar-SA' : 'en-US', {
    dateStyle: 'short',
    timeStyle: 'short',
  })
);

const isDraft = computed(() => doc.value?.status === 'DRAFT');

const canEdit = computed(() => {
  if (!isDraft.value || !doc.value) return false;
  const r = company.currentCompanyRole;
  if (r === 'owner' || r === 'admin' || r === 'accountant') return true;
  if (r === 'viewer' && auth.user?.id && doc.value.owner_id === auth.user.id) return true;
  return false;
});

function parsePlacementsJson(p) {
  if (Array.isArray(p)) return p.map((x) => ({ page: Number(x.page), x: Number(x.x), y: Number(x.y) }));
  if (typeof p === 'string') {
    try {
      const j = JSON.parse(p);
      return Array.isArray(j) ? j.map((x) => ({ page: Number(x.page), x: Number(x.x), y: Number(x.y) })) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function nextOrder() {
  const m = recipients.value.reduce((a, r) => Math.max(a, Number(r.signing_order) || 0), 0);
  return m + 1;
}

function addRecipient() {
  recipients.value.push({ name: '', email: '', signing_order: nextOrder() });
}

function removeRecipient(i) {
  recipients.value.splice(i, 1);
}

function addPlacement() {
  placements.value.push({ page: 1, x: 100, y: 700 });
}

function removePlacement(i) {
  placements.value.splice(i, 1);
}

function statusLabel(s) {
  if (s === 'DRAFT') return t('documents.statusDraft');
  if (s === 'SENT') return t('documents.statusSent');
  if (s === 'SIGNED') return t('documents.statusSigned');
  return s || '—';
}

function statusClass(s) {
  if (s === 'DRAFT') return 'bg-amber-100 text-amber-900';
  if (s === 'SENT') return 'bg-sky-100 text-sky-900';
  if (s === 'SIGNED') return 'bg-emerald-100 text-emerald-900';
  return 'bg-slate-100 text-slate-700';
}

async function load() {
  const id = route.params.id;
  if (!id || !company.currentCompanyId) {
    doc.value = null;
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const data = await getDocument(id);
    doc.value = data.document;
    title.value = data.document?.title || '';
    const draft = data.document?.status === 'DRAFT';
    recipients.value = (data.recipients || []).map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      signing_order: r.signing_order,
    }));
    if (!recipients.value.length && draft) {
      addRecipient();
    }
    placements.value = parsePlacementsJson(data.document?.placements_json);
    if (!placements.value.length && draft) {
      addPlacement();
    }
  } catch (e) {
    error.value = documentsApiErrorMessage(e, t);
    doc.value = null;
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!canEdit.value || !doc.value) return;
  error.value = '';
  saving.value = true;
  try {
    const recs = recipients.value
      .filter((r) => String(r.name).trim() && String(r.email).trim())
      .map((r) => ({
        name: String(r.name).trim(),
        email: String(r.email).trim().toLowerCase(),
        signing_order: Math.max(1, parseInt(String(r.signing_order), 10) || 1),
      }));
    if (!recs.length) {
      error.value = t('documents.recipientsRequired');
      saving.value = false;
      return;
    }
    const pl = placements.value
      .filter((p) => p.page >= 1 && Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => ({ page: Number(p.page), x: Number(p.x), y: Number(p.y) }));
    const data = await patchDocument(doc.value.id, {
      title: title.value.trim() || doc.value.title,
      recipients: recs,
      placements_json: pl,
    });
    doc.value = data.document;
    recipients.value = (data.recipients || []).map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      signing_order: r.signing_order,
    }));
    placements.value = parsePlacementsJson(data.document?.placements_json);
  } catch (e) {
    error.value = documentsApiErrorMessage(e, t);
  } finally {
    saving.value = false;
  }
}

async function send() {
  if (!canEdit.value || !doc.value) return;
  if (!window.confirm(t('documents.sendConfirm'))) return;
  error.value = '';
  sending.value = true;
  try {
    const data = await sendDocument(doc.value.id);
    doc.value = data.document;
    recipients.value = (data.recipients || []).map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      signing_order: r.signing_order,
    }));
    signingLinks.value = data.signing_links || [];
    showLinksModal.value = true;
  } catch (e) {
    error.value = documentsApiErrorMessage(e, t);
  } finally {
    sending.value = false;
  }
}

function copyLink(text) {
  if (!navigator.clipboard?.writeText) return;
  navigator.clipboard.writeText(text).then(() => {
    copyHint.value = t('documents.linkCopied');
    if (copyHintTimer) clearTimeout(copyHintTimer);
    copyHintTimer = setTimeout(() => {
      copyHint.value = '';
    }, 2500);
  }).catch(() => {});
}

function closeLinksModal() {
  showLinksModal.value = false;
  copyHint.value = '';
}

onMounted(load);
watch(
  () => [route.params.id, company.currentCompanyId],
  () => load()
);
</script>

<template>
  <div class="space-y-6">
    <div>
      <RouterLink to="/documents" class="text-sm font-medium text-brand-600 hover:text-brand-700">
        {{ t('documents.navBack') }}
      </RouterLink>
    </div>

    <p v-if="!company.currentCompanyId" class="ui-badge-amber inline-block text-sm">
      {{ t('documents.selectCompanyFirst') }}
    </p>

    <div v-else-if="loading" class="ui-card ui-card-pad text-slate-500">{{ t('documents.loading') }}</div>

    <p
      v-else-if="error && !doc"
      role="alert"
      aria-live="polite"
      class="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
    >
      {{ error }}
    </p>

    <template v-else-if="doc">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-3">
            <h1 class="text-2xl font-bold text-slate-900">{{ t('documents.detailTitle') }}</h1>
            <span class="inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold" :class="statusClass(doc.status)">
              {{ statusLabel(doc.status) }}
            </span>
          </div>
          <p class="mt-1 font-mono text-xs text-slate-500">{{ doc.id }}</p>
        </div>
        <div v-if="canEdit && isDraft" class="flex flex-wrap gap-2">
          <button type="button" class="ui-btn-secondary" :disabled="saving" @click="save">
            {{ saving ? t('documents.saving') : t('documents.saveDraft') }}
          </button>
          <button type="button" class="ui-btn-primary" :disabled="sending" @click="send">
            {{ sending ? t('documents.sending') : t('documents.sendForSign') }}
          </button>
        </div>
      </div>

      <p v-if="error" role="alert" aria-live="polite" class="text-sm text-rose-700">{{ error }}</p>

      <div class="grid gap-6 lg:grid-cols-2">
        <section class="ui-card ui-card-pad space-y-3">
          <h2 class="ui-card-title">{{ t('documents.previewSection') }}</h2>
          <input
            v-if="canEdit && isDraft"
            v-model="title"
            type="text"
            class="ui-input w-full"
            :placeholder="t('documents.fieldTitle')"
          />
          <p v-else class="text-lg font-semibold text-slate-900">{{ doc.title }}</p>
          <div class="aspect-[3/4] w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
            <iframe
              v-if="doc.file_url"
              :title="doc.title"
              class="h-full min-h-[28rem] w-full"
              :src="doc.file_url"
            />
            <p v-else class="p-4 text-sm text-slate-500">{{ t('documents.noFileUrl') }}</p>
          </div>
        </section>

        <div class="space-y-6">
          <section v-if="canEdit && isDraft" class="ui-card ui-card-pad space-y-3">
            <div class="flex items-center justify-between gap-2">
              <h2 class="ui-card-title">{{ t('documents.recipientsSection') }}</h2>
              <button type="button" class="text-sm font-medium text-brand-600 hover:text-brand-700" @click="addRecipient">
                + {{ t('documents.addRecipient') }}
              </button>
            </div>
            <div class="space-y-3">
              <div
                v-for="(r, i) in recipients"
                :key="i"
                class="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 sm:flex-row sm:flex-wrap sm:items-end"
              >
                <label class="min-w-0 flex-1">
                  <span class="ui-label">{{ t('documents.recipientName') }}</span>
                  <input v-model="r.name" type="text" class="ui-input w-full" />
                </label>
                <label class="min-w-0 flex-1">
                  <span class="ui-label">{{ t('documents.recipientEmail') }}</span>
                  <input v-model="r.email" type="email" class="ui-input w-full" dir="ltr" />
                </label>
                <label class="w-24">
                  <span class="ui-label">{{ t('documents.signingOrder') }}</span>
                  <input v-model.number="r.signing_order" type="number" min="1" class="ui-input w-full" />
                </label>
                <button
                  type="button"
                  class="text-sm text-rose-600 hover:text-rose-800"
                  @click="removeRecipient(i)"
                >
                  {{ t('documents.remove') }}
                </button>
              </div>
            </div>
          </section>

          <section v-else class="ui-card ui-card-pad space-y-2">
            <h2 class="ui-card-title">{{ t('documents.recipientsSection') }}</h2>
            <ul class="divide-y divide-slate-100 text-sm">
              <li v-for="(r, ri) in recipients" :key="r.id || `r-${ri}-${r.email}`" class="flex flex-wrap justify-between gap-2 py-2">
                <span class="font-medium text-slate-900">{{ r.name }}</span>
                <span class="text-slate-600" dir="ltr">{{ r.email }}</span>
                <span class="text-xs text-slate-500">{{ t('documents.signingOrder') }}: {{ r.signing_order }}</span>
              </li>
            </ul>
          </section>

          <section v-if="canEdit && isDraft" class="ui-card ui-card-pad space-y-3">
            <div class="flex items-center justify-between gap-2">
              <h2 class="ui-card-title">{{ t('documents.placementsSection') }}</h2>
              <button type="button" class="text-sm font-medium text-brand-600 hover:text-brand-700" @click="addPlacement">
                + {{ t('documents.addPlacement') }}
              </button>
            </div>
            <p class="text-xs text-slate-500">{{ t('documents.placementsHint') }}</p>
            <div v-for="(p, i) in placements" :key="i" class="flex flex-wrap items-end gap-2 rounded-lg border border-slate-100 p-2">
              <label class="w-20">
                <span class="ui-label">{{ t('documents.placementPage') }}</span>
                <input v-model.number="p.page" type="number" min="1" class="ui-input w-full" dir="ltr" />
              </label>
              <label class="w-28">
                <span class="ui-label">{{ t('documents.placementAxisX') }}</span>
                <input v-model.number="p.x" type="number" step="0.01" class="ui-input w-full" dir="ltr" />
              </label>
              <label class="w-28">
                <span class="ui-label">{{ t('documents.placementAxisY') }}</span>
                <input v-model.number="p.y" type="number" step="0.01" class="ui-input w-full" dir="ltr" />
              </label>
              <button type="button" class="text-sm text-rose-600" @click="removePlacement(i)">{{ t('documents.remove') }}</button>
            </div>
          </section>

          <section v-else-if="placements.length" class="ui-card ui-card-pad">
            <h2 class="ui-card-title">{{ t('documents.placementsSection') }}</h2>
            <ul class="mt-2 font-mono text-xs text-slate-600">
              <li v-for="(p, i) in placements" :key="i">
                {{ t('documents.placementPage') }} {{ p.page }} — x={{ p.x }}, y={{ p.y }}
              </li>
            </ul>
          </section>

          <section v-if="doc.created_at" class="ui-card ui-card-pad text-sm text-slate-600">
            {{ t('documents.colCreated') }}:
            {{ df.format(new Date(doc.created_at)) }}
          </section>
        </div>
      </div>
    </template>

    <Teleport to="body">
      <div
        v-if="showLinksModal"
        class="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 p-4"
        role="dialog"
        aria-modal="true"
        @click.self="closeLinksModal"
      >
        <div
          class="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
          :dir="locale === 'ar' ? 'rtl' : 'ltr'"
        >
          <h3 class="text-lg font-bold text-slate-900">{{ t('documents.linksModalTitle') }}</h3>
          <p class="mt-1 text-sm text-slate-600">{{ t('documents.linksModalHint') }}</p>
          <p v-if="copyHint" class="mt-2 text-sm font-medium text-emerald-700">{{ copyHint }}</p>
          <ul class="mt-4 space-y-3">
            <li v-for="(row, i) in signingLinks" :key="i" class="rounded-lg border border-slate-200 p-3 text-sm">
              <p class="font-medium text-slate-900">{{ row.name }}</p>
              <p class="break-all text-xs text-slate-600" dir="ltr">{{ row.link }}</p>
              <button type="button" class="mt-2 text-xs font-medium text-brand-600" @click="copyLink(row.link)">
                {{ t('documents.copyLink') }}
              </button>
            </li>
          </ul>
          <button type="button" class="ui-btn-primary mt-6 w-full" @click="closeLinksModal">
            {{ t('documents.close') }}
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>
