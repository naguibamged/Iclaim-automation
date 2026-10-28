const TESTING_PASSWORD = "105090";
const BUSY_STATUS = /^(Searching|Saving|Sending|Detecting|Replying|Choose)/;

const enabledEl = document.getElementById("enabled");
const switchLabelEl = document.getElementById("switch-label");
const backgroundEl = document.getElementById("work-in-background");
const backgroundLabelEl = document.getElementById("background-label");
const groupEl = document.getElementById("group-name");
const urlEl = document.getElementById("worklist-url");
const committeeUrlEl = document.getElementById("committee-url");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const claimEl = document.getElementById("claim-number");
const runEl = document.getElementById("run-claim");
const testingCardEl = document.getElementById("testing-card");
const passwordRowEl = document.getElementById("testing-password-row");
const passwordEl = document.getElementById("testing-password");
const unlockEl = document.getElementById("testing-unlock");
const panelEl = document.getElementById("testing-panel");
const detectEl = document.getElementById("test-detect");
const detectResultEl = document.getElementById("detect-result");
const replyEl = document.getElementById("test-reply");
const searchStageEl = document.getElementById("test-search");
const attachEl = document.getElementById("test-attach");
const repliesEl = document.getElementById("open-replies");
const stageButtons = [detectEl, replyEl, searchStageEl, attachEl];

function watchingLabel(groupName) {
  return `Watching ${groupName || ICLAIM_DEFAULTS.groupName}`;
}

function showStatus(text) {
  statusEl.textContent = text || "Ready";
  const busy = BUSY_STATUS.test(text || "");
  runEl.disabled = busy;
  for (const button of stageButtons) button.disabled = busy;
}

function showTesting(unlocked, asking) {
  testingCardEl.hidden = !(unlocked || asking);
  passwordRowEl.hidden = !asking;
  panelEl.hidden = !unlocked;
  if (asking) passwordEl.focus();
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
  backgroundEl.checked = data.workInBackground === true;
  backgroundLabelEl.textContent = backgroundEl.checked ? "On" : "Off";
  groupEl.value = data.groupName || ICLAIM_DEFAULTS.groupName;
  urlEl.value = data.worklistUrl || ICLAIM_DEFAULTS.worklistUrl;
  committeeUrlEl.value = data.committeeUrl || ICLAIM_DEFAULTS.committeeUrl;
  showStatus(data.jobStatus);
  showResult(data.lastResult);
  const session = await chrome.storage.session.get({ testingMode: false });
  if (session.testingMode === true) showTesting(true, false);
}

async function saveSettings() {
  const typedGroup = groupEl.value.trim();
  const worklistUrl = urlEl.value.trim() || ICLAIM_DEFAULTS.worklistUrl;
  const committeeUrl = committeeUrlEl.value.trim() || ICLAIM_DEFAULTS.committeeUrl;
  const enabled = enabledEl.checked;
  const workInBackground = backgroundEl.checked;
  switchLabelEl.textContent = enabled ? "On" : "Off";
  backgroundLabelEl.textContent = workInBackground ? "On" : "Off";

  const stored = await chrome.storage.local.get({
    ...ICLAIM_DEFAULTS,
    jobStatus: "Ready"
  });
  const groupName = typedGroup || stored.groupName || ICLAIM_DEFAULTS.groupName;
  const patch = { enabled, worklistUrl, committeeUrl, workInBackground };
  if (typedGroup) patch.groupName = typedGroup;
  const busy = BUSY_STATUS.test(stored.jobStatus || "");
  if (!busy) {
    patch.jobStatus = enabled ? watchingLabel(groupName) : "Paused";
  }

  await chrome.storage.local.set(patch);
  if (!urlEl.value.trim()) urlEl.value = worklistUrl;
  if (!committeeUrlEl.value.trim()) committeeUrlEl.value = committeeUrl;
  if (!busy) showStatus(patch.jobStatus);
}

