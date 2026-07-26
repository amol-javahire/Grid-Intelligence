import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// ── PyPSA engine proxy ────────────────────────────────────────────────────────
// The frontend calls /pypsa/* ; the FastAPI engine listens on 127.0.0.1:8083
// and exposes routes WITHOUT the /pypsa prefix (e.g. /opf, /opf/default, /scarcity).
// Strip the prefix and forward. OPF solves take 20–60s, so allow a long timeout.
const PYPSA_BASE = process.env.PYPSA_URL ?? "http://127.0.0.1:8083";

app.use("/pypsa", async (req, res) => {
  const target = `${PYPSA_BASE}${req.url}`; // req.url is already prefix-stripped by app.use
  try {
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const upstream = await fetch(target, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
      signal: AbortSignal.timeout(180_000), // OPF/expansion solves can be slow
    });
    const text = await upstream.text();
    res
      .status(upstream.status)
      .set("content-type", upstream.headers.get("content-type") ?? "application/json")
      .send(text);
  } catch (err) {
    req.log.error({ err, target }, "pypsa proxy error");
    res.status(502).json({ error: "pypsa_unreachable", target });
  }
});

export default app;
