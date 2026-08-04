import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

type Geometry = Record<string, unknown> | null;
type Properties = Record<string, unknown>;
type Feature = { type: "Feature"; geometry: Geometry; properties: Properties };
type FeatureCollection = { type: "FeatureCollection"; features: Feature[] };

type SubstationCapability = {
  busNumber: number;
  voltageKv: number;
  capabilityMw: number;
};

type CapabilityLookup = {
  available: boolean;
  asOfDate: string | null;
  substations: Map<string, SubstationCapability[]>;
  lines: Map<string, { minCapabilityMw: number; maxCapabilityMw: number }>;
};

const router = Router();
const SERVICE_ROOT = "https://services5.arcgis.com/6czaFAhUmpKiwuMe/arcgis/rest/services";

const LAYERS = {
  planningAreas: {
    url: `${SERVICE_ROOT}/AESO_Planning_Areas/FeatureServer/0`,
    fields: "ID,NAME,REGION",
    tolerance: "0.001",
  },
  lines: {
    url: `${SERVICE_ROOT}/AESO_TX_Lines_View_Layer/FeatureServer/3`,
    fields: "LINENAME,VOLTAGE,FROM_SUB,TO_SUB,LENGTH,PRECISION_",
    tolerance: "0.0001",
  },
  generators: {
    url: `${SERVICE_ROOT}/Existing_Generation_View_Layer/FeatureServer/0`,
    fields: "Asset_ID,Asset_Name,Asset_Type,Maximum_Ca,Planning_A,Planning_R",
  },
  substations: {
    url: `${SERVICE_ROOT}/AESO_Substations_Full_Province_View/FeatureServer/0`,
    fields: "Name,FacilCode,NameFacil,Voltage,DLSAddress,PlanArea,Region",
  },
  projects: {
    url: `${SERVICE_ROOT}/Projects_Upload/FeatureServer/0`,
    fields: [
      "Status_1", "Project_Na", "ProjNo", "Planning_1", "Project_Ty",
      "MW_Type", "FuelType", "Stage_1", "Inclusion", "Applied_On",
      "Total_STS", "Total_DTS",
    ].join(","),
  },
} as const;

const SOURCE_PAGE = "https://www.arcgis.com/home/item.html?id=171e235717634577a9e90c9ba12296f3";
const CAPABILITY_SOURCE = "https://www.aeso.ca/grid/connecting-to-the-grid/transmission-capability-map/";
const CACHE_TTL_MS = 15 * 60 * 1000;

let cache: { expiresAt: number; payload: unknown } | null = null;

function emptyCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateFromEpoch(value: unknown): string | null {
  const epoch = numberOrNull(value);
  if (epoch == null) return null;
  return new Date(epoch).toISOString().slice(0, 10);
}

