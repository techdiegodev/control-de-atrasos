/* ============================================================
   CONTROL DE ATRASOS — app.js
   Persistencia: localStorage
   Gráficos: Chart.js 4 + chartjs-plugin-datalabels
   Exportar: jsPDF + jspdf-autotable | SheetJS (xlsx)
   ============================================================ */

// Registrar plugin datalabels globalmente; se desactiva por defecto
// y se activa solo en las gráficas que lo necesitan.
Chart.register(ChartDataLabels);
Chart.defaults.plugins.datalabels.display = false;

// ─── STORAGE ────────────────────────────────────────────────
const LS_STUDENTS = 'ca_students';
const LS_ATRASOS  = 'ca_atrasos';
const LS_COURSES  = 'ca_courses';
const LS_SEQ_S    = 'ca_seq_s';
const LS_SEQ_A    = 'ca_seq_a';

const SUPABASE_URL = (window.SUPABASE_URL || 'https://lngrtvozaznytgvxtblm.supabase.co').trim();
const SUPABASE_ANON_KEY = (window.SUPABASE_ANON_KEY || 'sb_publishable_A599IrBwF5L4jr9lVKMdgw_ZAhmYpE5').trim();
const normalizedSupabaseUrl = SUPABASE_URL.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const hasSupabaseConfig = Boolean(normalizedSupabaseUrl && SUPABASE_ANON_KEY);
const SUPABASE_TABLES = window.SUPABASE_TABLES || {
  cursos: ['cursos', 'courses', 'course', 'curso'],
  estudiantes: ['estudiantes', 'students', 'student', 'alumnos'],
  atrasos: ['atrasos', 'delays', 'delay', 'incidencias'],
};
let supabase = null;
// Indica si la información en pantalla proviene de Supabase. Mientras esté
// activo no se añaden ni se conservan los datos de demostración locales.
let usingSupabaseData = false;
try {
  supabase = window.supabase && hasSupabaseConfig
    ? window.supabase.createClient(normalizedSupabaseUrl, SUPABASE_ANON_KEY)
    : null;
} catch (err) {
  console.warn('No fue posible inicializar el cliente de Supabase.', err);
  supabase = null;
}

function isSupabaseEnabled() {
  return Boolean(supabase);
}

function setSupabaseStatus(status, message) {
  const el = document.getElementById('connection-status');
  if (!el) return;
  el.className = `connection-pill ${status}`;
  el.textContent = message;
}

function loadStudents()  {
  const data = JSON.parse(localStorage.getItem(LS_STUDENTS) || '[]');
  if (!Array.isArray(data)) return [];
  return data.map(s => ({
    id: s.id,
    nombre: s.nombre,
    curso: s.curso,
    email: s.email || '',
  }));
}
function loadAtrasos()   { return JSON.parse(localStorage.getItem(LS_ATRASOS)  || '[]'); }
function loadCourses()   { const data = JSON.parse(localStorage.getItem(LS_COURSES) || '[]'); return Array.isArray(data) ? data : []; }
function saveStudents(d) { localStorage.setItem(LS_STUDENTS, JSON.stringify(d)); }
function saveAtrasos(d)  { localStorage.setItem(LS_ATRASOS,  JSON.stringify(d)); }
function saveCourses(d)  { localStorage.setItem(LS_COURSES,  JSON.stringify(d)); }

function pickExactValue(row, keys) {
  if (!row || typeof row !== 'object') return '';
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const value = row[key];
      if (value !== null && value !== undefined && value !== '') return value;
    }
  }
  return '';
}

function courseMatches(courseA = '', courseB = '') {
  return String(courseA || '').trim() === String(courseB || '').trim();
}

async function trySupabaseQuery(table, select, orderBy = null, ascending = true) {
  // Supabase/PostgREST devuelve como máximo 1000 filas por petición; se pagina
  // en bloques para no perder estudiantes/atrasos cuando superan ese límite.
  const PAGE_SIZE = 1000;
  const allData = [];
  try {
    let page = 0;
    while (true) {
      let query = supabase.from(table).select(select);
      if (orderBy) {
        query = query.order(orderBy, { ascending });
      }
      query = query.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
      const { data, error } = await query;
      if (error) return { ok: false, error, table };
      const rows = Array.isArray(data) ? data : [];
      allData.push(...rows);
      if (rows.length < PAGE_SIZE) break;
      page += 1;
      if (page > 500) break;
    }
    return { ok: true, data: allData, table };
  } catch (error) {
    return { ok: false, error, table };
  }
}

async function hydrateFromSupabase() {
  if (!isSupabaseEnabled()) {
    setSupabaseStatus('local', 'Modo local');
    return false;
  }

  setSupabaseStatus('checking', 'Conectando a Supabase...');

  try {
    const courseCandidates = (SUPABASE_TABLES.cursos || []).map(table => ({
      table,
      select: 'id, nombre, nivel',
      orderBy: 'nombre',
      ascending: true,
    }));
    const studentCandidates = (SUPABASE_TABLES.estudiantes || []).map(table => ({
      table,
      select: 'id, nombre, curso_id, email',
      orderBy: 'nombre',
      ascending: true,
    }));
    const delayCandidates = (SUPABASE_TABLES.atrasos || []).map(table => ({
      table,
      select: 'id, estudiante_id, fecha, hora, justificado, motivo, registrado_por',
      orderBy: 'fecha',
      ascending: false,
    }));

    let cursosData = [];
    let estudiantesData = [];
    let atrasosData = [];
    let coursesQuerySucceeded = false;
    let studentsQuerySucceeded = false;
    let delaysQuerySucceeded = false;
    const supabaseErrors = [];

    for (const candidate of courseCandidates) {
      let result = await trySupabaseQuery(candidate.table, candidate.select, candidate.orderBy, candidate.ascending);
      // Si la columna "nivel" aún no existe, se reintenta sin ella.
      if (!result.ok && candidate.select.includes('nivel')) {
        const selectBase = candidate.select.split(',').map(s => s.trim()).filter(s => s && s !== 'nivel').join(', ');
        result = await trySupabaseQuery(candidate.table, selectBase, candidate.orderBy, candidate.ascending);
      }
      if (result.ok) {
        cursosData = result.data || [];
        coursesQuerySucceeded = true;
        break;
      }
      supabaseErrors.push({ kind: 'courses', table: result.table, error: result.error });
    }

    for (const candidate of studentCandidates) {
      const result = await trySupabaseQuery(candidate.table, candidate.select, candidate.orderBy, candidate.ascending);
      if (result.ok) {
        estudiantesData = result.data || [];
        studentsQuerySucceeded = true;
        break;
      }
      supabaseErrors.push({ kind: 'students', table: result.table, error: result.error });
    }

    for (const candidate of delayCandidates) {
      let result = await trySupabaseQuery(candidate.table, candidate.select, candidate.orderBy, candidate.ascending);
      if (!result.ok && candidate.select.includes('registrado_por')) {
        const selectBase = candidate.select.split(',').map(s => s.trim()).filter(s => s && s !== 'registrado_por').join(', ');
        result = await trySupabaseQuery(candidate.table, selectBase, candidate.orderBy, candidate.ascending);
      }
      if (result.ok) {
        atrasosData = result.data || [];
        delaysQuerySucceeded = true;
        break;
      }
      supabaseErrors.push({ kind: 'atrasos', table: result.table, error: result.error });
    }

    const cursos = (cursosData || []).map(c => {
      const nombre = String(pickExactValue(c, ['nombre', 'name', 'curso', 'title']) || '').trim();
      const nivelStored = String(pickExactValue(c, ['nivel']) || '').trim();
      return {
        id: pickExactValue(c, ['id', 'ID']),
        nombre,
        nivel: (nivelStored === 'colegio' || nivelStored === 'escuela') ? nivelStored : getNivelCursoFromName(nombre),
      };
    });

    const courseById = Object.fromEntries(cursos.map(c => [String(c.id), c.nombre]));

    const students = (estudiantesData || []).map(s => {
      const id = pickExactValue(s, ['id', 'ID']);
      const nombre = String(pickExactValue(s, ['nombre', 'name', 'estudiante']) || '').trim();
      const email = String(pickExactValue(s, ['email', 'correo', 'mail']) || '').trim();
      const cursoFromField = String(pickExactValue(s, ['curso', 'curso_nombre', 'cursoName', 'curso_name', 'nombre_curso']) || '').trim();
      const cursoId = pickExactValue(s, ['curso_id', 'cursoId', 'cursoid']);
      const curso = cursoFromField || (cursoId !== '' ? (courseById[String(cursoId)] || '') : '');

      return { id, nombre, curso, email };
    });

    const atrasos = (atrasosData || []).map(a => ({
      id: pickExactValue(a, ['id', 'ID']),
      studentId: pickExactValue(a, ['estudiante_id', 'student_id', 'estudianteId', 'studentId']),
      fecha: pickExactValue(a, ['fecha', 'date']),
      hora: pickExactValue(a, ['hora', 'time']),
      justificado: !!pickExactValue(a, ['justificado', 'justified']),
      motivo: String(pickExactValue(a, ['motivo', 'reason', 'observacion']) || '').trim(),
      registradoPor: String(pickExactValue(a, ['registrado_por', 'registradoPor']) || '').trim(),
    }));

    const connectedToTables = coursesQuerySucceeded && studentsQuerySucceeded;

    if (connectedToTables) {
      // La caché local se reemplaza incluso si una tabla todavía está vacía.
      // Así nunca se mezclan datos antiguos/de demostración con Supabase.
      saveCourses(cursos);
      saveStudents(students);
      // Si la tabla de atrasos no puede leerse, no se muestra el historial
      // local antiguo como si perteneciera a la base de datos.
      saveAtrasos(delaysQuerySucceeded ? atrasos : []);
      usingSupabaseData = true;
      setSupabaseStatus('connected', `Supabase activo · ${cursos.length} cursos · ${students.length} estudiantes`);
    } else {
      usingSupabaseData = false;
      const firstError = supabaseErrors[0];
      const detail = firstError?.error?.message || 'sin tablas o permisos';
      const statusDetail = firstError ? `Supabase sin datos (${firstError.table}): ${detail}` : 'Supabase sin datos; usando datos locales';
      setSupabaseStatus('local', statusDetail);
    }
    return connectedToTables;
  } catch (err) {
    usingSupabaseData = false;
    console.warn('Supabase no disponible o aún no está configurado.', err);
    setSupabaseStatus('local', 'Modo local');
    return false;
  }
}

function nextId(key) {
  const n = parseInt(localStorage.getItem(key) || '0') + 1;
  localStorage.setItem(key, n);
  return n;
}

// ─── NIVELES Y CURSOS DEL ESTABLECIMIENTO ────────────────────
const NIVELES = [
  { id: 'colegio', label: 'Colegio' },
  { id: 'escuela', label: 'Escuela' },
];

const CURSOS_ORDENADOS_COLEGIO = [
  '8º A','8º B','8º C',
  '9º A','9º B','9º C',
  '10º A','10º B','10º C',
  '1º Hosteleria A','1º Hosteleria B',
  '1º Ciencias','1º Gestión',
  '2º Ciencias A','2º Ciencias B','2º Servicios','2º Gestión',
  '3º Ciencias A','3º Ciencias B','3º Servicios','3º Gestión',
];

