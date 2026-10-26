/**
 * functions/api/discounts.js
 * ════════════════════════════════════════════════════════════
 * GET  /api/discounts — lista códigos de descuento activos
 * POST /api/discounts — crea un código nuevo { code, percent_off, max_redemptions? }
 * DELETE /api/discounts?id=promo_xxx — desactiva un código (no se puede borrar en Stripe)
 *
 * Ambos protegidos con el mismo ADMIN_KEY que orders.js.
 * ════════════════════════════════════════════════════════════
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS_HEADERS });
}

function checkAuth(request, env) {
  if (!env.ADMIN_KEY) return 'Falta configurar el secreto ADMIN_KEY en el Worker (Settings → Variables and Secrets).';
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return 'Clave de administrador incorrecta.';
  if (!env.STRIPE_SECRET_KEY) return 'Falta configurar el secreto STRIPE_SECRET_KEY en el Worker.';
  return null;
}

// Desactiva un código de promoción (Stripe no permite borrarlos)
export async function onRequestDelete(context) {
  const { request, env } = context;
  const authErr = checkAuth(request, env);
  if (authErr) return json({ error: authErr }, 401);

  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^promo_[A-Za-z0-9]+$/.test(id)) return json({ error: 'Id de código no válido.' }, 400);

  try {
    const res = await fetch(`https://api.stripe.com/v1/promotion_codes/${id}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'active=false',
    });
    const data = await res.json();
    if (!res.ok) return json({ error: data.error?.message || 'Error de Stripe' }, 500);
    return json({ ok: true, id: data.id, active: data.active });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// Punto de entrada para src/worker.js
export function handleDiscounts(request, env) {
  const ctx = { request, env };
  switch (request.method) {
    case 'OPTIONS': return onRequestOptions();
    case 'GET': return onRequestGet(ctx);
    case 'POST': return onRequestPost(ctx);
    case 'DELETE': return onRequestDelete(ctx);
    default: return Promise.resolve(json({ error: 'Método no permitido.' }, 405));
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const authErr = checkAuth(request, env);
  if (authErr) return json({ error: authErr }, 401);

  try {
    const res = await fetch('https://api.stripe.com/v1/promotion_codes?limit=50&active=true', {
      headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const data = await res.json();
    if (!res.ok) return json({ error: data.error?.message || 'Error de Stripe' }, 500);

    const codes = (data.data || []).map(pc => ({
      id: pc.id,
      code: pc.code,
      percent_off: pc.coupon?.percent_off || null,
      amount_off: pc.coupon?.amount_off ? pc.coupon.amount_off / 100 : null,
      times_redeemed: pc.times_redeemed,
      max_redemptions: pc.max_redemptions,
      active: pc.active,
    }));
    return json({ codes });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const authErr = checkAuth(request, env);
  if (authErr) return json({ error: authErr }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Cuerpo inválido' }, 400); }

  const code = (body.code || '').trim().toUpperCase();
  const percentOff = parseFloat(body.percent_off);
  if (!code) return json({ error: 'Falta el código' }, 400);
  if (isNaN(percentOff) || percentOff <= 0 || percentOff > 100) return json({ error: 'Porcentaje inválido' }, 400);

  try {
    // 1. Crear el cupón (el % de descuento)
    const couponParams = new URLSearchParams();
    couponParams.set('percent_off', String(percentOff));
    couponParams.set('duration', 'forever');
    const couponRes = await fetch('https://api.stripe.com/v1/coupons', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: couponParams.toString(),
    });
    const coupon = await couponRes.json();
    if (!couponRes.ok) return json({ error: coupon.error?.message || 'Error creando el cupón' }, 500);

    // 2. Crear el código de promoción (lo que el cliente escribe en el checkout)
    const promoParams = new URLSearchParams();
    promoParams.set('coupon', coupon.id);
    promoParams.set('code', code);
    if (body.max_redemptions) promoParams.set('max_redemptions', String(body.max_redemptions));

    const promoRes = await fetch('https://api.stripe.com/v1/promotion_codes', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: promoParams.toString(),
    });
    const promo = await promoRes.json();
    if (!promoRes.ok) return json({ error: promo.error?.message || 'Error creando el código' }, 500);

    return json({ code: promo.code, percent_off: percentOff });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
