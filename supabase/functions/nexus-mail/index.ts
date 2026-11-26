// NEXUS — nexus-mail
// Passes dashboard email requests (ping / send / replies) to the Google Apps Script email service.
// The Apps Script address and secret live only here, as Supabase secrets — never in the browser.
// Required secrets (Supabase → Edge Functions → Secrets): NEXUS_SCRIPT_URL, NEXUS_SCRIPT_SECRET
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
// Always answer 200 with {ok:false,error} so the dashboard can show the reason.
const reply = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { ...CORS, "Content-Type": "application/json" } });

const ACTIONS = new Set(["ping", "send", "replies"]);

export async function handle(req: Request, env: (k: string) => string | undefined = (k) => Deno.env.get(k), fetchFn: typeof fetch = fetch, make = createClient): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ ok: false, error: "Use POST" });
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return reply({ ok: false, error: "Not signed in" });
    const admin = make(env("SUPABASE_URL")!, env("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: u, error: ue } = await admin.auth.getUser(token);
    if (ue || !u?.user) return reply({ ok: false, error: "Your session has expired — sign in again." });
    const { data: p } = await admin.from("profiles").select("email, role, active").eq("id", u.user.id).maybeSingle();
    if (!p || !p.active) return reply({ ok: false, error: "Your NEXUS account is not active." });

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return reply({ ok: false, error: "Bad request" }); }
    const action = String(body.action || "");
    if (!ACTIONS.has(action)) return reply({ ok: false, error: "Unknown action" });

    const url = env("NEXUS_SCRIPT_URL"), secret = env("NEXUS_SCRIPT_SECRET");
    if (!url || !secret) return reply({ ok: false, error: "Gmail is not connected yet: add NEXUS_SCRIPT_URL and NEXUS_SCRIPT_SECRET in Supabase → Edge Functions → Secrets." });
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url)) return reply({ ok: false, error: "NEXUS_SCRIPT_URL must be the Apps Script web app address ending in /exec." });

    // the signed-in user's email is taken from the login, not from the browser
    const payload = { ...body, action, secret, user: p.email };
    const r = await fetchFn(url, { method: "POST", body: JSON.stringify(payload), redirect: "follow" });
    const text = await r.text();
    try { return reply(JSON.parse(text)); }
    catch { return reply({ ok: false, error: `The Gmail script returned an unexpected response (HTTP ${r.status}). Check the web app is deployed with access "Anyone".` }); }
  } catch (e) {
    return reply({ ok: false, error: "Email service error: " + ((e as Error)?.message || String(e)) });
  }
}

// start the function (tests import this file with NEXUS_TEST set, so the server is not started)
if (!(globalThis as Record<string, unknown>).NEXUS_TEST) Deno.serve((req) => handle(req));
