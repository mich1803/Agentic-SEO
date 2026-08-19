const OUTPUT_FIELDS = {
  article: [
    { column: "Descrizione-HTML", jsonKey: "Descrizione-HTML" },
    { column: "Istruzioni-HTML", jsonKey: "Istruzioni-HTML" },
    { column: "Dettagli-HTML", jsonKey: "Dettagli-HTML" },
    { column: "Descrizione_Tag", jsonKey: "Descrizione_Tag" },
    { column: "Titolo_Tag", jsonKey: "Titolo_Tag" },
    { column: "Parole_Chiave", jsonKey: "Parole_Chiave" },
  ],
  category: [
    { column: "Categoria-HTML", jsonKey: "Descrizione" },
    { column: "Descrizione Tag", jsonKey: "Descrizione Tag" },
    { column: "Titolo Tag", jsonKey: "Titolo Tag" },
  ],
};

const INPUT_ORDER = {
  article: ["Codice_Articolo", "Nome", "Brand", "Categoria_1", "Categoria_2", "Categoria_3", "Descrizione", "Scheda_Tecnica"],
  category: ["Categoria_1", "Categoria_2", "Categoria_3", "Brand", "Descrizione", "Scheda_Tecnica", "Informazioni"],
};

const URL_SOURCE_FIELDS = {
  article: ["Descrizione", "Scheda_Tecnica"],
  category: ["Descrizione", "Scheda_Tecnica", "Informazioni"],
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
const generationLog = document.getElementById("generation-log");
const clearLogBtn = document.getElementById("clear-log");

clearLogBtn.addEventListener("click", resetLog);

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

  sections.status.classList.remove("hidden");
  statusSpinner.classList.remove("hidden");
  downloadOutputBtn.classList.add("hidden");
  downloadOutputBtn.removeAttribute("href");
  downloadOutputBtn.removeAttribute("download");
  progressBar.style.width = "0%";
  resetLog();

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  addLog(`Avvio generazione ${mode === "category" ? "categorie" : "articoli"} con ${model}.`);

  try {
    addLog("Caricamento dei prompt...");
    const [systemPrompt, promptTemplate] = await Promise.all([
      fetchText(`${mode}/${mode}_system_prompt.txt`),
      fetchText(`${mode}/${mode}_prompt.txt`),
    ]);
    addLog("Prompt caricati.", "success");

    addLog(`Lettura del file ${file.name}...`);
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    const ws = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });

    if (!rows.length) {
      throw new Error("Il file Excel è vuoto.");
    }

    const headers = rows[0].map((v) => String(v || "").trim());
    const headerIndex = new Map(headers.map((h, i) => [h, i]));
    ensureOutputColumns(rows, headerIndex, mode);

    const totalRows = Math.max(rows.length - 1, 0);
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    updateProgress(0, totalRows);
    addLog(`Foglio “${sheetName}”: ${totalRows} righe da controllare.`);

    for (let r = 1; r < rows.length; r++) {
      const excelRow = r + 1;
      const row = rows[r] || [];
      if (isEmptyRow(row)) {
        skipped++;
        processed++;
        addLog(`Riga ${excelRow}: vuota, ignorata.`, "warning");
        updateProgress(processed, totalRows);
        continue;
      }

      const rowObj = {};
      for (const [key, idx] of headerIndex.entries()) {
        rowObj[key] = (row[idx] ?? "").toString().trim();
      }

      addLog(`Riga ${excelRow}: preparazione input.`);
      await Promise.all(
        URL_SOURCE_FIELDS[mode].map(async (field) => {
          if (rowObj[field] && isLikelyUrlOnly(rowObj[field])) {
            addLog(`Riga ${excelRow}: recupero fonte URL per “${field}”...`);
            const sourceUrl = rowObj[field];
            rowObj[field] = await fetchUrlText(sourceUrl);
            if (rowObj[field] === sourceUrl) {
              addLog(`Riga ${excelRow}: fonte “${field}” non leggibile; uso l'URL originale.`, "warning");
            } else {
              addLog(`Riga ${excelRow}: fonte “${field}” acquisita (${rowObj[field].length} caratteri).`, "success");
            }
          }
        }),
      );

      const userPrompt = buildPrompt(mode, promptTemplate, rowObj);

      try {
        addLog(`Riga ${excelRow}: invio richiesta a OpenAI...`);
        const parsed = await callOpenAI({
          mode,
          model,
          apiKey,
          systemPrompt,
          userPrompt,
          onLog: (message, level) => addLog(`Riga ${excelRow}: ${message}`, level),
        });
        validateOutput(mode, parsed);

        for (const { column, jsonKey } of OUTPUT_FIELDS[mode]) {
          const value = parsed.OUTPUT[jsonKey].toString();
          const outIdx = headerIndex.get(column);
          const lenIdx = headerIndex.get(`len(${column})`);
          row[outIdx] = value;
          row[lenIdx] = value.length;
          addLog(`Riga ${excelRow}: “${column}” generata (${value.length} caratteri).`, "success");
        }

        logLengthWarnings(mode, parsed, excelRow);
        succeeded++;
      } catch (err) {
        failed++;
        clearRowOutput(row, headerIndex, mode);
        console.error(`Errore riga ${excelRow}:`, err);
        addLog(`Riga ${excelRow}: ${formatError(err)}`, "error");
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

    const summary = `${succeeded} riuscite, ${failed} fallite${skipped ? `, ${skipped} ignorate` : ""}`;
    statusText.textContent = failed
      ? `Completato con errori: ${summary}.`
      : `Completato: ${summary}.`;
    addLog(`File ${outputName} pronto (${summary}).`, failed ? "warning" : "success");
  } catch (err) {
    console.error("Errore generazione:", err);
    statusText.textContent = "Generazione interrotta. Consulta il log.";
    addLog(formatError(err), "error");
  } finally {
    statusSpinner.classList.add("hidden");
    submitButton.disabled = false;
  }
}

