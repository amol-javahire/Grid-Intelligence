#!/usr/bin/env python3
"""
ERCOT Hourly CDR Extractor — raw ZIP + cElementTree iterparse version.
Bypasses openpyxl; reads XLSX XML directly for ~5-10x speed vs openpyxl.
Outputs CSV to /tmp/ercot_hourly_data.csv for psql COPY ingestion.
"""

import sys
import os
import csv
import zipfile
import re
from collections import defaultdict
from xml.etree import cElementTree as ET
from multiprocessing import Pool

OUT_PATH   = '/tmp/ercot_hourly_data.csv'
CACHE_DIR  = '/tmp/ercot-hourly-cache'
NUM_WORKERS = 6

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

HUB_ZONE_NODES = {
    'HB_BUSAVG','HB_HOUSTON','HB_HUBAVG','HB_NORTH','HB_PAN','HB_SOUTH','HB_WEST',
    'LZ_AEN','LZ_CPS','LZ_HOUSTON','LZ_LCRA','LZ_NORTH','LZ_RAYBN','LZ_SOUTH','LZ_WEST',
}
MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

def node_type(sp):
    return 'hub' if sp.startswith('HB_') else 'load_zone'

_EXCEL_EPOCH = None

def parse_hour(val):
    """Parse hour from int, float string, or 'HH:MM' string."""
    if val is None:
        return None
    s = str(val)
    if ':' in s:
        try:
            return int(s.split(':')[0])
        except ValueError:
            pass
    try:
        return int(float(s))
    except (ValueError, TypeError):
        pass
    return None

def parse_date(val):
    global _EXCEL_EPOCH
    if val is None:
        return None, None, None
    s = str(val)
    # String format: MM/DD/YYYY
    if '/' in s:
        parts = s.split('/')
        if len(parts) == 3:
            try:
                return int(parts[2]), int(parts[0]), int(parts[1])
            except ValueError:
                pass
    # Excel serial date (numeric): days since Dec 30, 1899
    try:
        n = float(s)
        if 35000 < n < 60000:  # Plausible date range (1995-2064)
            from datetime import date, timedelta
            if _EXCEL_EPOCH is None:
                _EXCEL_EPOCH = date(1899, 12, 30)
            d = _EXCEL_EPOCH + timedelta(days=int(n))
            return d.year, d.month, d.day
    except (ValueError, TypeError):
        pass
    return None, None, None

def load_shared_strings(zf):
    try:
        with zf.open('xl/sharedStrings.xml') as f:
            tree = ET.parse(f)
        result = []
        for si in tree.iter(f'{{{NS}}}si'):
            parts = [t.text or '' for t in si.iter(f'{{{NS}}}t')]
            result.append(''.join(parts))
        return result
    except KeyError:
        return []

def load_sheet_map(zf):
    """Returns dict: sheet_name -> xml_path inside zip."""
    with zf.open('xl/workbook.xml') as f:
        wb = ET.parse(f)
    name_to_rid = {}
    for s in wb.iter(f'{{{NS}}}sheet'):
        name = s.get('name', '')
        rid = s.get(f'{{{REL_NS}}}id') or s.get('r:id')
        if name and rid:
            name_to_rid[name] = rid
    # Also try without namespace (some xlsx)
    if not name_to_rid:
        for s in wb.iter():
            if s.tag.endswith('}sheet') or s.tag == 'sheet':
                name = s.get('name', '')
                rid = None
                for k, v in s.attrib.items():
                    if k.endswith('}id') or k == 'r:id':
                        rid = v
                if name and rid:
                    name_to_rid[name] = rid

    try:
        with zf.open('xl/_rels/workbook.xml.rels') as f:
            rels = ET.parse(f)
    except KeyError:
        with zf.open('xl/workbook.xml.rels') as f:
            rels = ET.parse(f)

    rid_to_path = {}
    for rel in rels.iter():
        if rel.tag.endswith('}Relationship') or rel.tag == 'Relationship':
            rid = rel.get('Id', '')
            target = rel.get('Target', '')
            if target:
                rid_to_path[rid] = 'xl/' + target.lstrip('/')

    return {name: rid_to_path.get(rid, '') for name, rid in name_to_rid.items() if rid in rid_to_path}

