const API_BASE = "https://infraestructura-gestioninterna-354063050046.southamerica-east1.run.app";
//const API_BASE = "http://localhost:8080";
const GOOGLE_CLIENT_ID = "354063050046-fkp06ao8aauems1gcj4hlngljf56o3cj.apps.googleusercontent.com";

let idToken = null;
let CURRENT_USER = null;
let CURRENT_TAB = "gestiones";
let RESUMEN_TERRITORIAL = {
  departamento: "",
  localidad: "",
  data: null,
  editing: false,
};

// paginado
const PAGE = { limit: 50, offset: 0, total: null };

// cache UI
let LAST_ROWS = [];
let LAST_SEARCH = "";

// Usuarios cache
let LAST_USERS = [];

// Ordenamiento (front)
let SORT = { key: null, dir: "asc" }; // dir: asc | desc

// Columnas visibles (persistidas por usuario)
const LS_COLS_KEY = "infra.columns.visible.v1";
const LS_COL_WIDTH_KEY = "infra.columns.widths.v1";
let VISIBLE_COLS = new Set();
let COL_WIDTHS = {};

// Catálogos en memoria
let CATALOGOS = {
  estados: [],
  urgencias: [],
  ministerios: [],
  categorias: [],
  departamentos: [],
  localidadesByDepto: new Map(),

  // Nuevos (front-only)
  tiposGestion: [],
  canalesOrigen: [],
};

// ============================
// Helpers UI
// ============================
function show(el) { el?.classList.remove("hidden"); }
function hide(el) { el?.classList.add("hidden"); }
function $id(id) { return document.getElementById(id); }
function setVal(id, v) { const el = $id(id); if (el) el.value = v; }
function getVal(id, fallback = "") { const el = $id(id); return el ? (el.value ?? fallback) : fallback; }

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast({ title = "Info", message = "", variant = "ok", ms = 3200 } = {}) {
  const host = $id("toastHost");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast toast--${variant === "error" ? "error" : "ok"}`;
  el.innerHTML = `
    <div class="toast-title">${escapeHtml(title)}</div>
    ${message ? `<div class="toast-msg">${escapeHtml(message)}</div>` : ``}
  `;
  host.appendChild(el);
  window.setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    el.style.transition = "opacity .18s ease, transform .18s ease";
    window.setTimeout(() => el.remove(), 220);
  }, Math.max(800, ms));
}

function setGlobalLoading(isLoading, text = "Cargando...") {
  const box = $id("globalLoading");
  if (!box) return;
  const label = box.querySelector(".global-loading-text");
  if (label) label.textContent = text || "Cargando...";
  if (isLoading) {
    box.classList.remove("hidden");
    box.setAttribute("aria-hidden", "false");
  } else {
    box.classList.add("hidden");
    box.setAttribute("aria-hidden", "true");
  }
}

function setLoginError(msg) {
  const box = $id("loginError");
  if (!box) return;
  if (!msg) { box.textContent = ""; hide(box); }
  else { box.textContent = msg; show(box); }
}

function setAppError(msg) {
  const box = $id("appError");
  if (!box) return;
  if (!msg) { box.textContent = ""; hide(box); }
  else { box.textContent = msg; show(box); }
}

function setUsersError(msg) {
  const box = $id("usersError");
  if (!box) return;
  if (!msg) { box.textContent = ""; hide(box); }
  else { box.textContent = msg; show(box); }
}

function setUsersHint(msg) {
  const box = $id("usersHint");
  if (!box) return;
  box.textContent = msg || "";
}

function setAppAuthedUI(isAuthed) {
  const loginSection = $id("loginSection");
  const appSection = $id("appSection");
  const btnLogout = $id("btnLogout");

  if (isAuthed) {
    hide(loginSection);
    show(appSection);
    show(btnLogout);
  } else {
    show(loginSection);
    hide(appSection);
    hide(btnLogout);
  }
}

function saveToken(token) {
  idToken = token;
  if (token) sessionStorage.setItem("idToken", token);
  else sessionStorage.removeItem("idToken");
}
function readToken() { return sessionStorage.getItem("idToken"); }

function isAdmin() { return String(CURRENT_USER?.rol || "").toLowerCase() === "admin"; }
function isSupervisor() { return String(CURRENT_USER?.rol || "").toLowerCase() === "supervisor"; }

// ============================
// Robust field getter
// ============================
function pick(row, ...keys) {
  if (!row || typeof row !== "object") return undefined;

  for (const k of keys) {
    if (k in row) return row[k];
  }

  const lowerMap = new Map();
  for (const k of Object.keys(row)) lowerMap.set(k.toLowerCase(), k);

  for (const wanted of keys) {
    const real = lowerMap.get(String(wanted).toLowerCase());
    if (real) return row[real];
  }

  return undefined;
}

function fmtDateLike(v) {
  if (!v) return "";
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString();
  } catch {
    return String(v);
  }
}

function debounce(fn, ms = 250) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ============================
// Clipboard
// ============================
function copyToClipboard(text) {
  const s = String(text ?? "");
  try {
    navigator.clipboard?.writeText(s);
    toast({ title: "Copiado", message: s, variant: "ok" });
  } catch {
    const ta = document.createElement("textarea");
    ta.value = s;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast({ title: "Copiado", message: s, variant: "ok" });
  }
}

// ============================
// Sorting
// ============================
function sortRows(rows, key, dir) {
  const factor = dir === "desc" ? -1 : 1;

  const getComparable = (r) => {
    const v = pick(r, key);
    if (v == null) return "";
    if (typeof v === "number") return v;
    const s = String(v);
    const n = Number(s);
    if (!Number.isNaN(n) && s.trim() !== "") return n;
    const t = Date.parse(s);
    if (!Number.isNaN(t) && /\d{4}-\d{2}-\d{2}/.test(s)) return t;
    return s.toLowerCase();
  };

  return [...rows].sort((a, b) => {
    const A = getComparable(a);
    const B = getComparable(b);
    if (A < B) return -1 * factor;
    if (A > B) return 1 * factor;
    return 0;
  });
}

// ============================
// Text measure (for auto-fit)
// ============================
let __measureCanvas = null;
function measureTextPx(text, font) {
  if (!__measureCanvas) __measureCanvas = document.createElement('canvas');
  const ctx = __measureCanvas.getContext('2d');
  ctx.font = font || '12px sans-serif';
  return ctx.measureText(String(text || '')).width || 0;
}

// ============================
// Column definitions
// ============================
const COL_DEFS = [
  { key: "id_gestion", label: "ID", important: true },
  { key: "departamento", label: "Departamento", important: true },
  { key: "localidad", label: "Localidad", important: true },
  { key: "estado", label: "Estado", important: true },
  { key: "urgencia", label: "Urgencia", important: true },
  { key: "ministerio_agencia_id", label: "Ministerio/Agencia", important: true },
  { key: "categoria_general_id", label: "Categoria", important: true },
  { key: "tipo_gestion", label: "Tipo" },
  { key: "canal_origen", label: "Canal" },
  { key: "detalle", label: "Detalle", important: true },
  { key: "costo_estimado", label: "Costo" },
  { key: "fecha_ingreso", label: "Ingreso" },
  { key: "dias_transcurridos", label: "Dias" },
];

function defaultVisibleColsForWidth() {
  const w = window.innerWidth || 1200;
  if (w < 820) {
    return new Set(COL_DEFS.filter(c => c.important).map(c => c.key));
  }
  if (w < 1024) {
    return new Set(COL_DEFS.filter(c => c.important || ["fecha_ingreso"].includes(c.key)).map(c => c.key));
  }
  return new Set(COL_DEFS.map(c => c.key));
}

function loadVisibleCols() {
  try {
    const raw = localStorage.getItem(LS_COLS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        VISIBLE_COLS = new Set(arr.filter(Boolean));
        return;
      }
    }
  } catch { }
  VISIBLE_COLS = defaultVisibleColsForWidth();
}

function saveVisibleCols() {
  try {
    localStorage.setItem(LS_COLS_KEY, JSON.stringify([...VISIBLE_COLS]));
  } catch { }
}

function loadColWidths() {
  try {
    const raw = localStorage.getItem(LS_COL_WIDTH_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        COL_WIDTHS = obj;
        return;
      }
    }
  } catch { }
  COL_WIDTHS = {};
}

function saveColWidths() {
  try {
    localStorage.setItem(LS_COL_WIDTH_KEY, JSON.stringify(COL_WIDTHS || {}));
  } catch { }
}

function ensureMinimumCols() {
  const min = 4;
  if (VISIBLE_COLS.size < min) {
    // Reponer importantes
    COL_DEFS.filter(c => c.important).forEach(c => VISIBLE_COLS.add(c.key));
  }
}

function buildColumnsUI() {
  const list = $id("columnsList");
  if (!list) return;

  list.innerHTML = "";

  COL_DEFS.forEach((c) => {
    const wrap = document.createElement("label");
    wrap.className = "col-opt";
    wrap.innerHTML = `
      <input type="checkbox" ${VISIBLE_COLS.has(c.key) ? "checked" : ""} data-col="${escapeHtml(c.key)}" />
      <span>${escapeHtml(c.label)}</span>
    `;
    list.appendChild(wrap);
  });

  list.querySelectorAll("input[type='checkbox'][data-col]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const key = e.target.getAttribute("data-col");
      if (!key) return;
      if (e.target.checked) VISIBLE_COLS.add(key);
      else VISIBLE_COLS.delete(key);
      ensureMinimumCols();
      saveVisibleCols();
      buildColumnsUI(); // por si se repuso el minimo
      renderGrid(LAST_ROWS);
    });
  });
}

function setAllColsVisible() {
  VISIBLE_COLS = new Set(COL_DEFS.map(c => c.key));
  saveVisibleCols();
  buildColumnsUI();
  renderGrid(LAST_ROWS);
}

function setOnlyImportantCols() {
  VISIBLE_COLS = new Set(COL_DEFS.filter(c => c.important).map(c => c.key));
  saveVisibleCols();
  buildColumnsUI();
  renderGrid(LAST_ROWS);
}

function resetColsToDefault() {
  localStorage.removeItem(LS_COLS_KEY);
  loadVisibleCols();
  saveVisibleCols();
  buildColumnsUI();
  renderGrid(LAST_ROWS);
}

// ============================
// Popover helper
// ============================
function openPopover(btnId, panelId) {
  const btn = $id(btnId);
  const panel = $id(panelId);
  if (!btn || !panel) return;
  const isOpen = !panel.classList.contains("hidden");
  if (isOpen) {
    panel.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
    return;
  }

  // Posicionamiento robusto: evita que el panel salga del viewport.
  // Usamos position:fixed + coordenadas calculadas desde el botón.
  panel.classList.remove("hidden");
  btn.setAttribute("aria-expanded", "true");

  const place = () => {
    try {
      const r = btn.getBoundingClientRect();

      // Forzamos fixed para que SIEMPRE se limite al viewport.
      const pad = 8;
      panel.style.position = "fixed";
      panel.style.right = "auto";
      panel.style.transform = "none";
      panel.style.maxWidth = `calc(100vw - ${pad * 2}px)`;
      panel.style.maxHeight = `calc(100vh - ${pad * 2}px)`;
      panel.style.overflow = "auto";

      // Colocamos un punto inicial para medir sin que se vaya fuera.
      panel.style.left = `${pad}px`;
      panel.style.top = `${Math.round(r.bottom + 8)}px`;

      const rect = panel.getBoundingClientRect();
      const w = rect.width || 360;
      const h = rect.height || 240;

      const vw = window.innerWidth || 1200;
      const vh = window.innerHeight || 800;

      // Preferimos alinear el borde derecho del panel al borde derecho del botón.
      let left = r.right - w;
      left = Math.max(pad, Math.min(left, vw - w - pad));

      // Debajo del botón, o arriba si no entra.
      let top = r.bottom + 8;
      if (top + h > vh - pad) top = Math.max(pad, r.top - h - 8);

      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
    } catch {
      // si falla, dejamos el CSS por defecto
    }
  };

  // Colocar 2 veces: inmediato + en el siguiente frame (por si el browser ajusta width)
  place();
  requestAnimationFrame(place);
}

function closePopover(btnId, panelId) {
  const btn = $id(btnId);
  const panel = $id(panelId);
  if (!btn || !panel) return;
  panel.classList.add("hidden");
  btn.setAttribute("aria-expanded", "false");
}
// ============================
// Column resizing + auto-fit (client-only)
// ============================
let __resizing = null;

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function applyColWidth(tableEl, colIndex, px) {
  if (!tableEl) return;
  const w = clamp(toInt(px), 80, 900);
  const ths = tableEl.querySelectorAll('thead th');
  if (ths[colIndex]) ths[colIndex].style.width = w + 'px';
  tableEl.querySelectorAll('tbody tr').forEach(tr => {
    const td = tr.children[colIndex];
    if (td) td.style.width = w + 'px';
  });
}

function persistWidthForKey(colKey, px) {
  if (!colKey) return;
  COL_WIDTHS = COL_WIDTHS || {};
  COL_WIDTHS[colKey] = clamp(toInt(px), 80, 900);
  saveColWidths();
}

function getFontForMeasure(el) {
  const cs = window.getComputedStyle(el);
  return cs.font || (cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily);
}

function autoFitColumn(tableEl, colIndex, colKey) {
  const th = tableEl?.querySelectorAll('thead th')[colIndex];
  if (!th) return;
  const font = getFontForMeasure(th);

  let max = 0;
  const thLabel = th.innerText || th.textContent || '';
  max = Math.max(max, measureTextPx(thLabel, font));

  tableEl.querySelectorAll('tbody tr').forEach(tr => {
    const td = tr.children[colIndex];
    if (!td) return;
    const t = (td.innerText || td.textContent || '').trim();
    const longest = t.split(/\n/).reduce((a, b) => (a.length >= b.length ? a : b), '');
    max = Math.max(max, measureTextPx(longest, font));
  });

  const target = clamp(Math.ceil(max + 34), 80, 600);
  applyColWidth(tableEl, colIndex, target);
  persistWidthForKey(colKey, target);
}

function enableColumnResizing(tableEl, visibleCols) {
  if (!tableEl) return;
  const ths = tableEl.querySelectorAll('thead th');
  if (!ths.length) return;

  // Apply persisted widths first
  (visibleCols || []).forEach((c, idx) => {
    const w = COL_WIDTHS?.[c.key];
    if (w) applyColWidth(tableEl, idx, w);
  });

  (visibleCols || []).forEach((c, idx) => {
    const th = ths[idx];
    if (!th) return;

    // Ensure inner wrapper
    if (!th.querySelector('.th-inner')) {
      const label = th.textContent || '';
      th.innerHTML = '<div class="th-inner"><span class="th-label"></span></div>';
      th.querySelector('.th-label').textContent = label;
    }

    // Avoid duplicate
    if (th.querySelector('.col-resizer')) return;

    const res = document.createElement('span');
    res.className = 'col-resizer';
    res.title = 'Arrastrar para ajustar. Doble click para auto-ajustar.';

    res.addEventListener('click', (e) => e.stopPropagation());

    res.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      autoFitColumn(tableEl, idx, c.key);
    });

    res.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = th.getBoundingClientRect().width;
      __resizing = { tableEl, idx, key: c.key, startX, startW };
      document.documentElement.classList.add('resizing');
    });

    th.querySelector('.th-inner')?.appendChild(res);
  });
}

document.addEventListener('mousemove', (e) => {
  if (!__resizing) return;
  const dx = e.clientX - __resizing.startX;
  const next = __resizing.startW + dx;
  applyColWidth(__resizing.tableEl, __resizing.idx, next);
});

document.addEventListener('mouseup', () => {
  if (!__resizing) return;
  const th = __resizing.tableEl?.querySelectorAll('thead th')[__resizing.idx];
  const w = th ? Math.round(th.getBoundingClientRect().width) : null;
  if (w) persistWidthForKey(__resizing.key, w);
  __resizing = null;
  document.documentElement.classList.remove('resizing');
});


// ============================
// Google Sign-In init
// ============================
function initGoogleButton() {
  if (!(window.google && google.accounts && google.accounts.id)) {
    setTimeout(initGoogleButton, 200);
    return;
  }

  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: onGoogleSignIn,
    auto_select: false,
    cancel_on_tap_outside: true,
  });

  const googleBtn = $id("googleBtn");
  if (googleBtn) {
    googleBtn.innerHTML = "";
    google.accounts.id.renderButton(googleBtn, {
      theme: "outline",
      size: "large",
      text: "signin_with",
      shape: "pill",
      width: 280,
    });
  }
}

async function onGoogleSignIn(response) {
  setLoginError("");
  setAppError("");

  try {
    saveToken(response.credential);

    setAppAuthedUI(true);
    $id("userBox").innerText = "Validando usuario...";

    setGlobalLoading(true, "Validando usuario...");
    await validateAuthOrThrow();

    $id("userBox").innerText += " · Cargando...";
    setGlobalLoading(true, "Cargando datos...");
    await bootData();

    setGlobalLoading(false);
    toast({ title: "Sesion iniciada", message: "Autenticacion exitosa.", variant: "ok" });
  } catch (e) {
    console.error(e);
    setGlobalLoading(false);

    if (e?.__auth_error) {
      saveToken(null);
      setAppAuthedUI(false);
      $id("userBox").innerText = "";
      setLoginError(e.message || "No autorizado.");
      toast({ title: "Acceso denegado", message: e.message || "No autorizado.", variant: "error" });
      return;
    }

    setAppAuthedUI(true);
    setAppError("Autenticacion OK, pero fallo la carga de datos. Detalle: " + (e?.message || String(e)));
    toast({ title: "Error", message: "Fallo la carga inicial de datos.", variant: "error" });
  }
}

function logout() {
  saveToken(null);
  CURRENT_USER = null;
  setAppAuthedUI(false);
  $id("userBox").innerText = "";
  setLoginError("");
  setAppError("");

  closeModal("modalNewGestion");
  closeModal("modalChangeState");
  closeModal("modalEventos");
  closeDrawer();

  try { window.google?.accounts?.id?.disableAutoSelect(); } catch { }
  initGoogleButton();

  toast({ title: "Sesion cerrada", message: "Hasta luego.", variant: "ok" });
}

// ============================
// API helper
// ============================
async function api(path, opts = {}) {
  opts.headers = opts.headers || {};
  if (idToken) opts.headers["Authorization"] = `Bearer ${idToken}`;

  if (opts.body && typeof opts.body !== "string") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }

  opts.cache = "no-store";

  const res = await fetch(API_BASE + path, opts);
  const ct = res.headers.get("content-type") || "";
  const bodyText = await res.text();

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}: ${bodyText}`);
    err.status = res.status;
    err.body = bodyText;
    throw err;
  }

  if (ct.includes("application/json")) {
    try { return JSON.parse(bodyText); } catch { return bodyText; }
  }
  return bodyText;
}

