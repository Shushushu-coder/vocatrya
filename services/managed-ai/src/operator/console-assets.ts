/**
 * Self-contained Operator console assets. Served only from the loopback
 * listener under a strict CSP — no CDN, no inline handlers, no storage APIs.
 * The operator session token lives exclusively in a JS variable; a reload
 * requires a fresh credential exchange.
 */
export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vocatrya Managed AI — Operator</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header>
  <h1>Managed AI Operator</h1>
  <span id="sessionBadge" class="badge off">no session</span>
  <button id="logoutBtn" class="ghost hidden" type="button">Log out</button>
</header>
<section id="loginCard" class="card narrow">
  <h2>Operator sign-in</h2>
  <p class="muted">Paste the credential issued by the owner over the trusted CLI channel. It is exchanged once for a short-lived session token held in memory only.</p>
  <input id="credentialInput" type="password" autocomplete="off" spellcheck="false" placeholder="opc_…" aria-label="Operator credential">
  <button id="loginBtn" type="button">Sign in</button>
  <p id="loginError" class="error"></p>
</section>
<div id="app" class="hidden">
  <nav id="tabs"></nav>
  <main id="view"></main>
</div>
<div id="modal" class="hidden">
  <div class="card">
    <h2>Issued once — copy now</h2>
    <p class="muted">This token is never stored or shown again.</p>
    <pre id="modalSecret"></pre>
    <button id="modalClose" type="button">I have saved it</button>
  </div>
