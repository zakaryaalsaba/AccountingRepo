import { Router } from 'express';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { paymentsTableExists } from '../utils/invoiceSchema.js';
import * as paymentService from '../accounting/paymentService.js';

const router = Router();
router.use(authRequired, companyContext);

router.get('/', async (req, res) => {
  try {
    if (!(await paymentsTableExists())) {
      return res.status(503).json({
        error: 'Payments schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/002_payments_invoice_payer.sql',
      });
    }
    const payments = await paymentService.listPayments(req.company.id);
    return res.json({ payments });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list payments' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!(await paymentsTableExists())) {
      return res.status(503).json({ error: 'Payments schema not installed.' });
    }
    const payment = await paymentService.getPaymentById(req.company.id, req.params.id);
    if (!payment) return res.status(404).json({ error: 'Not found' });
    return res.json({ payment });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load payment' });
  }
});

router.post('/', async (req, res) => {
  try {
    if (!(await paymentsTableExists())) {
      return res.status(503).json({ error: 'Payments schema not installed.' });
    }
    const payment = await paymentService.createPayment(req.company.id, req.body);
    return res.status(201).json({ payment });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to create payment' });
  }
});

router.post('/:id/apply', async (req, res) => {
  try {
    if (!(await paymentsTableExists())) {
      return res.status(503).json({ error: 'Payments schema not installed.' });
    }
    const { allocations } = req.body || {};
    const payment = await paymentService.applyPaymentToInvoices(
      req.company.id,
      req.params.id,
      allocations
    );
    return res.status(200).json({ payment });
  } catch (e) {
    if (e.status === 400 || e.status === 404) return res.status(e.status).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to apply payment' });
  }
});

export default router;
