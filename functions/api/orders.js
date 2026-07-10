/**
 * functions/api/orders.js
 * ════════════════════════════════════════════════════════════
 * GET /api/orders — devuelve los pedidos guardados en KV.
 * Protegido con una clave simple (header x-admin-key) para que no
 * cualquiera pueda ver tus pedidos solo con la URL.
 *
 * Requiere:
 * - Binding de KV ORDERS_KV (el mismo que usa webhook.js)
 * - Secret ADMIN_KEY (la contraseña que tú elijas para el panel)
 * ════════════════════════════════════════════════════════════
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env.ADMIN_KEY) {
    return json({ error: 'Falta configurar ADMIN_KEY en Cloudflare Pages.' }, 500);
  }
  const key = request.headers.get('x-admin-key');
  if (key !== env.ADMIN_KEY) {
    return json({ error: 'Clave de administrador incorrecta.' }, 401);
  }
  if (!env.ORDERS_KV) {
    return json({ error: 'Falta el binding ORDERS_KV.' }, 500);
  }

  const indexRaw = await env.ORDERS_KV.get('order_index');
  const index = indexRaw ? JSON.parse(indexRaw) : [];

  const orders = [];
  for (const id of index.slice(0, 100)) {
    const raw = await env.ORDERS_KV.get(`order:${id}`);
    if (raw) orders.push(JSON.parse(raw));
  }

  return json({ orders, count: orders.length });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
