// NEXUS — nexus-admin
// Super-admin only: add sign-in accounts, change role, reset password, deactivate / reactivate.
// Uses the service role key, which Supabase provides to functions automatically (never sent to the browser).
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { ...CORS, "Content-Type": "application/json" } });
const EMAIL = /^[^\s@]+@univariety\.com$/;

export async function handle(req: Request, env: (k: string) => string | undefined = (k) => Deno.env.get(k), make = createClient): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ ok: false, error: "Use POST" });
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return reply({ ok: false, error: "Not signed in" });
    const admin = make(env("SUPABASE_URL")!, env("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: u, error: ue } = await admin.auth.getUser(token);
    if (ue || !u?.user) return reply({ ok: false, error: "Your session has expired — sign in again." });
    const { data: me } = await admin.from("profiles").select("role, active").eq("id", u.user.id).maybeSingle();
    if (!me || !me.active || me.role !== "super") return reply({ ok: false, error: "Only the super admin can manage users." });

    let b: Record<string, unknown>;
    try { b = await req.json(); } catch { return reply({ ok: false, error: "Bad request" }); }
    const action = String(b.action || "");
    const email = String(b.email || "").trim().toLowerCase();
    const list = async () => (await admin.from("profiles").select("email, name, role, active, must_change").order("name")).data || [];

    if (action === "list") return reply({ ok: true, profiles: await list() });
    if (!EMAIL.test(email)) return reply({ ok: false, error: "Login must be an @univariety.com email address." });

    if (action === "create") {
      const name = String(b.name || "").trim(), role = String(b.role || ""), password = String(b.password || "");
      if (!name) return reply({ ok: false, error: "Enter the name." });
      if (!["admin", "member"].includes(role)) return reply({ ok: false, error: "Role must be Admin or Member." });
      if (password.length < 8) return reply({ ok: false, error: "Temporary password must be at least 8 characters." });
      const { data: ex } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
      if (ex) return reply({ ok: false, error: "An account with this email already exists." });
      const { data: cu, error: ce } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
      if (ce || !cu?.user) return reply({ ok: false, error: "Could not create the login: " + (ce?.message || "unknown error") });
      const { error: pe } = await admin.from("profiles").insert({ id: cu.user.id, email, name, role, active: true, must_change: true });
      if (pe) { await admin.auth.admin.deleteUser(cu.user.id); return reply({ ok: false, error: "Could not save the profile: " + pe.message }); }
      return reply({ ok: true, profiles: await list() });
    }

    const { data: t } = await admin.from("profiles").select("id, role").eq("email", email).maybeSingle();
    if (!t) return reply({ ok: false, error: "No NEXUS account with this email." });
    if (t.role === "super") return reply({ ok: false, error: "The super admin account can't be changed here." });

    if (action === "role") {
      const role = String(b.role || "");
      if (!["admin", "member"].includes(role)) return reply({ ok: false, error: "Role must be Admin or Member." });
      const { error } = await admin.from("profiles").update({ role }).eq("id", t.id);
      if (error) return reply({ ok: false, error: error.message });
    } else if (action === "password") {
      const password = String(b.password || "");
      if (password.length < 8) return reply({ ok: false, error: "Temporary password must be at least 8 characters." });
      const { error } = await admin.auth.admin.updateUserById(t.id, { password });
      if (error) return reply({ ok: false, error: error.message });
      await admin.from("profiles").update({ must_change: true }).eq("id", t.id);
    } else if (action === "active") {
      const active = !!b.active;
      const { error } = await admin.auth.admin.updateUserById(t.id, { ban_duration: active ? "none" : "876000h" });
      if (error) return reply({ ok: false, error: error.message });
      await admin.from("profiles").update({ active }).eq("id", t.id);
    } else return reply({ ok: false, error: "Unknown action" });

    return reply({ ok: true, profiles: await list() });
  } catch (e) {
    return reply({ ok: false, error: "User service error: " + ((e as Error)?.message || String(e)) });
  }
}

// start the function (tests import this file with NEXUS_TEST set, so the server is not started)
if (!(globalThis as Record<string, unknown>).NEXUS_TEST) Deno.serve((req) => handle(req));
