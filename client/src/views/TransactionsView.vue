<script setup>
import { ref, onMounted, watch, computed, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { useFiscalStore } from '@/stores/fiscal';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();
const fiscal = useFiscalStore();

const transactions = ref([]);
const accounts = ref([]);
const dimensions = ref([]);
const templates = ref([]);
const loading = ref(false);
const error = ref('');
const templateName = ref('');
const templateDescription = ref('');
const selectedTemplateId = ref('');
const editingTransactionId = ref('');
const csvText = ref('account_code,debit,credit,note');
const csvDryRun = ref(null);
const accountQuery = ref('');
const autosaveState = ref('idle');
const DRAFT_STORAGE_KEY = 'tx-workbench-draft-v1';

const entry = ref({
  doc_type: 'journal_voucher',
  status: 'posted',
  dimension_policy: { mode: 'optional', required_types: [] },
  entry_date: new Date().toISOString().slice(0, 10),
  description: '',
  reference: '',
  notes: '',
  attachments: [],
  lines: [
    { account_id: '', debit: '', credit: '', note: '', dimension_ids: [] },
    { account_id: '', debit: '', credit: '', note: '', dimension_ids: [] },
  ],
});

const totalDebit = computed(() =>
  entry.value.lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0)
);
const totalCredit = computed(() =>
  entry.value.lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0)
);
const balanced = computed(() => Math.abs(totalDebit.value - totalCredit.value) < 0.005);
const balanceDiff = computed(() => Number((totalDebit.value - totalCredit.value).toFixed(2)));
const postingAccounts = computed(() => {
  const q = String(accountQuery.value || '').trim().toLowerCase();
  const base = accounts.value.filter((a) => Number(a.level) === 5 && a.is_active !== false);
  if (!q) return base;
  return base.filter((a) =>
    `${a.account_code || a.code || ''} ${a.name || ''}`.toLowerCase().includes(q)
  );
});

function focusNextEntryCell(currentEl) {
  const cells = Array.from(document.querySelectorAll('[data-entry-cell="1"]'));
  const idx = cells.findIndex((x) => x === currentEl);
  if (idx >= 0 && idx + 1 < cells.length) {
    cells[idx + 1].focus();
  }
}

function onEntryCellEnter(event) {
  focusNextEntryCell(event.target);
}

async function load() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const [tx, acc] = await Promise.all([
      api.get('/api/transactions'),
      api.get('/api/accounts'),
    ]);
    transactions.value = tx.data.transactions || [];
    accounts.value = acc.data.accounts || [];
    try {
      const dim = await api.get('/api/dimensions');
      dimensions.value = dim.data.dimensions || [];
    } catch {
      dimensions.value = [];
    }
    try {
      const tpl = await api.get('/api/journal-templates');
      templates.value = tpl.data.templates || [];
    } catch {
      templates.value = [];
    }
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  } finally {
    loading.value = false;
  }
}

function addLine() {
  entry.value.lines.push({ account_id: '', debit: '', credit: '', note: '', dimension_ids: [] });
}

function insertLineAt(idx) {
  const pos = Math.max(0, Math.min(entry.value.lines.length, Number(idx)));
  entry.value.lines.splice(pos, 0, { account_id: '', debit: '', credit: '', note: '', dimension_ids: [] });
}

function duplicateLine(idx) {
  const src = entry.value.lines[idx];
  if (!src) return;
  entry.value.lines.splice(idx + 1, 0, { ...src });
}

function removeLine(idx) {
  if (entry.value.lines.length <= 2) return;
  entry.value.lines.splice(idx, 1);
}

function suggestCounterpartLine() {
  const diff = balanceDiff.value;
  if (Math.abs(diff) < 0.005) return;

  const target = entry.value.lines.find(
    (l) => !l.account_id && !(parseFloat(l.debit) || 0) && !(parseFloat(l.credit) || 0)
  );
  const line = target || { account_id: '', debit: '', credit: '', note: '', dimension_ids: [] };

  if (diff > 0) {
    // Debits exceed credits, so suggest a credit counterpart.
    line.credit = Math.abs(diff).toFixed(2);
    line.debit = '';
  } else {
    // Credits exceed debits, so suggest a debit counterpart.
    line.debit = Math.abs(diff).toFixed(2);
    line.credit = '';
  }
  if (!line.note) line.note = 'Auto balance suggestion';

  if (!target) entry.value.lines.push(line);
}

