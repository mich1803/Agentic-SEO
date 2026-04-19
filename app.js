const OUTPUT_FIELDS = {
  article: ["Descrizione-HTML", "Istruzioni-HTML", "Dettagli-HTML", "Descrizione_Tag", "Titolo_Tag", "Parole_Chiave"],
  category: ["Categoria-HTML", "Alt_Categoria-HTML"],
};

const INPUT_ORDER = {
  article: ["Codice_Articolo", "Nome", "Brand", "Categoria_1", "Categoria_2", "Categoria_3", "Descrizione", "Scheda_Tecnica"],
  category: ["Categoria_1", "Categoria_2", "Categoria_3", "Brand", "Descrizione"],
};

const sections = {
  home: document.getElementById("home"),
  article: document.getElementById("article-section"),
  category: document.getElementById("category-section"),
  status: document.getElementById("status"),
};

const statusText = document.getElementById("status-text");
const progressBar = document.getElementById("progress-bar");
const statusSpinner = document.getElementById("status-spinner");
const downloadOutputBtn = document.getElementById("download-output");

document.querySelectorAll("button[data-target]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.target;
    sections.home.classList.add("hidden");
    sections[target.includes("article") ? "article" : "category"].classList.remove("hidden");
  });
});

document.querySelectorAll(".back").forEach((btn) => {
  btn.addEventListener("click", () => {
    sections.article.classList.add("hidden");
    sections.category.classList.add("hidden");
    sections.status.classList.add("hidden");
    sections.home.classList.remove("hidden");
  });
});

document.getElementById("article-form").addEventListener("submit", (e) => handleSubmit(e, "article"));
document.getElementById("category-form").addEventListener("submit", (e) => handleSubmit(e, "category"));

async function handleSubmit(event, mode) {
  event.preventDefault();

  if (!window.XLSX) {
    alert("La libreria XLSX non è stata caricata. Verifica la connessione internet e ricarica la pagina.");
    return;
  }

  const form = event.currentTarget;
  const model = form.model.value;
  const apiKey = form.apiKey.value.trim();
  const file = form.file.files[0];

  if (!apiKey || !file) {
    alert("Compila tutti i campi richiesti.");
    return;
  }

  const [systemPrompt, promptTemplate] = await Promise.all([
    fetchText(`${mode}/${mode}_system_prompt.txt`),
    fetchText(`${mode}/${mode}_prompt.txt`),
  ]);

  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const ws = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });

  if (!rows.length) {
    alert("Il file Excel è vuoto.");
    return;
  }

  sections.status.classList.remove("hidden");
  statusSpinner.classList.remove("hidden");
  downloadOutputBtn.classList.add("hidden");
  downloadOutputBtn.removeAttribute("href");
  downloadOutputBtn.removeAttribute("download");

  const headers = rows[0].map((v) => String(v || "").trim());
  const headerIndex = new Map(headers.map((h, i) => [h, i]));
  ensureOutputColumns(rows, headerIndex, mode);

  const totalRows = Math.max(rows.length - 1, 0);
  let processed = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    if (isEmptyRow(row)) {
      processed++;
      updateProgress(processed, totalRows);
      continue;
    }

    const rowObj = {};
    for (const [key, idx] of headerIndex.entries()) {
      rowObj[key] = (row[idx] ?? "").toString().trim();
    }

    if (rowObj.Descrizione && isLikelyUrlOnly(rowObj.Descrizione)) {
      rowObj.Descrizione = await fetchUrlText(rowObj.Descrizione);
    }
    if (rowObj.Scheda_Tecnica && isLikelyUrlOnly(rowObj.Scheda_Tecnica)) {
      rowObj.Scheda_Tecnica = await fetchUrlText(rowObj.Scheda_Tecnica);
    }

    const userPrompt = buildPrompt(mode, promptTemplate, rowObj);

    let parsed;
    try {
      parsed = await callOpenAI({ model, apiKey, systemPrompt, userPrompt });
    } catch (err) {
      parsed = { OUTPUT: {} };
      console.error(`Errore riga ${r + 1}:`, err);
    }

    for (const field of OUTPUT_FIELDS[mode]) {
      const value = (parsed.OUTPUT?.[field] ?? "").toString();
      const outIdx = headerIndex.get(field);
      const lenIdx = headerIndex.get(`len(${field})`);
      row[outIdx] = value;
      row[lenIdx] = value.length;
    }

    rows[r] = row;
    processed++;
    updateProgress(processed, totalRows);
  }

  const outWs = XLSX.utils.aoa_to_sheet(rows);
  workbook.Sheets[sheetName] = outWs;

  const outputName = `${mode}_output_${Date.now()}.xlsx`;
  const outArray = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  const outBlob = new Blob([outArray], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const outUrl = URL.createObjectURL(outBlob);

  if (downloadOutputBtn.dataset.objectUrl) {
    URL.revokeObjectURL(downloadOutputBtn.dataset.objectUrl);
  }

  downloadOutputBtn.href = outUrl;
  downloadOutputBtn.download = outputName;
  downloadOutputBtn.dataset.objectUrl = outUrl;
  downloadOutputBtn.classList.remove("hidden");
  statusSpinner.classList.add("hidden");
  statusText.textContent = "Completato. File generato.";
}

async function callOpenAI({ model, apiKey, systemPrompt, userPrompt }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${txt}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content || "{}";
  return safeParseJson(content);
}

function safeParseJson(content) {
  const cleaned = content.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    return { OUTPUT: {} };
  }
}

function buildPrompt(mode, promptTemplate, rowObj) {
  const pairs = INPUT_ORDER[mode]
    .map((key) => ({ key, value: (rowObj[key] || "").trim() }))
    .filter(({ value }) => value.length > 0)
    .map(({ key, value }) => `- (${key}) ${value}`)
    .join("\n");

  return promptTemplate.replace("{{INPUT_BLOCK}}", pairs || "- Nessun dato disponibile");
}

async function fetchText(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Impossibile leggere il file: ${path}`);
  }
  return response.text();
}

function ensureOutputColumns(rows, headerIndex, mode) {
  const headers = rows[0];
  for (const field of OUTPUT_FIELDS[mode]) {
    addHeaderIfMissing(headers, headerIndex, field);
    addHeaderIfMissing(headers, headerIndex, `len(${field})`);
  }

  for (let i = 1; i < rows.length; i++) {
    rows[i] ||= [];
    rows[i].length = headers.length;
  }
}

function addHeaderIfMissing(headers, headerIndex, name) {
  if (!headerIndex.has(name)) {
    headers.push(name);
    headerIndex.set(name, headers.length - 1);
  }
}

function isEmptyRow(row) {
  return row.every((v) => !v || !String(v).trim());
}

function isLikelyUrlOnly(text) {
  const t = String(text).trim();
  return /^https?:\/\//i.test(t);
}

async function fetchUrlText(url) {
  try {
    // Normalizza URL (aggiunge https se manca)
    let normalizedUrl = url.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    // Costruzione endpoint Jina senza rompere il protocollo
    const response = await fetch(`https://r.jina.ai/${normalizedUrl}`);

    if (!response.ok) {
      return url;
    }

    const text = (await response.text()).trim();

    // Fallback se contenuto vuoto
    if (!text) {
      return url;
    }

    // Limite sicurezza lunghezza
    return text.slice(0, 12000);

  } catch (error) {
    return url;
  }
}

function updateProgress(processed, total) {
  const pct = total === 0 ? 100 : Math.round((processed / total) * 100);
  progressBar.style.width = `${pct}%`;
  statusText.textContent = `Righe processate: ${processed}/${total} (${pct}%)`;
}
