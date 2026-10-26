importScripts("shared.js");

if (chrome.storage.session.setAccessLevel) {
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }).catch(() => {});
}

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

const HUD_TICK_MS = 700;
const HUD_SETTLE_MS = 800;

function idleHudStage() {
  return { label: "", phase: "idle", detail: "", at: Date.now() };
}

function setHudStage(label, phase, detail) {
  return chrome.storage.local.set({
    hudStage: {
      label: label || "",
      phase: phase || "idle",
      detail: detail || "",
      at: Date.now()
    }
  });
}

async function beginHudStage(background, label, detail) {
  if (!background) return;
  await setHudStage(label, "running", detail);
}

async function completeHudStage(background, label, detail) {
  if (!background) return;
  await setHudStage(label, "done", detail);
  await delay(HUD_TICK_MS);
}

function hudErrorDetail(id, message) {
  const text = String(message || "The automation stopped");
  if (!id || text.includes(String(id))) return text;
  return `${id} — ${text}`;
}

async function failHudStage(label, detail) {
  await setHudStage(label, "error", detail);
}

async function settleHudStage(background) {
  if (!background) return;
  await delay(HUD_SETTLE_MS);
  await setHudStage("", "idle", "");
}

async function getSettings() {
  const data = await chrome.storage.local.get({
    ...ICLAIM_DEFAULTS,
    replyTemplates: {},
    replyEnabled: {},
    replyInGap: {},
    ackReplies: true
  });
  const templates = data.replyTemplates;
  const flags = normalizeReplyFlags(data);
  return {
    enabled: data.enabled !== false,
    groupName: String(data.groupName || ICLAIM_DEFAULTS.groupName).trim() || ICLAIM_DEFAULTS.groupName,
    worklistUrl: String(data.worklistUrl || ICLAIM_DEFAULTS.worklistUrl).trim() || ICLAIM_DEFAULTS.worklistUrl,
    committeeUrl: String(data.committeeUrl || ICLAIM_DEFAULTS.committeeUrl).trim() || ICLAIM_DEFAULTS.committeeUrl,
    workInBackground: data.workInBackground === true,
    ignoreInvalid: data.ignoreInvalid === true,
    ackGapSeconds: gapSeconds(data.ackGapSeconds),
    replyEnabled: flags.replyEnabled,
    replyInGap: flags.replyInGap,
    replyTemplates: templates && typeof templates === "object" && !Array.isArray(templates) ? templates : {}
  };
}

function chatReplyText(templates, result, id) {
  if (!result) return "";
  if (result.replyKey) {
    return pickReply(templates, result.replyKey, {
      id,
      status: result.statusText || ""
    });
  }
  return result.reply || "";
}

async function ensureDefaults() {
  const current = await chrome.storage.local.get(null);
  const patch = {};
  if (typeof current.enabled !== "boolean") patch.enabled = ICLAIM_DEFAULTS.enabled;
  if (!current.groupName) patch.groupName = ICLAIM_DEFAULTS.groupName;
  if (!current.worklistUrl) patch.worklistUrl = ICLAIM_DEFAULTS.worklistUrl;
  if (!current.committeeUrl) patch.committeeUrl = ICLAIM_DEFAULTS.committeeUrl;
  if (typeof current.workInBackground !== "boolean") patch.workInBackground = ICLAIM_DEFAULTS.workInBackground;
  if (typeof current.ignoreInvalid !== "boolean") patch.ignoreInvalid = ICLAIM_DEFAULTS.ignoreInvalid;
  if (typeof current.ackGapSeconds !== "number") patch.ackGapSeconds = ICLAIM_DEFAULTS.ackGapSeconds;
  const flags = normalizeReplyFlags(current);
  const storedEnabled = flagObject(current.replyEnabled);
  const storedGap = flagObject(current.replyInGap);
  if (!sameReplyFlags(storedEnabled, flags.replyEnabled)) patch.replyEnabled = flags.replyEnabled;
  if (!sameReplyFlags(storedGap, flags.replyInGap)) patch.replyInGap = flags.replyInGap;
  if (!current.jobStatus) patch.jobStatus = "Ready";
  if (!Array.isArray(current.processedIds)) patch.processedIds = [];
  if (!Array.isArray(current.seenMessageIds)) patch.seenMessageIds = [];
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  if (typeof current.ackReplies === "boolean") await chrome.storage.local.remove("ackReplies");
}