def parse_sheet_xml(zf, xml_path, shared_strings, hub_zone_indices, is_rtm):
    """
    Stream-parse one worksheet XML.
    RTM columns: A=date, B=hour, C=_, D=dst_flag, E=sp, F=_, G=price
    DAM columns: A=date, B=hour, C=dst_flag, D=sp, E=price
    Returns dict: key(sp,yr,mo,dy,hr) -> list of prices (RTM) or price (DAM)
    """
    COL_MAP = {'A':0,'B':1,'C':2,'D':3,'E':4,'F':5,'G':6}

    result = defaultdict(list) if is_rtm else {}

    with zf.open(xml_path) as f:
        row_data = [None]*8  # indexed by COL_MAP
        in_row = False
        cur_col_idx = -1
        cur_type = 'n'

        for event, elem in ET.iterparse(f, events=('start','end')):
            if event == 'start':
                if elem.tag == f'{{{NS}}}row':
                    row_data = [None]*8
                    in_row = True
                elif elem.tag == f'{{{NS}}}c' and in_row:
                    ref = elem.get('r','')
                    col_letter = ref.rstrip('0123456789')
                    cur_col_idx = COL_MAP.get(col_letter, -1)
                    cur_type = elem.get('t','n')
            elif event == 'end':
                if elem.tag == f'{{{NS}}}v' and cur_col_idx >= 0:
                    raw = elem.text
                    if cur_type == 's' and raw is not None:
                        idx = int(raw)
                        row_data[cur_col_idx] = shared_strings[idx] if idx < len(shared_strings) else None
                    else:
                        row_data[cur_col_idx] = raw
                    elem.clear()
                elif elem.tag == f'{{{NS}}}t' and cur_type == 'inlineStr' and cur_col_idx >= 0:
                    row_data[cur_col_idx] = elem.text
                elif elem.tag == f'{{{NS}}}row' and in_row:
                    in_row = False
                    elem.clear()
                    # Process row
                    if is_rtm:
                        # A=date, B=hour, C=_, D=dst_flag, E=sp, F=_, G=price
                        date_val = row_data[0]
                        hour_raw = row_data[1]
                        dst_flag = row_data[3]
                        sp       = row_data[4]
                        price_raw= row_data[6]
                    else:
                        # A=date, B=hour, C=dst_flag, D=sp, E=price
                        date_val = row_data[0]
                        hour_raw = row_data[1]
                        dst_flag = row_data[2]
                        sp       = row_data[3]
                        price_raw= row_data[4]

                    if dst_flag == 'Y' or not sp or sp not in HUB_ZONE_NODES:
                        continue
                    if price_raw is None or date_val is None:
                        continue
                    hour = parse_hour(hour_raw)
                    if hour is None:
                        continue
                    try:
                        price_f = float(price_raw)
                    except (TypeError, ValueError):
                        continue
                    yr, mo, dy = parse_date(date_val)
                    if yr is None:
                        continue
                    key = (sp, yr, mo, dy, hour)
                    if is_rtm:
                        result[key].append(price_f)
                    else:
                        result[key] = price_f

    return dict(result)

def _worker(args):
    xlsx_path, month_name, is_rtm = args
    try:
        with zipfile.ZipFile(xlsx_path, 'r') as zf:
            shared = load_shared_strings(zf)
            hub_idx = {i for i, s in enumerate(shared) if s in HUB_ZONE_NODES}
            smap = load_sheet_map(zf)
            xml_path = smap.get(month_name)
            if not xml_path:
                sys.stderr.write(f"  sheet '{month_name}' not found in {os.path.basename(xlsx_path)}\n")
                return {}
            result = parse_sheet_xml(zf, xml_path, shared, HUB_ZONE_NODES, is_rtm)
            tag = 'RTM' if is_rtm else 'DAM'
            sys.stderr.write(f"  ✓ {tag} {month_name}: {len(result)} keys\n")
            sys.stderr.flush()
            return result
    except Exception as e:
        sys.stderr.write(f"  ✗ {month_name}: {e}\n")
        sys.stderr.flush()
        return {}

def process_year(year, writer):
    rtm_path = os.path.join(CACHE_DIR, f'rtm-{year}.xlsx')
    dam_path = os.path.join(CACHE_DIR, f'dam-{year}.xlsx')
    if not os.path.exists(rtm_path):
        sys.stderr.write(f"[{year}] RTM not cached — skipping\n")
        return 0

    sys.stderr.write(f"\n[Year {year}] RTM ({NUM_WORKERS} workers)...\n"); sys.stderr.flush()
    with Pool(processes=NUM_WORKERS) as pool:
        rtm_parts = pool.map(_worker, [(rtm_path, m, True) for m in MONTHS])

    rtm_agg = defaultdict(list)
    for part in rtm_parts:
        for k, v in part.items():
            rtm_agg[k].extend(v)
    sys.stderr.write(f"  RTM merged: {len(rtm_agg)} keys\n"); sys.stderr.flush()

    dam_agg = {}
    if os.path.exists(dam_path):
        sys.stderr.write(f"  DAM ({NUM_WORKERS} workers)...\n"); sys.stderr.flush()
        with Pool(processes=NUM_WORKERS) as pool:
            dam_parts = pool.map(_worker, [(dam_path, m, False) for m in MONTHS])
        for part in dam_parts:
            dam_agg.update(part)
        sys.stderr.write(f"  DAM merged: {len(dam_agg)} keys\n"); sys.stderr.flush()

    count = 0
    for key, rt_list in rtm_agg.items():
        sp, yr, mo, dy, hr = key
        rt_avg = sum(rt_list)/len(rt_list) if rt_list else None
        da_price = dam_agg.get(key)
        nt = node_type(sp)
        rt_val = f"{rt_avg:.4f}" if rt_avg is not None else ''
        da_val = f"{da_price:.4f}" if da_price is not None else ''
        writer.writerow([sp, nt, yr, mo, dy, hr, da_val, rt_val])
        count += 1
    sys.stderr.write(f"  => {count} rows for {year}\n"); sys.stderr.flush()
    return count

def main():
    sys.stderr.write(f"=== ERCOT Hourly Fast Extractor (raw XML)\n")
    sys.stderr.write(f"Output: {OUT_PATH}\n"); sys.stderr.flush()
    total = 0
    with open(OUT_PATH, 'w', newline='') as f:
        writer = csv.writer(f)
        for year in [2024, 2025]:
            total += process_year(year, writer)
    sys.stderr.write(f"\nTotal rows: {total} → {OUT_PATH}\n"); sys.stderr.flush()

if __name__ == '__main__':
    main()