const CURSOS_ORDENADOS_ESCUELA = [
  'Inicial 3 años','Inicial 4 años A','Inicial 4 años B',
  '1º A','1º B','2º A','2º B','3º A','3º B',
  '4º A','4º B','5º A','5º B','6º A','6º B','7º A','7º B',
];

// Alias de compatibilidad: antes la única lista ordenada era la del Colegio.
const CURSOS_ORDENADOS = CURSOS_ORDENADOS_COLEGIO;

function getNivelCursoFromName(nombre) {
  const n = String(nombre || '').trim();
  if (CURSOS_ORDENADOS_ESCUELA.indexOf(n) !== -1) return 'escuela';
  return 'colegio';
}

function getCursoNivel(nombre) {
  const n = String(nombre || '').trim();
  const entry = loadCourses().find(c => c.nombre === n);
  if (entry && (entry.nivel === 'colegio' || entry.nivel === 'escuela')) return entry.nivel;
  return getNivelCursoFromName(n);
}

function nivelLabel() {
  if (dashboardNivel === 'colegio') return 'Colegio';
  if (dashboardNivel === 'escuela') return 'Escuela';
  return 'Todo el establecimiento';
}

function getAvailableCourseNames() {
  const fromCourses = loadCourses().map(c => c.nombre).filter(Boolean);
  return [...new Set(fromCourses)];
}

function sortCursos(cursos) {
  const courseOrder = loadCourses().map(c => c.nombre);
  const nivelByName = {};
  loadCourses().forEach(c => { if (c.nombre) nivelByName[c.nombre] = c.nivel; });

  const nivelOf = (n) => {
    const stored = nivelByName[n];
    if (stored === 'colegio' || stored === 'escuela') return stored;
    return getNivelCursoFromName(n);
  };

  const rankOf = (n) => {
    const nivel = nivelOf(n);
    const list = nivel === 'escuela' ? CURSOS_ORDENADOS_ESCUELA : CURSOS_ORDENADOS_COLEGIO;
    return { nivel: nivel === 'escuela' ? 1 : 0, idx: list.indexOf(n) };
  };

  return [...cursos].sort((a, b) => {
    const ra = rankOf(a), rb = rankOf(b);
    if (ra.nivel !== rb.nivel) return ra.nivel - rb.nivel;
    if (ra.idx !== -1 && rb.idx !== -1) return ra.idx - rb.idx;
    if (ra.idx !== -1) return -1;
    if (rb.idx !== -1) return 1;

    const oa = courseOrder.indexOf(a);
    const ob = courseOrder.indexOf(b);
    if (oa !== -1 && ob !== -1) return oa - ob;
    if (oa !== -1) return -1;
    if (ob !== -1) return 1;
    return a.localeCompare(b);
  });
}

// ─── SEED INITIAL DATA (only if empty) ──────────────────────
(function seedIfEmpty() {
  // La app ya no utiliza datos de demostración: Supabase es la única fuente.
  return;
  if (loadStudents().length > 0) return;

  const today  = new Date();
  const offset = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };

  const students = [
    { id:1,  nombre:'Valentina Torres Muñoz',    curso:'8 A',              email:'' },
    { id:2,  nombre:'Matías González Pérez',     curso:'8 A',              email:'' },
    { id:3,  nombre:'Isidora Martínez Soto',     curso:'9 B',              email:'' },
    { id:4,  nombre:'Benjamín Rojas Contreras',  curso:'9 B',              email:'' },
    { id:5,  nombre:'Catalina Fuentes Vidal',    curso:'1 Ciencias',       email:'' },
    { id:6,  nombre:'Sebastián Muñoz Reyes',     curso:'1 Ciencias',       email:'' },
    { id:7,  nombre:'Antonia Vargas Castro',     curso:'2 Gestión',        email:'' },
    { id:8,  nombre:'Nicolás Herrera Morales',   curso:'2 Gestión',        email:'' },
    { id:9,  nombre:'Sofía Ramírez Jiménez',     curso:'3 Ciencias A',     email:'' },
    { id:10, nombre:'Diego Álvarez Navarro',     curso:'10 A',             email:'' },
  ];
  localStorage.setItem(LS_SEQ_S, '10');
  saveStudents(students);

  const atrasos = [
    {id:1, studentId:1, fecha:offset(0),  hora:'08:15', justificado:false, motivo:''},
    {id:2, studentId:1, fecha:offset(1),  hora:'08:22', justificado:false, motivo:''},
    {id:3, studentId:1, fecha:offset(3),  hora:'08:30', justificado:true,  motivo:'Médico'},
    {id:4, studentId:1, fecha:offset(5),  hora:'08:10', justificado:false, motivo:''},
    {id:5, studentId:1, fecha:offset(7),  hora:'08:45', justificado:false, motivo:''},
    {id:6, studentId:1, fecha:offset(9),  hora:'08:20', justificado:false, motivo:''},
    {id:7, studentId:1, fecha:offset(12), hora:'08:18', justificado:false, motivo:''},
    {id:8, studentId:2, fecha:offset(0),  hora:'08:35', justificado:false, motivo:''},
    {id:9, studentId:2, fecha:offset(2),  hora:'08:40', justificado:true,  motivo:'Transporte'},
    {id:10,studentId:2, fecha:offset(4),  hora:'08:25', justificado:false, motivo:''},
    {id:11,studentId:2, fecha:offset(8),  hora:'08:15', justificado:false, motivo:''},
    {id:12,studentId:2, fecha:offset(11), hora:'08:50', justificado:false, motivo:''},
    {id:13,studentId:3, fecha:offset(1),  hora:'08:20', justificado:false, motivo:''},
    {id:14,studentId:3, fecha:offset(5),  hora:'08:30', justificado:false, motivo:''},
    {id:15,studentId:3, fecha:offset(10), hora:'08:15', justificado:true,  motivo:'Cita médica'},
    {id:16,studentId:3, fecha:offset(15), hora:'08:45', justificado:false, motivo:''},
    {id:17,studentId:3, fecha:offset(20), hora:'08:25', justificado:false, motivo:''},
    {id:18,studentId:4, fecha:offset(0),  hora:'08:40', justificado:false, motivo:''},
    {id:19,studentId:4, fecha:offset(3),  hora:'08:20', justificado:false, motivo:''},
    {id:20,studentId:4, fecha:offset(7),  hora:'08:35', justificado:false, motivo:''},
    {id:21,studentId:4, fecha:offset(14), hora:'08:50', justificado:false, motivo:''},
    {id:22,studentId:5, fecha:offset(2),  hora:'08:15', justificado:true,  motivo:'Urgencia'},
    {id:23,studentId:5, fecha:offset(6),  hora:'08:30', justificado:false, motivo:''},
    {id:24,studentId:5, fecha:offset(13), hora:'08:20', justificado:false, motivo:''},
    {id:25,studentId:6, fecha:offset(1),  hora:'08:45', justificado:false, motivo:''},
    {id:26,studentId:6, fecha:offset(4),  hora:'08:25', justificado:false, motivo:''},
    {id:27,studentId:6, fecha:offset(9),  hora:'08:15', justificado:false, motivo:''},
    {id:28,studentId:7, fecha:offset(0),  hora:'08:20', justificado:false, motivo:''},
    {id:29,studentId:7, fecha:offset(2),  hora:'08:35', justificado:true,  motivo:'Médico'},
    {id:30,studentId:7, fecha:offset(8),  hora:'08:40', justificado:false, motivo:''},
    {id:31,studentId:8, fecha:offset(3),  hora:'08:15', justificado:false, motivo:''},
    {id:32,studentId:8, fecha:offset(6),  hora:'08:30', justificado:false, motivo:''},
    {id:33,studentId:9, fecha:offset(1),  hora:'08:45', justificado:false, motivo:''},
    {id:34,studentId:9, fecha:offset(5),  hora:'08:20', justificado:true,  motivo:'Transporte'},
    {id:35,studentId:10,fecha:offset(2),  hora:'08:25', justificado:false, motivo:''},
  ];
  localStorage.setItem(LS_SEQ_A, '35');
  saveAtrasos(atrasos);
})();

// ─── HELPERS ────────────────────────────────────────────────
const ECUADOR_TIME_ZONE = 'America/Guayaquil';

function ecuadorNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ECUADOR_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = type => parts.find(part => part.type === type)?.value;
  return {
    fecha: `${value('year')}-${value('month')}-${value('day')}`,
    hora: `${value('hour')}:${value('minute')}:${value('second')}`,
  };
}

function today() { return ecuadorNow().fecha; }

