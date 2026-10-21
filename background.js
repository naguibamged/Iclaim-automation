importScripts("shared.js");

const PROCESSED_LIMIT = 200;

let chain = Promise.resolve();

function schedule(task) {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStatus(jobStatus) {
  return chrome.storage.local.set({ jobStatus });
}

function setLastResult(lastResult) {
  return chrome.storage.local.set({ lastResult });
}

async function getSettings() {
  const data = await chrome.storage.local.get(ICLAIM_DEFAULTS);
  return {
    enabled: data.enabled !== false,
    groupName: String(data.groupName || ICLAIM_DEFAULTS.groupName).trim() || ICLAIM_DEFAULTS.groupName,
    worklistUrl: String(data.worklistUrl || ICLAIM_DEFAULTS.worklistUrl).trim() || ICLAIM_DEFAULTS.worklistUrl
  };
}

async function ensureDefaults() {
  const current = await chrome.storage.local.get(null);
  const patch = {};
  if (typeof current.enabled !== "boolean") patch.enabled = ICLAIM_DEFAULTS.enabled;
  if (!current.groupName) patch.groupName = ICLAIM_DEFAULTS.groupName;
  if (!current.worklistUrl) patch.worklistUrl = ICLAIM_DEFAULTS.worklistUrl;
  if (!current.jobStatus) patch.jobStatus = "Ready";
  if (!Array.isArray(current.processedIds)) patch.processedIds = [];
  if (!Array.isArray(current.seenMessageIds)) patch.seenMessageIds = [];
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

function claimKey(text) {
  return String(text || "").trim();
}

async function getSessionClaims() {
  const session = await chrome.storage.session.get({ sessionClaims: {} });
  const claims = session.sessionClaims;
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return {};
  return claims;
}

async function claimState(text) {
  const key = claimKey(text);
  if (!key) return "";
  const claims = await getSessionClaims();
  return claims[key] || "";
}

async function setClaimState(text, state) {
  const key = claimKey(text);
  if (!key) return;
  const claims = await getSessionClaims();
  if (state === "failed" && claims[key] === "sent") return;
  claims[key] = state;
  await chrome.storage.session.set({ sessionClaims: claims });
}

function pdfFilename(text) {
  const clean = String(text)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return `claim-${clean || "document"}.pdf`;
}

function waitForTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Timed out waiting for the tab to load")), timeout);
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === "complete") finish();
      },
      (error) => finish(error)
    );
  });
}

async function focusTab(tab) {
  const updated = await chrome.tabs.update(tab.id, { active: true });
  try {
    await chrome.windows.update(updated.windowId, { focused: true });
  } catch (error) {
    // The window may already be focused or closing.
  }
  return updated;
}

async function ensureIclaimTab(worklistUrl) {
  let origin = "";
  try {
    origin = new URL(worklistUrl).origin;
  } catch (error) {
    throw new Error("The iClaim worklist URL in settings is not valid");
  }

  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url && tab.url.startsWith(origin));
  if (existing) {
    await focusTab(existing);
    if (existing.status !== "complete") await waitForTabComplete(existing.id);
    return existing;
  }

  const created = await chrome.tabs.create({ url: worklistUrl, active: true });
  await waitForTabComplete(created.id);
  return created;
}

async function findWhatsAppTab() {
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  return tabs[0] || null;
}

async function ensureWhatsAppTab() {
  const tab = await findWhatsAppTab();
  if (!tab) return null;
  return focusTab(tab);
}

let mouseDebugTarget = null;

async function attachMouseDebugger(tabId) {
  const target = { tabId };
  if (mouseDebugTarget && mouseDebugTarget.tabId === tabId) return;
  await chrome.debugger.attach(target, "1.3");
  mouseDebugTarget = target;
}

async function detachMouseDebugger() {
  const target = mouseDebugTarget;
  mouseDebugTarget = null;
  if (!target) return;
  try {
    await chrome.debugger.detach(target);
  } catch (error) {
    // Already detached.
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (mouseDebugTarget && source.tabId === mouseDebugTarget.tabId) mouseDebugTarget = null;
});

async function debuggerClick(x, y, button) {
  if (!mouseDebugTarget) throw new Error("WhatsApp debugger is not attached");
  const mouseButton = button === "right" ? "right" : "left";
  const pressed = mouseButton === "right" ? 2 : 1;
  await chrome.debugger.sendCommand(mouseDebugTarget, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y
  });
  await chrome.debugger.sendCommand(mouseDebugTarget, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: mouseButton,
    buttons: pressed,
    clickCount: 1
  });
  await chrome.debugger.sendCommand(mouseDebugTarget, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: mouseButton,
    buttons: 0,
    clickCount: 1
  });
}

function waitForDebuggerLoad(target, timeout = 20000) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(onEvent);
      resolve();
    };
    const timer = setTimeout(finish, timeout);
    const onEvent = (source, method) => {
      if (source.tabId === target.tabId && method === "Page.loadEventFired") finish();
    };
    chrome.debugger.onEvent.addListener(onEvent);
  });
}

