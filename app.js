import * as XLSX from "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm";

const form = document.querySelector("#convertForm");
const fileInput = document.querySelector("#pdfFile");
const fileName = document.querySelector("#fileName");
const geocodeInput = document.querySelector("#geocode");
const statusBox = document.querySelector("#status");
const progress = document.querySelector("#progress");
const submitButton = document.querySelector("#submitButton");
const GEOCODE_DELAY_MS = 500;

const LEGAL_FORMS = [
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
];

const BED_TYPES = ["一般", "療養", "精神", "結核", "感染"];

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileName.textContent = file ? file.name : "厚生局公開の施設基準Excel";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;

  submitButton.disabled = true;
  progress.hidden = false;
  progress.value = 0;

  try {
    if (!isExcelFile(file)) {
      throw new Error("Excelファイル（.xlsx / .xlsm / .xls）を指定してください。");
    }

    setStatus("Excelを読み込んでいます。", 0);
    const buffer = await file.arrayBuffer();
    const parsed = parseExcel(buffer);
    const rows = parsed.rows.map((row) => ({ ...row, source_file: file.name || "upload.xlsx" }));

    if (geocodeInput.checked) {
      await geocodeRows(rows, GEOCODE_DELAY_MS);
    }

    const csv = toCsv(rows);
    downloadCsv(csv, file.name.replace(/\.(xlsx|xlsm|xls)$/i, ".csv") || "kouseikyoku.csv");
    setStatus(`${parsed.facility_count}医療機関、${rows.length}行のCSVを作成しました。`, 100);
  } catch (error) {
    setStatus(error.message || String(error), 0);
  } finally {
    submitButton.disabled = false;
    progress.hidden = true;
  }
});

function setStatus(message, value) {
  statusBox.textContent = message;
  progress.value = value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExcelFile(file) {
  return /\.(xlsx|xlsm|xls)$/i.test(file?.name || "") || /spreadsheet|excel/i.test(file?.type || "");
}

function toHalfWidthDigits(text) {
  return String(text || "").replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

function normalizeSpaces(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\r\n　]+/g, "　")
    .replace(/^[ 　]+|[ 　]+$/g, "");
}

function excelCellText(value) {
  if (value === undefined || value === null) return "";
  return normalizeSpaces(String(value).trim());
}

function findExcelHeaderIndex(rows) {
  const index = rows.findIndex((row) => {
    const cells = row.map(excelCellText);
    return cells.includes("項番") && cells.includes("医療機関番号") && cells.includes("医療機関名称");
  });
  if (index < 0) {
    throw new Error("Excelのヘッダー行を検出できませんでした。「項番」「医療機関番号」「医療機関名称」を含む行が必要です。");
  }
  return index;
}

function headerMap(headers) {
  const map = new Map();
  headers.forEach((header, index) => {
    const key = excelCellText(header);
    if (key && !map.has(key)) map.set(key, index);
  });
  return map;
}

function valueByHeader(row, headers, name) {
  const index = headers.get(name);
  return index === undefined ? "" : excelCellText(row[index]);
}

function normalizeMedicalInstitutionNo(value) {
  const text = excelCellText(value);
  const digits = toHalfWidthDigits(text).replace(/\D/g, "");
  if (digits.length === 7) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return text;
}

function normalizePostalCode(value) {
  const digits = toHalfWidthDigits(value).replace(/\D/g, "");
  if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return excelCellText(value);
}

