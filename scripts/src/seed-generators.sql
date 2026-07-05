-- ═══════════════════════════════════════════════════════════════════════════
-- ERCOT Generator Characteristics Seed
-- Sources: EIA Form 860 2024, ERCOT public capacity data, SCED NP3-965 ranges
-- Design heat rates from EIA-860 Schedule 3; startup costs from NP3-965-ER
-- ═══════════════════════════════════════════════════════════════════════════

-- Wipe existing seed (idempotent)
DELETE FROM thermal_params WHERE generator_id IN (SELECT id FROM generators WHERE iso = 'ERCOT');
DELETE FROM generators WHERE iso = 'ERCOT';

-- ── ERCOT Thermal Fleet ───────────────────────────────────────────────────────
INSERT INTO generators (plant_name, operator, asset_class, technology, fuel_primary,
  nameplate_mw, summer_capacity_mw, commissioning_year,
  lat, lng, county, state, iso, load_zone, status)
VALUES
-- ── CCGT — Combined Cycle Gas Turbines ───────────────────────────────────────
('Midlothian Energy Center',      'Luminant Energy',       'THERMAL','CCGT','NG', 1080, 1035, 2001, 32.447, -97.012, 'Ellis',       'TX','ERCOT','LZ_NORTH',   'OPERATING'),
('Wolf Hollow Energy Center',     'Luminant Energy',       'THERMAL','CCGT','NG',  735,  708, 2002, 32.471, -97.577, 'Hood',        'TX','ERCOT','LZ_NORTH',   'OPERATING'),
('Bosque Energy Center',          'Luminant Energy',       'THERMAL','CCGT','NG',  420,  404, 2001, 31.952, -97.563, 'Bosque',      'TX','ERCOT','LZ_NORTH',   'OPERATING'),
('Forney Energy Center',          'NRG Energy',            'THERMAL','CCGT','NG', 1734, 1661, 2002, 32.737, -96.459, 'Kaufman',     'TX','ERCOT','LZ_NORTH',   'OPERATING'),
('Freestone Energy Center',       'Calpine Corp',          'THERMAL','CCGT','NG', 1084, 1040, 2002, 31.743, -96.139, 'Freestone',   'TX','ERCOT','LZ_NORTH',   'OPERATING'),
('Lamar Power Partners',          'EthosEnergy Group',     'THERMAL','CCGT','NG',  570,  547, 2002, 33.641, -95.567, 'Lamar',       'TX','ERCOT','LZ_NORTH',   'OPERATING'),
('Lost Pines Power Park',         'LCRA',                  'THERMAL','CCGT','NG',  505,  484, 2003, 30.196, -97.238, 'Bastrop',     'TX','ERCOT','LZ_SOUTH',   'OPERATING'),
('Guadalupe Power Partners',      'Calpine Corp',          'THERMAL','CCGT','NG', 1000,  960, 2000, 29.687, -98.082, 'Guadalupe',   'TX','ERCOT','LZ_SOUTH',   'OPERATING'),
('Three Oaks Energy Center',      'EDF Renewables',        'THERMAL','CCGT','NG',  786,  754, 2002, 29.413, -99.003, 'Medina',      'TX','ERCOT','LZ_SOUTH',   'OPERATING'),
('CPS Braunig Combined Cycle',    'CPS Energy',            'THERMAL','CCGT','NG',  825,  792, 2003, 29.312, -98.353, 'Bexar',       'TX','ERCOT','LZ_SOUTH',   'OPERATING'),
('Corpus Christi Energy Center',  'AEP Texas',             'THERMAL','CCGT','NG', 1195, 1147, 2001, 27.857, -97.556, 'Nueces',      'TX','ERCOT','LZ_SOUTH',   'OPERATING'),
('Frontera Power Plant',          'InterGen Services',     'THERMAL','CCGT','NG',  550,  528, 2002, 26.140, -97.718, 'Hidalgo',     'TX','ERCOT','LZ_SOUTH',   'OPERATING'),
('Channel Energy Center',         'NRG Energy',            'THERMAL','CCGT','NG',  811,  779, 2002, 29.754, -95.267, 'Harris',      'TX','ERCOT','LZ_HOUSTON', 'OPERATING'),
('WA Parish Combined Cycle',      'NRG Energy',            'THERMAL','CCGT','NG', 1200, 1152, 2002, 29.499, -95.669, 'Fort Bend',   'TX','ERCOT','LZ_HOUSTON', 'OPERATING'),
('Colorado Bend Energy Center',   'Calpine Corp',          'THERMAL','CCGT','NG',  450,  432, 2002, 29.006, -96.419, 'Wharton',     'TX','ERCOT','LZ_HOUSTON', 'OPERATING'),
('Quail Run Energy Center',       'EDP Renewables',        'THERMAL','CCGT','NG',  617,  592, 2002, 31.866, -101.958,'Midland',     'TX','ERCOT','LZ_WEST',    'OPERATING'),
('Odessa-Ector Power Partners',   'J-W Power Company',     'THERMAL','CCGT','NG',  560,  538, 2003, 31.841, -102.368,'Ector',       'TX','ERCOT','LZ_WEST',    'OPERATING'),
-- ── CT — Combustion Turbines / Peakers ───────────────────────────────────────
('Handley Energy Center',         'Luminant Energy',       'THERMAL','CT','NG',  1190, 1142, 1958, 32.742, -97.196, 'Tarrant',     'TX','ERCOT','LZ_NORTH',   'OPERATING'),
('Mountain Creek Energy Center',  'Luminant Energy',       'THERMAL','CT','NG',   884,  848, 1955, 32.756, -97.063, 'Dallas',      'TX','ERCOT','LZ_NORTH',   'OPERATING'),
('Graham Power Plant',            'Luminant Energy',       'THERMAL','CT','NG',   571,  548, 1959, 33.077, -98.536, 'Young',       'TX','ERCOT','LZ_NORTH',   'OPERATING'),
('DFW Power Partners',            'Multiple Operators',    'THERMAL','CT','NG',   350,  336, 2003, 32.903, -97.038, 'Tarrant',     'TX','ERCOT','LZ_NORTH',   'OPERATING'),
('Barney M Davis Power Plant',    'AEP Texas',             'THERMAL','CT','NG',   640,  614, 1974, 27.836, -97.411, 'Nueces',      'TX','ERCOT','LZ_SOUTH',   'OPERATING'),
('JT Deely Power Plant',          'CPS Energy',            'THERMAL','CT','NG',   440,  422, 1977, 29.518, -98.758, 'Bexar',       'TX','ERCOT','LZ_SOUTH',   'OPERATING'),
('Texas Cedar Port Power',        'NRG Energy',            'THERMAL','CT','NG',   420,  403, 2006, 29.733, -95.029, 'Harris',      'TX','ERCOT','LZ_HOUSTON', 'OPERATING'),
('Permian Basin Energy Center',   'Multiple Operators',    'THERMAL','CT','NG',   400,  384, 2005, 31.985, -102.077,'Ector',       'TX','ERCOT','LZ_WEST',    'OPERATING'),
('West Texas Peaker',             'Sharyland Utilities',   'THERMAL','CT','NG',   300,  288, 2004, 32.458, -100.408,'Nolan',       'TX','ERCOT','LZ_WEST',    'OPERATING'),
-- ── STEAM — Coal and Lignite (sub-bituminous / lignite) ──────────────────────
('Limestone Electric Station',    'NRG Energy',            'THERMAL','STEAM','COAL',  1650, 1584, 1985, 31.448, -96.375, 'Leon',     'TX','ERCOT','LZ_NORTH',   'OPERATING'),
('Oak Grove Power Plant',         'Luminant Energy',       'THERMAL','STEAM','LIGNITE',1600, 1536, 2010, 31.378, -96.599, 'Robertson','TX','ERCOT','LZ_NORTH',   'OPERATING'),
('Fayette Power Project',         'LCRA',                  'THERMAL','STEAM','COAL',  1240, 1190, 1979, 29.800, -97.081, 'Fayette',  'TX','ERCOT','LZ_SOUTH',   'OPERATING'),
('San Miguel Electric Station',   'SMEC',                  'THERMAL','STEAM','LIGNITE', 410,  394, 1982, 29.025, -98.476, 'Atascosa', 'TX','ERCOT','LZ_SOUTH',   'OPERATING'),
('WA Parish Steam Units',         'NRG Energy',            'THERMAL','STEAM','COAL',  1274, 1223, 1958, 29.499, -95.669, 'Fort Bend','TX','ERCOT','LZ_HOUSTON', 'OPERATING');