async function fetchPdfFromPage(tabId, documentUrl) {
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [documentUrl],
    func: async (url) => {
      function toBase64(bytes) {
        let binary = "";
        const chunkSize = 0x8000;
        for (let index = 0; index < bytes.length; index += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
        }
        return btoa(binary);
      }

      try {
        const response = await fetch(url, { credentials: "include" });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const isPdf =
          bytes.length >= 5 &&
          bytes[0] === 0x25 &&
          bytes[1] === 0x50 &&
          bytes[2] === 0x44 &&
          bytes[3] === 0x46 &&
          bytes[4] === 0x2d;
        if (!isPdf) return { isPdf: false };
        return { isPdf: true, base64: toBase64(bytes) };
      } catch (error) {
        return { isPdf: false, error: error && error.message ? error.message : String(error) };
      }
    }
  });
  return injected?.result || { isPdf: false };
}

async function printUrlToPdf(url) {
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  const target = { tabId: tab.id };
  let attached = false;
  try {
    await waitForTabComplete(tab.id);
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await chrome.debugger.sendCommand(target, "Page.enable");
    await chrome.debugger.sendCommand(target, "Page.addScriptToEvaluateOnNewDocument", {
      source: "window.print = function () {};"
    });
    const loaded = waitForDebuggerLoad(target);
    await chrome.tabs.update(tab.id, { url, active: false });
    await loaded;
    await delay(1200);
    const printed = await chrome.debugger.sendCommand(target, "Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true
    });
    if (!printed?.data) throw new Error("Chrome did not return a PDF");
    return printed.data;
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch (error) {
        // Already detached.
      }
    }
    try {
      await chrome.tabs.remove(tab.id);
    } catch (error) {
      // The tab may already be closed.
    }
  }
}

async function capturePdf(documentUrl, iclaimTabId) {
  try {
    const fetched = await fetchPdfFromPage(iclaimTabId, documentUrl);
    if (fetched?.isPdf && fetched.base64) return fetched.base64;
  } catch (error) {
    console.info("Iclaim automation: direct PDF fetch failed", error);
  }
  return printUrlToPdf(documentUrl);
}

async function sendToWhatsApp(tabId, message) {
  const deliver = () => chrome.tabs.sendMessage(tabId, message);
  try {
    return await deliver();
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["shared.js", "content/whatsapp.js"]
    });
    return deliver();
  }
}

async function notifyWhatsApp(groupName, text) {
  const tab = await findWhatsAppTab();
  if (!tab) return;
  await focusTab(tab);
  const response = await sendToWhatsApp(tab.id, {
    type: "SEND_TEXT",
    groupName,
    text
  });
  if (!response?.ok) {
    console.info("Iclaim automation:", response?.error || "Could not send the WhatsApp reply");
  }
}

async function runSearch(tabId, claimNumber) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["content/iclaim.js"]
  });
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [claimNumber],
    func: async (number) => {
      try {
        const api = globalThis.__iclaimAutomation;
        if (!api || typeof api.searchAndOpen !== "function") {
          return { ok: false, error: "iClaim automation did not start" };
        }
        return await api.searchAndOpen(number);
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    }
  });
  return injected?.result || { ok: false, error: `No claim found for ${claimNumber}` };
}

async function runJob(job) {
  const settings = await getSettings();
  const groupName = job.groupName || settings.groupName;
  await setStatus(`Searching ${job.text}`);

  const iclaimTab = await ensureIclaimTab(settings.worklistUrl);
  const result = await runSearch(iclaimTab.id, job.text);
  if (!result?.ok) {
    const error = result?.error || `No claim found for ${job.text}`;
    await notifyWhatsApp(groupName, error);
    await setLastResult(error);
    await setStatus(error);
    return false;
  }

  await setStatus(`Saving PDF for ${job.text}`);
  let base64 = "";
  try {
    base64 = await capturePdf(result.documentUrl, iclaimTab.id);
  } catch (error) {
    const message = `Could not download the claim document for ${job.text}`;
    await notifyWhatsApp(groupName, message);
    await setLastResult(`${message}. ${error?.message || ""}`.trim());
    await setStatus(message);
    return false;
  }

  await setStatus(`Sending PDF for ${job.text}`);
  const whatsAppTab = await ensureWhatsAppTab();
  if (!whatsAppTab) {
    const message = "Open WhatsApp Web first";
    await setLastResult(message);
    await setStatus(message);
    return false;
  }

  const filename = pdfFilename(job.text);
  const response = await sendToWhatsApp(whatsAppTab.id, {
    type: "SEND_PDF",
    base64,
    filename,
    caption: job.text,
    groupName
  });
  if (!response?.ok) {
    const message = response?.error || `Could not send the PDF for ${job.text}`;
    await setLastResult(message);
    await setStatus(message);
    return false;
  }

  await setClaimState(job.text, "sent");
  const done = `Sent ${filename}`;
  await setLastResult(done);
  await setStatus(`Watching ${groupName}`);
  return true;
}

