#!/usr/bin/env node
// ============================================================================
// sync-sheet.js
//
// Holt zwei Tabs aus Hanas Google Sheet — "prints" (ein Werk = eine Zeile;
// hieß ursprünglich "Stücke", wurde im Sheet umbenannt — Datei/Variable im
// Code heißen trotzdem weiter "stuecke", das beschreibt nur die Rolle im
// Code, nicht den Tabnamen) und "media" (ein Bild/Video = eine Zeile,
// media_id/piece_id/type/role/…) — und schreibt sie nach
// webshop-v0/stuecke.csv bzw. webshop-v0/medien.csv. Die Live-Seite (app.js)
// lädt dann diese lokalen Dateien statt bei jedem Besuch live bei Google
// nachzufragen.
//
// Für die Medien-Zeilen wird das Seitenverhältnis (aspect) NICHT aus dem
// Sheet übernommen — Hana trägt das nirgends ein. Stattdessen liest dieses
// Skript die echte Breite/Höhe direkt aus der Bilddatei und berechnet
// aspect = Breite ÷ Höhe selbst. Das nimmt eine ganze Fehlerquelle raus
// (Tippfehler wie "0,8" statt "0.8", oder ein vergessenes Feld, das dann
// still auf ein Quadrat zurückfällt).
//
// Lokal manuell ausführen:   node scripts/sync-sheet.js
// Automatisch:                läuft stündlich über die GitHub Action
//                              (.github/workflows/sync-sheet.yml)
// ============================================================================

const fs = require('fs');
const path = require('path');

// Beide Links kommen aus Google Sheets: Datei → Freigeben → Im Web
// veröffentlichen → im Dropdown-Menü den jeweiligen Tab wählen (NICHT
// "Gesamtes Dokument" — das ergäbe eine einzige CSV mit allen Tabs
// zusammengemischt) → Format "Kommagetrennte Werte (.csv)" → Link kopieren.
// Für jeden Tab einen eigenen Link, weil "Publish to web" pro Tab einen
// eigenen CSV-Export erzeugt.
// gid=0 ist der "prints"-Tab (siehe die Sheet-URL, die Charlotte zu Beginn
// geschickt hat: .../edit?gid=0#gid=0 — Rename ändert die gid nicht). Der
// alte Link ohne gid/single-Parameter (".../pub?output=csv") ist inzwischen
// tot (HTTP 400) — vermutlich, weil das Dokument jetzt mehrere
// veröffentlichte Tabs hat und Google seitdem für jeden einen expliziten
// gid+single-Parameter verlangt, so wie beim media-Link direkt darunter.
const STUECKE_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSfoyJYQpsl5AeMg3JAiYqfrBNskev9ZrtVLGVE4nhWTAD-qUCPtGaQFRkw3J1uwjj2ZRy4B8ZhBjiZ/pub?gid=0&single=true&output=csv';
// Zeigt auf den Tab "media".
const MEDIEN_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSfoyJYQpsl5AeMg3JAiYqfrBNskev9ZrtVLGVE4nhWTAD-qUCPtGaQFRkw3J1uwjj2ZRy4B8ZhBjiZ/pub?gid=1569104768&single=true&output=csv';

const IMAGES_DIR = path.join(__dirname, '..', 'images');
const OUT_STUECKE = path.join(__dirname, '..', 'stuecke.csv');
const OUT_MEDIEN = path.join(__dirname, '..', 'medien.csv');

async function fetchCSV(url, label) {
  if (!url) throw new Error(label + ': keine URL eingetragen (siehe TODO oben in sync-sheet.js)');
  const res = await fetch(url);
  if (!res.ok) throw new Error(label + ': Sheet-Abruf fehlgeschlagen: HTTP ' + res.status);
  return res.text();
}

