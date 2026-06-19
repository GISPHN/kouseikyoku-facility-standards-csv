import * as XLSX from "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm";

const $ = (selector) => document.querySelector(selector);
const form = $("#convertForm");
const fileInput = $("#pdfFile");
const fileName = $("#fileName");
const geocodeInput = $("#geocode");
const wideOutputInput = $("#wideOutput");
const statusBox = $("#status");
const progress = $("#progress");
const submitButton = $("#submitButton");
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
const BED_COLUMNS = ["一般", "一般（感染）", "療養", "精神", "結核"];

const LONG_COLUMNS = [
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
  ...BED_COLUMNS,
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
const FACILITY_COLUMNS = LONG_COLUMNS.filter(
  (column) => !["standard_name", "standard_code", "acceptance_no", "start_date_jp", "start_date_iso", "start_year", "start_month", "start_day"].includes(column),
);

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
    if (!/\.(xlsx|xlsm|xls)$/i.test(file.name || "")) throw new Error("Excelファイル（.xlsx / .xlsm / .xls）を指定してください。");
    setStatus("Excelを読み込んでいます。", 0);
    const parsed = parseExcel(await file.arrayBuffer());
    const rows = parsed.rows.map((row) => ({ ...row, source_file: file.name || "upload.xlsx" }));

    if (geocodeInput.checked) await geocodeRows(rows);

    const baseName = file.name.replace(/\.(xlsx|xlsm|xls)$/i, "") || "kouseikyoku";
    downloadCsv(toCsv(rows, LONG_COLUMNS), `${baseName}.csv`);
    if (wideOutputInput?.checked) {
      const wide = buildWideRows(rows);
      downloadCsv(toCsv(wide.rows, [...FACILITY_COLUMNS, ...wide.standardNames]), `${baseName}_wide.csv`);
    }
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

function text(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\r\n　]+/g, "　")
    .replace(/^[ 　]+|[ 　]+$/g, "");
}

function halfDigits(value) {
  return String(value ?? "").replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

function code7(value) {
  const raw = text(value);
  const digits = halfDigits(raw).replace(/\D/g, "");
  return digits.length === 7 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : raw;
}

function postal(value) {
  const raw = text(value);
  const digits = halfDigits(raw).replace(/\D/g, "");
  return digits.length === 7 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : raw;
}

function parseSourceMeta(value) {
  const raw = halfDigits(value);
  const date = "((?:令和|平成|昭和)\\s*(?:元|\\d+)年\\s*\\d{1,2}月\\s*\\d{1,2}日)";
  return {
    as_of_date: text(new RegExp(`\\[\\s*${date}\\s*現在`, "u").exec(raw)?.[1]),
    created_date: text(new RegExp(`${date}\\s*作成`, "u").exec(raw)?.[1]),
  };
}

function splitName(fullName) {
  const name = text(fullName);
  if (!name) return ["", ""];
  const pieces = name.split(/[ 　]+/u).filter(Boolean);
  if (pieces.length >= 2 && LEGAL_FORMS.some((form) => pieces[0].startsWith(form))) return [text(pieces.slice(0, -1).join("　")), pieces.at(-1)];

  const compact = name.replace(/[ 　]+/gu, "");
  for (const form of LEGAL_FORMS) {
    if (!compact.startsWith(form)) continue;
    const rest = compact.slice(form.length);
    if (!rest) return [compact, ""];
    for (const suffix of ["会", "院", "財団", "社団"]) {
      const index = rest.indexOf(suffix);
      if (index > 0 && index + 1 < rest.length) return [form + rest.slice(0, index + 1), rest.slice(index + 1)];
    }
    if (form.includes("法人")) return [form, rest];
  }
  return ["", name];
}

function bedType(value) {
  const normalized = text(value)
    .replace(/一般[（(]\s*感染\s*[）)]/gu, "一般（感染）")
    .replace(/[ 　]+/gu, " ");
  if (!normalized) return "";
  const parts = normalized.split(" ").filter(Boolean);
  if (parts.includes("感染") || parts.includes("一般（感染）")) return "一般（感染）";
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (BED_COLUMNS.includes(parts[index])) return parts[index];
  }
  return "";
}

function parseBeds(value) {
  const result = Object.fromEntries(BED_COLUMNS.map((column) => [column, ""]));
  let total = 0;
  for (const part of text(value).split(/[／/]/u)) {
    const match = /^(.+?)\s*([0-9０-９][0-9０-９,，]*)$/u.exec(halfDigits(part).replace(/[ 　]+/gu, " ").trim());
    if (!match) continue;
    const type = bedType(match[1]);
    const count = Number(match[2].replace(/[，,]/g, ""));
    if (!type || !count) continue;
    result[type] = String((Number(result[type]) || 0) + count);
    total += count;
  }
  result.bed_total = total ? String(total) : "";
  return result;
}

function eraYear(era, yearText) {
  const year = halfDigits(yearText).trim() === "元" ? 1 : Number(halfDigits(yearText));
  return { 令和: 2018, 平成: 1988, 昭和: 1925 }[era] + year;
}

function dateIso(value) {
  const match = /(令和|平成|昭和)(元|\d+)年(\d{1,2})月(\d{1,2})日/u.exec(halfDigits(value).replace(/\s+/g, ""));
  if (!match) return "";
  return `${eraYear(match[1], match[2])}-${String(Number(match[3])).padStart(2, "0")}-${String(Number(match[4])).padStart(2, "0")}`;
}

function dateParts(value) {
  const iso = dateIso(value);
  if (!iso) return { start_year: "", start_month: "", start_day: "" };
  const [year, month, day] = iso.split("-");
  return { start_year: year, start_month: String(Number(month)), start_day: String(Number(day)) };
}

