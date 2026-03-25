<script setup>
import { onMounted, computed, ref } from 'vue';
import { useRouter, useRoute, RouterLink, RouterView } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useCompanyStore } from '@/stores/company';
import NavIcon from '@/components/NavIcon.vue';

const { t, locale } = useI18n();
const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const company = useCompanyStore();

const mobileNavOpen = ref(false);
const isOwnerAnywhere = computed(() => company.companies.some((c) => c.is_owner));

const navGroups = computed(() => [
  {
    title: null,
    items: [
      { to: '/', label: t('nav.dashboard'), exact: true, icon: 'home', needsCompany: false, ownerOnly: true },
      { to: '/companies', label: t('nav.companies'), icon: 'building', needsCompany: false, ownerOnly: true },
    ],
  },
  {
    title: t('nav.sectionAccounting'),
    module: 'accounting',
    items: [
      { to: '/accounts', label: t('nav.accounts'), icon: 'layers', needsCompany: true },
      { to: '/transactions', label: t('nav.transactions'), icon: 'swap', needsCompany: true },
      { to: '/invoices', label: t('nav.invoices'), icon: 'doc', needsCompany: true },
      { to: '/payments', label: t('nav.payments'), icon: 'wallet', needsCompany: true },
      { to: '/expenses', label: t('nav.expenses'), icon: 'cash', needsCompany: true },
      { to: '/reports', label: t('nav.reports'), icon: 'chart', needsCompany: true },
    ],
  },
  {
    title: t('nav.sectionStaff'),
    module: 'staff',
    items: [
      { to: '/staff/users', label: t('nav.staffUsers'), icon: 'users', needsCompany: true },
      { to: '/staff/roles', label: t('nav.staffRoles'), icon: 'key', needsCompany: true },
    ],
  },
  {
    title: t('nav.sectionClinical'),
    module: 'clinical',
    items: [
      { to: '/clinical/patients', label: t('clinical.navPatients'), icon: 'users', needsCompany: true },
      { to: '/clinical/appointments', label: t('clinical.navAppointments'), icon: 'calendar', needsCompany: true },
      { to: '/clinical/calendar', label: t('clinical.navCalendar'), icon: 'calendar', needsCompany: true },
      { to: '/clinical/prescriptions', label: t('clinical.navPrescriptions'), icon: 'pill', needsCompany: true },
      { to: '/clinical/lab-orders', label: t('clinical.navLabOrders'), icon: 'flask', needsCompany: true },
      { to: '/clinical/records', label: t('clinical.navRecords'), icon: 'clipboard', needsCompany: true },
      { to: '/clinical/insurance', label: t('clinical.navInsurance'), icon: 'shield', needsCompany: true },
    ],
  },
]);

const visibleNavGroups = computed(() =>
  navGroups.value
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.ownerOnly || isOwnerAnywhere.value),
    }))
    .filter(
      (group) =>
        group.items.length > 0 &&
        (!group.module || !company.currentCompanyId || company.canAccessModule(group.module))
    )
);

function isActive(item) {
  if (item.exact) return route.path === '/' || route.path === '';
  return route.path === item.to || route.path.startsWith(`${item.to}/`);
}

function resolveTo(item) {
  if (item.needsCompany && !company.currentCompanyId) return '/companies';
  return item.to;
}

function toggleLocale() {
  locale.value = locale.value === 'ar' ? 'en' : 'ar';
}

onMounted(async () => {
  await company.loadCompanies();
  if (auth.token && !auth.user) await auth.fetchMe();
});

async function logout() {
  auth.clear();
  company.setCurrentCompany(null);
  mobileNavOpen.value = false;
  await router.push({ name: 'login' });
}
</script>

