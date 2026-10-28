/**
 * functions/api/products.js
 * ════════════════════════════════════════════════════════════
 * Lista de productos compartida entre la tienda y el panel.
 * Se guarda en Workers KV (binding DATA_KV, clave "products:v1").
 * Si está vacía, se carga de /products.seed.json (productos actuales).
 *
 *  GET    /api/products              -> { products, count }  (sin "cost")
 *  GET    /api/products?full=1       -> igual, con "cost"    (admin)
 *  POST   /api/products              -> { product } o { products: [...] }  crea
 *  PUT    /api/products/:id          -> { product }  edita (fusiona campos)
 *  DELETE /api/products/:id          -> borra uno
 *  POST   /api/products/delete       -> { ids: [...] }  borra varios
 *  POST   /api/products/bulk         -> edición masiva (ver applyBulk)
 *  POST   /api/products/reset        -> vuelve a la lista inicial de la tienda
 *
 * Seguridad: si el Worker tiene el secreto ADMIN_KEY, todo lo que escribe
 * (y ?full=1) exige la cabecera x-admin-key. Sin ADMIN_KEY queda abierto.
 * ════════════════════════════════════════════════════════════
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

const KEY = 'products:v1';
const MAX_PRODUCTS = 8000;

export const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ...extra },
  });

/** null si la petición está autorizada; si no, el texto del error. */
export function guard(request, env) {
  if (!env.ADMIN_KEY) return null; // sin clave configurada: abierto (login del panel)
  return request.headers.get('x-admin-key') === env.ADMIN_KEY ? null : 'Clave de administrador incorrecta.';
}

/* ------------------------------ normalización ------------------------------ */

const num = (v, fallback = 0) => {
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : fallback;
};
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

export function slugify(s) {
  return String(s || 'producto')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'producto';
}

function cleanSizes(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[,\s]+/);
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))].slice(0, 40);
}

function cleanImage(v) {
  const s = str(v, 1000);
  return /^(\/|https:\/\/)/.test(s) ? s : '';
}

/** Campos que aceptamos de un producto, ya limpios. Solo devuelve los presentes. */
function pickFields(input) {
  const out = {};
  if ('title' in input) out.title = str(input.title);
  if ('brand' in input) out.brand = str(input.brand, 80);
  if ('cat' in input) out.cat = str(input.cat, 80) || 'Calzado';
  if ('price' in input) out.price = Math.max(0, num(input.price));
  if ('compare_price' in input) {
    const c = input.compare_price;
    out.compare_price = c === null || c === '' || c === undefined ? null : Math.max(0, num(c));
  }
  if ('cost' in input) out.cost = Math.max(0, num(input.cost));
  if ('image' in input) out.image = cleanImage(input.image);
  if ('sizes' in input) out.sizes = cleanSizes(input.sizes);
  if ('bestseller' in input) out.bestseller = !!input.bestseller;
  if ('source' in input) out.source = /^https?:\/\//.test(String(input.source || '')) ? str(input.source, 500) : '';
  return out;
}

