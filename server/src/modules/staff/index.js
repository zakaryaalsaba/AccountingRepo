import { Router } from 'express';
import staffUsersRoutes from './routes/staffUsers.js';
import staffRolesRoutes from './routes/staffRoles.js';

const router = Router();

router.use('/staff', staffUsersRoutes);
router.use('/roles', staffRolesRoutes);

export default router;
