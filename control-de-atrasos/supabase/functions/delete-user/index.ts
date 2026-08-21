// Edge Function: delete-user
// Elimina una cuenta de acceso (auth.users) usando el service role.
// Solo la puede ejecutar un administrador de la app (verifica is_app_admin con el JWT del solicitante).
// La fila correspondiente en app_user_roles se elimina sola (FK ON DELETE CASCADE).
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

  // Identidad del solicitante: para impedir que elimine su propia cuenta.
  const { data: callerData } = await callerClient.auth.getUser(jwt);
  const callerId = callerData?.user?.id;

  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "").trim();

  if (!id) return json({ error: "Falta el identificador del usuario" }, 400);
  if (callerId && id === callerId) {
    return json({ error: "No puede eliminar su propia cuenta" }, 400);
  }

  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await adminClient.auth.admin.deleteUser(id);
  if (error) return json({ error: error.message }, 400);

  return json({ ok: true });
});
