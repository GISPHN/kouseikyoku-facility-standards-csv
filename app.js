import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs";

const form = document.querySelector("#convertForm");
const fileInput = document.querySelector("#pdfFile");
const fileName = document.querySelector("#fileName");
const geocodeInput = document.querySelector("#geocode");
const geocodeDelayInput = document.querySelector("#geocodeDelay");
const statusBox = document.querySelector("#status");
const progress = document.querySelector("#progress");
const submitButton = document.querySelector("#submitButton");

const CODE_RE = /^(（[^）]+）第[^\s〒]+?号)(.*)$/u;
const DATE_RE = /^((?:令和|平成|昭和)(?:元|\s*\d+)?年\s*\d{1,2}月\s*\d{1,2}日)(.*)$/u;
const POSTAL_RE = /〒\s*([0-9０-９]{3})[－ー―‐-]\s*([0-9０-９]{4})/u;
const PHONE_RE = /(\d{2,5}-\d{1,4}-\d{3,4})/u;
const FAX_RE = /\((\d{2,5}-\d{1,4}-\d{3,4})\)/u;
const PAREN_PHONE_RE = /(\d{2,5})\((\d{1,4})\)(\d{3,4})/u;
const PAREN_FAX_RE = /\((\d{2,5})\((\d{1,4})\)(\d{3,4})\)/u;
const NUMBER_RE = /^(\d+)\s+(\d{2}-\d{5})/u;
const COMMA_NUMBER_RE = /^(\d+)\s+([0-9０-９]{2,3}[,，][0-9０-９]{3,4}[,，][0-9０-９])/u;
const BRANCH_RE = /^\((\d{2}-\d{5})\s*\)/u;
const COMMA_BRANCH_RE = /^\(([0-9０-９]{2,3}[,，][0-9０-９]{3,4}[,，][0-9０-９])\s*\)/u;
const BED_RE = /^(一般(?:（感染）)?|療養|精神|結核|感染|その他|一般・療養|一般及び療養)[\s　]*([\d,，]+)$/u;
const BED_TYPE_RE = /^(一般(?:（感染）)?|療養|精神|結核|感染|その他|一般・療養|一般及び療養)$/u;
const COUNT_RE = /^[\d,，]+$/u;
const PREF_RE = /届出受理医療機関名簿\[\s*([^\]\s]+)\s*\]/u;
const PREF_FALLBACK_RE = /\[\s*([^\]\s]+府|[^\]\s]+県|[^\]\s]+都|[^\]\s]+道)\s*\]/u;
const AS_OF_RE = /\[\s*(令和\s*\d+年\s*\d+月\s*\d+日)\s*現在/u;
const CREATED_RE = /(令和\s*\d+年\s*\d+月\s*\d+日)\s*作成/u;

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

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileName.textContent = file ? file.name : "厚生局公開の届出受理医療機関名簿PDF";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;

  submitButton.disabled = true;
  progress.hidden = false;
  progress.value = 0;

  try {
    setStatus("PDFを読み込んでいます。", 0);
    const buffer = await file.arrayBuffer();
    const parsed = await parsePdf(buffer);
    const rows = parsed.rows.map((row) => ({ ...row, source_file: file.name || "upload.pdf" }));

    if (geocodeInput.checked) {
      const delayMs = Math.max(0, Number(geocodeDelayInput.value || 120));
      await geocodeRows(rows, delayMs);
    }

    const csv = toCsv(rows);
    downloadCsv(csv, file.name.replace(/\.pdf$/i, ".csv") || "kouseikyoku.csv");
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

function normalizeSpaces(text) {
  return String(text || "").replace(/[ 　]+/g, "　").replace(/^[ 　]+|[ 　]+$/g, "");
}

function cleanLine(line) {
  return String(line || "")
    .replace(/\u00a0/g, " ")
    .replace(/－/g, "-")
    .trim();
}

function toHalfWidthDigits(text) {
  return String(text || "").replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

function normalizeMedicalInstitutionNo(value) {
  const text = toHalfWidthDigits(value);
  if (text.includes(",") || text.includes("，")) {
    const digits = text.replace(/\D/g, "");
    if (digits.length >= 7) return `${digits.slice(0, 2)}-${digits.slice(2, 7)}`;
  }
  return text;
}

function parseNumberLine(line) {
  const standard = NUMBER_RE.exec(line);
  if (standard) {
    return {
      item_no: standard[1],
      medical_institution_no: normalizeMedicalInstitutionNo(standard[2]),
    };
  }
  const comma = COMMA_NUMBER_RE.exec(line);
  if (comma) {
    return {
      item_no: comma[1],
      medical_institution_no: normalizeMedicalInstitutionNo(comma[2]),
    };
  }
  return null;
}

function parseBranchLine(line) {
  const standard = BRANCH_RE.exec(line);
  if (standard) return normalizeMedicalInstitutionNo(standard[1]);
  const comma = COMMA_BRANCH_RE.exec(line);
  if (comma) return normalizeMedicalInstitutionNo(comma[1]);
  return "";
}

function normalizeCount(value) {
  return toHalfWidthDigits(value).replace(/[，,]/g, "");
}

function normalizePhoneParts(match) {
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function findPhone(line) {
  const hyphen = PHONE_RE.exec(line);
  if (hyphen) return { index: hyphen.index, value: hyphen[1] };
  const paren = PAREN_PHONE_RE.exec(line);
  if (paren && line[paren.index - 1] !== "(") return { index: paren.index, value: normalizePhoneParts(paren) };
  return null;
}

function findFax(line) {
  const hyphen = FAX_RE.exec(line);
  if (hyphen) return hyphen[1];
  const paren = PAREN_FAX_RE.exec(line);
  if (paren) return normalizePhoneParts(paren);
  return "";
}

function shouldSkip(line) {
  return (
    !line ||
    line.startsWith("届出受理医療機関名簿") ||
    line.startsWith("全医療機関出力") ||
    line.startsWith("[ 令和") ||
    line.startsWith("病床数") ||
    line.startsWith("電話番号")
  );
}

function splitTokens(rawLine) {
  let line = cleanLine(rawLine);
  if (shouldSkip(line)) return [];

  const tokens = [];
  while (line) {
    const postal = POSTAL_RE.exec(line);
    if (postal && postal.index > 0) {
      tokens.push(...splitTokens(line.slice(0, postal.index)));
      line = line.slice(postal.index);
      continue;
    }

    const code = CODE_RE.exec(line);
    if (code) {
      tokens.push(code[1].trim());
      line = code[2].trim();
      continue;
    }

    const date = DATE_RE.exec(line);
    if (date) {
      tokens.push(date[1].replace(/\s+/g, " ").trim());
      line = date[2].trim();
      continue;
    }

    tokens.push(line);
    break;
  }

  return tokens.filter(Boolean);
}

async function parsePdf(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const rows = [];
  let facilities = 0;
  const sourceMeta = { prefecture: "", as_of_date: "", created_date: "" };
  let pendingStandards = [];
  let pendingDates = [];
  let record = null;
  let stage = "scan";

  const finalizeCurrent = () => {
    if (record && record.name_lines?.length) {
      rows.push(...buildRows(record, sourceMeta));
      facilities += 1;
    }
    record = null;
    stage = "scan";
  };

  const startRecord = (postalLine, pageNo) => {
    const postal = POSTAL_RE.exec(postalLine);
    record = {
      page: pageNo,
      postal_code: postal ? `${postal[1]}-${postal[2]}` : "",
      standards: pendingStandards,
      dates: pendingDates,
      address_lines: [],
      name_lines: [],
    };
    pendingStandards = [];
    pendingDates = [];
    const rest = postal ? postalLine.slice(postal.index + postal[0].length).trim() : "";
    if (rest) record.address_lines.push(rest);
    stage = "address";
  };

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    let pageHadRecordStart = false;
    setStatus(`PDF解析中: ${pageNo} / ${pdf.numPages} ページ`, Math.round((pageNo / pdf.numPages) * 55));
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });

    // This specific MHLW/Kouseikyoku PDF is internally ordered by logical columns.
    // Using visual line reconstruction merges facility columns with notification columns,
    // so keep PDF.js text item order here.
    const allItems = content.items.map((item) => item.str || "");
    const rawItems = content.items
      .filter((item) => (item.transform?.[4] ?? 0) >= 110)
      .map((item) => ({
        text: item.str || "",
        row: item.transform?.[4] ?? 0,
      }));
    const pageText = allItems.join("");

    if (!sourceMeta.prefecture) {
      const pref = PREF_RE.exec(pageText) || PREF_FALLBACK_RE.exec(pageText);
      if (pref) sourceMeta.prefecture = pref[1];
    }
    if (!sourceMeta.as_of_date) {
      const asOf = AS_OF_RE.exec(pageText);
      if (asOf) sourceMeta.as_of_date = normalizeSpaces(asOf[1]);
    }
    if (!sourceMeta.created_date) {
      const created = CREATED_RE.exec(pageText);
      if (created) sourceMeta.created_date = normalizeSpaces(created[1]);
    }

    const tokens = rawItems.flatMap((item) => splitTokens(item.text).map((line) => ({ line, row: item.row })));
    const firstPostalRow = tokens.find((token) => POSTAL_RE.test(token.line))?.row ?? Number.POSITIVE_INFINITY;
    for (const token of tokens) {
      const { line, row } = token;
      if (POSTAL_RE.test(line)) {
        if (record) finalizeCurrent();
        startRecord(line, pageNo);
        pageHadRecordStart = true;
        continue;
      }

      if (CODE_RE.test(line)) {
        if (!pageHadRecordStart && row < firstPostalRow) {
          if (record && stage === "name") record.standards.push(parseCode(line));
          continue;
        }
        if (record && stage === "name") finalizeCurrent();
        pendingStandards.push(parseCode(line));
        continue;
      }

      if (DATE_RE.test(line)) {
        if (!pageHadRecordStart && row < firstPostalRow) {
          if (record && stage === "name" && record.standards.length > record.dates.length) record.dates.push(line);
          continue;
        }
        if (record && stage === "name") finalizeCurrent();
        if (pendingStandards.length > 0 && pendingDates.length < pendingStandards.length) {
          pendingDates.push(line);
        }
        continue;
      }

      if (!record) continue;

      if (stage === "address") {
        const phone = findPhone(line);
        if (phone) {
          const before = line.slice(0, phone.index).trim();
          if (before) record.address_lines.push(before);
          record.phone = phone.value;
          const fax = findFax(line);
          if (fax) record.fax = fax;
          stage = "number";
        } else {
          record.address_lines.push(line);
        }
        continue;
      }

      if (stage === "number") {
        const number = parseNumberLine(line);
        if (number) {
          record.item_no = number.item_no;
          record.medical_institution_no = number.medical_institution_no;
          stage = "name";
        } else {
          const fax = findFax(line);
          if (fax) {
            record.fax = fax;
            continue;
          }
          const branch = parseBranchLine(line);
          if (branch) record.branch_no = branch;
        }
        continue;
      }

      if (stage === "name") {
        const branch = BRANCH_RE.exec(line);
        const branchNo = parseBranchLine(line);
        if (branchNo && !record.branch_no) {
          record.branch_no = branchNo;
          continue;
        }
        const bed = BED_RE.exec(line.replace(/　/g, " "));
        if (bed) {
          record.bed_type = bed[1];
          record.bed_count = normalizeCount(bed[2]);
          continue;
        }
        if (record.pending_bed_type && COUNT_RE.test(line)) {
          record.bed_type = record.pending_bed_type;
          record.bed_count = normalizeCount(line);
          delete record.pending_bed_type;
          continue;
        }
        if (BED_TYPE_RE.test(line)) {
          record.pending_bed_type = line;
          continue;
        }
        if (record.pending_bed_type) {
          record.name_lines.push(record.pending_bed_type);
          delete record.pending_bed_type;
        }
        record.name_lines.push(line);
      }
    }

    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  finalizeCurrent();
  return { facility_count: facilities, rows };
}

function parseCode(line) {
  const match = /^（([^）]+)）第(.+?)号$/u.exec(line);
  if (!match) return { standard_code: line, acceptance_no: "" };
  return { standard_code: match[1], acceptance_no: match[2] };
}

function splitName(fullName) {
  const name = normalizeSpaces(fullName);
  const compact = name.replace(/　/g, "");
  for (const form of LEGAL_FORMS) {
    if (!compact.startsWith(form)) continue;
    const pieces = name.split(/[ 　]+/u).filter(Boolean);
    if (pieces.length >= 2) return [normalizeSpaces(pieces.slice(0, -1).join("　")), pieces.at(-1)];
    const rest = compact.slice(form.length);
    if (["国立研究開発法人", "国立大学法人", "公立大学法人", "地方独立行政法人", "独立行政法人"].includes(form) && rest) {
      return [form, rest];
    }
    for (const suffix of ["会", "會", "財団", "社団"]) {
      const suffixIndex = rest.indexOf(suffix);
      if (suffixIndex > 0 && suffixIndex + 1 < rest.length) {
        return [form + rest.slice(0, suffixIndex + 1), rest.slice(suffixIndex + 1)];
      }
    }
    if (form.includes("法人") && rest) {
      return [form, rest];
    }
    return ["", name];
  }
  return ["", name];
}

function buildRows(record, sourceMeta) {
  const fullName = normalizeSpaces((record.name_lines || []).join(""));
  const [corporationName, hospitalName] = splitName(fullName);
  const standards = record.standards?.length ? record.standards : [{ standard_code: "", acceptance_no: "" }];
  const dates = record.dates || [];

  return standards.map((standard, index) => {
    const startDate = dates[index] || "";
    return {
      ...sourceMeta,
      page: record.page || "",
      item_no: record.item_no || "",
      medical_institution_no: record.medical_institution_no || "",
      branch_no: record.branch_no || "",
      corporation_name: corporationName,
      hospital_name: hospitalName,
      full_name: fullName,
      postal_code: record.postal_code || "",
      address: normalizeSpaces((record.address_lines || []).join("")),
      phone: record.phone || "",
      fax: record.fax || "",
      bed_type: record.bed_type || "",
      bed_count: record.bed_count || "",
      standard_code: standard.standard_code || "",
      acceptance_no: standard.acceptance_no || "",
      start_date_jp: startDate,
      start_date_iso: dateToIso(startDate),
      latitude: "",
      longitude: "",
      geocode_title: "",
      geocode_source: "",
    };
  });
}

function eraToYear(era, yearText) {
  const year = yearText.trim() === "元" ? 1 : Number(yearText);
  return { 令和: 2018, 平成: 1988, 昭和: 1925 }[era] + year;
}

function dateToIso(dateText) {
  const match = /(令和|平成|昭和)\s*(元|\d+)年\s*(\d+)月\s*(\d+)日/u.exec(dateText || "");
  if (!match) return "";
  return `${eraToYear(match[1], match[2])}-${String(Number(match[3])).padStart(2, "0")}-${String(Number(match[4])).padStart(2, "0")}`;
}

function normalizeAddressForQuery(prefecture, address) {
  const text = String(address || "").replace(/[ 　]+/g, "").replace(/[－―‐]/g, "-").trim();
  if (!text) return "";
  return text.startsWith(prefecture) ? text : `${prefecture || "大阪府"}${text}`;
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
      facilityQueries.set(facilityKey, normalizeAddressForQuery(row.prefecture || "大阪府", row.address));
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
    "prefecture",
    "as_of_date",
    "created_date",
    "page",
    "item_no",
    "medical_institution_no",
    "branch_no",
    "corporation_name",
    "hospital_name",
    "full_name",
    "postal_code",
    "address",
    "phone",
    "fax",
    "bed_type",
    "bed_count",
    "standard_code",
    "acceptance_no",
    "start_date_jp",
    "start_date_iso",
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
