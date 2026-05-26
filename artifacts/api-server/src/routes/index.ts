import { Router, type IRouter } from "express";
import healthRouter from "./health";
import streamProxyRouter from "./streamProxy";
import resolveStreamRouter from "./resolveStream";
import videoProxyRouter from "./videoProxy";
import vidlinkStreamRouter from "./vidlinkStream";
import tmdbSeriesRouter from "./tmdbSeries";
import sflixUrlRouter from "./sflixUrl";
import spProxyRouter from "./spProxy";

const router: IRouter = Router();

router.use(healthRouter);
router.use(streamProxyRouter);
router.use(resolveStreamRouter);
router.use(videoProxyRouter);
router.use(vidlinkStreamRouter);
router.use(tmdbSeriesRouter);
router.use(sflixUrlRouter);
router.use(spProxyRouter);

export default router;
