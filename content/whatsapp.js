(function () {
  if (globalThis.__iclaimWhatsAppInstalled) return;
  globalThis.__iclaimWhatsAppInstalled = true;

  const SEEN_LIMIT = 200;
  const ACK_TEXT = "getting the IClaim";
  const state = {
    enabled: true,
    groupName: ICLAIM_DEFAULTS.groupName,
    seenIds: new Set(),
    seeded: false,
    armed: false,
    openingForNewMessage: false,
    ownTexts: []
  };

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
    state.enabled = data.enabled !== false;
    state.groupName = normalizeName(data.groupName) || ICLAIM_DEFAULTS.groupName;
    const seen = await chrome.storage.local.get({ seenMessageIds: [] });
    for (const id of seen.seenMessageIds || []) state.seenIds.add(id);
  }

  async function persistEmitted(id) {
    state.seenIds.add(id);
    const data = await chrome.storage.local.get({ seenMessageIds: [] });
    const ids = data.seenMessageIds || [];
    if (!ids.includes(id)) ids.push(id);
    await chrome.storage.local.set({ seenMessageIds: ids.slice(-SEEN_LIMIT) });
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
    if (!state.armed || !state.enabled || state.openingForNewMessage) return;
    if (!chatIsOpen(state.groupName)) return;

    if (!state.seeded) {
      const messages = chatMessages();
      if (!messages.length && !messageAreaReady()) return;
      for (const message of messages.slice(0, -1)) state.seenIds.add(message.id);
      state.seeded = true;
      const last = messages[messages.length - 1];
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
      document.querySelector('#main footer div[contenteditable="true"]') ||
      document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
      document.querySelector('div[contenteditable="true"][data-tab="10"]')
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

  function clickPoint(element, button) {
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + (button === "right" ? Math.min(Math.max(rect.height / 2, 8), 18) : rect.height / 2));
    return { x, y };
  }

  async function trustedClick(element, button) {
    const point = clickPoint(element, button);
    const response = await chrome.runtime.sendMessage({
      type: "DEBUGGER_CLICK",
      x: point.x,
      y: point.y,
      button
    });
    if (!response?.ok) throw new Error(response?.error || "Could not click in WhatsApp");
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
    bubble.scrollIntoView({ block: "center", inline: "nearest" });

    const attached = await chrome.runtime.sendMessage({ type: "DEBUGGER_ATTACH" });
    if (!attached?.ok) return false;
    await sleep(400);

    try {
      await trustedClick(bubble, "right");
      let reply = await waitFor(() => replyMenuItem(), 1500);
      const container = bubble.closest('[data-testid="msg-container"]');
      if (!reply && container && container !== bubble) {
        await trustedClick(container, "right");
        reply = await waitFor(() => replyMenuItem(), 800);
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

  function clearBox(element) {
    element.focus();
    const quote = quotedBlock(element);
    const lexical = [...element.querySelectorAll('[data-lexical-text="true"]')].filter((node) => !quote || !quote.contains(node));
    const selection = window.getSelection();
    const range = document.createRange();
    if (lexical.length) {
      range.setStartBefore(lexical[0]);
      range.setEndAfter(lexical[lexical.length - 1]);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("delete", false, null);
    } else if (!quote) {
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } else {
      return;
    }
    if (normalizeName(typedText(element)) && !quote) {
      element.textContent = "";
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    }
  }

  async function fillBox(element, text) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      clearBox(element);
      await sleep(80);
      element.focus();
      if (!quotedBlock(element)) document.execCommand("selectAll", false, null);
      const inserted = document.execCommand("insertText", false, text);
      if (!inserted) {
        element.dispatchEvent(
          new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text })
        );
        document.execCommand("insertText", false, text);
      }
      await sleep(80);
      if (boxMatches(element, text)) return true;
    }
    return false;
  }

  async function typeAndSend(text) {
    const box = await waitFor(() => composeBox(), 8000);
    if (!box) throw new Error("Could not find the WhatsApp message box");
    const filled = await fillBox(box, text);
    const current = composeBox() || box;
    if (!filled || !boxMatches(current, text)) {
      clearBox(current);
      throw new Error("The WhatsApp message box did not contain the reply");
    }
    const send = await waitFor(() => findSendButton(), 5000);
    if (!send) throw new Error("Could not find the WhatsApp send button");
    if (!boxMatches(composeBox() || box, text)) {
      clearBox(composeBox() || box);
      throw new Error("The WhatsApp message box did not contain the reply");
    }
    clickElement(send);
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

  async function sendTextMessage(groupName, text) {
    await withDetectionPaused(async () => {
      await openGroup(groupName);
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

  async function finishPdfSend(caption, send) {
    const captionField = caption ? captionBox() : null;
    if (caption && captionField) {
      const filled = await fillBox(captionField, caption);
      if (!filled || !boxMatches(captionField, caption)) {
        clearBox(captionField);
        throw new Error("The WhatsApp caption did not match the claim number");
      }
    }
    clickElement(findSendButton() || send);
    await sleep(400);
    const mainBox = composeBox();
    if (mainBox && normalizeName(typedText(mainBox))) clearBox(mainBox);
  }

  async function sendPdfMessage({ base64, filename, caption, groupName }) {
    await withDetectionPaused(async () => {
      await openGroup(groupName);
      const file = base64ToFile(base64, filename);
      await ensureAttachMenu();
      const input = await revealDocumentInput();
      if (!input) throw new Error("Could not find the WhatsApp file input");
      setInputFiles(input, file);
      const send = await waitFor(() => previewReady(filename), 12000);
      if (!send) throw new Error("WhatsApp did not open the file preview");
      await finishPdfSend(caption, send);
    }, caption);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SEND_PDF") {
      sendPdfMessage(message)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === "SEND_TEXT") {
      sendTextMessage(message.groupName, message.text)
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
    if (area !== "local") return;
    if (changes.enabled) state.enabled = changes.enabled.newValue !== false;
    if (changes.groupName) {
      state.groupName = normalizeName(changes.groupName.newValue) || ICLAIM_DEFAULTS.groupName;
      state.seeded = false;
      openGroup(state.groupName)
        .then(() => queueCheck())
        .catch((error) => report({ type: "STATUS", status: error.message || "Could not open the WhatsApp group" }));
    }
  });

  async function start() {
    await loadSettings();
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
    if (state.enabled) report({ type: "WATCHING" });

    await openGroup(state.groupName);
    await waitFor(() => (chatIsOpen(state.groupName) && messageAreaReady() ? true : null), 20000);
    await queueCheck();
  }

  start().catch((error) => {
    report({ type: "STATUS", status: error.message || "WhatsApp watcher did not start" });
  });
})();