function addAttachment() {
  entry.value.attachments.push({
    file_name: '',
    file_url: '',
    mime_type: '',
    file_size_bytes: '',
  });
}

function removeAttachment(idx) {
  entry.value.attachments.splice(idx, 1);
}

async function saveAsTemplate() {
  const name = String(templateName.value || '').trim();
  if (!name) {
    error.value = 'Template name is required';
    return;
  }
  const lines = entry.value.lines
    .map((l) => ({
      account_id: l.account_id || null,
      debit: parseFloat(l.debit) || 0,
      credit: parseFloat(l.credit) || 0,
      note: l.note ? String(l.note) : null,
      dimension_ids: Array.isArray(l.dimension_ids) ? l.dimension_ids : [],
    }))
    .filter((l) => l.account_id || l.debit > 0 || l.credit > 0 || l.note);
  if (!lines.length) {
    error.value = 'Add at least one line before saving template';
    return;
  }
  try {
    await api.post('/api/journal-templates', {
      name,
      description: templateDescription.value || null,
      lines,
    });
    templateName.value = '';
    templateDescription.value = '';
    const tpl = await api.get('/api/journal-templates');
    templates.value = tpl.data.templates || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

function applyTemplate() {
  const tpl = templates.value.find((x) => x.id === selectedTemplateId.value);
  if (!tpl) return;
  const lines = Array.isArray(tpl.lines_json) ? tpl.lines_json : [];
  if (!lines.length) return;
  entry.value.description = tpl.description || entry.value.description;
  entry.value.lines = lines.map((l) => ({
    account_id: l.account_id || '',
    debit: l.debit || '',
    credit: l.credit || '',
    note: l.note || '',
    dimension_ids: Array.isArray(l.dimension_ids) ? l.dimension_ids : [],
  }));
}

async function deleteTemplate(id) {
  try {
    await api.delete(`/api/journal-templates/${id}`);
    templates.value = templates.value.filter((t) => t.id !== id);
    if (selectedTemplateId.value === id) selectedTemplateId.value = '';
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

function editDraft(tx) {
  if (!tx || tx.status !== 'draft') return;
  editingTransactionId.value = tx.id;
  entry.value.entry_date = tx.entry_date;
  entry.value.description = tx.description || '';
  entry.value.reference = tx.reference || '';
  entry.value.status = 'draft';
  entry.value.lines = (tx.lines || []).map((ln) => ({
    account_id: ln.account_id,
    debit: ln.debit || '',
    credit: ln.credit || '',
    note: ln.note || '',
    dimension_ids: Array.isArray(ln.dimensions) ? ln.dimensions.map((d) => d.id) : [],
  }));
}

async function runCsvDryRun() {
  try {
    const { data } = await api.post('/api/transactions/import-csv-dry-run', {
      csv_text: csvText.value,
    });
    csvDryRun.value = data;
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    csvDryRun.value = null;
  }
}

async function submit() {
  if (!balanced.value) {
    error.value = t('transactions.balanced');
    return;
  }
  error.value = '';
  const lines = entry.value.lines
    .map((l) => ({
      account_id: l.account_id,
      debit: parseFloat(l.debit) || 0,
      credit: parseFloat(l.credit) || 0,
      note: l.note ? String(l.note) : null,
      dimension_ids: Array.isArray(l.dimension_ids) ? l.dimension_ids : [],
    }))
    .filter((l) => l.account_id && (l.debit > 0 || l.credit > 0));
  try {
    const payload = {
      status: entry.value.status,
      entry_date: entry.value.entry_date,
      description: entry.value.description,
      reference: entry.value.reference,
      notes: entry.value.notes,
      doc_type: 'journal_voucher',
      fiscal_year_id: fiscal.currentFiscalYearId || null,
      dimension_policy: entry.value.dimension_policy,
      lines,
    };
    const { data } = editingTransactionId.value
      ? await api.patch(`/api/transactions/${editingTransactionId.value}`, payload)
      : await api.post('/api/transactions', payload);
    const txId = data?.transaction?.id;
    const attachments = (entry.value.attachments || []).filter(
      (a) => a.file_name && a.file_url
    );
    if (txId && attachments.length) {
      await Promise.all(
        attachments.map((a) =>
          api.post('/api/audit/attachments', {
            entity_type: 'transaction',
            entity_id: txId,
            file_name: a.file_name,
            file_url: a.file_url,
            mime_type: a.mime_type || null,
            file_size_bytes: a.file_size_bytes ? Number(a.file_size_bytes) : null,
          })
        )
      );
    }
    entry.value = {
      doc_type: 'journal_voucher',
      status: 'posted',
      dimension_policy: { mode: 'optional', required_types: [] },
      entry_date: new Date().toISOString().slice(0, 10),
      description: '',
      reference: '',
      notes: '',
      attachments: [],
      lines: [
        { account_id: '', debit: '', credit: '', note: '', dimension_ids: [] },
        { account_id: '', debit: '', credit: '', note: '', dimension_ids: [] },
      ],
    };
    localStorage.removeItem(DRAFT_STORAGE_KEY);
    autosaveState.value = 'idle';
    editingTransactionId.value = '';
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function remove(id) {
  if (!confirm('OK?')) return;
  try {
    await api.delete(`/api/transactions/${id}`);
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

function saveWorkbenchDraft() {
  try {
    const payload = {
      editingTransactionId: editingTransactionId.value || null,
      entry: entry.value,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
    autosaveState.value = 'saved';
  } catch {
    autosaveState.value = 'error';
  }
}

function restoreWorkbenchDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed?.entry?.lines?.length) return;
    editingTransactionId.value = parsed.editingTransactionId || '';
    entry.value = parsed.entry;
    autosaveState.value = 'restored';
  } catch {
    autosaveState.value = 'error';
  }
}

onMounted(load);
onMounted(() => {
  restoreWorkbenchDraft();
  nextTick(() => {
    const first = document.querySelector('[data-entry-cell="1"]');
    if (first) first.focus();
  });
});
watch(() => company.currentCompanyId, load);
watch(
  () => entry.value,
  () => {
    saveWorkbenchDraft();
  },
  { deep: true }
);
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('transactions.title') }}</h1>
      <p class="ui-page-desc">{{ t('transactions.new') }}</p>
    </div>

    <div class="ui-card ui-card-pad">
      <h2 class="ui-card-title mb-5">{{ t('transactions.new') }}</h2>
      <div class="mb-6 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
        <p class="mb-2 text-sm font-semibold text-slate-700">Frequent templates</p>
        <div class="grid gap-2 sm:grid-cols-4">
          <input v-model="accountQuery" type="text" class="ui-input" placeholder="Search account code/name" />
          <select v-model="selectedTemplateId" class="ui-select">
            <option value="">Select template</option>
            <option v-for="tpl in templates" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
          </select>
          <button type="button" class="ui-btn-secondary" :disabled="!selectedTemplateId" @click="applyTemplate">
            Apply
          </button>
          <input v-model="templateName" type="text" class="ui-input" placeholder="Template name" />
          <button type="button" class="ui-btn-secondary" :disabled="!templateName" @click="saveAsTemplate">
            Save current as template
          </button>
        </div>
        <div class="mt-2">
          <input v-model="templateDescription" type="text" class="ui-input" placeholder="Template description" />
        </div>
        <ul v-if="templates.length" class="mt-3 space-y-1 text-xs text-slate-600">
          <li v-for="tpl in templates" :key="tpl.id" class="flex items-center justify-between rounded-md bg-white px-2 py-1 ring-1 ring-slate-100">
            <span>{{ tpl.name }}</span>
            <button type="button" class="ui-btn-danger !px-2 !py-1 text-xs" @click="deleteTemplate(tpl.id)">Delete</button>
          </li>
        </ul>
      </div>
      <div class="mb-6 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
        <p class="mb-2 text-sm font-semibold text-slate-700">Dimension policy</p>
        <div class="grid gap-2 sm:grid-cols-2">
          <select v-model="entry.dimension_policy.mode" class="ui-select">
            <option value="optional">Optional</option>
            <option value="required_any">Require any dimension</option>
            <option value="required_types">Require specific types</option>
          </select>
          <select
            v-model="entry.dimension_policy.required_types"
            class="ui-select"
            multiple
            :disabled="entry.dimension_policy.mode !== 'required_types'"
          >
            <option value="cost_center">cost_center</option>
            <option value="project">project</option>
            <option value="department">department</option>
            <option value="custom">custom</option>
          </select>
        </div>
      </div>
      <div class="mb-6 grid gap-4 sm:grid-cols-3">
        <div>
          <label class="ui-label">Document type</label>
          <select v-model="entry.doc_type" class="ui-select">
            <option value="journal_voucher">Journal voucher</option>
          </select>
        </div>
        <div>
          <label class="ui-label">Status</label>
          <select v-model="entry.status" class="ui-select">
            <option value="posted">Posted</option>
            <option value="draft">Draft</option>
          </select>
        </div>
        <div>
          <label class="ui-label">{{ t('transactions.date') }}</label>
          <input v-model="entry.entry_date" type="date" class="ui-input" />
        </div>
        <div>
          <label class="ui-label">{{ t('transactions.description') }}</label>
          <input v-model="entry.description" type="text" class="ui-input" />
        </div>
        <div>
          <label class="ui-label">{{ t('transactions.reference') }}</label>
          <input v-model="entry.reference" type="text" class="ui-input" />
        </div>
        <div class="sm:col-span-3">
          <label class="ui-label">Notes</label>
          <textarea v-model="entry.notes" rows="2" class="ui-input"></textarea>
        </div>
      </div>

      <div class="overflow-x-auto rounded-xl border border-slate-100 bg-slate-50/50 p-2">
        <table class="w-full min-w-[640px] text-sm">
          <thead>
            <tr class="text-xs font-bold uppercase tracking-wide text-slate-500">
              <th class="px-2 py-2 text-start">{{ t('transactions.account') }}</th>
              <th class="px-2 py-2 text-start">{{ t('transactions.debit') }}</th>
              <th class="px-2 py-2 text-start">{{ t('transactions.credit') }}</th>
              <th class="px-2 py-2 text-start">Note</th>
              <th class="px-2 py-2 text-start">Dimensions</th>
              <th class="px-2 py-2 text-start">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(line, idx) in entry.lines" :key="idx">
              <td class="px-2 py-1.5">
                <select
                  v-model="line.account_id"
                  class="ui-select !bg-white"
                  data-entry-cell="1"
                  @keydown.enter.prevent="onEntryCellEnter"
                >
                  <option value="">{{ t('company.none') }}</option>
                  <option v-for="a in postingAccounts" :key="a.id" :value="a.id">{{ a.account_code || a.code }} — {{ a.name }}</option>
                </select>
              </td>
              <td class="px-2 py-1.5">
                <input
                  v-model="line.debit"
                  type="number"
                  step="0.01"
                  min="0"
                  class="ui-input !bg-white"
                  data-entry-cell="1"
                  @keydown.enter.prevent="onEntryCellEnter"
                />
              </td>
              <td class="px-2 py-1.5">
                <input
                  v-model="line.credit"
                  type="number"
                  step="0.01"
                  min="0"
                  class="ui-input !bg-white"
                  data-entry-cell="1"
                  @keydown.enter.prevent="onEntryCellEnter"
                />
              </td>
              <td class="px-2 py-1.5">
                <input
                  v-model="line.note"
                  type="text"
                  class="ui-input !bg-white"
                  placeholder="Note"
                  data-entry-cell="1"
                  @keydown.enter.prevent="onEntryCellEnter"
                />
              </td>
              <td class="px-2 py-1.5">
                <select v-model="line.dimension_ids" class="ui-select !bg-white" multiple>
                  <option v-for="d in dimensions" :key="d.id" :value="d.id">{{ d.type }} · {{ d.code || d.name }}</option>
                </select>
              </td>
              <td class="px-2 py-1.5 whitespace-nowrap">
                <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="insertLineAt(idx)">+Before</button>
                <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs ms-1" @click="insertLineAt(idx + 1)">+After</button>
                <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs ms-1" @click="duplicateLine(idx)">Copy</button>
                <button
                  type="button"
                  class="ui-btn-danger !px-2 !py-1 text-xs ms-1"
                  :disabled="entry.lines.length <= 2"
                  @click="removeLine(idx)"
                >
                  Remove
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mt-5 rounded-xl border border-slate-100 bg-slate-50/50 p-3">
        <div class="mb-2 flex items-center justify-between">
          <p class="text-sm font-semibold text-slate-700">Attachments</p>
          <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="addAttachment">+ Add</button>
        </div>
        <div v-if="!entry.attachments.length" class="text-xs text-slate-500">No attachments</div>
        <div v-for="(a, i) in entry.attachments" :key="i" class="mb-2 grid gap-2 sm:grid-cols-4">
          <input v-model="a.file_name" type="text" class="ui-input" placeholder="File name" />
          <input v-model="a.file_url" type="url" class="ui-input" placeholder="https://..." />
          <input v-model="a.mime_type" type="text" class="ui-input" placeholder="mime/type" />
          <div class="flex gap-2">
            <input v-model="a.file_size_bytes" type="number" min="0" class="ui-input" placeholder="bytes" />
            <button type="button" class="ui-btn-danger !px-2 !py-1 text-xs" @click="removeAttachment(i)">X</button>
          </div>
        </div>
      </div>
      <div class="ui-sticky-entry-footer mt-4 flex flex-wrap items-center gap-3">
        <button type="button" class="ui-btn-secondary text-sm" @click="addLine">+ {{ t('transactions.addLine') }}</button>
        <button
          type="button"
          class="ui-btn-secondary text-sm"
          :disabled="Math.abs(balanceDiff) < 0.005"
          @click="suggestCounterpartLine"
        >
          Auto-balance
        </button>
        <span class="text-sm font-medium tabular-nums text-slate-600">
          {{ t('transactions.debit') }}: {{ totalDebit.toFixed(2) }} · {{ t('transactions.credit') }}:
          {{ totalCredit.toFixed(2) }}
        </span>
        <span v-if="balanced && totalDebit > 0" class="ui-badge-emerald text-[11px]">✓</span>
        <span v-if="!balanced" class="ui-badge-amber max-w-full text-[11px] leading-snug">{{ t('transactions.balanced') }}</span>
        <span class="ui-badge-slate text-[11px]">
          Autosave:
          {{
            autosaveState === 'saved'
              ? 'saved'
              : autosaveState === 'restored'
                ? 'restored'
                : autosaveState === 'error'
                  ? 'error'
                  : 'idle'
          }}
        </span>
      </div>
      <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
        {{ error }}
      </p>
      <button type="button" class="ui-btn-primary mt-5" :disabled="!balanced" @click="submit">
        {{ editingTransactionId ? 'Update draft' : t('transactions.submit') }}
      </button>
      <div class="mt-6 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
        <p class="mb-2 text-sm font-semibold text-slate-700">CSV import (dry run)</p>
        <textarea v-model="csvText" rows="4" class="ui-input font-mono text-xs"></textarea>
        <button type="button" class="ui-btn-secondary mt-2" @click="runCsvDryRun">Run dry run</button>
        <div v-if="csvDryRun" class="mt-2 text-xs text-slate-600">
          <p>Balanced: {{ csvDryRun.totals?.balanced ? 'Yes' : 'No' }}</p>
          <p>Rows parsed: {{ csvDryRun.parsed_lines?.length || 0 }}</p>
          <p>Errors: {{ csvDryRun.errors?.length || 0 }}</p>
        </div>
      </div>
    </div>

    <div class="ui-table-wrap">
      <table class="ui-table">
        <thead>
          <tr>
            <th>{{ t('transactions.date') }}</th>
            <th>{{ t('transactions.description') }}</th>
            <th>{{ t('transactions.lines') }}</th>
            <th>Status</th>
            <th>{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="tx in transactions" :key="tx.id" class="align-top">
            <td class="whitespace-nowrap font-medium text-slate-900">{{ tx.entry_date }}</td>
            <td class="text-slate-600">{{ tx.description || '—' }}</td>
            <td>
              <ul class="space-y-1.5">
                <li v-for="ln in tx.lines" :key="ln.id" class="text-xs text-slate-600">
                  <span class="font-mono font-semibold text-brand-800">{{ ln.account_code }}</span>
                  <span class="ms-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">
                    {{ ln.debit > 0 ? `D ${ln.debit}` : `C ${ln.credit}` }}
                  </span>
                </li>
              </ul>
            </td>
            <td>
              <span
                class="ui-badge"
                :class="tx.status === 'draft' ? 'ui-badge-amber' : tx.status === 'reversed' ? 'ui-badge-slate' : 'ui-badge-emerald'"
              >
                {{ tx.status || 'posted' }}
              </span>
            </td>
            <td>
              <button type="button" class="ui-btn-danger !px-2 !py-1.5 text-sm" @click="remove(tx.id)">
                {{ t('accounts.delete') }}
              </button>
              <button
                v-if="tx.status === 'draft'"
                type="button"
                class="ui-btn-secondary !px-2 !py-1.5 text-sm ms-1"
                @click="editDraft(tx)"
              >
                Edit draft
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