function sameReplyFlags(stored, normalized) {
  return ICLAIM_REPLY_FIELDS.every((field) => stored[field.key] === normalized[field.key]);
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
  if (state === "failed" && (claims[key] === "sent" || claims[key] === "rejected")) return;
  claims[key] = state;
  await chrome.storage.session.set({ sessionClaims: claims });
}

function pdfFilename(text, kind) {
  const clean = String(text)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  const prefix = kind === "national" ? "decision" : "claim";
  return `${prefix}-${clean || "document"}.pdf`;
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

async function ensureOriginTab(url, invalidMessage, background, options = {}) {
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch (error) {
    throw new Error(invalidMessage);
  }

  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url && tab.url.startsWith(origin));
  if (existing) {
    // Activating a discarded tab reloads it. Skip that when the caller is about
    // to load a different address, or a form-post page shows "Resubmit the form?".
    if (options.skipReload) return chrome.tabs.get(existing.id);
    if (!background) await focusTab(existing);
    if (existing.discarded && background) {
      await chrome.tabs.reload(existing.id);
      await waitForTabComplete(existing.id);
    } else if (existing.status !== "complete" || existing.discarded) {
      await waitForTabComplete(existing.id);
    }
    return chrome.tabs.get(existing.id);
  }

  const created = await chrome.tabs.create({ url, active: background !== true });
  await waitForTabComplete(created.id);
  return chrome.tabs.get(created.id);
}

function ensureIclaimTab(worklistUrl, background) {
  return ensureOriginTab(worklistUrl, "The iClaim worklist URL in settings is not valid", background);
}

function committeeQueryUrl(committeeUrl) {
  const url = new URL(committeeUrl);
  const directory = url.pathname.endsWith("/") ? url.pathname : url.pathname.replace(/[^/]*$/, "");
  url.pathname = `${directory}RMS_QueryRequest_Branch.aspx`;
  url.search = "";
  url.hash = "";
  return url.href;
}

function freshCommitteeQueryUrl(queryUrl) {
  const url = new URL(queryUrl);
  url.searchParams.set("iclaim", String(Date.now()));
  url.hash = "";
  return url.href;
}

function sameDocumentUrl(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = "";
    b.hash = "";
    return a.href === b.href;
  } catch (error) {
    return false;
  }
}

async function replaceCommitteeQueryUrl(tabId, queryUrl) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [queryUrl],
      func: (clean) => {
        if (!/RMS_QueryRequest_Branch\.aspx/i.test(location.pathname)) return;
        history.replaceState(null, "", clean);
        const form = document.getElementById("form1") || document.forms[0];
        const action = form && form.getAttribute("action");
        if (!form || !action) return;
        try {
          const target = new URL(action, clean);
          target.searchParams.delete("iclaim");
          const query = target.searchParams.toString();
          form.setAttribute("action", `${target.pathname}${query ? `?${query}` : ""}`);
        } catch (error) {
          // Keep the action the page rendered.
        }
      }
    });
  } catch (error) {
    // The search page is already open. A leftover nonce does not block the search.
  }
}

function waitForQueryPage(tabId, timeout = 30000) {
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
    const timer = setTimeout(() => finish(new Error("Timed out waiting for the committee query page")), timeout);
    const onUpdated = (id, info, tab) => {
      if (id !== tabId || info.status !== "complete") return;
      const current = (tab && tab.url) || info.url || "";
      if (/RMS_QueryRequest_Branch\.aspx/i.test(current)) {
        finish();
        return;
      }
      chrome.tabs.get(id).then(
        (fresh) => {
          if (fresh.url && /RMS_QueryRequest_Branch\.aspx/i.test(fresh.url)) finish();
        },
        () => {}
      );
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function committeeFormReady(tabId) {
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        if (document.readyState !== "complete") return false;
        return Boolean(
          document.querySelector("#ContentPlaceHolder1_txtSearch") ||
            document.querySelector("#ContentPlaceHolder1_btnAll") ||
            document.querySelector("#ContentPlaceHolder1_btnGenral")
        );
      }
    });
    return injected?.result === true;
  } catch (error) {
    return false;
  }
}

