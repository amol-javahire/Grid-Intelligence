import { Router, type IRouter } from "express";
import healthRouter from "./health";
import candidatesRouter from "./candidates";
import screeningsRouter from "./screenings";
import energyStatsRouter from "./energy_stats";
import queueProjectsRouter from "./queue_projects";
import dashboardRouter from "./dashboard";
import chatRouter from "./chat";
import congestionIntelRouter from "./congestion_intel";
import adminRouter from "./admin";
import aesoStatsRouter from "./aeso_stats";
import ppaRouter from "./ppa";
import loadForecastRouter from "./load_forecast";
import datacentersRouter from "./datacenters";
import regulatoryRouter from "./regulatory";

const router: IRouter = Router();

router.use(healthRouter);
router.use(candidatesRouter);
router.use(screeningsRouter);
router.use(energyStatsRouter);
router.use(queueProjectsRouter);
router.use(dashboardRouter);
router.use(chatRouter);
router.use(congestionIntelRouter);
router.use(adminRouter);
router.use(aesoStatsRouter);
router.use(ppaRouter);
router.use(loadForecastRouter);
router.use(datacentersRouter);
router.use(regulatoryRouter);

export default router;
