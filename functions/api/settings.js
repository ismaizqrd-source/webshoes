/**
 * functions/api/settings.js — ajustes de la página de inicio (editables desde el panel)
 *   GET  /api/settings   -> { settings }   (público; {} si nunca se ha guardado)
 *   POST/PUT /api/settings  { settings }   (con ADMIN_KEY si está configurada)
 * Se guarda en la tabla D1 "store" (clave "site:settings:v1").
 */
import { json, guard, CORS_HEADERS } from './products.js';

const KEY = 'site:settings:v1';
let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.exec('CREATE TABLE IF NOT EXISTS store (k TEXT NOT NULL, i INTEGER NOT NULL, v TEXT NOT NULL, PRIMARY KEY (k, i))');
  ready = true;
}

const s = (v, n = 300) => String(v ?? '').slice(0, n);
const b = (v, d) => (v === undefined ? d : !!v);
const link = (l) => ({ text: s(l && l.text, 40), link: s(l && l.link, 300) });

export function cleanSettings(x) {
  x = x && typeof x === 'object' ? x : {};
  const h = x.hero || {}, be = x.best || {}, t = x.tiles || {}, r = x.rows || {}, c = x.cats || {};
  const arr = (a, n, len) => (Array.isArray(a) ? a.map((i) => s(i, len)).filter(Boolean).slice(0, n) : []);
  const labels = {};
  if (c.labels && typeof c.labels === 'object') for (const k of Object.keys(c.labels).slice(0, 30)) labels[s(k, 40)] = s(c.labels[k], 40);
  return {
    announce: { show: b(x.announce && x.announce.show, true), items: arr(x.announce && x.announce.items, 12, 80) },
    hero: {
      show: b(h.show, true), strip: h.strip === 'brands' ? 'brands' : 'cats', tag: s(h.tag, 80), title: s(h.title, 120), subtitle: s(h.subtitle, 300),
      btn1: link(h.btn1), btn2: link(h.btn2), image: s(h.image, 300), brands: arr(h.brands, 8, 40),
    },
    best: {
      show: b(be.show, true), title: s(be.title, 60) || 'Más vendidos', mode: be.mode === 'manual' ? 'manual' : 'auto',
      ids: arr(be.ids, 40, 80), max: Math.min(Math.max(parseInt(be.max, 10) || 12, 4), 24), unique: b(be.unique, true),
    },
    tiles: { show: b(t.show, true), title: s(t.title, 60) || 'Compra por categoría' },
    rows: { show: b(r.show, true), perRow: Math.min(Math.max(parseInt(r.perRow, 10) || 8, 4), 16) },
    cats: { order: arr(c.order, 20, 40), hidden: arr(c.hidden, 20, 40), labels },
    updated: Date.now(),
  };
}

export async function handleSettings(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (!env.DB) return json({ error: 'Falta la base de datos D1.' }, 500);
  await ensure(env);
  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT v FROM store WHERE k = ? AND i = 0').bind(KEY).first();
    let settings = {};
    try { settings = row ? JSON.parse(row.v) : {}; } catch { /* vacío */ }
    return json({ settings });
  }
  if (request.method !== 'POST' && request.method !== 'PUT') return json({ error: 'Método no permitido' }, 405);
  const bad = guard(request, env);
  if (bad) return json({ error: bad }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'El cuerpo debe ser JSON.' }, 400); }
  const settings = cleanSettings(body.settings);
  await env.DB.prepare('INSERT OR REPLACE INTO store (k, i, v) VALUES (?, 0, ?)').bind(KEY, JSON.stringify(settings)).run();
  return json({ ok: true, settings });
}
