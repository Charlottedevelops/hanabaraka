// ============================================================================
// Hana Baraka — Webshop v0 (statisch, ohne React/Babel/CDN-Abhängigkeit)
//
// Das ist die Vanilla-JS-Portierung von Hana.dc.html (dem Design-Canvas-
// Arbeitsfile). Gleiche Logik (CSV-Laden, Collage-/Grid-Layout, Klick-
// Verhalten, Edit-Mode zum Verschieben der Kacheln) — aber ohne React,
// ohne Babel, ohne Laden von drei externen Bibliotheken bei jedem
// Seitenaufruf. Läuft direkt im Browser, keine Build-Schritte nötig.
//
// ─── Zwei Tabellen statt einer ──────────────────────────────────────────────
// Früher gab es eine einzige pieces.csv, in der eine Zeile gleichzeitig ein
// "Stück" (Titel, Preis, Story) UND ein einzelnes Bild war. Kind-Bilder
// hingen per `parent`-Spalte an ihrem Hauptbild und waren dadurch *überall*
// unsichtbar außer im Popup ihres Elternbilds — ihre eigenen home/shop-Haken
// wurden nie geprüft. Das brach genau in den Fällen, die den Umbau hier
// ausgelöst haben: ein Detailbild sollte eigenständig im Home-Moodboard
// auftauchen können, im Shop-Grid aber nur das Hauptfoto erscheinen.
//
// Jetzt gibt es zwei Tabellen: `stuecke.csv` (ein Stück = eine Zeile, nur
// Metadaten wie Titel/Preis/Story) und `medien.csv` (ein Bild oder Video =
// eine Zeile, verweist per `piece_id` zurück auf sein Stück). home/portfolio/
// shop stehen jetzt auf der Medien-Zeile — jedes Bild entscheidet für sich,
// wo es als eigene Kachel auftaucht. `role` (cover/detail) legt fest, welches
// Bild im Overlay sofort zu sehen ist und welche erst hinter einem Klick auf
// "Weitere Ansichten" stecken. `type` (image/video) schaltet zwischen einem
// <img> und einem eingebetteten YouTube-<iframe> im Overlay um.
// ============================================================================

// ─── Google Sheet als CSV — ein Link pro Tab ────────────────────────────────
// Sheet: File → Share → Publish to web → im Dropdown den jeweiligen Tab
// wählen (nicht "Gesamtes Dokument") → Format CSV → Link hier einfügen.
// gid=0&single=true statt des alten bloßen "?output=csv" — der alte Link
// ist tot (HTTP 400), seit das Dokument mehrere veröffentlichte Tabs hat.
const STUECKE_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSfoyJYQpsl5AeMg3JAiYqfrBNskev9ZrtVLGVE4nhWTAD-qUCPtGaQFRkw3J1uwjj2ZRy4B8ZhBjiZ/pub?gid=0&single=true&output=csv';
const MEDIEN_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSfoyJYQpsl5AeMg3JAiYqfrBNskev9ZrtVLGVE4nhWTAD-qUCPtGaQFRkw3J1uwjj2ZRy4B8ZhBjiZ/pub?gid=1569104768&single=true&output=csv';

// ─── CSV-Parser ──────────────────────────────────────────────────────────────
// Zerlegt CSV-Text (inkl. mehrzeiliger "gequoteter" Felder) in ein Array von
// Objekten { spaltenname: wert-als-string }. Die Umwandlung in Boolean/Zahl
// passiert danach separat pro Tabelle (parseStuecke/parseMedien) — der
// Tokenizer selbst weiß nichts über die Bedeutung der Spalten.
function tokenizeCSV(text) {
  const rows = [];
  let cur = '', inQ = false, row = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQ && text[i + 1] === '"') { cur += '"'; i++; } // escaped ""
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
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map(cols => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (cols[i] || '').trim(); });
    return obj;
  });
}

function parseStuecke(text) {
  return tokenizeCSV(text)
    .filter(r => r.id)
    .map(r => ({ ...r, featured: (r.featured || '').toUpperCase() === 'TRUE' }));
}

