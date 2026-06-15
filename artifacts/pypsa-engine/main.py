"""
PyPSA Engine — FastAPI microservice
------------------------------------
Endpoints:
  GET  /pypsa/healthz
  GET  /pypsa/network            — static ERCOT 5-bus topology
  POST /pypsa/opf                — run DC OPF with custom scenario params
  GET  /pypsa/ml/status          — check if model is trained
  POST /pypsa/ml/train           — train XGBoost on ercot_node_stats
  GET  /pypsa/ml/predict         — predict basis for node/month
  GET  /pypsa/ml/importance      — feature importance ranking
  POST /pypsa/curtailment        — renewable curtailment + negative price simulator
  POST /pypsa/tx-relief          — transmission line upgrade before/after comparison
  POST /pypsa/scarcity           — thermal derate + load shedding scarcity scenario
  POST /pypsa/battery            — 24-hr multi-period OPF with battery StorageUnit
"""

import os
import logging
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pypsa-engine")

app = FastAPI(title="PyPSA Engine", root_path="/pypsa")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/healthz")
def healthz():
    return {"status": "ok", "service": "pypsa-engine"}


# ---------------------------------------------------------------------------
# Network topology + OPF
# ---------------------------------------------------------------------------
@app.get("/network")
def get_network():
    from network import get_topology
    return get_topology()


class OPFRequest(BaseModel):
    system_load_mw: float = 55000.0
    wind_cf: float        = 0.35
    solar_cf: float       = 0.22
    gas_price_mmbtu: float = 3.50


