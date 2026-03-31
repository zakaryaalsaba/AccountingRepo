import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

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
import customersRoutes from './routes/customers.js';
import invoiceTemplatesRoutes from './routes/invoiceTemplates.js';
import vendorsRoutes from './routes/vendors.js';
import billsRoutes from './routes/bills.js';
import clinicalRoutes from './modules/clinical/index.js';
import staffRoutes from './modules/staff/index.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

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
app.use('/api/customers', customersRoutes);
app.use('/api/invoice-templates', invoiceTemplatesRoutes);
app.use('/api/vendors', vendorsRoutes);
app.use('/api/bills', billsRoutes);
app.use('/api', clinicalRoutes);
app.use('/api', staffRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
