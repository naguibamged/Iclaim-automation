var ICLAIM_DEFAULTS = {
  enabled: false,
  groupName: "Iclaim automation",
  worklistUrl: "http://41.33.97.121:1337/#/requests/worklist",
  committeeUrl: "http://196.219.52.208/ReuestMedicine/Home.aspx",
  workInBackground: false,
  ignoreInvalid: false,
  ackGapSeconds: 0
};

var ICLAIM_REPLY_DEFAULTS = {
  ack: "getting the IClaim",
  stillPending: "Still Pending",
  followProtocol: "Follow ST. Protocol",
  alreadySent: "Already sent {id}",
  alreadyAnswered: "Already answered {id}",
  alreadyGetting: "Already getting {id}",
  invalidId: "please send valid National ID or Claim ID",
  noClaim: "No claim found for {id}",
  noDecision: "No decision found for {id}",
  committeeRefusal: "{status}",
  committeeCorrection: "{status}",
  committeeOther: "{status}"
};

var ICLAIM_REPLY_FIELDS = [
  { key: "ack", label: "Getting the claim" },
  { key: "stillPending", label: "Still pending" },
  { key: "followProtocol", label: "Follow protocol" },
  { key: "alreadySent", label: "Already sent" },
  { key: "alreadyAnswered", label: "Already answered" },
  { key: "alreadyGetting", label: "Already getting" },
  { key: "invalidId", label: "Invalid ID" },
  { key: "noClaim", label: "No claim" },
  { key: "noDecision", label: "No decision" },
  { key: "committeeRefusal", label: "Committee refusal" },
  { key: "committeeCorrection", label: "Committee correction" },
  { key: "committeeOther", label: "Other committee status" }
];

var ICLAIM_INVALID_ID_REPLY = ICLAIM_REPLY_DEFAULTS.invalidId;

function replyVariants(raw, fallback) {
  const fallbackText = String(fallback || "");
  const source = raw == null || String(raw).trim() === "" ? fallbackText : String(raw);
  const parts = source.split(/[,،]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length) return parts;
  const fallbackParts = fallbackText.split(/[,،]/).map((part) => part.trim()).filter(Boolean);
  return fallbackParts.length ? fallbackParts : [fallbackText];
}

function pickReply(templates, key, vars) {
  const defaults = ICLAIM_REPLY_DEFAULTS[key] || "";
  const stored = templates && typeof templates === "object" ? templates[key] : "";
  const list = replyVariants(stored, defaults);
  const choice = list[Math.floor(Math.random() * list.length)] || defaults;
  const values = vars || {};
  return choice
    .replace(/\{id\}/g, values.id == null ? "" : String(values.id))
    .replace(/\{status\}/g, values.status == null ? "" : String(values.status));
}

function gapSeconds(value) {
  const gap = Number(value);
  if (!Number.isFinite(gap) || gap < 0) return 0;
  return Math.floor(gap);
}

function flagObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function normalizeReplyFlags(data) {
  const storedEnabled = flagObject(data && data.replyEnabled);
  const storedGap = flagObject(data && data.replyInGap);
  const replyEnabled = {};
  const replyInGap = {};
  for (const field of ICLAIM_REPLY_FIELDS) {
    if (typeof storedEnabled[field.key] === "boolean") replyEnabled[field.key] = storedEnabled[field.key];
    else replyEnabled[field.key] = !(field.key === "ack" && data && data.ackReplies === false);
    replyInGap[field.key] = typeof storedGap[field.key] === "boolean" ? storedGap[field.key] : field.key === "ack";
  }
  return { replyEnabled, replyInGap };
}

function shouldSendReply(settings, key, withinGap) {
  if (!settings || !settings.replyEnabled || settings.replyEnabled[key] === false) return false;
  if (withinGap && settings.replyInGap && settings.replyInGap[key] === true) return false;
  return true;
}

function toLatinDigits(value) {
  return String(value || "").replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

function classifyClaimId(raw) {
  const latin = toLatinDigits(raw).trim();
  const collapsed = latin.replace(/[\s\-–—]/g, "");
  let digits = "";

  if (/^\d+$/.test(collapsed)) {
    digits = collapsed;
  } else {
    const runs = latin.match(/\d+/g) || [];
    const national = runs.filter((run) => /^[23]\d{13}$/.test(run));
    const claims = runs.filter((run) => /^\d{6,8}$/.test(run));
    if (national.length === 1 && claims.length === 0) digits = national[0];
    else if (claims.length === 1 && national.length === 0) digits = claims[0];
    else if (runs.length === 1) digits = runs[0];
  }

  if (/^[23]\d{13}$/.test(digits)) return { ok: true, kind: "national", id: digits };
  if (/^\d{6,8}$/.test(digits)) return { ok: true, kind: "claim", id: digits };
  return { ok: false, reply: ICLAIM_INVALID_ID_REPLY };
}
