import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { guest: true },
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('@/views/RegisterView.vue'),
      meta: { guest: true },
    },
    {
      path: '/',
      component: () => import('@/layouts/DashboardLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          name: 'dashboard',
          component: () => import('@/views/DashboardView.vue'),
          meta: { ownerOnly: true },
        },
        {
          path: 'companies',
          name: 'companies',
          component: () => import('@/views/CompaniesView.vue'),
          meta: { ownerOnly: true },
        },
        {
          path: 'accounts',
          name: 'accounts',
          component: () => import('@/views/ChartOfAccountsView.vue'),
          meta: { requiresCompany: true, module: 'accounting' },
        },
        {
          path: 'transactions',
          name: 'transactions',
          component: () => import('@/views/TransactionsView.vue'),
          meta: { requiresCompany: true, module: 'accounting' },
        },
        {
          path: 'invoices',
          name: 'invoices',
          component: () => import('@/views/InvoicesView.vue'),
          meta: { requiresCompany: true, module: 'accounting' },
        },
        {
          path: 'payments',
          name: 'payments',
          component: () => import('@/views/PaymentsView.vue'),
          meta: { requiresCompany: true, module: 'accounting' },
        },
        {
          path: 'expenses',
          name: 'expenses',
          component: () => import('@/views/ExpensesView.vue'),
          meta: { requiresCompany: true, module: 'accounting' },
        },
        {
          path: 'reports',
          name: 'reports',
          component: () => import('@/views/ReportsView.vue'),
          meta: { requiresCompany: true, module: 'accounting' },
        },
        {
          path: 'staff/users',
          name: 'staff-users',
          component: () => import('@/views/staff/StaffUsersView.vue'),
          meta: { requiresCompany: true, module: 'staff' },
        },
        {
          path: 'staff/roles',
          name: 'staff-roles',
          component: () => import('@/views/staff/StaffRolesView.vue'),
          meta: { requiresCompany: true, module: 'staff' },
        },
        {
          path: 'clinical/patients',
          name: 'clinical-patients',
          component: () => import('@/views/clinical/ClinicalPatientsView.vue'),
          meta: { requiresCompany: true, module: 'clinical' },
        },
        {
          path: 'clinical/appointments/:id',
          name: 'clinical-appointment-detail',
          component: () => import('@/views/clinical/ClinicalAppointmentDetailView.vue'),
          meta: { requiresCompany: true, module: 'clinical' },
        },
        {
          path: 'clinical/appointments',
          name: 'clinical-appointments',
          component: () => import('@/views/clinical/ClinicalAppointmentsView.vue'),
          meta: { requiresCompany: true, module: 'clinical' },
        },
        {
          path: 'clinical/calendar',
          name: 'clinical-calendar',
          component: () => import('@/views/clinical/ClinicalAppointmentsTimeGridView.vue'),
          meta: { requiresCompany: true, module: 'clinical' },
        },
        {
          path: 'clinical/prescriptions',
          name: 'clinical-prescriptions',
          component: () => import('@/views/clinical/ClinicalPrescriptionsView.vue'),
          meta: { requiresCompany: true, module: 'clinical' },
        },
        {
          path: 'clinical/lab-orders',
          name: 'clinical-lab-orders',
          component: () => import('@/views/clinical/ClinicalLabOrdersView.vue'),
          meta: { requiresCompany: true, module: 'clinical' },
        },
        {
          path: 'clinical/records',
          name: 'clinical-records',
          component: () => import('@/views/clinical/ClinicalMedicalRecordsView.vue'),
          meta: { requiresCompany: true, module: 'clinical' },
        },
        {
          path: 'clinical/insurance',
          name: 'clinical-insurance',
          component: () => import('@/views/clinical/ClinicalInsuranceView.vue'),
          meta: { requiresCompany: true, module: 'clinical' },
        },
      ],
    },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (to.meta.requiresAuth && !auth.token) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.meta.requiresAuth && auth.token && !auth.user) {
    await auth.fetchMe();
  }
  const { useCompanyStore } = await import('@/stores/company');
  const company = useCompanyStore();

  const redirectFirstAllowedModule = () => {
    // New account: no org yet — must create a company first (avoid login ↔ dashboard loop).
    if (!company.companies.length) return { name: 'companies' };
    if (company.canAccessModule('accounting')) return { name: 'accounts' };
    if (company.canAccessModule('clinical')) return { name: 'clinical-patients' };
    if (company.canAccessModule('staff')) return { name: 'staff-users' };
    return { name: 'login' };
  };

  if (to.meta.guest && auth.token) {
    if (!company.companies.length) await company.loadCompanies();
    if (!company.companies.length) return { name: 'companies' };
    return { name: 'dashboard' };
  }

  // Companies: allow first-time setup (zero companies). Otherwise same as owner-only.
  if (to.name === 'companies') {
    if (!company.companies.length) await company.loadCompanies();
    if (company.companies.length === 0) return true;
    const isOwnerAnywhere = company.companies.some((c) => c.is_owner);
    if (!isOwnerAnywhere) {
      if (!company.currentCompanyId && company.companies.length > 0) {
        company.setCurrentCompany(company.companies[0].id);
      }
      return redirectFirstAllowedModule();
    }
    return true;
  }

  if (to.meta.ownerOnly) {
    if (!company.companies.length) await company.loadCompanies();
    const isOwnerAnywhere = company.companies.some((c) => c.is_owner);
    if (!isOwnerAnywhere) {
      if (!company.currentCompanyId && company.companies.length > 0) {
        company.setCurrentCompany(company.companies[0].id);
      }
      return redirectFirstAllowedModule();
    }
  }
  if (to.meta.requiresCompany) {
    if (!company.companies.length) await company.loadCompanies();
    if (!company.currentCompanyId) {
      if (company.companies.length > 0) {
        company.setCurrentCompany(company.companies[0].id);
      } else {
        return { name: 'login' };
      }
    }
    if (company.currentCompany?.id !== company.currentCompanyId) {
      await company.loadCompanies();
    }
    if (to.meta.module && !company.canAccessModule(String(to.meta.module))) {
      return redirectFirstAllowedModule();
    }
  }
  return true;
});

export default router;
