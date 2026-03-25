import { Router } from 'express';
import patientsRoutes from './routes/patients.js';
import appointmentsRoutes from './routes/appointments.js';
import medicalRecordsRoutes from './routes/medicalRecords.js';
import insuranceProvidersRoutes from './routes/insuranceProviders.js';
import patientInsurancesRoutes from './routes/patientInsurances.js';
import doctorProfilesRoutes from './routes/doctorProfiles.js';
import prescriptionsRoutes from './routes/prescriptions.js';
import labOrdersRoutes from './routes/labOrders.js';

const router = Router();

router.use('/patients', patientsRoutes);
router.use('/appointments', appointmentsRoutes);
router.use('/medical-records', medicalRecordsRoutes);
router.use('/insurance-providers', insuranceProvidersRoutes);
router.use('/patient-insurances', patientInsurancesRoutes);
router.use('/doctor-profiles', doctorProfilesRoutes);
router.use('/prescriptions', prescriptionsRoutes);
router.use('/lab-orders', labOrdersRoutes);

export default router;