// ============================
// Boot / Wire
// ============================
let WIRED = false;
const debouncedSearchReload = debounce(() => loadGestiones(true), 250);

function wireUI() {
  if (WIRED) return;
  WIRED = true;

  // filtros
  $id("estadoFilter")?.addEventListener("change", () => loadGestiones(true));
  $id("ministerioFilter")?.addEventListener("change", () => loadGestiones(true));
  $id("categoriaFilter")?.addEventListener("change", () => loadGestiones(true));
  $id("tipoGestionFilter")?.addEventListener("change", () => loadGestiones(true));
  $id("canalOrigenFilter")?.addEventListener("change", () => loadGestiones(true));

  $id("departamentoFilter")?.addEventListener("change", onDepartamentoFilterChange);
  $id("localidadFilter")?.addEventListener("change", () => loadGestiones(true));

  // busqueda
  $id("searchInput")?.addEventListener("input", (e) => {
    LAST_SEARCH = e.target.value || "";
    debouncedSearchReload();
  });

  // tabs
  $id("tab-gestiones")?.addEventListener("click", () => setTab("gestiones"));
  $id("tab-tablero")?.addEventListener("click", () => setTab("tablero"));
  $id("tab-resumen-territorial")?.addEventListener("click", () => setTab("resumen-territorial"));
  $id("tab-resumen")?.addEventListener("click", () => setTab("resumen-territorial"));
  $id("tab-usuarios")?.addEventListener("click", () => setTab("usuarios"));

  // paginador
  $id("btnPrev")?.addEventListener("click", () => pagePrev());
  $id("btnNext")?.addEventListener("click", () => pageNext());

  // logout
  $id("btnLogout")?.addEventListener("click", logout);

  // modal localidades
  $id("ng_departamento")?.addEventListener("change", onNewGestionDeptoChange);
  $id("cs_departamento")?.addEventListener("change", onChangeStateDeptoChange);

  // columnas
  $id("btnColumns")?.addEventListener("click", () => openPopover("btnColumns", "columnsPanel"));
  $id("btnColumnsAll")?.addEventListener("click", setAllColsVisible);
  $id("btnColumnsMinimal")?.addEventListener("click", setOnlyImportantCols);
  $id("btnColumnsReset")?.addEventListener("click", resetColsToDefault);

  // recargar tablero
  $id("btnReloadDashboard")?.addEventListener("click", reloadDashboard);
  $id("rt_departamento")?.addEventListener("change", onResumenTerritorialDeptoChange);
  $id("rt_localidad")?.addEventListener("change", onResumenTerritorialLocalidadChange);
  $id("btnResumenVer")?.addEventListener("click", loadResumenTerritorial);
  $id("btnLoadResumen")?.addEventListener("click", loadResumenTerritorial);
  $id("btnResumenLimpiar")?.addEventListener("click", clearResumenTerritorial);
  $id("btnClearResumen")?.addEventListener("click", clearResumenTerritorial);
  $id("btnResumenExport")?.addEventListener("click", exportResumenTerritorialPdf);
  $id("appDialogConfirm")?.addEventListener("click", () => closeAppDialog(true));
  $id("appDialogCancel")?.addEventListener("click", () => closeAppDialog(false));
  $id("appDialogCloseBtn")?.addEventListener("click", () => closeAppDialog(false));
  $id("appDialogOverlay")?.addEventListener("click", () => closeAppDialog(false));

  // click afuera para cerrar popover
  document.addEventListener("click", (e) => {
    const panel = $id("columnsPanel");
    const btn = $id("btnColumns");
    if (!panel || !btn) return;
    if (panel.classList.contains("hidden")) return;
    const t = e.target;
    if (panel.contains(t) || btn.contains(t)) return;
    closePopover("btnColumns", "columnsPanel");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModal("modalNewGestion");
      closeModal("modalChangeState");
      closeModal("modalEventos");
      closeAppDialog(false);
      closeDrawer();
      closePopover("btnColumns", "columnsPanel");
    }
  });
}

async function validateAuthOrThrow() {
  try {
    const me = await api(`/me`);
    CURRENT_USER = me;

    const label = [me.nombre, me.email, me.rol].filter(Boolean).join(" · ");
    $id("userBox").innerText = label || "Autenticado";

    const tabUsuarios = $id("tab-usuarios");
    if (isAdmin()) show(tabUsuarios);
    else hide(tabUsuarios);

    const savedTab = sessionStorage.getItem("activeTab");
    if (savedTab && ["gestiones", "tablero", "resumen-territorial", "usuarios"].includes(savedTab)) {
      if (savedTab === "usuarios" && !isAdmin()) setTab("gestiones");
      else setTab(savedTab);
    } else {
      setTab("gestiones");
    }
  } catch (e) {
    const authErr = new Error("No autorizado o error de autenticacion. Detalle: " + (e?.message || String(e)));
    authErr.__auth_error = true;
    throw authErr;
  }
}

async function bootData() {
  wireUI();
  setAppError("");
  loadVisibleCols();
  loadColWidths();
  ensureMinimumCols();
  buildColumnsUI();
  await loadCatalogos();
  await loadGestiones(true);
}

// ============================
// Tabs
// ============================
function setTab(tab) {
  CURRENT_TAB = tab;
  sessionStorage.setItem("activeTab", tab);

  $id("tab-gestiones")?.classList.toggle("active", tab === "gestiones");
  $id("tab-tablero")?.classList.toggle("active", tab === "tablero");
  $id("tab-resumen-territorial")?.classList.toggle("active", tab === "resumen-territorial");
  $id("tab-resumen")?.classList.toggle("active", tab === "resumen-territorial");
  $id("tab-usuarios")?.classList.toggle("active", tab === "usuarios");

  const panes = {
    gestiones: $id("view-gestiones"),
    tablero: $id("view-tablero"),
    "resumen-territorial": $id("view-resumen-territorial") || $id("view-resumen"),
    usuarios: $id("view-usuarios"),
  };
  Object.entries(panes).forEach(([k, el]) => el && el.classList.toggle("hidden", k !== tab));

  if (tab === "usuarios") {
    if (!isAdmin()) {
      setTab("gestiones");
      return;
    }
    loadUsers().catch(e => {
      console.error(e);
      setAppError("No se pudo cargar Usuarios. " + (e?.message || String(e)));
    });
  }

  if (tab === "tablero") {
    // Intento suave: recarga solo el iframe (sin recargar toda la app)
    // Esto ayuda cuando Looker embed tarda en cargar al primer ingreso.
    setTimeout(() => reloadDashboard({ silent: true }), 250);
  }

  if (tab === "resumen-territorial" && RESUMEN_TERRITORIAL.departamento && !RESUMEN_TERRITORIAL.data) {
    loadResumenTerritorial().catch((e) => {
      console.error(e);
      setAppError("No se pudo cargar el resumen territorial. " + (e?.message || String(e)));
    });
  }
}

// ============================
// Modales + Drawer
// ============================
let LAST_FOCUS = null;
let APP_DIALOG_RESOLVE = null;

