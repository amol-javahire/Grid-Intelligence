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

export default router;
