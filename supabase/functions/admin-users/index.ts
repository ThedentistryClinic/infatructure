// =============================================================================
// Edge Function: admin-users
// Operations that need the Supabase service role key (never sent to browsers):
//   create_user, set_active, send_password_reset
// Authorisation: the caller's own JWT is used to ask the database whether the
// caller may do this (same RLS / helper functions as the rest of the app).
// Deploy: supabase functions deploy admin-users
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY are
// injected automatically. Set ALLOWED_ORIGINS and APP_BASE_URL yourself.
// =============================================================================
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "";
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes("*")) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function requireManage(caller: SupabaseClient, targetId: string) {
  const { data, error } = await caller.rpc("can_manage_user", { p_user_id: targetId });
  if (error) throw new HttpError(500, error.message);
  if (data !== true) throw new HttpError(403, "ไม่มีสิทธิ์จัดการผู้ใช้รายนี้");
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) throw new HttpError(401, "กรุณาเข้าสู่ระบบ");

    // Client acting AS THE CALLER: every query is subject to RLS
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Privileged client: used only after authorisation succeeded
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: ctx, error: ctxErr } = await caller.rpc("my_context");
    if (ctxErr || !ctx) throw new HttpError(401, "เซสชันไม่ถูกต้อง");
    const perms: string[] = ctx.permissions ?? [];
    const callerId: string = ctx.profile.id;
    if (!ctx.profile.is_active) throw new HttpError(403, "บัญชีถูกปิดใช้งาน");

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");

    if (action === "create_user") {
      if (!perms.includes("users.manage")) throw new HttpError(403, "ไม่มีสิทธิ์เพิ่มผู้ใช้");
      const email = String(body.email ?? "").trim().toLowerCase();
      const fullName = String(body.full_name ?? "").trim();
      const departmentId = body.department_id ? String(body.department_id) : null;
      const roleCodes: string[] = Array.isArray(body.role_codes) ? body.role_codes.map(String) : [];
      const password = body.password ? String(body.password) : "";
      if (!EMAIL_RE.test(email)) throw new HttpError(400, "อีเมลไม่ถูกต้อง");
      if (!fullName) throw new HttpError(400, "กรุณาระบุชื่อ-นามสกุล");
      if (departmentId && !UUID_RE.test(departmentId)) throw new HttpError(400, "แผนกไม่ถูกต้อง");
      if (password && password.length < 10) throw new HttpError(400, "รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร");

      const appMeta = { provisioned: true, provisioned_by: callerId, department_id: departmentId ?? "" };
      let newId: string;
      if (password) {
        const { data, error } = await admin.auth.admin.createUser({
          email, password, email_confirm: true,
          user_metadata: { full_name: fullName }, app_metadata: appMeta,
        });
        if (error) throw new HttpError(400, error.message);
        newId = data.user.id;
      } else {
        const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
          data: { full_name: fullName },
          redirectTo: APP_BASE_URL ? `${APP_BASE_URL}#/reset-password` : undefined,
        });
        if (error) throw new HttpError(400, error.message);
        newId = data.user.id;
        // invite cannot set app_metadata at creation time: activate explicitly
        await admin.auth.admin.updateUserById(newId, { app_metadata: appMeta });
      }

      // Profile details (authorised above: users.manage, new user is lowest level)
      const { error: pErr } = await admin.from("profiles").update({
        full_name: fullName,
        department_id: departmentId,
        username: body.username ? String(body.username).trim().toLowerCase() : null,
        employee_code: body.employee_code ? String(body.employee_code).trim() : null,
        position: body.position ? String(body.position).trim() : null,
        is_active: true,
      }).eq("id", newId);
      if (pErr) throw new HttpError(400, pErr.message);

      // Extra roles are inserted AS THE CALLER so RLS enforces can_assign_role
      const extra = roleCodes.filter((c) => c !== "employee");
      const roleErrors: string[] = [];
      if (extra.length) {
        const { data: roles } = await caller.from("roles").select("id, code").in("code", extra);
        for (const r of roles ?? []) {
          const { error } = await caller.from("user_roles").insert({ user_id: newId, role_id: r.id });
          if (error) roleErrors.push(`${r.code}: ${error.message}`);
        }
      }
      await admin.from("audit_logs").insert({
        actor_id: callerId, actor_email: ctx.profile.email, action: "user.create",
        entity_type: "profiles", entity_id: newId, summary: email,
        details: { roles: roleCodes, department_id: departmentId, invited: !password, role_errors: roleErrors },
      });
      return new Response(JSON.stringify({ ok: true, user_id: newId, role_errors: roleErrors }), { headers });
    }

    if (action === "set_active") {
      const userId = String(body.user_id ?? "");
      const active = body.active === true;
      if (!UUID_RE.test(userId)) throw new HttpError(400, "user_id ไม่ถูกต้อง");
      if (userId === callerId) throw new HttpError(400, "ไม่สามารถเปลี่ยนสถานะบัญชีของตนเองได้");
      await requireManage(caller, userId);

      // Profile flag through the caller (RLS + guard trigger + audit trigger)
      const { data: upd, error } = await caller.from("profiles").update({ is_active: active })
        .eq("id", userId).select("id");
      if (error) throw new HttpError(400, error.message);
      if (!upd?.length) throw new HttpError(403, "ไม่มีสิทธิ์จัดการผู้ใช้รายนี้");
      // Block / unblock sign-in and refresh tokens at the Auth level
      const { error: banErr } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: active ? "none" : "876000h",
      });
      if (banErr) throw new HttpError(500, banErr.message);
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    if (action === "send_password_reset") {
      const userId = String(body.user_id ?? "");
      if (!UUID_RE.test(userId)) throw new HttpError(400, "user_id ไม่ถูกต้อง");
      await requireManage(caller, userId);
      const { data: prof } = await admin.from("profiles").select("email").eq("id", userId).single();
      if (!prof) throw new HttpError(404, "ไม่พบผู้ใช้");
      const { error } = await admin.auth.resetPasswordForEmail(prof.email, {
        redirectTo: APP_BASE_URL ? `${APP_BASE_URL}#/reset-password` : undefined,
      });
      if (error) throw new HttpError(400, error.message);
      await admin.from("audit_logs").insert({
        actor_id: callerId, actor_email: ctx.profile.email, action: "user.password_reset_sent",
        entity_type: "profiles", entity_id: userId, summary: prof.email, details: {},
      });
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    throw new HttpError(400, "Unknown action");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const message = e instanceof Error ? e.message : "Unexpected error";
    if (status === 500) console.error(e);
    return new Response(JSON.stringify({ error: message }), { status, headers });
  }
});