async function waitForCommitteeForm(tabId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await committeeFormReady(tabId)) return true;
    await delay(250);
  }
  return false;
}

async function ensureCommitteeTab(committeeUrl, background) {
  let queryUrl = "";
  try {
    queryUrl = committeeQueryUrl(committeeUrl);
  } catch (error) {
    throw new Error("The committee URL in settings is not valid");
  }
  // Search results and the print page are both form posts on this site. Reloading
  // that page, or going back to it, makes Chrome show "Resubmit the form?" and the
  // run stops. A new address is always a GET, including after a refusal that never
  // left the results page.
  const freshUrl = freshCommitteeQueryUrl(queryUrl);
  const active = background !== true;
  const tab = await ensureOriginTab(freshUrl, "The committee URL in settings is not valid", background, {
    skipReload: true
  });
  const openedFresh = tab.status === "complete" && sameDocumentUrl(tab.url, freshUrl);
  if (!openedFresh) {
    const queryReady = waitForQueryPage(tab.id);
    await chrome.tabs.update(tab.id, { url: freshUrl, active });
    await queryReady;
  }
  await waitForCommitteeForm(tab.id);
  await replaceCommitteeQueryUrl(tab.id, queryUrl);
  if (!background) await focusTab(await chrome.tabs.get(tab.id));
  return chrome.tabs.get(tab.id);
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

async function debuggerKey(key, code, keyCode, modifiers) {
  if (!mouseDebugTarget) throw new Error("WhatsApp debugger is not attached");
  const event = {
    key,
    code,
    modifiers: modifiers || 0,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode
  };
  await chrome.debugger.sendCommand(mouseDebugTarget, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
  await chrome.debugger.sendCommand(mouseDebugTarget, "Input.dispatchKeyEvent", { type: "keyUp", ...event });
}

async function debuggerInsertText(text) {
  if (!mouseDebugTarget) throw new Error("WhatsApp debugger is not attached");
  await chrome.debugger.sendCommand(mouseDebugTarget, "Input.insertText", { text });
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

async function isolateDecisionForPrint(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const decision = document.querySelector("#GFG");
        if (!decision) return;
        const box = decision.parentElement || decision;
        box.classList.add("committee-print-root");
        if (document.getElementById("committee-print-style")) return;
        const style = document.createElement("style");
        style.id = "committee-print-style";
        style.textContent =
          "@media print { body * { visibility: hidden !important; } .committee-print-root, .committee-print-root * { visibility: visible !important; } .committee-print-root { position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; background: #fff !important; } }";
        document.head.appendChild(style);
      }
    });
  } catch (error) {
    console.info("Iclaim automation: could not isolate the decision for print", error);
  }
}

async function printOpenTabToPdf(tabId) {
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await chrome.debugger.sendCommand(target, "Page.enable");
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
  }
}