<template>
  <div class="min-h-screen bg-slate-100 md:flex">
    <!-- Mobile overlay -->
    <button
      v-if="mobileNavOpen"
      type="button"
      class="fixed inset-0 z-40 bg-slate-900/60 backdrop-blur-sm md:hidden"
      aria-label="Close menu"
      @click="mobileNavOpen = false"
    />

    <!-- Off-canvas transforms MUST be max-md only: [dir=rtl] .rtl:translate-x-full beats .md:translate-x-0, hiding the sidebar on desktop in Arabic. -->
    <aside
      class="fixed inset-y-0 start-0 z-50 flex w-[min(18rem,88vw)] flex-col border-white/10 bg-sidebar-shine shadow-2xl shadow-black/40 transition-transform duration-300 md:static md:w-64 md:transform-none md:border-e md:shadow-none"
      :class="
        mobileNavOpen
          ? 'max-md:translate-x-0'
          : 'max-md:ltr:-translate-x-full max-md:rtl:translate-x-full'
      "
    >
      <div
        class="relative overflow-hidden border-b border-white/10 px-5 py-6"
      >
        <div class="pointer-events-none absolute -end-10 -top-10 h-32 w-32 rounded-full bg-brand-500/25 blur-2xl" />
        <div class="relative flex items-center gap-3">
          <div
            class="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 text-lg font-extrabold text-white shadow-lg shadow-brand-900/40"
          >
            م
          </div>
          <div class="min-w-0">
            <p class="truncate text-lg font-bold text-white">{{ t('app.title') }}</p>
            <p class="truncate text-xs text-slate-400">{{ t('app.tagline') }}</p>
          </div>
        </div>
      </div>

      <nav class="scrollbar-thin flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
        <template v-for="(group, gi) in visibleNavGroups" :key="gi">
          <p
            v-if="group.title"
            class="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-slate-500"
          >
            {{ group.title }}
          </p>
          <RouterLink
            v-for="item in group.items"
            :key="item.to"
            :to="resolveTo(item)"
            class="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200"
            :class="
              isActive(item)
                ? 'bg-white/10 text-white shadow-inner-light ring-1 ring-white/10'
                : 'text-slate-400 hover:bg-white/5 hover:text-white'
            "
            @click="mobileNavOpen = false"
          >
            <span
              class="flex h-9 w-9 items-center justify-center rounded-lg transition-colors"
              :class="isActive(item) ? 'bg-brand-500/20 text-brand-200' : 'bg-white/5 text-slate-400 group-hover:text-white'"
            >
              <NavIcon :name="item.icon" />
            </span>
            <span class="truncate">{{ item.label }}</span>
          </RouterLink>
        </template>
      </nav>

      <div class="border-t border-white/10 p-4">
        <div
          v-if="auth.user"
          class="mb-3 flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2.5 ring-1 ring-white/10"
        >
          <div
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-600 to-slate-800 text-xs font-bold text-white"
          >
            {{ (auth.user.full_name || auth.user.email || '?').slice(0, 1).toUpperCase() }}
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold text-white">
              {{ auth.user.full_name || auth.user.email }}
            </p>
            <p class="truncate text-xs text-slate-500">{{ auth.user.email }}</p>
          </div>
        </div>
        <button
          type="button"
          class="ui-btn-secondary w-full border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 hover:text-white"
          @click="logout"
        >
          {{ t('nav.logout') }}
        </button>
      </div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col md:min-h-screen">
      <header
        class="sticky top-0 z-30 border-b border-slate-200/80 bg-white/80 px-4 py-3 shadow-sm backdrop-blur-xl md:px-6"
      >
        <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
          <button
            type="button"
            class="ui-btn-secondary -ms-1 border-slate-200 px-2.5 py-2 md:hidden"
            aria-label="Menu"
            @click="mobileNavOpen = true"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>

          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-3">
            <label class="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-xs">
              <span class="ui-label !mb-0 !normal-case !tracking-normal text-slate-500">{{ t('company.switcher') }}</span>
              <select
                :value="company.currentCompanyId || ''"
                class="ui-select max-w-full font-medium text-slate-800"
                @change="company.setCurrentCompany($event.target.value || null)"
              >
                <option value="">{{ t('company.none') }}</option>
                <option v-for="c in company.companies" :key="c.id" :value="c.id">
                  {{ c.name }}
                </option>
              </select>
            </label>
            <p
              v-if="!company.currentCompanyId"
              class="ui-badge-amber max-w-full text-[11px] leading-snug sm:max-w-md"
            >
              {{ t('company.selectHint') }}
            </p>
          </div>

          <div class="flex items-center gap-2">
            <button
              type="button"
              class="ui-btn-secondary border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600"
              @click="toggleLocale"
            >
              {{ locale === 'ar' ? 'العربية' : 'English' }}
            </button>
          </div>
        </div>
      </header>

      <main class="flex-1 px-4 py-6 md:px-8 md:py-8">
        <div class="mx-auto max-w-6xl">
          <RouterView />
        </div>
      </main>
    </div>
  </div>
</template>
