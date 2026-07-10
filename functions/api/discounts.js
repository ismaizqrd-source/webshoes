/**
 * functions/api/discounts.js
 * ════════════════════════════════════════════════════════════
 * GET  /api/discounts — lista códigos de descuento activos
 * POST /api/discounts — crea un código nuevo { code, percent_off }
 *
 * Ambos protegidos con el mismo ADMIN_KEY que orders.js.
 * ════════════════════════════════════════════════════════════
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS_HEADERS });
}

function checkAuth(request, env) {
  if (!env.ADMIN_KEY) return 'Falta configurar ADMIN_KEY en Cloudflare Pages.';
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return 'Clave de administrador incorrecta.';
  return null;
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