async function printHtmlToPdf(html, baseUrl) {
  const safeBase = String(baseUrl || "").replace(/"/g, "");
  const documentHtml = `<!doctype html><html dir="rtl"><head><meta charset="utf-8"><base href="${safeBase}"><style>@page{size:A4;margin:10mm}body{margin:0;background:#fff}</style></head><body>${html}</body></html>`;
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  const target = { tabId: tab.id };
  let attached = false;
  try {
    await waitForTabComplete(tab.id);
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await chrome.debugger.sendCommand(target, "Page.enable");
    const tree = await chrome.debugger.sendCommand(target, "Page.getFrameTree");
    const frameId = tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
    if (!frameId) throw new Error("Chrome did not return a PDF");
    await chrome.debugger.sendCommand(target, "Page.setDocumentContent", { frameId, html: documentHtml });
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

async function printUrlToPdf(url, options) {
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
    if (options && options.isolateDecision) {
      await isolateDecisionForPrint(tab.id);
      await delay(300);
    }
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

async function isTestingMode() {
  const session = await chrome.storage.session.get({ testingMode: false });
  return session.testingMode === true;
}

async function testingGate() {
  if (await isTestingMode()) return null;
  return { ok: false, error: "Turn on testing mode first" };
}

async function failStage(message) {
  await setHudStage("Stopped", "error", message);
  await setLastResult(message);
  await setStatus(message);
  return { ok: false, error: message };
}

function formatDetectedMessages(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.messages) ? payload.messages : [];
  if (!list.length) {
    const open = payload?.chatOpen ? "Group chat is open." : "Group chat is not open.";
    const bubbles = Number(payload?.containerCount) || 0;
    return `No incoming messages visible.\n${open}\nMessage bubbles on screen: ${bubbles}.`;
  }
  const lines = [`Incoming messages: ${list.length}`];
  for (const message of list) {
    const text = String(message?.text || "").replace(/\s+/g, " ").trim();
    lines.push(`- ${text} (${message?.seen ? "seen" : "new"})`);
  }
  return lines.join("\n");
}

function testPdfBase64() {
  const stream = "BT /F1 18 Tf 36 80 Td (iClaim attachment test) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefAt = body.length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    table += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  body += `${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return btoa(body);
}

async function notifyWhatsApp(groupName, text, quoteText) {
  const tab = await findWhatsAppTab();
  if (!tab) return false;
  await focusTab(tab);
  const response = await sendToWhatsApp(tab.id, {
    type: "SEND_TEXT",
    groupName,
    text,
    quoteText: quoteText || ""
  });
  if (!response?.ok) {
    console.info("Iclaim automation:", response?.error || "Could not send the WhatsApp reply");
    return false;
  }
  return true;
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
  return injected?.result || { ok: false, error: "iClaim automation did not start" };
}

async function readCommittee(tabId, payload) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["content/committee.js"]
    });
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [payload],
      func: async (request) => {
        try {
          const api = globalThis.__committeeAutomation;
          if (!api || typeof api.run !== "function") {
            return { ok: false, error: "Committee automation did not start" };
          }
          return await api.run(request);
        } catch (error) {
          return { ok: false, error: error && error.message ? error.message : String(error) };
        }
      }
    });
    return injected?.result || { ok: false, error: "Committee automation did not start" };
  } catch (error) {
    const message = error?.message || String(error);
    if (/frame|context|navigation|destroyed|removed/i.test(message)) {
      return { ok: false, navigated: true, error: message };
    }
    return { ok: false, error: message };
  }
}

async function runCommitteeVisible(tabId, id) {
  const result = await readCommittee(tabId, { method: "runVisible", id });
  if (!result) return { ok: false, error: "Committee automation did not start" };
  return { ...result, tabId: result.tabId || tabId };
}

function runCommitteeHidden(tabId, id) {
  return readCommittee(tabId, { method: "runHidden", id });
}

async function captureCommitteePdf(result, fallbackTabId, background) {
  if (result.base64) return result.base64;
  const tabId = result.tabId || fallbackTabId;
  if (result.capture === "tab") {
    await isolateDecisionForPrint(tabId);
    await delay(300);
    return printOpenTabToPdf(tabId);
  }
  if (result.documentUrl) {
    try {
      const fetched = await fetchPdfFromPage(tabId, result.documentUrl);
      if (fetched?.isPdf && fetched.base64) return fetched.base64;
    } catch (error) {
      console.info("Iclaim automation: direct PDF fetch failed", error);
    }
    if (!background && tabId) {
      await chrome.tabs.update(tabId, { url: result.documentUrl, active: true });
      await waitForTabComplete(tabId);
      await delay(800);
      await isolateDecisionForPrint(tabId);
      return printOpenTabToPdf(tabId);
    }
    return printUrlToPdf(result.documentUrl, { isolateDecision: true });
  }
  if (result.html) return printHtmlToPdf(result.html, result.baseUrl);
  throw new Error("Could not download the committee decision");
}

