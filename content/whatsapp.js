(function () {
  if (globalThis.__iclaimWhatsAppInstalled) return;
  globalThis.__iclaimWhatsAppInstalled = true;

  const SEEN_LIMIT = 200;
  const ACK_TEXT = "getting the IClaim";
  const state = {
    enabled: false,
    groupName: ICLAIM_DEFAULTS.groupName,
    seenIds: new Set(),
    seeded: false,
    armed: false,
    starting: false,
    releaseLatest: false,
    openingForNewMessage: false,
    ownTexts: [],
    testingMode: false
  };

  let sessionReady = false;
  let pauseOnStart = true;
  let kickStarted = false;
  let kickPromise = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitFor(fn, timeout = 10000, interval = 200) {
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        let value = null;
        try {
          value = fn();
        } catch (error) {
          value = null;
        }
        if (value) {
          clearInterval(timer);
          resolve(value);
        } else if (Date.now() - start >= timeout) {
          clearInterval(timer);
          resolve(null);
        }
      }, interval);
    });
  }

  function normalizeName(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function report(message) {
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  async function loadSettings() {
    const data = await chrome.storage.local.get(ICLAIM_DEFAULTS);
    state.groupName = normalizeName(data.groupName) || ICLAIM_DEFAULTS.groupName;
    const seen = await chrome.storage.local.get({ seenMessageIds: [] });
    for (const id of seen.seenMessageIds || []) state.seenIds.add(id);
    await refreshTestingMode();
  }

  async function refreshTestingMode() {
    try {
      const session = await chrome.storage.session.get({ testingMode: false });
      state.testingMode = session.testingMode === true;
      sessionReady = true;
    } catch (error) {
      sessionReady = false;
    }
  }

  async function absorbVisibleMessages() {
    if (!chatIsOpen(state.groupName)) return;
    const messages = chatMessages();
    if (!messages.length && !messageAreaReady()) return;
    const fresh = messages.filter((message) => message.id && !state.seenIds.has(message.id));
    const newest = fresh[fresh.length - 1];
    const absorbed = [];
    for (const message of messages) {
      if (newest && message.id === newest.id) continue;
      if (message.id && !state.seenIds.has(message.id)) absorbed.push(message.id);
      if (message.id) state.seenIds.add(message.id);
    }
    state.seeded = true;
    if (!absorbed.length) return;
    const data = await chrome.storage.local.get({ seenMessageIds: [] });
    const ids = data.seenMessageIds || [];
    for (const id of absorbed) {
      if (!ids.includes(id)) ids.push(id);
    }
    await chrome.storage.local.set({ seenMessageIds: ids.slice(-SEEN_LIMIT) });
  }

  async function persistEmitted(id) {
    state.seenIds.add(id);
    const data = await chrome.storage.local.get({ seenMessageIds: [] });
    const ids = data.seenMessageIds || [];
    if (!ids.includes(id)) ids.push(id);
    await chrome.storage.local.set({ seenMessageIds: ids.slice(-SEEN_LIMIT) });
  }

  async function forgetSeen(id) {
    if (!id) return;
    state.seenIds.delete(id);
    const data = await chrome.storage.local.get({ seenMessageIds: [] });
    const ids = data.seenMessageIds || [];
    const next = ids.filter((item) => item !== id);
    if (next.length !== ids.length) await chrome.storage.local.set({ seenMessageIds: next });
  }

  function conversationHeader() {
    return (
      document.querySelector("#main header") ||
      document.querySelector("#main [data-testid='conversation-header']") ||
      document.querySelector("#main [data-testid='conversation-info-header']")
    );
  }

  function openChatTitle() {
    const header = conversationHeader();
    if (!header) return "";
    const titled = [...header.querySelectorAll("[title]")]
      .map((element) => normalizeName(element.getAttribute("title")))
      .find(Boolean);
    if (titled) return titled;
    const named = [...header.querySelectorAll("span[dir='auto'], div[dir='auto']")]
      .map((element) => normalizeName(element.textContent))
      .find((text) => text && text.length < 80);
    if (named) return named;
    return normalizeName((header.innerText || "").split("\n")[0]);
  }

  function titlesMatch(left, right) {
    return normalizeName(left) === normalizeName(right);
  }

  function chatIsOpen(name) {
    const wanted = normalizeName(name);
    if (!wanted) return false;
    if (titlesMatch(openChatTitle(), wanted)) return true;
    const header = conversationHeader();
    if (!header) return false;
    return (header.innerText || "")
      .split("\n")
      .map(normalizeName)
      .some((line) => line === wanted || line.startsWith(`${wanted} `));
  }

  function findTitleElement(name, root) {
    const wanted = normalizeName(name);
    if (!wanted || !root) return null;
    const byTitle = [...root.querySelectorAll("[title]")].find(
      (element) => !element.closest("#main") && normalizeName(element.getAttribute("title")) === wanted
    );
    if (byTitle) return byTitle;
    const byText = [...root.querySelectorAll("span, div")].filter((element) => {
      if (element.closest("#main") || element.closest("footer")) return false;
      if (element.querySelectorAll("*").length > 3) return false;
      return normalizeName(element.textContent) === wanted;
    });
    byText.sort((left, right) => left.querySelectorAll("*").length - right.querySelectorAll("*").length);
    return byText[0] || null;
  }

  function findChatRow(name) {
    const pane = document.querySelector("#pane-side");
    if (!pane) return null;
    const title = findTitleElement(name, pane);
    if (!title) return null;
    return title.closest('[role="listitem"], [role="row"], [role="gridcell"]') || title.parentElement;
  }

  function clickElement(element) {
    const options = { bubbles: true, cancelable: true, view: window };
    element.dispatchEvent(new MouseEvent("mousedown", options));
    element.dispatchEvent(new MouseEvent("mouseup", options));
    element.dispatchEvent(new MouseEvent("click", options));
  }

  function searchBox() {
    return (
      document.querySelector('input[aria-label="Search or start a new chat"]') ||
      document.querySelector('input[placeholder="Search or start a new chat"]') ||
      document.querySelector('#side input[data-tab="3"]') ||
      document.querySelector('input[data-tab="3"][role="textbox"]') ||
      document.querySelector('#side div[contenteditable="true"][data-tab="3"]') ||
      document.querySelector('div[contenteditable="true"][data-tab="3"]') ||
      document.querySelector('[aria-label="Search input textbox"]') ||
      document.querySelector("#side div[contenteditable='true']")
    );
  }

  function replaceBoxText(element, text) {
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor && descriptor.set) descriptor.set.call(element, text);
      else element.value = text;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("delete", false, null);
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted) {
      element.textContent = text;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    }
  }

  async function clearSearch() {
    const box = searchBox();
    if (!box) return;
    const current = box instanceof HTMLInputElement ? box.value : box.textContent;
    if (!normalizeName(current)) return;
    replaceBoxText(box, "");
    await sleep(300);
  }

  async function openGroup(name) {
    await waitFor(() => document.querySelector("#pane-side"), 20000);
    if (chatIsOpen(name)) return;

    const existing = findChatRow(name);
    if (existing) {
      clickElement(existing);
      const opened = await waitFor(() => (chatIsOpen(name) ? true : null), 8000);
      if (opened) return;
    }

    const box = searchBox();
    if (!box) throw new Error("Could not find the WhatsApp search box");
    replaceBoxText(box, name);
    const found = await waitFor(() => {
      const pane = document.querySelector("#pane-side") || document.querySelector("#side") || document;
      const title = findTitleElement(name, pane);
      if (!title) return null;
      return title.closest('[role="listitem"], [role="row"], [role="gridcell"]') || title;
    }, 8000);
    if (!found) {
      await clearSearch();
      throw new Error(`Could not find the WhatsApp group "${name}"`);
    }
    clickElement(found);
    const opened = await waitFor(() => (chatIsOpen(name) ? true : null), 8000);
    await clearSearch();
    if (!opened) throw new Error(`Could not open the WhatsApp group "${name}"`);
  }

  function messageRow(node) {
    const container = node.closest('[data-testid="msg-container"]') || node;
    let parent = container.parentElement;
    for (let depth = 0; parent && depth < 6; depth += 1) {
      if (parent.querySelectorAll('[data-testid="msg-container"]').length > 1) break;
      if (
        parent.getAttribute("data-testid")?.startsWith("conv-msg-") ||
        parent.classList.contains("message-in") ||
        parent.classList.contains("message-out") ||
        parent.getAttribute("role") === "row"
      ) {
        return parent;
      }
      parent = parent.parentElement;
    }
    return container;
  }

  function messageScope(node) {
    return messageRow(node);
  }

  function onMySide(node) {
    const bubble = node.closest('[data-testid="msg-container"]') || node;
    const main = document.querySelector("#main");
    if (!main) return false;
    const bubbleRect = bubble.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    if (bubbleRect.width < 8 || bubbleRect.height < 8) return false;
    if (bubbleRect.width > mainRect.width * 0.92) return false;
    const center = bubbleRect.left + bubbleRect.width / 2;
    const mid = mainRect.left + mainRect.width / 2;
    const rtl = getComputedStyle(main).direction === "rtl";
    return rtl ? center < mid - 8 : center > mid + 8;
  }

  function isOutgoing(node) {
    if (!node) return false;
    const row = messageRow(node);
    if (row.classList.contains("message-out") || node.classList.contains("message-out")) return true;
    if (row.querySelector('[data-testid="tail-out"], [data-icon="tail-out"]')) return true;
    const id = row.getAttribute("data-id") || node.getAttribute("data-id") || "";
    if (id.startsWith("true_")) return true;
    for (const icon of row.querySelectorAll("[data-icon]")) {
      const name = icon.getAttribute("data-icon") || "";
      if (/^(msg|status)-(dbl)?check$/i.test(name)) return true;
    }
    for (const title of row.querySelectorAll("svg title")) {
      const name = title.textContent || "";
      if (/tail-out|msg-(dbl)?check|status-(dbl)?check/i.test(name)) return true;
    }
    const plain = row.querySelector("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text") || "";
    if (/\]\s+you:/i.test(plain)) return true;
    return onMySide(node);
  }

  function isFromOther(node) {
    if (!node || isOutgoing(node) || onMySide(node)) return false;
    const bubble = node.closest('[data-testid="msg-container"]') || node;
    const main = document.querySelector("#main");
    if (!main) return false;
    const bubbleRect = bubble.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    if (bubbleRect.width < 8 || bubbleRect.height < 8) return false;
    if (bubbleRect.width > mainRect.width * 0.92) return false;
    const center = bubbleRect.left + bubbleRect.width / 2;
    const mid = mainRect.left + mainRect.width / 2;
    const rtl = getComputedStyle(main).direction === "rtl";
    return rtl ? center > mid + 8 : center < mid - 8;
  }

  function messageContainers() {
    const main = document.querySelector("#main");
    if (!main) return [];
    return [...main.querySelectorAll('[data-testid="msg-container"]')].filter(
      (node) => !node.parentElement?.closest('[data-testid="msg-container"]') && isFromOther(node)
    );
  }

  function messageNodes() {
    const containers = messageContainers();
    if (containers.length) return containers;
    const main = document.querySelector("#main");
    if (!main) return [];
    return [...main.querySelectorAll('[data-testid^="conv-msg-"]')].filter((node) => isFromOther(node));
  }

  function messageText(node) {
    const selectable = node.querySelector('[data-testid="selectable-text"]') || node.querySelector(".selectable-text");
    if (!selectable) return "";
    const leaf = [...selectable.querySelectorAll("span")].find(
      (span) => normalizeName(span.textContent) && !span.querySelector("span")
    );
    const raw = normalizeName(leaf?.textContent || selectable.textContent);
    return raw.replace(/\s+\d{1,2}:\d{2}(?:\s*[ap]m)?$/i, "");
  }

  function messageIdentity(node) {
    const scope = messageScope(node);
    const dataId = scope?.getAttribute("data-id") || node.getAttribute("data-id") || "";
    if (dataId) return dataId;
    const testId = scope?.getAttribute("data-testid") || "";
    if (testId.startsWith("conv-msg-")) return testId.slice("conv-msg-".length);
    const plain = node.querySelector("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text") || "";
    const text = messageText(node);
    return plain || text ? `${plain}${text}` : "";
  }

  function readMessage(node) {
    const id = messageIdentity(node);
    if (!id) return null;
    const text = messageText(node);
    if (!text) return null;
    return { id, text };
  }

  function chatMessages() {
    return messageNodes().map(readMessage).filter(Boolean);
  }

  function messageAreaReady() {
    return Boolean(
      document.querySelector("#main [data-testid^='conv-msg-'], #main [data-testid='selectable-text'], #main .selectable-text")
    );
  }

  function freshMessages() {
    return chatMessages().filter((message) => !state.seenIds.has(message.id));
  }

  function isAckText(text) {
    return normalizeName(text) === normalizeName(ACK_TEXT);
  }

  function takeOwnText(text) {
    const wanted = normalizeName(text);
    const index = state.ownTexts.findIndex((item) => item === wanted);
    if (index < 0) return false;
    state.ownTexts.splice(index, 1);
    return true;
  }

  async function emitMessage(message) {
    if (!sessionReady) await refreshTestingMode();
    if (state.testingMode) return;
    if (!state.enabled || !message?.id || !message.text) return;
    if (isAckText(message.text) || takeOwnText(message.text)) {
      if (!state.seenIds.has(message.id)) {
        state.seenIds.add(message.id);
        await persistEmitted(message.id);
      }
      return;
    }
    if (state.seenIds.has(message.id)) return;
    state.seenIds.add(message.id);
    await persistEmitted(message.id);
    let decision = null;
    try {
      decision = await chrome.runtime.sendMessage({
        type: "RESERVE_CLAIM",
        messageId: message.id,
        text: message.text,
        groupName: state.groupName
      });
    } catch (error) {
      console.info("Iclaim automation:", error);
      return;
    }
    if (!decision?.ok) return;
    try {
      if (decision.validation) {
        if (decision.reply) await replyToClaim(message, decision.reply);
        return;
      }
      if (decision.duplicate) {
        if (decision.reply) await replyToClaim(message, decision.reply);
      } else {
        await acknowledgeClaim(message);
      }
    } catch (error) {
      console.info("Iclaim automation:", error);
    }
    if (!decision.start) return;
    report({
      type: "NEW_MESSAGE",
      messageId: message.id,
      text: message.text,
      groupName: state.groupName
    });
  }

  function markSentTextSeen(sentText) {
    const wanted = normalizeName(sentText);
    if (!wanted) return;
    for (const message of chatMessages()) {
      if (normalizeName(message.text) === wanted) state.seenIds.add(message.id);
    }
    const main = document.querySelector("#main");
    if (!main) return;
    for (const node of main.querySelectorAll('[data-testid="msg-container"], [data-testid^="conv-msg-"]')) {
      if (!isOutgoing(node)) continue;
      const id = messageIdentity(node);
      if (id) state.seenIds.add(id);
    }
  }

  async function checkMessages() {
    if (!state.armed || state.openingForNewMessage || state.starting) return;
    if (!sessionReady) await refreshTestingMode();
    if (state.testingMode || !state.enabled) return;
    if (!chatIsOpen(state.groupName)) {
      await openGroup(state.groupName);
      if (!chatIsOpen(state.groupName)) return;
    }

    if (!state.seeded) {
      const messages = chatMessages();
      if (!messages.length) return;
      const last = messages[messages.length - 1];
      if (state.releaseLatest && last) {
        state.releaseLatest = false;
        await forgetSeen(last.id);
      }
      for (const message of messages.slice(0, -1)) state.seenIds.add(message.id);
      state.seeded = true;
      if (last) await emitMessage(last);
      return;
    }

    for (const message of freshMessages()) await emitMessage(message);
  }

  let checkTimer = 0;
  let checkChain = Promise.resolve();
  let pollTimer = 0;

  function queueCheck() {
    checkChain = checkChain
      .then(() => checkMessages())
      .catch((error) => console.info("Iclaim automation:", error));
    return checkChain;
  }

  function scheduleCheck() {
    window.clearTimeout(checkTimer);
    checkTimer = window.setTimeout(queueCheck, 300);
  }

  function watchChat() {
    const root = document.body || document.documentElement;
    const observer = new MutationObserver(() => {
      scheduleCheck();
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  }

  function startPoll() {
    window.clearInterval(pollTimer);
    pollTimer = window.setInterval(queueCheck, 1000);
  }

  function visibleMessageIds() {
    const ids = new Set();
    const main = document.querySelector("#main");
    if (!main) return ids;
    for (const node of main.querySelectorAll('[data-testid="msg-container"]')) {
      const id = messageIdentity(node);
      if (id) ids.add(id);
    }
    return ids;
  }

  async function withDetectionPaused(work, sentText) {
    state.openingForNewMessage = true;
    const before = visibleMessageIds();
    try {
      await work();
      const wanted = normalizeName(sentText);
      if (wanted) state.ownTexts.push(wanted);
      await sleep(1200);
      const main = document.querySelector("#main");
      if (!main) return;
      for (const node of main.querySelectorAll('[data-testid="msg-container"]')) {
        const id = messageIdentity(node);
        if (!id) continue;
        const text = normalizeName(messageText(node));
        if (isOutgoing(node) || (wanted && text === wanted) || (!before.has(id) && !isFromOther(node))) {
          state.seenIds.add(id);
        }
      }
    } finally {
      state.openingForNewMessage = false;
    }
  }

  function findSendButton() {
    const selectors = [
      '[data-testid="wds-ic-send-filled"]',
      '[data-icon="wds-ic-send-filled"]',
      '[aria-label="Send 1 selected"]',
      '[aria-label^="Send"]',
      'button[aria-label="Send"]',
      'div[role="button"][aria-label="Send"]',
      '[data-icon="send"]'
    ];
    for (const selector of selectors) {
      for (const found of document.querySelectorAll(selector)) {
        const button = found.closest('[role="button"], button') || found;
        const label = button.getAttribute("aria-label") || "";
        if (!/^send\b/i.test(label) && !found.matches('[data-testid="wds-ic-send-filled"], [data-icon="wds-ic-send-filled"]')) {
          continue;
        }
        if (isVisible(button)) return button;
      }
    }
    const titled = [...document.querySelectorAll("svg title")].find((node) => node.textContent === "wds-ic-send-filled");
    const fromTitle = titled?.closest('[role="button"], button');
    return fromTitle && isVisible(fromTitle) ? fromTitle : null;
  }

  function findAttachButton() {
    const selectors = [
      'button[aria-label="Attach"]',
      '[aria-label="Attach"]',
      '[data-icon="plus-rounded"]',
      '[data-icon="plus"]',
      '[data-icon="clip"]',
      'span[data-icon="plus-rounded"]',
      'span[data-icon="plus"]'
    ];
    for (const selector of selectors) {
      const found = document.querySelector(selector);
      if (!found) continue;
      const button = found.closest("button, [role='button']") || found;
      if (isVisible(button)) return button;
    }
    const titled = [...document.querySelectorAll("svg title")].find((node) =>
      /^(plus|attach|ic-plus)/i.test(node.textContent || "")
    );
    const button = titled?.closest("button, [role='button']");
    return button && isVisible(button) ? button : null;
  }

  function findDocumentButton() {
    const span = [...document.querySelectorAll("span")].find((element) => normalizeName(element.textContent) === "Document");
    if (span) return span.closest("button, [role='button'], li") || span;
    const title = [...document.querySelectorAll("svg title")].find((node) =>
      /ic-description-filled/i.test(node.textContent || "")
    );
    return title?.closest("button, [role='button'], li, div") || null;
  }

  function fileInputBeside(start) {
    if (!start) return null;
    let node = start;
    for (let depth = 0; node && depth < 10; depth += 1) {
      const inputs = [...node.querySelectorAll('input[type="file"]')];
      const otherMenus = [...node.querySelectorAll("span")].filter((span) =>
        /^(Photos|Videos|Camera|Contact|Poll|Audio)$/i.test(normalizeName(span.textContent))
      );
      if (inputs.length === 1 && otherMenus.length === 0) return inputs[0];
      node = node.parentElement;
    }
    return null;
  }

  function findDocumentInput() {
    const marked = document.querySelector('input[type="file"][data-iclaim-file="1"]');
    if (marked) return marked;
    const multiple = document.querySelector('input[type="file"][multiple]');
    if (multiple && (multiple.getAttribute("accept") || "*") !== "image/*") return multiple;
    const beside = fileInputBeside(findDocumentButton());
    if (beside) return beside;

    const inputs = [...document.querySelectorAll('input[type="file"]')];
    let best = null;
    let bestScore = -1;
    for (const input of inputs) {
      const accept = (input.getAttribute("accept") || "").toLowerCase();
      let score = 0;
      if (accept === "*" || accept === "*/*" || accept === "") score += 6;
      if (accept.includes("pdf") || accept.includes("document")) score += 5;
      if (accept.includes("application")) score += 3;
      if ((accept.includes("image/") || accept.includes("video/")) && !accept.includes("pdf") && accept !== "*" && accept !== "*/*") {
        score -= 4;
      }
      const host = input.closest("li, button, [role='button'], div");
      if (host && /\bdocument\b/i.test(host.innerText || "")) score += 4;
      if (score > bestScore) {
        best = input;
        bestScore = score;
      }
    }
    return best;
  }

  async function ensureAttachMenu() {
    if (findDocumentButton() || findDocumentInput()) return;
    const attach = findAttachButton();
    if (!attach) throw new Error("Could not find the WhatsApp attach button");
    clickElement(attach);
    const opened = await waitFor(() => findDocumentButton() || findDocumentInput(), 8000);
    if (!opened) throw new Error("Could not open the WhatsApp attach menu");
  }

  async function revealDocumentInput() {
    const existing = findDocumentInput();
    if (existing) return existing;

    const prepared = await chrome.runtime.sendMessage({ type: "PATCH_FILE_CLICK" });
    if (!prepared?.ok) throw new Error(prepared?.error || "Could not prepare the WhatsApp file input");

    try {
      const button = findDocumentButton();
      if (!button) throw new Error("Could not find the WhatsApp Document button");
      clickElement(button);
      return await waitFor(
        () =>
          document.querySelector('input[type="file"][data-iclaim-file="1"]') ||
          document.querySelector('input[type="file"][multiple]') ||
          document.querySelector('input[type="file"][accept="*"]'),
        8000
      );
    } finally {
      chrome.runtime.sendMessage({ type: "RESTORE_FILE_CLICK" }).catch(() => {});
    }
  }

  function setInputFiles(input, file) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
    if (descriptor && descriptor.set) descriptor.set.call(input, transfer.files);
    else input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function base64ToFile(base64, filename) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], filename, { type: "application/pdf" });
  }

  function composeBox() {
    return (
      document.querySelector('#main [data-testid="conversation-compose-box-input"]') ||
      document.querySelector('[data-testid="conversation-compose-box-input"]') ||
      document.querySelector('div[data-lexical-editor="true"][data-tab="10"][role="textbox"]') ||
      document.querySelector('div[contenteditable="true"][aria-placeholder="Type a message"]') ||
      document.querySelector('#main footer div[contenteditable="true"][role="textbox"]') ||
      document.querySelector('div[contenteditable="true"][data-tab="10"][role="textbox"]')
    );
  }

  function captionBox() {
    return (
      document.querySelector('div[contenteditable="true"][aria-label*="caption" i]') ||
      composeBox()
    );
  }

  function messageBody(container) {
    if (!container) return null;
    const copy = container.querySelector("[data-pre-plain-text], .copyable-text, [data-testid='selectable-text']");
    if (!copy) return container.firstElementChild || container;
    let node = copy;
    while (node.parentElement && node.parentElement !== container) node = node.parentElement;
    return node.parentElement === container ? node : container;
  }

  function messageBubble(message) {
    const wantedId = message?.id || message;
    const wantedText = normalizeName(message?.text);
    const containers = messageContainers();
    const byId = containers.find((node) => messageIdentity(node) === wantedId);
    if (byId) return messageBody(byId);
    if (!wantedText) return null;
    const matches = containers.filter((node) => normalizeName(messageText(node)) === wantedText);
    return messageBody(matches[matches.length - 1] || null);
  }

  function messageScroller(element) {
    const main = document.querySelector("#main");
    let node = element?.parentElement || null;
    while (node && node !== document.documentElement) {
      if (main && node !== main && !main.contains(node)) break;
      const style = getComputedStyle(node);
      const overflow = style.overflowY || style.overflow;
      if (/(auto|scroll)/.test(overflow) && node.scrollHeight > node.clientHeight + 2) return node;
      if (node === main) break;
      node = node.parentElement;
    }
    return null;
  }

  function footerTop() {
    const footer = document.querySelector("#main footer");
    if (!footer) return window.innerHeight;
    return footer.getBoundingClientRect().top;
  }

  function animationFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  async function settleRect(element) {
    let previous = "";
    for (let frame = 0; frame < 10; frame += 1) {
      await animationFrame();
      const rect = element.getBoundingClientRect();
      const next = `${Math.round(rect.top)}:${Math.round(rect.bottom)}`;
      if (frame > 0 && next === previous) return;
      previous = next;
    }
  }

  async function revealMessage(element) {
    const margin = 12;
    const scroller = messageScroller(element);
    const rect = element.getBoundingClientRect();
    const paneTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const topLimit = paneTop + margin;
    const bottomLimit = footerTop() - margin;
    const fullyVisible = rect.width > 0 && rect.height > 0 && rect.top >= topLimit && rect.bottom <= bottomLimit;
    let delta = 0;
    if (rect.bottom > bottomLimit) delta = rect.bottom - bottomLimit;
    else if (rect.top < topLimit) delta = rect.top - topLimit;
    if (!fullyVisible && scroller && Math.abs(delta) >= 1) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
    }
    await settleRect(element);
  }

  function clickPoint(element, button) {
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + (button === "right" ? Math.min(Math.max(rect.height / 2, 8), 18) : rect.height / 2));
    return { x, y };
  }

  function rightClickPoint(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return null;
    const x = Math.round(rect.left + rect.width / 2);
    const preferred = rect.top + Math.min(Math.max(rect.height / 2, 8), 18);
    const inset = Math.min(4, rect.height / 2);
    const minY = rect.top + inset;
    const maxY = Math.min(rect.bottom - inset, footerTop() - 8);
    if (maxY < minY) return null;
    return { x, y: Math.round(Math.max(minY, Math.min(preferred, maxY))) };
  }

  function pointHitsMessage(element, point) {
    const hit = document.elementFromPoint(point.x, point.y);
    if (!hit || !element.contains(hit)) return false;
    const footer = document.querySelector("#main footer");
    return !footer || !footer.contains(hit);
  }

  async function dispatchTrustedClick(point, button) {
    const response = await chrome.runtime.sendMessage({
      type: "DEBUGGER_CLICK",
      x: point.x,
      y: point.y,
      button
    });
    if (!response?.ok) throw new Error(response?.error || "Could not click in WhatsApp");
  }

  async function trustedClick(element, button) {
    await dispatchTrustedClick(clickPoint(element, button), button);
  }

  async function rightClickMessage(element) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await revealMessage(element);
      const point = rightClickPoint(element);
      if (point && pointHitsMessage(element, point)) {
        await dispatchTrustedClick(point, "right");
        return true;
      }
      const scroller = messageScroller(element);
      if (!scroller) return false;
      const before = scroller.scrollTop;
      scroller.scrollTop = before + 36;
      await settleRect(element);
      if (scroller.scrollTop === before) return false;
    }
    return false;
  }

  function replyMenuItem() {
    for (const title of document.querySelectorAll("svg title")) {
      if ((title.textContent || "") !== "ic-reply") continue;
      let node = title.parentElement;
      for (let depth = 0; node && depth < 8; depth += 1) {
        if (normalizeName(node.innerText) === "Reply" && isVisible(node)) {
          return node.closest('[role="button"], button, li') || node;
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  function closeQuoteMenu() {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true })
    );
  }

  async function quoteMessage(message) {
    const bubble = messageBubble(message);
    if (!bubble) return false;

    const attached = await chrome.runtime.sendMessage({ type: "DEBUGGER_ATTACH" });
    if (!attached?.ok) return false;
    await sleep(400);

    try {
      const opened = await rightClickMessage(bubble);
      let reply = opened ? await waitFor(() => replyMenuItem(), 1500) : null;
      const container = bubble.closest('[data-testid="msg-container"]');
      if (!reply && container && container !== bubble) {
        const retried = await rightClickMessage(container);
        if (retried) reply = await waitFor(() => replyMenuItem(), 800);
      }
      if (!reply) {
        closeQuoteMenu();
        return false;
      }
      await trustedClick(reply, "left");
      await sleep(250);
      return true;
    } finally {
      chrome.runtime.sendMessage({ type: "DEBUGGER_DETACH" }).catch(() => {});
    }
  }

  function quotedBlock(element) {
    return element.querySelector('[data-testid*="quote" i], [data-testid="quoted-message"], [aria-label*="Quoted" i]');
  }

  function typedText(element) {
    if (!element) return "";
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value || "";
    const quote = quotedBlock(element);
    const lexical = [...element.querySelectorAll('[data-lexical-text="true"]')].filter((node) => !quote || !quote.contains(node));
    if (lexical.length) return lexical.map((node) => node.textContent || "").join("");
    if (!quote) return element.innerText || element.textContent || "";
    const copy = element.cloneNode(true);
    copy.querySelector('[data-testid*="quote" i], [data-testid="quoted-message"], [aria-label*="Quoted" i]')?.remove();
    return copy.innerText || copy.textContent || "";
  }

  function boxMatches(element, text) {
    return normalizeName(typedText(element)) === normalizeName(text);
  }

  async function sendDebuggerKey(key, code, keyCode, modifiers) {
    const response = await chrome.runtime.sendMessage({
      type: "DEBUGGER_KEY",
      key,
      code,
      keyCode,
      modifiers
    });
    if (!response?.ok) throw new Error(response?.error || "Could not type in WhatsApp");
  }

  function liveCompose(element, fallback) {
    if (element && document.contains(element)) return element;
    return composeBox() || fallback || null;
  }

  async function replaceComposeText(element, text) {
    const box = element || composeBox();
    if (!box) return false;
    const attached = await chrome.runtime.sendMessage({ type: "DEBUGGER_ATTACH" });
    if (!attached?.ok) throw new Error(attached?.error || "Could not control the WhatsApp message box");
    try {
      await dispatchTrustedClick(clickPoint(box, "left"), "left");
      await sleep(150);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const live = liveCompose(element, box);
        if (!live || !normalizeName(typedText(live))) break;
        await sendDebuggerKey("a", "KeyA", 65, 2);
        await sleep(60);
        await sendDebuggerKey("Backspace", "Backspace", 8, 0);
        await sleep(120);
      }
      const cleared = liveCompose(element, box);
      if (!cleared || normalizeName(typedText(cleared))) return false;
      if (!text) return true;
      const inserted = await chrome.runtime.sendMessage({ type: "DEBUGGER_TEXT", text });
      if (!inserted?.ok) throw new Error(inserted?.error || "Could not type in WhatsApp");
      await sleep(150);
      return boxMatches(liveCompose(element, cleared), text);
    } finally {
      chrome.runtime.sendMessage({ type: "DEBUGGER_DETACH" }).catch(() => {});
    }
  }

  async function fillBox(element, text) {
    return replaceComposeText(element, text);
  }

  function composeSendButton() {
    const footer = document.querySelector("#main footer");
    if (!footer) return null;
    const buttons = footer.querySelectorAll('button[aria-label="Send"], [role="button"][aria-label="Send"]');
    for (const button of buttons) {
      if (button.getAttribute("aria-label") === "Send" && isVisible(button)) return button;
    }
    return null;
  }

  async function typeAndSend(text) {
    const box = await waitFor(() => composeBox(), 8000);
    if (!box) throw new Error("Could not find the WhatsApp message box");
    const filled = await fillBox(box, text);
    const current = composeBox() || box;
    if (!filled || !boxMatches(current, text)) {
      const leftover = normalizeName(typedText(current));
      if (leftover && leftover !== normalizeName(text)) {
        throw new Error("Could not clear the WhatsApp message box");
      }
      throw new Error("The WhatsApp message box did not contain the reply");
    }
    const send = await waitFor(() => {
      const live = composeBox();
      if (!live || !boxMatches(live, text)) return null;
      return composeSendButton();
    }, 5000);
    const readyBox = composeBox() || box;
    const readySend = composeSendButton();
    if (!boxMatches(readyBox, text)) {
      throw new Error("The WhatsApp message box did not contain the reply");
    }
    if (!send || !readySend || readySend.getAttribute("aria-label") !== "Send") {
      throw new Error("Could not find the WhatsApp send button");
    }
    clickElement(readySend);
  }

  async function replyToClaim(message, text) {
    await withDetectionPaused(async () => {
      await openGroup(state.groupName);
      await quoteMessage(message);
      await typeAndSend(text);
    }, text);
  }

  async function acknowledgeClaim(message) {
    await replyToClaim(message, ACK_TEXT);
  }

  function findClaimMessage(claimText) {
    const wanted = normalizeName(claimText);
    const messages = chatMessages();
    if (!wanted) return messages[messages.length - 1] || null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (normalizeName(messages[index].text).includes(wanted)) return messages[index];
    }
    return null;
  }

  async function sendTextMessage(groupName, text, quoteText) {
    await withDetectionPaused(async () => {
      await openGroup(groupName);
      const quote = normalizeName(quoteText);
      if (quote) {
        const target = await waitFor(() => findClaimMessage(quote), 4000);
        if (target) {
          try {
            await quoteMessage(target);
          } catch (error) {
            closeQuoteMenu();
          }
        }
      }
      await typeAndSend(text);
    }, text);
  }

  function previewReady(filename) {
    const button = findSendButton();
    if (!button) return null;
    const label = button.getAttribute("aria-label") || "";
    if (/^send\b/i.test(label) && label !== "Send") return button;
    if (button.querySelector('[data-testid="wds-ic-send-filled"], [data-icon="wds-ic-send-filled"]')) return button;
    const scopes = [...document.querySelectorAll("footer, [role='dialog'], [data-animate-modal-popup]")];
    const blob = scopes.map((element) => element.innerText || "").join("\n");
    if (filename && blob.includes(filename)) return button;
    if (document.querySelector('div[contenteditable="true"][aria-label*="caption" i]')) return button;
    if (document.querySelector('[data-icon="document"], [data-icon="pdf-file"]')) return button;
    return null;
  }

  async function ensureComposeEmpty() {
    const box = await waitFor(() => composeBox(), 8000);
    if (!box) throw new Error("Could not find the WhatsApp message box");
    if (!normalizeName(typedText(box))) return;
    const cleared = await replaceComposeText(box, "");
    if (!cleared) throw new Error("Could not clear the WhatsApp message box");
  }

  async function finishPdfSend(send) {
    const captionField = captionBox();
    if (captionField && normalizeName(typedText(captionField))) {
      const cleared = await replaceComposeText(captionField, "");
      if (!cleared) throw new Error("Could not clear the WhatsApp caption");
    }
    clickElement(findSendButton() || send);
    await sleep(400);
  }

  async function sendPdfMessage({ base64, filename, groupName }) {
    await withDetectionPaused(async () => {
      await openGroup(groupName);
      await ensureComposeEmpty();
      const file = base64ToFile(base64, filename);
      await ensureAttachMenu();
      const input = await revealDocumentInput();
      if (!input) throw new Error("Could not find the WhatsApp file input");
      setInputFiles(input, file);
      const send = await waitFor(() => previewReady(filename), 12000);
      if (!send) throw new Error("WhatsApp did not open the file preview");
      await finishPdfSend(send);
    }, "");
  }

  async function prepareGroup(groupName) {
    const name = normalizeName(groupName) || state.groupName;
    state.groupName = name;
    await openGroup(name);
    await waitFor(() => (chatIsOpen(name) && (messageAreaReady() || chatMessages().length) ? true : null), 8000);
    return name;
  }

  async function readIncoming(groupName) {
    const name = await prepareGroup(groupName);
    const main = document.querySelector("#main");
    const messages = chatMessages();
    console.info("Iclaim detect:", messages.map((message) => message.text));
    return { name, main, messages };
  }

  function requestKickstart() {
    if (kickPromise) return kickPromise;
    if (kickStarted) return Promise.resolve({ ok: true, already: true });
    kickStarted = true;
    pauseOnStart = false;
    state.starting = true;
    kickPromise = kickstart()
      .catch((error) => {
        const message = error?.message || "Could not open the WhatsApp group";
        report({ type: "STATUS", status: message });
        return { ok: false, error: message };
      })
      .finally(() => {
        kickPromise = null;
      });
    return kickPromise;
  }

  async function kickstart() {
    state.enabled = true;
    state.testingMode = false;
    sessionReady = true;
    state.starting = true;
    try {
      try {
        await chrome.storage.session.set({ testingMode: false });
      } catch (error) {
        // Testing mode is already closed when automation is turned on.
      }
      state.testingMode = false;
      sessionReady = true;
      if (!state.enabled) return { ok: false, error: "Paused" };
      report({ type: "STATUS", status: "Detecting messages" });
      let detected = await readIncoming(state.groupName);
      if (!state.enabled) return { ok: false, error: "Paused" };
      if (!detected.messages.length) {
        await waitFor(() => (chatMessages().length ? true : null), 8000);
        detected = {
          name: detected.name,
          main: document.querySelector("#main"),
          messages: chatMessages()
        };
        console.info("Iclaim detect:", detected.messages.map((message) => message.text));
      }
      const messages = detected.messages;
      if (!messages.length) {
        state.seeded = false;
        state.releaseLatest = true;
        report({ type: "STATUS", status: "No incoming message yet" });
        return { ok: true, messages: [] };
      }
      const latest = messages[messages.length - 1];
      state.releaseLatest = false;
      await absorbVisibleMessages();
      await forgetSeen(latest.id);
      if (!state.enabled) return { ok: false, error: "Paused" };
      state.testingMode = false;
      state.seeded = true;
      await emitMessage(latest);
      return {
        ok: true,
        messages: messages.map((message) => ({
          text: message.text,
          seen: message.id !== latest.id && state.seenIds.has(message.id)
        }))
      };
    } finally {
      state.starting = false;
    }
  }

  async function testDetect(groupName) {
    const { name, main, messages } = await readIncoming(groupName);
    return {
      ok: true,
      chatOpen: chatIsOpen(name),
      containerCount: main ? main.querySelectorAll('[data-testid="msg-container"]').length : 0,
      messages: messages.map((message) => ({
        text: message.text,
        seen: state.seenIds.has(message.id)
      }))
    };
  }

  async function testReply(groupName, claimText) {
    await prepareGroup(groupName);
    const wanted = normalizeName(claimText);
    const target = findClaimMessage(claimText);
    if (!target) {
      return { ok: false, error: wanted ? `No incoming message contains ${wanted}` : "No incoming message to reply to" };
    }
    await replyToClaim(target, "test reply");
    return { ok: true, repliedTo: target.text };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "KICKSTART") {
      const run = async () => {
        const stored = await chrome.storage.local.get({ enabled: false });
        if (stored.enabled !== true) return { ok: false, error: "Paused" };
        if (message.groupName) state.groupName = normalizeName(message.groupName) || state.groupName;
        state.enabled = true;
        pauseOnStart = false;
        return requestKickstart();
      };
      run()
        .then((result) => sendResponse(result || { ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "TEST_DETECT" || message?.type === "TEST_REPLY") {
      const run = () =>
        message.type === "TEST_DETECT" ? testDetect(message.groupName) : testReply(message.groupName, message.text);
      run()
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "SEND_PDF") {
      sendPdfMessage(message)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "SEND_TEXT") {
      sendTextMessage(message.groupName, message.text, message.quoteText)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session") {
      if (!changes.testingMode) return;
      const testing = changes.testingMode.newValue === true;
      state.testingMode = testing;
      sessionReady = true;
      if (!testing && state.enabled && !state.starting) {
        absorbVisibleMessages()
          .catch((error) => console.info("Iclaim automation:", error))
          .then(() => queueCheck());
      }
      return;
    }
    if (area !== "local") return;
    if (changes.groupName) {
      state.groupName = normalizeName(changes.groupName.newValue) || ICLAIM_DEFAULTS.groupName;
      state.seeded = false;
      state.releaseLatest = false;
    }
    if (changes.enabled) {
      const enabled = changes.enabled.newValue !== false;
      if (enabled) pauseOnStart = false;
      state.enabled = enabled;
      if (!state.enabled) {
        state.releaseLatest = false;
        kickStarted = false;
      }
      if (state.enabled) requestKickstart();
    }
    if (changes.groupName && state.enabled && !changes.enabled) {
      openGroup(state.groupName)
        .then(() => queueCheck())
        .catch((error) => report({ type: "STATUS", status: error.message || "Could not open the WhatsApp group" }));
    }
  });

  async function pauseWatcher() {
    const current = await chrome.storage.local.get({ jobStatus: "" });
    if (!pauseOnStart) return;
    const patch = { enabled: false };
    if (!/^(Searching|Saving|Sending|Detecting|Replying)/.test(current.jobStatus || "")) {
      patch.jobStatus = "Paused";
    }
    if (!pauseOnStart) return;
    state.enabled = false;
    await chrome.storage.local.set(patch);
    if (pauseOnStart || state.enabled) return;
    state.enabled = true;
    await chrome.storage.local.set({ enabled: true });
  }

  async function start() {
    await loadSettings();
    await pauseWatcher();
    await new Promise((resolve) => {
      if (document.querySelector("#pane-side")) {
        resolve();
        return;
      }
      const observer = new MutationObserver(() => {
        if (!document.querySelector("#pane-side")) return;
        observer.disconnect();
        resolve();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });

    state.armed = true;
    watchChat();
    startPoll();
  }

  start().catch((error) => {
    report({ type: "STATUS", status: error.message || "WhatsApp watcher did not start" });
  });
})();