function dateOffset(n) {
  const [year, month, day] = today().split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function formatDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

const MESES_CORTOS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
function formatFechaCorta(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${parseInt(d, 10)}-${MESES_CORTOS[parseInt(m, 10) - 1] || ''}`;
}

// ─── ESCAPADO (XSS) ────────────────────────────────────────
// Escapa un valor para insertarlo como texto o atributo (entre comillas
// dobles) dentro de un template HTML. Neutraliza <script>, <img onerror=...>
// y cualquier otra inyección proveniente de nombres, motivos o emails.
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escapa un valor para usarlo como argumento de un manejador inline
// (onclick="fn('...')"): primero se sanean caracteres JS (barra y comilla
// simple) y luego los caracteres que podrían romper el atributo HTML.
function escJsArg(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/'/g, "\\'")
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getStudent(id) {
  return loadStudents().find(s => s.id === id);
}

// ─── TOAST ──────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

// ─── NAVIGATION ─────────────────────────────────────────────
let currentPage = 'dashboard';
let currentAuthUser = null;
let authorizedAdmin = false;
let authorizedUser = false;

document.querySelectorAll('.nav-item').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo(link.dataset.page);
  });
});

document.getElementById('btn-admin-access').addEventListener('click', handleAdminButton);
document.getElementById('btn-admin-access-sidebar').addEventListener('click', handleAdminButton);

function isAdmin() {
  return authorizedAdmin;
}

function canRegister() {
  return authorizedUser || authorizedAdmin;
}

function showAuthModal() {
  document.getElementById('auth-modal-overlay').classList.remove('hidden');
  document.getElementById('auth-email').focus();
}

function hideAuthModal() {
  document.getElementById('auth-modal-overlay').classList.add('hidden');
}

function showPasswordModal() {
  hideAuthModal();
  document.getElementById('password-modal-overlay').classList.remove('hidden');
  document.getElementById('auth-new-password').focus();
}

function hidePasswordModal() {
  document.getElementById('password-modal-overlay').classList.add('hidden');
}

function updateAccess() {
  const admin = isAdmin();
  const canUse = canRegister();
  document.querySelectorAll('[data-page="registrar"]').forEach(el => {
    el.style.display = canUse ? '' : 'none';
  });
  document.querySelectorAll('[data-page="usuarios"]').forEach(el => {
    el.style.display = admin ? '' : 'none';
  });
  // La gestión de estudiantes es solo para administradores.
  document.querySelectorAll('[data-page="estudiantes"]').forEach(el => {
    el.style.display = admin ? '' : 'none';
  });

  const adminButton = document.getElementById('btn-admin-access');
  const sidebarAdminButton = document.getElementById('btn-admin-access-sidebar');
  const label = canUse ? 'Cerrar sesión' : 'Ingresar';
  if (adminButton) adminButton.textContent = label;
  if (sidebarAdminButton) {
    const span = sidebarAdminButton.querySelector('span');
    if (span) span.textContent = label;
  }

  const newStudentBtn = document.getElementById('btn-nuevo-estudiante');
  if (newStudentBtn) newStudentBtn.style.display = admin ? '' : 'none';

  const clearBtn = document.getElementById('btn-limpiar-registros');
  if (clearBtn) clearBtn.style.display = admin ? '' : 'none';

  const sessionPills = document.querySelectorAll('.session-pill');
  if (sessionPills.length) {
    if (canUse && currentAuthUser) {
      const nombre = String(currentAuthUser.user_metadata?.nombre || '').trim();
      const texto = `${nombre || currentAuthUser.email} · ${admin ? 'Administrador' : 'Registrador'}`;
      document.querySelectorAll('.session-user-name').forEach(el => { el.textContent = texto; });
      sessionPills.forEach(p => { p.title = texto; p.classList.remove('hidden'); });
    } else {
      sessionPills.forEach(p => p.classList.add('hidden'));
    }
  }
}

async function handleAdminButton() {
  if (isAdmin() || canRegister()) {
    await supabase.auth.signOut();
    currentAuthUser = null;
    authorizedAdmin = false;
    authorizedUser = false;
    updateAccess();
    showToast('Sesión cerrada.');
    if (currentPage === 'registrar' || currentPage === 'estudiantes' || currentPage === 'usuarios') {
      navigateTo('dashboard');
    }
    await loadPublicDashboard();
  } else {
    showAuthModal();
  }
}

async function validateAuthorizedUser() {
  if (!supabase || !currentAuthUser) {
    authorizedAdmin = false;
    authorizedUser = false;
    return false;
  }

  const { data, error } = await supabase.rpc('is_app_admin');
  authorizedAdmin = !error && data === true;
  authorizedUser = true;
  updateAccess();
  return authorizedUser;
}

async function initializeAuthentication() {
  if (!supabase) return false;
  const authAction = new URLSearchParams(window.location.hash.slice(1)).get('type');
  const { data, error } = await supabase.auth.getSession();
  if (error) console.warn('No se pudo recuperar la sesión.', error);
  currentAuthUser = data?.session?.user || null;
  if (authAction === 'recovery' || authAction === 'invite') showPasswordModal();
  const allowed = await validateAuthorizedUser();

  supabase.auth.onAuthStateChange((event, session) => {
    currentAuthUser = session?.user || null;
    if (event === 'PASSWORD_RECOVERY') showPasswordModal();
    window.setTimeout(() => {
      validateAuthorizedUser().then(isAllowed => {
        if (isAllowed) {
          refreshDashboard();
        } else {
          setSupabaseStatus('local', 'Inicie sesión para acceder a los datos');
          renderPage('dashboard');
        }
      });
    }, 0);
  });
  return allowed;
}

document.getElementById('btn-auth-cancel').addEventListener('click', hideAuthModal);
document.getElementById('btn-auth-reset').addEventListener('click', async () => {
  const email = document.getElementById('auth-email').value.trim();
  if (!email) {
    showToast('Escriba primero su correo institucional.', 'error');
    return;
  }

  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname,
    });
    if (error) throw error;
    showToast('Revise su correo para crear la contraseña.');
  } catch (error) {
    console.error('No se pudo enviar el correo de contraseña.', error);
    showToast(error.message || 'No se pudo enviar el correo.', 'error');
  }
});

document.getElementById('form-password-update').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = document.getElementById('auth-new-password').value;
  const confirmation = document.getElementById('auth-confirm-password').value;
  if (password !== confirmation) {
    showToast('Las contraseñas no coinciden.', 'error');
    return;
  }

  const submit = document.getElementById('btn-password-submit');
  submit.disabled = true;
  submit.textContent = 'Guardando...';
  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    hidePasswordModal();
    document.getElementById('form-password-update').reset();
    const allowed = await validateAuthorizedUser();
    if (!allowed) throw new Error('La contraseña fue creada, pero esta cuenta aún no tiene rol de administrador.');
    showToast('Contraseña creada. Sesión iniciada.');
    await refreshDashboard();
  } catch (error) {
    console.error('No se pudo actualizar la contraseña.', error);
    showToast(error.message || 'No se pudo guardar la contraseña.', 'error');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Guardar contraseña';
  }
});

document.getElementById('form-auth').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!supabase) {
    showToast('Supabase no está disponible.', 'error');
    return;
  }

  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const submit = document.getElementById('btn-auth-submit');
  submit.disabled = true;
  submit.textContent = 'Ingresando...';

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    currentAuthUser = data.user || null;
    const allowed = await validateAuthorizedUser();
    if (!allowed) {
      await supabase.auth.signOut();
      throw new Error('Esta cuenta no tiene autorización para usar la aplicación.');
    }
    hideAuthModal();
    document.getElementById('form-auth').reset();
    showToast('Sesión iniciada.');
    await refreshDashboard();
  } catch (error) {
    console.error('No se pudo iniciar sesión.', error);
    showToast(error.message || 'No se pudo iniciar sesión.', 'error');
    await loadPublicDashboard();
  } finally {
    submit.disabled = false;
    submit.textContent = 'Ingresar';
  }
});

function navigateTo(page) {
  if ((page === 'usuarios' || page === 'estudiantes') && !isAdmin()) {
    showAuthModal();
    return;
  }
  if (page === 'registrar' && !canRegister()) {
    showAuthModal();
    return;
  }

  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(l =>
    l.classList.toggle('active', l.dataset.page === page));
  document.querySelectorAll('.page').forEach(p =>
    p.classList.toggle('active', p.id === `page-${page}`));
  renderPage(page);
}

function renderPage(page) {
  if (page === 'dashboard')   renderDashboard();
  if (page === 'registrar')   populateCursosDropdown();
  if (page === 'historico')   renderHistorico();
  if (page === 'estudiantes') renderEstudiantes();
  if (page === 'usuarios')    renderUsuarios();
}

// ─── DASHBOARD ──────────────────────────────────────────────
let chartEvolucion = null;
let chartCurso = null;
let evolutionRange = '30d';
let evolutionView = 'daily';
let evolutionFrom = '';
let evolutionTo = '';

// Nivel seleccionado en el panel: 'todo' | 'colegio' | 'escuela'
let dashboardNivel = 'todo';

function filterByNivel(students, atrasos) {
  if (dashboardNivel === 'todo') return { students, atrasos };
  const allowed = new Set();
  students.forEach(s => { if (getCursoNivel(s.curso) === dashboardNivel) allowed.add(s.id); });
  return {
    students: students.filter(s => allowed.has(s.id)),
    atrasos: atrasos.filter(a => allowed.has(a.studentId)),
  };
}

function setDashboardNivel(nivel) {
  dashboardNivel = ['colegio', 'escuela', 'todo'].indexOf(nivel) !== -1 ? nivel : 'todo';
  document.querySelectorAll('#dashboard-nivel-switcher .btn-chip').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.nivel === dashboardNivel);
  });
  renderDashboard();
}

document.querySelectorAll('#dashboard-nivel-switcher .btn-chip').forEach(btn => {
  btn.addEventListener('click', () => setDashboardNivel(btn.dataset.nivel));
});

function setEvolutionRange(range, view = 'daily') {
  evolutionRange = range;
  evolutionView = view;
  if (range !== 'custom') {
    evolutionFrom = '';
    evolutionTo = '';
  }
  renderDashboard();
}

function getEvolutionWindow() {
  const today = new Date();
  const to = new Date(today);
  let from = new Date(today);

  if (evolutionRange === '7d') {
    from.setDate(today.getDate() - 6);
  } else if (evolutionRange === '90d') {
    from.setDate(today.getDate() - 89);
  } else if (evolutionRange === '30d') {
    from.setDate(today.getDate() - 29);
  } else if (evolutionRange === 'custom' && evolutionFrom && evolutionTo) {
    const start = new Date(`${evolutionFrom}T00:00:00`);
    const end = new Date(`${evolutionTo}T00:00:00`);
    from = start;
    to.setTime(end.getTime());
  } else {
    from.setDate(today.getDate() - 29);
  }

  return { from, to };
}

function buildEvolutionSeries(atrasos) {
  const { from, to } = getEvolutionWindow();
  const all = (atrasos || loadAtrasos()).filter(a => {
    const date = new Date(`${a.fecha}T00:00:00`);
    return date >= from && date <= to;
  });

  const normalize = (date) => date.toISOString().slice(0, 10);

  if (evolutionView === 'weekly') {
    const buckets = {};
    const start = new Date(from);
    while (start <= to) {
      const weekKey = `Sem ${Math.ceil((start.getDate() + 6 - start.getDay()) / 7)}`;
      buckets[weekKey] = 0;
      start.setDate(start.getDate() + 7);
    }
    all.forEach(item => {
      const d = new Date(`${item.fecha}T00:00:00`);
      const weekKey = `Sem ${Math.ceil((d.getDate() + 6 - d.getDay()) / 7)}`;
      buckets[weekKey] = (buckets[weekKey] || 0) + 1;
    });
    const labels = Object.keys(buckets);
    return { labels, data: labels.map(label => buckets[label] || 0) };
  }

  if (evolutionView === 'monthly') {
    const buckets = {};
    const start = new Date(from);
    while (start <= to) {
      const monthKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
      buckets[monthKey] = 0;
      start.setMonth(start.getMonth() + 1);
    }
    all.forEach(item => {
      const d = new Date(`${item.fecha}T00:00:00`);
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      buckets[monthKey] = (buckets[monthKey] || 0) + 1;
    });
    const labels = Object.keys(buckets);
    return { labels, data: labels.map(label => buckets[label] || 0) };
  }

  const labels = [];
  const data = [];
  const cursor = new Date(from);
  while (cursor <= to) {
    const day = normalize(cursor);
    labels.push(formatFechaCorta(day));
    data.push(all.filter(a => a.fecha === day).length);
    cursor.setDate(cursor.getDate() + 1);
  }
  return { labels, data };
}

function renderDashboard() {
  const allAtrasos = loadAtrasos();
  const allStudents = loadStudents();
  const { students, atrasos } = filterByNivel(allStudents, allAtrasos);
  const todayStr = today();

  const hoy     = atrasos.filter(a => a.fecha === todayStr);
  const semana  = atrasos.filter(a => a.fecha >= dateOffset(6));
  const justHoy = hoy.filter(a => a.justificado).length;

  document.getElementById('stat-hoy').textContent = hoy.length;
  document.getElementById('stat-hoy-sub').textContent =
    `${justHoy} justificados, ${hoy.length - justHoy} sin justificar`;
  document.getElementById('stat-semana').textContent     = semana.length;
  document.getElementById('stat-fecha').textContent      = formatDate(todayStr);
  document.getElementById('stat-estudiantes').textContent = students.length;

  const last30 = atrasos.filter(a => a.fecha >= dateOffset(29));
  const byDay  = {};
  last30.forEach(a => { byDay[a.fecha] = (byDay[a.fecha] || 0) + 1; });
  const days = Object.keys(byDay).length;
  const prom = days ? (last30.length / days).toFixed(1) : 0;
  document.getElementById('stat-promedio').textContent = prom;

  // Today list
  const listEl = document.getElementById('list-hoy');
  if (hoy.length === 0) {
    listEl.innerHTML = '<div class="empty-state" style="padding:1.5rem">Sin atrasos hoy.</div>';
  } else {
    listEl.innerHTML = hoy
      .sort((a, b) => b.hora.localeCompare(a.hora) || b.id - a.id)
      .map(a => {
        const st = getStudent(a.studentId);
        const badge = a.justificado
          ? '<span class="badge badge-green">Justificado</span>'
          : '<span class="badge badge-amber">Sin Justificar</span>';
        return `<div class="today-item">
          <div class="today-info">
            <strong>${st ? esc(st.nombre) : '—'}</strong>
            <span>${st ? esc(st.curso) : ''} &bull; ${formatDate(a.fecha)} &bull; ${esc(a.hora)}</span>
          </div>
          ${badge}
        </div>`;
      }).join('');
  }

  // ── Top 15 table ──
  const totals = {};
  atrasos.forEach(a => { totals[a.studentId] = (totals[a.studentId] || 0) + 1; });

  const top = Object.entries(totals)
    .map(([id, n]) => ({ student: students.find(s => s.id === parseInt(id)), n }))
    .filter(x => x.student)
    .sort((a, b) => b.n - a.n)
    .slice(0, 15);

  const tbody15 = document.getElementById('tbody-top15');
  const empty15 = document.getElementById('top15-empty');

  if (top.length === 0) {
    tbody15.innerHTML = '';
    empty15.classList.remove('hidden');
  } else {
    empty15.classList.add('hidden');
    tbody15.innerHTML = top.map((x, i) => {
      const lastA = atrasos
        .filter(a => a.studentId === x.student.id)
        .sort((a, b) => b.fecha.localeCompare(a.fecha))[0];
      const rankBadge =
        i === 0 ? '<span class="badge badge-rank-1">1°</span>' :
        i === 1 ? '<span class="badge badge-rank-2">2°</span>' :
        i === 2 ? '<span class="badge badge-rank-3">3°</span>' :
        `<span style="color:var(--text-muted);font-size:.8rem">${i + 1}°</span>`;
      return `<tr>
        <td data-label="#">${rankBadge}</td>
        <td data-label="Estudiante"><strong>${esc(x.student.nombre)}</strong></td>
        <td data-label="Curso">${esc(x.student.curso)}</td>
        <td data-label="Total Atrasos"><span class="badge badge-blue">${x.n}</span></td>
        <td data-label="Último Atraso">${lastA ? formatDate(lastA.fecha) : '—'}</td>
      </tr>`;
    }).join('');
  }

  // ── Atrasos por curso — histórico fijo por curso (independiente del filtro de evolución) ──
  const byCurso = {};
  atrasos.forEach(a => {
    const st = students.find(s => s.id === a.studentId);
    if (st && st.curso) byCurso[st.curso] = (byCurso[st.curso] || 0) + 1;
  });

  const allCourseNames = getAvailableCourseNames();

  // Cursos del nivel seleccionado; en "Todo" se muestran todos los cursos.
  let courseNames = allCourseNames;
  if (dashboardNivel !== 'todo') {
    courseNames = allCourseNames.filter(c => getCursoNivel(c) === dashboardNivel);
  }

  courseNames.forEach(c => {
    if (!(c in byCurso)) byCurso[c] = 0;
  });

  const cursoEntries = sortCursos(courseNames).map(c => [c, byCurso[c] || 0]);
  const cursoLabels = cursoEntries.map(e => e[0]);
  const cursoData   = cursoEntries.map(e => e[1]);

  const ctx2 = document.getElementById('chart-reportes-curso').getContext('2d');
  if (chartCurso) chartCurso.destroy();
  const cursoChartHeight = Math.max(320, cursoLabels.length * 34);
  const cursoWrap = ctx2.canvas.parentElement;
  if (cursoWrap) cursoWrap.style.height = `${cursoChartHeight}px`;
  chartCurso = new Chart(ctx2, {
    type: 'bar',
    data: {
      labels: cursoLabels,
      datasets: [{
        label: 'Atrasos',
        data: cursoData,
        backgroundColor: cursoData.map(v =>
          v === 0 ? '#E8E2DB' : '#2A4A7E'
        ),
        borderColor: cursoData.map(v =>
          v === 0 ? '#d9d3c8' : '#1D3A6B'
        ),
        borderWidth: 1,
        borderRadius: 3,
        borderSkipped: false,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: context => `${context.parsed.x} atraso${context.parsed.x === 1 ? '' : 's'}`,
          },
        },
        datalabels: {
          display: true,
          anchor: 'end',
          align: 'end',
          color: (ctx) => ctx.dataset.data[ctx.dataIndex] === 0 ? '#547792' : '#2A4A7E',
          font: { weight: 'bold', size: 11 },
          formatter: (value) => value === 0 ? '0' : value,
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: { stepSize: 1, font: { size: 11 } },
          grid: { color: '#f1f5f9' },
        },
        y: {
          ticks: { font: { size: 11 }, color: '#547792' },
          grid: { display: false },
        },
      },
      layout: { padding: { right: 35 } },
    },
  });

const evolution = buildEvolutionSeries(atrasos);
  const ctx = document.getElementById('chart-evolucion').getContext('2d');
  if (chartEvolucion) chartEvolucion.destroy();
  chartEvolucion = new Chart(ctx, {
    type: 'line',
    data: {
      labels: evolution.labels,
      datasets: [{
        label: 'Atrasos por día',
        data: evolution.data,
        borderColor: '#2A4A7E',
        backgroundColor: 'rgba(42,74,126,.25)',
        tension: 0.3,
        fill: true,
        borderWidth: 2.5,
        pointRadius: 4,
        pointBackgroundColor: '#2A4A7E',
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        datalabels: { display: false },
        tooltip: {
          callbacks: {
            label: context => `${context.parsed.y} atraso${context.parsed.y === 1 ? '' : 's'}`,
          },
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 8, font: { size: 11 } }, grid: { color: '#f1f5f9' } },
        y: { beginAtZero: true, ticks: { stepSize: 1, font: { size: 11 } }, grid: { color: '#f1f5f9' } },
      },
    },
  });
}

// ─── REGISTRAR ATRASO ───────────────────────────────────────
let selectedStudentId = null;

// Default date/time
document.getElementById('input-fecha').value = today();
document.getElementById('input-hora').value  = ecuadorNow().hora;

// Populate curso dropdown from both stored students and the full course list
function populateCursosDropdown() {
  const merged = sortCursos(getAvailableCourseNames());

  const sel = document.getElementById('reg-curso');
  sel.innerHTML = '<option value="">— Seleccione un curso —</option>' +
    merged.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

  // Reset student dropdown
  const selEst = document.getElementById('reg-estudiante');
  selEst.innerHTML = '<option value="">— Primero seleccione un curso —</option>';
  selEst.disabled = true;
  selectedStudentId = null;
}

document.getElementById('reg-curso').addEventListener('change', function () {
  const curso = this.value;
  const selEst = document.getElementById('reg-estudiante');
  selectedStudentId = null;

  if (!curso) {
    selEst.innerHTML = '<option value="">— Primero seleccione un curso —</option>';
    selEst.disabled = true;
    return;
  }

  const estudiantes = loadStudents()
    .filter(s => courseMatches(s.curso, curso))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  selEst.disabled = false;

  if (estudiantes.length === 0) {
    selEst.innerHTML = '<option value="">Sin estudiantes en este curso</option>';
    return;
  }

  selEst.innerHTML = '<option value="">— Seleccione un estudiante —</option>' +
    estudiantes.map(s => `<option value="${esc(s.id)}">${esc(s.nombre)}</option>`).join('');
});

document.getElementById('reg-estudiante').addEventListener('change', function () {
  selectedStudentId = this.value ? parseInt(this.value) : null;
});

// Justificado toggle
document.getElementById('input-justificado').addEventListener('change', function () {
  document.getElementById('motivo-group').style.display = this.checked ? 'block' : 'none';
});

// Submit
document.getElementById('form-atraso').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedStudentId) { showToast('Seleccione un estudiante.', 'error'); return; }

  const fecha       = document.getElementById('input-fecha').value;
  const hora        = document.getElementById('input-hora').value;
  const justificado = document.getElementById('input-justificado').checked;
  const motivo      = document.getElementById('input-motivo').value.trim();

  if (!fecha || !hora) { showToast('Complete fecha y hora.', 'error'); return; }
  if (!isSupabaseEnabled() || !usingSupabaseData) {
    showToast('No hay conexión con Supabase. El atraso no fue guardado.', 'error');
    return;
  }

  const submitButton = e.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = 'Guardando...';

  try {
    const { data, error } = await supabase
      .from('atrasos')
      .insert({ estudiante_id: selectedStudentId, fecha, hora, justificado, motivo })
      .select('id, estudiante_id, fecha, hora, justificado, motivo, registrado_por')
      .single();

    if (error) throw error;

    const atrasos = loadAtrasos();
    atrasos.push({
      id: data.id,
      studentId: data.estudiante_id,
      fecha: data.fecha,
      hora: data.hora,
      justificado: data.justificado,
      motivo: data.motivo || '',
      registradoPor: data.registrado_por || (currentAuthUser ? currentAuthUser.email : ''),
    });
    saveAtrasos(atrasos);

    const st = getStudent(selectedStudentId);
    showToast(`Atraso registrado para ${st ? st.nombre : 'el estudiante'}`);
    resetFormAtraso();
    renderDashboard();
  } catch (error) {
    console.error('No se pudo guardar el atraso en Supabase.', error);
    showToast(`No se pudo guardar en Supabase: ${error.message || 'revise los permisos'}`, 'error');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Registrar Atraso';
  }
});

document.getElementById('btn-cancelar-atraso').addEventListener('click', resetFormAtraso);

function resetFormAtraso() {
  populateCursosDropdown();
  document.getElementById('input-fecha').value = today();
  document.getElementById('input-hora').value  = ecuadorNow().hora;
  document.getElementById('input-justificado').checked = false;
  document.getElementById('input-motivo').value = '';
  document.getElementById('motivo-group').style.display = 'none';
}

// ─── HISTORICO ──────────────────────────────────────────────
const HIST_PAGE_SIZE = 100;
let histPage = 1;

function renderHistorico() {
  const search = document.getElementById('filter-search').value.toLowerCase();
  const fecha  = document.getElementById('filter-fecha').value;
  const curso  = document.getElementById('filter-curso').value;
  const por    = document.getElementById('filter-por').value;

  // Populate curso filter
  const cursos = sortCursos(getAvailableCourseNames().filter(Boolean));
  const fc       = document.getElementById('filter-curso');
  const prevC    = fc.value;
  fc.innerHTML   = '<option value="">Todos los cursos</option>' +
    cursos.map(c => `<option value="${esc(c)}" ${prevC === c ? 'selected' : ''}>${esc(c)}</option>`).join('');

  // Populate "registrado por" filter
  const atrasosAll = loadAtrasos();
  const registrantes = [...new Set(atrasosAll.map(a => a.registradoPor).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const fp       = document.getElementById('filter-por');
  const prevP    = fp.value;
  fp.innerHTML   = '<option value="">Todos los que registraron</option>' +
    registrantes.map(email => `<option value="${esc(email)}" ${prevP === email ? 'selected' : ''}>${esc(email)}</option>`).join('');

  const students  = loadStudents();
  const enriched  = loadAtrasos()
    .map(a => ({ ...a, student: students.find(s => s.id === a.studentId) }))
    .filter(a => {
      if (!a.student) return false;
      if (search && !a.student.nombre.toLowerCase().includes(search)) return false;
      if (fecha && a.fecha !== fecha) return false;
      if (curso && !courseMatches(a.student.curso, curso)) return false;
      if (por && a.registradoPor !== por) return false;
      return true;
    })
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || b.hora.localeCompare(a.hora));

  const tbody = document.getElementById('tbody-historico');
  const empty = document.getElementById('historico-empty');
  const paginationEl = document.getElementById('historico-pagination');

  if (paginationEl) paginationEl.classList.add('hidden');

  if (enriched.length === 0) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  // Paginado: solo se renderiza la página actual.
  const totalPages = Math.ceil(enriched.length / HIST_PAGE_SIZE);
  if (histPage > totalPages) histPage = totalPages;
  if (histPage < 1) histPage = 1;
  const pageStart = (histPage - 1) * HIST_PAGE_SIZE;
  const pageRows  = enriched.slice(pageStart, pageStart + HIST_PAGE_SIZE);

  tbody.innerHTML = pageRows.map(a => {
    const badge = a.justificado
      ? '<span class="badge badge-green">Justificado</span>'
      : '<span class="badge badge-amber">Sin Justificar</span>';
    const idLiteral = typeof a.id === 'number' ? a.id : `'${escJsArg(a.id)}'`;
    const editBtn = `<button class="btn btn-icon btn-icon-edit" onclick="editAtraso(${idLiteral})" title="Editar / justificar">✏️</button>`;
    const deleteBtn = `<button class="btn btn-icon" onclick="confirmDeleteAtraso(${idLiteral})" title="Eliminar atraso">Eliminar</button>`;
    const actions = canRegister()
      ? `${editBtn}${isAdmin() ? deleteBtn : ''}`
      : '—';
    return `<tr>
      <td data-label="Estudiante"><strong>${esc(a.student.nombre)}</strong></td>
      <td data-label="Curso">${esc(a.student.curso)}</td>
      <td data-label="Fecha">${formatDate(a.fecha)}</td>
      <td data-label="Hora">${esc(a.hora)}</td>
      <td data-label="Estado">${badge}</td>
      <td data-label="Motivo">${esc(a.motivo) || '—'}</td>
      <td data-label="Registrado por">${esc(a.registradoPor) || '—'}</td>
      <td data-label="Acción">${actions}</td>
    </tr>`;
  }).join('');

  renderHistPagination(enriched.length, histPage);
}

function renderHistPagination(totalRows, page) {
  const el = document.getElementById('historico-pagination');
  if (!el) return;
  const totalPages = Math.max(1, Math.ceil(totalRows / HIST_PAGE_SIZE));
  if (totalRows === 0 || totalPages <= 1) {
    el.innerHTML = '';
    el.classList.add('hidden');
    return;
  }

  const first = (page - 1) * HIST_PAGE_SIZE + 1;
  const last  = Math.min(page * HIST_PAGE_SIZE, totalRows);

  const pages = [];
  const fromPage = Math.max(1, page - 2);
  const toPage   = Math.min(totalPages, page + 2);
  if (fromPage > 1) {
    if (fromPage > 2) pages.push('…');
    pages.push(1);
  }
  for (let i = fromPage; i <= toPage; i++) pages.push(i);
  if (toPage < totalPages) {
    pages.push('…');
    pages.push(totalPages);
  }

  const btn = (label, target, primary) =>
    `<button class="btn pagination-btn${primary ? ' pagination-current' : ''}" onclick="goHistPage(${target})">${label}</button>`;
  const disabledBtn = (label) =>
    `<button class="btn pagination-btn" disabled>${label}</button>`;

  const parts = [
    `<span class="pagination-info">Mostrando ${first}–${last} de ${totalRows}</span>`,
    page <= 1 ? disabledBtn('‹ Anterior') : btn('‹ Anterior', page - 1),
    pages.map(p =>
      p === '…'
        ? '<span class="pagination-ellipsis">…</span>'
        : btn(p, p, p === page)
    ).join(''),
    page >= totalPages ? disabledBtn('Siguiente ›') : btn('Siguiente ›', page + 1),
  ];

  el.innerHTML = parts.join('');
  el.classList.remove('hidden');
}

window.goHistPage = function (n) {
  histPage = n;
  renderHistorico();
};

['filter-search', 'filter-fecha', 'filter-curso', 'filter-por'].forEach(id =>
  document.getElementById(id).addEventListener('input', () => {
    histPage = 1;
    renderHistorico();
  }));

document.getElementById('btn-limpiar-filtros').addEventListener('click', () => {
  document.getElementById('filter-search').value = '';
  document.getElementById('filter-fecha').value  = '';
  document.getElementById('filter-curso').value  = '';
  document.getElementById('filter-por').value    = '';
  histPage = 1;
  renderHistorico();
});

// ─── ESTUDIANTES ────────────────────────────────────────────
let editingStudentId = null;
let estFormMode = 'individual'; // 'individual' | 'batch'

function refreshCursosDatalist() {
  const dl = document.getElementById('cursos-list');
  if (!dl) return;
  const names = getAvailableCourseNames().filter(Boolean);
  dl.innerHTML = names.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
}

// Autodetección del nivel cuando el nombre coincide con el padrón de cada nivel.
function autoDetectNivel(nombre) {
  const n = String(nombre || '').trim();
  if (CURSOS_ORDENADOS_ESCUELA.indexOf(n) !== -1) return 'escuela';
  if (CURSOS_ORDENADOS_COLEGIO.indexOf(n) !== -1) return 'colegio';
  return null;
}

function updateNivelFromCourse(nombre, selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const detected = autoDetectNivel(nombre);
  if (detected) sel.value = detected;
}

document.getElementById('est-curso').addEventListener('input', function () {
  updateNivelFromCourse(this.value, 'est-nivel');
});
document.getElementById('est-batch-curso').addEventListener('input', function () {
  updateNivelFromCourse(this.value, 'est-batch-nivel');
});

function renderEstudiantes() {
  refreshCursosDatalist();
  const search = document.getElementById('est-search').value.toLowerCase();
  const curso  = document.getElementById('est-filter-curso').value;

  const cursos = sortCursos(getAvailableCourseNames().filter(Boolean));
  const fc = document.getElementById('est-filter-curso');
  const prevC = fc.value;
  fc.innerHTML = '<option value="">Todos los cursos</option>' +
    cursos.map(c => `<option value="${esc(c)}" ${prevC === c ? 'selected' : ''}>${esc(c)}</option>`).join('');

  const students = loadStudents().filter(s => {
    if (search && !s.nombre.toLowerCase().includes(search)) return false;
    if (curso && !courseMatches(s.curso, curso)) return false;
    return true;
  }).sort((a, b) => a.nombre.localeCompare(b.nombre));

  const tbody = document.getElementById('tbody-estudiantes');
  const empty = document.getElementById('estudiantes-empty');

  if (students.length === 0) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const atrasos = loadAtrasos();
  tbody.innerHTML = students.map(s => {
    const total = atrasos.filter(a => a.studentId === s.id).length;
    const actions = isAdmin()
      ? `<button class="btn btn-icon btn-icon-edit" onclick="editStudent('${escJsArg(s.id)}')" title="Editar">✏️</button>
         <button class="btn btn-icon" onclick="confirmDeleteStudent('${escJsArg(s.id)}')" title="Eliminar">🗑️</button>`
      : '—';
    return `<tr>
      <td data-label="Nombre"><strong>${esc(s.nombre)}</strong></td>
      <td data-label="Curso">${esc(s.curso)}</td>
      <td data-label="Email">${esc(s.email) || '—'}</td>
      <td data-label="Total Atrasos"><span class="badge badge-blue">${total}</span></td>
      <td data-label="Acción" style="display:flex;gap:.4rem;justify-content:flex-end">${actions}</td>
    </tr>`;
  }).join('');

  renderCursos();
}

function renderCursos() {
  const tbody = document.getElementById('cursos-list-body');
  const empty = document.getElementById('cursos-empty');
  if (!tbody) return;

  const students = loadStudents();
  const names = sortCursos(getAvailableCourseNames().filter(Boolean));

  if (names.length === 0) {
    tbody.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  tbody.innerHTML = names.map(c => {
    const count = students.filter(s => s.curso === c).length;
    const isEscuela = getCursoNivel(c) === 'escuela';
    const nivelBadge = isEscuela
      ? '<span class="badge badge-nivel-escuela">Escuela</span>'
      : '<span class="badge badge-nivel-colegio">Colegio</span>';
    const actions = isAdmin()
      ? `<div class="cursos-actions">
          <button class="btn btn-icon" data-curso="${encodeURIComponent(c)}" onclick="openRenameCurso(this)" title="Renombrar curso">✏️</button>
          <button class="btn btn-icon" data-curso="${encodeURIComponent(c)}" onclick="confirmDeleteCurso(this)" title="Eliminar curso">🗑️</button>
        </div>`
      : '';
    return `<div class="cursos-row">
      <span class="cursos-nombre" title="${esc(c)}">${esc(c)}</span>
      ${nivelBadge}
      <span class="badge badge-blue cursos-count">${count}</span>
      ${actions}
    </div>`;
  }).join('');
}

['est-search', 'est-filter-curso'].forEach(id =>
  document.getElementById(id).addEventListener('input', renderEstudiantes));

// ── Toggle Individual / Lote ─────────────────────────────────
function setEstFormMode(mode) {
  estFormMode = mode === 'batch' ? 'batch' : 'individual';
  document.querySelectorAll('#est-mode-toggle .btn-mode').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === estFormMode));
  document.getElementById('fields-individual').style.display = estFormMode === 'individual' ? '' : 'none';
  document.getElementById('fields-batch').style.display = estFormMode === 'batch' ? '' : 'none';

  const individualRequired = estFormMode === 'individual';
  document.getElementById('est-nombre').required = individualRequired;
  document.getElementById('est-curso').required = individualRequired;
  document.getElementById('est-batch-curso').required = !individualRequired;
  document.getElementById('est-batch-nombres').required = !individualRequired;

  if (estFormMode === 'batch' && !editingStudentId) {
    document.getElementById('form-estudiante-title').textContent = 'Curso Completo';
    document.getElementById('btn-guardar-estudiante').textContent = 'Crear curso';
  } else {
    document.getElementById('form-estudiante-title').textContent = editingStudentId ? 'Editar Estudiante' : 'Nuevo Estudiante';
    document.getElementById('btn-guardar-estudiante').textContent = editingStudentId ? 'Actualizar' : 'Guardar';
  }
}

document.getElementById('est-mode-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-mode');
  if (!btn || btn.classList.contains('active')) return;
  setEstFormMode(btn.dataset.mode);
});

// Contador de líneas del textarea batch
document.getElementById('est-batch-nombres').addEventListener('input', (e) => {
  const lines = e.target.value.split('\n').map(l => l.trim()).filter(Boolean);
  document.getElementById('est-batch-count').textContent = `${lines.length} estudiante${lines.length !== 1 ? 's' : ''} detectado${lines.length !== 1 ? 's' : ''}`;
});

// ── Nuevo Estudiante (botón principal) ───────────────────────
document.getElementById('btn-nuevo-estudiante').addEventListener('click', () => {
  editingStudentId = null;
  document.getElementById('form-estudiante').reset();
  document.getElementById('est-id').value = '';
  setEstFormMode('individual');
  document.getElementById('est-mode-toggle').style.display = '';
  document.getElementById('est-batch-count').textContent = '';
  document.getElementById('form-estudiante-card').style.display = 'block';
  document.getElementById('form-estudiante-card').scrollIntoView({ behavior: 'smooth' });
});

document.getElementById('btn-cancelar-estudiante').addEventListener('click', () => {
  document.getElementById('form-estudiante-card').style.display = 'none';
  editingStudentId = null;
});

// ── Editar estudiante ────────────────────────────────────────
window.editStudent = function (id) {
  const s = loadStudents().find(x => String(x.id) === String(id));
  if (!s) return;
  editingStudentId = id;
  document.getElementById('est-id').value = id;
  document.getElementById('est-nombre').value = s.nombre;
  document.getElementById('est-curso').value = s.curso;
  document.getElementById('est-email').value = s.email || '';
  const estNivelSel = document.getElementById('est-nivel');
  if (estNivelSel) estNivelSel.value = getCursoNivel(s.curso);
  setEstFormMode('individual');
  document.getElementById('est-mode-toggle').style.display = 'none';
  document.getElementById('form-estudiante-card').style.display = 'block';
  document.getElementById('form-estudiante-card').scrollIntoView({ behavior: 'smooth' });
};

// ── Submit del formulario ────────────────────────────────────
document.getElementById('form-estudiante').addEventListener('submit', async (e) => {
  e.preventDefault();

  if (estFormMode === 'batch') return handleBatchSubmit();
  return handleIndividualSubmit();
});

async function handleIndividualSubmit() {
  const nombre = document.getElementById('est-nombre').value.trim();
  const curso  = document.getElementById('est-curso').value.trim();
  const email  = document.getElementById('est-email').value.trim();
  const nivel  = document.getElementById('est-nivel') ? document.getElementById('est-nivel').value : getCursoNivel(curso);
  if (!nombre || !curso) { showToast('Complete los campos obligatorios.', 'error'); return; }

  if (isSupabaseEnabled() && usingSupabaseData) {
    try {
      const payload = editingStudentId
        ? { action: 'update', id: editingStudentId, nombre, curso, email, nivel }
        : { action: 'create', nombre, curso, email, nivel };
      const result = await callEdgeFunction('manage-students', payload);
      if (result.error) { showToast(result.error, 'error'); return; }
      saveStudents(result.students || []);
      saveCourses(result.cursos || []);
      refreshCursosDatalist();
      showToast(editingStudentId ? 'Estudiante actualizado.' : 'Estudiante agregado.');
    } catch (err) {
      showToast(err.message || 'Error al guardar estudiante.', 'error');
      return;
    }
  } else {
    const students = loadStudents();
    const existing = students.find(s => s.nombre === nombre && s.curso === curso && s.id !== editingStudentId);
    if (existing) { showToast('Ya existe un estudiante con ese nombre en este curso.', 'error'); return; }
    if (editingStudentId) {
      const idx = students.findIndex(s => s.id === editingStudentId);
      if (idx >= 0) students[idx] = { ...students[idx], nombre, curso, email };
      saveStudents(students);
      showToast('Estudiante actualizado.');
    } else {
      students.push({ id: nextId(LS_SEQ_S), nombre, curso, email });
      saveStudents(students);
      showToast('Estudiante agregado.');
    }
  }

  document.getElementById('form-estudiante-card').style.display = 'none';
  editingStudentId = null;
  renderEstudiantes();
  renderDashboard();
}

async function handleBatchSubmit() {
  const curso = document.getElementById('est-batch-curso').value.trim();
  const nivel = document.getElementById('est-batch-nivel') ? document.getElementById('est-batch-nivel').value : getCursoNivel(curso);
  const raw = document.getElementById('est-batch-nombres').value;
  if (!curso) { showToast('Ingrese el nombre del curso.', 'error'); return; }

  const names = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (names.length === 0) { showToast('Ingrese al menos un nombre.', 'error'); return; }

  // Vista previa antes de crear
  const uniqueNames = [...new Set(names)];
  const dupCount = names.length - uniqueNames.length;
  let msg = `Se creará el curso "${curso}" con ${uniqueNames.length} estudiante${uniqueNames.length !== 1 ? 's' : ''}.`;
  if (dupCount > 0) msg += `\n\n${dupCount} nombre${dupCount !== 1 ? 's' : ''} duplicado${dupCount !== 1 ? 's' : ''} se omitirá${dupCount !== 1 ? 'n' : ''}.`;
  msg += '\n\n¿Continuar?';

  openModal('Crear curso completo', msg, async () => {
    if (isSupabaseEnabled() && usingSupabaseData) {
      try {
        const result = await callEdgeFunction('manage-students', {
          action: 'create-course',
          curso,
          nivel,
          estudiantes: names,
        });
        if (result.error) { showToast(result.error, 'error'); return; }
        saveStudents(result.students || []);
        saveCourses(result.cursos || []);
        refreshCursosDatalist();
        const parts = [`Curso "${curso}" creado.`];
        if (result.created > 0) parts.push(`${result.created} estudiante${result.created !== 1 ? 's' : ''} creado${result.created !== 1 ? 's' : ''}.`);
        if (result.skipped > 0) parts.push(`${result.skipped} saltado${result.skipped !== 1 ? 's' : ''}.`);
        if (result.errors?.length) parts.push(`Detalles: ${result.errors.join('; ')}`);
        showToast(parts.join(' '), result.errors?.length ? 'warning' : 'success');
      } catch (err) {
        showToast(err.message || 'Error al crear el curso.', 'error');
        return;
      }
    } else {
      const students = loadStudents();
      const existingCourses = loadCourses();
      let cursoEntry = existingCourses.find(c => c.nombre === curso);
      if (!cursoEntry) {
        cursoEntry = { id: nextId('ca_seq_c'), nombre: curso, nivel };
        existingCourses.push(cursoEntry);
        saveCourses(existingCourses);
      }
      const seen = new Set();
      let created = 0;
      for (const name of uniqueNames) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const dup = students.find(s => s.nombre === name && s.curso === curso);
        if (dup) continue;
        students.push({ id: nextId(LS_SEQ_S), nombre: name, curso, email: '' });
        created++;
      }
      saveStudents(students);
      refreshCursosDatalist();
      showToast(`Curso "${curso}" creado con ${created} estudiante${created !== 1 ? 's' : ''}.`);
    }

    document.getElementById('form-estudiante-card').style.display = 'none';
    editingStudentId = null;
    renderEstudiantes();
    renderDashboard();
  }, 'Crear curso');
}

// ── Eliminar estudiante ──────────────────────────────────────
window.confirmDeleteStudent = function (id) {
  const st = loadStudents().find(s => String(s.id) === String(id));
  const name = st ? st.nombre : 'este estudiante';
  openModal('Eliminar estudiante',
    `¿Eliminar a ${name}? También se eliminarán sus atrasos.`,
    async () => {
      try {
        if (isSupabaseEnabled() && usingSupabaseData) {
          const result = await callEdgeFunction('manage-students', { action: 'delete', id });
          if (result.error) { showToast(result.error, 'error'); return; }
          saveStudents(result.students || []);
          saveCourses(result.cursos || []);
        } else {
          saveStudents(loadStudents().filter(s => String(s.id) !== String(id)));
          saveAtrasos(loadAtrasos().filter(a => String(a.studentId) !== String(id)));
        }
        showToast('Estudiante eliminado.');
        renderEstudiantes();
        renderDashboard();
      } catch (err) {
        showToast(err.message || 'Error al eliminar estudiante.', 'error');
      }
    });
};

// ── Eliminar curso ───────────────────────────────────────────
window.confirmDeleteCurso = function (el) {
  const name = decodeURIComponent(el.dataset.curso || '');
  const entry = loadCourses().find(c => c.nombre === name);
  const id = entry ? entry.id : name;
  const count = loadStudents().filter(s => s.curso === name).length;

  openModal('Eliminar curso',
    `¿Eliminar el curso "${name}"` +
    (count > 0 ? ` junto a ${count} estudiante${count !== 1 ? 's' : ''}` : '') +
    ` y sus atrasos? Esta acción no se puede deshacer.`,
    async () => {
      const students = loadStudents();
      const removedIds = new Set(students.filter(s => s.curso === name).map(s => String(s.id)));
      try {
        if (isSupabaseEnabled() && usingSupabaseData) {
          const result = await callEdgeFunction('manage-students', { action: 'delete-course', id });
          if (result.error) { showToast(result.error, 'error'); return; }
          saveStudents(result.students || []);
          saveCourses(result.cursos || []);
        } else {
          saveStudents(students.filter(s => s.curso !== name));
          saveCourses(loadCourses().filter(c => String(c.id) !== String(id)));
        }
        saveAtrasos(loadAtrasos().filter(a => !removedIds.has(String(a.studentId))));
        refreshCursosDatalist();
        showToast(`Curso "${name}" eliminado.`);
        renderEstudiantes();
        renderDashboard();
      } catch (err) {
        showToast(err.message || 'Error al eliminar el curso.', 'error');
      }
    });
};

// ── Renombrar curso ──────────────────────────────────────────
let pendingRenameCurso = null;

window.openRenameCurso = function (el) {
  const name = decodeURIComponent(el.dataset.curso || '');
  const entry = loadCourses().find(c => c.nombre === name);
  pendingRenameCurso = { name, id: entry ? entry.id : name };
  document.getElementById('rename-curso-input').value = name;
  document.getElementById('rename-modal-overlay').classList.remove('hidden');
  document.getElementById('rename-curso-input').focus();
  document.getElementById('rename-curso-input').select();
};

function closeRenameModal() {
  document.getElementById('rename-modal-overlay').classList.add('hidden');
  pendingRenameCurso = null;
}

document.getElementById('rename-modal-cancel').addEventListener('click', closeRenameModal);
document.getElementById('rename-modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('rename-modal-overlay')) closeRenameModal();
});
document.getElementById('rename-curso-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('rename-modal-confirm').click();
  }
});

document.getElementById('rename-modal-confirm').addEventListener('click', async () => {
  if (!pendingRenameCurso) return;
  const { name: oldName, id } = pendingRenameCurso;
  const nuevo = document.getElementById('rename-curso-input').value.trim();
  closeRenameModal();

  if (!nuevo) { showToast('Ingrese el nuevo nombre del curso.', 'error'); return; }
  if (nuevo.toLowerCase() === oldName.toLowerCase()) return;

  if (isSupabaseEnabled() && usingSupabaseData) {
    try {
      const result = await callEdgeFunction('manage-students', { action: 'rename-course', id, nuevoNombre: nuevo });
      if (result.error) { showToast(result.error, 'error'); return; }
      saveStudents(result.students || []);
      saveCourses(result.cursos || []);
      showToast(`Curso renombrado a "${nuevo}".`);
    } catch (err) {
      showToast(err.message || 'Error al renombrar el curso.', 'error');
      return;
    }
  } else {
    const courses = loadCourses();
    const dup = courses.some(c => c.nombre.toLowerCase() === nuevo.toLowerCase() && String(c.id) !== String(id));
    if (dup) { showToast(`Ya existe un curso llamado "${nuevo}".`, 'error'); return; }
    const target = courses.find(c => String(c.id) === String(id));
    if (target) target.nombre = nuevo;
    saveCourses(courses);
    saveStudents(loadStudents().map(s => s.curso === oldName ? { ...s, curso: nuevo } : s));
    showToast(`Curso renombrado a "${nuevo}".`);
  }

  renderCursos();
  renderEstudiantes();
  renderDashboard();
});

// ─── USUARIOS ───────────────────────────────────────────────
function supabaseFunctionUrl(name) {
  return `${normalizedSupabaseUrl}/functions/v1/${name}`;
}

async function callEdgeFunction(name, payload) {
  if (!isSupabaseEnabled() || !currentAuthUser) {
    throw new Error('Debe iniciar sesión para realizar esta acción.');
  }
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token || '';
  const response = await fetch(supabaseFunctionUrl(name), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload || {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Error en ${name}`);
  return body;
}

