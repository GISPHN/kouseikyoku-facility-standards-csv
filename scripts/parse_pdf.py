import argparse
import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader


CODE_RE = re.compile(r"^(（[^）]+）第[^\s〒]+?号)(.*)$")
DATE_RE = re.compile(r"^((?:令和|平成|昭和)(?:元|\s*\d+)?年\s*\d{1,2}月\s*\d{1,2}日)(.*)$")
POSTAL_RE = re.compile(r"〒\s*([0-9０-９]{3})[－ー―‐-]\s*([0-9０-９]{4})")
PHONE_RE = re.compile(r"(\d{2,5}-\d{1,4}-\d{3,4})")
FAX_RE = re.compile(r"\((\d{2,5}-\d{1,4}-\d{3,4})\)")
NUMBER_RE = re.compile(r"^(\d+)\s+(\d{2}-\d{5})")
BRANCH_RE = re.compile(r"^\((\d{2}-\d{5})\s*\)")
BED_RE = re.compile(r"^(一般|療養|精神|結核|感染|その他|一般・療養|一般及び療養)[\s　]*(\d+)$")
PREF_RE = re.compile(r"届出受理医療機関名簿\[\s*([^\]\s]+)\s*\]")
AS_OF_RE = re.compile(r"\[\s*(令和\s*\d+年\s*\d+月\s*\d+日)\s*現在")
CREATED_RE = re.compile(r"(令和\s*\d+年\s*\d+月\s*\d+日)\s*作成")


LEGAL_FORMS = (
    "国立研究開発法人",
    "地方独立行政法人",
    "独立行政法人",
    "国立大学法人",
    "公立大学法人",
    "社会医療法人",
    "医療法人社団",
    "医療法人財団",
    "医療法人",
    "社会福祉法人",
    "公益財団法人",
    "一般財団法人",
    "公益社団法人",
    "一般社団法人",
    "学校法人",
    "宗教法人",
    "株式会社",
    "有限会社",
)


def clean_line(line):
    return (
        line.replace("\u3000", "　")
        .replace("\xa0", " ")
        .replace("－", "-")
        .strip()
    )


def should_skip(line):
    return (
        not line
        or line.startswith("届出受理医療機関名簿")
        or line.startswith("全医療機関出力")
        or line.startswith("[ 令和")
        or line.startswith("病床数")
        or line.startswith("電話番号")
    )


def split_tokens(line):
    line = clean_line(line)
    if should_skip(line):
        return []

    tokens = []
    while line:
        postal_match = POSTAL_RE.search(line)
        if postal_match and postal_match.start() > 0:
            tokens.extend(split_tokens(line[: postal_match.start()]))
            line = line[postal_match.start() :]
            continue

        code_match = CODE_RE.match(line)
        if code_match:
            tokens.append(code_match.group(1).strip())
            line = code_match.group(2).strip()
            continue

        date_match = DATE_RE.match(line)
        if date_match:
            tokens.append(re.sub(r"\s+", " ", date_match.group(1)).strip())
            line = date_match.group(2).strip()
            continue

        tokens.append(line)
        break
    return [token for token in tokens if token]


def normalize_spaces(text):
    return re.sub(r"[ 　]+", "　", text).strip(" 　")


def split_name(full_name):
    name = normalize_spaces(full_name)
    compact = name.replace("　", "")
    for form in LEGAL_FORMS:
        if compact.startswith(form):
            pieces = [piece for piece in re.split(r"[ 　]+", name) if piece]
            if len(pieces) >= 2:
                return normalize_spaces("　".join(pieces[:-1])), pieces[-1]
            rest = compact[len(form) :]
            if form in ("国立研究開発法人", "国立大学法人", "公立大学法人", "地方独立行政法人", "独立行政法人") and rest:
                return form, rest
            for suffix in ("会", "財団", "社団"):
                suffix_index = rest.find(suffix)
                if suffix_index > 0 and suffix_index + 1 < len(rest):
                    return form + rest[: suffix_index + 1], rest[suffix_index + 1 :]
            return "", name
    return "", name


def parse_code(line):
    match = re.match(r"^（([^）]+)）第(.+?)号$", line)
    if not match:
        return {"standard_code": line, "acceptance_no": ""}
    return {"standard_code": match.group(1), "acceptance_no": match.group(2)}


def era_to_year(era, year_text):
    year = 1 if year_text.strip() == "元" else int(year_text)
    offsets = {"令和": 2018, "平成": 1988, "昭和": 1925}
    return offsets[era] + year


def date_to_iso(date_text):
    match = re.search(r"(令和|平成|昭和)\s*(元|\d+)年\s*(\d+)月\s*(\d+)日", date_text)
    if not match:
        return ""
    year = era_to_year(match.group(1), match.group(2))
    month = int(match.group(3))
    day = int(match.group(4))
    return f"{year:04d}-{month:02d}-{day:02d}"


