/**
 * Seed calibrated synthetic AESO data
 * Alberta power market: pool price cap $999.99/MWh, HE1-HE24, Mountain Time
 * Gas ~60%, Wind ~30%, Solar ~5%, Hydro ~5%; coal phased out 2023
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 4294967296;
  };
}

const rand = rng(42);

function norm(mean: number, std: number) {
  const u1 = rand() || 1e-10;
  const u2 = rand();
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// Date range: Jan 2024 – May 2026 (~880 days)
function* dayRange(startY: number, startM: number, startD: number, endY: number, endM: number, endD: number) {
  const start = new Date(Date.UTC(startY, startM - 1, startD));
  const end = new Date(Date.UTC(endY, endM - 1, endD));
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    yield new Date(d);
  }
}

function dateStr(d: Date) {
  return d.toISOString().slice(0, 10);
}

async function seedPoolPrice() {
  console.log("Seeding pool price + generation mix + supply/demand + actual/forecast...");
  const CHUNK = 500;
  const poolPriceBatch: string[] = [];
  const genMixBatch: string[] = [];
  const supplyDemandBatch: string[] = [];
  const actualForecastBatch: string[] = [];

  for (const day of dayRange(2024, 1, 1, 2026, 5, 31)) {
    const ds = dateStr(day);
    const month = day.getUTCMonth() + 1;
    const dow = day.getUTCDay(); // 0=Sun
    const isWeekend = dow === 0 || dow === 6;
    // Seasonal demand factor: higher winter (Dec-Feb), lower spring
    const seasonDemand = month === 12 || month <= 2 ? 1.15
      : month >= 6 && month <= 8 ? 1.05 : 0.95;
    // Coal was phased out by Jan 2024 so coalMw = 0 throughout
    const coalMw = 0;

    for (let he = 1; he <= 24; he++) {
      // Load shape: peak HE8-HE22, trough HE3-HE5
      const loadShape = he >= 8 && he <= 22 ? 1.1 : he >= 3 && he <= 5 ? 0.88 : 1.0;
      const ailBase = isWeekend ? 9400 : 10200;
      const ailMw = clamp(norm(ailBase * seasonDemand * loadShape, 350), 7500, 13000);

      // Wind: higher in southern AB, stronger in afternoon/night
      const windBase = 3200;
      const windHourFactor = (he >= 14 && he <= 20) ? 1.2 : (he >= 2 && he <= 6) ? 1.15 : 0.9;
      const windMonthFactor = month >= 3 && month <= 6 ? 1.2 : month >= 7 && month <= 9 ? 0.85 : 1.0;
      const windMw = clamp(norm(windBase * windHourFactor * windMonthFactor, 600), 100, 7500);

      // Solar: daytime only
      const solarHourFactor = he >= 9 && he <= 19
        ? Math.sin(((he - 9) / 10) * Math.PI)
        : 0;
      const solarSeasonFactor = month >= 5 && month <= 8 ? 1.3 : month <= 2 || month === 12 ? 0.4 : 0.9;
      const solarMw = clamp(he >= 9 && he <= 19
        ? norm(650 * solarHourFactor * solarSeasonFactor, 80)
        : 0, 0, 1500);

      // Hydro: relatively stable
      const hydroMw = clamp(norm(500, 60), 250, 800);

      // Gas fills the rest
      const storageMw = clamp(norm(50, 30), 0, 300);
      const otherMw = clamp(norm(80, 20), 30, 150);
      const gasMw = clamp(ailMw - windMw - solarMw - hydroMw - storageMw - otherMw, 3000, 9000);
      const totalMw = gasMw + windMw + solarMw + hydroMw + storageMw + otherMw + coalMw;

      // Available capacity
      const availableCapacityMw = clamp(norm(totalMw * 1.18, 400), totalMw * 1.03, 18000);
      const reserveMarginPct = clamp(((availableCapacityMw - ailMw) / ailMw) * 100, 3, 45);

      // Interchange
      const bcInterchangeMw = clamp(norm(-150, 200), -600, 300);
      const skInterchangeMw = clamp(norm(80, 80), -100, 350);
      const netInterchangeMw = bcInterchangeMw + skInterchangeMw;

      // Pool price: driven by supply tightness and gas price
      const tightness = clamp((ailMw - availableCapacityMw * 0.92) / 500, -2, 4);
      const gasPriceBase = 65;
      const basePrice = gasPriceBase + tightness * 25 + (windMw > 4500 ? -15 : 0);
      let poolPrice = clamp(norm(basePrice, 18), -20, 999.99);

      // Price spike: ~2% of hours, more likely at peak winter/summer load
      const spikeProb = (month === 1 || month === 12 || month === 7) && he >= 16 && he <= 21 ? 0.035 : 0.012;
      if (rand() < spikeProb) {
        poolPrice = clamp(norm(680, 180), 300, 999.99);
      }

      // Very low/negative price: ~3% of off-peak high-wind hours
      if (he >= 1 && he <= 6 && windMw > 4000 && rand() < 0.06) {
        poolPrice = clamp(norm(-5, 15), -20, 30);
      }

      const forecastPoolPrice = clamp(poolPrice + norm(0, 12), -20, 999.99);
      const netGenMw = totalMw - netInterchangeMw;

      // Forecast errors
      const ailForecastMw = ailMw + norm(0, 80);
      const forecastWindMw = windMw + norm(0, 180);
      const windForecastErrorMw = forecastWindMw - windMw;
      const forecastSolarMw = solarMw + norm(0, 30);
      const solarForecastErrorMw = forecastSolarMw - solarMw;
      const priceForecastError = forecastPoolPrice - poolPrice;

      poolPriceBatch.push(`('${ds}', ${he}, ${poolPrice.toFixed(4)}, ${forecastPoolPrice.toFixed(4)}, ${ailMw.toFixed(2)}, ${netGenMw.toFixed(2)})`);
      genMixBatch.push(`('${ds}', ${he}, ${gasMw.toFixed(2)}, ${coalMw.toFixed(2)}, ${windMw.toFixed(2)}, ${solarMw.toFixed(2)}, ${hydroMw.toFixed(2)}, ${storageMw.toFixed(2)}, ${otherMw.toFixed(2)}, ${totalMw.toFixed(2)})`);
      supplyDemandBatch.push(`('${ds}', ${he}, ${ailMw.toFixed(2)}, ${availableCapacityMw.toFixed(2)}, ${reserveMarginPct.toFixed(2)}, ${bcInterchangeMw.toFixed(2)}, ${skInterchangeMw.toFixed(2)}, ${netInterchangeMw.toFixed(2)})`);
      actualForecastBatch.push(`('${ds}', ${he}, ${poolPrice.toFixed(4)}, ${forecastPoolPrice.toFixed(4)}, ${priceForecastError.toFixed(4)}, ${ailMw.toFixed(2)}, ${ailForecastMw.toFixed(2)}, ${windMw.toFixed(2)}, ${forecastWindMw.toFixed(2)}, ${windForecastErrorMw.toFixed(2)}, ${solarMw.toFixed(2)}, ${forecastSolarMw.toFixed(2)}, ${solarForecastErrorMw.toFixed(2)}, 'synthetic')`);

      if (poolPriceBatch.length >= CHUNK) {
        await db.execute(sql.raw(`INSERT INTO aeso_pool_price (date, hour_ending, pool_price, forecast_pool_price, ail_mw, net_gen_mw) VALUES ${poolPriceBatch.join(",")} ON CONFLICT (date, hour_ending) DO NOTHING`));
        await db.execute(sql.raw(`INSERT INTO aeso_generation_mix (date, hour_ending, gas_mw, coal_mw, wind_mw, solar_mw, hydro_mw, storage_mw, other_mw, total_mw) VALUES ${genMixBatch.join(",")} ON CONFLICT (date, hour_ending) DO NOTHING`));
        await db.execute(sql.raw(`INSERT INTO aeso_supply_demand (date, hour_ending, ail_mw, available_capacity_mw, reserve_margin_pct, bc_interchange_mw, sk_interchange_mw, net_interchange_mw) VALUES ${supplyDemandBatch.join(",")} ON CONFLICT (date, hour_ending) DO NOTHING`));
        await db.execute(sql.raw(`INSERT INTO aeso_actual_forecast (date, hour_ending, actual_pool_price, forecast_pool_price, price_forecast_error, actual_ail_mw, forecast_ail_mw, actual_wind_mw, forecast_wind_mw, wind_forecast_error_mw, actual_solar_mw, forecast_solar_mw, solar_forecast_error_mw, source) VALUES ${actualForecastBatch.join(",")} ON CONFLICT (date, hour_ending) DO NOTHING`));
        poolPriceBatch.length = 0;
        genMixBatch.length = 0;
        supplyDemandBatch.length = 0;
        actualForecastBatch.length = 0;
        process.stdout.write(".");
      }
    }
  }

  // Flush remaining
  if (poolPriceBatch.length > 0) {
    await db.execute(sql.raw(`INSERT INTO aeso_pool_price (date, hour_ending, pool_price, forecast_pool_price, ail_mw, net_gen_mw) VALUES ${poolPriceBatch.join(",")} ON CONFLICT (date, hour_ending) DO NOTHING`));
    await db.execute(sql.raw(`INSERT INTO aeso_generation_mix (date, hour_ending, gas_mw, coal_mw, wind_mw, solar_mw, hydro_mw, storage_mw, other_mw, total_mw) VALUES ${genMixBatch.join(",")} ON CONFLICT (date, hour_ending) DO NOTHING`));
    await db.execute(sql.raw(`INSERT INTO aeso_supply_demand (date, hour_ending, ail_mw, available_capacity_mw, reserve_margin_pct, bc_interchange_mw, sk_interchange_mw, net_interchange_mw) VALUES ${supplyDemandBatch.join(",")} ON CONFLICT (date, hour_ending) DO NOTHING`));
    await db.execute(sql.raw(`INSERT INTO aeso_actual_forecast (date, hour_ending, actual_pool_price, forecast_pool_price, price_forecast_error, actual_ail_mw, forecast_ail_mw, actual_wind_mw, forecast_wind_mw, wind_forecast_error_mw, actual_solar_mw, forecast_solar_mw, solar_forecast_error_mw, source) VALUES ${actualForecastBatch.join(",")} ON CONFLICT (date, hour_ending) DO NOTHING`));
  }
  console.log("\nPool price, generation mix, supply/demand, actual/forecast seeded.");
}

// DEPRECATED 2026-07 — synthetic (Math.random) data only, not called from
// main() anymore. Kept for reference. Use seed-aeso-queue-real.ts instead,
// which pulls the real monthly AESO Connection Project List.
async function seedQueue() {
  console.log("Seeding AESO interconnection queue...");
  const regions = ["Southern AB", "Central AB", "Northern AB", "Eastern AB"];
  const fuelTypes = ["Wind", "Wind", "Wind", "Solar", "Solar", "Battery Storage", "Gas"];
  const statuses = ["Active", "Active", "Active", "Suspended", "Withdrawn", "Approved"];
  const transmissionNodes = [
    "BROOKS 240S", "PINCHER CREEK 240S", "VULCAN 240S", "LETHBRIDGE 240S",
    "MEDICINE HAT 240S", "RED DEER 240S", "LACOMBE 240S", "INNISFAIL 240S",
    "DRUMHELLER 240S", "CALGARY 240S", "AIRDRIE 240S", "OKOTOKS 240S",
    "STETTLER 240S", "CORONATION 240S", "WAINWRIGHT 240S", "GRANDE PRAIRIE 240S",
    "EDSON 240S", "JASPER 240S", "WHITECOURT 240S", "WESTLOCK 240S",
  ];

  const projects = [];
  const projectNames = [
    "Blackspring Ridge Wind III", "Castle Rock Ridge Wind II", "Chin Chute Wind", "Forty Mile Wind III",
    "Granum Wind", "High Level Wind", "Iron Creek Wind", "Jenner Wind II",
    "Kaybob Solar", "Keephills Storage", "Lacombe Solar North", "Magrath Wind II",
    "Medicine Hat Solar III", "Namaka Solar", "Oldman River Wind", "Peace River Wind II",
    "Provost Wind", "Rattlesnake Ridge Wind", "Rocky Mountain Wind", "Stavely Wind II",
    "Taber Solar III", "Vauxhall Solar II", "Vermilion Wind", "Wainwright Wind",
    "Whitecourt Wind II", "Wild Rose Wind III", "Winfield Solar", "Youngstown Wind II",
    "Zama Storage", "Athabasca Solar II", "Barons Wind III", "Carmangay Wind",
    "Didsbury Storage", "Eckville Wind", "Finnegan Wind", "Gleichen Solar II",
    "Hanna Wind II", "Innisfail Storage", "Jenner Solar", "Killam Wind",
    "Lacombe Wind II", "Madden Gas Peaker", "Nanton Solar III", "Oyen Wind",
    "Ponoka Storage", "Queenstown Wind", "Redcliff Solar", "Sundre Wind",
    "Three Hills Wind II", "Vulcan Solar III",
  ];

  for (let i = 0; i < 50; i++) {
    const fuelType = fuelTypes[Math.floor(rand() * fuelTypes.length)];
    const region = fuelType === "Wind" && rand() < 0.6 ? "Southern AB" : regions[Math.floor(rand() * regions.length)];
    const status = statuses[Math.floor(rand() * statuses.length)];
    const capacityMw = fuelType === "Battery Storage"
      ? Math.round(norm(150, 80))
      : fuelType === "Gas"
      ? Math.round(norm(200, 100))
      : Math.round(norm(200, 100));

    const queueYear = 2022 + Math.floor(rand() * 3);
    const queueMonth = 1 + Math.floor(rand() * 12);
    const onlineYear = queueYear + 2 + Math.floor(rand() * 3);
    const onlineMonth = 1 + Math.floor(rand() * 12);

    // Approximate lat/lng for AB regions
    const latBase = region === "Southern AB" ? 49.8 : region === "Central AB" ? 52.0 : region === "Northern AB" ? 55.0 : 52.5;
    const lngBase = -113.5;
    const lat = latBase + (rand() - 0.5) * 2.5;
    const lng = lngBase + (rand() - 0.5) * 4;

    projects.push(`(
      '${projectNames[i]}',
      '${fuelType}',
      ${Math.max(50, capacityMw)},
      '${region}',
      '${region.replace(" AB", "")}',
      '${status}',
      '${queueYear}-${String(queueMonth).padStart(2, "0")}-${String(1 + Math.floor(rand() * 28)).padStart(2, "0")}',
      '${onlineYear}-${String(onlineMonth).padStart(2, "0")}-01',
      '${transmissionNodes[Math.floor(rand() * transmissionNodes.length)]}',
      ${lat.toFixed(6)},
      ${lng.toFixed(6)}
    )`);
  }

  await db.execute(sql.raw(`
    INSERT INTO aeso_queue_projects
      (project_name, fuel_type, capacity_mw, region, county, status, queue_date, expected_online, transmission_connection, lat, lng)
    VALUES ${projects.join(",")}
    ON CONFLICT DO NOTHING
  `));
  console.log("Queue seeded.");
}

async function seedOutages() {
  console.log("Seeding outages...");
  const facilities = [
    "Genesee Unit 3", "Keephills Unit 2", "Sundance Unit 6", "Battle River Unit 5",
    "Sheerness Unit 1", "Rainbow Lake GT1", "Provost Gas Turbine",
    "Blackspring Ridge Wind Farm", "Castle Rock Ridge Wind", "Forty Mile Wind",
    "High Level Wind Farm", "Lac Ste. Anne Hydro", "Ghost Hydro",
    "TransAlta Cogeneration Fort SK", "Cenovus Foster Creek Cogen",
    "Capital Power Genesee 4", "Capital Power Genesee 5",
    "Suncor Firebag Cogen", "CNRL Horizon Cogen",
    "Vauxhall Solar Farm", "Chin Chute Solar",
  ];
  const fuelTypes: Record<string, string> = {
    "Genesee": "Gas", "Keephills": "Gas", "Sundance": "Gas",
    "Battle River": "Gas", "Sheerness": "Gas",
    "Rainbow Lake": "Gas", "Provost": "Gas",
    "Blackspring": "Wind", "Castle Rock": "Wind", "Forty Mile": "Wind", "High Level": "Wind",
    "Lac Ste. Anne": "Hydro", "Ghost": "Hydro",
    "TransAlta": "Gas", "Cenovus": "Gas", "Capital Power": "Gas",
    "Suncor": "Gas", "CNRL": "Gas",
    "Vauxhall": "Solar", "Chin Chute": "Solar",
  };
  const outageTypes = ["forced", "forced", "planned", "planned", "maintenance"];
  const reasons = [
    "Unplanned equipment failure", "Generator trip", "Turbine inspection",
    "Scheduled maintenance", "Transformer repair", "Control system upgrade",
    "Stator rewind", "Boiler tube leak", "Compressor inspection",
    "Annual outage", "Grid inspection", "Protection relay testing",
  ];

  const values: string[] = [];
  const now = new Date();

  for (let i = 0; i < 80; i++) {
    const facility = facilities[Math.floor(rand() * facilities.length)];
    const fuelKey = Object.keys(fuelTypes).find(k => facility.includes(k)) ?? "Gas";
    const fuelType = fuelTypes[fuelKey];
    const outageType = outageTypes[Math.floor(rand() * outageTypes.length)];
    const mwOffline = clamp(norm(180, 100), 20, 600);
    const reason = reasons[Math.floor(rand() * reasons.length)];

    // Mix of past, current, and future outages
    const startDaysFromNow = Math.floor(rand() * 300) - 200; // -200 to +100 days
    const start = new Date(now.getTime() + startDaysFromNow * 86400000);
    const durationDays = Math.max(1, Math.floor(norm(7, 5)));
    const end = new Date(start.getTime() + durationDays * 86400000);
    // Future "active" outages have no end
    const isOngoing = startDaysFromNow < 0 && startDaysFromNow > -14 && rand() < 0.2;

    values.push(`(
      '${facility}',
      '${fuelType}',
      '${outageType}',
      '${start.toISOString()}',
      ${isOngoing ? "NULL" : `'${end.toISOString()}'`},
      ${mwOffline.toFixed(2)},
      '${reason}',
      'AESO Outage Bulletin'
    )`);
  }

  await db.execute(sql.raw(`
    INSERT INTO aeso_outages (facility, fuel_type, outage_type, outage_start, outage_end, mw_offline, reason, source)
    VALUES ${values.join(",")}
  `));
  console.log("Outages seeded.");
}

async function seedCapability7Day() {
  console.log("Seeding 7-day capability forecast...");
  const forecastDate = new Date();
  forecastDate.setUTCHours(0, 0, 0, 0);
  const fd = dateStr(forecastDate);

  const values: string[] = [];
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const td = new Date(forecastDate.getTime() + dayOffset * 86400000);
    const tds = dateStr(td);
    for (let he = 1; he <= 24; he++) {
      const loadShape = he >= 8 && he <= 22 ? 1.1 : 0.9;
      const ailForecast = clamp(norm(10000 * loadShape, 400), 8000, 13500);
      const gasMw = clamp(norm(5800, 400), 3500, 8500);
      const windMw = clamp(norm(3100, 500), 500, 7000);
      const solarMw = he >= 9 && he <= 19 ? clamp(norm(400, 100), 0, 1200) : 0;
      const hydroMw = clamp(norm(490, 50), 300, 700);
      const storageMw = clamp(norm(60, 30), 0, 300);
      const otherMw = clamp(norm(80, 15), 40, 130);
      const totalAvailableMw = gasMw + windMw + solarMw + hydroMw + storageMw + otherMw;
      const reserveMarginPct = ((totalAvailableMw - ailForecast) / ailForecast) * 100;

      values.push(`('${fd}', '${tds}', ${he}, ${gasMw.toFixed(2)}, ${windMw.toFixed(2)}, ${solarMw.toFixed(2)}, ${hydroMw.toFixed(2)}, ${storageMw.toFixed(2)}, ${otherMw.toFixed(2)}, ${totalAvailableMw.toFixed(2)}, ${ailForecast.toFixed(2)}, ${clamp(reserveMarginPct, 3, 50).toFixed(2)})`);
    }
  }

  await db.execute(sql.raw(`
    INSERT INTO aeso_7day_capability
      (forecast_date, target_date, hour_ending, gas_mw, wind_mw, solar_mw, hydro_mw, storage_mw, other_mw, total_available_mw, ail_forecast_mw, reserve_margin_pct)
    VALUES ${values.join(",")}
    ON CONFLICT (forecast_date, target_date, hour_ending) DO NOTHING
  `));
  console.log("7-day capability seeded.");
}

async function seedConstraintEvents() {
  console.log("Seeding constraint events...");
  const corridors = [
    "Southern AB Export", "Crowsnest Pass", "Rocky Mountain House",
    "Central AB North-South", "Peace Country South", "Edmonton Metro",
    "Lloydminster Tie", "SK Intertie",
  ];
  const constraintTypes = ["Thermal", "Voltage", "Stability", "Import Limit", "Export Limit"];
  const values: string[] = [];

  let i = 0;
  for (const eventDate of dayRange(2024, 1, 1, 2026, 5, 31)) {
    if (rand() > 0.12) { i++; continue; } // ~12% of days have constraint events
    i++;
    const ds = dateStr(eventDate);
    const numEvents = 1 + Math.floor(rand() * 3);
    for (let e = 0; e < numEvents; e++) {
      const corridor = corridors[Math.floor(rand() * corridors.length)];
      const constraintType = constraintTypes[Math.floor(rand() * constraintTypes.length)];
      const he = 1 + Math.floor(rand() * 24);
      const mwConstrained = clamp(norm(250, 150), 30, 800);
      const costCad = clamp(norm(180000, 120000), 5000, 800000);
      values.push(`('${ds}', ${he}, '${constraintType}', '${corridor}', '${corridor} Corridor', ${mwConstrained.toFixed(2)}, ${costCad.toFixed(2)}, 'Transmission constraint event')`);
    }
    if (values.length > 200) break; // cap at ~200 constraint events
  }

  if (values.length > 0) {
    await db.execute(sql.raw(`
      INSERT INTO aeso_constraint_events (event_date, hour_ending, constraint_type, corridor, facility, mw_constrained, cost_cad, reason)
      VALUES ${values.join(",")}
    `));
  }
  console.log("Constraint events seeded.");
}

async function seedTransmissionCorridors() {
  console.log("Seeding transmission corridors...");
  const corridors = [
    ["Southern AB Export", "Southern AB", "Central AB", 240, 2800, 2600, 2500, 42.3, 380, "Primary export corridor for south AB wind; frequently constrained"],
    ["Crowsnest Pass", "Southern AB", "BC", 138, 600, 580, 550, 28.1, 150, "BC-AB intertie via Crowsnest; import-limited in summer"],
    ["Rocky Mountain House", "Central AB", "Northern AB", 240, 1400, 1350, 1300, 18.5, 120, "N-S backbone; congested during northern gas dispatch"],
    ["Central AB North-South", "Central AB", "Edmonton", 240, 3200, 3100, 3000, 12.4, 85, "Main central trunk; rarely constrained"],
    ["Peace Country South", "Northern AB", "Edmonton", 500, 4200, 4000, 3800, 8.2, 60, "High-voltage Peace country export to Edmonton"],
    ["Edmonton Metro 500kV", "Edmonton", "Central AB", 500, 5500, 5200, 5000, 5.1, 40, "Metro load supply backbone"],
    ["Lloydminster Tie", "Eastern AB", "SK", 138, 400, 380, 360, 15.6, 65, "AB-SK intertie; export-limited in peak wind events"],
    ["SK Intertie 240kV", "Eastern AB", "SK", 240, 900, 860, 830, 22.1, 180, "Expanded SK intertie; used for wind export"],
    ["Battle River Spur", "Central AB", "Eastern AB", 138, 700, 680, 650, 9.3, 45, "Eastern distribution feeder"],
    ["Lacombe-Ponoka", "Central AB", "Central AB", 240, 1100, 1050, 1000, 6.7, 30, "Central load pocket corridor"],
  ];

  const values = corridors.map(([name, from, to, kv, rating, winter, summer, congPct, avgMw, notes]) =>
    `('${name}', '${from}', '${to}', ${kv}, ${rating}, ${winter}, ${summer}, ${congPct}, ${avgMw}, '${notes}')`
  );

  await db.execute(sql.raw(`
    INSERT INTO aeso_transmission_corridors
      (corridor_name, from_region, to_region, voltage_kv, rating_mw, winter_rating_mw, summer_rating_mw, congestion_frequency_pct, avg_constrained_mw, notes)
    VALUES ${values.join(",")}
    ON CONFLICT DO NOTHING
  `));
  console.log("Transmission corridors seeded.");
}

async function main() {
  console.log("Starting AESO seed...");
  await seedPoolPrice();
  // seedQueue() REMOVED 2026-07: it was 100% synthetic (Math.random project
  // names, fake substations, fake dates) — never real AESO data. Real queue
  // data now comes from `pnpm seed-aeso-queue-real`, sourced from AESO's
  // published Connection Project List. Do not re-add a call to seedQueue()
  // here — it would silently overwrite real data with fake data on the next
  // full reseed. The function is left below, unused, for reference only.
  await seedOutages();
  await seedCapability7Day();
  await seedConstraintEvents();
  await seedTransmissionCorridors();
  console.log("\nAESO seed complete!");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
