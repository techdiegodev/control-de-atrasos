// Edge Function: list-users
// Lista las cuentas creadas (service role). Solo administradores de la app.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "No autorizado" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  const callerClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });

  const { data: isAdmin } = await callerClient.rpc("is_app_admin");
  if (isAdmin !== true) return json({ error: "No tiene permisos de administrador" }, 403);

  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) return json({ error: error.message }, 400);

  // El rol vigente vive en app_user_roles (la misma fuente que consultan
  // is_app_admin() y las políticas RLS); el user_metadata puede estar
  // desactualizado o vacío en cuentas creadas manualmente.
  const { data: rolesRows } = await adminClient
    .from("app_user_roles")
    .select("user_id, role");

  const rolPorUsuario = new Map(
    (rolesRows ?? []).map((r) => [r.user_id, r.role])
  );

  const users = (data?.users || [])
    .map((u) => ({
      id: u.id,
      email: u.email,
      nombre: u.user_metadata?.nombre || "",
      rol: rolPorUsuario.get(u.id) || "registrador",
      created_at: u.created_at,
    }))
    .sort((a, b) => (a.email || "").localeCompare(b.email || ""));

  return json({ users });
});
