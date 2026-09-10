// ============================================================================
// admin.js — Hana Baraka Website-Backend
//
// Diese Seite ist selbst wieder eine ganz normale statische Seite, kein
// eigener Server. "Speichern" funktioniert trotzdem, weil GitHub seine
// REST-API auch direkt aus dem Browser heraus erlaubt (inkl. CORS) — man
// muss nur einen persönlichen Zugriffstoken mitschicken. Jede "Speichern"-
// Aktion hier ist technisch ein echter Commit ins Repo, genau als hätte man
// die Datei lokal bearbeitet und "git push" gemacht.
//
// Betroffene Dateien im Repo:
//   stuecke.csv   — ein Werk (Titel/Preis/Story) pro Zeile
//   medien.csv    — ein Bild/Video pro Zeile, verweist per piece_id aufs Werk
//   images/*.webp — die eigentlichen Bilddateien
//
// WICHTIG zur Sicherheit: Diese Seite hat kein "echtes" Login (keine
// Passwort-Prüfung o.ä.) — Schutz ist allein der Token, den man selbst
// einträgt. Für ein internes Zwei-Personen-Werkzeug ist das ein bewusst in
// Kauf genommenes, kleines Risiko. Wichtig ist nur: den Token als
// "Fine-grained personal access token" mit Zugriff NUR auf dieses eine Repo
// erzeugen (siehe Hilfetext auf der Seite selbst) — nicht einen Token mit
// Rechten auf den ganzen GitHub-Account verwenden.
// ============================================================================

// ─── Repo-Konfiguration ────────────────────────────────────────────────────
// TODO Charlotte: sobald das GitHub-Repo existiert, hier eintragen.
// OWNER ist dein GitHub-Benutzername, REPO der Repo-Name (siehe Runbook /
// IMPLEMENTATION_LOG.md — dort ist "GitHub-Repo erstellen" noch offen).
const OWNER = 'charlottedevelops';
const REPO = 'hanabaraka';
const BRANCH = 'main';

const TOKEN_KEY = 'hana-admin-gh-token';
const MAX_IMAGE_EDGE = 1800;   // gleiche Grenze wie beim ursprünglichen Bild-Komprimieren (siehe IMPLEMENTATION_LOG.md, 2026-06-30)
const IMAGE_QUALITY = 0.8;     // WebP-Qualität, ebenfalls 1:1 aus derselben Entscheidung übernommen

const STUECKE_HEADERS = ['id', 'title', 'medium', 'year', 'place', 'story', 'price', 'theme', 'colour', 'featured'];
const MEDIEN_HEADERS = ['role', 'media_id', 'piece_id', 'type', 'order', 'home', 'portfolio', 'shop', 'video_id', 'aspect'];
const STUECKE_BOOL_COLS = ['featured'];
const MEDIEN_BOOL_COLS = ['home', 'portfolio', 'shop'];

// ─── Token-Verwaltung ───────────────────────────────────────────────────────
function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

// ─── UTF-8-sicheres Base64 ──────────────────────────────────────────────────
// GitHub liefert/erwartet Dateiinhalte als Base64 der UTF-8-Bytes. btoa()/
// atob() im Browser kennen aber nur Latin1 (ein Byte pro Zeichen) — bei
// Sonderzeichen in Hanas Texten (z.B. das runde Anführungszeichen "'" statt
// eines geraden ', das in "Egypt's" in stuecke.csv steckt) würde das sonst
// stillschweigend kaputtgehen. Deshalb hier über TextEncoder/TextDecoder
// gehen statt btoa/atob direkt auf dem String aufzurufen.
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}
function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

