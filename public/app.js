const form = document.querySelector("#convertForm");
const fileInput = document.querySelector("#pdfFile");
const fileName = document.querySelector("#fileName");
const geocodeInput = document.querySelector("#geocode");
const statusBox = document.querySelector("#status");
const progress = document.querySelector("#progress");
const submitButton = document.querySelector("#submitButton");

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileName.textContent = file ? file.name : "厚生局公開の届出受理医療機関名簿PDF";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;

  const body = new FormData();
  body.append("pdf", file);
  body.append("geocode", geocodeInput.checked ? "true" : "false");

  submitButton.disabled = true;
  progress.hidden = false;
  progress.removeAttribute("value");
  statusBox.textContent = geocodeInput.checked
    ? "PDFを解析し、住所をジオコーディングしています。件数が多いPDFでは数分かかります。"
    : "PDFを解析しています。";

  try {
    const response = await fetch("/api/convert", {
      method: "POST",
      body,
    });

    if (!response.ok) {
      let message = `変換に失敗しました (${response.status})`;
      try {
        const payload = await response.json();
        if (payload.error) message = payload.error;
      } catch (_) {
        // Keep the HTTP status message.
      }
      throw new Error(message);
    }

    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const match = /filename="([^"]+)"/.exec(disposition);
    const downloadName = match ? decodeURIComponent(match[1]) : file.name.replace(/\.pdf$/i, ".csv");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = downloadName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    const facilityCount = response.headers.get("x-record-count");
    const rowCount = response.headers.get("x-row-count");
    statusBox.textContent = `${facilityCount || "-"}医療機関、${rowCount || "-"}行のCSVを作成しました。`;
  } catch (error) {
    statusBox.textContent = error.message;
  } finally {
    submitButton.disabled = false;
    progress.hidden = true;
  }
});
