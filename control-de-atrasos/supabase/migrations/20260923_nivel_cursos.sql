-- Nivel educativo al que pertenece cada curso: 'colegio' | 'escuela'
-- Aplicar en: Supabase Dashboard -> SQL Editor -> New query -> Run
-- (o con: supabase db push)
--
-- Contexto: los cursos recién agregados corresponden a la Escuela y los
-- existentes al Colegio (misma institución). Se agrega una columna "nivel"
-- a la tabla cursos y se marcan los cursos de la Escuela con un backfill
-- idempotente según el padrón registrado.
-- Este script se puede ejecutar varias veces sin efectos colaterales.

-- 1) Columna nivel (idempotente)
ALTER TABLE public.cursos ADD COLUMN IF NOT EXISTS nivel TEXT NOT NULL DEFAULT 'colegio';

-- 2) Restricción de valores permitidos (idempotente)
ALTER TABLE public.cursos DROP CONSTRAINT IF EXISTS cursos_nivel_check;
ALTER TABLE public.cursos ADD CONSTRAINT cursos_nivel_check CHECK (nivel IN ('colegio', 'escuela'));

-- 3) Backfill: cursos de la Escuela
UPDATE public.cursos SET nivel = 'escuela'
WHERE nombre IN (
  'Inicial 3 años',
  'Inicial 4 años A',
  'Inicial 4 años B',
  '1º A', '1º B',
  '2º A', '2º B',
  '3º A', '3º B',
  '4º A', '4º B',
  '5º A', '5º B',
  '6º A', '6º B',
  '7º A', '7º B'
);

-- 4) Respaldar cualquier valor residual al nivel del Colegio
UPDATE public.cursos SET nivel = 'colegio'
WHERE nivel IS NULL OR nivel = '' OR nivel NOT IN ('colegio', 'escuela');