async function kickstartAutomation() {
  const settings = await getSettings();
  if (!settings.enabled) return;
  const tab = await findWhatsAppTab();
  if (!tab) {
    await setStatus("Open WhatsApp Web first");
    return;
  }
  const response = await sendToWhatsApp(tab.id, { type: "KICKSTART", groupName: settings.groupName });
  if (response?.already) return;
  if (!response?.ok) await setStatus(response?.error || "Could not read WhatsApp messages");
}

async function testDetect() {
  const blocked = await testingGate();
  if (blocked) return blocked;
  const settings = await getSettings();
  await setStatus("Detecting messages");
  const tab = await findWhatsAppTab();
  if (!tab) return failStage("Open WhatsApp Web first");
  const response = await sendToWhatsApp(tab.id, { type: "TEST_DETECT", groupName: settings.groupName });
  if (!response?.ok) return failStage(response?.error || "Could not read WhatsApp messages");
  const report = formatDetectedMessages(response);
  const status = report.split("\n")[0] || "Detect finished";
  await setLastResult(report);
  await setStatus(status);
  return { ok: true, report, status };
}

async function testReply(claimText) {
  const blocked = await testingGate();
  if (blocked) return blocked;
  const settings = await getSettings();
  await setStatus("Replying");
  const tab = await ensureWhatsAppTab();
  if (!tab) return failStage("Open WhatsApp Web first");
  const response = await sendToWhatsApp(tab.id, {
    type: "TEST_REPLY",
    groupName: settings.groupName,
    text: String(claimText || "").trim()
  });
  if (!response?.ok) return failStage(response?.error || "Could not send the reply");
  const done = `Replied to ${response.repliedTo}`;
  await setLastResult(done);
  await setStatus(done);
  return { ok: true };
}

async function testSearch(claimText) {
  const blocked = await testingGate();
  if (blocked) return blocked;
  const text = String(claimText || "").trim();
  if (!text) return failStage("Type a National ID or Claim ID");
  const parsed = classifyClaimId(text);
  if (!parsed.ok) return failStage(parsed.reply);
  const settings = await getSettings();
  const background = settings.workInBackground === true;
  await setStatus(`Searching ${parsed.id}`);
  if (parsed.kind === "national") {
    const tab = await ensureCommitteeTab(settings.committeeUrl, background);
    const result = background ? await runCommitteeHidden(tab.id, parsed.id) : await runCommitteeVisible(tab.id, parsed.id);
    if (!result?.ok) return failStage(result?.error || `No decision found for ${parsed.id}`);
    const replyText = chatReplyText(settings.replyTemplates, result, parsed.id);
    if (replyText) {
      await setLastResult(replyText);
      await setStatus(replyText);
      return { ok: true, report: replyText, status: replyText };
    }
    const summary = result.summary || `Opened decision ${parsed.id}`;
    await setLastResult(summary);
    await setStatus("Search finished");
    return { ok: true, report: summary, status: "Search finished" };
  }
  const iclaimTab = await ensureIclaimTab(settings.worklistUrl, background);
  const result = await runSearch(iclaimTab.id, parsed.id);
  if (!result?.ok) return failStage(result?.error || `No claim found for ${parsed.id}`);
  const claimReply = chatReplyText(settings.replyTemplates, result, parsed.id);
  if (claimReply) {
    await setLastResult(claimReply);
    await setStatus(claimReply);
    return { ok: true, report: claimReply, status: claimReply };
  }
  await setLastResult(result.documentUrl || `Opened claim ${parsed.id}`);
  await setStatus("Search finished");
  return { ok: true };
}

async function testAttach(claimText) {
  const blocked = await testingGate();
  if (blocked) return blocked;
  const settings = await getSettings();
  const caption = String(claimText || "").trim() || "test";
  await setStatus("Sending attachment");
  const tab = await ensureWhatsAppTab();
  if (!tab) return failStage("Open WhatsApp Web first");
  const filename = pdfFilename(caption);
  const response = await sendToWhatsApp(tab.id, {
    type: "SEND_PDF",
    base64: testPdfBase64(),
    filename,
    caption,
    groupName: settings.groupName
  });
  if (!response?.ok) return failStage(response?.error || "Could not send the test PDF");
  const done = `Sent ${filename}`;
  await setLastResult(done);
  await setStatus(done);
  return { ok: true };
}