function uniqueId(base, taken) {
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

/* --------------------------------- storage --------------------------------- */

async function seedList(request, env) {
  if (!env.ASSETS) return [];
  const res = await env.ASSETS.fetch(new URL('/products.seed.json', request.url));
  if (!res.ok) return [];
  try {
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

// La lista se guarda en D1 troceada en filas de ~400 KB (un cambio = unas pocas filas escritas).
// Si D1 aún está vacío se lee la lista antigua de KV (migración automática) o la semilla.
const CHUNK = 400_000;
let tableReady = false;
async function ensureTable(env) {
  if (tableReady) return;
  await env.DB.exec('CREATE TABLE IF NOT EXISTS store (k TEXT NOT NULL, i INTEGER NOT NULL, v TEXT NOT NULL, PRIMARY KEY (k, i))');
  tableReady = true;
}

async function load(request, env) {
  if (env.DB) {
    await ensureTable(env);
    const { results } = await env.DB.prepare('SELECT v FROM store WHERE k = ? ORDER BY i').bind(KEY).all();
    if (results && results.length) {
      try { return JSON.parse(results.map((r) => r.v).join('')); } catch { /* corrupta: se vuelve a sembrar */ }
    }
  }
  if (env.DATA_KV) {
    const raw = await env.DATA_KV.get(KEY);
    if (raw) { try { return JSON.parse(raw); } catch { /* corrupta */ } }
  } else if (!env.DB) {
    throw new Error('Falta el binding DB (D1) o DATA_KV en el Worker.');
  }
  const seed = await seedList(request, env);
  if (seed.length) { try { await save(env, seed); } catch { /* sin escritura: se sirve la semilla */ } }
  return seed;
}

async function save(env, list) {
  const text = JSON.stringify(list);
  if (!env.DB) return env.DATA_KV.put(KEY, text);
  await ensureTable(env);
  const stmts = [env.DB.prepare('DELETE FROM store WHERE k = ?').bind(KEY)];
  for (let i = 0, n = 0; i < text.length; i += CHUNK, n++) {
    stmts.push(env.DB.prepare('INSERT INTO store (k, i, v) VALUES (?, ?, ?)').bind(KEY, n, text.slice(i, i + CHUNK)));
  }
  await env.DB.batch(stmts);   // una sola transacción
}

const publicView = (p) => {
  const { cost, ...rest } = p; // eslint-disable-line no-unused-vars
  return rest;
};

/* ----------------------------------- bulk ---------------------------------- */

/**
 * body = {
 *   ids: ["a","b"] | "all",
 *   set: { brand, cat, sizes, price, compare_price, cost, bestseller },   // opcional
 *   price_adjust: { mode: "percent"|"amount", value: -10 }                // opcional
 * }
 */
function applyBulk(list, body) {
  const ids = body.ids === 'all' ? null : new Set(Array.isArray(body.ids) ? body.ids : []);
  const set = body.set && typeof body.set === 'object' ? pickFields(body.set) : {};
  delete set.title; delete set.image; // el título y la imagen son por producto
  const adj = body.price_adjust;
  let changed = 0;

  const next = list.map((p) => {
    if (ids && !ids.has(p.id)) return p;
    const q = { ...p, ...set };
    if (adj && Number.isFinite(Number(adj.value)) && Number(adj.value) !== 0) {
      const v = Number(adj.value);
      const base = Number(q.price) || 0;
      const np = adj.mode === 'percent' ? base * (1 + v / 100) : base + v;
      q.price = Math.max(0, Math.round(np * 100) / 100);
    }
    changed++;
    return q;
  });
  return { next, changed };
}

/* --------------------------------- handler --------------------------------- */

export async function handleProducts(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  const url = new URL(request.url);
  const rest = url.pathname.replace(/^\/api\/products\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const method = request.method;

  try {
    // ---------- lectura ----------
    if (method === 'GET' && rest.length === 0) {
      const wantsFull = url.searchParams.get('full') === '1';
      if (wantsFull) {
        const err = guard(request, env);
        if (err) return json({ error: err }, 401);
      }
      const list = await load(request, env);
      return json({ products: wantsFull ? list : list.map(publicView), count: list.length });
    }

    // ---------- todo lo demás escribe ----------
    const authErr = guard(request, env);
    if (authErr) return json({ error: authErr }, 401);

    let body = {};
    if (method !== 'DELETE' && method !== 'GET') {
      try { body = await request.json(); } catch { return json({ error: 'El cuerpo debe ser JSON.' }, 400); }
    }

    // reset a la lista inicial
    if (method === 'POST' && rest[0] === 'reset') {
      const seed = await seedList(request, env);
      if (!seed.length) return json({ error: 'No se encontró /products.seed.json.' }, 500);
      await save(env, seed);
      return json({ ok: true, count: seed.length });
    }

    const list = await load(request, env);

    // crear (uno o varios)
    if (method === 'POST' && rest.length === 0) {
      const incoming = Array.isArray(body.products) ? body.products : body.product ? [body.product] : [];
      if (!incoming.length) return json({ error: 'Falta "product" o "products".' }, 400);
      if (list.length + incoming.length > MAX_PRODUCTS) return json({ error: 'Demasiados productos.' }, 400);

      const taken = new Set(list.map((p) => p.id));
      const created = [];
      for (const raw of incoming) {
        const f = pickFields(raw);
        if (!f.title) continue;
        created.push({
          id: uniqueId(slugify(raw.id || f.title), taken),
          title: f.title,
          price: f.price ?? 0,
          compare_price: f.compare_price ?? null,
          cat: f.cat || 'Calzado',
          brand: f.brand || '',
          image: f.image || '/img/_placeholder.webp',
          sizes: f.sizes || [],
          cost: f.cost ?? 0,
          ...(f.bestseller ? { bestseller: true } : {}),
          ...(f.source ? { source: f.source } : {}),
        });
      }
      if (!created.length) return json({ error: 'Ningún producto válido (falta el título).' }, 400);
      await save(env, [...list, ...created]);
      return json({ ok: true, created, count: list.length + created.length }, 201);
    }

    // borrar varios
    if (method === 'POST' && rest[0] === 'delete') {
      const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
      const next = list.filter((p) => !ids.has(p.id));
      await save(env, next);
      return json({ ok: true, deleted: list.length - next.length, count: next.length });
    }

    // edición masiva
    if (method === 'POST' && rest[0] === 'bulk') {
      const { next, changed } = applyBulk(list, body);
      await save(env, next);
      return json({ ok: true, changed, count: next.length });
    }

    // precios por marca o categoría: { rules: [{ by:'brand'|'cat', value, price?, compare_price? }] }
    if (method === 'POST' && rest[0] === 'prices') {
      const rules = (Array.isArray(body.rules) ? body.rules : []).filter((r) => r && (r.by === 'brand' || r.by === 'cat' || r.by === 'all'));
      if (!rules.length) return json({ error: 'Falta "rules".' }, 400);
      const norm = (v) => String(v ?? '').trim().toLowerCase();
      const result = rules.map(() => 0);
      const next = list.map((p) => {
        let q = p;
        rules.forEach((r, k) => {
          if (r.by !== 'all') {
            const mine = r.by === 'brand' ? norm(p.brand) : norm(p.cat || 'Calzado');
            if (mine !== norm(r.value)) return;
          }
          const hasPrice = r.price !== undefined && r.price !== null && r.price !== '';
          const hasComp = r.compare_price !== undefined && r.compare_price !== null && r.compare_price !== '';
          const price = hasPrice ? num(r.price, NaN) : NaN;
          if (hasPrice && !(price >= 0)) return;
          q = { ...q };
          if (hasPrice) q.price = price;
          if (!hasComp && q.compare_price && q.compare_price <= (q.price || 0)) q.compare_price = null;
          if (hasComp) { const c = num(r.compare_price, 0); q.compare_price = c > (q.price || 0) ? c : null; }
          result[k]++;
        });
        return q;
      });
      const changed = result.reduce((a, b) => a + b, 0);
      if (changed) await save(env, next);
      return json({ ok: true, changed, per_rule: result });
    }

    // editar varios a la vez, en una sola escritura (evita que ediciones simultáneas se pisen)
    if (method === 'POST' && rest[0] === 'patch') {
      const updates = Array.isArray(body.updates) ? body.updates : [];
      if (!updates.length) return json({ error: 'Falta "updates".' }, 400);
      const idx = new Map(list.map((p, i) => [p.id, i]));
      let changed = 0;
      for (const u of updates) {
        const i = idx.get(u && u.id);
        if (i === undefined) continue;
        const f = pickFields(u.fields || {});
        if ('title' in f && !f.title) continue;
        list[i] = { ...list[i], ...f };
        if (list[i].bestseller === false) delete list[i].bestseller;
        changed++;
      }
      if (changed) await save(env, list);
      return json({ ok: true, changed });
    }

    // editar uno
    if ((method === 'PUT' || method === 'PATCH') && rest.length === 1) {
      const i = list.findIndex((p) => p.id === rest[0]);
      if (i === -1) return json({ error: 'Producto no encontrado.' }, 404);
      const f = pickFields(body.product || body);
      if ('title' in f && !f.title) return json({ error: 'El título no puede estar vacío.' }, 400);
      list[i] = { ...list[i], ...f };
      if (list[i].bestseller === false) delete list[i].bestseller;
      await save(env, list);
      return json({ ok: true, product: list[i] });
    }

    // borrar uno
    if (method === 'DELETE' && rest.length === 1) {
      const next = list.filter((p) => p.id !== rest[0]);
      if (next.length === list.length) return json({ error: 'Producto no encontrado.' }, 404);
      await save(env, next);
      return json({ ok: true, count: next.length });
    }

    return json({ error: 'Ruta no válida.' }, 404);
  } catch (err) {
    return json({ error: 'Error en el servidor: ' + (err.message || err) }, 500);
  }
}
