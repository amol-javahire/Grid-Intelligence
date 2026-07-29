/* ══════════════════════════════════════════════════════════════════════════
   Alberta natural gas — monthly historical price series.

   SOURCE
   --------------------------------------------------------------------------
   Government of Alberta, Energy and Minerals — "Alberta natural gas reference
   price", monthly, C$/GJ.
   https://www.alberta.ca/alberta-natural-gas-reference-price

   Official, free, and published monthly back to 1994 (with an average-market-
   price series before that). This is the series the province itself uses to
   value Crown royalty volumes.

   WHAT THIS IS *NOT* — read before comparing to a traded quote
   --------------------------------------------------------------------------
   The Reference Price is a ROYALTY VALUATION price, computed with a simplified
   netback model from NGX Alberta Market Hub purchase prices. It is NOT the
   AECO-C spot settle, and it is NOT the same number as an ICE NGX AB-NIT
   index. Netback treatment means it sits BELOW a raw hub price by roughly the
   transportation and processing allowances of the period.

   It is used here because:
     · it is free and redistributable (a provincial Official Statistic),
     · it is monthly, consistent, and runs 30+ years without gaps, and
     · ICE NGX — the actual traded AECO benchmark — is proprietary, and
       terminal access does not convey the right to display it in a product.

   So: correct for trend, seasonality, and order of magnitude. Do not quote a
   number off this chart as "the AECO price" on a given day.

   MAINTENANCE
   --------------------------------------------------------------------------
   Alberta posts one new figure per month. Appending it is a one-line edit to
   GAS_REFERENCE_MONTHLY below. There is no API — the province publishes an
   HTML table plus per-month PDFs, so this is deliberately a static table
   rather than a scraper that would silently break.
   Last figure below: April 2026.
   ══════════════════════════════════════════════════════════════════════════ */

export const GAS_SOURCE_NAME =
  "Government of Alberta — Alberta natural gas reference price (royalty netback, C$/GJ)";
export const GAS_SOURCE_URL = "https://www.alberta.ca/alberta-natural-gas-reference-price";