async function deliverPdf(job, groupName, base64) {
  await setStatus(`Sending PDF for ${job.text}`);
  const whatsAppTab = await ensureWhatsAppTab();
  if (!whatsAppTab) {
    const message = "Open WhatsApp Web first";
    await setLastResult(message);
    await setStatus(message);
    return false;
  }

  const filename = pdfFilename(job.text, job.kind);
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

async function reportFailure(label, id, message, detail) {
  const combined = detail ? `${message}. ${detail}`.trim() : message;
  const text = hudErrorDetail(id, combined);
  await setHudStage(label || "Stopped", "error", text);
  await setLastResult(text);
  await setStatus(message);
  return false;
}

async function runJob(job) {
  const settings = await getSettings();
  const groupName = job.groupName || settings.groupName;
  const quote = job.quoteText || job.text;
  const parsed =
    job.kind === "national" || job.kind === "claim"
      ? { ok: true, kind: job.kind, id: String(job.text || "").trim() }
      : classifyClaimId(job.text);
  if (!parsed.ok) {
    if (!shouldSendReply(settings, "invalidId", job.withinGap === true)) return false;
    const reply = pickReply(settings.replyTemplates, "invalidId");
    await notifyWhatsApp(groupName, reply, quote);
    await setLastResult(reply);
    await setStatus(reply);
    return false;
  }

  const id = parsed.id;
  const kind = parsed.kind;
  const current = { ...job, text: id, kind };
  const background = settings.workInBackground === true;
  let stageLabel = "";

  async function startStage(label) {
    stageLabel = label;
    await beginHudStage(background, label, id);
  }

  async function failStage(label, message) {
    await failHudStage(label, hudErrorDetail(id, message));
    stageLabel = "";
  }

  async function sendChatReply(result) {
    const key = result && result.replyKey;
    if (key && !shouldSendReply(settings, key, job.withinGap === true)) {
      await setStatus(`Watching ${groupName}`);
      if (result.status === "danger") {
        await setClaimState(id, "rejected");
        return true;
      }
      return false;
    }
    const replyText = chatReplyText(settings.replyTemplates, result, id);
    if (!replyText) return null;
    await startStage("Replying on WhatsApp");
    const delivered = await notifyWhatsApp(groupName, replyText, quote);
    await setLastResult(replyText);
    await setStatus(replyText);
    if (!delivered) {
      await failStage("Replying on WhatsApp", "Could not send the WhatsApp reply");
      return false;
    }
    await completeHudStage(background, "Replying on WhatsApp", id);
    stageLabel = "";
    await settleHudStage(background);
    if (result.status === "danger") {
      await setClaimState(id, "rejected");
      return true;
    }
    return false;
  }

  try {
    await setStatus(`Searching ${id}`);
    if (!background) await setHudStage("", "idle", "");

    if (kind === "national") {
      await startStage("Opening the committee website");
      const tab = await ensureCommitteeTab(settings.committeeUrl, background);
      await completeHudStage(background, "Opening the committee website", id);

      await startStage("Searching for the decision");
      const result = background ? await runCommitteeHidden(tab.id, id) : await runCommitteeVisible(tab.id, id);
      if (!result?.ok) {
        const message = result?.error || `No decision found for ${id}`;
        await failStage("Searching for the decision", message);
        return reportFailure("Searching for the decision", id, message);
      }
      await completeHudStage(background, "Searching for the decision", id);

      const committeeAnswer = await sendChatReply(result);
      if (committeeAnswer !== null) return committeeAnswer;

      await startStage("Getting the PDF");
      await setStatus(`Saving PDF for ${id}`);
      let base64 = "";
      try {
        base64 = await captureCommitteePdf(result, result.tabId || tab.id, background);
      } catch (error) {
        const message = `Could not download the committee decision for ${id}`;
        await failStage("Getting the PDF", error?.message || message);
        return reportFailure("Getting the PDF", id, message, error?.message || "");
      }
      await completeHudStage(background, "Getting the PDF", id);

      await startStage("Sending the PDF");
      const sent = await deliverPdf(current, groupName, base64);
      if (!sent) {
        const stored = await chrome.storage.local.get({ lastResult: "" });
        await failStage("Sending the PDF", stored.lastResult || "Could not send the PDF");
        return false;
      }
      await completeHudStage(background, "Sending the PDF", id);
      stageLabel = "";
      await settleHudStage(background);
      return true;
    }

    await startStage("Opening the iClaim website");
    const iclaimTab = await ensureIclaimTab(settings.worklistUrl, background);
    await completeHudStage(background, "Opening the iClaim website", id);

    await startStage("Searching for the claim");
    const result = await runSearch(iclaimTab.id, id);
    if (!result?.ok) {
      const message = result?.error || `No claim found for ${id}`;
      await failStage("Searching for the claim", message);
      return reportFailure("Searching for the claim", id, message);
    }
    await completeHudStage(background, "Searching for the claim", id);

    const claimAnswer = await sendChatReply(result);
    if (claimAnswer !== null) return claimAnswer;

    await startStage("Getting the PDF");
    await setStatus(`Saving PDF for ${id}`);
    let base64 = "";
    try {
      base64 = await capturePdf(result.documentUrl, iclaimTab.id);
    } catch (error) {
      const message = `Could not download the claim document for ${id}`;
      await failStage("Getting the PDF", error?.message || message);
      return reportFailure("Getting the PDF", id, message, error?.message || "");
    }
    await completeHudStage(background, "Getting the PDF", id);

    await startStage("Sending the PDF");
    const sent = await deliverPdf(current, groupName, base64);
    if (!sent) {
      const stored = await chrome.storage.local.get({ lastResult: "" });
      await failStage("Sending the PDF", stored.lastResult || "Could not send the PDF");
      return false;
    }
    await completeHudStage(background, "Sending the PDF", id);
    stageLabel = "";
    await settleHudStage(background);
    return true;
  } catch (error) {
    const message = error?.message || "The automation stopped";
    if (stageLabel) await failStage(stageLabel, message);
    else await setHudStage("Stopped", "error", message);
    throw error;
  }
}

async function drainQueue() {
  for (;;) {
    const session = await chrome.storage.session.get({ jobQueue: [] });
    const queue = session.jobQueue || [];
    if (!queue.length) return;

    let index = 0;
    if (await isTestingMode()) {
      index = queue.findIndex((job) => job.manual);
      if (index < 0) return;
    }

    const job = queue[index];
    const rest = queue.filter((_, itemIndex) => itemIndex !== index);
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
  if (!job.manual && (await isTestingMode())) return { ok: false };
  if (!settings.enabled && !job.manual) {
    await setStatus("Paused");
    return { ok: false };
  }

  const stored = await chrome.storage.local.get({ processedIds: [] });
  if ((stored.processedIds || []).includes(job.messageId)) return { ok: true, duplicate: true, reply: "" };

  const parsed = classifyClaimId(text);
  if (!parsed.ok) {
    if (settings.ignoreInvalid && !job.manual) return { ok: true, ignored: true };
    const reply = pickReply(settings.replyTemplates, "invalidId");
    if (job.manual) {
      await setLastResult(reply);
      await setStatus(reply);
      return { ok: false, error: reply };
    }
    const withinGap = await noteMessageGap(settings);
    if (!shouldSendReply(settings, "invalidId", withinGap)) return { ok: true, validation: true, reply: "" };
    await setLastResult(reply);
    await setStatus(reply);
    return { ok: true, validation: true, reply };
  }

  const id = parsed.id;
  const withinGap = job.manual ? false : await noteMessageGap(settings);
  const state = await claimState(id);
  if (state === "sent" || state === "rejected" || state === "pending") {
    const key = state === "sent" ? "alreadySent" : state === "rejected" ? "alreadyAnswered" : "alreadyGetting";
    if (!shouldSendReply(settings, key, withinGap)) return { ok: true, duplicate: true, reply: "" };
    const reply = pickReply(settings.replyTemplates, key, { id });
    await setStatus(reply);
    return { ok: true, duplicate: true, reply };
  }

  await setClaimState(id, "pending");

  const session = await chrome.storage.session.get({ jobQueue: [] });
  const queue = session.jobQueue || [];
  if (!queue.some((item) => item.messageId === job.messageId)) {
    queue.push({
      messageId: job.messageId,
      text: id,
      quoteText: text,
      kind: parsed.kind,
      groupName: job.groupName || settings.groupName,
      manual: job.manual === true,
      withinGap
    });
    await chrome.storage.session.set({ jobQueue: queue });
  }

  const ack = !job.manual && shouldSendReply(settings, "ack", withinGap);
  return { ok: true, start: true, ack };
}

async function noteMessageGap(settings) {
  const now = Date.now();
  const session = await chrome.storage.session.get({ lastClaimAt: 0 });
  const last = Number(session.lastClaimAt) || 0;
  const gapMs = settings.ackGapSeconds * 1000;
  const withinGap = gapMs > 0 && last > 0 && now - last <= gapMs;
  await chrome.storage.session.set({ lastClaimAt: now });
  return withinGap;
}

async function acceptAndRun(job) {
  const decision = await reserveClaim(job);
  if (decision.start) await drainQueue();
  return decision;
}

async function pauseOnLoad() {
  await chrome.storage.local.set({ workInBackground: false, hudStage: idleHudStage() });
  const current = await chrome.storage.local.get({ jobStatus: "" });
  if (/^(Searching|Saving|Sending|Detecting|Replying)/.test(current.jobStatus || "")) return;
  await chrome.storage.local.set({ enabled: false, jobStatus: "Paused" });
}

async function markWatching() {
  if (await isTestingMode()) return;
  const settings = await getSettings();
  if (!settings.enabled) {
    await setStatus("Paused");
    return;
  }
  const session = await chrome.storage.session.get({ jobQueue: [] });
  if ((session.jobQueue || []).length) return;
  const current = await chrome.storage.local.get({ jobStatus: "" });
  if (/^(Searching|Saving|Sending|Detecting|Replying)/.test(current.jobStatus || "")) return;
  await setStatus(`Watching ${settings.groupName}`);
}

chrome.runtime.onInstalled.addListener(() => {
  schedule(async () => {
    await ensureDefaults();
    await pauseOnLoad();
    await drainQueue();
  });
});

chrome.runtime.onStartup.addListener(() => {
  schedule(async () => {
    await pauseOnLoad();
    await drainQueue();
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message?.type === "TEST_DETECT" ||
    message?.type === "TEST_REPLY" ||
    message?.type === "TEST_SEARCH" ||
    message?.type === "TEST_ATTACH"
  ) {
    const task = async () => {
      try {
        if (message.type === "TEST_DETECT") return await testDetect();
        if (message.type === "TEST_REPLY") return await testReply(message.text);
        if (message.type === "TEST_SEARCH") return await testSearch(message.text);
        return await testAttach(message.text);
      } catch (error) {
        return failStage(error?.message || "The stage did not run");
      }
    };
    schedule(task)
      .then((result) => sendResponse(result || { ok: false, error: "The stage did not run" }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "RUN_CLAIM") {
    const text = String(message.text || "").trim();
    if (!text) {
      sendResponse({ ok: false, error: "Type a National ID or Claim ID" });
      return true;
    }
    schedule(() =>
      acceptAndRun({
        messageId: `manual-${Date.now()}`,
        text,
        manual: true
      })
    )
      .then((decision) => {
        if (decision && decision.ok === false) sendResponse(decision);
        else sendResponse({ ok: true });
      })
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

  if (message?.type === "DEBUGGER_KEY") {
    debuggerKey(String(message.key || ""), String(message.code || ""), Number(message.keyCode) || 0, Number(message.modifiers) || 0)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "DEBUGGER_TEXT") {
    debuggerInsertText(String(message.text || ""))
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled && changes.enabled.newValue === true) {
    kickstartAutomation().catch((error) => console.info("Iclaim automation:", error));
  }
  if (area !== "session" || !changes.testingMode || changes.testingMode.newValue === true) return;
  schedule(async () => {
    await drainQueue();
    await markWatching();
  });
});

schedule(() => drainQueue());