function focusFirstIn(container) {
  if (!container) return;
  const focusable = container.querySelector("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
  if (focusable) focusable.focus({ preventScroll: true });
}

function openModal(id) {
  const el = $id(id);
  if (!el) return;
  LAST_FOCUS = document.activeElement;
  el.classList.remove("hidden");
  el.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  focusFirstIn(el);
}

function closeModal(id) {
  const el = $id(id);
  if (!el) return;
  el.classList.add("hidden");
  el.setAttribute("aria-hidden", "true");

  const anyOpen = Array.from(document.querySelectorAll(".modal")).some(m => !m.classList.contains("hidden"));
  if (!anyOpen) document.body.classList.remove("modal-open");

  try { LAST_FOCUS?.focus?.({ preventScroll: true }); } catch { }
}

function openAppDialog({
  title = "Infra Gestion",
  subtitle = "Mensaje del sistema",
  message = "",
  confirmText = "Aceptar",
  cancelText = "",
} = {}) {
  const modal = $id("modalAppDialog");
  const titleEl = $id("appDialogTitle");
  const subtitleEl = $id("appDialogSubtitle");
  const messageEl = $id("appDialogMessage");
  const confirmBtn = $id("appDialogConfirm");
  const cancelBtn = $id("appDialogCancel");

  if (!modal || !titleEl || !subtitleEl || !messageEl || !confirmBtn || !cancelBtn) {
    return Promise.resolve(false);
  }

  titleEl.textContent = title;
  subtitleEl.textContent = subtitle;
  messageEl.textContent = message;
  confirmBtn.textContent = confirmText || "Aceptar";
  cancelBtn.textContent = cancelText || "Cancelar";
  cancelBtn.classList.toggle("hidden", !cancelText);

  openModal("modalAppDialog");

  return new Promise((resolve) => {
    APP_DIALOG_RESOLVE = resolve;
  });
}

function closeAppDialog(result = false) {
  closeModal("modalAppDialog");
  if (typeof APP_DIALOG_RESOLVE === "function") {
    const resolve = APP_DIALOG_RESOLVE;
    APP_DIALOG_RESOLVE = null;
    resolve(result);
  }
}

function openDrawer() {
  const el = $id("drawer");
  if (!el) return;
  LAST_FOCUS = document.activeElement;
  el.classList.remove("hidden");
  el.setAttribute("aria-hidden", "false");
  focusFirstIn(el);
}

function closeDrawer() {
  const el = $id("drawer");
  if (!el) return;
  el.classList.add("hidden");
  el.setAttribute("aria-hidden", "true");
  try { LAST_FOCUS?.focus?.({ preventScroll: true }); } catch { }
}

// ============================
// Dashboard reload
// ============================
let DASHBOARD_BASE_SRC = null;
function reloadDashboard({ silent = false } = {}) {
  const frame = $id("dashboardFrame");
  if (!frame) return;
  if (!DASHBOARD_BASE_SRC) {
    DASHBOARD_BASE_SRC = frame.getAttribute("src") || "";
  }
  const base = DASHBOARD_BASE_SRC;
  const sep = base.includes("?") ? "&" : "?";
  frame.setAttribute("src", base + sep + "cacheBust=" + Date.now());
  if (!silent) toast({ title: "Tablero", message: "Recargando Looker...", variant: "ok" });
}

// ============================
// Catalogos
// ============================
function defaultTiposGestion() {
  return [
    { id: "CONSULTA", nombre: "Consulta" },
    { id: "DEMANDA", nombre: "Demanda" },
    { id: "PROYECTO", nombre: "Proyecto" },
    { id: "EXPEDIENTE", nombre: "Expediente" },
    { id: "OTRO", nombre: "Otro" },
  ];
}

function defaultCanalesOrigen() {
  return [
    { id: "AGENDA_REUNIONES", nombre: "Agenda de reuniones" },
    { id: "TELEFONO_FUNCIONARIO", nombre: "Telefono del funcionario" },
    { id: "ENCUENTRO_EVENTO", nombre: "Encuentro / acto / evento" },
    { id: "WHATSAPP", nombre: "WhatsApp" },
    { id: "MAIL", nombre: "Mail" },
    { id: "OTRO", nombre: "Otro" },
  ];
}

async function loadCatalogos() {
  const [estados, urgencias, ministerios, categorias, departamentos] = await Promise.all([
    api(`/catalogos/estados`),
    api(`/catalogos/urgencias`),
    api(`/catalogos/ministerios`),
    api(`/catalogos/categorias`),
    api(`/catalogos/departamentos`),
  ]);

  CATALOGOS.estados = estados || [];
  CATALOGOS.urgencias = urgencias || [];
  CATALOGOS.ministerios = ministerios || [];
  CATALOGOS.categorias = categorias || [];
  CATALOGOS.departamentos = departamentos || [];

  CATALOGOS.tiposGestion = defaultTiposGestion();
  CATALOGOS.canalesOrigen = defaultCanalesOrigen();

  fillSelectFromCatalog("estadoFilter", CATALOGOS.estados, { valueKey: "nombre", labelKey: "nombre", firstLabel: "(Todos)" });
  fillSelectFromCatalog("ministerioFilter", CATALOGOS.ministerios, { valueKey: "id", labelKey: "nombre", firstLabel: "(Todos)" });
  fillSelectFromCatalog("categoriaFilter", CATALOGOS.categorias, { valueKey: "id", labelKey: "nombre", firstLabel: "(Todos)" });
  fillSelectFromList("departamentoFilter", CATALOGOS.departamentos, "(Todos)");
  fillSelectFromList("rt_departamento", CATALOGOS.departamentos, "(Seleccionar)");

  // nuevos filtros
  fillSelectFromCatalog("tipoGestionFilter", CATALOGOS.tiposGestion, { valueKey: "id", labelKey: "nombre", firstLabel: "(Todos)" });
  fillSelectFromCatalog("canalOrigenFilter", CATALOGOS.canalesOrigen, { valueKey: "id", labelKey: "nombre", firstLabel: "(Todos)" });

  // modal new
  fillSelectFromCatalog("ng_ministerio", CATALOGOS.ministerios, { valueKey: "id", labelKey: "nombre", firstLabel: "(Seleccionar)" });
  fillSelectFromCatalog("ng_categoria", CATALOGOS.categorias, { valueKey: "id", labelKey: "nombre", firstLabel: "(Seleccionar)" });
  fillSelectFromCatalog("ng_urgencia", CATALOGOS.urgencias, { valueKey: "nombre", labelKey: "nombre", firstLabel: "(Seleccionar)" });
  fillSelectFromList("ng_departamento", CATALOGOS.departamentos, "(Seleccionar)");

  fillSelectFromCatalog("ng_tipo_gestion", CATALOGOS.tiposGestion, { valueKey: "id", labelKey: "nombre", firstLabel: "(Seleccionar)" });
  fillSelectFromCatalog("ng_canal_origen", CATALOGOS.canalesOrigen, { valueKey: "id", labelKey: "nombre", firstLabel: "(Seleccionar)" });

  fillSelectFromCatalog("cs_nuevo_estado", CATALOGOS.estados, { valueKey: "nombre", labelKey: "nombre", firstLabel: "(Seleccionar)" });
  fillSelectFromList("cs_departamento", CATALOGOS.departamentos, "(Seleccionar)");
  const csLocSel = $id("cs_localidad");
  if (csLocSel) {
    csLocSel.innerHTML = `<option value="">(Seleccionar)</option>`;
    csLocSel.disabled = true;
  }

  const locSel = $id("localidadFilter");
  if (locSel) {
    locSel.innerHTML = `<option value="">(Todas)</option>`;
    locSel.disabled = true;
  }

  const rtLocSel = $id("rt_localidad");
  if (rtLocSel) {
    rtLocSel.innerHTML = `<option value="">(Seleccionar)</option>`;
    rtLocSel.disabled = true;
  }
}

function fillSelectFromCatalog(selectId, arr, { valueKey, labelKey, firstLabel }) {
  const sel = $id(selectId);
  if (!sel) return;

  sel.innerHTML = "";
  const first = document.createElement("option");
  first.value = "";
  first.textContent = firstLabel || "(Seleccionar)";
  sel.appendChild(first);

  (arr || []).forEach((item) => {
    const opt = document.createElement("option");
    opt.value = item[valueKey] ?? "";
    opt.textContent = item[labelKey] ?? "";
    sel.appendChild(opt);
  });
}

function fillSelectFromList(selectId, list, firstLabel) {
  const sel = $id(selectId);
  if (!sel) return;

  sel.innerHTML = "";
  const first = document.createElement("option");
  first.value = "";
  first.textContent = firstLabel || "(Seleccionar)";
  sel.appendChild(first);

  (list || []).forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  });
}

// ============================
// Localidades
// ============================
async function getLocalidadesByDepto(departamento) {
  if (!departamento) return [];
  if (CATALOGOS.localidadesByDepto.has(departamento)) return CATALOGOS.localidadesByDepto.get(departamento);
  const locs = await api(`/catalogos/localidades?departamento=${encodeURIComponent(departamento)}`);
  CATALOGOS.localidadesByDepto.set(departamento, locs || []);
  return locs || [];
}

async function onNewGestionDeptoChange() {
  const depto = $id("ng_departamento")?.value || "";
  const selLoc = $id("ng_localidad");
  if (!selLoc) return;

  selLoc.innerHTML = `<option value="">(Seleccionar)</option>`;
  if (!depto) return;

  const locs = await getLocalidadesByDepto(depto);
  locs.forEach((l) => {
    const opt = document.createElement("option");
    opt.value = l;
    opt.textContent = l;
    selLoc.appendChild(opt);
  });
}

async function onChangeStateDeptoChange() {
  const depto = $id("cs_departamento")?.value || "";
  const selLoc = $id("cs_localidad");
  if (!selLoc) return;

  selLoc.innerHTML = `<option value="">(Seleccionar)</option>`;
  selLoc.disabled = !depto;
  if (!depto) return;

  const locs = await getLocalidadesByDepto(depto);
  locs.forEach((l) => {
    const opt = document.createElement("option");
    opt.value = l;
    opt.textContent = l;
    selLoc.appendChild(opt);
  });
}

async function onDepartamentoFilterChange() {
  const depto = $id("departamentoFilter")?.value || "";
  const locSel = $id("localidadFilter");
  if (!locSel) return;

  locSel.innerHTML = `<option value="">(Todas)</option>`;
  locSel.value = "";
  locSel.disabled = !depto;

  if (depto) {
    const locs = await getLocalidadesByDepto(depto);
    locs.forEach((l) => {
      const opt = document.createElement("option");
      opt.value = l;
      opt.textContent = l;
      locSel.appendChild(opt);
    });
  }
  await loadGestiones(true);
}

function resumenFieldRow(label, value) {
  const safeValue = value == null || value === "" ? "-" : String(value);
  return `
    <div class="resumen-field">
      <span class="resumen-field-label">${escapeHtml(label)}</span>
      <span class="resumen-field-value">${escapeHtml(safeValue)}</span>
    </div>
  `;
}

function resumenSemaforoRow(label, value) {
  if (!value) return resumenFieldRow(label, null);
  const cls = `semaforo-badge semaforo-${escapeHtml(value.toLowerCase())}`;
  return `
    <div class="resumen-field">
      <span class="resumen-field-label">${escapeHtml(label)}</span>
      <span class="${cls}">${escapeHtml(value)}</span>
    </div>
  `;
}

function renderResumenTerritorialEmpty(message = "Selecciona un departamento o una localidad para ver el resumen.") {
  const host = $id("resumenTerritorialContent") || $id("summaryContent");
  if (!host) return;
  host.innerHTML = `
    <div class="card resumen-empty">
      <h4 class="h4">Resumen territorial</h4>
      <p class="hint">${escapeHtml(message)}</p>
    </div>
  `;
}

function getResumenSelection() {
  return {
    departamento: $id("rt_departamento")?.value || "",
    localidad: $id("rt_localidad")?.value || "",
  };
}

async function onResumenTerritorialDeptoChange() {
  const depto = $id("rt_departamento")?.value || "";
  const locSel = $id("rt_localidad");
  if (!locSel) return;

  RESUMEN_TERRITORIAL.departamento = depto;
  RESUMEN_TERRITORIAL.localidad = "";
  RESUMEN_TERRITORIAL.data = null;
  RESUMEN_TERRITORIAL.editing = false;

  locSel.innerHTML = `<option value="">(Seleccionar)</option>`;
  locSel.value = "";
  locSel.disabled = !depto;

  if (!depto) {
    renderResumenTerritorialEmpty();
    return;
  }

  const locs = await getLocalidadesByDepto(depto);
  locs.forEach((l) => {
    const opt = document.createElement("option");
    opt.value = l;
    opt.textContent = l;
    locSel.appendChild(opt);
  });
  renderResumenTerritorialEmpty("Selecciona una localidad para ver el resumen de la localidad, o deja localidad vacia para ver todo el departamento.");
}

function onResumenTerritorialLocalidadChange() {
  RESUMEN_TERRITORIAL.localidad = $id("rt_localidad")?.value || "";
  RESUMEN_TERRITORIAL.data = null;
  RESUMEN_TERRITORIAL.editing = false;
}

