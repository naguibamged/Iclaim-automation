var ICLAIM_DEFAULTS = {
  enabled: false,
  groupName: "Iclaim automation",
  worklistUrl: "http://41.33.97.121:1337/#/requests/worklist",
  committeeUrl: "http://196.219.52.208/ReuestMedicine/Home.aspx",
  workInBackground: false
};

var ICLAIM_INVALID_ID_REPLY = "please send valid National ID or Claim ID";

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