async function renderUsuarios() {
  const tbody = document.getElementById('tbody-usuarios');
  const empty = document.getElementById('usuarios-empty');
  tbody.innerHTML = '';

  let users = [];
  try {
    const result = await callEdgeFunction('list-users', {});
    users = result.users || [];
  } catch (error) {
    console.warn('No se pudo listar usuarios.', error);
    empty.classList.remove('hidden');
    empty.textContent = `No se pudo cargar la lista: ${error.message}`;
    return;
  }

  const atrasos = loadAtrasos();
  const countBy = {};
  atrasos.forEach(a => {
    if (a.registradoPor) countBy[a.registradoPor] = (countBy[a.registradoPor] || 0) + 1;
  });

  if (users.length === 0) {
    empty.classList.remove('hidden');
    empty.textContent = 'Sin usuarios creados todavía.';
    return;
  }
  empty.classList.add('hidden');

  tbody.innerHTML = users.map(u => {
    const rol = (u.rol || '').toLowerCase() === 'admin' ? 'Administrador' : 'Registrador';
    const total = countBy[u.email] || 0;
    const creado = u.created_at ? formatDate(u.created_at.slice(0, 10)) : '—';
    const propio = currentAuthUser && (currentAuthUser.email || '').toLowerCase() === String(u.email || '').toLowerCase();
    const emailLiteral = escJsArg(u.email);
    const acciones = propio
      ? '<button class="btn btn-icon" disabled title="No puede eliminar su propia cuenta">Eliminar</button>'
      : `<button class="btn btn-icon" onclick="confirmDeleteUsuario('${escJsArg(u.id)}', '${emailLiteral}')">Eliminar</button>`;
    return `<tr>
      <td data-label="Correo"><strong>${esc(u.email)}</strong></td>
      <td data-label="Nombre">${esc(u.nombre) || '—'}</td>
      <td data-label="Rol">${rol}</td>
      <td data-label="Atrasos registrados"><span class="badge badge-blue">${total}</span></td>
      <td data-label="Creado">${creado}</td>
      <td data-label="Acciones">${acciones}</td>
    </tr>`;
  }).join('');
}

