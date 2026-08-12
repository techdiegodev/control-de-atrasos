-- Registro de quién registró cada atraso
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query -> Run

-- 1) Columna para guardar el correo del usuario que registró el atraso
ALTER TABLE atrasos ADD COLUMN IF NOT EXISTS registrado_por TEXT;

-- 2) Trigger que asigna automáticamente el correo del usuario autenticado.
--    Se ejecuta antes de cada INSERT y sobrescribe cualquier valor enviado,
--    por lo que el dato siempre es confiable (no se puede falsear).
CREATE OR REPLACE FUNCTION public.set_registrado_por()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.registrado_por := (SELECT email FROM auth.users WHERE id = auth.uid());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_registrado_por ON public.atrasos;
CREATE TRIGGER trg_set_registrado_por
BEFORE INSERT ON public.atrasos
FOR EACH ROW EXECUTE FUNCTION public.set_registrado_por();