function parseSourceMeta(text) {
  const normalized = toHalfWidthDigits(text || "");
  const asOf = /\[\s*((?:令和|平成|昭和)\s*(?:元|\d+)年\s*\d{1,2}月\s*\d{1,2}日)\s*現在/u.exec(normalized);
  const created = /((?:令和|平成|昭和)\s*(?:元|\d+)年\s*\d{1,2}月\s*\d{1,2}日)\s*作成/u.exec(normalized);
  return {
    as_of_date: asOf ? normalizeSpaces(asOf[1]) : "",
    created_date: created ? normalizeSpaces(created[1]) : "",
  };
}

function splitName(fullName) {
  const name = normalizeSpaces(fullName);
  if (!name) return ["", ""];

  const pieces = name.split(/[ 　]+/u).filter(Boolean);
  if (pieces.length >= 2 && LEGAL_FORMS.some((form) => pieces[0].startsWith(form))) {
    return [normalizeSpaces(pieces.slice(0, -1).join("　")), pieces.at(-1)];
  }

  const compact = name.replace(/[ 　]+/gu, "");
  for (const form of LEGAL_FORMS) {
    if (!compact.startsWith(form)) continue;
    const rest = compact.slice(form.length);
    if (!rest) return [compact, ""];
    for (const suffix of ["会", "院", "財団", "社団"]) {
      const index = rest.indexOf(suffix);
      if (index > 0 && index + 1 < rest.length) {
        return [form + rest.slice(0, index + 1), rest.slice(index + 1)];
      }
    }
    if (form.includes("法人")) return [form, rest];
    return ["", name];
  }

  return ["", name];
}

function normalizeCount(value) {
  return toHalfWidthDigits(value).replace(/[，,]/g, "");
}

function addBed(record, type, count) {
  const normalizedType = normalizeBedType(type);
  const normalizedCount = normalizeCount(count);
  if (!normalizedType || !normalizedCount) return;
  record.beds ||= [];
  if (!record.beds.some((bed) => bed.type === normalizedType && bed.count === normalizedCount)) {
    record.beds.push({ type: normalizedType, count: normalizedCount });
  }
}

function bedValues(record) {
  const beds = record.beds || [];
  const total = beds.reduce((sum, bed) => sum + (Number(bed.count) || 0), 0);
  return {
    bed_type: beds.map((bed) => bed.type).join(";"),
    bed_count: beds.map((bed) => bed.count).join(";"),
    bed_summary: beds.map((bed) => `${bed.type}:${bed.count}`).join(";"),
    bed_total: beds.length ? String(total) : "",
  };
}

function normalizeBedType(typeText) {
  const text = normalizeSpaces(typeText)
    .replace(/一般[（(]\s*感染\s*[）)]/gu, "感染")
    .replace(/[ 　]+/gu, " ")
    .trim();
  if (!text) return "";
  const parts = text.split(" ").filter(Boolean);
  if (parts.includes("感染")) return "感染";
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (BED_TYPES.includes(parts[index])) return parts[index];
  }
  return text;
}

function parseBeds(value) {
  const record = { beds: [] };
  const text = excelCellText(value);
  if (!text) return bedValues(record);

  for (const part of text.split(/[／/]/u)) {
    const normalized = toHalfWidthDigits(part).replace(/[ 　]+/gu, " ").trim();
    const match = /^(.+?)\s*([0-9][0-9,]*)$/u.exec(normalized);
    if (match) addBed(record, match[1], match[2]);
  }

  return bedValues(record);
}

function eraToYear(era, yearText) {
  const normalizedYear = toHalfWidthDigits(yearText).trim();
  const year = normalizedYear === "元" ? 1 : Number(normalizedYear);
  return { 令和: 2018, 平成: 1988, 昭和: 1925 }[era] + year;
}

function dateToIso(dateText) {
  const normalized = toHalfWidthDigits(dateText || "").replace(/\s+/g, "");
  const match = /(令和|平成|昭和)(元|\d+)年(\d{1,2})月(\d{1,2})日/u.exec(normalized);
  if (!match) return "";
  return `${eraToYear(match[1], match[2])}-${String(Number(match[3])).padStart(2, "0")}-${String(Number(match[4])).padStart(2, "0")}`;
}

function dateToParts(dateText) {
  const iso = dateToIso(dateText);
  if (!iso) return { start_year: "", start_month: "", start_day: "" };
  const [year, month, day] = iso.split("-");
  return {
    start_year: year,
    start_month: String(Number(month)),
    start_day: String(Number(day)),
  };
}

function parseExcel(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: "array", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("Excelにシートがありません。");

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  const headerIndex = findExcelHeaderIndex(rows);
  const headers = headerMap(rows[headerIndex]);
  const sourceMetaText = rows.slice(0, headerIndex).flat().map(excelCellText).find(Boolean) || "";
  const sourceMeta = parseSourceMeta(sourceMetaText);
  const outputRows = [];
  const facilityKeys = new Set();

  for (const row of rows.slice(headerIndex + 1)) {
    if (!row.some((value) => excelCellText(value))) continue;

    const fullName = valueByHeader(row, headers, "医療機関名称");
    const address = valueByHeader(row, headers, "医療機関所在地（住所）");
    const medicalInstitutionNo = normalizeMedicalInstitutionNo(valueByHeader(row, headers, "医療機関番号"));
    if (!fullName && !address && !medicalInstitutionNo) continue;

    const branchNo = normalizeMedicalInstitutionNo(valueByHeader(row, headers, "併設医療機関番号"));
    const [corporationName, hospitalName] = splitName(fullName);
    const startDate = valueByHeader(row, headers, "算定開始年月日");
    const rowObject = {
      prefecture_code: valueByHeader(row, headers, "都道府県コード"),
      prefecture: valueByHeader(row, headers, "都道府県名"),
      category: valueByHeader(row, headers, "区分"),
      as_of_date: sourceMeta.as_of_date,
      created_date: sourceMeta.created_date,
      item_no: valueByHeader(row, headers, "項番"),
      medical_institution_no: medicalInstitutionNo,
      branch_no: branchNo,
      medical_institution_symbol_no: valueByHeader(row, headers, "医療機関記号番号"),
      corporation_name: corporationName,
      hospital_name: hospitalName,
      full_name: fullName,
      postal_code: normalizePostalCode(valueByHeader(row, headers, "医療機関所在地（郵便番号）")),
      address,
      phone: valueByHeader(row, headers, "電話番号"),
      fax: valueByHeader(row, headers, "FAX番号"),
      ...parseBeds(valueByHeader(row, headers, "病床数")),
      standard_name: valueByHeader(row, headers, "受理届出名称"),
      standard_code: valueByHeader(row, headers, "受理記号"),
      acceptance_no: valueByHeader(row, headers, "受理番号"),
      start_date_jp: startDate,
      start_date_iso: dateToIso(startDate),
      ...dateToParts(startDate),
      individual_valid_start_date_jp: valueByHeader(row, headers, "個別有効開始年月日"),
      individual_valid_start_date_iso: dateToIso(valueByHeader(row, headers, "個別有効開始年月日")),
      remarks_heading: valueByHeader(row, headers, "備考（見出し）"),
      remarks_data: valueByHeader(row, headers, "備考（データ）"),
      municipality_code: valueByHeader(row, headers, "市町村コード"),
      municipality_name: valueByHeader(row, headers, "市町村名"),
      type_code: valueByHeader(row, headers, "種別コード"),
      type: valueByHeader(row, headers, "種別"),
      latitude: "",
      longitude: "",
      geocode_title: "",
      geocode_source: "",
    };

    outputRows.push(rowObject);
    facilityKeys.add([medicalInstitutionNo, branchNo, rowObject.postal_code, address, fullName].join("|"));
  }

  return { rows: outputRows, facility_count: facilityKeys.size };
}