def build_rows(record, source_meta):
    full_name = normalize_spaces("".join(record.get("name_lines", [])))
    corporation_name, hospital_name = split_name(full_name)
    standards = record.get("standards", [])
    dates = record.get("dates", [])
    if not standards:
        standards = [{"standard_code": "", "acceptance_no": ""}]
    rows = []
    for index, standard in enumerate(standards):
        start_date = dates[index] if index < len(dates) else ""
        rows.append(
            {
                **source_meta,
                "page": record.get("page", ""),
                "item_no": record.get("item_no", ""),
                "medical_institution_no": record.get("medical_institution_no", ""),
                "branch_no": record.get("branch_no", ""),
                "corporation_name": corporation_name,
                "hospital_name": hospital_name,
                "full_name": full_name,
                "postal_code": record.get("postal_code", ""),
                "address": normalize_spaces("".join(record.get("address_lines", []))),
                "phone": record.get("phone", ""),
                "fax": record.get("fax", ""),
                "bed_type": record.get("bed_type", ""),
                "bed_count": record.get("bed_count", ""),
                "standard_code": standard.get("standard_code", ""),
                "acceptance_no": standard.get("acceptance_no", ""),
                "start_date_jp": start_date,
                "start_date_iso": date_to_iso(start_date),
                "latitude": "",
                "longitude": "",
                "geocode_title": "",
                "geocode_source": "",
            }
        )
    return rows


def parse_pdf(pdf_path):
    reader = PdfReader(pdf_path)
    rows = []
    facilities = 0
    source_meta = {"prefecture": "", "as_of_date": "", "created_date": ""}
    pending_standards = []
    pending_dates = []
    record = None
    stage = "scan"

    def finalize_current():
        nonlocal record, facilities, pending_standards, pending_dates, stage
        if record and record.get("name_lines"):
            rows.extend(build_rows(record, source_meta))
            facilities += 1
        record = None
        stage = "scan"

    def start_record(postal_line, page_no):
        nonlocal record, pending_standards, pending_dates, stage
        postal = POSTAL_RE.search(postal_line)
        record = {
            "page": page_no,
            "postal_code": f"{postal.group(1)}-{postal.group(2)}" if postal else "",
            "standards": pending_standards,
            "dates": pending_dates,
            "address_lines": [],
            "name_lines": [],
        }
        pending_standards = []
        pending_dates = []
        rest = postal_line[postal.end() :].strip() if postal else ""
        if rest:
            record["address_lines"].append(rest)
        stage = "address"

    for page_index, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        if not source_meta["prefecture"]:
            pref = PREF_RE.search(text)
            if pref:
                source_meta["prefecture"] = pref.group(1)
        if not source_meta["as_of_date"]:
            as_of = AS_OF_RE.search(text)
            if as_of:
                source_meta["as_of_date"] = normalize_spaces(as_of.group(1))
        if not source_meta["created_date"]:
            created = CREATED_RE.search(text)
            if created:
                source_meta["created_date"] = normalize_spaces(created.group(1))

        lines = []
        for raw_line in text.splitlines():
            lines.extend(split_tokens(raw_line))

        i = 0
        while i < len(lines):
            line = lines[i]

            if POSTAL_RE.search(line):
                if record:
                    finalize_current()
                start_record(line, page_index)
                i += 1
                continue

            if CODE_RE.match(line):
                if record and stage == "name":
                    finalize_current()
                pending_standards.append(parse_code(line))
                i += 1
                continue

            if DATE_RE.match(line):
                if record and stage == "name":
                    finalize_current()
                pending_dates.append(line)
                i += 1
                continue

            if not record:
                i += 1
                continue

            if stage == "address":
                phone = PHONE_RE.search(line)
                if phone:
                    before = line[: phone.start()].strip()
                    if before:
                        record["address_lines"].append(before)
                    record["phone"] = phone.group(1)
                    fax = FAX_RE.search(line)
                    if fax:
                        record["fax"] = fax.group(1)
                    stage = "number"
                else:
                    record["address_lines"].append(line)
                i += 1
                continue

            if stage == "number":
                number = NUMBER_RE.match(line)
                if number:
                    record["item_no"] = number.group(1)
                    record["medical_institution_no"] = number.group(2)
                    stage = "name"
                else:
                    branch = BRANCH_RE.match(line)
                    if branch:
                        record["branch_no"] = branch.group(1)
                i += 1
                continue

            if stage == "name":
                branch = BRANCH_RE.match(line)
                if branch and not record.get("branch_no"):
                    record["branch_no"] = branch.group(1)
                    i += 1
                    continue
                bed = BED_RE.match(line.replace("　", " "))
                if bed:
                    record["bed_type"] = bed.group(1)
                    record["bed_count"] = bed.group(2)
                    finalize_current()
                    i += 1
                    continue
                record["name_lines"].append(line)
                i += 1
                continue

            i += 1

    finalize_current()
    return {"facility_count": facilities, "rows": rows}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser()
    parser.add_argument("pdf")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    result = parse_pdf(Path(args.pdf))
    if args.json:
        json.dump(result, sys.stdout, ensure_ascii=False)
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
