const fieldsEl = document.getElementById("fields");
const savedEl = document.getElementById("saved");
const ignoreEl = document.getElementById("ignore-invalid");
const ignoreLabelEl = document.getElementById("ignore-label");
const gapEl = document.getElementById("ack-gap");
const inputs = {};
const sendInputs = {};
const gapInputs = {};

function switchBox(id, text) {
  const wrap = document.createElement("label");
  wrap.className = "check";
  const toggle = document.createElement("span");
  toggle.className = "switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  const slider = document.createElement("span");
  slider.className = "slider";
  const name = document.createElement("span");
  name.textContent = text;
  toggle.append(input, slider);
  wrap.append(toggle, name);
  return { wrap, input };
}

for (const field of ICLAIM_REPLY_FIELDS) {
  const block = document.createElement("div");
  block.className = "reply";

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

  const toggles = document.createElement("div");
  toggles.className = "toggles";
  const send = switchBox(`send-${field.key}`, "Send");
  const gap = switchBox(`gap-${field.key}`, "In gap");
  toggles.append(send.wrap, gap.wrap);
  block.append(label, input, toggles);
  fieldsEl.append(block);

  inputs[field.key] = input;
  sendInputs[field.key] = send.input;
  gapInputs[field.key] = gap.input;
}

function storedTemplates(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function showIgnore(on) {
  ignoreLabelEl.textContent = on ? "On" : "Off";
}

async function load() {
  const data = await chrome.storage.local.get({
    replyTemplates: {},
    ignoreInvalid: ICLAIM_DEFAULTS.ignoreInvalid,
    ackGapSeconds: ICLAIM_DEFAULTS.ackGapSeconds,
    ackReplies: true,
    replyEnabled: {},
    replyInGap: {}
  });
  const templates = storedTemplates(data.replyTemplates);
  const flags = normalizeReplyFlags(data);
  ignoreEl.checked = data.ignoreInvalid === true;
  showIgnore(ignoreEl.checked);
  gapEl.value = String(gapSeconds(data.ackGapSeconds));
  for (const field of ICLAIM_REPLY_FIELDS) {
    const stored = templates[field.key];
    inputs[field.key].value =
      stored == null || String(stored).trim() === "" ? ICLAIM_REPLY_DEFAULTS[field.key] || "" : String(stored);
    sendInputs[field.key].checked = flags.replyEnabled[field.key] !== false;
    gapInputs[field.key].checked = flags.replyInGap[field.key] === true;
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
  const replyEnabled = {};
  const replyInGap = {};
  for (const field of ICLAIM_REPLY_FIELDS) {
    replyTemplates[field.key] = inputs[field.key].value.trim();
    replyEnabled[field.key] = sendInputs[field.key].checked;
    replyInGap[field.key] = gapInputs[field.key].checked;
  }
  const ignoreInvalid = ignoreEl.checked;
  const ackGapSeconds = gapSeconds(gapEl.value);
  showIgnore(ignoreInvalid);
  await chrome.storage.local.set({ replyTemplates, replyEnabled, replyInGap, ignoreInvalid, ackGapSeconds });
  showSaved("Saved");
}

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    save().catch((error) => showSaved(error.message || "Could not save"));
  }, 250);
}

ignoreEl.addEventListener("change", () => {
  showIgnore(ignoreEl.checked);
  scheduleSave();
});
gapEl.addEventListener("input", scheduleSave);

for (const field of ICLAIM_REPLY_FIELDS) {
  inputs[field.key].addEventListener("input", scheduleSave);
  sendInputs[field.key].addEventListener("change", scheduleSave);
  gapInputs[field.key].addEventListener("change", scheduleSave);
}

load().catch((error) => showSaved(error.message || "Could not load replies"));
