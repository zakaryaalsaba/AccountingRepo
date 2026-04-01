import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { getEsignStorageConfig } from './modules/documents/storage/index.js';
import documentsModule from './modules/documents/index.js';
import publicSignRoutes from './modules/documents/routes/publicSign.js';

import authRoutes from './routes/auth.js';
import companiesRoutes from './routes/companies.js';
import accountsRoutes from './routes/accounts.js';
import transactionsRoutes from './routes/transactions.js';
import invoicesRoutes from './routes/invoices.js';
import paymentsRoutes from './routes/payments.js';
import expensesRoutes from './routes/expenses.js';
import reportsRoutes from './routes/reports.js';
import periodsRoutes from './routes/periods.js';
import bankAccountsRoutes from './routes/bankAccounts.js';
import treasurySafesRoutes from './routes/treasurySafes.js';
import customersRoutes from './routes/customers.js';
import invoiceTemplatesRoutes from './routes/invoiceTemplates.js';
import vendorsRoutes from './routes/vendors.js';
import billsRoutes from './routes/bills.js';
import fixedAssetsRoutes from './routes/fixedAssets.js';
import inventoryRoutes from './routes/inventory.js';
import taxesRoutes from './routes/taxes.js';
import currenciesRoutes from './routes/currencies.js';
import budgetsRoutes from './routes/budgets.js';
import dimensionsRoutes from './routes/dimensions.js';
import recurringRoutes from './routes/recurring.js';
import journalTemplatesRoutes from './routes/journalTemplates.js';
import vouchersRoutes from './routes/vouchers.js';
import chequesRoutes from './routes/cheques.js';
import auditRoutes from './routes/audit.js';
import integrityRoutes from './routes/integrity.js';
import integrationsRoutes from './routes/integrations.js';
import enterpriseRoutes from './routes/enterprise.js';
import fiscalYearsRoutes from './routes/fiscalYears.js';
import projectsRoutes from './routes/projects.js';
import serviceInvoicesRoutes from './routes/serviceInvoices.js';
import clinicalRoutes from './modules/clinical/index.js';
import staffRoutes from './modules/staff/index.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(cors({ origin: true, credentials: true }));

const esignSignJsonLimit = process.env.ESIGN_SIGN_JSON_LIMIT || '15mb';
app.use('/api/sign', express.json({ limit: esignSignJsonLimit }), publicSignRoutes);
app.use('/sign', express.json({ limit: esignSignJsonLimit }), publicSignRoutes);

app.use(express.json({ limit: '1mb' }));

const esignPublicPath = process.env.ESIGN_PUBLIC_URL_PATH || '/files/esign';
app.use(esignPublicPath, express.static(getEsignStorageConfig().uploadRoot));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'accounting-saas-api' });
});

app.use('/api/auth', authRoutes);
app.use('/api/companies', companiesRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/periods', periodsRoutes);
app.use('/api/bank-accounts', bankAccountsRoutes);
app.use('/api/treasury-safes', treasurySafesRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/invoice-templates', invoiceTemplatesRoutes);
app.use('/api/vendors', vendorsRoutes);
app.use('/api/bills', billsRoutes);
app.use('/api/fixed-assets', fixedAssetsRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/taxes', taxesRoutes);
app.use('/api/currencies', currenciesRoutes);
app.use('/api/budgets', budgetsRoutes);
app.use('/api/dimensions', dimensionsRoutes);
app.use('/api/recurring', recurringRoutes);
app.use('/api/journal-templates', journalTemplatesRoutes);
app.use('/api/vouchers', vouchersRoutes);
app.use('/api/cheques', chequesRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/integrity', integrityRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/enterprise', enterpriseRoutes);
app.use('/api/fiscal-years', fiscalYearsRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/service-invoices', serviceInvoicesRoutes);
app.use('/api', clinicalRoutes);
app.use('/api', staffRoutes);
app.use('/api', documentsModule);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