async function confirmDeleteUsuario(userId, email) {
  if (!confirm(`¿Eliminar el acceso de ${email}? Ya no podrá iniciar sesión y la acción no se puede deshacer.`)) return;
  try {
    await callEdgeFunction('delete-user', { id: userId });
    showToast(`Acceso de ${email} eliminado.`);
    await renderUsuarios();
  } catch (error) {
    console.error('No se pudo eliminar el usuario.', error);
    showToast(error.message || 'No se pudo eliminar el usuario.', 'error');
  }
}

document.getElementById('form-usuario').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = document.getElementById('usr-nombre').value.trim();
  const email  = document.getElementById('usr-email').value.trim();
  const pass   = document.getElementById('usr-pass').value;
  const rol    = document.getElementById('usr-rol').value;

  const submitBtn = document.getElementById('btn-crear-usuario');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creando...';

  try {
    const result = await callEdgeFunction('create-user', { email, password: pass, nombre, rol });
    if (result.warning) showToast(result.warning, 'error');
    showCredentialsModal(email || result.email, result.password || pass);
    document.getElementById('form-usuario').reset();
    await renderUsuarios();
  } catch (error) {
    console.error('No se pudo crear el usuario.', error);
    showToast(error.message || 'No se pudo crear el usuario.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Crear acceso';
  }
});

