#!/usr/bin/env python3
"""
Targeted ERCOT hourly gap-fill for 2026 (Jan-May 2026).
Downloads fresh CDR ZIP files with updated 2026 doclookupIds,
parses RTM + DAM for all 15 hub/zone nodes, inserts into ercot_hub_da_rt_hourly.
"""
import os, sys, struct, zlib, zipfile, io, urllib.request, psycopg2
from collections import defaultdict
from xml.etree import cElementTree as ET

CACHE_DIR   = "/tmp/ercot-hourly-cache"
CDR_BASE    = "https://www.ercot.com/misdownload/servlets/mirDownload?mimic_duns=000000000&doclookupId="
RTM_ID_2026 = "1238507929"
DAM_ID_2026 = "1238506057"

HUB_ZONE_NODES = {
    "HB_BUSAVG","HB_HOUSTON","HB_HUBAVG","HB_NORTH","HB_PAN","HB_SOUTH","HB_WEST",
    "LZ_AEN","LZ_CPS","LZ_HOUSTON","LZ_LCRA","LZ_NORTH","LZ_RAYBN","LZ_SOUTH","LZ_WEST",
}
MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

def node_type(sp): return "hub" if sp.startswith("HB_") else "load_zone"

def download_bytes(url):
    print(f"  Downloading...", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    print(f"  Downloaded {len(data)/1024/1024:.1f} MB", flush=True)
    return data

def extract_xlsx_from_zip_bytes(data):
    buf = data
    eocd_off = len(buf) - 22
    while eocd_off >= 0 and struct.unpack_from("<I", buf, eocd_off)[0] != 0x06054b50:
        eocd_off -= 1
    if eocd_off < 0:
        raise ValueError("No EOCD")
    cd_off = struct.unpack_from("<I", buf, eocd_off + 16)[0]
    z64loc = eocd_off - 20
    if z64loc >= 0 and struct.unpack_from("<I", buf, z64loc)[0] == 0x07064b50:
        z64pos = struct.unpack_from("<Q", buf, z64loc + 8)[0]
        if z64pos < len(buf) and struct.unpack_from("<I", buf, z64pos)[0] == 0x06064b50:
            cd_off = struct.unpack_from("<Q", buf, z64pos + 48)[0]
    comp_size = struct.unpack_from("<I", buf, cd_off + 20)[0]
    local_off  = struct.unpack_from("<I", buf, cd_off + 42)[0]
    fn_len = struct.unpack_from("<H", buf, cd_off + 28)[0]
    ex_len = struct.unpack_from("<H", buf, cd_off + 30)[0]
    ep, e_end = cd_off + 46 + fn_len, cd_off + 46 + fn_len + ex_len
    while ep < e_end - 3:
        tag, sz = struct.unpack_from("<HH", buf, ep)
        if tag == 0x0001:
            p = ep + 4
            usz = struct.unpack_from("<I", buf, cd_off + 24)[0]
            if usz == 0xFFFFFFFF and p + 8 <= ep + 4 + sz: p += 8
            if comp_size == 0xFFFFFFFF and p + 8 <= ep + 4 + sz:
                comp_size = struct.unpack_from("<Q", buf, p)[0]; p += 8
            if local_off == 0xFFFFFFFF and p + 8 <= ep + 4 + sz:
                local_off = struct.unpack_from("<Q", buf, p)[0]
        ep += 4 + sz
    lf_fn = struct.unpack_from("<H", buf, local_off + 26)[0]
    lf_ex = struct.unpack_from("<H", buf, local_off + 28)[0]
    data_start = local_off + 30 + lf_fn + lf_ex
    return zlib.decompress(buf[data_start:data_start + comp_size], -15)

def get_shared_strings(zf):
    try:
        xml = zf.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    strings, cur = [], []
    for ev, el in ET.iterparse(io.BytesIO(xml), events=("start","end")):
        local = el.tag.split("}")[-1]
        if ev == "start" and local == "si":
            cur = []
        elif ev == "end":
            if local == "t" and el.text:
                cur.append(el.text)
            elif local == "si":
                strings.append("".join(cur))
    return strings

def get_sheet_paths(zf):
    """Return dict: sheet_name -> full path in zip."""
    # parse rels to get rId -> path
    rels_xml = zf.read("xl/_rels/workbook.xml.rels")
    rid_to_path = {}
    for ev, el in ET.iterparse(io.BytesIO(rels_xml)):
        local = el.tag.split("}")[-1]
        if local == "Relationship" and "worksheet" in el.get("Type",""):
            target = el.get("Target","")
            rid_to_path[el.get("Id","")] = f"xl/{target}"

    # parse workbook to get name -> rId
    wb_xml = zf.read("xl/workbook.xml")
    name_to_path = {}
    XLNS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    RELNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
    for ev, el in ET.iterparse(io.BytesIO(wb_xml)):
        if el.tag == f"{XLNS}sheet":
            name = el.get("name","")
            rid  = el.get(f"{RELNS}id","")
            path = rid_to_path.get(rid)
            if path:
                name_to_path[name] = path
    return name_to_path

def parse_hour(val):
    if val is None: return None
    s = str(val)
    if ":" in s:
        try: return int(s.split(":")[0])
        except: pass
    try: return int(float(s))
    except: return None

def parse_date(val):
    if val is None: return None, None, None
    s = str(val)
    if "/" in s:
        parts = s.split("/")
        if len(parts) == 3:
            try: return int(parts[2]), int(parts[0]), int(parts[1])
            except: pass
    return None, None, None

def parse_sheet(zf, sheet_path, shared, is_rtm):
    """
    RTM columns (0-indexed): A=date, B=hour, C=interval, D=flag, E=sp, F=sp_type, G=price
    DAM columns (0-indexed): A=date, B=hour, C=flag, D=sp, E=price
    """
    agg = defaultdict(list) if is_rtm else {}
    xml_data = zf.read(sheet_path)
    cells, cur_col, cur_type = {}, None, ""

    for ev, el in ET.iterparse(io.BytesIO(xml_data), events=("start","end")):
        local = el.tag.split("}")[-1]
        if ev == "start":
            if local == "row":
                cells = {}
            elif local == "c":
                r = el.get("r","")
                cur_col = "".join(ch for ch in r if ch.isalpha())
                cur_type = el.get("t","")
        elif ev == "end":
            if local == "v" and cur_col and el.text is not None:
                raw = el.text
                val = shared[int(raw)] if cur_type == "s" and raw.lstrip("-").isdigit() else raw
                cells[cur_col] = val
            elif local == "row" and cells:
                if is_rtm:
                    # A=date, B=hour, D=flag, E=sp, G=price
                    date_s = cells.get("A"); hr_raw = cells.get("B")
                    flag   = cells.get("D",""); sp = cells.get("E","")
                    price_s = cells.get("G")
                    if flag == "Y" or sp not in HUB_ZONE_NODES: continue
                    if not date_s or not price_s: continue
                    yr, mo, dy = parse_date(date_s)
                    hr = parse_hour(hr_raw)
                    if yr is None or hr is None: continue
                    try: price = float(price_s)
                    except: continue
                    agg[(sp, yr, mo, dy, hr)].append(price)
                else:
                    # A=date, B=hour, C=flag, D=sp, E=price
                    date_s = cells.get("A"); hr_raw = cells.get("B")
                    flag   = cells.get("C",""); sp = cells.get("D","")
                    price_s = cells.get("E")
                    if flag == "Y" or sp not in HUB_ZONE_NODES: continue
                    if not date_s or not price_s: continue
                    yr, mo, dy = parse_date(date_s)
                    hr = parse_hour(hr_raw)
                    if yr is None or hr is None: continue
                    try: price = float(price_s)
                    except: continue
                    agg[(sp, yr, mo, dy, hr)] = price
    return agg

def process_xlsx(xlsx_bytes, is_rtm, only_months=None):
    combined = defaultdict(list) if is_rtm else {}
    zf = zipfile.ZipFile(io.BytesIO(xlsx_bytes))
    shared = get_shared_strings(zf)
    sheet_paths = get_sheet_paths(zf)
    print(f"  Sheets found: {list(sheet_paths.keys())}", flush=True)

    for name in MONTHS:
        month_num = MONTHS.index(name) + 1
        if only_months and month_num not in only_months: continue
        path = sheet_paths.get(name)
        if not path:
            print(f"  {name}: not found", flush=True); continue
        print(f"  {name}...", end="", flush=True)
        result = parse_sheet(zf, path, shared, is_rtm)
        print(f" {len(result)} rows", flush=True)
        if is_rtm:
            for k, v in result.items(): combined[k].extend(v)
        else:
            combined.update(result)
    return combined

def main():
    os.makedirs(CACHE_DIR, exist_ok=True)
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL not set"); sys.exit(1)

    ONLY_MONTHS = {1,2,3,4,5}  # Jan-May 2026 only

    # Download / use cached 2026 RTM
    rtm_cache = os.path.join(CACHE_DIR, "rtm-2026.xlsx")
    if not os.path.exists(rtm_cache):
        print("[2026] Downloading RTM...", flush=True)
        raw = download_bytes(CDR_BASE + RTM_ID_2026)
        xlsx = extract_xlsx_from_zip_bytes(raw)
        with open(rtm_cache, "wb") as f: f.write(xlsx)
        print(f"[2026] RTM cached: {len(xlsx)/1024/1024:.1f} MB", flush=True)
    else:
        print(f"[2026] RTM already cached ({os.path.getsize(rtm_cache)/1024/1024:.1f} MB)", flush=True)

    # Download / use cached 2026 DAM
    dam_cache = os.path.join(CACHE_DIR, "dam-2026.xlsx")
    if not os.path.exists(dam_cache):
        print("[2026] Downloading DAM...", flush=True)
        raw = download_bytes(CDR_BASE + DAM_ID_2026)
        xlsx = extract_xlsx_from_zip_bytes(raw)
        with open(dam_cache, "wb") as f: f.write(xlsx)
        print(f"[2026] DAM cached: {len(xlsx)/1024/1024:.1f} MB", flush=True)
    else:
        print(f"[2026] DAM already cached ({os.path.getsize(dam_cache)/1024/1024:.1f} MB)", flush=True)

    print("\n[2026] Parsing RTM (Jan-May)...", flush=True)
    with open(rtm_cache, "rb") as f: rtm_xlsx = f.read()
    rtm_agg = process_xlsx(rtm_xlsx, is_rtm=True, only_months=ONLY_MONTHS)
    print(f"  RTM total keys: {len(rtm_agg)}", flush=True)

    print("\n[2026] Parsing DAM (Jan-May)...", flush=True)
    with open(dam_cache, "rb") as f: dam_xlsx = f.read()
    dam_agg = process_xlsx(dam_xlsx, is_rtm=False, only_months=ONLY_MONTHS)
    print(f"  DAM total keys: {len(dam_agg)}", flush=True)

    # Build rows (only 2026)
    rows = []
    for key, rt_list in rtm_agg.items():
        sp, yr, mo, dy, hr = key
        if yr != 2026 or mo > 5: continue
        rt_avg = sum(rt_list) / len(rt_list)
        da_price = dam_agg.get(key)
        rows.append((sp, node_type(sp), yr, mo, dy, hr,
                     round(da_price, 4) if da_price is not None else None,
                     round(rt_avg, 4)))

    print(f"\nBuilt {len(rows)} rows for 2026 Jan-May", flush=True)
    if not rows:
        print("No rows — check column mapping"); sys.exit(1)

    print("Inserting into ercot_hub_da_rt_hourly...", flush=True)
    conn = psycopg2.connect(db_url)
    cur = conn.cursor()
    inserted = 0
    BATCH = 2000
    for i in range(0, len(rows), BATCH):
        batch = rows[i:i+BATCH]
        args = ",".join(cur.mogrify("(%s,%s,%s,%s,%s,%s,%s,%s)", r).decode() for r in batch)
        cur.execute(f"""
            INSERT INTO ercot_hub_da_rt_hourly (node,node_type,year,month,day,hour,da_price,rt_price)
            VALUES {args} ON CONFLICT DO NOTHING
        """)
        inserted += cur.rowcount
        conn.commit()
        print(f"  {i+len(batch)}/{len(rows)} rows processed, {cur.rowcount} inserted", flush=True)
    cur.close(); conn.close()
    print(f"\n✓ Inserted {inserted} new rows for 2026 Jan-May into ercot_hub_da_rt_hourly.", flush=True)

if __name__ == "__main__":
    main()