function normalizarResumenFecha(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function parseMetadata(metadata) {
  if (!metadata) return null;
  if (typeof metadata === "object") return metadata;
  try {
    return JSON.parse(metadata);
  } catch {
    return null;
  }
}

function getMinisterioNombre(value) {
  if (!value) return "-";
  const minMap = new Map((CATALOGOS.ministerios || []).map((m) => [m.id, m.nombre]));
  return minMap.get(value) || String(value);
}

function getResumenUrgenciaClass(value) {
  const urgencia = String(value || "").trim().toLowerCase();
  if (urgencia === "alta") return "chip-priority chip-priority--alta";
  if (urgencia === "media") return "chip-priority chip-priority--media";
  if (urgencia === "baja") return "chip-priority chip-priority--baja";
  return "chip-priority";
}

function renderResumenEvento(evento) {
  const tipo = pick(evento, "tipo_evento") || "-";
  const fecha = normalizarResumenFecha(pick(evento, "fecha_evento"));
  const usuario = pick(evento, "usuario") || "-";
  const rol = pick(evento, "rol_usuario") || "-";
  const estadoAnterior = pick(evento, "estado_anterior") || "-";
  const estadoNuevo = pick(evento, "estado_nuevo") || "-";
  const comentario = pick(evento, "comentario") || "";
  const campoModificado = pick(evento, "campo_modificado") || "";
  const valorAnterior = pick(evento, "valor_anterior");
  const valorNuevo = pick(evento, "valor_nuevo");
  const meta = parseMetadata(pick(evento, "metadata_json")) || {};
  const ministerioIngreso = getMinisterioNombre(meta.ministerio_agencia_id);
  const ministerioDerivado = getMinisterioNombre(meta.derivado_a || meta.derivado_a_id);

  const metaLines = [];
  if (campoModificado) {
    metaLines.push(`<span class="resumen-event-tag">Campo: ${escapeHtml(campoModificado)}</span>`);
  }
  if (meta.departamento) metaLines.push(`<span class="resumen-event-tag">Departamento: ${escapeHtml(meta.departamento)}</span>`);
  if (meta.localidad) metaLines.push(`<span class="resumen-event-tag">Localidad: ${escapeHtml(meta.localidad)}</span>`);
  if (meta.nro_expediente) metaLines.push(`<span class="resumen-event-tag">Expediente: ${escapeHtml(meta.nro_expediente)}</span>`);
  if (meta.fecha_ingreso) metaLines.push(`<span class="resumen-event-tag">Ingreso: ${escapeHtml(String(meta.fecha_ingreso))}</span>`);

  return `
    <div class="resumen-evento">
      <div class="resumen-evento-line"></div>
      <div class="resumen-evento-content">
        <div class="resumen-evento-head">
          <strong>${escapeHtml(tipo)}</strong>
          <span>${escapeHtml(fecha || "-")}</span>
        </div>
        <div class="resumen-evento-meta">${escapeHtml(usuario)} · ${escapeHtml(rol)}</div>
        <div class="resumen-evento-state">Estado: ${escapeHtml(estadoAnterior)} → ${escapeHtml(estadoNuevo)}</div>
        ${tipo === "CREACION" ? `<div class="resumen-evento-state">Ministerio: ${escapeHtml(ministerioIngreso)}</div>` : ``}
        ${tipo === "CAMBIO_ESTADO" && (meta.derivado_a || meta.derivado_a_id) ? `<div class="resumen-evento-state">Ministerio destino: ${escapeHtml(ministerioDerivado)}</div>` : ``}
        ${campoModificado ? `<div class="resumen-evento-state">Cambio: ${escapeHtml(campoModificado)} | ${escapeHtml(valorAnterior ?? "-")} → ${escapeHtml(valorNuevo ?? "-")}</div>` : ``}
        ${comentario ? `<div class="resumen-evento-comment">${escapeHtml(comentario)}</div>` : ``}
        ${metaLines.length ? `<div class="resumen-evento-tags">${metaLines.join("")}</div>` : ``}
      </div>
    </div>
  `;
}

function renderResumenGestion(item) {
  const gestion = item?.gestion || {};
  const eventos = Array.isArray(item?.eventos) ? item.eventos : [];
  const catMap = new Map((CATALOGOS.categorias || []).map((c) => [c.id, c.nombre]));
  const tipoMap = new Map((CATALOGOS.tiposGestion || []).map((t) => [t.id, t.nombre]));
  const canalMap = new Map((CATALOGOS.canalesOrigen || []).map((c) => [c.id, c.nombre]));

  const ministerio = getMinisterioNombre(pick(gestion, "ministerio_agencia_id"));
  const categoria = catMap.get(pick(gestion, "categoria_general_id")) || pick(gestion, "categoria_general_id") || "-";
  const tipoGestion = tipoMap.get(pick(gestion, "tipo_gestion")) || pick(gestion, "tipo_gestion") || "-";
  const canalOrigen = canalMap.get(pick(gestion, "canal_origen")) || pick(gestion, "canal_origen") || "-";
  const sticker = pick(gestion, "nro_expediente") || "-";
  const costo = pick(gestion, "costo_estimado");
  const moneda = pick(gestion, "costo_moneda");
  const costoText = costo == null || costo === "" ? "-" : `${costo}${moneda ? ` ${moneda}` : ""}`;
  const urgencia = pick(gestion, "urgencia") || "-";
  const estado = pick(gestion, "estado") || "-";

  return `
    <article class="card resumen-gestion-card">
      <div class="resumen-gestion-head">
        <div>
          <h4 class="h4">Gestion ${escapeHtml(pick(gestion, "id_gestion") || "-")}</h4>
          <p class="hint">${escapeHtml(pick(gestion, "departamento") || "")} · ${escapeHtml(pick(gestion, "localidad") || "")}</p>
        </div>
        <div class="resumen-gestion-badges">
          <div class="chip chip-stack">
            <span class="chip-stack-label">Estado:</span>
            <span class="chip-stack-value">${escapeHtml(estado)}</span>
          </div>
          <div class="${escapeHtml(getResumenUrgenciaClass(urgencia))} chip-stack">
            <span class="chip-stack-label">Prioridad:</span>
            <span class="chip-stack-value">${escapeHtml(urgencia)}</span>
          </div>
        </div>
      </div>

      <div class="resumen-gestion-grid">
        ${resumenFieldRow("Ministerio", ministerio)}
        ${resumenFieldRow("Categoria", categoria)}
        ${resumenFieldRow("Tipo gestion", tipoGestion)}
        ${resumenFieldRow("Canal origen", canalOrigen)}
        ${resumenFieldRow("Detalle", pick(gestion, "detalle"))}
        ${resumenFieldRow("Subtipo detalle", pick(gestion, "subtipo_detalle"))}
        ${resumenFieldRow("Observaciones", pick(gestion, "observaciones"))}
        ${resumenFieldRow("Sticker", sticker)}
        ${resumenFieldRow("Fecha ingreso", normalizarResumenFecha(pick(gestion, "fecha_ingreso")))}
        ${resumenFieldRow("Costo estimado", costoText)}
        ${resumenFieldRow("Direccion", pick(gestion, "direccion"))}
      </div>

      <div class="resumen-timeline">
        <div class="resumen-section-title">Timeline de eventos</div>
        ${eventos.length ? eventos.map(renderResumenEvento).join("") : `<p class="hint">Sin eventos registrados.</p>`}
      </div>
    </article>
  `;
}

function renderResumenTerritorialLegacy() {
  const host = $id("resumenTerritorialContent") || $id("summaryContent");
  const data = RESUMEN_TERRITORIAL.data;
  if (!host) return;
  if (!data) {
    renderResumenTerritorialEmpty();
    return;
  }

  const info = data.localidad_info || {};
  const metricas = data.metricas || {};
  const gestiones = Array.isArray(data.gestiones) ? data.gestiones : [];
  const editing = !!RESUMEN_TERRITORIAL.editing;

  host.innerHTML = `
    <div class="resumen-grid">
      <section class="card resumen-ficha-card print-block">
        <div class="resumen-card-head">
          <div>
            <h3 class="h3">Ficha de localidad</h3>
            <p class="hint">Información socio-política de la localidad.</p>
          </div>
          <div class="resumen-actions no-print">
            ${editing ? `
              <button class="btn primary" id="btnResumenGuardarFicha" type="button">Guardar</button>
              <button class="btn" id="btnResumenCancelarFicha" type="button">Cancelar</button>
            ` : `
              <button class="btn" id="btnResumenEditarFicha" type="button">Editar</button>
            `}
          </div>
        </div>

        ${editing ? `
          <div class="resumen-ficha-form">
            <label>Localidad
              <input id="rtf_localidad" type="text" value="${escapeHtml(info.localidad || "")}" disabled />
            </label>
            <label class="resumen-field-readonly">Tipo
              <input type="text" value="${escapeHtml(info.tipo_localidad || "-")}" disabled />
            </label>
            <label class="resumen-field-readonly">Semáforo político
              <span class="semaforo-badge semaforo-${escapeHtml((info.color_semaforo || "").toLowerCase())}">${escapeHtml(info.color_semaforo || "-")}</span>
            </label>
            <label>Habitantes
              <input id="rtf_habitantes" type="number" min="0" value="${escapeHtml(info.habitantes ?? "")}" />
            </label>
            <label>Electores
              <input id="rtf_electores" type="number" min="0" value="${escapeHtml(info.electores ?? "")}" />
            </label>
            <label>Intendente / Jefe comunal
              <input id="rtf_intendente" type="text" value="${escapeHtml(info.intendente_jefe_comunal || "")}" />
            </label>
            <label>Partido politico
              <input id="rtf_partido" type="text" value="${escapeHtml(info.partido_politico || "")}" />
            </label>
          </div>
        ` : `
          <div class="resumen-ficha-grid">
            ${resumenFieldRow("Departamento", info.departamento)}
            ${resumenFieldRow("Localidad", info.localidad)}
            ${resumenFieldRow("Tipo", info.tipo_localidad)}
            ${resumenSemaforoRow("Semáforo político", info.color_semaforo)}
            ${resumenFieldRow("Habitantes", info.habitantes)}
            ${resumenFieldRow("Electores", info.electores)}
            ${resumenFieldRow("Intendente / Jefe comunal", info.intendente_jefe_comunal)}
            ${resumenFieldRow("Partido politico", info.partido_politico)}
            ${resumenFieldRow("Ultima actualizacion", normalizarResumenFecha(info.updated_at))}
            ${resumenFieldRow("Actualizado por", info.updated_by)}
          </div>
        `}
      </section>

      <section class="resumen-kpis print-block">
        <div class="card resumen-kpi">
          <span>Total gestiones</span>
          <strong>${escapeHtml(metricas.total_gestiones ?? 0)}</strong>
        </div>
        <div class="card resumen-kpi">
          <span>Abiertas</span>
          <strong>${escapeHtml(metricas.abiertas ?? 0)}</strong>
        </div>
        <div class="card resumen-kpi">
          <span>Finalizadas</span>
          <strong>${escapeHtml(metricas.finalizadas ?? 0)}</strong>
        </div>
        <div class="card resumen-kpi">
          <span>Urgentes</span>
          <strong>${escapeHtml(metricas.urgentes ?? 0)}</strong>
        </div>
      </section>
    </div>

    <section class="resumen-listado print-block">
      <div class="card resumen-card-head">
        <div>
          <h3 class="h3">Gestiones de la localidad</h3>
          <p class="hint">${escapeHtml(String(gestiones.length))} registradas</p>
        </div>
      </div>
      <div class="resumen-gestiones-list">
        ${gestiones.length ? gestiones.map(renderResumenGestion).join("") : `<div class="card"><p class="hint">No hay gestiones para esta localidad.</p></div>`}
      </div>
    </section>
  `;

  $id("btnResumenEditarFicha")?.addEventListener("click", () => {
    RESUMEN_TERRITORIAL.editing = true;
    renderResumenTerritorial();
  });
  $id("btnResumenCancelarFicha")?.addEventListener("click", () => {
    RESUMEN_TERRITORIAL.editing = false;
    renderResumenTerritorial();
  });
  $id("btnResumenGuardarFicha")?.addEventListener("click", saveResumenTerritorialFicha);
}

async function loadResumenTerritorialLegacy() {
  const { departamento, localidad } = getResumenSelection();
  if (!departamento) return alert("Selecciona un departamento");
  if (!localidad) return alert("Selecciona una localidad");

  RESUMEN_TERRITORIAL.departamento = departamento;
  RESUMEN_TERRITORIAL.localidad = localidad;
  RESUMEN_TERRITORIAL.editing = false;

  setGlobalLoading(true, "Cargando resumen territorial...");
  try {
    const qs = new URLSearchParams({ departamento, localidad });
    const data = await api(`/gestiones/resumen-territorial?${qs.toString()}`);
    RESUMEN_TERRITORIAL.data = data;
    renderResumenTerritorial();
  } catch (e) {
    console.error(e);
    RESUMEN_TERRITORIAL.data = null;
    renderResumenTerritorialEmpty("No se pudo cargar el resumen territorial.");
    alert("No se pudo cargar el resumen territorial.\n\nDetalle: " + (e?.message || String(e)));
  } finally {
    setGlobalLoading(false);
  }
}

async function saveResumenTerritorialFichaLegacy() {
  if (!RESUMEN_TERRITORIAL.departamento || !RESUMEN_TERRITORIAL.localidad) return;

  const habitantesRaw = $id("rtf_habitantes")?.value ?? "";
  const electoresRaw = $id("rtf_electores")?.value ?? "";
  const payload = {
    departamento: RESUMEN_TERRITORIAL.departamento,
    localidad: RESUMEN_TERRITORIAL.localidad,
    habitantes: habitantesRaw === "" ? null : Number(habitantesRaw),
    electores: electoresRaw === "" ? null : Number(electoresRaw),
    intendente_jefe_comunal: ($id("rtf_intendente")?.value || "").trim() || null,
    partido_politico: ($id("rtf_partido")?.value || "").trim() || null,
  };

  setGlobalLoading(true, "Guardando ficha de localidad...");
  try {
    const info = await api(`/localidades-info`, { method: "PUT", body: payload });
    if (!RESUMEN_TERRITORIAL.data) RESUMEN_TERRITORIAL.data = {};
    RESUMEN_TERRITORIAL.data.localidad_info = info;
    RESUMEN_TERRITORIAL.editing = false;
    renderResumenTerritorial();
    toast({ title: "Ficha actualizada", message: `${payload.localidad}`, variant: "ok" });
  } catch (e) {
    console.error(e);
    alert("No se pudo guardar la ficha de localidad.\n\nDetalle: " + (e?.message || String(e)));
  } finally {
    setGlobalLoading(false);
  }
}

function renderResumenTerritorial() {
  const host = $id("resumenTerritorialContent") || $id("summaryContent");
  const data = RESUMEN_TERRITORIAL.data;
  if (!host) return;
  if (!data) {
    renderResumenTerritorialEmpty();
    return;
  }

  const isDepartamento = data.scope === "departamento";
  const info = data.territorio_info || data.localidad_info || data.departamento_info || {};
  const metricas = data.metricas || {};
  const gestiones = Array.isArray(data.gestiones) ? data.gestiones : [];
  const editing = !isDepartamento && !!RESUMEN_TERRITORIAL.editing;
  const fichaTitulo = isDepartamento ? "Ficha de Departamento" : "Ficha de localidad";
  const fichaDescripcion = isDepartamento
    ? "Informacion socio-politica del departamento"
    : "Informacion socio-politica de la localidad.";
  const listadoTitulo = isDepartamento ? "Gestiones del departamento" : "Gestiones de la localidad";
  const listadoVacio = isDepartamento ? "No hay gestiones para este departamento." : "No hay gestiones para esta localidad.";

  host.innerHTML = `
    <div class="resumen-grid">
      <section class="card resumen-ficha-card print-block">
        <div class="resumen-card-head">
          <div>
            <h3 class="h3">${escapeHtml(fichaTitulo)}</h3>
            <p class="hint">${escapeHtml(fichaDescripcion)}</p>
          </div>
          <div class="resumen-actions no-print">
            ${editing ? `
              <button class="btn primary" id="btnResumenGuardarFicha" type="button">Guardar</button>
              <button class="btn" id="btnResumenCancelarFicha" type="button">Cancelar</button>
            ` : !isDepartamento ? `
              <button class="btn" id="btnResumenEditarFicha" type="button">Editar</button>
            ` : ``}
          </div>
        </div>

        ${editing ? `
          <div class="resumen-ficha-form">
            <label>Localidad
              <input id="rtf_localidad" type="text" value="${escapeHtml(info.localidad || "")}" disabled />
            </label>
            <label class="resumen-field-readonly">Tipo
              <input type="text" value="${escapeHtml(info.tipo_localidad || "-")}" disabled />
            </label>
            <label class="resumen-field-readonly">Semáforo político
              <span class="semaforo-badge semaforo-${escapeHtml((info.color_semaforo || "").toLowerCase())}">${escapeHtml(info.color_semaforo || "-")}</span>
            </label>
            <label>Habitantes
              <input id="rtf_habitantes" type="number" min="0" value="${escapeHtml(info.habitantes ?? "")}" />
            </label>
            <label>Electores
              <input id="rtf_electores" type="number" min="0" value="${escapeHtml(info.electores ?? "")}" />
            </label>
            <label>Intendente / Jefe comunal
              <input id="rtf_intendente" type="text" value="${escapeHtml(info.intendente_jefe_comunal || "")}" />
            </label>
            <label>Partido politico
              <input id="rtf_partido" type="text" value="${escapeHtml(info.partido_politico || "")}" />
            </label>
          </div>
        ` : `
          <div class="resumen-ficha-grid">
            ${isDepartamento ? `
              ${resumenFieldRow("Departamento", info.departamento)}
              ${resumenFieldRow("Habitantes", info.habitantes)}
              ${resumenFieldRow("Electores", info.electores)}
              ${resumenFieldRow("Legislador departamental", info.legislador_departamental)}
              ${resumenFieldRow("Partido politico", info.partido_politico)}
              ${resumenFieldRow("Legislador sabana 1", info.legislador_sabana1)}
              ${resumenFieldRow("Partido politico (sabana 1)", info.partido_politico_sabana1)}
              ${resumenFieldRow("Legislador sabana 2", info.legislador_sabana2)}
              ${resumenFieldRow("Partido politico (sabana 2)", info.partido_politico_sabana2)}
              ${resumenFieldRow("Ultima actualizacion", normalizarResumenFecha(info.updated_at))}
              ${resumenFieldRow("Actualizado por", info.updated_by)}
            ` : `
              ${resumenFieldRow("Departamento", info.departamento)}
              ${resumenFieldRow("Localidad", info.localidad)}
              ${resumenFieldRow("Tipo", info.tipo_localidad)}
              ${resumenSemaforoRow("Semáforo político", info.color_semaforo)}
              ${resumenFieldRow("Habitantes", info.habitantes)}
              ${resumenFieldRow("Electores", info.electores)}
              ${resumenFieldRow("Intendente / Jefe comunal", info.intendente_jefe_comunal)}
              ${resumenFieldRow("Partido politico", info.partido_politico)}
              ${resumenFieldRow("Ultima actualizacion", normalizarResumenFecha(info.updated_at))}
              ${resumenFieldRow("Actualizado por", info.updated_by)}
            `}
          </div>
        `}
      </section>

      <section class="resumen-kpis print-block">
        <div class="card resumen-kpi">
          <span>Total gestiones</span>
          <strong>${escapeHtml(metricas.total_gestiones ?? 0)}</strong>
        </div>
        <div class="card resumen-kpi">
          <span>Abiertas</span>
          <strong>${escapeHtml(metricas.abiertas ?? 0)}</strong>
        </div>
        <div class="card resumen-kpi">
          <span>Finalizadas</span>
          <strong>${escapeHtml(metricas.finalizadas ?? 0)}</strong>
        </div>
        <div class="card resumen-kpi">
          <span>Urgentes</span>
          <strong>${escapeHtml(metricas.urgentes ?? 0)}</strong>
        </div>
      </section>
    </div>

    <section class="resumen-listado print-block">
      <div class="card resumen-card-head">
        <div>
          <h3 class="h3">${escapeHtml(listadoTitulo)}</h3>
          <p class="hint">${escapeHtml(String(gestiones.length))} registradas</p>
        </div>
      </div>
      <div class="resumen-gestiones-list">
        ${gestiones.length ? gestiones.map(renderResumenGestion).join("") : `<div class="card"><p class="hint">${escapeHtml(listadoVacio)}</p></div>`}
      </div>
    </section>
  `;

  $id("btnResumenEditarFicha")?.addEventListener("click", () => {
    RESUMEN_TERRITORIAL.editing = true;
    renderResumenTerritorial();
  });
  $id("btnResumenCancelarFicha")?.addEventListener("click", () => {
    RESUMEN_TERRITORIAL.editing = false;
    renderResumenTerritorial();
  });
  $id("btnResumenGuardarFicha")?.addEventListener("click", saveResumenTerritorialFicha);
}

async function loadResumenTerritorial() {
  const { departamento, localidad } = getResumenSelection();
  if (!departamento) return alert("Selecciona un departamento");

  RESUMEN_TERRITORIAL.departamento = departamento;
  RESUMEN_TERRITORIAL.localidad = localidad;
  RESUMEN_TERRITORIAL.editing = false;

  setGlobalLoading(true, "Cargando resumen territorial...");
  try {
    const qs = new URLSearchParams({ departamento });
    if (localidad) qs.set("localidad", localidad);
    const data = await api(`/gestiones/resumen-territorial?${qs.toString()}`);
    RESUMEN_TERRITORIAL.data = data;
    renderResumenTerritorial();
  } catch (e) {
    console.error(e);
    RESUMEN_TERRITORIAL.data = null;
    renderResumenTerritorialEmpty("No se pudo cargar el resumen territorial.");
    alert("No se pudo cargar el resumen territorial.\n\nDetalle: " + (e?.message || String(e)));
  } finally {
    setGlobalLoading(false);
  }
}

async function saveResumenTerritorialFicha() {
  if (!RESUMEN_TERRITORIAL.departamento || !RESUMEN_TERRITORIAL.localidad) return;

  const habitantesRaw = $id("rtf_habitantes")?.value ?? "";
  const electoresRaw = $id("rtf_electores")?.value ?? "";
  const payload = {
    departamento: RESUMEN_TERRITORIAL.departamento,
    localidad: RESUMEN_TERRITORIAL.localidad,
    habitantes: habitantesRaw === "" ? null : Number(habitantesRaw),
    electores: electoresRaw === "" ? null : Number(electoresRaw),
    intendente_jefe_comunal: ($id("rtf_intendente")?.value || "").trim() || null,
    partido_politico: ($id("rtf_partido")?.value || "").trim() || null,
  };

  setGlobalLoading(true, "Guardando ficha de localidad...");
  try {
    const info = await api(`/localidades-info`, { method: "PUT", body: payload });
    if (!RESUMEN_TERRITORIAL.data) RESUMEN_TERRITORIAL.data = {};
    RESUMEN_TERRITORIAL.data.territorio_info = info;
    RESUMEN_TERRITORIAL.data.localidad_info = info;
    RESUMEN_TERRITORIAL.editing = false;
    renderResumenTerritorial();
    toast({ title: "Ficha actualizada", message: `${payload.localidad}`, variant: "ok" });
  } catch (e) {
    console.error(e);
    alert("No se pudo guardar la ficha de localidad.\n\nDetalle: " + (e?.message || String(e)));
  } finally {
    setGlobalLoading(false);
  }
}

function clearResumenTerritorial() {
  RESUMEN_TERRITORIAL = {
    departamento: "",
    localidad: "",
    data: null,
    editing: false,
  };
  setVal("rt_departamento", "");
  const locSel = $id("rt_localidad");
  if (locSel) {
    locSel.innerHTML = `<option value="">(Seleccionar)</option>`;
    locSel.disabled = true;
  }
  renderResumenTerritorialEmpty();
}

function exportResumenTerritorialPdf() {
  if (!RESUMEN_TERRITORIAL.data) {
    alert("Primero carga un resumen territorial.");
    return;
  }
  window.print();
}

// ============================
// Gestiones
// ============================
function normalizeRows(resp) {
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp?.items)) return resp.items;
  if (Array.isArray(resp?.rows)) return resp.rows;
  if (Array.isArray(resp?.data)) return resp.data;
  return [];
}

