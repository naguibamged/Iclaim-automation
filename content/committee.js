(function () {
  const SIGN_IN = "Sign in on the committee tab, then send the number again.";
  const NO_QUERY = "Could not find the committee query page. Sign in on the committee tab, then send the number again.";
  const SELECTOR = '[onclick*="Select$"], [href*="Select$"]';

  function toLatin(value) {
    return String(value || "").replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
  }

  function isPdf(bytes) {
    return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  }

  function toBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function postBackOf(element) {
    const source = `${element.getAttribute("href") || ""}${element.getAttribute("onclick") || ""}`;
    const match = /__doPostBack\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/.exec(source);
    return match && [match[1], match[2]];
  }

  function dateOf(value) {
    const text = toLatin(value);
    let match = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/.exec(text);
    if (match) return Date.UTC(+match[3], +match[2] - 1, +match[1]);
    match = /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/.exec(text);
    return match ? Date.UTC(+match[1], +match[2] - 1, +match[3]) : 0;
  }

  function friendlyError(error) {
    const message = error && error.message ? error.message : String(error || "");
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
      return "The committee site did not respond. Send the number again.";
    }
    return message || "Could not open the committee decision.";
  }

  function looksLikeLogin(doc) {
    if (doc.querySelector("#ContentPlaceHolder1_txtSearch")) return false;
    if (doc.querySelector('input[type="password"]')) return true;
    const text = ((doc.body && doc.body.innerText) || "").slice(0, 800);
    return /تسجيل الدخول|اسم المستخدم|كلمة السر|كلمة المرور/i.test(text);
  }

  function shownNationalId(doc) {
    const node = doc.querySelector("#lbNationalID");
    return toLatin((node && node.textContent) || "").replace(/\D/g, "");
  }

  function textOf(doc, selector) {
    const node = doc.querySelector(selector);
    return ((node && node.textContent) || "").trim();
  }

  function decisionSummary(doc) {
    return ["#lbName", "#lbDrugName", "#lbStatus", "#lbstatus_date", "#lbRequestID"].map((selector) => textOf(doc, selector)).filter(Boolean).join(" | ");
  }

  function decisionRows(doc) {
    return [...doc.querySelectorAll("#ContentPlaceHolder1_grdpreviousRequest tr")].filter((row) => row.querySelector(SELECTOR));
  }

  function pickLatest(doc) {
    const rows = decisionRows(doc);
    if (!rows.length) return null;
    const table = rows[0].closest("table");
    const headRow = table ? table.querySelector("tr") : null;
    const dateCol = headRow
      ? [...headRow.children].findIndex((cell) => (cell.textContent || "").includes("تاريخ تقديم الطلب"))
      : -1;
    let best = 0;
    let bestKey = [-1, -1];
    rows.forEach((row, index) => {
      const cells = [...row.querySelectorAll("td")].map((cell) => cell.textContent.trim());
      const date = dateCol >= 0 && cells[dateCol] ? dateOf(cells[dateCol]) : Math.max(0, ...cells.map(dateOf));
      const num = Math.max(0, ...cells.map((value) => (/^\d{3,10}$/.test(toLatin(value)) ? +toLatin(value) : 0)));
      if (date > bestKey[0] || (date === bestKey[0] && num > bestKey[1])) {
        best = index;
        bestKey = [date, num];
      }
    });
    return rows[best];
  }

  function statusTextOf(row) {
    const table = row && row.closest("table");
    if (!table) return "";
    const headRow = [...table.querySelectorAll("tr")].find((tr) =>
      [...tr.children].some((cell) => (cell.textContent || "").includes("حالة الطلب"))
    );
    if (!headRow) return "";
    const index = [...headRow.children].findIndex((cell) => (cell.textContent || "").includes("حالة الطلب"));
    const cell = [...row.children][index];
    return ((cell && cell.textContent) || "").replace(/\u00a0/g, " ").trim();
  }

  function decisionReply(row, id) {
    const text = statusTextOf(row);
    const value = text.replace(/\s+/g, " ").trim();
    if (!value) return { ok: false, error: `Could not read the decision status for ${id}` };
    if (/^accept$/i.test(value)) return null;
    if (/^refusal$/i.test(value)) return { ok: true, replyKey: "committeeRefusal", status: "danger", statusText: text };
    if (/^correction$/i.test(value)) return { ok: true, replyKey: "committeeCorrection", status: "danger", statusText: text };
    return { ok: true, replyKey: "committeeOther", status: "warning", statusText: text };
  }

  function findSearchButton(doc, field) {
    for (let parent = field.parentElement; parent; parent = parent.parentElement) {
      const match = /WebForm_FireDefaultButton\(\s*event\s*,\s*['"]([^'"]+)['"]/.exec(parent.getAttribute("onkeypress") || "");
      if (match && doc.getElementById(match[1])) return doc.getElementById(match[1]);
    }
    const candidateSelector = 'a[href*="__doPostBack"], input[type="submit"], input[type="button"], button';
    for (let parent = field.parentElement, depth = 0; parent && depth < 6; parent = parent.parentElement, depth += 1) {
      const controls = [...parent.querySelectorAll(candidateSelector)].filter((element) => {
        return !/btn(All|Onc|Bio|Print)/i.test(element.id || "") && !element.closest("#MenuGeneral_Branch, nav, .navbar");
      });
      const named = controls.find((element) =>
        /بحث|ابحث|استعلام|search|find/i.test([element.value, element.textContent, element.title, element.id].join(" "))
      );
      if (named) return named;
      if (controls.length === 1) return controls[0];
    }
    return null;
  }

  function absoluteBoxHtml(gfg, pageUrl) {
    const box = gfg.parentElement || gfg;
    const copy = box.cloneNode(true);
    copy.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src");
      if (!src) return;
      try {
        img.setAttribute("src", new URL(src, pageUrl).href);
      } catch (error) {
        // Keep the original address when it cannot be resolved.
      }
    });
    return copy.outerHTML;
  }

  function createSession(startDoc, startUrl) {
    const ctx = { doc: startDoc, url: startUrl };

    function pdfResult(bytes, id) {
      return { ok: true, base64: toBase64(bytes), summary: decisionSummary(ctx.doc) || `Decision ${id}` };
    }

    function pageResult(id, allowEmpty) {
      const gfg = ctx.doc.querySelector("#GFG");
      if (!gfg) return null;
      const shownId = shownNationalId(ctx.doc);
      if (shownId && shownId !== id) {
        return { ok: false, error: `The decision page is for a different national ID (${shownId}). Stopped.` };
      }
      if (!shownId && !allowEmpty) return null;
      const summary = decisionSummary(ctx.doc);
      if (/RMS_FinalPrint\.aspx/i.test(ctx.url)) return { ok: true, documentUrl: ctx.url, summary };
      return { ok: true, html: absoluteBoxHtml(gfg, ctx.url), baseUrl: ctx.url, summary };
    }

    async function step(target, arg, extra) {
      const form = ctx.doc.getElementById("form1") || ctx.doc.forms[0];
      if (!form) throw new Error("Could not find the committee form.");
      const body = new URLSearchParams(new FormData(form));
      body.set("__EVENTTARGET", target || "");
      body.set("__EVENTARGUMENT", arg || "");
      if (extra) {
        for (const [key, value] of Object.entries(extra)) body.set(key, value);
      }
      const action = new URL(form.getAttribute("action") || ctx.url, ctx.url).href;
      const response = await fetch(action, { method: "POST", body, credentials: "include" });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (isPdf(bytes)) return bytes;
      ctx.doc = parseHtml(new TextDecoder("utf-8").decode(bytes));
      ctx.url = response.url || action;
      return null;
    }

    function press(element, extra) {
      const post = postBackOf(element);
      if (post) return step(post[0], post[1], extra);
      const fields = { ...(extra || {}) };
      if (element.name) fields[element.name] = element.value || "";
      return step("", "", fields);
    }

    async function openLinkedDecision() {
      const html = ctx.doc.documentElement ? ctx.doc.documentElement.outerHTML : "";
      const match = /RMS_FinalPrint\.aspx\?[^'"\s<>)]*/i.exec(html) || /window\.open\(\s*['"]([^'"]+)['"]/i.exec(html);
      const link = match && (match[1] || match[0]);
      if (!link) return null;
      const response = await fetch(new URL(link.replace(/&amp;/g, "&"), ctx.url).href, { credentials: "include" });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (isPdf(bytes)) return bytes;
      ctx.doc = parseHtml(new TextDecoder("utf-8").decode(bytes));
      ctx.url = response.url || ctx.url;
      return null;
    }

    async function finishFromPrint(id) {
      try {
        const printButton = ctx.doc.querySelector("#ContentPlaceHolder1_btnPrint");
        if (!printButton) return { ok: false, error: "Could not find the committee print button." };
        const direct = await press(printButton);
        if (direct) return pdfResult(direct, id);
        if (!ctx.doc.querySelector("#GFG")) {
          const linked = await openLinkedDecision();
          if (linked) return pdfResult(linked, id);
        }
        const ready = pageResult(id, true);
        if (ready) return ready;
        return { ok: false, error: "Could not open the committee decision." };
      } catch (error) {
        return { ok: false, error: friendlyError(error) };
      }
    }

    async function runAll(id) {
      try {
        const existing = /RMS_FinalPrint\.aspx/i.test(ctx.url) ? pageResult(id, false) : null;
        if (existing && existing.ok) return existing;

        const oncology = ctx.doc.querySelector("#ContentPlaceHolder1_btnGenral");
        if (oncology) {
          const printed = await press(oncology);
          if (printed) return pdfResult(printed, id);
        }

        if (!/rms_queryrequest_branch/i.test(ctx.url)) {
          const link = ctx.doc.querySelector('a[href$="RMS_QueryRequest_Branch.aspx"]');
          if (!link) {
            if (existing && existing.error) return existing;
            if (looksLikeLogin(ctx.doc)) return { ok: false, error: SIGN_IN };
            return { ok: false, error: NO_QUERY };
          }
          const response = await fetch(new URL(link.getAttribute("href"), ctx.url).href, { credentials: "include" });
          ctx.doc = parseHtml(await response.text());
          ctx.url = response.url || ctx.url;
        }

        const all = ctx.doc.querySelector("#ContentPlaceHolder1_btnAll");
        if (all) {
          const printed = await press(all);
          if (printed) return pdfResult(printed, id);
        }

        const field = ctx.doc.querySelector("#ContentPlaceHolder1_txtSearch");
        if (!field || !field.name) {
          if (looksLikeLogin(ctx.doc)) return { ok: false, error: SIGN_IN };
          return { ok: false, error: "Could not find the committee search box." };
        }
        const searchButton = ctx.doc.querySelector("#ContentPlaceHolder1_btnsearch") || findSearchButton(ctx.doc, field);
        if (!searchButton) return { ok: false, error: "Could not find the committee search button." };
        const searched = await press(searchButton, { [field.name]: id });
        if (searched) return pdfResult(searched, id);

        const rows = decisionRows(ctx.doc);
        if (rows.length) {
          const row = pickLatest(ctx.doc);
          const select = row && row.querySelector(SELECTOR);
          if (!select) return { ok: true, replyKey: "noDecision" };
          const reply = decisionReply(row, id);
          if (reply) return reply;
          const selected = await press(select);
          if (selected) return pdfResult(selected, id);
        } else if (!ctx.doc.querySelector("#ContentPlaceHolder1_btnPrint")) {
          return { ok: true, replyKey: "noDecision" };
        }

        return finishFromPrint(id);
      } catch (error) {
        return { ok: false, error: friendlyError(error) };
      }
    }

    return { runAll };
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function runVisible(id) {
    let doc = document;
    let url = location.href;
    const query = (selector) => doc.querySelector(selector);

    async function showHtml(htmlText, nextUrl, waitMs) {
      document.open();
      document.write(htmlText);
      document.close();
      doc = document;
      url = nextUrl || url;
      await delay(waitMs);
    }

    async function step(target, arg, extra) {
      const form = doc.getElementById("form1") || doc.forms[0];
      if (!form) throw new Error("Could not find the committee form.");
      const body = new URLSearchParams(new FormData(form));
      body.set("__EVENTTARGET", target || "");
      body.set("__EVENTARGUMENT", arg || "");
      if (extra) {
        for (const [key, value] of Object.entries(extra)) body.set(key, value);
      }
      const action = new URL(form.getAttribute("action") || url, url).href;
      const response = await fetch(action, { method: "POST", body, credentials: "include" });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (isPdf(bytes)) return bytes;
      await showHtml(new TextDecoder("utf-8").decode(bytes), response.url || action, 400);
      return null;
    }

    async function press(element, extra) {
      const post = postBackOf(element);
      if (post) return step(post[0], post[1], extra);
      const fields = { ...(extra || {}) };
      if (element.name) fields[element.name] = element.value || "";
      return step("", "", fields);
    }

    function pdfResult(bytes) {
      return { ok: true, base64: toBase64(bytes), summary: decisionSummary(doc) || `Decision ${id}` };
    }

    function queryPageUrl(pageUrl) {
      const parsed = new URL(pageUrl, location.href);
      const directory = parsed.pathname.endsWith("/") ? parsed.pathname : parsed.pathname.replace(/[^/]*$/, "");
      parsed.pathname = `${directory}RMS_QueryRequest_Branch.aspx`;
      parsed.search = "";
      parsed.hash = "";
      return parsed.href;
    }

    async function openQueryPage() {
      if (/rms_queryrequest_branch/i.test(url) && query("#ContentPlaceHolder1_txtSearch")) return;
      const link = query('a[href$="RMS_QueryRequest_Branch.aspx"]');
      const target = link ? new URL(link.getAttribute("href"), url).href : queryPageUrl(url);
      const response = await fetch(target, { credentials: "include" });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (isPdf(bytes)) return bytes;
      await showHtml(new TextDecoder("utf-8").decode(bytes), response.url || target, 500);
      return null;
    }

    try {
      const oncology = query("#ContentPlaceHolder1_btnGenral");
      if (oncology) {
        const printed = await press(oncology);
        if (printed) return pdfResult(printed);
      }

      const opened = await openQueryPage();
      if (opened) return pdfResult(opened);

      const all = query("#ContentPlaceHolder1_btnAll");
      if (all) {
        const printed = await press(all);
        if (printed) return pdfResult(printed);
      }

      const field = query("#ContentPlaceHolder1_txtSearch");
      if (!field) {
        if (looksLikeLogin(doc)) return { ok: false, error: SIGN_IN };
        return { ok: false, error: "Could not find the committee search box." };
      }
      field.value = id;

      const searchButton = query("#ContentPlaceHolder1_btnsearch") || findSearchButton(doc, field);
      if (!searchButton) return { ok: false, error: "Could not find the committee search button." };
      const searched = await press(searchButton, field.name ? { [field.name]: id } : {});
      if (searched) return pdfResult(searched);

      const rows = decisionRows(doc);
      if (rows.length) {
        const row = pickLatest(doc);
        const select = row && row.querySelector(SELECTOR);
        if (!select) return { ok: true, replyKey: "noDecision" };
        const reply = decisionReply(row, id);
        if (reply) return reply;
        const selected = await press(select);
        if (selected) return pdfResult(selected);
      } else if (!query("#ContentPlaceHolder1_btnPrint")) {
        return { ok: true, replyKey: "noDecision" };
      }

      const printButton = query("#ContentPlaceHolder1_btnPrint");
      if (!printButton) return { ok: false, error: "Could not find the committee print button." };
      const direct = await press(printButton);
      if (direct) return pdfResult(direct);

      if (!query("#GFG")) {
        const html = doc.documentElement ? doc.documentElement.outerHTML : "";
        const match = /RMS_FinalPrint\.aspx\?[^'"\s<>)]*/i.exec(html) || /window\.open\(\s*['"]([^'"]+)['"]/i.exec(html);
        const link = match && (match[1] || match[0]);
        if (link) {
          const response = await fetch(new URL(link.replace(/&amp;/g, "&"), url).href, { credentials: "include" });
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (isPdf(bytes)) return pdfResult(bytes);
          await showHtml(new TextDecoder("utf-8").decode(bytes), response.url, 500);
        }
      }

      const gfg = query("#GFG");
      if (!gfg) return { ok: false, error: "Could not open the committee decision." };
      const shownId = shownNationalId(doc);
      if (shownId && shownId !== id) {
        return { ok: false, error: `The decision page is for a different national ID (${shownId}). Stopped.` };
      }
      return { ok: true, html: absoluteBoxHtml(gfg, url), baseUrl: url, summary: decisionSummary(doc) };
    } catch (error) {
      return { ok: false, error: friendlyError(error) };
    }
  }

  function run(request) {
    const method = request && request.method;
    try {
      if (method === "runVisible") return runVisible(request.id);
      if (method === "runHidden") return createSession(document, location.href).runAll(request.id);
    } catch (error) {
      return { ok: false, error: friendlyError(error) };
    }
    return { ok: false, error: "Committee automation did not start" };
  }

  globalThis.__committeeAutomation = { run };
})();
