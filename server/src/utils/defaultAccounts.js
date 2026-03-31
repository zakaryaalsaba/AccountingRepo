/**
 * Minimal default chart of accounts for a new company (Arabic-friendly names).
 * Codes are stable for reporting and demos.
 */
export const DEFAULT_ACCOUNTS = [
  { code: '1000', name: 'النقدية والبنوك', type: 'ASSET' },
  { code: '1100', name: 'المستحقات من العملاء', type: 'ASSET' },
  { code: '1200', name: 'ضريبة مدخلات مستردة', type: 'ASSET' },
  { code: '1300', name: 'المخزون', type: 'ASSET' },
  { code: '2000', name: 'الموردون والالتزامات', type: 'LIABILITY' },
  { code: '2100', name: 'ضريبة مخرجات مستحقة', type: 'LIABILITY' },
  { code: '3000', name: 'رأس المال', type: 'EQUITY' },
  { code: '4000', name: 'إيرادات المبيعات', type: 'REVENUE' },
  { code: '4100', name: 'أرباح فروق العملة', type: 'REVENUE' },
  { code: '5000', name: 'المصروفات العمومية', type: 'EXPENSE' },
  { code: '5100', name: 'تكلفة البضاعة المباعة', type: 'EXPENSE' },
  { code: '5101', name: 'خسائر فروق العملة', type: 'EXPENSE' },
];