async function callOpenAI({ mode, model, apiKey, systemPrompt, userPrompt, onLog = () => {} }) {
  if (mode === "category") {
    try {
      return await callOpenAIResponses({ model, apiKey, systemPrompt, userPrompt, useWebSearch: true });
    } catch (firstError) {
      if (isTerminalApiError(firstError)) {
        throw firstError;
      }

      onLog(`ricerca web non riuscita (${formatError(firstError)}). Nuovo tentativo senza ricerca web.`, "warning");
      try {
        return await callOpenAIResponses({ model, apiKey, systemPrompt, userPrompt, useWebSearch: false });
      } catch (secondError) {
        if (isTerminalApiError(secondError)) {
          throw secondError;
        }

        onLog(`Responses API non riuscita (${formatError(secondError)}). Fallback su Chat Completions.`, "warning");
        return callOpenAIChatCompletions({ model, apiKey, systemPrompt, userPrompt });
      }
    }
  }

  return callOpenAIChatCompletions({ model, apiKey, systemPrompt, userPrompt });
}

async function callOpenAIChatCompletions({ model, apiKey, systemPrompt, userPrompt }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    throw await buildOpenAIError(response);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content || "{}";
  return safeParseJson(content);
}

async function callOpenAIResponses({ model, apiKey, systemPrompt, userPrompt, useWebSearch }) {
  const requestBody = {
    model,
    instructions: systemPrompt,
    input: userPrompt,
    text: {
      format: {
        type: "json_schema",
        name: "category_content",
        strict: true,
        schema: {
          type: "object",
          properties: {
            OUTPUT: {
              type: "object",
              properties: {
                Descrizione: {
                  type: "string",
                  description: "Descrizione HTML completa della categoria.",
                },
                "Descrizione Tag": {
                  type: "string",
                  description: "Una sola frase SEO tra 150 e 220 caratteri.",
                },
                "Titolo Tag": {
                  type: "string",
                  description: "Titolo SEO naturale tra 45 e 65 caratteri.",
                },
              },
              required: ["Descrizione", "Descrizione Tag", "Titolo Tag"],
              additionalProperties: false,
            },
          },
          required: ["OUTPUT"],
          additionalProperties: false,
        },
      },
    },
  };

  if (useWebSearch) {
    requestBody.tools = [
      {
        type: "web_search",
        search_context_size: "low",
        user_location: {
          type: "approximate",
          country: "IT",
        },
      },
    ];
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    throw await buildOpenAIError(response);
  }

  const json = await response.json();
  const content = extractResponsesText(json);
  return safeParseJson(content);
}