function parseMedien(text) {
  return tokenizeCSV(text)
    .filter(r => r.media_id)
    .map(r => ({
      id: r.media_id,               // Dateiname-Basis, z.B. images/<id>.webp
      piece_id: r.piece_id,
      type: r.type || 'image',      // 'image' | 'video'
      role: r.role || 'cover',      // 'cover' | 'detail'
      order: parseFloat(r.order) || 0,
      home: (r.home || '').toUpperCase() === 'TRUE',
      portfolio: (r.portfolio || '').toUpperCase() === 'TRUE',
      shop: (r.shop || '').toUpperCase() === 'TRUE',
      video_id: r.video_id || '',
      // von sync-sheet.js automatisch aus der Bilddatei berechnet — hier nur
      // noch als Zahl übernehmen, mit Fallback 1 (Quadrat) falls mal leer.
      aspect: parseFloat(r.aspect) || 1
    }));
}

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  mode: 'home',           // 'home' | 'portfolio' | 'workshop' | 'prints' | 'contact'
  sel: null,               // aktuell geöffnete Medien-Zeile (Overlay)
  galleryOpen: false,      // ist die "Weitere Ansichten"-Galerie im Overlay aufgeklappt?
  theme: 'all',
  colour: 'all',
  vw: window.innerWidth,
  vh: window.innerHeight,
  stuecke: [],             // eine Zeile pro Werk (Titel, Preis, Story, …)
  medien: [],              // eine Zeile pro Bild/Video (Kachel-Sichtbarkeit, Rolle, …)
  editMode: false,
  dragOffsets: {}          // { [mediaId]: {dx, dy, dw, drot} }
};

let dragged = false; // unterdrückt den Klick direkt nach einem Drag

function rnd(seed, salt) {
  const x = Math.sin(seed * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function collage(list, ax, ay, aw, ah) {
  const n = list.length;
  const cols = aw > 1180 ? 5 : aw > 820 ? 4 : 3;
  const rows = Math.ceil(n / cols);
  const cellW = aw / cols, cellH = ah / rows;
  const res = {};
  list.forEach((p, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const sd = (p.seedBase || 1) + 1;
    const r1 = rnd(sd, 1), r2 = rnd(sd, 2), r3 = rnd(sd, 3), r4 = rnd(sd, 4), r5 = rnd(sd, 5);
    let w = cellW * (0.5 + r1 * 0.5);
    let h = w / p.aspect;
    const maxH = cellH * 1.85;
    if (h > maxH) { h = maxH; w = h * p.aspect; }
    const jx = (r2 - 0.5) * cellW * 0.46, jy = (r3 - 0.5) * cellH * 0.4;
    const cx = ax + col * cellW + cellW / 2 + jx;
    const cy = ay + row * cellH + cellH / 2 + jy;
    res[p.id] = { left: cx - w / 2, top: cy - h / 2, w, h, rot: (r4 - 0.5) * 6, z: 12 + Math.floor(r5 * 22) };
  });
  return res;
}

// Tiefster Punkt (top+h) über alle Kacheln einer Geometrie-Tabelle —
// z.B. um zu wissen, wie hoch #content mindestens sein muss, damit
// nichts unten abgeschnitten wird.
function geomsBottom(geoms) {
  return Object.values(geoms).reduce((max, g) => Math.max(max, g.top + g.h), 0);
}

function grid(list, ax, ay, aw) {
  const cols = aw > 1180 ? 4 : aw > 820 ? 3 : 2;
  const gap = 20;
  const colW = (aw - gap * (cols - 1)) / cols;
  const ch = new Array(cols).fill(0);
  const res = {};
  list.forEach(p => {
    let c = 0; for (let k = 1; k < cols; k++) if (ch[k] < ch[c]) c = k;
    const w = colW, h = colW / p.aspect;
    res[p.id] = { left: ax + c * (colW + gap), top: ay + ch[c], w, h, rot: 0, z: 12 };
    ch[c] += h + gap;
  });
  return { res, bottom: ay + Math.max(0, ...ch) };
}

// ─── DOM-Referenzen ──────────────────────────────────────────────────────────
const el = {
  scrollwrap: document.getElementById('scrollwrap'),
  content: document.getElementById('content'),
  philosophy: document.getElementById('philosophy'),
  navHome: document.getElementById('nav-home'),
  navPortfolio: document.getElementById('nav-portfolio'),
  navWorkshop: document.getElementById('nav-workshop'),
  navPrints: document.getElementById('nav-prints'),
  navContact: document.getElementById('nav-contact'),
  filterbar: document.getElementById('filterbar'),
  themePills: document.getElementById('theme-pills'),
  colourPills: document.getElementById('colour-pills'),
  workshopSection: document.getElementById('workshop-section'),
  contactSection: document.getElementById('contact-section'),
  contactPortraitFrame: document.getElementById('contact-portrait-frame'),
  overlay: document.getElementById('overlay'),
  overlayPanel: document.getElementById('overlay-panel'),
  overlayMedia: document.getElementById('overlay-media'),
  overlayOverline: document.getElementById('overlay-overline'),
  overlayTitle: document.getElementById('overlay-title'),
  overlayMeta: document.getElementById('overlay-meta'),
  overlayStory: document.getElementById('overlay-story'),
  overlayShop: document.getElementById('overlay-shop'),
  overlayPrice: document.getElementById('overlay-price'),
  overlayAvail: document.getElementById('overlay-avail'),
  overlayEnquire: document.getElementById('overlay-enquire'),
  overlayArchive: document.getElementById('overlay-archive'),
  overlayChildren: document.getElementById('overlay-children'),
  overlayClose: document.getElementById('overlay-close'),
  editBanner: document.getElementById('edit-banner'),
  editReset: document.getElementById('edit-reset'),
  loading: document.getElementById('loading')
};

const tileEls = new Map(); // mediaId -> { wrap, rotateHandle, resizeHandle }

// ─── Navigation ──────────────────────────────────────────────────────────────
function setMode(mode) { state.mode = mode; state.sel = null; render(); }
el.navHome.addEventListener('click', () => setMode('home'));
el.navPortfolio.addEventListener('click', () => setMode('portfolio'));
el.navWorkshop.addEventListener('click', () => setMode('workshop'));
el.navPrints.addEventListener('click', () => setMode('prints'));
el.navContact.addEventListener('click', () => setMode('contact'));

// ─── Detail-Overlay öffnen/schließen ─────────────────────────────────────────
// `media` ist die angeklickte Medien-Zeile (nicht das Stück!) — sie wird als
// "Hero"-Bild im Overlay gezeigt. Alle anderen Medien-Zeilen mit derselben
// piece_id landen als eingeklappte Galerie darunter (siehe render()).
function openDetail(media) { state.sel = media; state.galleryOpen = false; render(); }
function closeDetail() { state.sel = null; state.galleryOpen = false; render(); }
el.overlay.addEventListener('click', closeDetail);
el.overlayPanel.addEventListener('click', e => e.stopPropagation());
el.overlayClose.addEventListener('click', closeDetail);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.sel) closeDetail(); });