// ─── MODAL CREDENCIALES ────────────────────────────────────
function showCredentialsModal(email, password) {
  document.getElementById('cred-email').value = email;
  document.getElementById('cred-pass').value = password;
  document.getElementById('credentials-modal-overlay').classList.remove('hidden');
}

function hideCredentialsModal() {
  document.getElementById('credentials-modal-overlay').classList.add('hidden');
}

document.getElementById('btn-close-creds').addEventListener('click', hideCredentialsModal);
document.getElementById('btn-copy-creds').addEventListener('click', async () => {
  const text = `Usuario: ${document.getElementById('cred-email').value}\nContraseña: ${document.getElementById('cred-pass').value}`;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Credenciales copiadas.');
  } catch (error) {
    const creds = `${document.getElementById('cred-email').value}:${document.getElementById('cred-pass').value}`;
    prompt('Copie manualmente:', creds);
  }
});

// ─── DELETE MODAL ───────────────────────────────────────────
let pendingDelete = null;

function openModal(title, msg, onConfirm, confirmLabel = 'Eliminar') {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-msg').textContent   = msg;
  const btn = document.getElementById('modal-confirm');
  if (btn) btn.textContent = confirmLabel;
  document.getElementById('modal-overlay').classList.remove('hidden');
  pendingDelete = onConfirm;
}