function updatePagerInfo(resp, rows) {
  const pager = $id("pagerInfo");
  if (!pager) return;

  const total = resp?.total ?? resp?.count ?? null;
  const limit = resp?.limit ?? PAGE.limit;
  const offset = resp?.offset ?? PAGE.offset;

  PAGE.total = total;
  PAGE.limit = limit;
  PAGE.offset = offset;

  if (total != null) {
    const from = Math.min(total, offset + 1);
    const to = Math.min(total, offset + rows.length);
    pager.textContent = `Mostrando ${from}-${to} de ${total}`;
  } else {
    pager.textContent = rows.length ? `Mostrando ${rows.length}` : "";
  }

  const btnPrev = $id("btnPrev");
  const btnNext = $id("btnNext");
  if (btnPrev) btnPrev.disabled = (offset <= 0);
  if (btnNext) btnNext.disabled = (total != null ? (offset + limit >= total) : (rows.length < limit));
}

function currentFilters() {
  const q = String(LAST_SEARCH || "").trim();
  return {
    estado: $id("estadoFilter")?.value || null,
    ministerio: $id("ministerioFilter")?.value || null,
    categoria: $id("categoriaFilter")?.value || null,
    departamento: $id("departamentoFilter")?.value || null,
    localidad: $id("localidadFilter")?.value || null,
    tipo_gestion: $id("tipoGestionFilter")?.value || null,
    canal_origen: $id("canalOrigenFilter")?.value || null,
    q: q || null,
  };
}

async function loadGestiones(resetOffset = false) {
  setAppError("");
  if (resetOffset) PAGE.offset = 0;

  const { estado, ministerio, categoria, departamento, localidad, q, tipo_gestion, canal_origen } = currentFilters();

  const qs = new URLSearchParams();
  if (estado) qs.set("estado", estado);
  if (ministerio) qs.set("ministerio", ministerio);
  if (categoria) qs.set("categoria", categoria);
  if (departamento) qs.set("departamento", departamento);
  if (localidad) qs.set("localidad", localidad);
  if (tipo_gestion) qs.set("tipo_gestion", tipo_gestion);
  if (canal_origen) qs.set("canal_origen", canal_origen);
  if (q) qs.set("q", q);

  qs.set("limit", String(PAGE.limit));
  qs.set("offset", String(PAGE.offset));

  setGlobalLoading(true, "Cargando gestiones...");
  try {
    const resp = await api(`/gestiones/?${qs.toString()}`);
    const rows = normalizeRows(resp);
    LAST_ROWS = rows;
    updatePagerInfo(resp, rows);
    renderGrid(rows);
  } finally {
    setGlobalLoading(false);
  }
}

