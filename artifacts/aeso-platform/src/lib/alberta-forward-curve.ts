/* ══════════════════════════════════════════════════════════════════════════
   Alberta forward power + AECO gas curve — single source of truth.

   Consumed by BOTH the AECO Gas tab (which displays it) and the DCF
   Valuation tab (which discounts against it). Previously this lived only in
   aeco-gas.tsx, so the DCF ran off a flat typed pool price while the app
   simultaneously displayed a real forward curve two tabs over. That
   inconsistency is the reason this module exists.

   SOURCE AND ITS LIMITS — read before relying on a number
   --------------------------------------------------------------------------
   TC Energy "Alberta Power Market Update", indicative as of 14 July 2026:
   https://www.tcenergy.com/siteassets/pdfs/power/alberta-power-marketing/power-market-updates/2026/tce-market-update-july-2026.pdf

   This is an INDICATIVE marketer curve published in a PDF — it is not a
   tradable quote, not a settlement price, and not updated on any schedule we
   control. It is the best free, citable Alberta forward source available.
   The tradable curve is ICE NGX (AESO flat power = XCU; AB-NIT gas forwards =
   XW7/XW6), which is proprietary: terminal access does NOT convey the right
   to redistribute or display those values in a customer-facing product. That
   licensing question must be settled separately before wiring ICE in.

   Alberta MSA's Q1 2026 Wholesale Market Report independently quotes a
   calendar strip (Cal-27 $47.88, Cal-28 $59.07, Cal-29 $63.62) — regulator-
   grade corroboration that the TC Energy Cal-27/28/29 numbers are in the
   right neighbourhood, though the two sources are struck at different dates
   and will not tie exactly.

   Beyond Cal-2029 there is no published curve. extendCurve() below holds the
   last observed year flat rather than extrapolating a trend — a flat hold is
   an assumption you can state and defend; a fitted trend out to year 30 is a
   fabrication that compounds.
   ══════════════════════════════════════════════════════════════════════════ */

export interface ForwardRow {
  period: string;
  flat: number;      // 7x24 flat power, C$/MWh
  onPeak: number;    // 7x16, C$/MWh
  offPeak: number;   // 7x8, C$/MWh
  gasGj: number;     // AECO gas, C$/GJ
  heatRate: number;  // implied market heat rate, GJ/MWh
}

export const TC_FORWARD_AS_OF = "2026-07-14";
export const TC_FORWARD_SOURCE =
  "TC Energy Alberta Power Market Update, indicative as of 14 July 2026";
export const TC_FORWARD_URL =
  "https://www.tcenergy.com/siteassets/pdfs/power/alberta-power-marketing/power-market-updates/2026/tce-market-update-july-2026.pdf";

export const TC_FORWARD: ForwardRow[] = [
  { period: "Balance of month", flat: 43.12, onPeak: 53.20, offPeak: 22.96, gasGj: 1.67, heatRate: 25.82 },
  { period: "August 2026",      flat: 44.00, onPeak: 56.65, offPeak: 27.96, gasGj: 1.53, heatRate: 28.84 },
  { period: "Balance of 2026",  flat: 42.75, onPeak: 52.65, offPeak: 30.33, gasGj: 1.94, heatRate: 22.00 },
  { period: "Calendar 2027",    flat: 46.61, onPeak: 56.40, offPeak: 34.10, gasGj: 2.24, heatRate: 20.80 },
  { period: "Calendar 2028",    flat: 65.38, onPeak: 83.60, offPeak: 42.27, gasGj: 2.44, heatRate: 26.82 },
  { period: "Calendar 2029",    flat: 80.88, onPeak: 105.87,offPeak: 48.98, gasGj: 2.47, heatRate: 32.73 },
];

// MSA Wholesale Market Report Q1 2026 — quarter-end calendar strip, stated
// as % change over the quarter (source's own framing, not derived here).
export const MSA_CAL_STRIP = [
  { label: "Cal-27", price: 47.88, qoq: -18 },
  { label: "Cal-28", price: 59.07, qoq: -20 },
  { label: "Cal-29", price: 63.62, qoq: -18 },
];

/** Calendar-year rows only, keyed by year — the annual strip usable in a DCF. */
export const FORWARD_BY_YEAR: Record<number, ForwardRow> = {
  2027: TC_FORWARD[3],
  2028: TC_FORWARD[4],
  2029: TC_FORWARD[5],
};

/** First and last calendar years the published curve actually covers. */
export const CURVE_FIRST_YEAR = 2027;
export const CURVE_LAST_YEAR = 2029;

export interface CurveYear {
  /** Project year, 1-indexed from COD. */
  year: number;
  /** Calendar year this maps to. */
  calendarYear: number;
  /** Flat 7x24 power, C$/MWh. */
  power: number;
  /** AECO gas, C$/GJ. */
  gas: number;
  /** True when this year is inside the published curve; false when held flat. */
  observed: boolean;
}

/**
 * Build a year-by-year power and gas path for a project of `lifeYears`
 * starting at `codYear`.
 *
 * Inside the published window (2027-2029) it uses the actual curve. Past the
 * end of the curve it HOLDS THE LAST OBSERVED YEAR FLAT and marks those years
 * observed:false, optionally escalating at `postCurveEscalationPct` if the
 * caller explicitly wants a stated escalation assumption rather than a hold.
 *
 * Years before the curve starts (a COD in 2026) use the balance-of-2026 row.
 */
export function buildCurvePath(
  codYear: number,
  lifeYears: number,
  postCurveEscalationPct = 0,
): CurveYear[] {
  const balOf2026 = TC_FORWARD[2];
  const last = FORWARD_BY_YEAR[CURVE_LAST_YEAR];
  const out: CurveYear[] = [];

  for (let y = 1; y <= lifeYears; y++) {
    const cal = codYear + y - 1;

    if (cal < CURVE_FIRST_YEAR) {
      out.push({ year: y, calendarYear: cal, power: balOf2026.flat, gas: balOf2026.gasGj, observed: true });
      continue;
    }
    const row = FORWARD_BY_YEAR[cal];
    if (row) {
      out.push({ year: y, calendarYear: cal, power: row.flat, gas: row.gasGj, observed: true });
      continue;
    }
    // Past the end of the published curve.
    const yearsPast = cal - CURVE_LAST_YEAR;
    const esc = Math.pow(1 + postCurveEscalationPct / 100, yearsPast);
    out.push({
      year: y, calendarYear: cal,
      power: last.flat * esc,
      gas: last.gasGj * esc,
      observed: false,
    });
  }
  return out;
}

/** Simple average flat power over the published calendar strip — a headline number. */
export function curveStripAverage(): number {
  const rows = Object.values(FORWARD_BY_YEAR);
  return rows.reduce((a, r) => a + r.flat, 0) / rows.length;
}
