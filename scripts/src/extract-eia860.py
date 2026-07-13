import zipfile, openpyxl, io, csv, os

ZIP_PATH = '/tmp/eia8602025ER.zip'
OUT_PATH = '/home/runner/workspace/scripts/data/candidates-seed.csv'

BA_TO_MARKET = {'ERCO': 'ERCOT', 'CISO': 'CAISO', 'PJM': 'PJM'}

TECH_TO_ASSET = {
    'Solar Photovoltaic':                       'solar',
    'Solar Thermal without Energy Storage':     'solar',
    'Solar Thermal with Energy Storage':        'solar_storage',
    'Onshore Wind Turbine':                     'wind',
    'Offshore Wind Turbine':                    'wind',
    'Batteries':                                'storage',
    'Hydroelectric Pumped Storage':             'storage',
    'Flywheels':                                'storage',
    'Conventional Hydroelectric':               'hydro',
    'Natural Gas Fired Combined Cycle':         'natural_gas',
    'Natural Gas Fired Combustion Turbine':     'natural_gas',
    'Natural Gas Steam Turbine':                'natural_gas',
    'Natural Gas Internal Combustion Engine':   'natural_gas',
    'Other Natural Gas':                        'natural_gas',
    'Other Gases':                              'natural_gas',
    'Combined Cycle Steam Part':                'natural_gas',
    'Combined Cycle Combustion Turbine Part':   'natural_gas',
    'Nuclear':                                  'nuclear',
    'Wood/Wood Waste Biomass':                  'biomass',
    'Landfill Gas':                             'biomass',
    'Other Waste Biomass':                      'biomass',
    'Municipal Solid Waste':                    'biomass',
    'Agricultural Crop Residue':                'biomass',
    'Geothermal':                               'geothermal',
}

# Skip: Petroleum Liquids, Petroleum Coke, Conventional Steam Coal,
#        Coal Integrated Gasification Combined Cycle, All Other

print("Loading plant data...")
z = zipfile.ZipFile(ZIP_PATH)
plants = {}  # plant_code → {plant_name, state, county, lat, lon, ba_code}
with z.open('2___Plant_Y2025_Early_Release.xlsx') as f:
    wb = openpyxl.load_workbook(io.BytesIO(f.read()), read_only=True, data_only=True)
    ws = wb.active
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i < 3: continue          # row 0=disclaimer, 1=title, 2=col headers
        plant_code = row[2]
        if plant_code is None: continue
        plants[plant_code] = {
            'plant_name': str(row[3] or '').strip(),
            'state':      str(row[6] or '').strip(),
            'county':     str(row[8] or '').strip(),
            'lat':        row[9],
            'lon':        row[10],
            'ba_code':    str(row[12] or '').strip(),
        }
print(f"  Loaded {len(plants)} plants")

print("Extracting generators...")
rows_out = []
seen_names = {}   # plant_code → count, for dedup suffix

with z.open('3_1_Generator_Y2025_Early_Release.xlsx') as f:
    wb = openpyxl.load_workbook(io.BytesIO(f.read()), read_only=True, data_only=True)
    ws = wb.active
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i < 3: continue
        plant_code = row[2]
        if plant_code is None: continue
        plant = plants.get(plant_code)
        if not plant: continue

        ba = plant['ba_code']
        market = BA_TO_MARKET.get(ba)
        if not market: continue

        status = row[23]
        if status != 'OP': continue

        mw = row[15]
        if mw is None: continue
        try:
            mw_f = float(mw)
        except:
            continue
        if mw_f < 1.0: continue

        tech = str(row[7] or '').strip()
        asset_type = TECH_TO_ASSET.get(tech)
        if not asset_type: continue   # petroleum/coal/all-other → skip

        gen_id    = str(row[6] or '').strip()
        plant_name = plant['plant_name']
        op_year   = row[26]

        # Name: plant name; append gen ID if plant has multiple generators
        seen_names[plant_code] = seen_names.get(plant_code, 0) + 1
        name = f"{plant_name}" if not gen_id else f"{plant_name} ({gen_id})"

        rows_out.append({
            'name':                  name,
            'market':                market,
            'asset_type':            asset_type,
            'status':                'active',
            'capacity_mw':           round(mw_f, 2),
            'latitude':              round(float(plant['lat']), 6) if plant['lat'] is not None else '',
            'longitude':             round(float(plant['lon']), 6) if plant['lon'] is not None else '',
            'county':                plant['county'],
            'state':                 plant['state'],
            'interconnection_node':  '',
            'pricing_hub_node':      '',
            'estimated_lcoe':        '',
            'offtake_price_mwh':     '',
            'overall_score':         '',
            'price_score':           '',
            'location_score':        '',
            'curtailment_score':     '',
            'interconnection_score': '',
            'regulatory_score':      '',
            'financial_score':       '',
            'environmental_score':   '',
            'grid_stability_score':  '',
            'demand_proximity_score': '',
            'development_risk_score': '',
            'commissioning_year':    int(op_year) if op_year else '',
        })

print(f"\nTotal qualifying generators: {len(rows_out)}")
from collections import Counter
mkt = Counter(r['market'] for r in rows_out)
atype = Counter(r['asset_type'] for r in rows_out)
print("By market:", dict(mkt))
print("By asset type:", dict(atype.most_common()))

# Back up old CSV
backup = OUT_PATH.replace('.csv', '_2024_backup.csv')
if os.path.exists(OUT_PATH) and not os.path.exists(backup):
    os.rename(OUT_PATH, backup)
    print(f"\nBacked up old CSV to {backup}")

fieldnames = list(rows_out[0].keys())
with open(OUT_PATH, 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=fieldnames)
    w.writeheader()
    w.writerows(rows_out)

print(f"Written {len(rows_out)} rows to {OUT_PATH}")
