/* NEXUS — cloud connector (Supabase).
   Signs the user in, loads NEXUS data from Supabase, saves every change back, and picks up
   changes made by other people. The dashboard code (index.html) is the same as the tested
   prototype; it calls window.NEXUS_CLOUD instead of the browser's local storage. */
(function () {
  "use strict";
  window.NEXUS_CLOUD_MODE = true;
  const CFG = window.NEXUS_CONFIG || {};
  const POLL_MS = CFG.pollMs || 20000;
  const PAGE = 1000;

  // ---------- how dashboard data is stored: one row per item ----------
  const MAPS = ["status", "dates", "entOn", "recip", "entTpl", "team", "assign", "stepTpl"];
  const LISTS = ["sent", "history", "replies", "feedback"];
  const SCALARS = ["master", "testMode", "templates", "defaultTpl", "lastBackup", "changesSinceBackup", "data", "removedInv",
    "nameMap", "dataMeta", "lastImport", "alwaysCc", "steps", "mig16"];
  const MEMBER_PREFIX = ["status/", "dates/", "sent/", "history/", "replies/", "feedback/", "entOn/"];
  const MEMBER_KEYS = ["master", "testMode", "changesSinceBackup", "lastBackup"];
  // same rule as public.nexus_can_write() in the database
  const canWrite = (p, role) => !role ? false : p === "base" ? role === "super" : (role === "super" || role === "admin") ? true
    : MEMBER_PREFIX.some(x => p.startsWith(x)) || MEMBER_KEYS.includes(p);
  const topKey = p => p.startsWith("rem.") ? "rem" : p.split("/")[0];

  let order = Date.now();
  function tagList(arr) {   // give every list item a stable id (_k) and an ordering number (_o); newest first
    let run = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      const it = arr[i];
      if (!it || typeof it !== "object") continue;
      if (!it._k) it._k = it.sid || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
      if (typeof it._o === "number") run = Math.max(run, it._o); else it._o = ++run;
    }
  }
  function toRows(S) {
    const m = new Map();
    SCALARS.forEach(k => { if (S[k] !== undefined) m.set(k, S[k]); });
    MAPS.forEach(k => Object.entries(S[k] || {}).forEach(([id, v]) => m.set(k + "/" + id, v)));
    const rem = S.rem || {};
    m.set("rem.all", rem.all || {});
    ["ent", "inv"].forEach(k => Object.entries(rem[k] || {}).forEach(([id, v]) => m.set("rem." + k + "/" + id, v)));
    LISTS.forEach(k => { const a = S[k] || []; tagList(a); a.forEach(it => m.set(k + "/" + it._k, it)); });
    return m;
  }
  function fromRows(cache) {
    const o = {}, lists = {};
    for (const [p, v] of cache) {
      if (v === null || v === undefined || p === "base") continue;
      if (p === "rem.all") { (o.rem = o.rem || {}).all = v; continue; }
      if (p.startsWith("rem.ent/") || p.startsWith("rem.inv/")) {
        const k = p.slice(4, 7), id = p.slice(8); o.rem = o.rem || {}; (o.rem[k] = o.rem[k] || {})[id] = v; continue;
      }
      const i = p.indexOf("/");
      if (i < 0) { o[p] = v; continue; }
      const k = p.slice(0, i), id = p.slice(i + 1);
      if (LISTS.includes(k)) (lists[k] = lists[k] || []).push(v);
      else if (MAPS.includes(k)) (o[k] = o[k] || {})[id] = v;
    }
    LISTS.forEach(k => { if (lists[k]) o[k] = lists[k].sort((a, b) => (b._o || 0) - (a._o || 0)); });
    return o;
  }

  // ---------- small UI helpers (login card + save indicator) ----------
  const $ = id => document.getElementById(id);
  function card(html) {   // replace the login card's content with a message
    const f = $("loginForm"); if (!f) return;
    f.dataset.saved = f.dataset.saved || f.innerHTML; f.innerHTML = html;
  }
  function restoreLogin(msg) {
    const f = $("loginForm"); if (f && f.dataset.saved) { f.innerHTML = f.dataset.saved; delete f.dataset.saved; }
    $("login").classList.remove("hidden"); $("app").classList.add("hidden");
    hideProto(); if (msg && $("lerr")) $("lerr").textContent = msg;
  }
  function hideProto() { document.querySelectorAll(".proto-note").forEach(n => n.remove()); }
  function pill(state, text) {
    const p = $("syncPill"); if (!p) return;
    p.classList.remove("hidden"); p.dataset.state = state;
    p.innerHTML = `<span class="dot" style="background:${state === "ok" ? "var(--good)" : state === "busy" ? "#ff9800" : "var(--crit)"}"></span>${text}`;
    p.title = state === "err" ? "Your last change has not reached the server yet. NEXUS keeps retrying; don’t close this tab." : "";
  }
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey || /PASTE/.test(CFG.supabaseUrl + CFG.supabaseAnonKey)) {
    document.addEventListener("DOMContentLoaded", () => card(`<div class="brand">NEXUS</div><p class="err" style="margin-top:12px">Setup not finished: open <b>config.js</b> in the GitHub repository and paste the Supabase Project URL and anon/publishable key.</p>`));
    return;
  }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });

  // ---------- state shared with the dashboard ----------
  let me = null, role = null, cache = new Map(), synced = new Map(), lastSeen = null;
  let S = null, timer = null, inflight = null, failing = false, pendingRemote = new Map(), pollTimer = null;

  async function fetchAll(since) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      let q = sb.from("nexus_kv").select("path,value,updated_at").order("updated_at", { ascending: true }).order("path", { ascending: true });
      if (since) q = q.gt("updated_at", since);
      const { data, error } = await q.range(from, from + PAGE - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < PAGE) break;
    }
    return out;
  }
  async function loadProfiles() {
    const { data, error } = await sb.from("profiles").select("email,name,role,active,must_change").order("name");
    if (error) throw error;
    return Object.fromEntries(data.map(p => [p.email, { email: p.email, name: p.name, role: p.role, active: p.active, mustChange: p.must_change }]));
  }
  const seen = rows => rows.forEach(r => { if (!lastSeen || r.updated_at > lastSeen) lastSeen = r.updated_at; });

  // ---------- saving: send only what changed, shortly after each change ----------
  function save(state) { S = state; clearTimeout(timer); timer = setTimeout(flush, 400); if (!failing) pill("busy", "Saving…"); }
  async function flush() {
    clearTimeout(timer); timer = null;
    if (inflight) { await inflight; return flush(); }
    if (!S) return;
    const now = toRows(S), ups = [];
    for (const [p, v] of now) { const j = JSON.stringify(v); if (synced.get(p) !== j && canWrite(p, role)) ups.push([p, v, j]); }
    for (const [p, j] of synced) if (!now.has(p) && j !== "null" && p !== "base" && canWrite(p, role)) ups.push([p, null, "null"]);
    if (!ups.length) { if (!failing) pill("ok", "Saved"); applyPending(); return; }
    inflight = (async () => {
      try {
        let batch = [], size = 0;
        const send = async () => {
          if (!batch.length) return;
          const { error } = await sb.from("nexus_kv").upsert(batch.map(([path, value]) => ({ path, value })), { onConflict: "path" });
          if (error) throw error;
          batch.forEach(([p, v, j]) => { synced.set(p, j); cache.set(p, v === null ? null : JSON.parse(j)); });
          batch = []; size = 0;
        };
        for (const u of ups) { batch.push(u); size += u[2].length; if (batch.length >= 300 || size > 700000) await send(); }
        await send();
        failing = false; pill("ok", "Saved");
      } catch (e) {
        failing = true; pill("err", "Not saved — retrying");
        console.error("NEXUS save failed", e);
        if (/JWT|session|auth/i.test(e.message || "")) { const { data } = await sb.auth.getSession(); if (!data.session) return restoreLogin("Your session ended — sign in again. Unsaved changes in this tab were not stored."); }
        setTimeout(() => save(S), 5000);
      } finally { inflight = null; }
    })();
    await inflight;
    applyPending();
  }
  window.addEventListener("beforeunload", e => { if (timer || inflight || failing) { flush(); e.preventDefault(); e.returnValue = ""; } });

  // ---------- picking up changes made by other people ----------
  async function poll() {
    if (!me || document.hidden) return;
    try {
      const since = lastSeen ? new Date(new Date(lastSeen).getTime() - 5000).toISOString() : null;   // small overlap so nothing is missed
      const rows = await fetchAll(since);
      seen(rows);
      rows.forEach(r => { const j = JSON.stringify(r.value); if (synced.get(r.path) !== j) pendingRemote.set(r.path, r); });
      applyPending();
    } catch (e) { console.warn("NEXUS refresh failed", e); }
  }
  function busy() { return timer || inflight || document.querySelector("#modalRoot .sheet, #modalRoot .modal, #modalRoot > *"); }
  function applyPending() {
    if (!pendingRemote.size || !window.NEXUS_CLOUD.onRemote) return;
    if (busy()) { setTimeout(applyPending, 1500); return; }
    const keys = new Set();
    for (const [p, r] of pendingRemote) {
      if (p === "base") continue;
      cache.set(p, r.value); synced.set(p, JSON.stringify(r.value)); keys.add(topKey(p));
    }
    pendingRemote.clear();
    if (keys.size) window.NEXUS_CLOUD.onRemote(fromRows(cache), [...keys]);
  }

  // ---------- email (through the nexus-mail server function) ----------
  async function invoke(fn, body) {
    try {
      const { data, error } = await sb.functions.invoke(fn, { body });
      if (error) {
        let msg = error.message || String(error);
        try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (_) { }
        return { ok: false, error: /Failed to send|fetch/i.test(msg) ? "Couldn’t reach the NEXUS server function “" + fn + "”. Check it is deployed in Supabase → Edge Functions." : msg };
      }
      return data && typeof data === "object" ? data : { ok: false, error: "Unexpected answer from " + fn };
    } catch (e) { return { ok: false, error: "Couldn’t reach the NEXUS server: " + (e.message || e) }; }
  }

  // ---------- start ----------
  async function boot() {
    card(`<div class="brand">NEXUS</div><p class="why" style="margin-top:12px">Loading…</p>`);
    try {
      const { data: s } = await sb.auth.getSession();
      if (!s.session) return restoreLogin();
      const email = (s.session.user.email || "").toLowerCase();
      const { data: prof } = await sb.from("profiles").select("email,name,role,active,must_change").eq("id", s.session.user.id).maybeSingle();
      if (!prof || !prof.active) { await sb.auth.signOut(); return restoreLogin(!prof ? "This login isn’t set up for NEXUS. Ask the super admin to add you." : "This account has been deactivated. Ask the super admin to reactivate it."); }
      me = { id: s.session.user.id, email }; role = prof.role;
      const rows = await fetchAll(null); seen(rows);
      rows.forEach(r => { cache.set(r.path, r.value); synced.set(r.path, JSON.stringify(r.value)); });
      if (!cache.get("base")) return firstRun();
      const accounts = await loadProfiles();
      window.NEXUS_CLOUD = {
        user: me, role, base: JSON.parse(JSON.stringify(cache.get("base"))), state: fromRows(cache), accounts,
        save, flush,
        mail: (action, payload) => invoke("nexus-mail", { ...(payload || {}), action }),
        async admin(action, body) {
          const r = await invoke("nexus-admin", { ...(body || {}), action });
          if (r.ok) r.accounts = Object.fromEntries((r.profiles || []).map(p => [p.email, { email: p.email, name: p.name, role: p.role, active: p.active, mustChange: p.must_change }]));
          return r;
        },
        async changePassword(current, next) {
          const chk = await sb.auth.signInWithPassword({ email: me.email, password: current });
          if (chk.error) return { ok: false, error: "Current password is incorrect." };
          const { error } = await sb.auth.updateUser({ password: next });
          if (error) return { ok: false, error: error.message };
          await sb.rpc("nexus_clear_must_change");
          return { ok: true };
        },
        async signOut() { try { await flush(); } catch (_) { } clearInterval(pollTimer); await sb.auth.signOut(); location.reload(); },
        onRemote: null,
      };
      const f = $("loginForm"); if (f && f.dataset.saved) { f.innerHTML = f.dataset.saved; delete f.dataset.saved; }
      hideProto();
      window.NEXUS_MAIN();
      pill("ok", "Saved");
      pollTimer = setInterval(poll, POLL_MS);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
    } catch (e) {
      console.error(e);
      card(`<div class="brand">NEXUS</div><p class="err" style="margin-top:12px">Couldn’t load NEXUS: ${esc(e.message || e)}</p><button class="btn primary" style="width:100%;margin-top:10px" onclick="location.reload()">Try again</button>`);
    }
  }

  function firstRun() {
    if (role !== "super") { card(`<div class="brand">NEXUS</div><p style="margin-top:12px">NEXUS hasn’t been set up yet. Ask Siddharth to load the starting data.</p><button class="btn" id="foOut" style="width:100%">Sign out</button>`); $("foOut").onclick = async () => { await sb.auth.signOut(); location.reload(); }; return; }
    card(`<div class="brand">Set up NEXUS</div>
      <p class="why" style="margin-top:8px">One-time step. Choose the starting data file <b>NEXUS_base_data.json</b> (sent to you separately — it is not in GitHub). After this, restore your latest backup from Settings → Backup &amp; restore.</p>
      <input type="file" id="baseFile" accept=".json,application/json" class="inp" style="margin-top:8px">
      <div class="err" id="baseErr" role="alert"></div>
      <button class="btn primary" type="button" id="baseOk" style="width:100%;margin-top:6px">Load starting data</button>`);
    $("baseOk").onclick = async () => {
      const f = $("baseFile").files[0], err = $("baseErr");
      if (!f) { err.textContent = "Choose the file first."; return; }
      let d; try { d = JSON.parse(await f.text()); } catch (_) { err.textContent = "This isn’t a valid JSON file."; return; }
      if (!d || !Array.isArray(d.invoices) || !Array.isArray(d.entities) || !d.team || !d.sender || !d.finance) { err.textContent = "This isn’t the NEXUS starting data file."; return; }
      delete d.accounts;   // logins live in Supabase, never in the data
      $("baseOk").disabled = true; $("baseOk").textContent = "Loading…";
      const { error } = await sb.from("nexus_kv").upsert([{ path: "base", value: d }], { onConflict: "path" });
      if (error) { err.textContent = "Couldn’t save: " + error.message; $("baseOk").disabled = false; $("baseOk").textContent = "Load starting data"; return; }
      cache.clear(); synced.clear(); lastSeen = null; boot();
    };
  }

  document.addEventListener("DOMContentLoaded", () => {
    hideProto();
    const form = $("loginForm");
    form.addEventListener("submit", async e => {
      if (!form.querySelector("#lid")) return;
      e.preventDefault();
      const id = $("lid").value.trim().toLowerCase(), pw = $("lpw").value, err = $("lerr");
      if (!/^[^\s@]+@univariety\.com$/.test(id)) { err.textContent = "Login ID must be your @univariety.com email address."; return; }
      if (!pw) { err.textContent = "Enter your password."; return; }
      err.textContent = "";
      const btn = form.querySelector("button[type=submit]"); btn.disabled = true;
      const { error } = await sb.auth.signInWithPassword({ email: id, password: pw });
      btn.disabled = false;
      if (error) { err.textContent = /banned/i.test(error.message) ? "This account has been deactivated. Ask the super admin to reactivate it." : "Incorrect login ID or password."; return; }
      $("lpw").value = "";
      boot();
    });
    sb.auth.getSession().then(({ data }) => { if (data.session) boot(); });
  });
  // exposed for tests only
  window.__nexusCloudTest = { toRows, fromRows, tagList, canWrite };
})();