// ─── CSV-Parser / -Schreiber ────────────────────────────────────────────────
// Gleiche Tokenizer-Logik wie in app.js/scripts/sync-sheet.js (mehrzeilige,
// gequotete Felder inklusive) — hier dupliziert statt importiert, weil es
// keine gemeinsame Build-Pipeline zwischen den drei Dateien gibt (bewusst,
// siehe "kein Build-Schritt"-Prämisse von v0).
function tokenizeCSV(text) {
  const rows = [];
  let cur = '', inQ = false, row = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQ && text[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      row.push(cur); cur = '';
    } else if ((c === '\n' || (c === '\r' && text[i + 1] === '\n')) && !inQ) {
      if (c === '\r') i++;
      row.push(cur); cur = '';
      rows.push(row); row = [];
    } else {
      if (c !== '\r') cur += c;
    }
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function parseCSV(text, fallbackHeaders) {
  const rows = tokenizeCSV(text);
  if (rows.length < 1) return { headers: fallbackHeaders.slice(), rows: [] };
  const headers = rows[0];
  const dataRows = rows.slice(1)
    .filter(r => r.some(c => c.trim() !== ''))
    .map(cols => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (cols[i] || '').trim(); });
      return obj;
    });
  return { headers, rows: dataRows };
}

function toCSVField(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function stringifyCSV(headers, rows) {
  const lines = [headers.map(toCSVField).join(',')];
  rows.forEach(r => lines.push(headers.map(h => toCSVField(r[h] || '')).join(',')));
  return lines.join('\n') + '\n';
}

// ─── GitHub Contents API ────────────────────────────────────────────────────
// Doku: https://docs.github.com/en/rest/repos/contents
async function ghGetFile(path) {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}?ref=${BRANCH}`,
    { headers: { Authorization: `token ${getToken()}`, Accept: 'application/vnd.github+json' } }
  );
  if (res.status === 404) return null; // Datei existiert im Repo noch nicht — kein Fehler, nur "leer"
  if (!res.ok) throw new Error(`GitHub-Lesefehler bei "${path}": HTTP ${res.status}`);
  const json = await res.json();
  return { sha: json.sha, text: base64ToUtf8(json.content) };
}

// isBase64 = true für Bild-Uploads (der Aufrufer hat schon Base64, z.B. aus
// canvas.toBlob), false/weggelassen für Text (CSV) — dann wird hier erst
// nach Base64 umgewandelt.
async function ghPutFile(path, content, sha, message, isBase64) {
  const body = {
    message,
    content: isBase64 ? content : utf8ToBase64(content),
    branch: BRANCH
  };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `token ${getToken()}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch {}
    throw new Error(`GitHub-Schreibfehler bei "${path}": HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
  }
  return res.json();
}

// ─── App-Zustand ────────────────────────────────────────────────────────────
const state = {
  stuecke: { headers: STUECKE_HEADERS.slice(), rows: [], sha: null },
  medien: { headers: MEDIEN_HEADERS.slice(), rows: [], sha: null },
  seite: { values: {}, sha: null }
};

// ─── DOM-Referenzen ─────────────────────────────────────────────────────────
const el = {
  tokenInput: document.getElementById('token-input'),
  connectBtn: document.getElementById('connect-btn'),
  disconnectBtn: document.getElementById('disconnect-btn'),
  authStatus: document.getElementById('auth-status'),
  tokenHelpToggle: document.getElementById('token-help-toggle'),
  tokenHelp: document.getElementById('token-help'),
  app: document.getElementById('app'),
  tabBtns: document.querySelectorAll('.tab-btn'),
  tabWerke: document.getElementById('tab-werke'),
  tabMedien: document.getElementById('tab-medien'),
  tabSeite: document.getElementById('tab-seite'),
  werkeTable: document.getElementById('werke-table'),
  werkeAddBtn: document.getElementById('werke-add-btn'),
  werkeSaveBtn: document.getElementById('werke-save-btn'),
  werkeStatus: document.getElementById('werke-status'),
  medienTable: document.getElementById('medien-table'),
  medienAddBtn: document.getElementById('medien-add-btn'),
  medienSaveBtn: document.getElementById('medien-save-btn'),
  medienStatus: document.getElementById('medien-status'),
  uploadMediaId: document.getElementById('upload-media-id'),
  uploadFile: document.getElementById('upload-file'),
  uploadBtn: document.getElementById('upload-btn'),
  uploadStatus: document.getElementById('upload-status'),
  pieceIdOptions: document.getElementById('piece-id-options'),
  seiteFields: document.getElementById('seite-fields'),
  seiteSaveBtn: document.getElementById('seite-save-btn'),
  seiteStatus: document.getElementById('seite-status')
};

function showStatus(elm, msg, isError) {
  elm.textContent = msg;
  elm.className = 'status ' + (isError ? 'err' : 'ok');
}

// ─── Zugang / Verbinden ─────────────────────────────────────────────────────
el.tokenHelpToggle.addEventListener('click', e => {
  e.preventDefault();
  el.tokenHelp.hidden = !el.tokenHelp.hidden;
});

el.connectBtn.addEventListener('click', async () => {
  const token = el.tokenInput.value.trim();
  if (!token) { showStatus(el.authStatus, 'Bitte zuerst einen Token einfügen.', true); return; }
  setToken(token);
  await connectAndLoad();
});

el.disconnectBtn.addEventListener('click', () => {
  clearToken();
  el.tokenInput.value = '';
  el.app.hidden = true;
  el.disconnectBtn.hidden = true;
  el.connectBtn.hidden = false;
  showStatus(el.authStatus, 'Getrennt — Token wurde aus diesem Browser gelöscht.', false);
});

async function connectAndLoad() {
  showStatus(el.authStatus, 'Verbinde …', false);
  try {
    await loadStuecke();
    await loadMedien();
    await loadSeite();
    el.app.hidden = false;
    el.connectBtn.hidden = true;
    el.disconnectBtn.hidden = false;
    showStatus(el.authStatus, 'Verbunden ✓', false);
  } catch (err) {
    showStatus(el.authStatus, 'Verbindung fehlgeschlagen: ' + err.message + ' — Token, OWNER/REPO in admin.js und Repo-Rechte prüfen.', true);
  }
}

// Beim Öffnen der Seite: falls schon ein Token gespeichert ist, direkt
// versuchen zu verbinden, damit man nicht bei jedem Besuch neu einloggen muss.
if (getToken()) {
  el.tokenInput.value = getToken();
  connectAndLoad();
}

// ─── Tabs ───────────────────────────────────────────────────────────────────
el.tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    el.tabBtns.forEach(b => b.classList.toggle('active', b === btn));
    el.tabWerke.hidden = btn.dataset.tab !== 'werke';
    el.tabMedien.hidden = btn.dataset.tab !== 'medien';
    el.tabSeite.hidden = btn.dataset.tab !== 'seite';
  });
});

// ─── Werke-Tab ──────────────────────────────────────────────────────────────
async function loadStuecke() {
  const file = await ghGetFile('stuecke.csv');
  if (file) {
    const parsed = parseCSV(file.text, STUECKE_HEADERS);
    state.stuecke = { headers: parsed.headers, rows: parsed.rows, sha: file.sha };
  } else {
    state.stuecke = { headers: STUECKE_HEADERS.slice(), rows: [], sha: null };
  }
  renderStueckeTable();
  updatePieceIdOptions();
}

function renderStueckeTable() {
  const { headers, rows } = state.stuecke;
  el.werkeTable.innerHTML = '';
  const table = document.createElement('table');
  table.appendChild(buildHeaderRow(headers));
  const tbody = document.createElement('tbody');
  rows.forEach((row, i) => tbody.appendChild(buildDataRow(headers, row, STUECKE_BOOL_COLS, () => {
    rows.splice(i, 1);
    renderStueckeTable();
    updatePieceIdOptions();
  })));
  table.appendChild(tbody);
  el.werkeTable.appendChild(table);
}

el.werkeAddBtn.addEventListener('click', () => {
  const blank = {};
  state.stuecke.headers.forEach(h => { blank[h] = ''; });
  state.stuecke.rows.push(blank);
  renderStueckeTable();
});

el.werkeSaveBtn.addEventListener('click', async () => {
  showStatus(el.werkeStatus, 'Speichere …', false);
  try {
    const csvText = stringifyCSV(state.stuecke.headers, state.stuecke.rows);
    const result = await ghPutFile('stuecke.csv', csvText, state.stuecke.sha, 'Admin: stuecke.csv aktualisiert');
    state.stuecke.sha = result.content.sha;
    updatePieceIdOptions();
    showStatus(el.werkeStatus, 'Gespeichert ✓ (auf der Live-Seite sichtbar, sobald sie neu geladen wird)', false);
  } catch (err) {
    showStatus(el.werkeStatus, err.message, true);
  }
});

function updatePieceIdOptions() {
  el.pieceIdOptions.innerHTML = '';
  state.stuecke.rows.forEach(r => {
    if (!r.id) return;
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.label = r.title || r.id;
    el.pieceIdOptions.appendChild(opt);
  });
}

// ─── Medien-Tab ─────────────────────────────────────────────────────────────
async function loadMedien() {
  const file = await ghGetFile('medien.csv');
  if (file) {
    const parsed = parseCSV(file.text, MEDIEN_HEADERS);
    state.medien = { headers: parsed.headers, rows: parsed.rows, sha: file.sha };
  } else {
    state.medien = { headers: MEDIEN_HEADERS.slice(), rows: [], sha: null };
  }
  renderMedienTable();
}

function renderMedienTable() {
  const { headers, rows } = state.medien;
  el.medienTable.innerHTML = '';
  const table = document.createElement('table');
  table.appendChild(buildHeaderRow(headers));
  const tbody = document.createElement('tbody');
  rows.forEach((row, i) => tbody.appendChild(buildDataRow(headers, row, MEDIEN_BOOL_COLS, () => {
    rows.splice(i, 1);
    renderMedienTable();
  }, 'piece_id')));
  table.appendChild(tbody);
  el.medienTable.appendChild(table);
}

el.medienAddBtn.addEventListener('click', () => {
  const blank = {};
  state.medien.headers.forEach(h => { blank[h] = ''; });
  blank.type = 'video';
  blank.role = 'detail';
  state.medien.rows.push(blank);
  renderMedienTable();
});

el.medienSaveBtn.addEventListener('click', async () => {
  showStatus(el.medienStatus, 'Speichere …', false);
  try {
    const csvText = stringifyCSV(state.medien.headers, state.medien.rows);
    const result = await ghPutFile('medien.csv', csvText, state.medien.sha, 'Admin: medien.csv aktualisiert');
    state.medien.sha = result.content.sha;
    showStatus(el.medienStatus, 'Gespeichert ✓ (auf der Live-Seite sichtbar, sobald sie neu geladen wird)', false);
  } catch (err) {
    showStatus(el.medienStatus, err.message, true);
  }
});

// ─── Gemeinsamer Tabellen-Baukasten (Werke + Medien) ────────────────────────
function buildHeaderRow(headers) {
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  headers.forEach(h => { const th = document.createElement('th'); th.textContent = h; tr.appendChild(th); });
  tr.appendChild(document.createElement('th')); // Spalte für den Löschen-Knopf
  thead.appendChild(tr);
  return thead;
}

// datalistCol: optionaler Spaltenname, der die piece_id-Vorschlagsliste bekommt
// (nur bei der Medien-Tabelle relevant — dort soll piece_id auf ein
// existierendes Werk in stuecke.csv verweisen).
function buildDataRow(headers, row, boolCols, onDelete, datalistCol) {
  const tr = document.createElement('tr');
  headers.forEach(h => {
    const td = document.createElement('td');
    if (boolCols.includes(h)) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = (row[h] || '').toUpperCase() === 'TRUE';
      cb.addEventListener('change', () => { row[h] = cb.checked ? 'TRUE' : 'FALSE'; });
      td.appendChild(cb);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = row[h] || '';
      if (h === datalistCol) input.setAttribute('list', 'piece-id-options');
      input.addEventListener('input', () => { row[h] = input.value; });
      td.appendChild(input);
    }
    tr.appendChild(td);
  });
  const tdDel = document.createElement('td');
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'row-delete';
  delBtn.textContent = '✕';
  delBtn.title = 'Zeile löschen';
  delBtn.addEventListener('click', onDelete);
  tdDel.appendChild(delBtn);
  tr.appendChild(tdDel);
  return tr;
}

// ─── Bild-Upload ────────────────────────────────────────────────────────────
// Verkleinert auf max. 1800px Kantenlänge und wandelt nach WebP (Qualität
// 0.8) um — dieselben Werte, mit denen die ursprünglichen 20 Bilder von Hand
// per ImageMagick komprimiert wurden (siehe IMPLEMENTATION_LOG.md,
// 2026-06-30), damit neue Bilder sich nahtlos einreihen.
async function processImageFile(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Datei ist kein lesbares Bild.'));
    im.src = dataUrl;
  });

  const aspect = Math.round((img.naturalWidth / img.naturalHeight) * 1000) / 1000;
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', IMAGE_QUALITY));
  if (!blob) throw new Error('Dieser Browser kann kein WebP erzeugen — bitte in Chrome oder Firefox versuchen.');

  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Komprimiertes Bild konnte nicht gelesen werden.'));
    reader.readAsDataURL(blob);
  });

  return { base64, aspect };
}

el.uploadBtn.addEventListener('click', async () => {
  const mediaId = el.uploadMediaId.value.trim();
  const file = el.uploadFile.files[0];
  if (!mediaId) { showStatus(el.uploadStatus, 'Bitte eine Bild-ID eingeben (z.B. flowervase_2).', true); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(mediaId)) { showStatus(el.uploadStatus, 'Bild-ID darf nur Buchstaben, Zahlen, "_" und "-" enthalten (wird zum Dateinamen).', true); return; }
  if (!file) { showStatus(el.uploadStatus, 'Bitte zuerst eine Bilddatei auswählen.', true); return; }
  if (state.medien.rows.some(r => r.media_id === mediaId)) { showStatus(el.uploadStatus, `Bild-ID "${mediaId}" gibt es schon in der Medien-Tabelle — bitte eine andere wählen.`, true); return; }

  el.uploadBtn.disabled = true;
  showStatus(el.uploadStatus, 'Verkleinere und komprimiere Bild …', false);
  try {
    const { base64, aspect } = await processImageFile(file);

    showStatus(el.uploadStatus, 'Lade Bild zu GitHub hoch …', false);
    const imagePath = `images/${mediaId}.webp`;
    const existing = await ghGetFile(imagePath); // null, falls neu — sonst brauchen wir den sha zum Überschreiben
    await ghPutFile(imagePath, base64, existing ? existing.sha : null, `Admin: Bild ${mediaId}.webp hochgeladen`, true);

    // Neue Zeile mit sinnvollen Vorgaben unten an die Medien-Tabelle anhängen —
    // Rolle/Verwendung (home/portfolio/shop) trägt Hana/Charlotte direkt in
    // der Tabelle darunter ein.
    const blank = {};
    state.medien.headers.forEach(h => { blank[h] = ''; });
    blank.media_id = mediaId;
    blank.type = 'image';
    blank.role = 'cover';
    blank.order = String(state.medien.rows.length);
    blank.aspect = String(aspect);
    blank.home = 'FALSE'; blank.portfolio = 'FALSE'; blank.shop = 'FALSE';
    state.medien.rows.push(blank);
    renderMedienTable();

    el.uploadMediaId.value = '';
    el.uploadFile.value = '';
    showStatus(el.uploadStatus, `Bild hochgeladen ✓ — jetzt unten in der Medien-Tabelle piece_id/role/home/portfolio/shop eintragen und "Medien speichern" klicken.`, false);
  } catch (err) {
    showStatus(el.uploadStatus, err.message, true);
  } finally {
    el.uploadBtn.disabled = false;
  }
});


// ─── Seite-Tab (texte.csv) ──────────────────────────────────────────────────
// Feste Seitentexte (Workshop-/Contact-Abschnitt, Navigation, Instagram), die
// bisher direkt in index.html standen. Eigene, freundlich beschriftete Felder
// statt einer rohen Tabelle wie bei Werke/Medien: die Zuordnung "key" → Stelle
// auf der Seite ist fest im Code (app.js, TEXTE_TARGETS) verankert — die
// Schluessel duerfen sich beim Bearbeiten nicht aendern, nur ihre Werte.
const TEXTE_FIELDS = [
  { key: 'nav_portfolio', label: 'Navigation — "Portfolio"-Link' },
  { key: 'nav_workshops', label: 'Navigation — "Workshops"-Link' },
  { key: 'nav_prints', label: 'Navigation — "Take Home"-Link' },
  { key: 'nav_contact', label: 'Navigation — "Contact"-Link' },
  { key: 'workshop_heading', label: 'Workshops — Überschrift' },
  { key: 'workshop_body', label: 'Workshops — Text', multiline: true },
  { key: 'workshop_email', label: 'Workshops — Kontakt-E-Mail' },
  { key: 'contact_heading', label: 'Contact — Überschrift' },
  { key: 'contact_body', label: 'Contact — Text', multiline: true },
  { key: 'contact_email', label: 'Contact — E-Mail' },
  { key: 'instagram_handle', label: 'Instagram — Anzeigename (z.B. @hana.makes)' },
  { key: 'instagram_url', label: 'Instagram — Link (z.B. https://instagram.com/...)' }
];

async function loadSeite() {
  const file = await ghGetFile('texte.csv');
  const values = {};
  if (file) {
    parseCSV(file.text, ['key', 'value']).rows.forEach(r => { values[r.key] = r.value; });
  }
  state.seite = { values, sha: file ? file.sha : null };
  renderSeiteFields();
}

function renderSeiteFields() {
  el.seiteFields.innerHTML = '';
  TEXTE_FIELDS.forEach(f => {
    const wrap = document.createElement('div');
    wrap.className = 'field-row';
    const label = document.createElement('label');
    label.textContent = f.label;
    label.setAttribute('for', 'seite-input-' + f.key);
    const input = document.createElement(f.multiline ? 'textarea' : 'input');
    input.id = 'seite-input-' + f.key;
    if (!f.multiline) input.type = 'text';
    input.value = state.seite.values[f.key] || '';
    input.addEventListener('input', () => { state.seite.values[f.key] = input.value; });
    wrap.appendChild(label);
    wrap.appendChild(input);
    el.seiteFields.appendChild(wrap);
  });
}

el.seiteSaveBtn.addEventListener('click', async () => {
  showStatus(el.seiteStatus, 'Speichere …', false);
  try {
    const rows = TEXTE_FIELDS.map(f => ({ key: f.key, value: state.seite.values[f.key] || '' }));
    const csvText = stringifyCSV(['key', 'value'], rows);
    const result = await ghPutFile('texte.csv', csvText, state.seite.sha, 'Admin: texte.csv aktualisiert');
    state.seite.sha = result.content.sha;
    showStatus(el.seiteStatus, 'Gespeichert ✓ (auf der Live-Seite sichtbar, sobald sie neu geladen wird)', false);
  } catch (err) {
    showStatus(el.seiteStatus, err.message, true);
  }
});