// ─── Mini-CSV-Parser (gleiche Logik wie in app.js: multi-line quoted fields) ─
// Gibt rohe Zeilen als Array-of-Arrays zurück (noch keine Objekte, keine
// Typ-Umwandlung) — die Aufrufer wissen selbst, welche Spalte was bedeutet.
function parseCSVRows(text) {
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

function toCSVLine(values) {
  return values.map(v => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',');
}

// ─── Bildmaße direkt aus dem Datei-Header lesen (kein npm-Paket nötig) ──────
// Unterstützt WebP (alle drei Chunk-Varianten) und PNG. PNG kommt dazu, weil
// sich beim Testen herausgestellt hat, dass flowervase_0.webp/flowervase_1.webp
// in diesem Projekt tatsächlich PNG-Bytes mit einer .webp-Endung sind (im
// Browser fällt das nicht auf, weil <img>/background-image den Inhalt anhand
// der Bytes erkennen, nicht anhand der Dateiendung — aber ein Skript, das
// gezielt "ist das WebP?" prüft, muss beide Formate kennen, sonst bekommen
// genau diese beiden Bilder fälschlich aspect=1).
function readImageSize(buf) {
  if (buf.length >= 24 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buf.length >= 30) {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { w, h };
    }
    if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      const w = 1 + (((b1 & 0x3f) << 8) | b0);
      const h = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { w, h };
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      const w = ((buf[27] << 8) | buf[26]) & 0x3fff;
      const h = ((buf[29] << 8) | buf[28]) & 0x3fff;
      return { w, h };
    }
    return null;
  }
  // PNG-Signatur + IHDR-Chunk: Breite/Höhe stehen als 4-Byte big-endian
  // Zahlen direkt nach "IHDR" an fester Position.
  if (buf.length >= 24 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a' && buf.toString('ascii', 12, 16) === 'IHDR') {
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    return { w, h };
  }
  return null;
}

function computeAspect(mediaId) {
  const file = path.join(IMAGES_DIR, mediaId + '.webp');
  if (!fs.existsSync(file)) {
    console.warn('  … keine Bilddatei für "' + mediaId + '" gefunden (images/' + mediaId + '.webp) — aspect bleibt 1.');
    return 1;
  }
  const size = readImageSize(fs.readFileSync(file));
  if (!size || !size.w || !size.h) {
    console.warn('  … Maße von "' + mediaId + '.webp" nicht lesbar — aspect bleibt 1.');
    return 1;
  }
  return Math.round((size.w / size.h) * 1000) / 1000;
}

async function main() {
  console.log('Hole Stücke-Tab ("prints" im Sheet) …');
  const stueckeText = await fetchCSV(STUECKE_CSV_URL, 'Stücke');
  const stueckeRows = parseCSVRows(stueckeText);
  if (stueckeRows.length < 2 || !stueckeRows[0].includes('id')) {
    throw new Error('Stücke-CSV sieht nicht plausibel aus (keine "id"-Spalte gefunden) — breche ab, nichts wird überschrieben.');
  }

  console.log('Hole Medien-Tab ("media" im Sheet) …');
  const medienText = await fetchCSV(MEDIEN_CSV_URL, 'Medien');
  const medienRows = parseCSVRows(medienText);
  const medienHeaders = medienRows[0] || [];
  const idIdx = medienHeaders.indexOf('media_id');
  if (medienRows.length < 2 || idIdx === -1) {
    throw new Error('Medien-CSV sieht nicht plausibel aus (keine "media_id"-Spalte gefunden) — breche ab, nichts wird überschrieben.');
  }

  console.log('Berechne Seitenverhältnisse aus den Bilddateien …');
  // Falls im Sheet selbst (noch) eine "aspect"-Spalte existiert — von Hand
  // eingetragen oder ein Rest aus einer früheren Version — wird sie hier
  // rausgefiltert und durch die aus der Bilddatei berechnete ersetzt. Sonst
  // gäbe es zwei "aspect"-Spalten in der Ausgabe, und die von Hand
  // eingetragene (mit allen ihren möglichen Tippfehlern/Locale-Problemen —
  // z.B. "1.842" wird bei deutscher Spracheinstellung als 1842 gelesen, weil
  // dort der Punkt der Tausender-Trenner ist) würde nie benutzt, aber
  // trotzdem verwirrend mit rumliegen.
  const aspectIdx = medienHeaders.findIndex(h => h.trim().toLowerCase() === 'aspect');
  const stripAspect = cols => aspectIdx === -1 ? cols : cols.filter((_, i) => i !== aspectIdx);
  const outHeaders = stripAspect(medienHeaders).concat(['aspect']);
  const medienLines = [toCSVLine(outHeaders)];
  let rowCount = 0;
  for (const cols of medienRows.slice(1)) {
    const mediaId = cols[idIdx];
    if (!mediaId) continue; // leere Zeilen ignorieren
    const aspect = computeAspect(mediaId);
    medienLines.push(toCSVLine(stripAspect(cols).concat([aspect])));
    rowCount++;
  }

  fs.writeFileSync(OUT_STUECKE, stueckeText, 'utf8');
  fs.writeFileSync(OUT_MEDIEN, medienLines.join('\n') + '\n', 'utf8');
  console.log('stuecke.csv geschrieben (' + (stueckeRows.length - 1) + ' Zeilen) → ' + OUT_STUECKE);
  console.log('medien.csv geschrieben (' + rowCount + ' Zeilen) → ' + OUT_MEDIEN);
}

main().catch(err => {
  console.error('Fehler:', err.message);
  process.exit(1);
});