document.getElementById('modal-cancel').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.add('hidden');
  pendingDelete = null;
});

document.getElementById('modal-confirm').addEventListener('click', () => {
  if (pendingDelete) pendingDelete();
  document.getElementById('modal-overlay').classList.add('hidden');
  pendingDelete = null;
});

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) {
    document.getElementById('modal-overlay').classList.add('hidden');
    pendingDelete = null;
  }
});

window.confirmDeleteAtraso = function (id) {
  const a  = loadAtrasos().find(x => String(x.id) === String(id));
  const st = a ? getStudent(a.studentId) : null;
  openModal('Eliminar atraso',
    `¿Eliminar el atraso de ${st ? st.nombre : 'este estudiante'}?`,
    async () => {
      try {
        if (isSupabaseEnabled() && usingSupabaseData && a) {
          const { error } = await supabase.from('atrasos').delete().eq('id', a.id);
          if (error) throw error;
        }
        saveAtrasos(loadAtrasos().filter(x => String(x.id) !== String(id)));
        showToast('Atraso eliminado.');
        renderHistorico();
      } catch (error) {
        console.error('No se pudo eliminar el atraso en Supabase.', error);
        showToast(`No se pudo eliminar: ${error.message || 'revise los permisos'}`, 'error');
      }
    });
};

window.clearAllAtrasos = function () {
  const total = loadAtrasos().length;
  if (total === 0) {
    showToast('No hay registros para limpiar.', 'error');
    return;
  }
  openModal('Limpiar todos los registros',
    `¿Eliminar los ${total} registros de atrasos? Esta acción no se puede deshacer.`,
    async () => {
      try {
        if (isSupabaseEnabled() && usingSupabaseData) {
          const ids = loadAtrasos().map(a => a.id);
          for (const id of ids) {
            const { error } = await supabase.from('atrasos').delete().eq('id', id);
            if (error) throw error;
          }
        }
        saveAtrasos([]);
        showToast('Todos los registros fueron eliminados.');
        renderHistorico();
        renderDashboard();
      } catch (error) {
        console.error('No se pudieron eliminar los registros en Supabase.', error);
        showToast(`No se pudo limpiar: ${error.message || 'revise los permisos'}`, 'error');
      }
    });
};

document.getElementById('btn-limpiar-registros').addEventListener('click', clearAllAtrasos);

// ─── EDITAR / JUSTIFICAR ATRASO ────────────────────────────
let editingAtrasoId = null;

window.editAtraso = function (id) {
  const a = loadAtrasos().find(x => String(x.id) === String(id));
  if (!a) return;
  editingAtrasoId = String(a.id);
  const just = document.getElementById('edit-justificado');
  just.checked = !!a.justificado;
  document.getElementById('edit-motivo').value = a.motivo || '';
  document.getElementById('edit-motivo-group').style.display = just.checked ? 'block' : 'none';
  document.getElementById('edit-atraso-modal-overlay').classList.remove('hidden');
  if (just.checked) document.getElementById('edit-motivo').focus();
};

function hideEditAtrasoModal() {
  editingAtrasoId = null;
  document.getElementById('edit-atraso-modal-overlay').classList.add('hidden');
}

document.getElementById('edit-justificado').addEventListener('change', function () {
  document.getElementById('edit-motivo-group').style.display = this.checked ? 'block' : 'none';
  if (this.checked) document.getElementById('edit-motivo').focus();
});

document.getElementById('edit-atraso-cancel').addEventListener('click', hideEditAtrasoModal);
document.getElementById('edit-atraso-modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('edit-atraso-modal-overlay')) hideEditAtrasoModal();
});

document.getElementById('edit-atraso-save').addEventListener('click', async () => {
  if (!editingAtrasoId) return;
  const justificado = document.getElementById('edit-justificado').checked;
  const motivo = document.getElementById('edit-motivo').value.trim();

  const current = loadAtrasos().find(x => String(x.id) === String(editingAtrasoId));
  if (!current) {
    hideEditAtrasoModal();
    return;
  }

  const submit = document.getElementById('edit-atraso-save');
  submit.disabled = true;
  submit.textContent = 'Guardando...';
  try {
    if (isSupabaseEnabled() && usingSupabaseData) {
      const { error } = await supabase
        .from('atrasos')
        .update({ justificado, motivo })
        .eq('id', editingAtrasoId);
      if (error) throw error;
    }
    saveAtrasos(loadAtrasos().map(a =>
      String(a.id) === String(editingAtrasoId) ? { ...a, justificado, motivo } : a
    ));
    showToast('Atraso actualizado.');
    hideEditAtrasoModal();
    renderHistorico();
    renderDashboard();
  } catch (error) {
    console.error('No se pudo actualizar el atraso.', error);
    showToast(error.message || 'No se pudo actualizar el atraso.', 'error');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Guardar';
  }
});