function extractResponsesText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  for (const item of response.output || []) {
    for (const part of item.content || []) {
      if (part.type === "output_text" && typeof part.text === "string") {
        return part.text;
      }
    }
  }

  const refusal = (response.output || [])
    .flatMap((item) => item.content || [])
    .find((part) => part.type === "refusal")?.refusal;
  const detail = refusal || `stato risposta: ${response.status || "sconosciuto"}`;
  throw new Error(`La risposta OpenAI non contiene testo (${detail}).`);
}

function safeParseJson(content) {
  const cleaned = content.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // L'errore esplicito viene mostrato nel log della riga.
      }
    }
    throw new Error(`La risposta OpenAI non è un JSON valido: ${firstError.message}`);
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
  for (const { column } of OUTPUT_FIELDS[mode]) {
    addHeaderIfMissing(headers, headerIndex, column);
    addHeaderIfMissing(headers, headerIndex, `len(${column})`);
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

function resetLog() {
  generationLog.textContent = "";
}

function addLog(message, level = "info") {
  const labels = {
    info: "INFO",
    success: "OK",
    warning: "ATTENZIONE",
    error: "ERRORE",
  };
  const timestamp = new Date().toLocaleTimeString("it-IT");
  generationLog.textContent += `[${timestamp}] ${labels[level] || labels.info} ${message}\n`;
  generationLog.scrollTop = generationLog.scrollHeight;
}

function formatError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 900 ? `${message.slice(0, 900)}…` : message;
}

async function buildOpenAIError(response) {
  const rawBody = await response.text();
  let detail = rawBody;

  try {
    const parsed = JSON.parse(rawBody);
    detail = parsed.error?.message || parsed.message || rawBody;
  } catch {
    // Se il corpo non è JSON, viene mostrato il testo restituito dall'API.
  }

  const error = new Error(`OpenAI API ${response.status}: ${String(detail || response.statusText).slice(0, 700)}`);
  error.status = response.status;
  return error;
}

function isTerminalApiError(error) {
  return [401, 403, 429].includes(error?.status);
}

function validateOutput(mode, parsed) {
  if (!parsed || typeof parsed !== "object" || !parsed.OUTPUT || typeof parsed.OUTPUT !== "object") {
    throw new Error("La risposta OpenAI non contiene l'oggetto OUTPUT richiesto.");
  }

  const missing = OUTPUT_FIELDS[mode]
    .filter(({ jsonKey }) => !String(parsed.OUTPUT[jsonKey] ?? "").trim())
    .map(({ jsonKey }) => jsonKey);

  if (missing.length) {
    throw new Error(`Campi mancanti o vuoti nella risposta: ${missing.join(", ")}.`);
  }
}

function clearRowOutput(row, headerIndex, mode) {
  for (const { column } of OUTPUT_FIELDS[mode]) {
    row[headerIndex.get(column)] = "";
    row[headerIndex.get(`len(${column})`)] = 0;
  }
}

function logLengthWarnings(mode, parsed, excelRow) {
  if (mode !== "category") {
    return;
  }

  const descriptionLength = String(parsed.OUTPUT["Descrizione Tag"]).length;
  const titleLength = String(parsed.OUTPUT["Titolo Tag"]).length;

  if (descriptionLength < 150 || descriptionLength > 220) {
    addLog(`Riga ${excelRow}: “Descrizione Tag” fuori intervallo 150–220 (${descriptionLength}).`, "warning");
  }
  if (titleLength < 45 || titleLength > 65) {
    addLog(`Riga ${excelRow}: “Titolo Tag” fuori intervallo 45–65 (${titleLength}).`, "warning");
  }
}

function updateProgress(processed, total) {
  const pct = total === 0 ? 100 : Math.round((processed / total) * 100);
  progressBar.style.width = `${pct}%`;
  statusText.textContent = `Righe processate: ${processed}/${total} (${pct}%)`;
}
