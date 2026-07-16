import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import http from "node:http";
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

// ── PyPSA reverse proxy — forwards /pypsa/* → localhost:8083 ─────────────────
app.use("/pypsa", (req: Request, res: Response) => {
  const target = `http://localhost:8083/pypsa${req.url}`;
  const options: http.RequestOptions = {
    hostname: "localhost",
    port: 8083,
    path: `/pypsa${req.url}`,
    method: req.method,
    headers: { ...req.headers, host: "localhost:8083" },
  };
  const proxy = http.request(options, (pyRes) => {
    res.writeHead(pyRes.statusCode ?? 502, pyRes.headers);
    pyRes.pipe(res, { end: true });
  });
  proxy.on("error", (err) => {
    logger.error({ err, target }, "PyPSA proxy error");
    if (!res.headersSent) res.status(502).json({ error: "pypsa_unavailable", message: "PyPSA engine is not running" });
  });
  if (req.body && Object.keys(req.body).length > 0) {
    const body = JSON.stringify(req.body);
    proxy.setHeader("content-type", "application/json");
    proxy.setHeader("content-length", Buffer.byteLength(body));
    proxy.write(body);
  }
  proxy.end();
});

export default app;