// ─── EXPORT: DATOS DEL PANEL (compartidos) ──────────────────
function buildDashboardExportData() {
  const allAtrasos = loadAtrasos();
  const allStudents = loadStudents();
  const { students, atrasos } = filterByNivel(allStudents, allAtrasos);
  const todayStr = today();
  const hoy      = atrasos.filter(a => a.fecha === todayStr);
  const semana   = atrasos.filter(a => a.fecha >= dateOffset(6));
  const justHoy  = hoy.filter(a => a.justificado).length;
  const last30   = atrasos.filter(a => a.fecha >= dateOffset(29));
  const byDay    = {};
  last30.forEach(a => { byDay[a.fecha] = (byDay[a.fecha] || 0) + 1; });
  const days = Object.keys(byDay).length;
  const prom  = days ? (last30.length / days).toFixed(1) : 0;

  const totals = {};
  atrasos.forEach(a => { totals[a.studentId] = (totals[a.studentId] || 0) + 1; });
  const top = Object.entries(totals)
    .map(([id, n]) => ({ student: students.find(s => s.id === parseInt(id)), n }))
    .filter(x => x.student)
    .sort((a, b) => b.n - a.n)
    .slice(0, 15);

  const byCurso = {};
  atrasos.forEach(a => {
    const st = students.find(s => s.id === a.studentId);
    if (st && st.curso) byCurso[st.curso] = (byCurso[st.curso] || 0) + 1;
  });
  let courseNames = getAvailableCourseNames();
  if (dashboardNivel !== 'todo') courseNames = courseNames.filter(c => getCursoNivel(c) === dashboardNivel);
  courseNames.forEach(c => { if (!(c in byCurso)) byCurso[c] = 0; });
  const cursoEntries = sortCursos(courseNames).map(c => [c, byCurso[c] || 0]);

  const evolution = buildEvolutionSeries(atrasos);
  const { from, to } = getEvolutionWindow();
  const rangeLabel = `${formatDate(from.toISOString().slice(0, 10))} a ${formatDate(to.toISOString().slice(0, 10))}`;

  return { atrasos, students, todayStr, hoy, semana, justHoy, prom, top, cursoEntries, evolution, rangeLabel };
}

// ─── EXPORT: DASHBOARD PDF ──────────────────────────────────
window.exportDashboardPDF = function () {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const fechaHoy = formatDate(today());
  const d = buildDashboardExportData();

  doc.setFontSize(16);
  doc.setTextColor(15, 23, 42);
  doc.text(`Control de Atrasos — Panel de Control (${nivelLabel()})`, 14, 18);

  doc.setFontSize(10);
  doc.setTextColor(100, 116, 139);
  doc.text(`Generado: ${fechaHoy}`, 14, 25);

  const headStyles = { fillColor: [26, 50, 99], textColor: 255, fontStyle: 'bold', fontSize: 9 };
  const bodyStyles = { fontSize: 9 };
  const altRow = { fillColor: [243, 246, 250] };

  doc.autoTable({
    startY: 32,
    head: [['Indicador', 'Valor']],
    body: [
      ['Atrasos hoy', d.hoy.length],
      ['Justificados hoy', d.justHoy],
      ['Sin justificar hoy', d.hoy.length - d.justHoy],
      ['Atrasos esta semana', d.semana.length],
      ['Promedio diario (30 días)', d.prom],
      ['Total estudiantes', d.students.length],
    ],
    headStyles: { fillColor: [26, 50, 99], textColor: 255, fontStyle: 'bold', fontSize: 10 },
    bodyStyles: { fontSize: 10 },
    alternateRowStyles: altRow,
    margin: { left: 14, right: 14 },
    tableWidth: 100,
  });

  const sectionStart = (title) => {
    const y = doc.lastAutoTable.finalY + 8;
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text(title, 14, y);
    return y + 5;
  };

  if (d.hoy.length > 0) {
    doc.autoTable({
      startY: sectionStart(`Atrasos de hoy — ${fechaHoy}`),
      head: [['Estudiante', 'Curso', 'Hora', 'Estado', 'Motivo']],
      body: d.hoy.sort((a, b) => b.hora.localeCompare(a.hora) || b.id - a.id).map(a => {
        const st = getStudent(a.studentId);
        return [
          st ? st.nombre : '—',
          st ? st.curso : '—',
          a.hora,
          a.justificado ? 'Justificado' : 'Sin justificar',
          a.motivo || '—',
        ];
      }),
      headStyles, bodyStyles, alternateRowStyles: altRow,
      margin: { left: 14, right: 14 },
    });
  }

  doc.autoTable({
    startY: sectionStart('Top 15 Estudiantes con más atrasos'),
    head: [['#', 'Estudiante', 'Curso', 'Total Atrasos', 'Último Atraso']],
    body: d.top.map((x, i) => {
      const lastA = d.atrasos
        .filter(a => a.studentId === x.student.id)
        .sort((a, b) => b.fecha.localeCompare(a.fecha))[0];
      return [i + 1, x.student.nombre, x.student.curso, x.n, lastA ? formatDate(lastA.fecha) : '—'];
    }),
    headStyles, bodyStyles, alternateRowStyles: altRow,
    margin: { left: 14, right: 14 },
  });

  doc.autoTable({
    startY: sectionStart('Cursos con más atrasos'),
    head: [['Curso', 'Total Atrasos']],
    body: d.cursoEntries.map(([c, n]) => [c, n]),
    headStyles, bodyStyles, alternateRowStyles: altRow,
    margin: { left: 14, right: 14 },
  });

  doc.autoTable({
    startY: sectionStart(`Evolución de atrasos — ${d.rangeLabel}`),
    head: [['Período', 'Atrasos']],
    body: d.evolution.labels.map((l, i) => [l, d.evolution.data[i]]),
    headStyles, bodyStyles, alternateRowStyles: altRow,
    margin: { left: 14, right: 14 },
  });

  doc.save(`panel-control-${d.todayStr}.pdf`);
  showToast('PDF del panel generado.');
};

// ─── EXPORT: DASHBOARD EXCEL ────────────────────────────────
window.exportDashboardExcel = function () {
  const d = buildDashboardExportData();
  const wb = XLSX.utils.book_new();

  // Hoja 1: Resumen
  const resumen = [
    ['PANEL DE CONTROL', ''],
    ['Generado:', formatDate(d.todayStr)],
    ['Nivel:', nivelLabel()],
    [''],
    ['Indicador', 'Valor'],
    ['Atrasos hoy', d.hoy.length],
    ['Justificados hoy', d.justHoy],
    ['Sin justificar hoy', d.hoy.length - d.justHoy],
    ['Atrasos esta semana', d.semana.length],
    ['Promedio diario (30 días)', d.prom],
    ['Total estudiantes', d.students.length],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumen), 'Resumen');

  // Hoja 2: Atrasos hoy
  if (d.hoy.length > 0) {
    const rows = [['Estudiante', 'Curso', 'Hora', 'Estado', 'Motivo']];
    d.hoy.sort((a, b) => b.hora.localeCompare(a.hora) || b.id - a.id).forEach(a => {
      const st = getStudent(a.studentId);
      rows.push([
        st ? st.nombre : '—',
        st ? st.curso : '—',
        a.hora,
        a.justificado ? 'Justificado' : 'Sin justificar',
        a.motivo || '',
      ]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Atrasos Hoy');
  }

  // Hoja 3: Top 15
  const top15 = [['#', 'Estudiante', 'Curso', 'Total Atrasos', 'Último Atraso']];
  d.top.forEach((x, i) => {
    const lastA = d.atrasos
      .filter(a => a.studentId === x.student.id)
      .sort((a, b) => b.fecha.localeCompare(a.fecha))[0];
    top15.push([i + 1, x.student.nombre, x.student.curso, x.n, lastA ? formatDate(lastA.fecha) : '—']);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(top15), 'Top 15 Estudiantes');

  // Hoja 4: Cursos
  const cursos = [['Curso', 'Total Atrasos']];
  d.cursoEntries.forEach(([c, n]) => cursos.push([c, n]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cursos), 'Cursos');

  // Hoja 5: Evolución
  const evolucion = [['Período', 'Atrasos']];
  d.evolution.labels.forEach((l, i) => evolucion.push([l, d.evolution.data[i]]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(evolucion), 'Evolución');

  XLSX.writeFile(wb, `panel-control-${d.todayStr}.xlsx`);
  showToast('Excel del panel generado.');
};

// ─── INIT ────────────────────────────────────────────────────
// Carga los datos en modo lectura pública (sin sesión de admin).
// Permite que las autoridades vean el tablero/indicadores con solo
// compartirles el link, mientras que registrar atrasos y gestionar
// estudiantes siguen exigiendo inicio de sesión.
async function loadPublicDashboard() {
  await hydrateFromSupabase();
  renderPage(currentPage || 'dashboard');
}

window.refreshDashboard = async function () {
  if (!isAdmin()) {
    await loadPublicDashboard();
    return;
  }
  await hydrateFromSupabase();
  populateCursosDropdown();
  renderPage(currentPage || 'dashboard');
};

updateAccess();
initializeAuthentication().then(isAllowed => {
  if (isAllowed) {
    return refreshDashboard();
  }
  return loadPublicDashboard();
});

const rangeButtons = document.querySelectorAll('[data-range]');
rangeButtons.forEach(button => {
  button.addEventListener('click', () => {
    const range = button.dataset.range;
    const view = button.dataset.view || 'daily';
    document.querySelectorAll('[data-range]').forEach(btn => btn.classList.remove('active'));
    button.classList.add('active');
    if (range === 'custom') {
      document.getElementById('range-from').classList.remove('hidden');
      document.getElementById('range-to').classList.remove('hidden');
    } else {
      document.getElementById('range-from').classList.add('hidden');
      document.getElementById('range-to').classList.add('hidden');
    }
    setEvolutionRange(range, view);
  });
});

document.getElementById('range-from').addEventListener('change', () => {
  evolutionFrom = document.getElementById('range-from').value;
  evolutionTo = document.getElementById('range-to').value;
  if (evolutionFrom && evolutionTo) {
    setEvolutionRange('custom', evolutionView);
  }
});

document.getElementById('range-to').addEventListener('change', () => {
  evolutionFrom = document.getElementById('range-from').value;
  evolutionTo = document.getElementById('range-to').value;
  if (evolutionFrom && evolutionTo) {
    setEvolutionRange('custom', evolutionView);
  }
});

// ─── AUTO-REFRESH DEL TABLERO (tiempo real) ────────────────
// Consulta Supabase cada 30 s mientras el usuario esté en el panel.
// No interfiere con el formulario de registro ni con el histórico.
setInterval(async () => {
  if (currentPage !== 'dashboard' || !isSupabaseEnabled()) return;
  await hydrateFromSupabase();
  renderPage('dashboard');
}, 30000);