// Galerie-Klicks: entweder auf den "Weitere Ansichten"-Knopf (auf-/zuklappen)
// oder auf ein Galerie-Thumbnail (wird zum neuen Hero-Bild). Ein einziger
// delegierter Listener statt einem pro Bild, weil overlayChildren bei jedem
// Render neu geschrieben wird (siehe render()).
el.overlayChildren.addEventListener('click', e => {
  const toggleBtn = e.target.closest('.gallery-toggle');
  if (toggleBtn) { state.galleryOpen = !state.galleryOpen; render(); return; }
  const thumb = e.target.closest('[data-media-id]');
  if (thumb) {
    const m = state.medien.find(mm => mm.id === thumb.getAttribute('data-media-id'));
    if (m) { state.sel = m; render(); } // Galerie bleibt offen, nur der Hero wechselt
  }
});

// ─── Edit-Mode (?edit=hanaedits) ─────────────────────────────────────────────
el.editReset.addEventListener('click', () => {
  state.dragOffsets = {};
  try { localStorage.removeItem('hana-collage-offsets'); } catch {}
  render();
});

// ─── Kachel-Drag (Verschieben / Größe / Rotation) ────────────────────────────
function attachDrag(p, wrap, rotateHandle, resizeHandle) {
  wrap.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !wrap.classList.contains('is-draggable')) return;
    if (e.target === rotateHandle || e.target === resizeHandle) return;
    e.preventDefault();
    const elTile = wrap;
    const geom = elTile._geom;
    const curOff = state.dragOffsets[p.id] || {};
    const baseLeft = geom.left + (curOff.dx || 0);
    const baseTop = geom.top + (curOff.dy || 0);
    const startX = e.clientX, startY = e.clientY;
    let lastDdx = 0, lastDdy = 0, moved = false;
    elTile.style.transition = 'none';
    elTile.style.zIndex = '999';
    elTile.style.cursor = 'grabbing';
    elTile.setPointerCapture(e.pointerId);
    const onMove = ev => {
      lastDdx = ev.clientX - startX; lastDdy = ev.clientY - startY;
      if (!moved && Math.hypot(lastDdx, lastDdy) < 5) return;
      moved = true;
      elTile.style.left = (baseLeft + lastDdx) + 'px';
      elTile.style.top = (baseTop + lastDdy) + 'px';
    };
    const onUp = () => {
      elTile.removeEventListener('pointermove', onMove);
      elTile.removeEventListener('pointerup', onUp);
      elTile.style.cursor = 'grab';
      if (moved) {
        dragged = true;
        const prev = state.dragOffsets[p.id] || {};
        state.dragOffsets = { ...state.dragOffsets, [p.id]: { ...prev, dx: (prev.dx || 0) + lastDdx, dy: (prev.dy || 0) + lastDdy } };
        try { localStorage.setItem('hana-collage-offsets', JSON.stringify(state.dragOffsets)); } catch {}
        render();
      }
    };
    elTile.addEventListener('pointermove', onMove);
    elTile.addEventListener('pointerup', onUp);
  });

  resizeHandle.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !wrap.classList.contains('is-draggable')) return;
    e.preventDefault(); e.stopPropagation();
    const handle = resizeHandle;
    const elTile = wrap;
    const geom = elTile._geom;
    const curOff = state.dragOffsets[p.id] || {};
    const startDw = curOff.dw || 0;
    const startX = e.clientX, startY = e.clientY;
    let lastDw = startDw;
    handle.setPointerCapture(e.pointerId);
    elTile.style.transition = 'none';
    const onMove = ev => {
      const delta = ((ev.clientX - startX) + (ev.clientY - startY)) / 2;
      lastDw = Math.max(-geom.w + 40, startDw + delta);
      const newW = geom.w + lastDw;
      elTile.style.width = newW + 'px';
      elTile.style.height = (newW / p.aspect) + 'px';
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      const prev = state.dragOffsets[p.id] || {};
      state.dragOffsets = { ...state.dragOffsets, [p.id]: { ...prev, dw: lastDw } };
      try { localStorage.setItem('hana-collage-offsets', JSON.stringify(state.dragOffsets)); } catch {}
      render();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });

  rotateHandle.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !wrap.classList.contains('is-draggable')) return;
    e.preventDefault(); e.stopPropagation();
    const handle = rotateHandle;
    const elTile = wrap;
    const geom = elTile._geom;
    const rect = elTile.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const curOff = state.dragOffsets[p.id] || {};
    const baseDrot = curOff.drot || 0;
    const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
    let lastDrot = baseDrot;
    handle.setPointerCapture(e.pointerId);
    elTile.style.transition = 'none';
    const onMove = ev => {
      const angle = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI;
      lastDrot = baseDrot + (angle - startAngle);
      elTile.style.transform = 'rotate(' + (geom.rot + lastDrot) + 'deg)';
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      const prev = state.dragOffsets[p.id] || {};
      state.dragOffsets = { ...state.dragOffsets, [p.id]: { ...prev, drot: lastDrot } };
      try { localStorage.setItem('hana-collage-offsets', JSON.stringify(state.dragOffsets)); } catch {}
      render();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

// ─── Kachel-Elemente einmalig anlegen ─────────────────────────────────────────
// `p` ist eine Medien-Zeile. `piece` ihre zugehörige Stück-Zeile (für Titel/
// Preis/Jahr in der Bildunterschrift — die Medien-Zeile selbst kennt das
// nicht mehr, das steht jetzt nur noch beim Stück).
function ensureTileEls(mediaList, piecesById) {
  mediaList.forEach(p => {
    if (tileEls.has(p.id)) return;
    const piece = piecesById[p.piece_id] || {};
    const wrap = document.createElement('div');
    wrap.className = 'tile' + (p.type === 'video' ? ' is-video' : '');
    wrap.style.backgroundImage = "url(\"images/" + p.id + ".webp\")";

    const cap = document.createElement('div');
    cap.className = 'cap';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'title';
    titleSpan.textContent = piece.title || '';
    const subSpan = document.createElement('span');
    subSpan.className = 'sub';
    subSpan.textContent = p.shop ? (piece.medium + ' · ' + piece.price) : (piece.medium + ' · ' + piece.year);
    cap.appendChild(titleSpan); cap.appendChild(subSpan);

    const rotateHandle = document.createElement('div');
    rotateHandle.className = 'handle rotate';
    rotateHandle.title = 'Drehen';
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'handle resize';
    resizeHandle.title = 'Größe ändern';

    wrap.appendChild(cap);
    wrap.appendChild(rotateHandle);
    wrap.appendChild(resizeHandle);
    el.content.appendChild(wrap);

    wrap.addEventListener('click', () => {
      if (dragged) { dragged = false; return; }
      if (state.mode !== 'contact') openDetail(p);
    });

    attachDrag(p, wrap, rotateHandle, resizeHandle);
    tileEls.set(p.id, { wrap, rotateHandle, resizeHandle });
  });
}

// ─── Filter-Pills (Theme / Colour) ───────────────────────────────────────────
// Früher stand hier eine feste Liste ("folk"/"painting"/"object" …), die nur
// funktionierte, wenn im Sheet exakt derselbe Text in der theme/colour-Spalte
// stand — eine unsichtbare Kopplung zwischen Code und Sheet, die beim
// kleinsten Tippfehler (oder einer neuen Kategorie) still nichts mehr
// filtert. Jetzt werden die Pills aus den Werten abgeleitet, die tatsächlich
// bei den Shop-Stücken im Sheet stehen — eine neue Kategorie im Sheet taucht
// beim nächsten Sync automatisch als Pille auf, ohne Code-Änderung.
function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Nur Stücke, die auch wirklich im Shop auftauchen (mind. eine Medien-Zeile
// mit shop=TRUE) — ein Theme, das nur bei einem Portfolio-Stück steht, soll
// hier keine Pille erzeugen, die dann immer leer bleibt.
function derivePillOptions(shopPieces, field) {
  const values = [...new Set(shopPieces.map(s => s[field]).filter(Boolean))].sort();
  return [['all', 'All']].concat(values.map(v => [v, capitalize(v)]));
}

function buildPills(container, list, stateKey) {
  container.innerHTML = '';
  list.forEach(([key, label]) => {
    const span = document.createElement('span');
    span.className = 'pill' + (state[stateKey] === key ? ' active' : '');
    span.textContent = label;
    span.addEventListener('click', () => { state[stateKey] = key; render(); });
    container.appendChild(span);
  });
}

// ─── Haupt-Render ─────────────────────────────────────────────────────────────
function render() {
  const { vw, vh, mode, sel, editMode, dragOffsets } = state;
  const H = vw > 720 ? 120 : 104;
  const FB = 60;
  const pad = vw > 900 ? 40 : 16;

  const piecesById = Object.fromEntries(state.stuecke.map(s => [s.id, s]));
  const M = state.medien.map((m, i) => ({ ...m, seedBase: i }));

  // Jede Medien-Zeile, die in mindestens einem Kontext als eigene Kachel
  // auftauchen soll (home/portfolio/shop) — die anderen bleiben unsichtbar
  // und existieren nur als Galeriebild im Overlay ihres Stücks.
  const tileCandidates = M.filter(p => p.home || p.portfolio || p.shop);
  ensureTileEls(tileCandidates, piecesById);

  // Ruheposition für Kacheln, die im aktuellen Modus gerade nicht gezeigt
  // werden (op=0) — sie "warten" an dieser Stelle, damit sie beim Moduswechsel
  // von dort aus einfliegen, statt aus der Ecke (0,0) zu springen.
  const rest = collage(tileCandidates, pad, H + 4, vw - 2 * pad, vh - H - pad - 4);

  const homeList = tileCandidates.filter(p => p.home);
  const home = collage(homeList, pad, H + 4, vw - 2 * pad, vh - H - pad - 4);

  const workList = tileCandidates.filter(p => p.portfolio);
  const workC = collage(workList, pad, H + 4, vw - 2 * pad, vh - H - pad - 4);

  let shopList = tileCandidates.filter(p => p.shop)
    .slice()
    .sort((a, b) => ((piecesById[b.piece_id] || {}).featured ? 1 : 0) - ((piecesById[a.piece_id] || {}).featured ? 1 : 0));
  const shopShown = shopList.filter(p => {
    const piece = piecesById[p.piece_id] || {};
    return (state.theme === 'all' || piece.theme === state.theme) && (state.colour === 'all' || piece.colour === state.colour);
  });

  // Grundlage für die Filter-Pills: die Stücke, die überhaupt im Shop stehen
  // (unabhängig vom aktuell aktiven Filter — sonst würde das Anklicken einer
  // Pille andere Pillen zum Verschwinden bringen).
  const shopPieces = [...new Map(shopList.map(p => [p.piece_id, piecesById[p.piece_id]])).values()].filter(Boolean);
  const g = grid(shopShown, pad, H + FB + 16, vw - 2 * pad);

  let contentH = vh;
  if (mode === 'prints') contentH = Math.max(vh, g.bottom + 56);
  else if (mode === 'home') contentH = Math.max(vh, geomsBottom(home) + 56);
  el.content.style.height = contentH + 'px';
  el.scrollwrap.style.overflowY = (mode === 'prints' || mode === 'home') ? 'auto' : 'hidden';

  // Welche Geometrie-Tabelle im aktuellen Modus "aktiv" ist (op=1). Alles,
  // was hier keinen Eintrag hat, bleibt unsichtbar (op=0) auf der Ruheposition.
  let activeGeoms = {};
  if (mode === 'home') activeGeoms = home;
  else if (mode === 'portfolio') activeGeoms = workC;
  else if (mode === 'prints') activeGeoms = g.res;

  const ease = 'cubic-bezier(.66,0,.18,1)';
  tileCandidates.forEach((p, i) => {
    const active = activeGeoms[p.id];
    const geom = active || rest[p.id];
    const op = active ? 1 : 0;

    const delay = (i % 8) * 24;
    const isDraggable = editMode && op === 1;
    const off = dragOffsets[p.id] || {};
    const dispW = Math.max(40, geom ? geom.w + (off.dw || 0) : 0);
    const dispGeom = geom ? {
      ...geom,
      left: geom.left + (off.dx || 0),
      top: geom.top + (off.dy || 0),
      w: dispW,
      h: dispW / p.aspect,
      rot: geom.rot + (off.drot || 0)
    } : geom;

    const t = tileEls.get(p.id);
    const wrap = t.wrap;
    wrap._geom = dispGeom;
    wrap.classList.toggle('is-draggable', isDraggable);
    // Einzelne Properties setzen statt cssText += — sonst wächst der
    // style-Attribut-String bei jedem Render (z.B. jedes resize-Event)
    // unbegrenzt weiter, weil += immer an den bisherigen Text anhängt.
    const s = wrap.style;
    s.position = 'absolute';
    s.left = dispGeom.left + 'px';
    s.top = dispGeom.top + 'px';
    s.width = dispGeom.w + 'px';
    s.height = dispGeom.h + 'px';
    s.transform = 'rotate(' + dispGeom.rot + 'deg)';
    s.opacity = op;
    s.zIndex = op === 0 ? 2 : dispGeom.z;
    s.cursor = isDraggable ? 'grab' : 'pointer';
    s.touchAction = isDraggable ? 'none' : 'auto';
    s.pointerEvents = op === 0 ? 'none' : 'auto';
    s.transition = 'left .95s ' + ease + ' ' + delay + 'ms, top .95s ' + ease + ' ' + delay + 'ms, width .95s ' + ease + ' ' + delay + 'ms, height .95s ' + ease + ' ' + delay + 'ms, transform .95s ease ' + delay + 'ms, opacity .55s ease ' + delay + 'ms';
  });

  // Philosophie-Texte nur auf Home
  el.philosophy.classList.toggle('visible', mode === 'home');

  // Nav-Status
  el.navPortfolio.classList.toggle('active', mode === 'portfolio');
  el.navWorkshop.classList.toggle('active', mode === 'workshop');
  el.navPrints.classList.toggle('active', mode === 'prints');
  el.navContact.classList.toggle('active', mode === 'contact');

  // Filterleiste + Pills (nur bei prints sichtbar)
  el.filterbar.style.top = H + 'px';
  el.filterbar.classList.toggle('visible', mode === 'prints');
  buildPills(el.themePills, derivePillOptions(shopPieces, 'theme'), 'theme');
  buildPills(el.colourPills, derivePillOptions(shopPieces, 'colour'), 'colour');

  // Vollbild-Sections
  el.workshopSection.classList.toggle('visible', mode === 'workshop');
  el.contactSection.classList.toggle('visible', mode === 'contact');

  // ─── Detail-Overlay ─────────────────────────────────────────────────────
  // sel ist eine Medien-Zeile (das "Hero"-Bild). Alle Text-/Preis-Infos
  // kommen über sel.piece_id vom zugehörigen Stück. "Ist das käuflich?"
  // wird nicht mehr an der angeklickten Zeile selbst festgemacht (die kann
  // z.B. gerade ein Detailbild ohne eigenes shop=TRUE sein), sondern daran,
  // ob irgendeine Medien-Zeile desselben Stücks shop=TRUE hat.
  if (sel) {
    const piece = piecesById[sel.piece_id] || {};
    const isShop = state.medien.some(m => m.piece_id === sel.piece_id && m.shop);

    el.overlayMedia.innerHTML = sel.type === 'video'
      ? '<iframe src="https://www.youtube-nocookie.com/embed/' + encodeURIComponent(sel.video_id || '') +
        '" title="' + (piece.title || '') + '" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>'
      : '<img src="images/' + sel.id + '.webp" alt="' + (piece.title || '') + '">';

    el.overlayOverline.textContent = (piece.place || '') + ' · ' + (piece.year || '');
    el.overlayTitle.textContent = piece.title || '';
    el.overlayMeta.textContent = (piece.medium || '') + ' · ' + (piece.year || '');
    el.overlayStory.textContent = piece.story || '';
    el.overlayShop.classList.toggle('visible', isShop);
    el.overlayArchive.classList.toggle('visible', !isShop);
    el.overlayPrice.textContent = piece.price || '';
    el.overlayAvail.textContent = piece.place || '';
    el.overlayEnquire.href = 'mailto:studio@hanamakes.example?subject=' + encodeURIComponent('Enquiry — ' + (piece.title || ''));

    // Geschwister-Bilder desselben Stücks — das sind die "weiteren Ansichten".
    // Bleiben eingeklappt (state.galleryOpen === false), bis man draufklickt;
    // das ist genau der "erst Gesamtbild, Detail erst nach Klick"-Effekt für
    // den Shop-Bereich, funktioniert aber überall, wo das Overlay aufgeht.
    const siblings = state.medien
      .filter(m => m.piece_id === sel.piece_id && m.id !== sel.id)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    el.overlayChildren.classList.toggle('visible', siblings.length > 0);
    if (siblings.length > 0) {
      el.overlayChildren.innerHTML =
        '<button type="button" class="gallery-toggle">' +
          (state.galleryOpen ? 'Weniger anzeigen' : 'Weitere Ansichten (' + siblings.length + ')') +
        '</button>' +
        '<div class="gallery-strip' + (state.galleryOpen ? ' open' : '') + '">' +
          siblings.map(c =>
            '<div class="gallery-thumb' + (c.type === 'video' ? ' is-video' : '') + '" data-media-id="' + c.id + '">' +
              '<img src="images/' + c.id + '.webp" alt="' + (piece.title || '') + '">' +
            '</div>'
          ).join('') +
        '</div>';
    } else {
      el.overlayChildren.innerHTML = '';
    }
  } else {
    el.overlayMedia.innerHTML = '';
    el.overlayChildren.innerHTML = '';
  }
  el.overlay.classList.toggle('visible', !!sel);

  // Edit-Banner
  el.editBanner.classList.toggle('visible', editMode);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function handleResize() {
  const w = window.innerWidth, h = window.innerHeight;
  if (w && h) { state.vw = w; state.vh = h; render(); }
}
window.addEventListener('resize', handleResize);

// Edit-Mode per URL ?edit=hanaedits, gespeicherte Verschiebungen aus localStorage
state.editMode = new URLSearchParams(window.location.search).get('edit') === 'hanaedits';
try {
  const saved = JSON.parse(localStorage.getItem('hana-collage-offsets') || '{}');
  if (saved && typeof saved === 'object') state.dragOffsets = saved;
} catch {}

// Echtes Portrait einsetzen, falls die Datei existiert (sonst bleibt der Platzhalter stehen)
(function loadPortrait() {
  const img = new Image();
  img.onload = () => { el.contactPortraitFrame.innerHTML = '<img src="images/hana-portrait.jpg" alt="Hana Baraka">'; };
  img.onerror = () => {}; // Platzhalter bleibt, kein Fehler im Frontend
  img.src = 'images/hana-portrait.jpg';
})();

// ─── Editierbare Seiten-Texte (texte.csv) ─────────────────────────────────────
// Ergänzt stuecke.csv/medien.csv um eine einfache key,value-Tabelle für Text,
// der bisher fest in index.html stand (Workshop-/Contact-Abschnitt, Nav-
// Beschriftungen, Instagram) — gepflegt über den "Seiten-Texte"-Tab im
// Admin-Bereich (admin/admin.js). Fehlt texte.csv (noch) oder ein einzelner
// Schlüssel darin, bleibt einfach der Text stehen, der schon hier in
// index.html steht — kein Fehler, kein leeres Feld auf der Live-Seite.
const TEXTE_TARGETS = {
  nav_portfolio:    { sel: '#nav-portfolio' },
  nav_workshops:    { sel: '#nav-workshop' },
  nav_prints:       { sel: '#nav-prints' },
  nav_contact:      { sel: '#nav-contact' },
  workshop_heading: { sel: '#workshop-heading' },
  workshop_body:    { sel: '#workshop-body' },
  workshop_email:   { sel: '#workshop-email', mailto: true, subject: 'Workshops' },
  contact_heading:  { sel: '#contact-heading' },
  contact_body:     { sel: '#contact-body' },
  contact_email:    { sel: '#contact-email', mailto: true },
  instagram_handle: { sel: '#contact-instagram' },
  instagram_url:    { sel: '#contact-instagram', hrefOnly: true }
};

function applyTexte(rows) {
  rows.forEach(row => {
    const t = TEXTE_TARGETS[row.key];
    if (!t || !row.value) return;
    const node = document.querySelector(t.sel);
    if (!node) return;
    if (t.hrefOnly) { node.href = row.value; return; }
    node.textContent = row.value;
    if (t.mailto) node.href = 'mailto:' + row.value + (t.subject ? '?subject=' + t.subject : '');
  });
}

(function loadTexte() {
  fetch('texte.csv')
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then(text => applyTexte(tokenizeCSV(text)))
    .catch(err => console.warn('texte.csv nicht verfügbar (' + err.message + ') — Standardtexte aus index.html bleiben stehen.'));
})();

// Daten laden — zuerst die lokalen stuecke.csv/medien.csv (liegen direkt
// neben dieser Seite, laden also so schnell wie style.css oder ein Bild:
// kein Umweg über Google bei jedem Besuch). Beide werden per
// scripts/sync-sheet.js aus dem Google Sheet erzeugt — lokal manuell, live
// automatisch per GitHub Action (.github/workflows/sync-sheet.yml, stündlich).
//
// Falls eine der beiden Dateien (noch) nicht existiert, fällt die Seite pro
// Datei einzeln auf den direkten Live-Abruf bei Google zurück, damit nichts
// kaputt ist. Das ist dann spürbar langsamer, aber nur ein Übergangszustand.
function showLoading() { el.loading.classList.add('visible'); }
function hideLoading() { el.loading.classList.remove('visible'); }

const SOURCES = [
  { key: 'stuecke', local: 'stuecke.csv', live: STUECKE_CSV_URL, parse: parseStuecke },
  { key: 'medien', local: 'medien.csv', live: MEDIEN_CSV_URL, parse: parseMedien }
];

function loadSource(src) {
  return fetch(src.local)
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .catch(err => {
      console.warn('Lokale ' + src.local + ' nicht verfügbar (' + err.message + ') — falle auf Live-Abruf bei Google zurück.');
      if (!src.live) throw new Error(src.local + ': kein Live-Fallback-Link konfiguriert (siehe TODO oben in app.js)');
      return fetch(src.live).then(r => r.text());
    })
    .then(text => ({ key: src.key, rows: src.parse(text) }));
}

showLoading();
Promise.all(SOURCES.map(loadSource))
  .then(results => {
    results.forEach(({ key, rows }) => { state[key] = rows; });
    hideLoading();
    render();
  })
  .catch(err => {
    console.error('Daten konnten nicht geladen werden:', err.message);
    hideLoading();
    render();
  });

render();
