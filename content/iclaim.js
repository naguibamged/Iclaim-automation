(function () {
  const DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(fn, timeout = 15000, interval = 250) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const value = fn();
        if (value) return value;
      } catch (error) {
        // Keep polling while the page is still rendering.
      }
      await sleep(interval);
    }
    return null;
  }

  function parseDate(text) {
    const match = String(text || "").trim().match(DATE_PATTERN);
    if (!match) return null;
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date.getTime();
  }

  function onWorklist() {
    return location.hash.includes("/requests/worklist");
  }

  function claimDetailOpened(hashBefore) {
    if (!onWorklist() || location.hash !== hashBefore) return true;
    const input = document.querySelector('input[ng-model="claimsSearchText"]');
    if (!input) return true;
    const style = window.getComputedStyle(input);
    return style.display === "none" || style.visibility === "hidden";
  }

  function looksLikeLogin() {
    if (document.querySelector('input[type="password"]')) return true;
    return /login|sign in/i.test(`${document.title} ${document.body ? document.body.innerText.slice(0, 400) : ""}`);
  }

  function angularScope(element) {
    const angularRef = window.angular;
    if (!angularRef || typeof angularRef.element !== "function") return null;
    const wrapped = angularRef.element(element);
    return wrapped.scope() || wrapped.isolateScope() || null;
  }

  function applyFn(scope, fn) {
    const root = scope.$root || scope;
    if (root.$$phase) fn();
    else scope.$apply(fn);
  }

  function scopeWithModel(start) {
    let scope = start;
    const seen = new Set();
    while (scope && !seen.has(scope)) {
      seen.add(scope);
      if (Object.prototype.hasOwnProperty.call(scope, "claimsSearchText")) return scope;
      scope = scope.$parent;
    }
    return start;
  }

  function runSearchAction(start, input) {
    const expression = input.getAttribute("ng-enter") || "loadClaims()";
    let scope = start;
    const seen = new Set();
    while (scope && !seen.has(scope)) {
      seen.add(scope);
      try {
        applyFn(scope, () => scope.$eval(expression));
        return true;
      } catch (error) {
        if (typeof scope.loadClaims === "function") {
          try {
            applyFn(scope, () => scope.loadClaims());
            return true;
          } catch (loadError) {
            // Try the parent scope.
          }
        }
      }
      scope = scope.$parent;
    }
    return false;
  }

  function setSearchNative(input, text) {
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const eventInit = {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13
    };
    input.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    input.dispatchEvent(new KeyboardEvent("keypress", eventInit));
    input.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  }

  function setSearch(input, text) {
    const start = angularScope(input);
    if (!start) {
      setSearchNative(input, text);
      return;
    }

    const owner = scopeWithModel(start);
    applyFn(owner, () => {
      owner.claimsSearchText = text;
    });
    input.value = text;
    const angularRef = window.angular;
    if (angularRef && typeof angularRef.element === "function") {
      const wrapped = angularRef.element(input);
      wrapped.triggerHandler("input");
      wrapped.triggerHandler("change");
    }
    if (!runSearchAction(owner, input)) setSearchNative(input, text);
  }

  function submissionColumn(table) {
    const headers = [...table.querySelectorAll("thead th, thead td")];
    return headers.findIndex((cell) => /submission/i.test(cell.textContent || ""));
  }

  function tableRows(table) {
    const bodyRows = [...table.querySelectorAll("tbody tr")];
    const rows = bodyRows.length ? bodyRows : [...table.querySelectorAll("tr")];
    return rows.filter((row) => row.querySelector("td") && !row.querySelector("th"));
  }

  function dateInRow(row, columnIndex) {
    const cells = [...row.querySelectorAll("td")];
    const ordered = columnIndex >= 0 && cells[columnIndex] ? [cells[columnIndex]] : cells;
    for (const cell of ordered) {
      const time = parseDate(cell.textContent);
      if (time != null) return { cell, time };
    }
    return null;
  }

  function rowRecord(row, rowIndex) {
    const table = row.closest("table");
    const columnIndex = table ? submissionColumn(table) : -1;
    const found = dateInRow(row, columnIndex) || dateInRow(row, -1);
    return {
      row,
      cell: found ? found.cell : row,
      time: found ? found.time : 0,
      rowIndex
    };
  }

  function rowIsShown(row) {
    if (!row || row.closest(".ng-hide")) return false;
    let node = row;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      node = node.parentElement;
    }
    const rect = row.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function collectRows() {
    const linked = [...document.querySelectorAll("tr[target-url]")].filter(
      (row) => rowIsShown(row) && /requests\/details/i.test(row.getAttribute("target-url") || "")
    );
    if (linked.length) return linked.map(rowRecord);

    const tables = [...document.querySelectorAll("table")];
    let best = [];
    for (const table of tables) {
      const columnIndex = submissionColumn(table);
      const dated = [];
      tableRows(table).forEach((row, rowIndex) => {
        if (!rowIsShown(row)) return;
        const found = dateInRow(row, columnIndex);
        if (!found) return;
        dated.push({ row, cell: found.cell, time: found.time, rowIndex });
      });
      if (columnIndex >= 0 && dated.length) return dated;
      if (dated.length > best.length) best = dated;
    }
    if (best.length) return best;

    const dated = [];
    [...document.querySelectorAll("tr")].forEach((row, rowIndex) => {
      if (row.querySelector("th") || !rowIsShown(row)) return;
      const found = dateInRow(row, -1);
      if (!found) return;
      dated.push({ row, cell: found.cell, time: found.time, rowIndex });
    });
    return dated;
  }

  function rowsForClaim(rows, claimNumber) {
    const query = String(claimNumber || "").trim();
    if (!query) return rows;
    const matched = rows.filter((item) => {
      const url = item.row.getAttribute("target-url") || "";
      return url.includes(query) || item.row.innerText.includes(query);
    });
    return matched.length ? matched : rows;
  }

  function clickClaimRow(row) {
    row.scrollIntoView({ block: "center", inline: "nearest" });
    const options = { bubbles: true, cancelable: true, view: window };
    row.dispatchEvent(new MouseEvent("mousedown", options));
    row.dispatchEvent(new MouseEvent("mouseup", options));
    row.dispatchEvent(new MouseEvent("click", options));
  }

  function openTargetUrl(targetUrl) {
    if (!targetUrl) return false;
    const hash = targetUrl.startsWith("#") ? targetUrl : `#${targetUrl}`;
    const angularRef = window.angular;
    try {
      if (angularRef && typeof angularRef.element === "function") {
        const injector = angularRef.element(document.body).injector();
        const scope = angularRef.element(document.body).scope();
        if (injector && scope) {
          const router = injector.get("$location");
          applyFn(scope, () => {
            router.url(hash.replace(/^#/, ""));
          });
          return true;
        }
      }
    } catch (error) {
      // The row click is the normal path. The hash is the fallback.
    }
    location.hash = hash;
    return true;
  }

  function signatureOf(rows) {
    return rows.map((item) => `${item.time}:${item.row.innerText}`).join("\n");
  }

  function isBusy() {
    return [...document.querySelectorAll(".cg-busy")].some((node) => !node.classList.contains("ng-hide"));
  }

  async function waitUntilNotBusy(timeout = 90000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (!isBusy()) {
        await sleep(500);
        if (!isBusy()) return true;
      }
      await sleep(300);
    }
    return !isBusy();
  }

  async function waitForSearchToFinish() {
    const appearBy = Date.now() + 5000;
    let sawBusy = isBusy();
    while (!sawBusy && Date.now() < appearBy) {
      await sleep(200);
      sawBusy = isBusy();
    }
    return waitUntilNotBusy();
  }

  async function waitForResults(previousSignature, claimNumber) {
    const started = Date.now();
    let last = previousSignature;
    let stableSince = Date.now();
    const query = String(claimNumber || "").trim().toLowerCase();

    while (Date.now() - started < 90000) {
      if (isBusy()) {
        stableSince = Date.now();
        await sleep(300);
        continue;
      }
      const rows = collectRows();
      const signature = signatureOf(rows);
      if (signature !== last) {
        last = signature;
        stableSince = Date.now();
      }
      const settled = Date.now() - stableSince >= 800;
      const elapsed = Date.now() - started;
      const changed = signature !== previousSignature && signature !== "";
      const queryMatched = query && signature.toLowerCase().includes(query);
      if (settled && elapsed >= 800 && changed) return rows;
      if (settled && elapsed >= 6000 && rows.length && queryMatched) return rows;
      await sleep(250);
    }

    const rows = collectRows();
    const signature = signatureOf(rows);
    if (signature && signature !== previousSignature) return rows;
    if (query && signature.toLowerCase().includes(query)) return rows;
    return [];
  }

function labelOf(element) {
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" ");
    const bits = [
      element.getAttribute("title"),
      element.getAttribute("aria-label"),
      element.getAttribute("ng-click"),
      element.getAttribute("onclick"),
      typeof element.className === "string" ? element.className : "",
      ownText,
      element.childElementCount <= 3 ? element.textContent : ""
    ];
    return bits.filter(Boolean).join(" ");
  }

  function nearbyHref(control) {
    const parent = control.parentElement;
    if (!parent || parent.childElementCount > 12) return "";
    for (const link of parent.querySelectorAll("a")) {
      if (link === control) continue;
      const href = absoluteHref(link);
      if (href) return href;
    }
    return "";
  }

  function absoluteHref(link) {
    const raw = link.getAttribute("href") || link.getAttribute("ng-href") || "";
    if (!raw || raw === "#" || raw.startsWith("javascript:") || raw.includes("{{")) return "";
    try {
      return new URL(raw, location.href).href;
    } catch (error) {
      return "";
    }
  }

  function urlFromCode(code) {
    if (!code) return "";
    const quoted = String(code).match(/['"]((?:https?:\/\/|\/)[^'"]+)['"]/);
    if (!quoted) return "";
    try {
      return new URL(quoted[1], location.href).href;
    } catch (error) {
      return "";
    }
  }

  function findDocumentUrl() {
    const formLink = document.querySelector('a[href*="/workflow/download_form"]');
    if (formLink) {
      const href = absoluteHref(formLink);
      if (href) return href;
    }

    const downloadButton = [...document.querySelectorAll("button[pdf-name], button[onclick]")].find((button) =>
      /previousElementSibling\.click\(\)/.test(button.getAttribute("onclick") || "")
    );
    const sibling = downloadButton?.previousElementSibling;
    if (sibling && sibling.tagName === "A") {
      const href = absoluteHref(sibling);
      if (href) return href;
    }

    const controls = [...document.querySelectorAll("button, a, input[type='button'], [role='button']")];
    for (const control of controls) {
      if (!/print|pdf/i.test(labelOf(control))) continue;
      if (control.tagName === "A") {
        const ownHref = absoluteHref(control);
        if (ownHref) return ownHref;
      }
      const href = nearbyHref(control);
      if (href) return href;
      const fromCode = urlFromCode(control.getAttribute("ng-click") || control.getAttribute("onclick"));
      if (fromCode) return fromCode;
    }

    for (const link of document.querySelectorAll("a[href], a[ng-href]")) {
      const href = absoluteHref(link);
      if (href && /print|pdf|download|report/i.test(`${href} ${labelOf(link)}`)) return href;
    }
    return "";
  }

  function latestRow(rows) {
    let best = null;
    for (const item of rows) {
      if (!best || item.time > best.time || (item.time === best.time && item.rowIndex >= best.rowIndex)) {
        best = item;
      }
    }
    return best;
  }

  function claimStatusOf(row) {
    const cell = row?.querySelector("td.claim-status");
    if (!cell) return "";
    if (cell.classList.contains("success")) return "success";
    if (cell.classList.contains("warning")) return "warning";
    if (cell.classList.contains("danger")) return "danger";
    return "";
  }

  async function ensureWorklist() {
    if (!onWorklist()) location.hash = "#/requests/worklist";
    const input = await waitFor(() => document.querySelector('input[ng-model="claimsSearchText"]'), 20000);
    if (input) {
      const idle = await waitUntilNotBusy();
      if (!idle) return { error: "iClaim is still loading. Send the number again." };
      return { input };
    }
    if (looksLikeLogin()) {
      return { error: "Sign in on the iClaim tab, then send the number again." };
    }
    return { error: "Could not find the iClaim search box. Sign in if the login page is open." };
  }

  function claimsReportLink() {
    const links = [...document.querySelectorAll("a[ng-click]")].filter((link) => {
      const click = link.getAttribute("ng-click") || "";
      return (
        /currentTab\s*=\s*1/.test(click) &&
        /callLoadClaims\s*\(/.test(click) &&
        /claims report/i.test(link.textContent || "")
      );
    });
    return links.find((link) => !link.closest(".ng-hide")) || links[0] || null;
  }

  function reportsTabActive(link) {
    const item = link?.closest("li");
    return Boolean(item && item.classList.contains("active"));
  }

  function openClaimsReport(link) {
    const expression = link.getAttribute("ng-click") || "currentTab=1;callLoadClaims()";
    let scope = angularScope(link);
    const seen = new Set();
    while (scope && !seen.has(scope)) {
      seen.add(scope);
      try {
        applyFn(scope, () => scope.$eval(expression));
        return true;
      } catch (error) {
        scope = scope.$parent;
      }
    }
    link.click();
    return false;
  }

  async function ensureClaimsReport() {
    const link = await waitFor(() => claimsReportLink(), 15000);
    if (!link) return { error: "Could not find the Claims Report tab" };
    if (reportsTabActive(link)) return { ok: true };

    openClaimsReport(link);
    const active = await waitFor(() => (reportsTabActive(claimsReportLink() || link) ? true : null), 15000);
    if (!active) return { error: "Could not open the Claims Report tab" };
    const idle = await waitUntilNotBusy();
    if (!idle) return { error: "iClaim is still loading the Claims Report. Send the number again." };
    return { ok: true };
  }

  async function searchAndOpen(claimNumber) {
    const text = String(claimNumber || "").trim();
    if (!text) return { ok: false, error: "The WhatsApp message was empty." };

    const ready = await ensureWorklist();
    if (ready.error) return { ok: false, error: ready.error };

    const reportTab = await ensureClaimsReport();
    if (reportTab.error) return { ok: false, error: reportTab.error };

    const previousSignature = signatureOf(collectRows());
    setSearch(ready.input, text);
    const finished = await waitForSearchToFinish();
    if (!finished) return { ok: false, error: `iClaim is still loading results for ${text}` };
    const rows = await waitForResults(previousSignature, text);
    if (!rows.length) return { ok: false, error: `No claim found for ${text}` };

    if (!(await waitUntilNotBusy())) {
      return { ok: false, error: `iClaim is still loading results for ${text}` };
    }
    const settledRows = rowsForClaim(collectRows(), text);
    const target = latestRow(settledRows.length ? settledRows : rows);
    if (!target?.row) return { ok: false, error: `No claim found for ${text}` };

    const status = claimStatusOf(target.row);
    if (status === "warning") return { ok: true, status, reply: "Still Pending" };
    if (status === "danger") return { ok: true, status, reply: "Follow ST. Protocol" };
    if (status !== "success") return { ok: false, error: `Could not read the claim status for ${text}` };

    const hashBefore = location.hash;
    clickClaimRow(target.row);

    const left = await waitFor(() => claimDetailOpened(hashBefore), 2000);
    if (!left) openTargetUrl(target.row.getAttribute("target-url"));

    if (!(await waitUntilNotBusy())) {
      return { ok: false, error: `iClaim is still loading the claim for ${text}` };
    }

    const opened = await waitFor(() => claimDetailOpened(hashBefore) && !isBusy(), 90000);
    if (!opened) return { ok: false, error: `Could not open the claim for ${text}` };

    if (!(await waitUntilNotBusy())) {
      return { ok: false, error: `iClaim is still loading the claim for ${text}` };
    }
    const documentUrl = await waitFor(() => (!isBusy() ? findDocumentUrl() : ""), 20000);
    if (!documentUrl) return { ok: false, error: `Could not download the claim document for ${text}` };
    return { ok: true, status: "success", documentUrl };
  }

  globalThis.__iclaimAutomation = { searchAndOpen };
})();