function parseExcel(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: "array", cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("Excelにシートがありません。");
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  const headerIndex = rows.findIndex((row) => {
    const cells = row.map(text);
    return cells.includes("項番") && cells.includes("医療機関番号") && cells.includes("医療機関名称");
  });
  if (headerIndex < 0) throw new Error("Excelのヘッダー行を検出できませんでした。");
  const headers = new Map(rows[headerIndex].map((header, index) => [text(header), index]).filter(([header]) => header));
  const get = (row, name) => text(row[headers.get(name)]);
  const sourceMeta = parseSourceMeta(rows.slice(0, headerIndex).flat().map(text).find(Boolean) || "");
  const outputRows = [];
  const facilityKeys = new Set();

  for (const row of rows.slice(headerIndex + 1)) {
    if (!row.some((cell) => text(cell))) continue;
    const fullName = get(row, "医療機関名称");
    const address = get(row, "医療機関所在地（住所）");
    const medicalNo = code7(get(row, "医療機関番号"));
    if (!fullName && !address && !medicalNo) continue;

    const branchNo = code7(get(row, "併設医療機関番号"));
    const [corporationName, hospitalName] = splitName(fullName);
    const startDate = get(row, "算定開始年月日");
    const validStartDate = get(row, "個別有効開始年月日");
    const rowObject = {
      source_file: "",
      prefecture_code: get(row, "都道府県コード"),
      prefecture: get(row, "都道府県名"),
      category: get(row, "区分"),
      ...sourceMeta,
      item_no: get(row, "項番"),
      medical_institution_no: medicalNo,
      branch_no: branchNo,
      medical_institution_symbol_no: get(row, "医療機関記号番号"),
      corporation_name: corporationName,
      hospital_name: hospitalName,
      full_name: fullName,
      postal_code: postal(get(row, "医療機関所在地（郵便番号）")),
      address,
      phone: get(row, "電話番号"),
      fax: get(row, "FAX番号"),
      ...parseBeds(get(row, "病床数")),
      standard_name: get(row, "受理届出名称"),
      standard_code: get(row, "受理記号"),
      acceptance_no: get(row, "受理番号"),
      start_date_jp: startDate,
      start_date_iso: dateIso(startDate),
      ...dateParts(startDate),
      individual_valid_start_date_jp: validStartDate,
      individual_valid_start_date_iso: dateIso(validStartDate),
      remarks_heading: get(row, "備考（見出し）"),
      remarks_data: get(row, "備考（データ）"),
      municipality_code: get(row, "市町村コード"),
      municipality_name: get(row, "市町村名"),
      type_code: get(row, "種別コード"),
      type: get(row, "種別"),
      latitude: "",
      longitude: "",
      geocode_title: "",
      geocode_source: "",
    };
    outputRows.push(rowObject);
    facilityKeys.add(facilityKey(rowObject));
  }

  return { rows: outputRows, facility_count: facilityKeys.size };
}

function normalizeAddressForQuery(prefecture, address) {
  const normalized = text(address).replace(/[ 　]+/g, "").replace(/[－ー―]/g, "-");
  if (!normalized) return "";
  return normalized.startsWith(prefecture) ? normalized : `${prefecture || ""}${normalized}`;
}

async function geocodeRows(rows) {
  const facilityQueries = new Map();
  const queryResults = new Map();
  for (const row of rows) {
    const key = facilityKey(row);
    if (!facilityQueries.has(key)) facilityQueries.set(key, normalizeAddressForQuery(row.prefecture, row.address));
  }

  const queries = [...new Set([...facilityQueries.values()].filter(Boolean))];
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    setStatus(`ジオコーディング中: ${index + 1} / ${queries.length} 医療機関住所`, 55 + Math.round(((index + 1) / Math.max(queries.length, 1)) * 40));
    let result = { geocode_source: "gsi-address-search:no-result" };
    try {
      const response = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`);
      if (response.ok) {
        const first = (await response.json())?.[0];
        const coords = first?.geometry?.coordinates;
        if (Array.isArray(coords) && coords.length >= 2) {
          result = { longitude: coords[0], latitude: coords[1], geocode_title: first?.properties?.title || "", geocode_source: "gsi-address-search" };
        }
      } else {
        result = { geocode_source: `gsi-address-search:http-${response.status}` };
      }
    } catch (error) {
      result = { geocode_source: `gsi-address-search:error:${error.message}` };
    }
    queryResults.set(query, result);
    await sleep(GEOCODE_DELAY_MS);
  }

  for (const row of rows) Object.assign(row, queryResults.get(facilityQueries.get(facilityKey(row))) || {});
}

function facilityKey(row) {
  return [row.medical_institution_no, row.branch_no, row.postal_code, row.address, row.full_name].join("|");
}

function usedColumns(rows, columns) {
  return rows.length ? columns.filter((column) => rows.some((row) => text(row[column]) !== "")) : columns;
}

function csvEscape(value) {
  const raw = String(value ?? "");
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function toCsv(rows, candidateColumns) {
  const columns = usedColumns(rows, candidateColumns);
  return "\uFEFF" + [columns.join(","), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))].join("\r\n");
}

function buildWideRows(rows) {
  const facilities = new Map();
  const standardNames = [];
  const standardSet = new Set();
  for (const row of rows) {
    const key = facilityKey(row);
    if (!facilities.has(key)) {
      const facility = {};
      for (const column of FACILITY_COLUMNS) facility[column] = row[column] || "";
      facilities.set(key, facility);
    }
    if (!row.standard_name) continue;
    if (!standardSet.has(row.standard_name)) {
      standardSet.add(row.standard_name);
      standardNames.push(row.standard_name);
    }
    facilities.get(key)[row.standard_name] = row.standard_name;
  }
  return { rows: [...facilities.values()], standardNames };
}

function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