async function queryArcGis(
  layer: { url: string; fields: string; tolerance?: string },
): Promise<FeatureCollection> {
  const url = new URL(`${layer.url}/query`);
  url.search = new URLSearchParams({
    where: "1=1",
    outFields: layer.fields,
    returnGeometry: "true",
    outSR: "4326",
    geometryPrecision: "6",
    f: "geojson",
    ...(layer.tolerance ? { maxAllowableOffset: layer.tolerance } : {}),
  }).toString();

  const response = await fetch(url, {
    headers: { Accept: "application/geo+json, application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`ArcGIS ${response.status} for ${layer.url}`);

  const payload = await response.json() as Partial<FeatureCollection> & { error?: unknown };
  if (payload.type !== "FeatureCollection" || !Array.isArray(payload.features)) {
    throw new Error(`ArcGIS returned an invalid feature collection for ${layer.url}`);
  }
  return payload as FeatureCollection;
}

async function loadCapabilities(): Promise<CapabilityLookup> {
  const [tables] = (await db.execute<{
    substations: string | null;
    lines: string | null;
  }>(sql`
    SELECT to_regclass('public.aeso_substation_capability')::text AS substations,
           to_regclass('public.aeso_line_capability')::text AS lines
  `)).rows;

  if (!tables?.substations || !tables?.lines) {
    return { available: false, asOfDate: null, substations: new Map(), lines: new Map() };
  }

  const [substationRows, lineRows] = await Promise.all([
    db.execute<{
      facility_code: string;
      as_of_date: string;
      capabilities: SubstationCapability[];
    }>(sql`
      SELECT facility_code,
             as_of_date::text,
             json_agg(json_build_object(
               'busNumber', bus_number,
               'voltageKv', voltage_kv,
               'capabilityMw', capability_mw::float
             ) ORDER BY voltage_kv DESC, bus_number) AS capabilities
      FROM aeso_substation_capability
      WHERE as_of_date = (SELECT MAX(as_of_date) FROM aeso_substation_capability)
      GROUP BY facility_code, as_of_date
    `),
    db.execute<{
      line_code: string;
      min_capability_mw: number;
      max_capability_mw: number;
    }>(sql`
      SELECT split_part(line_name, ' ', 1) AS line_code,
             MIN(capability_mw)::float AS min_capability_mw,
             MAX(capability_mw)::float AS max_capability_mw
      FROM aeso_line_capability
      WHERE as_of_date = (SELECT MAX(as_of_date) FROM aeso_line_capability)
      GROUP BY split_part(line_name, ' ', 1)
    `),
  ]);

  return {
    available: true,
    asOfDate: substationRows.rows[0]?.as_of_date ?? null,
    substations: new Map(substationRows.rows.map((row) => [row.facility_code, row.capabilities])),
    lines: new Map(lineRows.rows.map((row) => [row.line_code, {
      minCapabilityMw: row.min_capability_mw,
      maxCapabilityMw: row.max_capability_mw,
    }])),
  };
}

function normalizeFeatures(
  raw: Record<keyof typeof LAYERS, FeatureCollection>,
  capabilities: CapabilityLookup,
) {
  const planningAreas: FeatureCollection = {
    type: "FeatureCollection",
    features: raw.planningAreas.features.map((feature) => ({
      type: "Feature",
      geometry: feature.geometry,
      properties: {
        areaCode: numberOrNull(feature.properties.ID),
        areaName: feature.properties.NAME ?? null,
        region: feature.properties.REGION ?? null,
      },
    })),
  };

  const lines: FeatureCollection = {
    type: "FeatureCollection",
    features: raw.lines.features.map((feature) => {
      const lineName = String(feature.properties.LINENAME ?? "").trim();
      return {
        type: "Feature",
        geometry: feature.geometry,
        properties: {
          lineName,
          voltageKv: numberOrNull(feature.properties.VOLTAGE),
          fromSubstation: feature.properties.FROM_SUB ?? null,
          toSubstation: feature.properties.TO_SUB ?? null,
          lengthM: numberOrNull(feature.properties.LENGTH),
          precision: feature.properties.PRECISION_ ?? null,
          capability: capabilities.lines.get(lineName) ?? null,
        },
      };
    }),
  };

  const substations: FeatureCollection = {
    type: "FeatureCollection",
    features: raw.substations.features.map((feature) => {
      const facilityCode = String(feature.properties.FacilCode ?? "").trim();
      return {
        type: "Feature",
        geometry: feature.geometry,
        properties: {
          name: feature.properties.Name ?? null,
          facilityCode,
          displayName: feature.properties.NameFacil ?? null,
          voltage: feature.properties.Voltage ?? null,
          landLocation: feature.properties.DLSAddress ?? null,
          planningArea: feature.properties.PlanArea ?? null,
          region: feature.properties.Region ?? null,
          capabilities: capabilities.substations.get(facilityCode) ?? [],
        },
      };
    }),
  };

  const generators: FeatureCollection = {
    type: "FeatureCollection",
    features: raw.generators.features.map((feature) => ({
      type: "Feature",
      geometry: feature.geometry,
      properties: {
        assetId: feature.properties.Asset_ID ?? null,
        assetName: feature.properties.Asset_Name ?? null,
        assetType: feature.properties.Asset_Type ?? null,
        maximumCapabilityMw: numberOrNull(feature.properties.Maximum_Ca),
        planningArea: feature.properties.Planning_A ?? null,
        region: feature.properties.Planning_R ?? null,
      },
    })),
  };

  const projects: FeatureCollection = {
    type: "FeatureCollection",
    features: raw.projects.features.map((feature) => ({
      type: "Feature",
      geometry: feature.geometry,
      properties: {
        projectNumber: numberOrNull(feature.properties.ProjNo),
        projectName: feature.properties.Project_Na ?? null,
        status: feature.properties.Status_1 ?? null,
        planningArea: feature.properties.Planning_1 ?? null,
        projectType: feature.properties.Project_Ty ?? null,
        mwType: feature.properties.MW_Type ?? null,
        fuelType: feature.properties.FuelType ?? null,
        stage: numberOrNull(feature.properties.Stage_1),
        included: feature.properties.Inclusion ?? null,
        appliedOn: dateFromEpoch(feature.properties.Applied_On),
        supplyMw: numberOrNull(feature.properties.Total_STS),
        demandMw: numberOrNull(feature.properties.Total_DTS),
      },
    })),
  };

  return { planningAreas, lines, substations, generators, projects };
}

router.get("/aeso/map", async (req, res) => {
  try {
    if (cache && cache.expiresAt > Date.now()) {
      res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=900");
      return res.json(cache.payload);
    }

    const [planningAreas, lines, generators, substations, projects, capabilityResult] =
      await Promise.all([
        queryArcGis(LAYERS.planningAreas),
        queryArcGis(LAYERS.lines),
        queryArcGis(LAYERS.generators),
        queryArcGis(LAYERS.substations),
        queryArcGis(LAYERS.projects),
        loadCapabilities().catch((error) => {
          req.log.warn({ error }, "AESO map capability tables unavailable");
          return { available: false, asOfDate: null, substations: new Map(), lines: new Map() };
        }),
      ]);

    const layers = normalizeFeatures(
      { planningAreas, lines, generators, substations, projects },
      capabilityResult,
    );
    const payload = {
      retrievedAt: new Date().toISOString(),
      capabilityAsOf: capabilityResult.asOfDate,
      capabilityDataAvailable: capabilityResult.available,
      counts: {
        planningAreas: layers.planningAreas.features.length,
        lines: layers.lines.features.length,
        substations: layers.substations.features.length,
        generators: layers.generators.features.length,
        projects: layers.projects.features.length,
      },
      sources: {
        geometry: SOURCE_PAGE,
        capability: CAPABILITY_SOURCE,
        note: "Geometry is live AESO ArcGIS data. Capability values are from the latest seeded AESO workbook.",
      },
      layers,
    };

    cache = { expiresAt: Date.now() + CACHE_TTL_MS, payload };
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=900");
    return res.json(payload);
  } catch (err) {
    req.log.error({ err }, "AESO network map source error");
    return res.status(502).json({
      error: "AESO network map data is temporarily unavailable",
      detail: err instanceof Error ? err.message : "Unknown upstream error",
    });
  }
});

export default router;
