const enabledEl = document.getElementById("enabled");
const switchLabelEl = document.getElementById("switch-label");
const groupEl = document.getElementById("group-name");
const urlEl = document.getElementById("worklist-url");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const claimEl = document.getElementById("claim-number");
const runEl = document.getElementById("run-claim");

function watchingLabel(groupName) {
  return `Watching ${groupName || ICLAIM_DEFAULTS.groupName}`;
}

function showStatus(text) {
  statusEl.textContent = text || "Ready";
  const busy = /^(Searching|Saving|Sending)/.test(text || "");
  runEl.disabled = busy;
}

function showResult(text) {
  resultEl.textContent = text || "No run yet.";
}

async function load() {
  const data = await chrome.storage.local.get({
    ...ICLAIM_DEFAULTS,
    jobStatus: "Ready",
    lastResult: ""
  });
  enabledEl.checked = data.enabled !== false;
  switchLabelEl.textContent = enabledEl.checked ? "On" : "Off";
  groupEl.value = data.groupName || ICLAIM_DEFAULTS.groupName;
  urlEl.value = data.worklistUrl || ICLAIM_DEFAULTS.worklistUrl;
  showStatus(data.jobStatus);
  showResult(data.lastResult);
}

async function saveSettings() {
  const groupName = groupEl.value.trim() || ICLAIM_DEFAULTS.groupName;
  const worklistUrl = urlEl.value.trim() || ICLAIM_DEFAULTS.worklistUrl;
  const enabled = enabledEl.checked;
  switchLabelEl.textContent = enabled ? "On" : "Off";

  const patch = { enabled, groupName, worklistUrl };
  const current = await chrome.storage.local.get({ jobStatus: "Ready" });
  const busy = /^(Searching|Saving|Sending)/.test(current.jobStatus || "");
  if (!busy) {
    patch.jobStatus = enabled ? watchingLabel(groupName) : "Paused";
  }

  await chrome.storage.local.set(patch);
  if (!groupEl.value.trim()) groupEl.value = groupName;
  if (!urlEl.value.trim()) urlEl.value = worklistUrl;
  if (!busy) showStatus(patch.jobStatus);
}

let saveTimer = 0;

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveSettings().catch((error) => showStatus(error.message));
  }, 250);
}

async function runClaim() {
  const text = claimEl.value.trim();
  if (!text) {
    showStatus("Type an iClaim number");
    claimEl.focus();
    return;
  }

  runEl.disabled = true;
  showStatus(`Searching ${text}`);
  try {
    const response = await chrome.runtime.sendMessage({ type: "RUN_CLAIM", text });
    if (!response?.ok) {
      showStatus(response?.error || "The extension background did not start. Reload the extension and try again.");
      runEl.disabled = false;
    }
  } catch (error) {
    showStatus(error?.message || "The extension background did not start. Reload the extension and try again.");
    runEl.disabled = false;
  }
}

claimEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runClaim();
  }
});

runEl.addEventListener("click", () => {
  runClaim();
});

enabledEl.addEventListener("change", scheduleSave);
groupEl.addEventListener("input", scheduleSave);
urlEl.addEventListener("input", scheduleSave);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.jobStatus) showStatus(changes.jobStatus.newValue);
  if (changes.lastResult) showResult(changes.lastResult.newValue);
  if (changes.enabled && document.activeElement !== enabledEl) {
    enabledEl.checked = changes.enabled.newValue !== false;
    switchLabelEl.textContent = enabledEl.checked ? "On" : "Off";
  }
});

load().catch((error) => showStatus(error.message));