</div>
<script src="/app.js"></script>
</body>
</html>
`;

export const CONSOLE_CSS = `:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; background: #0d1117; color: #d7dde4; }
header { display: flex; align-items: center; gap: 12px; padding: 10px 18px; background: #161b22; border-bottom: 1px solid #2d333b; }
h1 { font-size: 15px; margin: 0; font-weight: 600; }
h2 { font-size: 13px; margin: 0 0 10px; text-transform: uppercase; letter-spacing: .06em; color: #9da7b1; }
h3 { font-size: 12px; margin: 16px 0 6px; color: #9da7b1; }
nav { display: flex; gap: 2px; padding: 0 14px; background: #161b22; border-bottom: 1px solid #2d333b; }
nav button { background: none; border: none; color: #9da7b1; padding: 9px 14px; cursor: pointer; font: inherit; border-bottom: 2px solid transparent; }
nav button.active { color: #fff; border-bottom-color: #539bf5; }
main { padding: 18px; }
.card { background: #161b22; border: 1px solid #2d333b; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.narrow { max-width: 460px; margin: 60px auto; }
.muted { color: #768390; }
.error { color: #e5534b; }
.badge { padding: 2px 10px; border-radius: 10px; font-size: 12px; }
.badge.on { background: #1a3a24; color: #57ab5a; }
.badge.off { background: #3a1d1d; color: #e5534b; }
.badge.warn { background: #3d2f10; color: #daaa3f; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 13px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #2d333b; vertical-align: top; }
th { color: #768390; font-weight: 600; }
input, select, textarea { background: #0d1117; border: 1px solid #373e47; color: #d7dde4; border-radius: 6px; padding: 7px 10px; font: inherit; margin: 3px 4px 3px 0; }
textarea { width: 100%; min-height: 140px; }
button { background: #316dca; border: none; color: #fff; border-radius: 6px; padding: 7px 14px; cursor: pointer; font: inherit; margin: 3px 4px 3px 0; }
button.ghost { background: #21262d; border: 1px solid #373e47; color: #d7dde4; }
button.danger { background: #922f2b; }
button:disabled { opacity: .5; cursor: default; }
.hidden { display: none !important; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.kv { display: grid; grid-template-columns: 220px 1fr; gap: 4px 14px; }
.kv div:nth-child(odd) { color: #768390; }
pre { background: #0d1117; border: 1px solid #2d333b; border-radius: 6px; padding: 10px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
#modal { position: fixed; inset: 0; background: rgba(1,4,9,.8); display: flex; align-items: center; justify-content: center; }
#modal .card { max-width: 560px; }
#modal pre { font-size: 15px; color: #daaa3f; }
.disabled-banner { background: #3a1d1d; border: 1px solid #922f2b; color: #f0b6b3; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; }
`;

export const CONSOLE_JS = `(function () {
"use strict";
var session = null;
var currentTab = "overview";
var cursors = {};
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; }
function fmtTs(ms) { return ms ? new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 19) + "Z" : "-"; }
function api(path, opts) {
  opts = opts || {};
  var headers = { "content-type": "application/json" };
  if (session) headers["authorization"] = "Bearer " + session.token;
  return fetch("/operator/v1" + path, { method: opts.method || "GET", headers: headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (data) {
      if (r.status === 401 && session) logout(true);
      return { status: r.status, data: data };
    }); });
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function table(parent, headers, rows) {
  var t = el("table"), tr = el("tr");
  headers.forEach(function (h) { tr.appendChild(el("th", null, h)); });
  t.appendChild(tr);
  rows.forEach(function (cells) {
    var r = el("tr");
    cells.forEach(function (c) { var td = el("td"); if (c && c.nodeType) td.appendChild(c); else td.textContent = c == null ? "-" : String(c); r.appendChild(td); });
    t.appendChild(r);
  });
  parent.appendChild(t);
  if (!rows.length) parent.appendChild(el("p", "muted", "No rows."));
}
function kv(parent, pairs) {
  var d = el("div", "kv");
  pairs.forEach(function (p) { d.appendChild(el("div", null, p[0])); d.appendChild(el("div", null, p[1])); });
  parent.appendChild(d);
}
function err(parent, res) { parent.appendChild(el("p", "error", "Error " + res.status + ": " + (res.data.code || "?"))); }
function btn(label, cls, onClick) { var b = el("button", cls || null, label); b.type = "button"; b.addEventListener("click", onClick); return b; }
function field(placeholder, type) { var i = el("input"); i.type = type || "text"; i.placeholder = placeholder; i.spellcheck = false; return i; }
function showSecret(secret) {
  document.getElementById("modalSecret").textContent = secret;
  document.getElementById("modal").classList.remove("hidden");
}
function logout(expired) {
  if (session && !expired) api("/session", { method: "DELETE" });
  session = null;
  document.getElementById("app").classList.add("hidden");
  document.getElementById("loginCard").classList.remove("hidden");
  var b = document.getElementById("sessionBadge");
  b.textContent = expired ? "session expired" : "no session"; b.className = "badge off";
  document.getElementById("logoutBtn").classList.add("hidden");
}
function enter(result) {
  session = { token: result.token, expiresAt: result.expiresAt };
  document.getElementById("credentialInput").value = "";
  document.getElementById("loginCard").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  var b = document.getElementById("sessionBadge");
  b.textContent = "operator " + result.credentialLabel + " until " + fmtTs(result.expiresAt); b.className = "badge on";
  document.getElementById("logoutBtn").classList.remove("hidden");
  render();
}
var TABS = [["overview", "Overview"], ["provider", "Provider & Models"], ["users", "Plans & Users"], ["usage", "Usage & Ledger"], ["ops", "Operations"], ["audit", "Audit"]];
function render() {
  var nav = document.getElementById("tabs"); clear(nav);
  TABS.forEach(function (t) {
    var b = el("button", t[0] === currentTab ? "active" : null, t[1]);
    b.addEventListener("click", function () { currentTab = t[0]; cursors = {}; render(); });
    nav.appendChild(b);
  });
  var view = document.getElementById("view"); clear(view);
  ({ overview: vOverview, provider: vProvider, users: vUsers, usage: vUsage, ops: vOps, audit: vAudit })[currentTab](view);
}
function vOverview(v) {
  api("/overview").then(function (res) {
    if (res.status !== 200) return err(v, res);
    var o = res.data;
    if (o.runtime && o.runtime.disabled) v.appendChild(el("div", "disabled-banner", "RUNTIME DISABLED — new invocations are refused. Reason: " + (o.runtime.reason || "-")));
    var c = el("div", "card"); c.appendChild(el("h2", null, "Runtime"));
    kv(c, [["Kill switch", o.runtime.disabled ? "DISABLED" : "enabled"], ["Reason", o.runtime.reason], ["Updated", fmtTs(o.runtime.updatedAt) + " by " + (o.runtime.updatedBy || "-")]]);
    v.appendChild(c);
    c = el("div", "card"); c.appendChild(el("h2", null, "Tenancy"));
    kv(c, [["Hosted users", o.users.total], ["Active subscriptions", o.users.activeSubscriptions], ["Active hosted sessions", o.sessions.activeHosted], ["Active operator sessions", o.sessions.activeOperator]]);
    v.appendChild(c);
    c = el("div", "card"); c.appendChild(el("h2", null, "Usage (24h)"));
    kv(c, [["Committed units (24h)", o.usage.committedUnits24h], ["Open UNKNOWN", o.usage.openUnknown]]);
    table(c, ["status", "count"], (o.usage.last24hByStatus || []).map(function (s) { return [s.status, s.count]; }));
    v.appendChild(c);
    c = el("div", "card"); c.appendChild(el("h2", null, "Configuration"));
    kv(c, [["Provider", o.provider.label], ["Base URL (masked)", o.provider.baseUrlMasked], ["Catalog revision", o.catalog.revision], ["Managed AI enabled", o.catalog.managedAiEnabled], ["Plan revision", o.plans.revision], ["Last probe", o.provider.lastProbe ? fmtTs(o.provider.lastProbe.probedAt) + " ok=" + o.provider.lastProbe.ok : "never"]]);
    v.appendChild(c);
  });
}
function vProvider(v) {
  api("/provider").then(function (res) {
    if (res.status !== 200) return err(v, res);
    var p = res.data, c = el("div", "card");
    c.appendChild(el("h2", null, "Provider"));
    kv(c, [["Label", p.label], ["Base URL (masked)", p.baseUrlMasked], ["Configured", p.configured], ["Last probe", p.lastProbe ? fmtTs(p.lastProbe.probedAt) + " ok=" + p.lastProbe.ok + " http=" + (p.lastProbe.httpStatus || "-") + " " + (p.lastProbe.latencyMs || 0) + "ms" : "never"]]);
    c.appendChild(btn("Run connectivity probe", "ghost", function () {
      api("/provider/probe", { method: "POST", body: {} }).then(function () { render(); });
    }));
    c.appendChild(el("p", "muted", "Unauthenticated HEAD against the provider origin only. Never sends the platform key; never invokes a model."));
    v.appendChild(c);
    c = el("div", "card"); c.appendChild(el("h2", null, "Effective catalog " + p.catalog.revision));
    table(c, ["modelKey", "displayName", "enabled", "upstreamModelId", "mappingRevision", "caps", "maxIn", "maxOut"],
      p.catalog.models.map(function (m) { return [m.modelKey, m.displayName, m.enabled, m.upstreamModelId, m.mappingRevision,
        (m.capabilities.text ? "T" : "") + (m.capabilities.streaming ? "S" : "") + (m.capabilities.structuredOutput ? "J" : ""), m.maxInputTokens, m.maxOutputTokens]; }));
    v.appendChild(c);
    stagedSection(v);
  });
}
function stagedSection(v) {
  var c = el("div", "card"); c.appendChild(el("h2", null, "Staged catalog revisions (review-only — never auto-activated)"));
  api("/catalog/staged").then(function (res) {
    if (res.status === 200) table(c, ["revision", "status", "createdAt", "createdBy", "errors"], res.data.items.map(function (s) {
      return [s.revision, s.status, fmtTs(s.createdAt), s.createdBy, (s.validationErrors || []).join("; ")];
    }));
    var ta = el("textarea"); ta.placeholder = '{"revision":"…","managedAiEnabled":false,"defaultModelKey":"…","models":[…]}';
    c.appendChild(ta);
    var out = el("p", "muted");
    c.appendChild(btn("Stage for review", null, function () {
      var payload; try { payload = JSON.parse(ta.value); } catch (e) { out.textContent = "invalid JSON"; out.className = "error"; return; }
      api("/catalog/staged", { method: "POST", body: { catalog: payload } }).then(function (res) {
        if (res.status === 200) { render(); } else { out.textContent = "Error " + res.status + ": " + (res.data.code || ""); out.className = "error"; }
      });
    }));
    c.appendChild(out);
    v.appendChild(c);
  });
}
function vUsers(v) {
  var c = el("div", "card");
  c.appendChild(el("h2", null, "Plan policy"));
  api("/plans").then(function (res) {
    if (res.status !== 200) return err(c, res);
    table(c, ["planKey", "enabled", "allowedModels", "periodQuotaUnits", "usageUnits"], res.data.plans.map(function (p) {
      return [p.planKey, p.managedAiEnabled, p.allowedModels.join(", "), p.periodQuotaUnits, JSON.stringify(p.modelUsageUnits)];
    }));
    c.appendChild(el("p", "muted", "revision " + res.data.revision));
  });
  v.appendChild(c);
  c = el("div", "card");
  c.appendChild(el("h2", null, "Hosted users"));
  var search = field("search hostedUserId"), newId = field("new hostedUserId");
  c.appendChild(search); c.appendChild(btn("Search", "ghost", function () { cursors.users = null; load(); }));
  c.appendChild(newId); c.appendChild(btn("Create user", "ghost", function () {
    api("/users", { method: "POST", body: { hostedUserId: newId.value.trim() } }).then(function () { load(); });
  }));
  var listWrap = el("div"); c.appendChild(listWrap);
  var pager = el("div", "row"); c.appendChild(pager);
  v.appendChild(c);
  var detail = el("div"); v.appendChild(detail);
  function load() {
    clear(listWrap); clear(pager);
    var q = "?limit=25" + (search.value ? "&search=" + encodeURIComponent(search.value) : "") + (cursors.users ? "&cursor=" + encodeURIComponent(cursors.users) : "");
    api("/users" + q).then(function (res) {
      if (res.status !== 200) return err(listWrap, res);
      table(listWrap, ["hostedUserId", "plan", "status", "periodEnd", "sessions", "invocations", "committedUnits"], res.data.items.map(function (u) {
        var open = btn("open", "ghost", function () { userDetail(detail, u.hostedUserId); });
        return [u.hostedUserId, u.subscription ? u.subscription.planKey : "-", u.subscription ? u.subscription.status : "-", u.subscription ? fmtTs(u.subscription.periodEnd) : "-", u.activeSessions, u.invocations, u.committedUnits, open];
      }));
      if (res.data.nextCursor) pager.appendChild(btn("Next page", "ghost", function () { cursors.users = res.data.nextCursor; load(); }));
    });
  }
  load();
}
function userDetail(v, uid) {
  clear(v);
  api("/users/" + encodeURIComponent(uid)).then(function (res) {
    if (res.status !== 200) return err(v, res);
    var d = res.data, c = el("div", "card");
    c.appendChild(el("h2", null, "User " + d.hostedUserId));
    c.appendChild(el("h3", null, "Subscription"));
    if (d.subscription) kv(c, [["plan", d.subscription.planKey], ["status", d.subscription.status], ["period", fmtTs(d.subscription.periodStart) + " → " + fmtTs(d.subscription.periodEnd)], ["revision", d.subscription.revision], ["source", d.subscription.source + " / " + (d.subscription.sourceRevision || "-")]]);
    else c.appendChild(el("p", "muted", "none"));
    var plan = field("planKey"), status = el("select"), pStart = field("periodStart (ms or ISO)"), pEnd = field("periodEnd (ms or ISO)"), idem = field("idempotencyKey (optional)");
    ["ACTIVE", "PAST_DUE", "CANCELED", "EXPIRED"].forEach(function (s) { var o = el("option", null, s); o.value = s; status.appendChild(o); });
    var row = el("div", "row"); [plan, status, pStart, pEnd, idem].forEach(function (x) { row.appendChild(x); }); c.appendChild(row);
    var sres = el("span", "muted"); c.appendChild(sres);
    function subBody() { return { planKey: plan.value.trim(), status: status.value, periodStart: pStart.value.trim(), periodEnd: pEnd.value.trim(), idempotencyKey: idem.value.trim() || undefined }; }
    row.appendChild(btn("Provision", null, function () { sub("/users/" + encodeURIComponent(uid) + "/subscription/provision"); }));
    row.appendChild(btn("Set", null, function () { sub("/users/" + encodeURIComponent(uid) + "/subscription/set"); }));
    row.appendChild(btn("Revoke", "danger", function () { sub("/users/" + encodeURIComponent(uid) + "/subscription/revoke", { idempotencyKey: idem.value.trim() || undefined }); }));
    function sub(path, override) {
      api(path, { method: "POST", body: override || subBody() }).then(function (res) {
        if (res.status === 200) { sres.textContent = "ok — revision " + res.data.subscription.revision + (res.data.replayed ? " (idempotent replay)" : ""); sres.className = "muted"; userDetail(v, uid); }
        else { sres.textContent = "Error " + res.status + ": " + (res.data.code || ""); sres.className = "error"; }
      });
    }
    c.appendChild(el("h3", null, "Hosted sessions"));
    table(c, ["hashPrefix", "expiresAt"], (d.activeSessions || []).map(function (s) { return [s.prefix, fmtTs(s.expiresAt)]; }));
    var srow = el("div", "row"), ttl = field("ttl ms (default 24h)"); srow.appendChild(ttl);
    srow.appendChild(btn("Issue session", null, function () {
      var body = {}; if (ttl.value.trim()) body.ttlMs = Number(ttl.value.trim());
      api("/users/" + encodeURIComponent(uid) + "/sessions", { method: "POST", body: body }).then(function (res) {
        if (res.status === 200) showSecret(res.data.token); else sres.textContent = "Error " + res.status;
      });
    }));
    srow.appendChild(btn("Revoke all sessions", "danger", function () {
      api("/users/" + encodeURIComponent(uid) + "/sessions/revoke", { method: "POST", body: {} }).then(function () { userDetail(v, uid); });
    }));
    c.appendChild(srow);
    c.appendChild(el("h3", null, "Bindings"));
    table(c, ["id", "business", "resourceKey", "modelKey", "upstreamModelId", "mappingRevision"], (d.bindings || []).map(function (b) { return [b.id, b.business, b.resourceKey, b.modelKey, b.upstreamModelId, b.mappingRevision]; }));
    c.appendChild(el("h3", null, "Usage"));
    kv(c, [["total invocations", d.usage.total], ["committed units", d.usage.committedUnits]]);
    table(c, ["status", "count"], (d.usage.byStatus || []).map(function (s) { return [s.status, s.count]; }));
    c.appendChild(el("h3", null, "Recent usage"));
    usageTable(c, d.recentUsage || []);
    v.appendChild(c);
  });
}
function usageTable(parent, items) {
  table(parent, ["createdAt", "hostedUserId", "business", "operationId", "invocationKey", "model", "status", "settlement", "units", "latencyMs"],
    items.map(function (u) { return [fmtTs(u.createdAt), u.hostedUserId, u.business, u.operationId, u.invocationKey, u.modelKey, u.status, u.settlement, u.chargedUnits + "/" + u.reservedUnits, u.latencyMs]; }));
}
function vUsage(v) {
  var c = el("div", "card");
  c.appendChild(el("h2", null, "Usage ledger (read-only — operator cannot rewrite history)"));
  var uf = field("hostedUserId"), sf = el("select"), bf = field("business");
  ["", "RESERVED", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN"].forEach(function (s) { var o = el("option", null, s || "any status"); o.value = s; sf.appendChild(o); });
  var row = el("div", "row"); [uf, sf, bf].forEach(function (x) { row.appendChild(x); });
  row.appendChild(btn("Filter", "ghost", function () { cursors.usage = null; load(); }));
  c.appendChild(row);
  var wrap = el("div"); c.appendChild(wrap);
  var pager = el("div", "row"); c.appendChild(pager);
  v.appendChild(c);
  function load() {
    clear(wrap); clear(pager);
    var q = "?limit=50" + (uf.value ? "&user=" + encodeURIComponent(uf.value) : "") + (sf.value ? "&status=" + sf.value : "") + (bf.value ? "&business=" + encodeURIComponent(bf.value) : "") + (cursors.usage ? "&cursor=" + encodeURIComponent(cursors.usage) : "");
    api("/usage" + q).then(function (res) {
      if (res.status !== 200) return err(wrap, res);
      usageTable(wrap, res.data.items);
      if (res.data.nextCursor) pager.appendChild(btn("Next page", "ghost", function () { cursors.usage = res.data.nextCursor; load(); }));
    });
  }
  load();
}
function vOps(v) {
  api("/runtime").then(function (res) {
    if (res.status !== 200) return err(v, res);
    var r = res.data, c = el("div", "card");
    c.appendChild(el("h2", null, "Runtime kill switch"));
    if (r.disabled) c.appendChild(el("div", "disabled-banner", "DISABLED — all new managed invocations are refused at admission. In-flight invocations settle normally; idempotent replays still return receipts."));
    kv(c, [["State", r.disabled ? "DISABLED" : "enabled"], ["Reason", r.reason], ["Updated", fmtTs(r.updatedAt) + " by " + (r.updatedBy || "-")]]);
    var reason = field("reason (required to disable)"); c.appendChild(reason);
    var row = el("div", "row");
    row.appendChild(btn("Disable new admissions", "danger", function () {
      api("/runtime/disable", { method: "POST", body: { reason: reason.value.trim() } }).then(function () { render(); });
    }));
    row.appendChild(btn("Resume admissions", null, function () {
      api("/runtime/enable", { method: "POST", body: { reason: reason.value.trim() || undefined } }).then(function () { render(); });
    }));
    c.appendChild(row);
    v.appendChild(c);
    c = el("div", "card");
    c.appendChild(el("h2", null, "Boundaries"));
    c.appendChild(el("p", "muted", "This console cannot: show or change the platform upstream key, activate staged catalogs, restart services, rewrite usage/ledger rows, or promote hosted/desktop users to operator. Activation and key rotation are controlled deploy steps."));
    v.appendChild(c);
  });
}
function vAudit(v) {
  var c = el("div", "card");
  c.appendChild(el("h2", null, "Operator audit"));
  var wrap = el("div"); c.appendChild(wrap);
  var pager = el("div", "row"); c.appendChild(pager);
  v.appendChild(c);
  function load() {
    clear(wrap); clear(pager);
    api("/audit?limit=50" + (cursors.audit ? "&cursor=" + cursors.audit : "")).then(function (res) {
      if (res.status !== 200) return err(wrap, res);
      table(wrap, ["createdAt", "credentialId", "action", "target", "result", "detail"], res.data.items.map(function (a) {
        return [fmtTs(a.createdAt), (a.credentialId || "-").slice(0, 8), a.action, a.target, a.result, a.detail ? JSON.stringify(a.detail) : "-"];
      }));
      if (res.data.nextCursor) pager.appendChild(btn("Next page", "ghost", function () { cursors.audit = res.data.nextCursor; load(); }));
    });
  }
  load();
}
document.getElementById("loginBtn").addEventListener("click", function () {
  var cred = document.getElementById("credentialInput").value.trim();
  api("/session", { method: "POST", body: { credential: cred } }).then(function (res) {
    if (res.status === 200) { document.getElementById("loginError").textContent = ""; enter(res.data); }
    else document.getElementById("loginError").textContent = "Invalid or revoked credential.";
  });
});
document.getElementById("logoutBtn").addEventListener("click", function () { logout(false); });
document.getElementById("modalClose").addEventListener("click", function () {
  document.getElementById("modal").classList.add("hidden");
  document.getElementById("modalSecret").textContent = "";
});
})();
`;
