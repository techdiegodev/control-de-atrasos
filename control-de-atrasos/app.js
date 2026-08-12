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
  try {
    let query = supabase.from(table).select(select);
    if (orderBy) {
      query = query.order(orderBy, { ascending });
    }
    const { data, error } = await query;
    if (error) return { ok: false, error, table };
    return { ok: true, data: Array.isArray(data) ? data : [], table };
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
      select: 'id, nombre',
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
      const result = await trySupabaseQuery(candidate.table, candidate.select, candidate.orderBy, candidate.ascending);
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

    const cursos = (cursosData || []).map(c => ({
      id: pickExactValue(c, ['id', 'ID']),
      nombre: String(pickExactValue(c, ['nombre', 'name', 'curso', 'title']) || '').trim(),
    }));

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

// ─── CURSOS DEL ESTABLECIMIENTO ──────────────────────────────
const CURSOS_ORDENADOS = [
  '8º A','8º B','8º C',
  '9º A','9º B','9º C',
  '10º A','10º B','10º C',
  '1º Hosteleria A','1º Hosteleria B',
  '1º Ciencias','1º Gestión',
  '2º Ciencias A','2º Ciencias B','2º Servicios','2º Gestión',
  '3º Ciencias A','3º Ciencias B','3º Servicios','3º Gestión',
];

function getAvailableCourseNames() {
  const fromCourses = loadCourses().map(c => c.nombre).filter(Boolean);
  return [...new Set(fromCourses)];
}

function sortCursos(cursos) {
  const courseOrder = loadCourses().map(c => c.nombre);
  return [...cursos].sort((a, b) => {
    const ia = CURSOS_ORDENADOS.indexOf(a);
    const ib = CURSOS_ORDENADOS.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;

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
  // La gestión de estudiantes sigue siendo solo local; se oculta hasta que
  // sus operaciones se sincronicen también con Supabase.
  document.querySelectorAll('[data-page="estudiantes"]').forEach(el => {
    el.style.display = 'none';
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
      redirectTo: window.location.href,
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
  if (page === 'usuarios' && !isAdmin()) {
    showAuthModal();
    return;
  }
  if ((page === 'registrar' || page === 'estudiantes') && !canRegister()) {
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

function buildEvolutionSeries() {
  const { from, to } = getEvolutionWindow();
  const all = loadAtrasos().filter(a => {
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
  const atrasos  = loadAtrasos();
  const students = loadStudents();
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
            <strong>${st ? st.nombre : '—'}</strong>
            <span>${st ? st.curso : ''} &bull; ${formatDate(a.fecha)} &bull; ${a.hora}</span>
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
        <td data-label="Estudiante"><strong>${x.student.nombre}</strong></td>
        <td data-label="Curso">${x.student.curso}</td>
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

  allCourseNames.forEach(c => {
    if (!(c in byCurso)) byCurso[c] = 0;
  });

  const cursoEntries = sortCursos(allCourseNames).map(c => [c, byCurso[c] || 0]);
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

const evolution = buildEvolutionSeries();
  const ctx = document.getElementById('chart-evolucion').getContext('2d');
  if (chartEvolucion) chartEvolucion.destroy();
  chartEvolucion = new Chart(ctx, {
    type: 'line',
    data: {
      labels: evolution.labels,
      datasets: [{
        label: 'Atrasos por día',
        data: evolution.data,
        borderColor: '#1A3263',
        backgroundColor: 'rgba(26,50,99,.14)',
        tension: 0.3,
        fill: true,
        borderWidth: 2.5,
        pointRadius: 4,
        pointBackgroundColor: '#1A3263',
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
    merged.map(c => `<option value="${c}">${c}</option>`).join('');

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
    estudiantes.map(s => `<option value="${s.id}">${s.nombre}</option>`).join('');
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
    cursos.map(c => `<option value="${c}" ${prevC === c ? 'selected' : ''}>${c}</option>`).join('');

  // Populate "registrado por" filter
  const atrasosAll = loadAtrasos();
  const registrantes = [...new Set(atrasosAll.map(a => a.registradoPor).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const fp       = document.getElementById('filter-por');
  const prevP    = fp.value;
  fp.innerHTML   = '<option value="">Todos los que registraron</option>' +
    registrantes.map(email => `<option value="${email}" ${prevP === email ? 'selected' : ''}>${email}</option>`).join('');

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

  if (enriched.length === 0) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  tbody.innerHTML = enriched.map(a => {
    const badge = a.justificado
      ? '<span class="badge badge-green">Justificado</span>'
      : '<span class="badge badge-amber">Sin Justificar</span>';
    const idLiteral = typeof a.id === 'number' ? a.id : `'${a.id}'`;
    const actions = isAdmin()
      ? `<button class="btn btn-icon" onclick="confirmDeleteAtraso(${idLiteral})" title="Eliminar atraso">Eliminar</button>`
      : '—';
    return `<tr>
      <td data-label="Estudiante"><strong>${a.student.nombre}</strong></td>
      <td data-label="Curso">${a.student.curso}</td>
      <td data-label="Fecha">${formatDate(a.fecha)}</td>
      <td data-label="Hora">${a.hora}</td>
      <td data-label="Estado">${badge}</td>
      <td data-label="Motivo">${a.motivo || '—'}</td>
      <td data-label="Registrado por">${a.registradoPor || '—'}</td>
      <td data-label="Acción">${actions}</td>
    </tr>`;
  }).join('');
}

['filter-search', 'filter-fecha', 'filter-curso', 'filter-por'].forEach(id =>
  document.getElementById(id).addEventListener('input', renderHistorico));

document.getElementById('btn-limpiar-filtros').addEventListener('click', () => {
  document.getElementById('filter-search').value = '';
  document.getElementById('filter-fecha').value  = '';
  document.getElementById('filter-curso').value  = '';
  document.getElementById('filter-por').value    = '';
  renderHistorico();
});

// ─── ESTUDIANTES ────────────────────────────────────────────
let editingStudentId = null;

function renderEstudiantes() {
  const search = document.getElementById('est-search').value.toLowerCase();
  const curso  = document.getElementById('est-filter-curso').value;

  const cursos = sortCursos(getAvailableCourseNames().filter(Boolean));
  const fc = document.getElementById('est-filter-curso');
  const prevC = fc.value;
  fc.innerHTML = '<option value="">Todos los cursos</option>' +
    cursos.map(c => `<option value="${c}" ${prevC === c ? 'selected' : ''}>${c}</option>`).join('');

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
    const actions = '—';
    return `<tr>
      <td data-label="Nombre"><strong>${s.nombre}</strong></td>
      <td data-label="Curso">${s.curso}</td>
      <td data-label="Email">${s.email || '—'}</td>
      <td data-label="Total Atrasos"><span class="badge badge-blue">${total}</span></td>
      <td data-label="Acción" style="display:flex;gap:.4rem;justify-content:flex-end">${actions}</td>
    </tr>`;
  }).join('');
}

['est-search', 'est-filter-curso'].forEach(id =>
  document.getElementById(id).addEventListener('input', renderEstudiantes));

document.getElementById('btn-nuevo-estudiante').addEventListener('click', () => {
  editingStudentId = null;
  document.getElementById('form-estudiante').reset();
  document.getElementById('est-id').value = '';
  document.getElementById('form-estudiante-title').textContent = 'Nuevo Estudiante';
  document.getElementById('btn-guardar-estudiante').textContent = 'Guardar';
  document.getElementById('form-estudiante-card').style.display = 'block';
  document.getElementById('form-estudiante-card').scrollIntoView({ behavior: 'smooth' });
});

document.getElementById('btn-cancelar-estudiante').addEventListener('click', () => {
  document.getElementById('form-estudiante-card').style.display = 'none';
  editingStudentId = null;
});

window.editStudent = function (id) {
  const s = loadStudents().find(x => x.id === id);
  if (!s) return;
  editingStudentId = id;
  document.getElementById('est-id').value     = id;
  document.getElementById('est-nombre').value = s.nombre;
  document.getElementById('est-curso').value  = s.curso;
  document.getElementById('est-email').value  = s.email || '';
  document.getElementById('form-estudiante-title').textContent = 'Editar Estudiante';
  document.getElementById('btn-guardar-estudiante').textContent = 'Actualizar';
  document.getElementById('form-estudiante-card').style.display = 'block';
  document.getElementById('form-estudiante-card').scrollIntoView({ behavior: 'smooth' });
};

document.getElementById('form-estudiante').addEventListener('submit', (e) => {
  e.preventDefault();
  const nombre = document.getElementById('est-nombre').value.trim();
  const curso  = document.getElementById('est-curso').value.trim();
  const email  = document.getElementById('est-email').value.trim();

  if (!nombre || !curso) { showToast('Complete los campos obligatorios.', 'error'); return; }

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

  document.getElementById('form-estudiante-card').style.display = 'none';
  editingStudentId = null;
  renderEstudiantes();
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
    return `<tr>
      <td data-label="Correo"><strong>${u.email}</strong></td>
      <td data-label="Nombre">${u.nombre || '—'}</td>
      <td data-label="Rol">${rol}</td>
      <td data-label="Atrasos registrados"><span class="badge badge-blue">${total}</span></td>
      <td data-label="Creado">${creado}</td>
    </tr>`;
  }).join('');
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
    showCredentialsModal(result.email, result.password);
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

function openModal(title, msg, onConfirm) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-msg').textContent   = msg;
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

window.confirmDeleteStudent = function (id) {
  const st = getStudent(id);
  openModal('Eliminar estudiante',
    `¿Eliminar a ${st ? st.nombre : 'este estudiante'}? También se eliminarán sus atrasos.`,
    () => {
      saveStudents(loadStudents().filter(s => s.id !== id));
      saveAtrasos(loadAtrasos().filter(a => a.studentId !== id));
      showToast('Estudiante eliminado.');
      renderEstudiantes();
    });
};

// ─── EXPORT: DATOS DEL PANEL (compartidos) ──────────────────
function buildDashboardExportData() {
  const atrasos  = loadAtrasos();
  const students = loadStudents();
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
  const allCourseNames = getAvailableCourseNames();
  allCourseNames.forEach(c => { if (!(c in byCurso)) byCurso[c] = 0; });
  const cursoEntries = sortCursos(allCourseNames).map(c => [c, byCurso[c] || 0]);

  const evolution = buildEvolutionSeries();
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
  doc.text('Control de Atrasos — Panel de Control', 14, 18);

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