/** Jan-indexed monthly reference price, C$/GJ. Empty slots = not yet published. */
const GAS_REFERENCE_MONTHLY: Record<number, (number | null)[]> = {
  2026: [2.46, 1.95, 1.69, 1.28, null, null, null, null, null, null, null, null],
  2025: [1.62, 1.75, 1.64, 1.79, 1.65, 1.05, 0.90, 0.61, 0.50, 0.95, 2.04, 2.71],
  2024: [2.63, 1.73, 1.48, 1.25, 1.01, 0.78, 0.64, 0.53, 0.43, 0.66, 1.33, 1.62],
  2023: [4.55, 3.24, 2.72, 2.24, 2.00, 1.94, 1.93, 2.24, 2.25, 2.07, 2.30, 2.04],
  2022: [3.88, 4.26, 4.26, 5.22, 5.97, 6.53, 5.44, 3.55, 4.00, 3.53, 5.12, 5.65],
  2021: [2.32, 3.00, 2.54, 2.33, 2.56, 2.78, 3.17, 2.78, 3.15, 4.01, 4.57, 3.99],
  2020: [2.06, 1.79, 1.60, 1.56, 1.66, 1.65, 1.62, 1.85, 2.00, 1.99, 2.58, 2.41],
  2019: [1.55, 2.10, 1.99, 0.91, 1.22, 0.55, 0.87, 0.82, 0.76, 1.63, 2.19, 2.22],
  2018: [1.74, 1.76, 1.54, 1.26, 0.78, 0.75, 1.14, 0.94, 1.03, 1.21, 1.59, 1.69],
  2017: [2.86, 2.39, 2.20, 2.34, 2.46, 2.39, 1.83, 1.72, 1.20, 1.11, 1.92, 1.82],
  2016: [2.11, 1.82, 1.36, 1.11, 0.94, 1.23, 1.82, 1.82, 2.12, 2.41, 2.48, 2.75],
  2015: [2.83, 2.51, 2.53, 2.30, 2.33, 2.36, 2.38, 2.56, 2.55, 2.40, 2.21, 2.12],
  2014: [3.61, 5.20, 4.90, 4.21, 4.21, 4.17, 3.98, 3.63, 3.64, 3.57, 3.47, 3.39],
  2013: [2.76, 2.69, 2.85, 3.14, 3.24, 3.17, 2.78, 2.37, 2.14, 2.49, 3.06, 3.22],
  2012: [2.56, 2.13, 1.83, 1.63, 1.58, 1.75, 1.92, 2.05, 1.94, 2.36, 2.90, 2.98],
  2011: [3.49, 3.40, 3.19, 3.30, 3.39, 3.51, 3.42, 3.32, 3.14, 3.17, 2.99, 2.92],
  2010: [4.88, 4.68, 4.05, 3.26, 3.37, 3.49, 3.42, 3.25, 3.14, 2.92, 3.04, 3.34],
  2009: [5.77, 4.66, 4.01, 3.41, 3.13, 2.97, 2.94, 2.72, 2.48, 3.40, 3.77, 4.51],
  2008: [6.18, 6.72, 7.52, 8.11, 8.92, 9.81, 9.84, 7.35, 6.28, 6.27, 6.26, 6.36],
  2007: [6.27, 6.82, 6.92, 6.74, 6.61, 6.21, 5.43, 4.81, 4.42, 4.96, 5.54, 5.85],
  2006: [9.52, 7.38, 6.47, 6.18, 5.71, 5.29, 5.22, 5.84, 5.12, 4.40, 6.51, 7.05],
  2005: [6.02, 5.94, 6.30, 6.79, 6.51, 6.34, 6.87, 7.45, 9.46, 11.38, 10.81, 10.54],
  2004: [6.10, 5.83, 5.49, 5.64, 6.28, 6.47, 6.17, 5.99, 5.21, 5.29, 6.58, 6.70],
  2003: [5.88, 6.83, 8.94, 5.88, 5.73, 5.93, 5.58, 5.08, 5.19, 4.92, 4.60, 5.11],
  2002: [3.71, 2.71, 3.23, 3.91, 3.91, 3.54, 3.17, 2.93, 3.51, 4.27, 4.85, 4.94],
  2001: [11.21, 8.05, 6.48, 6.59, 5.74, 4.44, 3.75, 3.53, 2.76, 2.40, 3.33, 3.20],
  2000: [2.50, 2.62, 2.72, 3.10, 3.35, 4.33, 4.42, 3.93, 4.66, 5.53, 5.79, 8.28],
  1999: [2.04, 1.90, 1.80, 1.90, 2.21, 2.22, 2.33, 2.60, 2.86, 2.72, 3.06, 2.54],
  1998: [1.80, 1.73, 1.71, 1.84, 1.84, 1.71, 1.83, 1.78, 1.56, 1.86, 2.19, 2.22],
  1997: [2.77, 2.28, 1.39, 1.44, 1.57, 1.65, 1.59, 1.57, 1.73, 2.07, 2.37, 1.95],
  1996: [1.62, 1.61, 1.60, 1.51, 1.41, 1.37, 1.38, 1.38, 1.20, 1.28, 1.79, 2.36],
  1995: [1.39, 1.25, 1.20, 1.19, 1.25, 1.27, 1.10, 1.07, 1.20, 1.25, 1.29, 1.39],
  1994: [1.93, 2.04, 2.07, 1.82, 1.80, 1.66, 1.73, 1.66, 1.50, 1.35, 1.53, 1.56],
};

export interface GasMonth {
  /** YYYY-MM */
  month: string;
  year: number;
  monthNum: number;
  gasGj: number;
}

/** Flat, newest-first list of every published month. */
export const GAS_HISTORY: GasMonth[] = Object.entries(GAS_REFERENCE_MONTHLY)
  .flatMap(([yr, months]) =>
    months
      .map((v, idx) =>
        v == null ? null : {
          month: `${yr}-${String(idx + 1).padStart(2, "0")}`,
          year: Number(yr),
          monthNum: idx + 1,
          gasGj: v,
        },
      )
      .filter((x): x is GasMonth => x !== null),
  )
  .sort((a, b) => b.month.localeCompare(a.month));

/** Lookup by "YYYY-MM". */
export const GAS_BY_MONTH: Record<string, number> = Object.fromEntries(
  GAS_HISTORY.map((g) => [g.month, g.gasGj]),
);

export const GAS_HISTORY_FIRST_MONTH = GAS_HISTORY[GAS_HISTORY.length - 1]?.month ?? "";
export const GAS_HISTORY_LAST_MONTH = GAS_HISTORY[0]?.month ?? "";

/**
 * Implied market heat rate for a month, GJ/MWh: pool price ÷ gas price.
 * A high number means power is expensive relative to gas (scarcity, outages,
 * low renewables); a low number means gas-on-the-margin economics dominate.
 */
export function impliedHeatRate(poolPrice: number, gasGj: number): number | null {
  if (!gasGj || gasGj <= 0) return null;
  return poolPrice / gasGj;
}
