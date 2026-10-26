/**
 * functions/api/images.js
 * ════════════════════════════════════════════════════════════
 *  POST /api/img               -> guarda una imagen (cuerpo binario) en KV
 *                                 devuelve { url: "/api/img/<id>.webp" }
 *  GET  /api/img/<id>[.ext]    -> sirve una imagen guardada
 *  DELETE /api/img/<id>        -> borra una imagen guardada
 *  GET  /api/img-proxy?url=…   -> descarga una imagen remota y la devuelve
 *                                 con CORS, para poder procesarla en el panel
 *
 * Las imágenes se guardan ya normalizadas por el panel (fondo blanco,
 * 900×900, punta a la derecha). Guardar y el proxy exigen x-admin-key
 * solo si el Worker tiene el secreto ADMIN_KEY.
 * ════════════════════════════════════════════════════════════
 */

import { CORS_HEADERS, json, guard } from './products.js';
import { isBlockedHost } from './scrape.js';

const MAX_UPLOAD = 1_500_000;   // 1,5 MB por imagen guardada
const MAX_PROXY = 8_000_000;    // 8 MB por imagen descargada
const ALLOWED_TYPES = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' };

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function handleImages(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (!env.DATA_KV) return json({ error: 'Falta el binding DATA_KV (KV) en el Worker.' }, 500);

  const url = new URL(request.url);
  const rest = url.pathname.replace(/^\/api\/img\/?/, '');

  try {
    // ---------- servir ----------
    if (request.method === 'GET' && rest) {
      const id = rest.replace(/\.[a-z0-9]+$/i, '');
      if (!/^[a-f0-9]{16}$/.test(id)) return new Response('No encontrada', { status: 404 });
      const { value, metadata } = await env.DATA_KV.getWithMetadata(`img:${id}`, 'arrayBuffer');
      if (!value) return new Response('No encontrada', { status: 404 });
      return new Response(value, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': metadata?.type || 'image/webp',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }

    const authErr = guard(request, env);
    if (authErr) return json({ error: authErr }, 401);

    // ---------- guardar ----------
    if (request.method === 'POST' && !rest) {
      const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const ext = ALLOWED_TYPES[type];
      if (!ext) return json({ error: 'Formato no permitido (usa webp, png o jpeg).' }, 415);
      const buf = await request.arrayBuffer();
      if (!buf.byteLength) return json({ error: 'Imagen vacía.' }, 400);
      if (buf.byteLength > MAX_UPLOAD) return json({ error: 'Imagen demasiado grande (máx. 1,5 MB).' }, 413);
      const id = newId();
      await env.DATA_KV.put(`img:${id}`, buf, { metadata: { type } });
      return json({ ok: true, id, url: `/api/img/${id}.${ext}` }, 201);
    }

    // ---------- borrar ----------
    if (request.method === 'DELETE' && rest) {
      const id = rest.replace(/\.[a-z0-9]+$/i, '');
      if (!/^[a-f0-9]{16}$/.test(id)) return json({ error: 'Id no válido.' }, 400);
      await env.DATA_KV.delete(`img:${id}`);
      return json({ ok: true });
    }

    return json({ error: 'Ruta no válida.' }, 404);
  } catch (err) {
    return json({ error: 'Error en el servidor: ' + (err.message || err) }, 500);
  }
}

export async function handleImageProxy(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405);

  const authErr = guard(request, env);
  if (authErr) return json({ error: authErr }, 401);

  let target;
  try { target = new URL(new URL(request.url).searchParams.get('url') || ''); }
  catch { return json({ error: 'URL no válida.' }, 400); }
  if (target.protocol !== 'https:' || isBlockedHost(target.hostname)) {
    return json({ error: 'URL no permitida (solo https público).' }, 400);
  }

  try {
    const res = await fetch(target.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0 Safari/537.36', Accept: 'image/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return json({ error: `El origen respondió HTTP ${res.status}.` }, 502);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) return json({ error: 'La URL no es una imagen.' }, 415);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_PROXY) return json({ error: 'Imagen demasiado grande.' }, 413);
    return new Response(buf, {
      headers: { ...CORS_HEADERS, 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' },
    });
  } catch (err) {
    return json({ error: 'No se pudo descargar la imagen: ' + (err.message || err) }, 502);
  }
}