async function drainQueue() {
  for (;;) {
    const session = await chrome.storage.session.get({ jobQueue: [] });
    const queue = session.jobQueue || [];
    if (!queue.length) return;

    const [job, ...rest] = queue;
    await chrome.storage.session.set({ jobQueue: rest });

    const stored = await chrome.storage.local.get({ processedIds: [] });
    const processed = stored.processedIds || [];
    if (processed.includes(job.messageId)) continue;
    processed.push(job.messageId);
    await chrome.storage.local.set({ processedIds: processed.slice(-PROCESSED_LIMIT) });

    try {
      const sent = await runJob(job);
      if (!sent) await setClaimState(job.text, "failed");
    } catch (error) {
      await setClaimState(job.text, "failed");
      const message = error?.message || "The automation stopped";
      await setLastResult(message);
      await setStatus(message);
    }
  }
}

async function reserveClaim(job) {
  const settings = await getSettings();
  const text = String(job.text || "").trim();
  if (!text || !job.messageId) return { ok: false };
  if (!settings.enabled && !job.manual) {
    await setStatus("Paused");
    return { ok: false };
  }

  const stored = await chrome.storage.local.get({ processedIds: [] });
  if ((stored.processedIds || []).includes(job.messageId)) return { ok: true, duplicate: true, reply: "" };

  const state = await claimState(text);
  if (state === "sent") {
    const reply = `Already sent ${text}`;
    await setStatus(reply);
    return { ok: true, duplicate: true, reply };
  }
  if (state === "pending") {
    const reply = `Already getting ${text}`;
    await setStatus(reply);
    return { ok: true, duplicate: true, reply };
  }

  await setClaimState(text, "pending");

  const session = await chrome.storage.session.get({ jobQueue: [] });
  const queue = session.jobQueue || [];
  if (!queue.some((item) => item.messageId === job.messageId)) {
    queue.push({
      messageId: job.messageId,
      text,
      groupName: job.groupName || settings.groupName
    });
    await chrome.storage.session.set({ jobQueue: queue });
  }

  return { ok: true, start: true };
}

async function acceptAndRun(job) {
  const decision = await reserveClaim(job);
  if (decision.start) await drainQueue();
}

async function markWatching() {
  const settings = await getSettings();
  if (!settings.enabled) {
    await setStatus("Paused");
    return;
  }
  const session = await chrome.storage.session.get({ jobQueue: [] });
  if ((session.jobQueue || []).length) return;
  const current = await chrome.storage.local.get({ jobStatus: "" });
  if (/^(Searching|Saving|Sending)/.test(current.jobStatus || "")) return;
  await setStatus(`Watching ${settings.groupName}`);
}

chrome.runtime.onInstalled.addListener(() => {
  schedule(async () => {
    await ensureDefaults();
    await drainQueue();
  });
});

chrome.runtime.onStartup.addListener(() => {
  schedule(() => drainQueue());
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "RUN_CLAIM") {
    const text = String(message.text || "").trim();
    if (!text) {
      sendResponse({ ok: false, error: "Type an iClaim number" });
      return true;
    }
    schedule(() =>
      acceptAndRun({
        messageId: `manual-${Date.now()}`,
        text,
        manual: true
      })
    )
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "RESERVE_CLAIM") {
    schedule(() =>
      reserveClaim({
        messageId: message.messageId,
        text: message.text,
        groupName: message.groupName
      })
    )
      .then((decision) => sendResponse(decision))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "NEW_MESSAGE") {
    schedule(() => drainQueue());
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "WATCHING") {
    schedule(() => markWatching());
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "STATUS") {
    schedule(() => setStatus(message.status || "Ready"));
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "DEBUGGER_ATTACH" && sender.tab?.id) {
    attachMouseDebugger(sender.tab.id)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "DEBUGGER_DETACH") {
    detachMouseDebugger()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "DEBUGGER_CLICK") {
    debuggerClick(Number(message.x), Number(message.y), message.button)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if ((message?.type === "PATCH_FILE_CLICK" || message?.type === "RESTORE_FILE_CLICK") && sender.tab?.id) {
    const patch = message.type === "PATCH_FILE_CLICK";
    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id },
        world: "MAIN",
        func: (shouldPatch) => {
          const original = window.__iclaimFileClick;
          if (!shouldPatch) {
            if (original) HTMLInputElement.prototype.click = original;
            delete window.__iclaimFileClick;
            return;
          }
          if (original) return;
          const nativeClick = HTMLInputElement.prototype.click;
          window.__iclaimFileClick = nativeClick;
          HTMLInputElement.prototype.click = function capturedFileClick() {
            if (this && this.type === "file") {
              this.setAttribute("data-iclaim-file", "1");
              return undefined;
            }
            return nativeClick.apply(this, arguments);
          };
        },
        args: [patch]
      })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  return false;
});

schedule(() => drainQueue());