function pagePrev() {
  PAGE.offset = Math.max(0, PAGE.offset - PAGE.limit);
  loadGestiones(false);
}

function pageNext() {
  PAGE.offset = PAGE.offset + PAGE.limit;
  loadGestiones(false);
}

function renderGrid(rows) {
  if (!Array.isArray(rows)) rows = [];

  if (SORT.key) {
    rows = sortRows(rows, SORT.key, SORT.dir);
  }

  const table = $id("grid");
  if (!table) return;
  table.innerHTML = "";

  const minMap = new Map((CATALOGOS.ministerios || []).map((m) => [m.id, m.nombre]));
  const catMap = new Map((CATALOGOS.categorias || []).map((c) => [c.id, c.nombre]));
  const tipoMap = new Map((CATALOGOS.tiposGestion || []).map((t) => [t.id, t.nombre]));
  const canalMap = new Map((CATALOGOS.canalesOrigen || []).map((c) => [c.id, c.nombre]));

  const visibleCols = COL_DEFS.filter(c => VISIBLE_COLS.has(c.key));

  // header
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");

  visibleCols.forEach((c) => {
    const th = document.createElement("th");
    th.style.cursor = "pointer";
    th.title = "Ordenar";

    const isSorted = SORT.key === c.key;
    th.textContent = isSorted ? `${c.label} ${SORT.dir === "asc" ? "▲" : "▼"}` : c.label;

    th.addEventListener("click", () => {
      if (SORT.key === c.key) {
        SORT.dir = (SORT.dir === "asc") ? "desc" : "asc";
      } else {
        SORT.key = c.key;
        SORT.dir = "asc";
      }
      renderGrid(LAST_ROWS);
    });

    trh.appendChild(th);
  });

  const thA = document.createElement("th");
  thA.textContent = "Acciones";
  trh.appendChild(thA);

  thead.appendChild(trh);
  table.appendChild(thead);
  // habilitar resize + auto-fit (solo desktop/tablet)
  enableColumnResizing(table, visibleCols);

  // body
  const tbody = document.createElement("tbody");

  rows.forEach((r) => {
    const tr = document.createElement("tr");

    visibleCols.forEach((c) => {
      const td = document.createElement("td");
      td.dataset.label = c.label;

      if (c.key === "id_gestion") {
        const id = pick(r, "id_gestion") ?? "";
        td.innerHTML = `
          <button class="chip" type="button" title="Copiar ID" onclick="copyToClipboard('${escapeHtml(id)}')">
            <span class="chip-label">${escapeHtml(id)}</span>
            <span class="chip-icon" aria-hidden="true">⧉</span>
          </button>
        `;
      } else if (c.key === "ministerio_agencia_id") {
        const id = pick(r, "ministerio_agencia_id");
        td.textContent = id ? (minMap.get(id) || id) : "";
      } else if (c.key === "categoria_general_id") {
        const id = pick(r, "categoria_general_id");
        td.textContent = id ? (catMap.get(id) || id) : "";
      } else if (c.key === "tipo_gestion") {
        const id = pick(r, "tipo_gestion");
        td.textContent = id ? (tipoMap.get(id) || id) : "";
      } else if (c.key === "canal_origen") {
        const id = pick(r, "canal_origen");
        td.textContent = id ? (canalMap.get(id) || id) : "";
      } else if (c.key === "detalle") {
        const txt = String(pick(r, "detalle") ?? "");
        td.innerHTML = `<div class="cell-wrap" title="${escapeHtml(txt)}">${escapeHtml(txt)}</div>`;
      } else if (c.key === "costo_estimado") {
        const v = pick(r, "costo_estimado");
        const m = pick(r, "costo_moneda");
        td.textContent = (v === null || v === undefined || v === "") ? "" : `${v}${m ? " " + m : ""}`;
      } else {
        td.textContent = pick(r, c.key) ?? "";
      }

      tr.appendChild(td);
    });

    const tdA = document.createElement("td");
    tdA.className = "actions";
    tdA.dataset.label = "Acciones";

    const canDelete = isAdmin() || isSupervisor();
    const id = pick(r, "id_gestion") ?? "";

    tdA.innerHTML = `
      <div class="actions-wrap">
        <button class="btn" type="button" onclick="openDetalle('${escapeHtml(id)}')">Ver</button>
        <button class="btn" type="button" onclick="openChangeState('${escapeHtml(id)}')">Modificar</button>
        <button class="btn" type="button" onclick="openEventos('${escapeHtml(id)}')">Eventos</button>
        ${canDelete ? `<button class="btn btn-danger" type="button" onclick="deleteGestion('${escapeHtml(id)}')">Eliminar</button>` : ``}
      </div>
    `;

    tr.appendChild(tdA);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
}

// ============================
// Drawer detalle
// ============================
function kvRow(k, v) {
  return `
    <div class="kv-row">
      <div class="kv-k">${escapeHtml(k)}</div>
      <div class="kv-v">${escapeHtml(v ?? "")}</div>
    </div>
  `;
}

async function openDetalle(id) {
  if (!id) return;

  try {
    setGlobalLoading(true, "Cargando detalle...");
    const [g, ev] = await Promise.all([
      api(`/gestiones/${encodeURIComponent(id)}`),
      api(`/gestiones/${encodeURIComponent(id)}/eventos`).catch(() => []),
    ]);

    $id("drawerTitle").textContent = `Gestion ${id}`;
    $id("drawerSub").textContent =
      [pick(g, "departamento"), pick(g, "localidad"), pick(g, "estado")].filter(Boolean).join(" · ");

    const minMap = new Map((CATALOGOS.ministerios || []).map((m) => [m.id, m.nombre]));
    const catMap = new Map((CATALOGOS.categorias || []).map((c) => [c.id, c.nombre]));
    const tipoMap = new Map((CATALOGOS.tiposGestion || []).map((t) => [t.id, t.nombre]));
    const canalMap = new Map((CATALOGOS.canalesOrigen || []).map((c) => [c.id, c.nombre]));

    const ministerioId = pick(g, "ministerio_agencia_id");
    const categoriaId = pick(g, "categoria_general_id");
    const ministerioNombre = ministerioId ? (minMap.get(ministerioId) || ministerioId) : "";
    const categoriaNombre = categoriaId ? (catMap.get(categoriaId) || categoriaId) : "";

    const tipoId = pick(g, "tipo_gestion");
    const canalId = pick(g, "canal_origen");
    const tipoNombre = tipoId ? (tipoMap.get(tipoId) || tipoId) : "";
    const canalNombre = canalId ? (canalMap.get(canalId) || canalId) : "";

    const costo = pick(g, "costo_estimado");
    const moneda = pick(g, "costo_moneda");

    const summary = [
      ["Estado", pick(g, "estado")],
      ["Urgencia", pick(g, "urgencia")],
      ["Ministerio/Agencia", ministerioNombre],
      ["Categoria", categoriaNombre],
      ["Tipo de gestion", tipoNombre],
      ["Canal origen", canalNombre],
      ["Detalle", pick(g, "detalle")],
      ["Subtipo detalle", pick(g, "subtipo_detalle")],
      ["Costo", (costo != null && costo !== "" ? `${costo}${moneda ? " " + moneda : ""}` : "")],
      ["Nro expediente", pick(g, "nro_expediente")],
      ["Organismo", pick(g, "organismo_id")],
      ["Departamento", pick(g, "departamento")],
      ["Localidad", pick(g, "localidad")],
      ["Direccion", pick(g, "direccion")],
      ["Ingreso", fmtDateLike(pick(g, "fecha_ingreso"))],
      ["Ultima actualizacion", fmtDateLike(pick(g, "updated_at"))],
    ];

    $id("drawerSummary").innerHTML =
      summary
        .filter(([_, v]) => v !== null && v !== undefined && String(v).trim() !== "")
        .map(([k, v]) => kvRow(k, String(v)))
        .join("");

    const arr = Array.isArray(ev) ? ev : [];
    arr.sort((a, b) => {
      const ta = new Date(pick(a, "fecha_evento") || 0).getTime();
      const tb = new Date(pick(b, "fecha_evento") || 0).getTime();
      return (tb || 0) - (ta || 0);
    });

    const timeline = arr.map((e) => {
      const tipo = pick(e, "tipo_evento") || "";
      const when = fmtDateLike(pick(e, "fecha_evento") || "");
      const actor = pick(e, "usuario") || "";
      const rol = pick(e, "rol_usuario") || "";
      const estA = pick(e, "estado_anterior") || "";
      const estN = pick(e, "estado_nuevo") || "";
      const comentario = pick(e, "comentario") || "";
      const campoModificado = pick(e, "campo_modificado") || "";
      const valorAnterior = pick(e, "valor_anterior");
      const valorNuevo = pick(e, "valor_nuevo");

      let tipoLabel = tipo;
      const bodyLines = [];
      if (actor || rol) bodyLines.push(`Actor: ${actor}${rol ? " (" + rol + ")" : ""}`);

      const meta = pick(e, "metadata_json");
      let metaObj = null;
      if (meta) {
        try {
          metaObj = (typeof meta === "string") ? JSON.parse(meta) : meta;
        } catch { }
      }

      if (tipo === "ACTUALIZA_DATO") {
        tipoLabel = "Actualización de dato";
        const labelMap = {
          nro_expediente: "Nro expediente",
          fecha_ingreso: "Fecha de carga",
          departamento: "Departamento",
          localidad: "Localidad",
        };
        const campoLabel = labelMap[campoModificado] || campoModificado || metaObj?.campo || "Dato";
        bodyLines.push(`Campo: ${campoLabel}`);
        bodyLines.push(`Valor anterior: ${valorAnterior ?? "-"}`);
        bodyLines.push(`Valor nuevo: ${valorNuevo ?? "-"}`);
        if (estN) bodyLines.push(`Estado actual: ${estN}`);
      } else {
        if (estA || estN) bodyLines.push(`Estado: ${estA || "-"} -> ${estN || "-"}`);

        const extraLines = [];
        const deriv = metaObj?.derivado_a || metaObj?.derivado_a_id;
        const acc = metaObj?.acciones_implementadas;
        const nroExp = Object.prototype.hasOwnProperty.call(metaObj || {}, "nro_expediente") ? metaObj?.nro_expediente : undefined;
        const fechaIng = Object.prototype.hasOwnProperty.call(metaObj || {}, "fecha_ingreso") ? metaObj?.fecha_ingreso : undefined;
        const deptoMeta = Object.prototype.hasOwnProperty.call(metaObj || {}, "departamento") ? metaObj?.departamento : undefined;
        const locMeta = Object.prototype.hasOwnProperty.call(metaObj || {}, "localidad") ? metaObj?.localidad : undefined;

        if (deriv) extraLines.push(`Derivado a: ${deriv}`);
        if (acc) extraLines.push(`Acciones: ${acc}`);
        if (nroExp !== undefined) extraLines.push(`Nro expediente: ${nroExp || "-"}`);
        if (fechaIng !== undefined) extraLines.push(`Fecha de carga: ${fechaIng || "-"}`);
        if (deptoMeta !== undefined) extraLines.push(`Departamento: ${deptoMeta || "-"}`);
        if (locMeta !== undefined) extraLines.push(`Localidad: ${locMeta || "-"}`);

        bodyLines.push(...extraLines);
      }

      if (comentario) bodyLines.push(`Comentario: ${comentario}`);
      const body = bodyLines.join("\n");

      return `
        <div class="tl-item">
          <div class="tl-head">
            <div class="tl-type">${escapeHtml(tipoLabel)}</div>
            <div class="tl-date">${escapeHtml(when)}</div>
          </div>
          <div class="tl-body">${escapeHtml(body)}</div>
        </div>
      `;
    }).join("");

    $id("drawerEventos").innerHTML = timeline || `<div class="hint">Sin movimientos.</div>`;
    openDrawer();
  } catch (e) {
    alert("No se pudo abrir el detalle.\n\nDetalle: " + (e?.message || String(e)));
  } finally {
    setGlobalLoading(false);
  }
}

// ============================
// Eventos (modal raw JSON)
// ============================
async function openEventos(id) {
  setGlobalLoading(true, "Cargando eventos...");
  try {
    const ev = await api(`/gestiones/${encodeURIComponent(id)}/eventos`);
    $id("ev_title").textContent = `Eventos · ${id}`;
    $id("ev_body").textContent = JSON.stringify(ev, null, 2);
    openModal("modalEventos");
  } finally {
    setGlobalLoading(false);
  }
}

// ============================
// Delete
// ============================
async function deleteGestion(id) {
  if (!id) return;
  const ok = await openAppDialog({
    title: "Infra Gestion",
    subtitle: "Confirmacion requerida",
    message: `Estas por eliminar la gestion ${id}. La accion realiza un borrado logico y quedara registrada en el historial.`,
    confirmText: "Eliminar",
    cancelText: "Cancelar",
  });
  if (!ok) return;

  try {
    setGlobalLoading(true, "Eliminando...");
    await api(`/gestiones/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast({ title: "Gestion eliminada", message: `ID ${id}`, variant: "ok" });
    await loadGestiones(true);
  } catch (e) {
    await openAppDialog({
      title: "Infra Gestion",
      subtitle: "No se pudo completar la operacion",
      message: "No se pudo eliminar la gestion. " + (e?.message || String(e)),
      confirmText: "Cerrar",
    });
  } finally {
    setGlobalLoading(false);
  }
}

// ============================
// Cambiar estado
// ============================
async function openChangeState(id) {
  if (!id) return;

  $id("cs_id_gestion").value = id;
  $id("cs_comentario").value = "";
  $id("cs_nuevo_estado").value = "";

  const d = $id("cs_derivado_a");
  const a = $id("cs_acciones_implementadas");
  const exp = $id("cs_nro_expediente");
  const fi = $id("cs_fecha_ingreso");
  const deptSel = $id("cs_departamento");
  const locSel = $id("cs_localidad");

  if (d) d.value = "";
  if (a) a.value = "";
  if (exp) exp.value = "";
  if (fi) fi.value = "";
  if (deptSel) deptSel.value = "";
  if (locSel) {
    locSel.innerHTML = `<option value="">(Seleccionar)</option>`;
    locSel.disabled = true;
  }

  try {
    setGlobalLoading(true, "Cargando datos actuales...");
    const g = await api(`/gestiones/${encodeURIComponent(id)}`);
    if (g) {
      $id("cs_nuevo_estado").value = pick(g, "estado") || "";
      if (d) d.value = pick(g, "derivado_a_id") || "";
      if (exp) exp.value = pick(g, "nro_expediente") || "";
      if (fi) {
        const dateVal = pick(g, "fecha_ingreso");
        if (dateVal) fi.value = String(dateVal).split('T')[0];
      }

      const depto = pick(g, "departamento") || "";
      const loc = pick(g, "localidad") || "";
      if (deptSel) deptSel.value = depto;

      if (locSel) {
        locSel.innerHTML = `<option value="">(Seleccionar)</option>`;
        locSel.disabled = !depto;
        if (depto) {
          const locs = await getLocalidadesByDepto(depto);
          locs.forEach((l) => {
            const opt = document.createElement("option");
            opt.value = l;
            opt.textContent = l;
            locSel.appendChild(opt);
          });
          locSel.value = loc;
        }
      }
    }
    openModal("modalChangeState");
  } catch (e) {
    await openAppDialog({
      title: "Infra Gestion",
      subtitle: "No se pudo abrir la gestion",
      message: "No se pudo cargar la gestion para editar. " + (e?.message || String(e)),
      confirmText: "Cerrar",
    });
  } finally {
    setGlobalLoading(false);
  }
}

async function submitChangeState() {
  const id = $id("cs_id_gestion").value;
  const nuevo = $id("cs_nuevo_estado").value;
  const comentario = $id("cs_comentario").value || null;
  const derivado_a = $id("cs_derivado_a")?.value || null;
  const acciones_implementadas = $id("cs_acciones_implementadas")?.value || null;
  const nro_expediente = $id("cs_nro_expediente")?.value ?? null;
  const fecha_ingreso = $id("cs_fecha_ingreso")?.value || null;
  const departamento = $id("cs_departamento")?.value || null;
  const localidad = $id("cs_localidad")?.value || null;

  if (!id) return openAppDialog({ title: "Infra Gestion", subtitle: "Dato faltante", message: "Falta el identificador de la gestion.", confirmText: "Cerrar" });
  if (!nuevo) return openAppDialog({ title: "Infra Gestion", subtitle: "Dato faltante", message: "Selecciona un estado.", confirmText: "Cerrar" });
  if (!departamento) return openAppDialog({ title: "Infra Gestion", subtitle: "Dato faltante", message: "Selecciona un departamento.", confirmText: "Cerrar" });
  if (!localidad) return openAppDialog({ title: "Infra Gestion", subtitle: "Dato faltante", message: "Selecciona una localidad.", confirmText: "Cerrar" });

  const nuevoUp = String(nuevo || "").toUpperCase();
  if ((nuevoUp === "ARCHIVADO" || nuevoUp === "NO REMITE SUAC") && (!comentario || String(comentario).trim() === "")) {
    return openAppDialog({
      title: "Infra Gestion",
      subtitle: "Validacion",
      message: "El comentario es obligatorio para ARCHIVADO y NO REMITE SUAC.",
      confirmText: "Cerrar",
    });
  }

  setGlobalLoading(true, "Guardando cambios...");
  try {
    await api(`/gestiones/${encodeURIComponent(id)}/cambiar-estado`, {
      method: "POST",
      body: {
        nuevo_estado: nuevo,
        comentario,
        derivado_a,
        acciones_implementadas,
        nro_expediente,
        fecha_ingreso,
        departamento,
        localidad
      },
    });

    closeModal("modalChangeState");
    toast({ title: "Cambios guardados", message: `Gestion ${id}`, variant: "ok" });
    await loadGestiones(false);
  } catch (e) {
    await openAppDialog({
      title: "Infra Gestion",
      subtitle: "No se pudo completar la operacion",
      message: "No se pudieron guardar los cambios de la gestion. " + (e?.message || String(e)),
      confirmText: "Cerrar",
    });
  } finally {
    setGlobalLoading(false);
  }
}

// ============================
// Nueva gestion
// ============================
function openNew() {
  setVal("ng_ministerio", "");
  setVal("ng_categoria", "");
  setVal("ng_urgencia", "Media");

  setVal("ng_tipo_gestion", "");
  setVal("ng_canal_origen", "");

  setVal("ng_departamento", "");

  const loc = $id("ng_localidad");
  if (loc) loc.innerHTML = `<option value="">(Seleccionar)</option>`;

  setVal("ng_direccion", "");
  setVal("ng_detalle", "");
  setVal("ng_observaciones", "");

  setVal("ng_organismo_id", "");
  setVal("ng_subtipo_detalle", "");
  setVal("ng_costo_estimado", "");
  setVal("ng_costo_moneda", "ARS");
  setVal("ng_nro_expediente", "");

  openModal("modalNewGestion");
}

async function submitNewGestion() {
  try {
    const ministerio = getVal("ng_ministerio");
    const categoria = getVal("ng_categoria");
    const urgencia = getVal("ng_urgencia") || "Media";

    const tipo_gestion = getVal("ng_tipo_gestion", "") || null;
    const canal_origen = getVal("ng_canal_origen", "") || null;

    const departamento = getVal("ng_departamento");
    const localidad = getVal("ng_localidad");
    const direccion = getVal("ng_direccion", "") || null;

    const detalle = getVal("ng_detalle");
    const observaciones = getVal("ng_observaciones", "") || null;

    const organismo_id = getVal("ng_organismo_id", "") || null;
    const subtipo_detalle = getVal("ng_subtipo_detalle", "") || null;

    const costo_estimado_raw = getVal("ng_costo_estimado", "");
    const costo_estimado = (costo_estimado_raw === "" || costo_estimado_raw == null) ? null : Number(costo_estimado_raw);

    const costo_moneda = getVal("ng_costo_moneda") || "ARS";
    const nro_expediente = getVal("ng_nro_expediente", "") || null;

    if (!ministerio) return openAppDialog({ title: "Infra Gestion", subtitle: "Dato faltante", message: "Selecciona un ministerio o agencia.", confirmText: "Cerrar" });
    if (!categoria) return openAppDialog({ title: "Infra Gestion", subtitle: "Dato faltante", message: "Selecciona una categoria.", confirmText: "Cerrar" });
    if (!departamento) return openAppDialog({ title: "Infra Gestion", subtitle: "Dato faltante", message: "Selecciona un departamento.", confirmText: "Cerrar" });
    if (!localidad) return openAppDialog({ title: "Infra Gestion", subtitle: "Dato faltante", message: "Selecciona una localidad.", confirmText: "Cerrar" });
    if (!detalle || detalle.trim() === "") return openAppDialog({ title: "Infra Gestion", subtitle: "Dato faltante", message: "El detalle es obligatorio.", confirmText: "Cerrar" });

    setGlobalLoading(true, "Validando datos...");
    await api(`/catalogos/geo?departamento=${encodeURIComponent(departamento)}&localidad=${encodeURIComponent(localidad)}`);

    const payload = {
      ministerio_agencia_id: ministerio,
      categoria_general_id: categoria,
      urgencia,
      detalle,
      observaciones,
      departamento,
      localidad,
      direccion,

      organismo_id,
      subtipo_detalle,
      costo_estimado,
      costo_moneda,
      nro_expediente,

      tipo_gestion,
      canal_origen,
    };

    setGlobalLoading(true, "Creando gestion...");
    const resp = await api(`/gestiones`, { method: "POST", body: payload });

    closeModal("modalNewGestion");
    await loadGestiones(true);

    if (resp?.id_gestion) {
      toast({ title: "Gestion creada", message: `ID ${resp.id_gestion}`, variant: "ok" });
      await openAppDialog({
        title: "Infra Gestion",
        subtitle: "Operacion completada",
        message: `La gestion se creo correctamente con el ID ${resp.id_gestion}.`,
        confirmText: "Aceptar",
      });
    } else {
      toast({ title: "Gestion creada", message: "Se creo correctamente.", variant: "ok" });
    }
  } catch (e) {
    console.error(e);
    await openAppDialog({
      title: "Infra Gestion",
      subtitle: "No se pudo completar la operacion",
      message: "No se pudo crear la gestion. " + (e?.message || String(e)),
      confirmText: "Cerrar",
    });
  } finally {
    setGlobalLoading(false);
  }
}

// ============================
// Usuarios (Admin)
// ============================
function normalizeEmail(s) { return String(s || "").trim().toLowerCase(); }
function boolToYesNo(v) { return (v === true || String(v).toLowerCase() === "true") ? "Si" : "No"; }

function clearUserForm() {
  setUsersError("");
  setUsersHint("");

  const email = $id("u_email");
  const nombre = $id("u_nombre");
  const rol = $id("u_rol");
  const activo = $id("u_activo");

  if (email) { email.value = ""; email.readOnly = false; }
  if (nombre) nombre.value = "";
  if (rol) rol.value = "";
  if (activo) activo.checked = true;

  if (email) email.dataset.mode = "create";
}

function fillUserForm(u) {
  const email = $id("u_email");
  const nombre = $id("u_nombre");
  const rol = $id("u_rol");
  const activo = $id("u_activo");

  if (email) {
    email.value = pick(u, "email") || "";
    email.readOnly = true;
    email.dataset.mode = "edit";
  }
  if (nombre) nombre.value = pick(u, "nombre") || "";
  if (rol) rol.value = pick(u, "rol") || "";
  if (activo) activo.checked = (pick(u, "activo") === true || String(pick(u, "activo")).toLowerCase() === "true");
}

async function loadUsers() {
  if (!isAdmin()) return;
  setUsersError("");
  setUsersHint("Cargando...");

  setGlobalLoading(true, "Cargando usuarios...");
  try {
    const rows = await api(`/usuarios/`);
    LAST_USERS = Array.isArray(rows) ? rows : [];
    renderUsersGrid(LAST_USERS);
    setUsersHint(`Usuarios: ${LAST_USERS.length}`);
  } catch (e) {
    console.error(e);
    setUsersHint("");
    setUsersError("No se pudo cargar usuarios. " + (e?.message || String(e)));
  } finally {
    setGlobalLoading(false);
  }
}

function renderUsersGrid(rows) {
  const table = $id("usersGrid");
  if (!table) return;
  table.innerHTML = "";

  const cols = [
    { key: "email", label: "Email" },
    { key: "nombre", label: "Nombre" },
    { key: "rol", label: "Rol" },
    { key: "activo", label: "Activo" },
    { key: "updated_at", label: "Actualizado" },
    { key: "updated_by", label: "Actualizo" },
  ];

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  cols.forEach(c => {
    const th = document.createElement("th");
    th.textContent = c.label;
    trh.appendChild(th);
  });
  const thA = document.createElement("th");
  thA.textContent = "Acciones";
  trh.appendChild(thA);
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  (rows || []).forEach(u => {
    const tr = document.createElement("tr");

    cols.forEach(c => {
      const td = document.createElement("td");
      td.dataset.label = c.label;
      let v = pick(u, c.key);
      if (c.key === "activo") v = boolToYesNo(v);
      if (c.key === "updated_at") v = fmtDateLike(v);
      td.textContent = (v == null ? "" : String(v));
      tr.appendChild(td);
    });

    const email = normalizeEmail(pick(u, "email"));
    const activo = (pick(u, "activo") === true || String(pick(u, "activo")).toLowerCase() === "true");

    const tdA = document.createElement("td");
    tdA.className = "actions";
    tdA.dataset.label = "Acciones";
    tdA.innerHTML = `
      <div class="actions-wrap">
        <button class="btn" type="button" onclick="editUser('${escapeHtml(email)}')">Editar</button>
        ${activo ? `<button class="btn btn-danger" type="button" onclick="disableUser('${escapeHtml(email)}')">Deshabilitar</button>` : `<span class="hint">Deshabilitado</span>`}
      </div>
    `;

    tr.appendChild(tdA);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
}

function findUserByEmail(email) {
  const e = normalizeEmail(email);
  return (LAST_USERS || []).find(u => normalizeEmail(pick(u, "email")) === e) || null;
}

function editUser(email) {
  setUsersError("");
  setUsersHint("Editando usuario...");
  const u = findUserByEmail(email);
  if (!u) {
    setUsersHint("");
    return alert("No se encontro el usuario en la lista.");
  }
  fillUserForm(u);
  setUsersHint(`Editando: ${normalizeEmail(email)}`);
}

async function upsertUser() {
  if (!isAdmin()) return;

  setUsersError("");
  setUsersHint("");

  const emailEl = $id("u_email");
  const nombreEl = $id("u_nombre");
  const rolEl = $id("u_rol");
  const activoEl = $id("u_activo");

  const email = normalizeEmail(emailEl?.value);
  const nombre = (nombreEl?.value || "").trim() || null;
  const rol = String(rolEl?.value || "").trim();
  const activo = !!activoEl?.checked;

  if (!email) return setUsersError("Email es obligatorio.");
  if (!rol) return setUsersError("Rol es obligatorio.");

  const isEditMode = !!emailEl?.readOnly || emailEl?.dataset.mode === "edit";

  setGlobalLoading(true, "Guardando usuario...");
  try {
    if (isEditMode) {
      await api(`/usuarios/${encodeURIComponent(email)}`, {
        method: "PUT",
        body: { nombre, rol, activo },
      });
      setUsersHint("Usuario actualizado.");
      toast({ title: "Usuario actualizado", message: email, variant: "ok" });
    } else {
      await api(`/usuarios/`, {
        method: "POST",
        body: { email, nombre, rol, activo },
      });
      setUsersHint("Usuario creado.");
      toast({ title: "Usuario creado", message: email, variant: "ok" });
    }

    await loadUsers();
    clearUserForm();
  } catch (e) {
    console.error(e);
    if (e?.status === 409) {
      setUsersError("El usuario ya existe. Usa Editar desde la lista o cambia el email.");
      return;
    }
    setUsersError("No se pudo guardar. " + (e?.message || String(e)));
  } finally {
    setGlobalLoading(false);
  }
}

async function disableUser(email) {
  if (!isAdmin()) return;
  const e = normalizeEmail(email);
  const ok = confirm(`Deshabilitar usuario?\n\n${e}`);
  if (!ok) return;

  setGlobalLoading(true, "Deshabilitando usuario...");
  try {
    await api(`/usuarios/${encodeURIComponent(e)}`, { method: "DELETE" });
    setUsersHint("Usuario deshabilitado.");
    toast({ title: "Usuario deshabilitado", message: e, variant: "ok" });
    await loadUsers();
    const currentFormEmail = normalizeEmail($id("u_email")?.value);
    if (currentFormEmail === e) clearUserForm();
  } catch (err) {
    console.error(err);
    setUsersError("No se pudo deshabilitar. " + (err?.message || String(err)));
  } finally {
    setGlobalLoading(false);
  }
}

// ============================
// Init
// ============================
document.addEventListener("DOMContentLoaded", async () => {
  $id("userBox").innerText = "";
  setAppAuthedUI(false);
  setLoginError("");
  setAppError("");
  setUsersError("");
  setUsersHint("");

  wireUI();
  initGoogleButton();

  const emailEl = $id("u_email");
  if (emailEl) emailEl.dataset.mode = "create";

  const t = readToken();
  if (t) {
    try {
      saveToken(t);
      setAppAuthedUI(true);
      $id("userBox").innerText = "Restaurando sesion...";
      setGlobalLoading(true, "Restaurando sesion...");
      await validateAuthOrThrow();
      await bootData();
      toast({ title: "Sesion restaurada", message: "Continuaste donde lo dejaste.", variant: "ok" });
    } catch (e) {
      console.warn("No se pudo restaurar sesion:", e);
      logout();
    } finally {
      setGlobalLoading(false);
    }
  }
});

// ============================
// Exponer globales
// ============================
window.loadGestiones = loadGestiones;
window.openNew = openNew;
window.closeModal = closeModal;
window.submitNewGestion = submitNewGestion;
window.openChangeState = openChangeState;
window.submitChangeState = submitChangeState;
window.openEventos = openEventos;
window.deleteGestion = deleteGestion;
window.openDetalle = openDetalle;
window.closeDrawer = closeDrawer;

// Usuarios
window.loadUsers = loadUsers;
window.upsertUser = upsertUser;
window.clearUserForm = clearUserForm;
window.editUser = editUser;
window.disableUser = disableUser;

// Util
window.copyToClipboard = copyToClipboard;
window.reloadDashboard = reloadDashboard;
window.loadResumenTerritorial = loadResumenTerritorial;
window.clearResumenTerritorial = clearResumenTerritorial;

// Exportar
window.exportGestiones = exportGestiones;
window.toggleExportMenu = toggleExportMenu;

// ============================
// Exportar tabla de gestiones
// ============================

function toggleExportMenu(e) {
  e.stopPropagation();
  const menu = $id("exportMenu");
  const btn = $id("btnExportToggle");
  if (!menu) return;
  const isHidden = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !isHidden);
  btn?.setAttribute("aria-expanded", isHidden ? "true" : "false");
}

// Cierra el menu de exportar si se hace click afuera
document.addEventListener("click", (e) => {
  const menu = $id("exportMenu");
  const dropdown = $id("exportDropdown");
  if (!menu || menu.classList.contains("hidden")) return;
  if (dropdown && dropdown.contains(e.target)) return;
  menu.classList.add("hidden");
  $id("btnExportToggle")?.setAttribute("aria-expanded", "false");
});

// Labels legibles para cada columna
const EXPORT_COLS = [
  { key: "id_gestion",          label: "ID Gestion" },
  { key: "departamento",        label: "Departamento" },
  { key: "localidad",           label: "Localidad" },
  { key: "estado",              label: "Estado" },
  { key: "urgencia",            label: "Urgencia" },
  { key: "ministerio_agencia_id", label: "Ministerio/Agencia" },
  { key: "categoria_general_id",  label: "Categoria" },
  { key: "tipo_gestion",        label: "Tipo de gestion" },
  { key: "canal_origen",        label: "Canal de origen" },
  { key: "detalle",             label: "Detalle" },
  { key: "nro_expediente",      label: "Nro. Expediente" },
  { key: "costo_estimado",      label: "Costo estimado" },
  { key: "costo_moneda",        label: "Moneda" },
  { key: "fecha_ingreso",       label: "Fecha ingreso" },
  { key: "dias_transcurridos",  label: "Dias transcurridos" },
];

async function exportGestiones(formato) {
  // Cerrar el menu
  $id("exportMenu")?.classList.add("hidden");
  $id("btnExportToggle")?.setAttribute("aria-expanded", "false");

  const filters = currentFilters();
  const { estado, ministerio, categoria, departamento, localidad, q, tipo_gestion, canal_origen } = filters;

  // Construir descripcion del filtro activo para el encabezado
  const partesFiltro = [];
  if (departamento) partesFiltro.push("Departamento: " + departamento);
  if (localidad) partesFiltro.push("Localidad: " + localidad);
  if (estado) partesFiltro.push("Estado: " + estado);
  if (ministerio) {
    const min = (CATALOGOS.ministerios || []).find(m => m.id === ministerio);
    partesFiltro.push("Ministerio: " + (min ? min.nombre : ministerio));
  }
  if (categoria) {
    const cat = (CATALOGOS.categorias || []).find(c => c.id === categoria);
    partesFiltro.push("Categoria: " + (cat ? cat.nombre : categoria));
  }
  if (tipo_gestion) partesFiltro.push("Tipo: " + tipo_gestion);
  if (canal_origen) partesFiltro.push("Canal: " + canal_origen);
  if (q) partesFiltro.push('Busqueda: "' + q + '"');
  const filtroTexto = partesFiltro.length ? partesFiltro.join(" | ") : "Sin filtros (todos los registros)";

  // Fetch de TODOS los registros con los filtros actuales, respetando el limite maximo del backend.
  const qs = new URLSearchParams();
  if (estado) qs.set("estado", estado);
  if (ministerio) qs.set("ministerio", ministerio);
  if (categoria) qs.set("categoria", categoria);
  if (departamento) qs.set("departamento", departamento);
  if (localidad) qs.set("localidad", localidad);
  if (tipo_gestion) qs.set("tipo_gestion", tipo_gestion);
  if (canal_origen) qs.set("canal_origen", canal_origen);
  if (q) qs.set("q", q);
  const exportLimit = 200;
  qs.set("limit", String(exportLimit));

  setGlobalLoading(true, "Preparando exportacion...");
  const rows = [];
  try {
    let offset = 0;
    let total = null;

    while (true) {
      qs.set("offset", String(offset));

      const resp = await api(`/gestiones/?${qs.toString()}`);
      const pageRows = normalizeRows(resp);
      rows.push(...pageRows);

      total = resp?.total ?? resp?.count ?? total;
      const progreso = total != null ? `${rows.length} de ${total}` : `${rows.length}`;
      setGlobalLoading(true, `Preparando exportacion... ${progreso} gestiones`);

      if (!pageRows.length) break;
      if (total != null && rows.length >= total) break;
      if (pageRows.length < exportLimit) break;

      offset += exportLimit;
    }
  } catch (err) {
    toast({ title: "Error al exportar", message: String(err.message || err), variant: "error" });
    return;
  } finally {
    setGlobalLoading(false);
  }

  if (!rows.length) {
    toast({ title: "Sin datos", message: "No hay gestiones que coincidan con los filtros aplicados.", variant: "error" });
    return;
  }

  // Mapas para resolver IDs a nombres
  const minMap = new Map((CATALOGOS.ministerios || []).map(m => [m.id, m.nombre]));
  const catMap = new Map((CATALOGOS.categorias || []).map(c => [c.id, c.nombre]));
  const tipoMap = new Map((CATALOGOS.tiposGestion || []).map(t => [t.id, t.nombre]));
  const canalMap = new Map((CATALOGOS.canalesOrigen || []).map(c => [c.id, c.nombre]));

  function resolveCell(key, val) {
    if (val == null) return "";
    if (key === "ministerio_agencia_id") return minMap.get(val) || val;
    if (key === "categoria_general_id")  return catMap.get(val)  || val;
    if (key === "tipo_gestion")           return tipoMap.get(val) || val;
    if (key === "canal_origen")           return canalMap.get(val)|| val;
    return val;
  }

  const fechaExport = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const nombreArchivo = "gestiones_" + (departamento || "todos") + (localidad ? "_" + localidad : "") + "_" + fechaExport.replace(/\//g, "-");

  if (formato === "excel") {
    exportarExcel(rows, resolveCell, filtroTexto, fechaExport, nombreArchivo);
  } else {
    exportarPdf(rows, resolveCell, filtroTexto, fechaExport, nombreArchivo);
  }
}

function exportarExcel(rows, resolveCell, filtroTexto, fechaExport, nombreArchivo) {
  const wb = XLSX.utils.book_new();

  // Fila de titulo + filtros
  const header = [
    ["Infra Gestion - Secretaria de Infraestructura"],
    ["Fecha de exportacion: " + fechaExport],
    ["Filtros: " + filtroTexto],
    ["Total de registros: " + rows.length],
    [], // fila en blanco
    EXPORT_COLS.map(c => c.label), // cabecera de columnas
  ];

  // Filas de datos
  const dataRows = rows.map(row =>
    EXPORT_COLS.map(col => resolveCell(col.key, row[col.key]))
  );

  const wsData = [...header, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Ancho de columnas (estimado)
  ws["!cols"] = EXPORT_COLS.map(col => ({
    wch: col.key === "detalle" ? 60 : col.key === "id_gestion" ? 38 : 22
  }));

  XLSX.utils.book_append_sheet(wb, ws, "Gestiones");
  XLSX.writeFile(wb, nombreArchivo + ".xlsx");

  toast({ title: "Excel generado", message: rows.length + " gestiones exportadas.", variant: "ok" });
}

function exportarPdf(rows, resolveCell, filtroTexto, fechaExport, nombreArchivo) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  const pageW = doc.internal.pageSize.getWidth();

  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("Infra Gestion - Secretaria de Infraestructura", pageW / 2, 14, { align: "center" });

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text("Fecha: " + fechaExport + "   |   Total: " + rows.length + " registros", pageW / 2, 20, { align: "center" });
  doc.text("Filtros: " + filtroTexto, pageW / 2, 26, { align: "center" });

  // Columnas a incluir en PDF (excluir columnas muy anchas o poco utiles en papel)
  const pdfCols = EXPORT_COLS.filter(c => c.key !== "id_gestion");

  const tableHead = [pdfCols.map(c => c.label)];
  const tableBody = rows.map(row => pdfCols.map(col => String(resolveCell(col.key, row[col.key]) ?? "")));

  doc.autoTable({
    head: tableHead,
    body: tableBody,
    startY: 32,
    styles: { fontSize: 7, cellPadding: 2, overflow: "linebreak" },
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 247, 250] },
    columnStyles: {
      // detalle mas ancho
      [pdfCols.findIndex(c => c.key === "detalle")]: { cellWidth: 55 },
    },
    margin: { top: 32, left: 6, right: 6 },
    didDrawPage: (data) => {
      const pageCount = doc.internal.getNumberOfPages();
      const currentPage = doc.internal.getCurrentPageInfo().pageNumber;
      doc.setFontSize(7);
      doc.text("Pagina " + currentPage + " de " + pageCount, pageW - 12, doc.internal.pageSize.getHeight() - 5, { align: "right" });
    },
  });

  doc.save(nombreArchivo + ".pdf");
  toast({ title: "PDF generado", message: rows.length + " gestiones exportadas.", variant: "ok" });
}
