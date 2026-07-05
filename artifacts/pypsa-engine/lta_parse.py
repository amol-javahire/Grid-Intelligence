"""
LTA PDF parser — called by the API server via execSync.
Usage: python3 lta_parse.py <pdf_path>
Returns: JSON with key LTA metrics.

Column layout for Table 1 data rows (pdfplumber, observed across multiple reports):
  0=Stage  1=Solar  2=Wind  3=Storage  7=Gas  8=Hydro  11=Total
  (header row uses different offsets due to merged cells — use hardcoded data indices)
"""
import pdfplumber
import json
import re
import sys

pdf_path = sys.argv[1]

with pdfplumber.open(pdf_path) as pdf:
    all_text = ""
    table1_raw = None
    prob_text = ""

    for page in pdf.pages:
        text = page.extract_text() or ""
        all_text += text + "\n"
        tables = page.extract_tables()
        for tbl in tables:
            if not tbl or len(tbl) < 3:
                continue
            header_str = " ".join(str(c) for c in tbl[0] if c)
            if "Stage" in header_str and "Solar" in header_str and table1_raw is None:
                table1_raw = tbl

result = {}

# ── AIL Forecast ─────────────────────────────────────────────────────────────
# Text layout: "Alberta Internal Load (AIL)\n10,417 MW\nForecast\n..."
ail_m = re.search(r"Alberta Internal Load \(AIL\)\s*\n\s*([\d,]+)\s*MW", all_text)
if not ail_m:
    # Fallback: value appears in a table cell alongside the "Forecast" label
    ail_m = re.search(r"AIL.*?Forecast.*?([\d,]+)\s*MW", all_text, re.DOTALL)
result["ailMw"] = int(ail_m.group(1).replace(",", "")) if ail_m else None

# ── TENS / Threshold ─────────────────────────────────────────────────────────
tens_m = re.search(
    r"Total Energy Not Served.*?equaling\s*([\d.]+)\s*MWh", all_text, re.DOTALL
)
result["tensMwh"] = float(tens_m.group(1)) if tens_m else None
thresh_m = re.search(r"([\d,]+)\s*MWh threshold", all_text)
result["thresholdMwh"] = int(thresh_m.group(1).replace(",", "")) if thresh_m else None

# ── Two-year probability (parsed from text) ──────────────────────────────────
# Header line: "Worst Shortfall Hour (MW) # of Hours in Shortfall Total Energy Not Served (MWh)"
# Values line: "0.025 0.001 0.06"
# Next line may contain integer hours count e.g. "May 2026 7 Public"
prob = {}
prob_header = re.search(
    r"Worst Shortfall Hour.*?Total Energy Not Served.*?\n([\d.]+)\s+([\d.]+)\s+([\d.]+)",
    all_text,
    re.DOTALL,
)
if prob_header:
    prob["worstShortfallProbability"] = float(prob_header.group(1))
    prob["shortfallHoursProbability"] = float(prob_header.group(2))
    prob["tensMwh"] = float(prob_header.group(3))
    # Hours integer count may appear on next line after the values (skip 4-digit years)
    after_vals = all_text[prob_header.end() : prob_header.end() + 80]
    hrs_m = re.search(r"\b(\d{1,3})\b", after_vals)
    if hrs_m:
        prob["hoursInShortfall"] = int(hrs_m.group(1))

result["probability"] = prob if prob else None

# ── Table 1: capacity by stage ────────────────────────────────────────────────
def parse_mw(row: list, idx: int) -> int | None:
    if idx >= len(row):
        return None
    v = row[idx]
    if v is None or str(v).strip() in ("", "-", "None"):
        return None
    try:
        return int(str(v).replace(",", "").strip())
    except Exception:
        return None


if table1_raw:
    valid_kw = ["operational", "met project", "received auc", "announced", "total"]
    skip_kw = ["2-year", "ail", "alberta internal", "footnote", "note"]
    stages = []
    for row in table1_raw:
        if not row or row[0] is None:
            continue
        name = str(row[0]).replace("\n", " ").strip()
        name_lower = name.lower()
        if not any(kw in name_lower for kw in valid_kw):
            continue
        if any(kw in name_lower for kw in skip_kw):
            continue
        # Hardcoded data-row column positions (observed in pdfplumber across reports)
        stages.append(
            {
                "name": name,
                "solar":   parse_mw(row, 1),
                "wind":    parse_mw(row, 2),
                "storage": parse_mw(row, 3),
                "gas":     parse_mw(row, 7),
                "hydro":   parse_mw(row, 8),
                "total":   parse_mw(row, 11),
            }
        )
    result["stages"] = stages

# ── Project changes (text-based extraction) ───────────────────────────────────
# Each section starts with a header line describing the type of change
SECTION_HEADERS = re.compile(
    r"((?:Projects? completed[^\n]+|Generation [Pp]rojects? (?:moved|added|that have been "
    r"(?:cancel|announce|added|moved|placed|on\s+hold))[^\n]*))\n",
    re.IGNORECASE,
)

changes = []
for m in SECTION_HEADERS.finditer(all_text):
    header = m.group(1).strip()
    body_start = m.end()
    # Grab next ~60 lines worth of text
    body = all_text[body_start : body_start + 2500]
    projects = []
    for line in body.split("\n")[:60]:
        pm = re.search(
            r"^(.+?)\s+(Solar|Wind|Gas|Storage|Hydro)\s+([\d.]+)", line.strip()
        )
        if pm:
            projects.append(
                {"name": pm.group(1).strip(), "fuel": pm.group(2), "mc": float(pm.group(3))}
            )
    if projects:
        changes.append({"section": header, "projects": projects})

result["projectChanges"] = changes

print(json.dumps(result))