@app.post("/opf")
def run_opf(req: OPFRequest):
    from network import run_opf as _run_opf
    try:
        result = _run_opf(
            system_load_mw=req.system_load_mw,
            wind_cf=req.wind_cf,
            solar_cf=req.solar_cf,
            gas_price_mmbtu=req.gas_price_mmbtu,
        )
        if "error" in result:
            raise HTTPException(status_code=422, detail=result["error"])
        return result
    except Exception as e:
        logger.error("OPF failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


_opf_cache: dict | None = None

@app.on_event("startup")
async def startup_event():
    global _opf_cache
    try:
        from network import run_opf as _run_opf
        logger.info("Pre-computing default OPF on startup...")
        _opf_cache = _run_opf()
        logger.info("OPF ready — avg LMP $%.2f, spread $%.2f",
                    _opf_cache.get("avg_lmp", 0), _opf_cache.get("lmp_spread", 0))
    except Exception as e:
        logger.warning("Startup OPF failed (non-fatal): %s", e)


@app.get("/opf/default")
def get_default_opf():
    """Return cached default scenario OPF result."""
    if _opf_cache:
        return _opf_cache
    from network import run_opf as _run_opf
    return _run_opf()


# ---------------------------------------------------------------------------
# ML model
# ---------------------------------------------------------------------------
_training = False

@app.get("/ml/status")
def ml_status():
    from ml_model import get_status
    status = get_status()
    status["training_in_progress"] = _training
    return status


@app.post("/ml/train")
async def ml_train(background_tasks: BackgroundTasks):
    global _training
    if _training:
        return {"message": "Training already in progress"}
    _training = True

    def do_train():
        global _training
        try:
            from ml_model import train
            result = train()
            logger.info("ML training complete — MAE=%.2f, F1=%.3f",
                        result.get("mae", 0), result.get("f1", 0))
        except Exception as e:
            logger.error("ML training failed: %s", e)
        finally:
            _training = False

    background_tasks.add_task(do_train)
    return {"message": "Training started in background — poll /ml/status for results"}


@app.get("/ml/predict")
def ml_predict(node: str = "HB_NORTH", month: int = 7, year: int = 2026):
    from ml_model import predict
    result = predict(node=node, month=month, year=year)
    if "error" in result:
        raise HTTPException(status_code=422, detail=result["error"])
    return result


@app.get("/ml/importance")
def ml_importance():
    from ml_model import get_importance
    importance = get_importance()
    if not importance:
        raise HTTPException(status_code=404, detail="Model not trained yet — POST /ml/train first")
    return {"features": importance}


@app.get("/ml/scatter")
def ml_scatter():
    from ml_model import get_status
    meta = get_status()
    if not meta.get("trained"):
        raise HTTPException(status_code=404, detail="Model not trained")
    return {"scatter": meta.get("scatter_sample", [])}


# ---------------------------------------------------------------------------
# Curtailment Simulator
# ---------------------------------------------------------------------------
class CurtailmentRequest(BaseModel):
    system_load_mw: float   = 45000.0
    wind_cf: float          = 0.55
    solar_cf: float         = 0.28
    gas_price_mmbtu: float  = 3.50
    west_wind_bonus_pct: float = 0.0


@app.post("/curtailment")
def curtailment(req: CurtailmentRequest):
    from simulators import run_curtailment
    try:
        result = run_curtailment(
            system_load_mw=req.system_load_mw,
            wind_cf=req.wind_cf,
            solar_cf=req.solar_cf,
            gas_price_mmbtu=req.gas_price_mmbtu,
            west_wind_bonus_pct=req.west_wind_bonus_pct,
        )
        if "error" in result:
            raise HTTPException(status_code=422, detail=result["error"])
        return result
    except Exception as e:
        logger.error("Curtailment sim failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Transmission Relief Simulator
# ---------------------------------------------------------------------------
class TxReliefRequest(BaseModel):
    system_load_mw: float  = 55000.0
    wind_cf: float         = 0.35
    solar_cf: float        = 0.22
    gas_price_mmbtu: float = 3.50
    upgrade_line: str      = "NORTH-WEST"
    upgrade_pct: float     = 50.0


@app.post("/tx-relief")
def tx_relief(req: TxReliefRequest):
    from simulators import run_tx_relief
    try:
        result = run_tx_relief(
            system_load_mw=req.system_load_mw,
            wind_cf=req.wind_cf,
            solar_cf=req.solar_cf,
            gas_price_mmbtu=req.gas_price_mmbtu,
            upgrade_line=req.upgrade_line,
            upgrade_pct=req.upgrade_pct,
        )
        if "error" in result:
            raise HTTPException(status_code=422, detail=result["error"])
        return result
    except Exception as e:
        logger.error("TX relief sim failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Scarcity / Load Shedding Simulator
# ---------------------------------------------------------------------------
class ScarcityRequest(BaseModel):
    system_load_mw: float    = 70000.0
    wind_cf: float           = 0.12
    solar_cf: float          = 0.05
    gas_price_mmbtu: float   = 5.00
    gas_derate_pct: float    = 15.0
    nuclear_derate_pct: float = 0.0
    voll: float              = 5000.0


@app.post("/scarcity")
def scarcity(req: ScarcityRequest):
    from simulators import run_scarcity
    try:
        result = run_scarcity(
            system_load_mw=req.system_load_mw,
            wind_cf=req.wind_cf,
            solar_cf=req.solar_cf,
            gas_price_mmbtu=req.gas_price_mmbtu,
            gas_derate_pct=req.gas_derate_pct,
            nuclear_derate_pct=req.nuclear_derate_pct,
            voll=req.voll,
        )
        if "error" in result:
            raise HTTPException(status_code=422, detail=result["error"])
        return result
    except Exception as e:
        logger.error("Scarcity sim failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Battery Revenue Simulator
# ---------------------------------------------------------------------------
class BatteryRequest(BaseModel):
    storage_bus: str        = "WEST"
    storage_mw: float       = 500.0
    storage_mwh: float      = 2000.0
    storage_efficiency: float = 0.90
    node: str               = "HB_WEST"
    year: int               = 2025
    month: int              = 7
    wind_cf: float          = 0.35
    solar_cf: float         = 0.22
    gas_price_mmbtu: float  = 3.50


@app.post("/battery")
def battery(req: BatteryRequest):
    from simulators import run_battery
    try:
        result = run_battery(
            storage_bus=req.storage_bus,
            storage_mw=req.storage_mw,
            storage_mwh=req.storage_mwh,
            storage_efficiency=req.storage_efficiency,
            node=req.node,
            year=req.year,
            month=req.month,
            wind_cf=req.wind_cf,
            solar_cf=req.solar_cf,
            gas_price_mmbtu=req.gas_price_mmbtu,
        )
        if "error" in result:
            raise HTTPException(status_code=422, detail=result["error"])
        return result
    except Exception as e:
        logger.error("Battery sim failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8083"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
