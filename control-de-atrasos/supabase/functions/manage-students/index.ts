// Edge Function: manage-students
// CRUD de estudiantes y creación masiva de cursos con listas de estudiantes.
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

// ── helpers ──────────────────────────────────────────────────
const NIVELES_CURSO = ["colegio", "escuela"];

function normalizeNivel(value: unknown): string {
  const v = String(value || "").trim().toLowerCase();
  return NIVELES_CURSO.includes(v) ? v : "colegio";
}

async function resolveCursoId(adminClient: any, cursoNombre: string, nivel?: string): Promise<string | number | null> {
  const trimmed = cursoNombre.trim();
  if (!trimmed) return null;

  const { data: existing } = await adminClient
    .from("cursos")
    .select("id")
    .ilike("nombre", trimmed)
    .limit(1)
    .maybeSingle();

  if (existing?.id) return existing.id;

  const { data: inserted } = await adminClient
    .from("cursos")
    .insert({ nombre: trimmed, nivel: normalizeNivel(nivel) })
    .select("id")
    .single();

  return inserted?.id ?? null;
}

async function fetchStudentsNormalized(adminClient: any) {
  const { data: cursos } = await adminClient
    .from("cursos")
    .select("id, nombre");
  const courseMap = new Map(
    (cursos || []).map((c: Record<string, unknown>) => [String(c.id), String(c.nombre || "")]),
  );

  const { data: rows } = await adminClient
    .from("estudiantes")
    .select("id, nombre, curso_id, email")
    .order("nombre", { ascending: true });

  return (rows || []).map((r: Record<string, unknown>) => ({
    id: r.id,
    nombre: String(r.nombre || ""),
    curso: courseMap.get(String(r.curso_id)) || "",
    email: String(r.email || ""),
  }));
}

async function fetchCursosNormalized(adminClient: any) {
  let result = await adminClient
    .from("cursos")
    .select("id, nombre, nivel")
    .order("nombre", { ascending: true });

  // Si la columna nivel aún no existe (migración pendiente), se consulta el nombre únicamente.
  if (result.error) {
    result = await adminClient
      .from("cursos")
      .select("id, nombre")
      .order("nombre", { ascending: true });
  }

  return (result.data || []).map((c: Record<string, unknown>) => ({
    id: c.id,
    nombre: String(c.nombre || ""),
    nivel: String(c.nivel || "colegio"),
  }));
}

