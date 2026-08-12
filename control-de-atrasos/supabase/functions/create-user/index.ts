// Edge Function: create-user
// Crea una cuenta de acceso (email + contraseña) usando el service role.
// Solo la puede ejecutar un administrador de la app (verifica is_app_admin con el JWT del solicitante).
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

  const body = await req.json().catch(() => ({}));
  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  const nombre = String(body.nombre || "").trim();
  const rol = String(body.rol || "registrador").trim();

  if (!email || !password) return json({ error: "Faltan correo o contraseña" }, 400);
  if (password.length < 6) return json({ error: "La contraseña debe tener al menos 6 caracteres" }, 400);

  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: user, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { nombre, app_role: rol },
  });

  if (error) return json({ error: error.message }, 400);

  return json({
    id: user.id,
    email: user.email,
    nombre: user.user_metadata?.nombre || "",
    rol: user.user_metadata?.app_role || "registrador",
    password,
  });
});