function normalizeAddressForQuery(prefecture, address) {
  const text = String(address || "").replace(/[ 　]+/g, "").replace(/[－ー―]/g, "-").trim();
  if (!text) return "";
  return text.startsWith(prefecture) ? text : `${prefecture || ""}${text}`;
}

async function geocodeRows(rows, delayMs) {
  const facilityQueries = new Map();
  const queryResults = new Map();

  for (const row of rows) {
    const facilityKey = [
      row.medical_institution_no,
      row.branch_no,
      row.postal_code,
      row.address,
      row.full_name,
    ].join("|");
    if (!facilityQueries.has(facilityKey)) {
      facilityQueries.set(facilityKey, normalizeAddressForQuery(row.prefecture, row.address));
    }
  }

  const uniqueQueries = [...new Set([...facilityQueries.values()].filter(Boolean))];

  for (let index = 0; index < uniqueQueries.length; index += 1) {
    const query = uniqueQueries[index];
    setStatus(
      `ジオコーディング中: ${index + 1} / ${uniqueQueries.length} 医療機関住所`,
      55 + Math.round(((index + 1) / Math.max(uniqueQueries.length, 1)) * 40),
    );
    const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`;
    let result = { geocode_source: "gsi-address-search:no-result" };
    try {
      const response = await fetch(url);
      if (response.ok) {
        const payload = await response.json();
        const first = Array.isArray(payload) ? payload[0] : null;
        const coords = first?.geometry?.coordinates;
        if (Array.isArray(coords) && coords.length >= 2) {
          result = {
            longitude: coords[0],
            latitude: coords[1],
            geocode_title: first?.properties?.title || "",
            geocode_source: "gsi-address-search",
          };
        }
      } else {
        result = { geocode_source: `gsi-address-search:http-${response.status}` };
      }
    } catch (error) {
      result = { geocode_source: `gsi-address-search:error:${error.message}` };
    }
    queryResults.set(query, result);
    if (delayMs > 0) await sleep(delayMs);
  }

  const facilityResults = new Map();
  for (const [facilityKey, query] of facilityQueries) {
    facilityResults.set(facilityKey, queryResults.get(query) || {});
  }

  for (const row of rows) {
    const facilityKey = [
      row.medical_institution_no,
      row.branch_no,
      row.postal_code,
      row.address,
      row.full_name,
    ].join("|");
    Object.assign(row, facilityResults.get(facilityKey) || {});
  }
}

function csvEscape(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  const columns = [
    "source_file",
    "prefecture_code",
    "prefecture",
    "category",
    "as_of_date",
    "created_date",
    "item_no",
    "medical_institution_no",
    "branch_no",
    "medical_institution_symbol_no",
    "corporation_name",
    "hospital_name",
    "full_name",
    "postal_code",
    "address",
    "phone",
    "fax",
    "bed_type",
    "bed_count",
    "bed_summary",
    "bed_total",
    "standard_name",
    "standard_code",
    "acceptance_no",
    "start_date_jp",
    "start_date_iso",
    "start_year",
    "start_month",
    "start_day",
    "individual_valid_start_date_jp",
    "individual_valid_start_date_iso",
    "remarks_heading",
    "remarks_data",
    "municipality_code",
    "municipality_name",
    "type_code",
    "type",
    "latitude",
    "longitude",
    "geocode_title",
    "geocode_source",
  ];
  return "\uFEFF" + [columns.join(","), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))].join("\r\n");
}

function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "kouseikyoku.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