-- ── Thermal Parameters ────────────────────────────────────────────────────────
-- Linked to generators by plant_name match. Fuel hub: Waha (NCEN/SCEN/WEST), HSC/Katy (COAS)
INSERT INTO thermal_params (
  generator_id,
  design_heat_rate, min_load_mw, max_load_mw,
  ramp_rate_mw_min, ramp_rate_emergency_mw_min,
  startup_cost_cold, startup_cost_warm, startup_cost_hot,
  startup_time_cold_h,
  vom_per_mwh, fuel_hub,
  co2_rate_tons_mwh, forced_outage_rate, planned_outage_days,
  implied_fuel_cost_per_mmb
)
SELECT g.id,
  p.design_heat_rate, p.min_load_mw, p.max_load_mw,
  p.ramp_rate_mw_min, p.ramp_rate_emergency_mw_min,
  p.startup_cost_cold, p.startup_cost_warm, p.startup_cost_hot,
  p.startup_time_cold_h,
  p.vom_per_mwh, p.fuel_hub,
  p.co2_rate_tons_mwh, p.forced_outage_rate, p.planned_outage_days,
  p.implied_fuel_cost_per_mmb
FROM generators g
JOIN (VALUES
  -- ── CCGT params ─────────────────────────────────────────────────────────────
  --  plant_name                         HR    minMW maxMW ramp  remg  cold$     warm$     hot$      coldH vom   hub          co2    efor  outDays fuelCost
  ('Midlothian Energy Center',          6.80, 324,  1028, 9.0,  12.0, 102600,  61560,  30780,   8.0,  4.50, 'WAHA',     0.3950, 0.048, 25,  NULL),
  ('Wolf Hollow Energy Center',         7.10, 221,   699, 6.0,   8.5,  66150,  39690,  19845,   8.5,  4.75, 'WAHA',     0.4120, 0.051, 22,  NULL),
  ('Bosque Energy Center',              7.20, 126,   399, 3.5,   5.0,  37800,  22680,  11340,   9.0,  4.60, 'WAHA',     0.4180, 0.053, 20,  NULL),
  ('Forney Energy Center',              6.65, 520,  1648, 14.0, 19.0, 156060, 93636,  46818,   7.5,  4.25, 'WAHA',     0.3860, 0.045, 28,  NULL),
  ('Freestone Energy Center',           6.90, 325,  1030,  8.7,  12.0,  97560,  58536,  29268,   8.2,  4.40, 'WAHA',     0.4005, 0.049, 24,  NULL),
  ('Lamar Power Partners',              7.30, 171,   542,  4.8,   6.5,  51300,  30780,  15390,   9.0,  4.80, 'WAHA',     0.4240, 0.055, 21,  NULL),
  ('Lost Pines Power Park',             7.15, 152,   480,  4.2,   5.5,  45450,  27270,  13635,   8.8,  4.65, 'WAHA',     0.4150, 0.052, 22,  NULL),
  ('Guadalupe Power Partners',          6.95, 300,   950,  8.0,  11.0,  90000,  54000,  27000,   8.0,  4.50, 'WAHA',     0.4035, 0.047, 25,  NULL),
  ('Three Oaks Energy Center',          7.05, 236,   747,  6.3,   8.8,  70740,  42444,  21222,   8.5,  4.65, 'WAHA',     0.4095, 0.050, 22,  NULL),
  ('CPS Braunig Combined Cycle',        7.15, 248,   784,  6.9,   9.5,  74250,  44550,  22275,   8.5,  4.70, 'WAHA',     0.4150, 0.051, 23,  NULL),
  ('Corpus Christi Energy Center',      6.85, 359,  1136,  9.6,  13.0, 107550,  64530,  32265,   8.0,  4.35, 'WAHA',     0.3975, 0.047, 26,  NULL),
  ('Frontera Power Plant',              7.20, 165,   523,  4.6,   6.2,  49500,  29700,  14850,   9.0,  4.70, 'WAHA',     0.4180, 0.052, 21,  NULL),
  ('Channel Energy Center',             7.00, 243,   771,  6.7,   9.3,  72990,  43794,  21897,   8.2,  4.55, 'HSC',      0.4065, 0.049, 24,  NULL),
  ('WA Parish Combined Cycle',          7.25, 360,  1140,  9.0,  12.5, 108000,  64800,  32400,   9.0,  4.80, 'HSC',      0.4210, 0.052, 26,  NULL),
  ('Colorado Bend Energy Center',       7.10, 135,   428,  3.8,   5.2,  40500,  24300,  12150,   8.5,  4.55, 'HSC',      0.4120, 0.050, 21,  NULL),
  ('Quail Run Energy Center',           7.40, 185,   586,  5.1,   7.0,  55530,  33318,  16659,   9.5,  4.90, 'WAHA',     0.4295, 0.055, 20,  NULL),
  ('Odessa-Ector Power Partners',       7.50, 168,   532,  4.7,   6.5,  50400,  30240,  15120,   9.5,  5.00, 'WAHA',     0.4355, 0.056, 20,  NULL),
  -- ── CT params ───────────────────────────────────────────────────────────────
  --  plant_name                         HR    minMW maxMW ramp  remg  cold$     warm$     hot$      coldH vom   hub          co2    efor  outDays fuelCost
  ('Handley Energy Center',             10.80, 238, 1131, 14.0, 20.0,  35700,  21420,  10710,   3.0,  7.00, 'WAHA',     0.6270, 0.068, 14,  NULL),
  ('Mountain Creek Energy Center',      11.20, 177,  840, 11.6, 16.5,  26520,  15912,   7956,   3.5,  7.50, 'WAHA',     0.6500, 0.071, 13,  NULL),
  ('Graham Power Plant',                11.50, 114,  543, 7.4,  10.8,  17130,  10278,   5139,   4.0,  7.20, 'WAHA',     0.6675, 0.069, 12,  NULL),
  ('DFW Power Partners',                 9.80,  70,  333, 8.8,  13.5,  10500,   6300,   3150,   2.5,  5.80, 'WAHA',     0.5690, 0.062, 10,  NULL),
  ('Barney M Davis Power Plant',        10.80, 128,  608, 8.0,  12.0,  19200,  11520,   5760,   3.5,  6.80, 'WAHA',     0.6270, 0.067, 12,  NULL),
  ('JT Deely Power Plant',              10.50,  88,  418, 5.8,   8.5,  13200,   7920,   3960,   3.5,  6.50, 'WAHA',     0.6095, 0.065, 11,  NULL),
  ('Texas Cedar Port Power',            10.20,  84,  399, 12.0, 18.0,  12600,   7560,   3780,   2.0,  6.20, 'HSC',      0.5920, 0.060, 11,  NULL),
  ('Permian Basin Energy Center',       10.00,  80,  380, 12.0, 18.0,  12000,   7200,   3600,   2.0,  6.00, 'WAHA',     0.5805, 0.063, 10,  NULL),
  ('West Texas Peaker',                 10.50,  60,  285,  9.0, 14.0,   9000,   5400,   2700,   2.5,  6.50, 'WAHA',     0.6095, 0.065, 10,  NULL),
  -- ── Steam / Coal params ──────────────────────────────────────────────────────
  --  plant_name                         HR    minMW maxMW ramp  remg  cold$       warm$      hot$       coldH vom  hub                co2    efor  outDays fuelCost(coal)
  ('Limestone Electric Station',        10.80, 743, 1568,  3.0,  4.5, 297000, 148500,  74250,  24.0,  2.50, 'COAL_POWDER_RIVER', 1.0850, 0.095, 38,  2.20),
  ('Oak Grove Power Plant',             11.50, 720, 1520,  2.5,  3.5, 288000, 144000,  72000,  36.0,  2.20, 'COAL_LIGNITE_TX',   1.0500, 0.082, 32,  1.80),
  ('Fayette Power Project',             11.20, 558, 1178,  2.5,  3.5, 223200, 111600,  55800,  28.0,  2.40, 'COAL_POWDER_RIVER', 1.0640, 0.091, 40,  2.10),
  ('San Miguel Electric Station',       13.20, 185,  390,  1.8,  2.5,  73800,  36900,  18450,  48.0,  1.80, 'COAL_LIGNITE_TX',   1.0150, 0.088, 35,  1.50),
  ('WA Parish Steam Units',             11.80, 573, 1211,  2.8,  4.0, 229320, 114660,  57330,  30.0,  2.30, 'COAL_POWDER_RIVER', 1.0950, 0.098, 42,  2.15)
) AS p(plant_name, design_heat_rate, min_load_mw, max_load_mw,
       ramp_rate_mw_min, ramp_rate_emergency_mw_min,
       startup_cost_cold, startup_cost_warm, startup_cost_hot,
       startup_time_cold_h, vom_per_mwh, fuel_hub,
       co2_rate_tons_mwh, forced_outage_rate, planned_outage_days,
       implied_fuel_cost_per_mmb)
  ON g.plant_name = p.plant_name
WHERE g.iso = 'ERCOT';
