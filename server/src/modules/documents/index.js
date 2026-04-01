import { Router } from 'express';
import documentsRoutes from './routes/documents.js';

const router = Router();
router.use('/documents', documentsRoutes);

export default router;
