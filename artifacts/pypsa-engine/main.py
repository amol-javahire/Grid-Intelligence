"""
PyPSA Engine — FastAPI microservice
------------------------------------
Endpoints (ERCOT):
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

Endpoints (Alberta / AESO):
  GET  /pypsa/aeso/topology      — 3-node Alberta network topology for map
  POST /pypsa/aeso/opf           — run Alberta DC OPF with scenario params
  GET  /pypsa/aeso/opf/default   — cached default high-wind scenario result
  POST /pypsa/aeso/sensitivity   — sweep a single parameter (wind_cf, load, etc.)
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


@app.post("/topology/seed")
async def topology_seed(background_tasks: BackgroundTasks, key: str = ""):
    """Reseed ercot_buses + ercot_lines from CDR 10008 + ercot_node_locations.
    Runs in background — poll GET /pypsa/topology/seed/status.
    Requires ?key=<ERCOT_PASSWORD>."""
    _require_admin_key(key)
    def _run():
        try:
            import seed_topology
            seed_topology.seed()
            logger.info("Topology seed complete")
        except Exception as e:
            logger.error("Topology seed failed: %s", e)
    background_tasks.add_task(_run)
    return {"status": "started", "message": "Seeding in background"}


@app.get("/buses")
def get_buses():
    """Return all ercot_buses rows with lat/lon for map rendering."""
    try:
        import psycopg2
        conn = psycopg2.connect(os.environ.get("DATABASE_URL", ""))
        cur = conn.cursor()
        cur.execute("""
            SELECT bus_name, load_zone, hub, lat, lon, location_source
            FROM ercot_buses
            WHERE lat IS NOT NULL ORDER BY id
        """)
        rows = cur.fetchall()
        conn.close()
        return {"buses": [
            {"name": r[0], "zone": r[1], "hub": r[2],
             "lat": float(r[3]), "lon": float(r[4]), "src": r[5]}
            for r in rows
        ], "count": len(rows)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class OPFRequest(BaseModel):
    system_load_mw: float       = 55000.0
    wind_cf: float              = 0.35
    solar_cf: float             = 0.22
    gas_price_mmbtu: float      = 3.50
    simulation_datetime: str | None = None   # ISO8601 e.g. "2024-08-20T15:00:00"


@app.post("/opf")
def run_opf(req: OPFRequest):
    from network import run_opf as _run_opf
    try:
        result = _run_opf(
            system_load_mw=req.system_load_mw,
            wind_cf=req.wind_cf,
            solar_cf=req.solar_cf,
            gas_price_mmbtu=req.gas_price_mmbtu,
            simulation_datetime=req.simulation_datetime,
        )
        if "error" in result:
            raise HTTPException(status_code=422, detail=result["error"])
        return result
    except Exception as e:
        logger.error("OPF failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


_opf_cache: dict | None = None

def _precompute_ercot_opf():
    global _opf_cache
    try:
        from network import run_opf as _run_opf
        logger.info("Pre-computing default OPF on startup (high-wind scenario)...")
        _opf_cache = _run_opf(wind_cf=0.55, solar_cf=0.25)
        logger.info("OPF ready — avg LMP $%.2f, spread $%.2f",
                    _opf_cache.get("avg_lmp", 0), _opf_cache.get("lmp_spread", 0))
    except Exception as e:
        logger.warning("Startup OPF failed (non-fatal): %s", e)


@app.on_event("startup")
async def startup_event():
    """Kick off ERCOT OPF pre-computation in the background so the port binds immediately."""
    import asyncio
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _precompute_ercot_opf)


@app.get("/opf/default")
def get_default_opf():
    """Return cached default scenario OPF result."""
    if _opf_cache:
        return _opf_cache
    from network import run_opf as _run_opf
    return _run_opf()


@app.get("/gas-price")
def get_gas_price(date: str):
    """Return Henry Hub spot price for a given date (YYYY-MM-DD), using closest prior trading day."""
    try:
        from datetime import date as _date
        d = _date.fromisoformat(date)
        import psycopg2, os as _os
        conn = psycopg2.connect(_os.environ["DATABASE_URL"])
        cur = conn.cursor()
        cur.execute("""
            SELECT date, price FROM gas_prices
            WHERE hub = 'henry_hub' AND date <= %s AND price > 0
            ORDER BY date DESC LIMIT 1
        """, (d,))
        row = cur.fetchone()
        conn.close()
        if not row:
            raise HTTPException(status_code=404, detail="No gas price data for that date")
        return {"date": str(row[0]), "hub": "henry_hub", "price": float(row[1])}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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


# ---------------------------------------------------------------------------
# Admin: Resource Node Seed
# ---------------------------------------------------------------------------
_seeding = False


def _require_admin_key(key: str) -> None:
    """Compare key against ERCOT_PASSWORD. Raise 401 on mismatch."""
    expected = os.environ.get("ERCOT_PASSWORD", "")
    if not expected or key != expected:
        raise HTTPException(status_code=401, detail="Invalid admin key")


@app.get("/admin/seed-status")
def admin_seed_status():
    """Return current seed job progress. Safe to poll repeatedly."""
    from seeder import seed_status
    return dict(seed_status)


@app.post("/admin/seed-reset")
def admin_seed_reset(key: str = ""):
    """Force-clear the _seeding lock (use if a seed job is stuck/hung)."""
    global _seeding
    _require_admin_key(key)
    from seeder import seed_status
    was_running = _seeding or seed_status.get("running", False)
    _seeding = False
    seed_status["running"] = False
    seed_status["phase"] = "reset"
    seed_status["completed"] = False
    return {"reset": True, "was_running": was_running}


@app.post("/admin/seed")
async def admin_seed(
    background_tasks: BackgroundTasks,
    mode: str = "quick",
    key: str = "",
):
    """
    Trigger a resource node seed run in the background.

    mode=quick  CDR 12301 — public, no auth, recent 7-day window (~950 nodes, 1-2 months)
    mode=full   ERCOT API — OAuth B2C ROPC, Jan 2024 → now (all nodes, all months)

    Requires ?key=<ERCOT_PASSWORD> for auth.
    Poll GET /pypsa/admin/seed-status for progress.
    """
    global _seeding
    _require_admin_key(key)

    from seeder import seed_status
    if _seeding or seed_status.get("running"):
        return {"status": "already_running", "seed_status": dict(seed_status)}

    if mode not in ("quick", "full", "gaps"):
        raise HTTPException(status_code=400, detail="mode must be 'quick', 'full', or 'gaps'")

    _seeding = True

    def _run() -> None:
        global _seeding
        try:
            if mode == "full":
                from seeder import seed_ercot_api_full
                seed_ercot_api_full()
            elif mode == "gaps":
                from seeder import seed_ercot_api_gaps
                seed_ercot_api_gaps()
            else:
                from seeder import seed_cdr_quick
                seed_cdr_quick()
        finally:
            _seeding = False

    background_tasks.add_task(_run)
    return {
        "status": "started",
        "mode": mode,
        "message": "Seed running in background — poll GET /pypsa/admin/seed-status for progress",
    }


# ---------------------------------------------------------------------------
# Admin: ERCOT Hourly Dispatch Seed (NP3-965-ER SCED 60-day disclosure)
# ---------------------------------------------------------------------------
_dispatch_seeding = False


@app.get("/admin/seed-dispatch-status")
def admin_dispatch_seed_status():
    """Return current dispatch seed job progress. Safe to poll repeatedly."""
    from dispatch_seeder import dispatch_seed_status
    return dict(dispatch_seed_status)


@app.post("/admin/seed-dispatch-reset")
def admin_dispatch_seed_reset(key: str = ""):
    """Force-clear the dispatch seeding lock."""
    global _dispatch_seeding
    _require_admin_key(key)
    from dispatch_seeder import dispatch_seed_status
    was_running = _dispatch_seeding or dispatch_seed_status.get("running", False)
    _dispatch_seeding = False
    dispatch_seed_status["running"] = False
    dispatch_seed_status["phase"] = "reset"
    dispatch_seed_status["completed"] = False
    return {"reset": True, "was_running": was_running}


@app.post("/admin/seed-dispatch")
async def admin_seed_dispatch(
    background_tasks: BackgroundTasks,
    key: str = "",
    start_date: str = "",
):
    """
    Trigger ERCOT SCED hourly dispatch seed in the background.

    Pulls NP3-965-ER SCED 60-day disclosure data.
    Gap-fill safe — skips dates already in ercot_dispatch_seed_log.
    Requires ?key=<ERCOT_PASSWORD> for auth.
    Optional: ?start_date=YYYY-MM-DD to override the default start (2024-01-01).
    Poll GET /pypsa/admin/seed-dispatch-status for progress.
    """
    import datetime as dt
    global _dispatch_seeding
    _require_admin_key(key)

    from dispatch_seeder import dispatch_seed_status
    if _dispatch_seeding or dispatch_seed_status.get("running"):
        return {"status": "already_running", "seed_status": dict(dispatch_seed_status)}

    parsed_start: dt.date | None = None
    if start_date:
        try:
            parsed_start = dt.date.fromisoformat(start_date)
        except ValueError:
            return {"status": "error", "message": f"Invalid start_date: {start_date!r} — use YYYY-MM-DD"}

    _dispatch_seeding = True

    def _run() -> None:
        global _dispatch_seeding
        try:
            from dispatch_seeder import seed_dispatch_full, dispatch_seed_status
            seed_dispatch_full(start_date=parsed_start)
        except Exception as exc:
            import traceback
            try:
                from dispatch_seeder import dispatch_seed_status
                dispatch_seed_status["phase"] = "error"
                dispatch_seed_status["error"] = traceback.format_exc()
                dispatch_seed_status["running"] = False
            except Exception:
                pass
            raise
        finally:
            _dispatch_seeding = False

    background_tasks.add_task(_run)
    return {
        "status": "started",
        "start_date": str(parsed_start or "2024-01-01"),
        "message": "Dispatch seed running in background — poll GET /pypsa/admin/seed-dispatch-status",
    }


# ---------------------------------------------------------------------------
# Alberta / AESO — 3-node OPF
# ---------------------------------------------------------------------------

class AesoOPFRequest(BaseModel):
    system_load_mw: float       = 10500.0   # Provincial AIL (realistic: 9,000–12,500 MW)
    wind_cf: float              = 0.35       # Southern wind capacity factor
    solar_cf: float             = 0.22       # Southern solar capacity factor
    gas_price_mmbtu: float      = 4.50       # AECO-C natural gas price $/MMBtu
    south_central_limit_mw: float | None = None  # Override corridor limit (default 2800 MW)
    central_north_limit_mw: float | None = None  # Override N-S limit (default 1400 MW)
    bc_import_mw: float | None  = None       # Override BC import cap (default 1200 MW)
    south_wind_bonus_pct: float = 0.0        # % extra wind capacity in SOUTH zone


class AesoSensitivityRequest(BaseModel):
    param: str = "wind_cf"          # Parameter to sweep
    values: list[float] | None = None
    fixed: dict | None = None


_aeso_opf_cache: dict | None = None


@app.get("/aeso/topology")
def aeso_topology():
    """Return 3-node Alberta network topology (buses, lines, generator summaries)."""
    from aeso_network import get_topology
    return get_topology()


@app.post("/aeso/opf")
def aeso_opf(req: AesoOPFRequest):
    """Run DC OPF on the 3-node Alberta network. Returns nodal LMPs, line flows, dispatch, curtailment."""
    from aeso_network import run_opf as _run_aeso_opf
    try:
        result = _run_aeso_opf(
            system_load_mw=req.system_load_mw,
            wind_cf=req.wind_cf,
            solar_cf=req.solar_cf,
            gas_price_mmbtu=req.gas_price_mmbtu,
            south_central_limit_mw=req.south_central_limit_mw,
            central_north_limit_mw=req.central_north_limit_mw,
            bc_import_mw=req.bc_import_mw,
            south_wind_bonus_pct=req.south_wind_bonus_pct,
        )
        if "error" in result:
            raise HTTPException(status_code=422, detail=result["error"])
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error("AESO OPF failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/aeso/opf/default")
def aeso_opf_default():
    """Return cached default Alberta OPF result (high-wind, mid-load scenario)."""
    if _aeso_opf_cache:
        return _aeso_opf_cache
    from aeso_network import run_opf as _run_aeso_opf
    return _run_aeso_opf(wind_cf=0.55, solar_cf=0.25, system_load_mw=10500.0)


@app.post("/aeso/sensitivity")
def aeso_sensitivity(req: AesoSensitivityRequest):
    """
    Sweep a single input parameter and return LMP/congestion/curtailment curves.

    param options: wind_cf | solar_cf | gas_price_mmbtu | system_load_mw | south_central_limit_mw
    """
    from aeso_network import run_sensitivity
    try:
        result = run_sensitivity(
            param=req.param,
            values=req.values,
            fixed=req.fixed,
        )
        return result
    except Exception as e:
        logger.error("AESO sensitivity failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


def _precompute_aeso_opf():
    global _aeso_opf_cache
    try:
        from aeso_network import run_opf as _run_aeso_opf
        logger.info("Pre-computing Alberta OPF (high-wind scenario)...")
        _aeso_opf_cache = _run_aeso_opf(wind_cf=0.55, solar_cf=0.25, system_load_mw=10500.0)
        logger.info(
            "Alberta OPF ready — SOUTH LMP $%.2f, CENTRAL LMP $%.2f, spread $%.2f",
            _aeso_opf_cache.get("lmp_south", 0),
            _aeso_opf_cache.get("lmp_central", 0),
            _aeso_opf_cache.get("south_central_spread_cad_mwh", 0),
        )
    except Exception as e:
        logger.warning("Alberta startup OPF failed (non-fatal): %s", e)


@app.on_event("startup")
async def aeso_startup():
    """Kick off Alberta OPF pre-computation in the background so the port binds immediately."""
    import asyncio
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _precompute_aeso_opf)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8083"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
