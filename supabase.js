// Supabase client. Configuration comes from js/env.js (generated per environment
// by scripts/generate-env.mjs). Only the PUBLIC anon / publishable key may be used.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

function decodeJwtRole(key) {
  try {
    const payload = key.split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).role;
  } catch { return null; }
}

function loadConfig() {
  const c = window.APP_CONFIG || {};
  const problems = [];
  if (!c.SUPABASE_URL || !/^https?:\/\//.test(c.SUPABASE_URL)) problems.push('SUPABASE_URL ไม่ได้ตั้งค่า');
  if (!c.SUPABASE_ANON_KEY) problems.push('SUPABASE_ANON_KEY ไม่ได้ตั้งค่า');
  // Hard stop if anyone ships a privileged key to the browser.
  if (c.SUPABASE_ANON_KEY && (c.SUPABASE_ANON_KEY.startsWith('sb_secret_') || decodeJwtRole(c.SUPABASE_ANON_KEY) === 'service_role')) {
    problems.push('ตรวจพบ Service Role / Secret key ในฝั่งเว็บ — ห้ามใช้เด็ดขาด ให้ใช้ anon หรือ publishable key เท่านั้น');
  }
  return { config: { APP_ENV: 'production', ADMIN_USERS_FUNCTION: 'admin-users', ...c }, problems };
}

export const { config, problems: configProblems } = loadConfig();

export const supabase = configProblems.length ? null : createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
});
