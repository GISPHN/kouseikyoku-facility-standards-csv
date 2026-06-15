const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 3000);
const BUNDLED_PYTHON = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
const PYTHON_BIN = process.env.PYTHON_BIN || (fs.existsSync(BUNDLED_PYTHON) ? BUNDLED_PYTHON : "python");
const GEOCODE_DELAY_MS = Number(process.env.GEOCODE_DELAY_MS || 120);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 80 * 1024 * 1024);

const PUBLIC_DIR = path.join(__dirname, "public");
const PARSER_PATH = path.join(__dirname, "scripts", "parse_pdf.py");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), {
    "content-type": "application/json; charset=utf-8",
  });
}

function safeJoin(base, target) {
  const resolved = path.resolve(base, "." + decodeURIComponent(target));
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        reject(new Error("PDFが大きすぎます。MAX_UPLOAD_BYTESを増やしてください。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!boundaryMatch) throw new Error("multipart boundaryが見つかりません。");
  const boundary = Buffer.from("--" + (boundaryMatch[1] || boundaryMatch[2]));
  const fields = {};
  let file = null;
  let offset = 0;

  while (true) {
    const start = buffer.indexOf(boundary, offset);
    if (start === -1) break;
    const next = buffer.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    let partStart = start + boundary.length;
    if (buffer[partStart] === 45 && buffer[partStart + 1] === 45) break;
    if (buffer[partStart] === 13 && buffer[partStart + 1] === 10) partStart += 2;

    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), partStart);
    if (headerEnd === -1 || headerEnd > next) {
      offset = next;
      continue;
    }

    const headerText = buffer.slice(partStart, headerEnd).toString("utf8");
    let data = buffer.slice(headerEnd + 4, next);
    if (data.length >= 2 && data[data.length - 2] === 13 && data[data.length - 1] === 10) {
      data = data.slice(0, -2);
    }

    const disposition = /content-disposition:[^\r\n]+/i.exec(headerText)?.[0] || "";
    const name = /name="([^"]+)"/i.exec(disposition)?.[1];
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    if (filename) {
      file = { name, filename, data };
    } else if (name) {
      fields[name] = data.toString("utf8");
    }
    offset = next;
  }

  return { fields, file };
}

function runParser(pdfPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [PARSER_PATH, pdfPath, "--json"], {
      cwd: __dirname,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `PDF parser exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`PDF parserのJSONを読めませんでした: ${error.message}`));
      }
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddressForQuery(prefecture, address) {
  const text = String(address || "")
    .replace(/[ 　]+/g, "")
    .replace(/[－―‐]/g, "-")
    .trim();
  if (!text) return "";
  return text.startsWith(prefecture) ? text : `${prefecture}${text}`;
}

async function geocodeRows(rows) {
  const cache = new Map();
  for (const row of rows) {
    const query = normalizeAddressForQuery(row.prefecture || "大阪府", row.address);
    if (!query) continue;
    if (!cache.has(query)) {
      const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`;
      let result = {};
      try {
        const response = await fetch(url, {
          headers: { "user-agent": "kouseikyoku-facility-standards-csv/0.1" },
        });
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
          } else {
            result = { geocode_source: "gsi-address-search:no-result" };
          }
        } else {
          result = { geocode_source: `gsi-address-search:http-${response.status}` };
        }
      } catch (error) {
        result = { geocode_source: `gsi-address-search:error:${error.message}` };
      }
      cache.set(query, result);
      await sleep(GEOCODE_DELAY_MS);
    }
    Object.assign(row, cache.get(query));
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
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(","));
  }
  return "\uFEFF" + lines.join("\r\n");
}

async function handleConvert(req, res) {
  let tempDir = null;
  try {
    const body = await readBody(req);
    const { fields, file } = parseMultipart(body, req.headers["content-type"]);
    if (!file?.data?.length) {
      sendJson(res, 400, { error: "PDFファイルを選択してください。" });
      return;
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kouseikyoku-pdf-"));
    const pdfPath = path.join(tempDir, "upload.pdf");
    fs.writeFileSync(pdfPath, file.data);

    const parsed = await runParser(pdfPath);
    const rows = parsed.rows || [];
    if (fields.geocode === "true") {
      await geocodeRows(rows);
    }

    const csv = toCsv(rows.map((row) => ({ ...row, source_file: file.filename || "upload.pdf" })));
    const basename = path.basename(file.filename || "kouseikyoku.csv", path.extname(file.filename || ""));
    send(res, 200, csv, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${encodeURIComponent(basename)}.csv"`,
      "x-record-count": String(parsed.facility_count || 0),
      "x-row-count": String(rows.length),
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  } finally {
    if (tempDir) fs.rm(tempDir, { recursive: true, force: true }, () => {});
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/convert") {
    handleConvert(req, res);
    return;
  }

  if (req.method !== "GET") {
    send(res, 405, "Method Not Allowed");
    return;
  }

  const requestPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = safeJoin(PUBLIC_DIR, requestPath);
  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not Found");
      return;
    }
    send(res, 200, data, { "content-type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" });
  });
});

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
  console.log(`PYTHON_BIN=${PYTHON_BIN}`);
});
