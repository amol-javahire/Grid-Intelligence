---
name: PyPSA /pypsa path routing
description: How the /pypsa reverse-proxy routing works and why it lives in api-server's artifact.toml
---

The `/pypsa` path is routed to port 8083 via a `[[services]]` block inside `artifacts/api-server/.replit-artifact/artifact.toml`.

`artifacts/pypsa-engine` has **no `artifact.toml`** of its own. The running workflow (`artifacts/pypsa-engine: PyPSA Engine`) is what actually starts the Python process on port 8083, but the proxy only knows to forward `/pypsa` traffic there because of the service definition in api-server's toml.

**Why:** When the pypsa-engine artifact was created, `verifyAndReplaceArtifactToml` failed because no artifact.toml existed for it. Rather than create one, the service was defined inside api-server's toml. This means two workflows exist for PyPSA:
- `artifacts/api-server: PyPSA Engine` — FAILS (runs from api-server/ dir, `cd artifacts/pypsa-engine` fails)
- `artifacts/pypsa-engine: PyPSA Engine` — RUNS (runs from workspace root, `cd artifacts/pypsa-engine` succeeds)

**How to apply:** Never remove the PyPSA `[[services]]` block from api-server's artifact.toml. The failing workflow is harmless noise; the routing depends on the block existing, not on the workflow succeeding. If the `/pypsa` endpoint goes dark, first check that this block is still in api-server's artifact.toml.
