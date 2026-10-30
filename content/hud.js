(() => {
  if (window.__iclaimHud || window.top !== window) return;
  window.__iclaimHud = true;

  const host = document.createElement("div");
  host.setAttribute("data-iclaim-hud", "1");
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty("left", "16px", "important");
  host.style.setProperty("bottom", "16px", "important");
  host.style.setProperty("z-index", "2147483647", "important");
  host.style.setProperty("margin", "0", "important");
  host.style.setProperty("padding", "0", "important");
  host.style.setProperty("pointer-events", "none", "important");
  host.style.setProperty("background", "transparent", "important");

  const shadow = host.attachShadow({ mode: "open" });
  const iconUrl = chrome.runtime.getURL("icons/icon128.png");
  const style = document.createElement("style");
  style.textContent = `
    :host { color-scheme: light; }
    * { box-sizing: border-box; }
    button, .card {
      pointer-events: auto;
      font: 13px/1.4 "Segoe UI", sans-serif;
    }
    button {
      border: 0;
      padding: 0;
      cursor: pointer;
    }
    .card {
      width: 240px;
      padding: 10px 12px;
      background: #ffffff;
      color: #10211e;
      border: 1px solid #d7e3df;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(16, 33, 30, 0.16);
    }
    .card.is-hidden, .mark.is-hidden { display: none; }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .brand {
      width: 22px;
      height: 22px;
      border-radius: 7px;
      background: url("${iconUrl}") center / cover no-repeat;
    }
    .hide {
      width: 22px;
      height: 22px;
      border-radius: 7px;
      background: #f4f7f6;
      color: #5d6f6b;
      font-size: 16px;
      line-height: 22px;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 4px;
    }
    .name {
      color: #5d6f6b;
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .value {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #9aa8a4;
    }
    .value[data-on="1"] .dot { background: #0f766e; }
    .stage {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #d7e3df;
    }
    .stage.is-hidden { display: none; }
    .copy { min-width: 0; }
    .label { font-weight: 600; }
    .detail {
      margin-top: 2px;
      color: #5d6f6b;
      font-size: 12px;
      max-height: 4.6em;
      overflow: auto;
      overflow-wrap: anywhere;
    }
    .detail.is-hidden { display: none; }
    .detail.is-error { color: #b42318; }
    .icon {
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
      margin-top: 2px;
      display: grid;
      place-items: center;
    }
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid #d7e3df;
      border-top-color: #0f766e;
      border-radius: 50%;
      animation: iclaim-spin 0.7s linear infinite;
    }
    .tick { color: #0f766e; font-size: 15px; font-weight: 700; }
    .cross { color: #b42318; font-size: 14px; font-weight: 700; }
    .icon > .is-hidden { display: none; }
    .mark {
      pointer-events: auto;
      width: 36px;
      height: 36px;
      border-radius: 12px;
      background: url("${iconUrl}") center / cover no-repeat;
      box-shadow: 0 8px 24px rgba(16, 33, 30, 0.16);
    }
    .mark.is-live { animation: iclaim-pulse 1.4s ease-out infinite; }
    .mark.is-error { box-shadow: 0 0 0 2px #b42318; }
    @keyframes iclaim-spin { to { transform: rotate(360deg); } }
    @keyframes iclaim-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(15, 118, 110, 0.55); }
      70% { box-shadow: 0 0 0 8px rgba(15, 118, 110, 0); }
    }
  `;

  const card = document.createElement("section");
  card.className = "card is-hidden";

  const top = document.createElement("div");
  top.className = "top";
  const brand = document.createElement("div");
  brand.className = "brand";
  brand.setAttribute("aria-hidden", "true");
  const hide = document.createElement("button");
  hide.className = "hide";
  hide.type = "button";
  hide.setAttribute("aria-label", "Minimize");
  hide.textContent = "\u2013";
  top.append(brand, hide);

  function statusRow(name) {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = name;
    const value = document.createElement("span");
    value.className = "value";
    const dot = document.createElement("span");
    dot.className = "dot";
    const text = document.createElement("span");
    text.textContent = "Off";
    value.append(dot, text);
    row.append(label, value);
    return { row, value, text };
  }

  const automation = statusRow("Automation");
  const background = statusRow("Background");

  const stage = document.createElement("div");
  stage.className = "stage is-hidden";
  stage.setAttribute("aria-live", "polite");
  const copy = document.createElement("div");
  copy.className = "copy";
  const stageLabel = document.createElement("div");
  stageLabel.className = "label";
  const stageDetail = document.createElement("div");
  stageDetail.className = "detail is-hidden";
  copy.append(stageLabel, stageDetail);
  const icon = document.createElement("div");
  icon.className = "icon";
  const spinner = document.createElement("div");
  spinner.className = "spinner is-hidden";
  spinner.setAttribute("aria-hidden", "true");
  const tick = document.createElement("div");
  tick.className = "tick is-hidden";
  tick.textContent = "\u2713";
  tick.setAttribute("aria-hidden", "true");
  const cross = document.createElement("div");
  cross.className = "cross is-hidden";
  cross.textContent = "\u2715";
  cross.setAttribute("aria-hidden", "true");
  icon.append(spinner, tick, cross);
  stage.append(copy, icon);

  card.append(top, automation.row, background.row, stage);

  const mark = document.createElement("button");
  mark.className = "mark is-hidden";
  mark.type = "button";
  mark.setAttribute("aria-label", "Show Iclaim status");

  shadow.append(style, card, mark);

  const state = {
    enabled: false,
    workInBackground: false,
    hudCollapsed: false,
    hudStage: { label: "", phase: "idle", detail: "" }
  };

  function show(element, visible) {
    element.classList.toggle("is-hidden", !visible);
  }

  function render() {
    const stageState = state.hudStage || { label: "", phase: "idle", detail: "" };
    const phase = stageState.phase || "idle";
    const active = phase === "running" || phase === "done" || phase === "error";
    automation.text.textContent = state.enabled ? "On" : "Off";
    automation.value.dataset.on = state.enabled ? "1" : "0";
    background.text.textContent = state.workInBackground ? "On" : "Off";
    background.value.dataset.on = state.workInBackground ? "1" : "0";
    show(card, !state.hudCollapsed);
    show(mark, state.hudCollapsed);
    mark.classList.toggle("is-live", state.hudCollapsed && phase === "running");
    mark.classList.toggle("is-error", state.hudCollapsed && phase === "error");
    show(stage, active);
    stageLabel.textContent = stageState.label || "";
    stageDetail.textContent = stageState.detail || "";
    show(stageDetail, Boolean(stageState.detail));
    stageDetail.classList.toggle("is-error", phase === "error");
    show(spinner, phase === "running");
    show(tick, phase === "done");
    show(cross, phase === "error");
  }

  function apply(data) {
    state.enabled = data.enabled !== false;
    state.workInBackground = data.workInBackground === true;
    state.hudCollapsed = data.hudCollapsed === true;
    const next = data.hudStage;
    state.hudStage = next && typeof next === "object"
      ? next
      : { label: "", phase: "idle", detail: "" };
    render();
  }

  let reattaches = 0;

  function attach() {
    try {
      const root = document.documentElement;
      if (!root || host.isConnected || reattaches > 20) return;
      reattaches += 1;
      root.appendChild(host);
    } catch (error) {
      // Some XML documents cannot hold the card.
    }
  }

  hide.addEventListener("click", () => {
    state.hudCollapsed = true;
    render();
    chrome.storage.local.set({ hudCollapsed: true }).catch(() => {});
  });

  mark.addEventListener("click", () => {
    state.hudCollapsed = false;
    render();
    chrome.storage.local.set({ hudCollapsed: false }).catch(() => {});
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled) state.enabled = changes.enabled.newValue !== false;
    if (changes.workInBackground) state.workInBackground = changes.workInBackground.newValue === true;
    if (changes.hudCollapsed) state.hudCollapsed = changes.hudCollapsed.newValue === true;
    if (changes.hudStage) {
      const next = changes.hudStage.newValue;
      state.hudStage = next && typeof next === "object"
        ? next
        : { label: "", phase: "idle", detail: "" };
    }
    render();
  });

  attach();
  try {
    if (document.documentElement) {
      new MutationObserver(attach).observe(document.documentElement, { childList: true });
    }
  } catch (error) {
    // The document cannot be observed.
  }
  chrome.storage.local
    .get({
      enabled: false,
      workInBackground: false,
      hudCollapsed: false,
      hudStage: { label: "", phase: "idle", detail: "" }
    })
    .then(apply)
    .catch(() => render());
})();