// ── serve ────────────────────────────────────────────────────
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

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "").trim();

  try {
    // ── LIST ────────────────────────────────────────────────
    if (action === "list") {
      const students = await fetchStudentsNormalized(adminClient);
      const cursos = await fetchCursosNormalized(adminClient);
      return json({ students, cursos });
    }

    // ── CREATE (individual) ─────────────────────────────────
    if (action === "create") {
      const nombre = String(body.nombre || "").trim();
      const curso = String(body.curso || "").trim();
      const email = String(body.email || "").trim();
      const nivel = String(body.nivel || "").trim();
      if (!nombre || !curso) return json({ error: "Faltan nombre o curso" }, 400);

      const cursoId = await resolveCursoId(adminClient, curso, nivel);
      if (!cursoId) return json({ error: "No se pudo resolver el curso" }, 500);

      const { data: dup } = await adminClient
        .from("estudiantes")
        .select("id")
        .eq("curso_id", cursoId)
        .ilike("nombre", nombre)
        .limit(1)
        .maybeSingle();

      if (dup) return json({ error: "Ya existe un estudiante con ese nombre en este curso" }, 409);

      const { error } = await adminClient
        .from("estudiantes")
        .insert({ nombre, curso_id: cursoId, email: email || null });
      if (error) return json({ error: error.message }, 400);

      const students = await fetchStudentsNormalized(adminClient);
      const cursos = await fetchCursosNormalized(adminClient);
      return json({ success: true, students, cursos });
    }

    // ── UPDATE (individual) ─────────────────────────────────
    if (action === "update") {
      const id = body.id;
      const nombre = String(body.nombre || "").trim();
      const curso = String(body.curso || "").trim();
      const email = String(body.email || "").trim();
      const nivel = String(body.nivel || "").trim();
      if (!id || !nombre || !curso) return json({ error: "Faltan campos obligatorios" }, 400);

      const cursoId = await resolveCursoId(adminClient, curso, nivel);
      if (!cursoId) return json({ error: "No se pudo resolver el curso" }, 500);

      const { data: dup } = await adminClient
        .from("estudiantes")
        .select("id")
        .eq("curso_id", cursoId)
        .ilike("nombre", nombre)
        .neq("id", id)
        .limit(1)
        .maybeSingle();

      if (dup) return json({ error: "Ya existe otro estudiante con ese nombre en este curso" }, 409);

      const { error } = await adminClient
        .from("estudiantes")
        .update({ nombre, curso_id: cursoId, email: email || null })
        .eq("id", id);
      if (error) return json({ error: error.message }, 400);

      const students = await fetchStudentsNormalized(adminClient);
      const cursos = await fetchCursosNormalized(adminClient);
      return json({ success: true, students, cursos });
    }

    // ── DELETE ──────────────────────────────────────────────
    if (action === "delete") {
      const id = body.id;
      if (!id) return json({ error: "Falta el id del estudiante" }, 400);

      await adminClient.from("atrasos").delete().eq("estudiante_id", id);
      const { error } = await adminClient.from("estudiantes").delete().eq("id", id);
      if (error) return json({ error: error.message }, 400);

      const students = await fetchStudentsNormalized(adminClient);
      const cursos = await fetchCursosNormalized(adminClient);
      return json({ success: true, students, cursos });
    }

    // ── CREATE-COURSE (masivo) ─────────────────────────────
    if (action === "create-course") {
      const curso = String(body.curso || "").trim();
      const nivel = String(body.nivel || "").trim();
      const rawNames = Array.isArray(body.estudiantes) ? body.estudiantes : [];
      if (!curso) return json({ error: "Falta el nombre del curso" }, 400);
      if (rawNames.length === 0) return json({ error: "Debe indicar al menos un estudiante" }, 400);

      const cursoId = await resolveCursoId(adminClient, curso, nivel);
      if (!cursoId) return json({ error: "No se pudo crear o resolver el curso" }, 500);

      const cleaned = rawNames
        .map((n: unknown) => String(n || "").trim())
        .filter((n: string) => n.length > 0);

      const seen = new Set<string>();
      let created = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const name of cleaned) {
        const key = name.toLowerCase();
        if (seen.has(key)) {
          skipped++;
          errors.push(`'${name}' duplicado en la lista — saltado`);
          continue;
        }
        seen.add(key);

        const { data: exists } = await adminClient
          .from("estudiantes")
          .select("id")
          .eq("curso_id", cursoId)
          .ilike("nombre", name)
          .limit(1)
          .maybeSingle();

        if (exists) {
          skipped++;
          errors.push(`'${name}' ya existe en el curso — saltado`);
          continue;
        }

        const { error: insErr } = await adminClient
          .from("estudiantes")
          .insert({ nombre: name, curso_id: cursoId, email: null });

        if (insErr) {
          errors.push(`Error al crear '${name}': ${insErr.message}`);
        } else {
          created++;
        }
      }

      const students = await fetchStudentsNormalized(adminClient);
      const cursos = await fetchCursosNormalized(adminClient);
      return json({ success: true, created, skipped, errors, students, cursos });
    }

    // ── RENAME-COURSE ───────────────────────────────────────
    if (action === "rename-course") {
      const id = body.id;
      const nuevoNombre = String(body.nuevoNombre || "").trim();
      if (!id || !nuevoNombre) return json({ error: "Faltan el id y el nuevo nombre del curso" }, 400);

      const { data: current, error: curErr } = await adminClient
        .from("cursos")
        .select("id")
        .eq("id", id)
        .maybeSingle();
      if (curErr) return json({ error: curErr.message }, 400);
      if (!current) return json({ error: "El curso no existe" }, 404);

      const { data: dup, error: dupErr } = await adminClient
        .from("cursos")
        .select("id")
        .ilike("nombre", nuevoNombre)
        .neq("id", id)
        .limit(1)
        .maybeSingle();
      if (dupErr) return json({ error: dupErr.message }, 400);
      if (dup) return json({ error: `Ya existe un curso llamado "${nuevoNombre}"` }, 409);

      const { error } = await adminClient
        .from("cursos")
        .update({ nombre: nuevoNombre })
        .eq("id", id);
      if (error) return json({ error: error.message }, 400);

      const students = await fetchStudentsNormalized(adminClient);
      const cursos = await fetchCursosNormalized(adminClient);
      return json({ success: true, students, cursos });
    }

    // ── DELETE-COURSE ───────────────────────────────────────
    if (action === "delete-course") {
      const id = body.id;
      if (!id) return json({ error: "Falta el id del curso" }, 400);

      const { data: course, error: cErr } = await adminClient
        .from("cursos")
        .select("id")
        .eq("id", id)
        .maybeSingle();
      if (cErr) return json({ error: cErr.message }, 400);
      if (!course) return json({ error: "El curso no existe" }, 404);

      const { data: studentsInCourse } = await adminClient
        .from("estudiantes")
        .select("id")
        .eq("curso_id", id);

      const studentIds = (studentsInCourse || []).map((s: Record<string, unknown>) => s.id);
      if (studentIds.length > 0) {
        await adminClient.from("atrasos").delete().in("estudiante_id", studentIds);
        await adminClient.from("estudiantes").delete().in("id", studentIds);
      }

      const { error } = await adminClient.from("cursos").delete().eq("id", id);
      if (error) return json({ error: error.message }, 400);

      const outStudents = await fetchStudentsNormalized(adminClient);
      const cursos = await fetchCursosNormalized(adminClient);
      return json({ success: true, students: outStudents, cursos });
    }

    return json({ error: `Acción desconocida: ${action}` }, 400);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
