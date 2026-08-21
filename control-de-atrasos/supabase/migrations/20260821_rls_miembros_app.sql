-- Acceso a datos para miembros de la app (roles 'admin' y 'registrador')
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query -> Run
--
-- Contexto: las políticas actuales solo permiten leer datos a administradores
-- (is_app_admin). Los usuarios con rol 'registrador' no veían cursos,
-- estudiantes ni atrasos, y por lo tanto no podían registrar.
-- Además, la política de borrado de atrasos permitía borrar a cualquier
-- usuario autenticado; aquí se restringe a administradores.
--
-- Este script es idempotente: se puede ejecutar varias veces sin duplicar.

-- ─── PASO 1: función auxiliar ───────────────────────────────────────────
-- Verdadera si el usuario autenticado tiene alguna fila en app_user_roles.
-- SECURITY DEFINER para que la comprobación no dependa del RLS de la propia
-- tabla app_user_roles (mismo patrón que is_app_admin).
CREATE OR REPLACE FUNCTION public.is_app_member()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_user_roles WHERE user_id = auth.uid()
  );
$$;

-- ─── PASO 2: políticas de lectura e inserción para miembros ─────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'cursos'
      AND policyname = 'Miembros leen cursos'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "Miembros leen cursos"
      ON public.cursos FOR SELECT TO authenticated
      USING ((SELECT public.is_app_member()))
    $p$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'estudiantes'
      AND policyname = 'Miembros leen estudiantes'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "Miembros leen estudiantes"
      ON public.estudiantes FOR SELECT TO authenticated
      USING ((SELECT public.is_app_member()))
    $p$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'atrasos'
      AND policyname = 'Miembros leen atrasos'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "Miembros leen atrasos"
      ON public.atrasos FOR SELECT TO authenticated
      USING ((SELECT public.is_app_member()))
    $p$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'atrasos'
      AND policyname = 'Miembros registran atrasos'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "Miembros registran atrasos"
      ON public.atrasos FOR INSERT TO authenticated
      WITH CHECK ((SELECT public.is_app_member()))
    $p$;
  END IF;
END
$$;

-- ─── PASO 3: el borrado de atrasos queda solo para administradores ──────
DROP POLICY IF EXISTS "admin_delete_atrasos" ON public.atrasos;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'atrasos'
      AND policyname = 'Administradores eliminan atrasos'
  ) THEN
    EXECUTE $p$
      CREATE POLICY "Administradores eliminan atrasos"
      ON public.atrasos FOR DELETE TO authenticated
      USING ((SELECT public.is_app_admin()))
    $p$;
  END IF;
END
$$;

-- ─── PASO 4: reparar el usuario creado antes de este arreglo ────────────
-- El usuario de prueba existe en Auth pero no tiene fila en app_user_roles.
-- Reemplace el correo y ejecute UNA sola vez (descomente las líneas):
--
-- INSERT INTO public.app_user_roles (user_id, role)
-- SELECT u.id, 'registrador'
-- FROM auth.users u
-- WHERE u.email = 'correo-del-usuario-de-prueba'
--   AND NOT EXISTS (
--     SELECT 1 FROM public.app_user_roles r WHERE r.user_id = u.id
--   );

-- ─── PASO 5: permitir el rol 'registrador' en app_user_roles ────────────
-- La restricción original solo admitía 'admin', por lo que rechazaba insertar
-- usuarios con rol 'registrador' (error 23514 app_user_roles_role_check).
-- Se elimina y se vuelve a crear admitiendo ambos roles de la aplicación.
ALTER TABLE public.app_user_roles
  DROP CONSTRAINT IF EXISTS app_user_roles_role_check;

ALTER TABLE public.app_user_roles
  ADD CONSTRAINT app_user_roles_role_check
  CHECK (role IN ('admin', 'registrador'));