async function restoreGroupName() {
  if (groupEl.value.trim()) return;
  const data = await chrome.storage.local.get(ICLAIM_DEFAULTS);
  if (groupEl.value.trim()) return;
  groupEl.value = data.groupName || ICLAIM_DEFAULTS.groupName;
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
    showStatus("Type a National ID or Claim ID");
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

async function unlockTesting() {
  if (passwordEl.value.trim() !== TESTING_PASSWORD) {
    passwordEl.value = "";
    await chrome.storage.session.set({ testingMode: false });
    showTesting(false, false);
    showStatus("Wrong password");
    return;
  }
  passwordEl.value = "";
  await chrome.storage.session.set({ testingMode: true });
  showTesting(true, false);
}

function showDetectResult(text) {
  const report = text || "No incoming messages visible.";
  detectResultEl.textContent = report;
  console.log("Iclaim detect:", report);
  detectResultEl.scrollIntoView({ block: "nearest" });
}

async function runStage(type, status, extra) {
  showStatus(status);
  if (type === "TEST_DETECT") showDetectResult("Detecting messages...");
  try {
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    console.log("Iclaim stage:", type, response);
    if (!response?.ok) {
      const message = response?.error || "The stage did not run";
      showStatus(message);
      showResult(message);
      if (type === "TEST_DETECT") showDetectResult(message);
      return;
    }
    if (response.report) {
      showResult(response.report);
      showStatus(response.status || status);
      if (type === "TEST_DETECT") showDetectResult(response.report);
    }
  } catch (error) {
    const message = error?.message || "The extension background did not start. Reload the extension and try again.";
    console.log("Iclaim stage failed:", type, message);
    showStatus(message);
    showResult(message);
    if (type === "TEST_DETECT") showDetectResult(message);
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

repliesEl.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

function isTestingShortcut(event) {
  return event.ctrlKey && !event.altKey && !event.metaKey && (event.code === "Backquote" || event.key === "`");
}

async function toggleTesting() {
  if (!testingCardEl.hidden) {
    passwordEl.value = "";
    showTesting(false, false);
    await chrome.storage.session.set({ testingMode: false });
    return;
  }
  const session = await chrome.storage.session.get({ testingMode: false });
  if (session.testingMode === true) {
    showTesting(true, false);
    return;
  }
  passwordEl.value = "";
  showTesting(false, true);
}

window.addEventListener("keydown", (event) => {
  if (!isTestingShortcut(event)) return;
  event.preventDefault();
  toggleTesting().catch((error) => showStatus(error.message));
}, true);

unlockEl.addEventListener("click", () => {
  unlockTesting().catch((error) => showStatus(error.message));
});

passwordEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  unlockTesting().catch((error) => showStatus(error.message));
});

detectEl.addEventListener("click", () => {
  runStage("TEST_DETECT", "Detecting messages").catch((error) => showStatus(error.message));
});

replyEl.addEventListener("click", () => {
  runStage("TEST_REPLY", "Replying", { text: claimEl.value.trim() }).catch((error) => showStatus(error.message));
});

searchStageEl.addEventListener("click", () => {
  const text = claimEl.value.trim();
  if (!text) {
    showStatus("Type a National ID or Claim ID");
    claimEl.focus();
    return;
  }
  runStage("TEST_SEARCH", `Searching ${text}`, { text }).catch((error) => showStatus(error.message));
});

attachEl.addEventListener("click", () => {
  runStage("TEST_ATTACH", "Sending attachment", { text: claimEl.value.trim() }).catch((error) => showStatus(error.message));
});

backgroundEl.addEventListener("change", () => {
  scheduleSave();
});

enabledEl.addEventListener("change", () => {
  if (!enabledEl.checked) {
    scheduleSave();
    return;
  }
  showTesting(false, false);
  chrome.storage.session
    .set({ testingMode: false })
    .then(() => scheduleSave())
    .catch((error) => showStatus(error.message));
});
groupEl.addEventListener("input", scheduleSave);
groupEl.addEventListener("blur", () => {
  restoreGroupName().catch((error) => showStatus(error.message));
});
urlEl.addEventListener("input", scheduleSave);
committeeUrlEl.addEventListener("input", scheduleSave);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session") {
    if (changes.testingMode && !testingCardEl.hidden) {
      showTesting(changes.testingMode.newValue === true, false);
    }
    return;
  }
  if (area !== "local") return;
  if (changes.jobStatus) showStatus(changes.jobStatus.newValue);
  if (changes.lastResult) showResult(changes.lastResult.newValue);
  if (changes.enabled && document.activeElement !== enabledEl) {
    enabledEl.checked = changes.enabled.newValue !== false;
    switchLabelEl.textContent = enabledEl.checked ? "On" : "Off";
  }
  if (changes.workInBackground && document.activeElement !== backgroundEl) {
    backgroundEl.checked = changes.workInBackground.newValue === true;
    backgroundLabelEl.textContent = backgroundEl.checked ? "On" : "Off";
  }
});

load().catch((error) => showStatus(error.message));
