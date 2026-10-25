const fieldsEl = document.getElementById("fields");
const savedEl = document.getElementById("saved");
const inputs = {};

for (const field of ICLAIM_REPLY_FIELDS) {
  const label = document.createElement("label");
  label.className = "label";
  label.htmlFor = `reply-${field.key}`;
  label.textContent = field.label;

  const input = document.createElement("input");
  input.id = `reply-${field.key}`;
  input.className = "field";
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.dir = "auto";
  input.placeholder = ICLAIM_REPLY_DEFAULTS[field.key] || "";
  inputs[field.key] = input;
  fieldsEl.append(label, input);
}

function storedTemplates(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

async function load() {
  const data = await chrome.storage.local.get({ replyTemplates: {} });
  const templates = storedTemplates(data.replyTemplates);
  for (const field of ICLAIM_REPLY_FIELDS) {
    const stored = templates[field.key];
    inputs[field.key].value =
      stored == null || String(stored).trim() === "" ? ICLAIM_REPLY_DEFAULTS[field.key] || "" : String(stored);
  }
}

let saveTimer = 0;
let savedTimer = 0;

function showSaved(text) {
  savedEl.hidden = false;
  savedEl.textContent = text;
  window.clearTimeout(savedTimer);
  if (text !== "Saved") return;
  savedTimer = window.setTimeout(() => {
    savedEl.hidden = true;
  }, 1200);
}

async function save() {
  const replyTemplates = {};
  for (const field of ICLAIM_REPLY_FIELDS) {
    replyTemplates[field.key] = inputs[field.key].value.trim();
  }
  await chrome.storage.local.set({ replyTemplates });
  showSaved("Saved");
}

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    save().catch((error) => showSaved(error.message || "Could not save"));
  }, 250);
}

for (const field of ICLAIM_REPLY_FIELDS) {
  inputs[field.key].addEventListener("input", scheduleSave);
}

load().catch((error) => showSaved(error.message || "Could not load replies"));
