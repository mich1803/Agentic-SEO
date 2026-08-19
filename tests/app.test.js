const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeElement() {
  return {
    classList: { add() {}, remove() {} },
    dataset: {},
    style: {},
    textContent: "",
    scrollHeight: 0,
    scrollTop: 0,
    addEventListener() {},
    removeAttribute() {},
  };
}

const elements = new Map();
const getElement = (id) => {
  if (!elements.has(id)) elements.set(id, makeElement());
  return elements.get(id);
};

const context = vm.createContext({
  Blob,
  console,
  Date,
  Error,
  JSON,
  Map,
  Math,
  Promise,
  Response,
  String,
  URL,
  alert() {},
  document: {
    getElementById: getElement,
    querySelectorAll() { return []; },
  },
  window: {},
});

const appPath = path.join(__dirname, "..", "app.js");
const source = `${fs.readFileSync(appPath, "utf8")}\n;globalThis.__app = { callOpenAI, safeParseJson, validateOutput };`;
vm.runInContext(source, context, { filename: appPath });

async function run() {
  const { callOpenAI, safeParseJson, validateOutput } = context.__app;

  assert.deepEqual(
    JSON.parse(JSON.stringify(safeParseJson('```json\n{"OUTPUT":{"x":"y"}}\n```'))),
    { OUTPUT: { x: "y" } },
  );
  assert.throws(() => safeParseJson("not-json"), /non è un JSON valido/);

  const validCategory = {
    OUTPUT: {
      Descrizione: "<p>Test</p>",
      "Descrizione Tag": "Descrizione valida",
      "Titolo Tag": "Titolo valido",
    },
  };
  assert.doesNotThrow(() => validateOutput("category", validCategory));
  assert.throws(
    () => validateOutput("category", { OUTPUT: { Descrizione: "ok" } }),
    /Campi mancanti o vuoti/,
  );

  const requests = [];
  context.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ error: { message: "web tool unavailable" } }), { status: 500 });
    }
    return new Response(JSON.stringify({ output_text: JSON.stringify(validCategory) }), { status: 200 });
  };
  const logMessages = [];
  const result = await callOpenAI({
    mode: "category",
    model: "gpt-5.4-nano",
    apiKey: "test-key",
    systemPrompt: "system",
    userPrompt: "user",
    onLog: (message, level) => logMessages.push({ message, level }),
  });

  assert.equal(requests.length, 2);
  assert.ok(Array.isArray(requests[0].body.tools));
  assert.equal(requests[1].body.tools, undefined);
  assert.equal(result.OUTPUT.Descrizione, "<p>Test</p>");
  assert.equal(logMessages[0].level, "warning");

  let unauthorizedCalls = 0;
  context.fetch = async () => {
    unauthorizedCalls++;
    return new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 });
  };
  await assert.rejects(
    callOpenAI({
      mode: "category",
      model: "gpt-5.4-nano",
      apiKey: "bad-key",
      systemPrompt: "system",
      userPrompt: "user",
    }),
    /OpenAI API 401: invalid key/,
  );
  assert.equal(unauthorizedCalls, 1);

  console.log("app.js smoke tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
