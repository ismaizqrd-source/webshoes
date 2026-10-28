/**
 * functions/api/requests.js — "¿No encuentras tu producto?"
 *   POST /api/requests                 (público) crea una solicitud { title, note, size, name, contact, image (data URL) }
 *   GET  /api/requests/status?code=XX  (público) estado y precio de UNA solicitud, con su código
 *   GET  /api/requests                 (admin)   lista
 *   POST|PUT|PATCH /api/requests/:id   (admin)   { price, reply, status }
 *   DELETE /api/requests/:id           (admin)
 * Tablas D1: requests; las fotos van a la tabla images (ids "rq…").
 */
import { CORS_HEADERS, json, guard } from './products.js';

const MAX_IMG_B64 = 1_300_000;      // ~950 KB de imagen
const MAX_PENDING = 1500;
const PER_IP_HOUR = 5;

let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.exec('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, note TEXT, size TEXT, name TEXT, contact TEXT NOT NULL, image TEXT, price REAL, reply TEXT, replied INTEGER, ip TEXT)');
  await env.DB.exec('CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, type TEXT NOT NULL, data TEXT NOT NULL)');
  ready = true;
}

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join('');
const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const newCode = () => 'SOL-' + [...crypto.getRandomValues(new Uint8Array(6))].map((b) => ALPHA[b % ALPHA.length]).join('');
const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, n);

async function ipHash(request) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'local';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('rq|' + ip));
  return [...new Uint8Array(d)].slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('');
}

const validContact = (c) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c) || /^\+?[\d\s().-]{7,20}$/.test(c);

export async function handleRequests(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (!env.DB) return json({ error: 'Falta la base de datos D1.' }, 500);
  await ensure(env);
  const url = new URL(request.url);
  const rest = url.pathname.replace(/^\/api\/requests\/?/, '').split('/').filter(Boolean);
  const method = request.method;

  try {
    // ---------- público: consultar por código ----------
    if (method === 'GET' && rest[0] === 'status') {
      const code = clip(url.searchParams.get('code'), 20).toUpperCase();
      const r = code ? await env.DB.prepare('SELECT title, status, price, reply, image, created FROM requests WHERE code = ?').bind(code).first() : null;
      if (!r) return json({ error: 'No encontramos ninguna solicitud con ese código.' }, 404);
      return json({ ok: true, request: { ...r, price: r.status === 'quoted' || r.status === 'closed' ? r.price : null } });
    }

    // ---------- público: crear ----------
    if (method === 'POST' && rest.length === 0) {
      let b; try { b = await request.json(); } catch { return json({ error: 'Datos no válidos.' }, 400); }
      if (b.website) return json({ ok: true, code: 'SOL-000000' });                // trampa para bots
      const title = clip(b.title, 140), note = clip(b.note, 1000), size = clip(b.size, 40), name = clip(b.name, 80), contact = clip(b.contact, 120);
      if (title.length < 3) return json({ error: 'Escribe qué producto buscas.' }, 400);
      if (!validContact(contact)) return json({ error: 'Pon un email o un teléfono válido para poder contestarte.' }, 400);
      const ip = await ipHash(request);
      const recent = await env.DB.prepare('SELECT count(*) AS n FROM requests WHERE ip = ? AND created > ?').bind(ip, Date.now() - 3600_000).first();
      if (recent && recent.n >= PER_IP_HOUR) return json({ error: 'Has enviado varias solicitudes seguidas. Inténtalo más tarde.' }, 429);
      const open = await env.DB.prepare("SELECT count(*) AS n FROM requests WHERE status = 'new'").first();
      if (open && open.n >= MAX_PENDING) return json({ error: 'Ahora mismo no podemos recibir más solicitudes.' }, 503);

      let imageUrl = '';
      if (b.image) {
        const m = String(b.image).match(/^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return json({ error: 'La foto debe ser JPG, PNG o WebP.' }, 400);
        if (m[2].length > MAX_IMG_B64) return json({ error: 'La foto es demasiado grande.' }, 413);
        const id = hex(8);
        await env.DB.prepare('INSERT INTO images (id, type, data) VALUES (?, ?, ?)').bind(id, m[1], m[2]).run();
        imageUrl = `/api/img/${id}`;
      }
      const id = hex(8);
      let code = newCode();
      for (let k = 0; k < 4; k++) {
        try {
          await env.DB.prepare('INSERT INTO requests (id, code, created, status, title, note, size, name, contact, image, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(id, code, Date.now(), 'new', title, note, size, name, contact, imageUrl, ip).run();
          return json({ ok: true, code }, 201);
        } catch (e) { if (!/UNIQUE/i.test(String(e.message))) throw e; code = newCode(); }
      }
      return json({ error: 'No se pudo guardar. Inténtalo de nuevo.' }, 500);
    }

    // ---------- admin ----------
    const bad = guard(request, env);
    if (bad) return json({ error: bad }, 401);

    if (method === 'GET' && rest.length === 0) {
      const { results } = await env.DB.prepare('SELECT id, code, created, status, title, note, size, name, contact, image, price, reply, replied FROM requests ORDER BY created DESC LIMIT 500').all();
      return json({ ok: true, requests: results || [] });
    }
    if (['POST', 'PUT', 'PATCH'].includes(method) && rest.length === 1) {
      let b; try { b = await request.json(); } catch { return json({ error: 'Datos no válidos.' }, 400); }
      const sets = [], vals = [];
      if ('price' in b) {
        const p = b.price === '' || b.price === null ? null : parseFloat(String(b.price).replace(',', '.'));
        if (p !== null && !(p >= 0)) return json({ error: 'Precio no válido.' }, 400);
        sets.push('price = ?'); vals.push(p);
      }
      if ('reply' in b) { sets.push('reply = ?'); vals.push(clip(b.reply, 1000)); }
      if ('status' in b) {
        if (!['new', 'quoted', 'closed'].includes(b.status)) return json({ error: 'Estado no válido.' }, 400);
        sets.push('status = ?'); vals.push(b.status);
        if (b.status === 'quoted') { sets.push('replied = ?'); vals.push(Date.now()); }
      }
      if (!sets.length) return json({ error: 'Nada que cambiar.' }, 400);
      const r = await env.DB.prepare(`UPDATE requests SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, rest[0]).run();
      if (!r.meta || !r.meta.changes) return json({ error: 'Solicitud no encontrada.' }, 404);
      return json({ ok: true });
    }
    if (method === 'DELETE' && rest.length === 1) {
      const r = await env.DB.prepare('SELECT image FROM requests WHERE id = ?').bind(rest[0]).first();
      if (!r) return json({ error: 'Solicitud no encontrada.' }, 404);
      const m = (r.image || '').match(/^\/api\/img\/([0-9a-f]{16})$/);
      if (m) await env.DB.prepare('DELETE FROM images WHERE id = ?').bind(m[1]).run();
      await env.DB.prepare('DELETE FROM requests WHERE id = ?').bind(rest[0]).run();
      return json({ ok: true });
    }
    return json({ error: 'Ruta no encontrada.' }, 404);
  } catch (e) {
    return json({ error: 'Error en el servidor: ' + (e.message || e) }, 500);
  }
}
