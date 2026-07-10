/**
 * functions/api/create-checkout.js
 * ════════════════════════════════════════════════════════════
 * Versión Cloudflare Pages Functions del checkout de Stripe.
 * Cloudflare mapea automáticamente este archivo a la ruta:
 *   POST /api/create-checkout
 *
 * Requiere un secret STRIPE_SECRET_KEY configurado en el proyecto
 * de Pages (Settings → Environment variables).
 * ════════════════════════════════════════════════════════════
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export async function onRequestOptions() {
  return new Response(null, { status: 200, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let items, shipping;
  try {
    ({ items, shipping } = await request.json());
  } catch {
    return json({ error: 'Cuerpo de la petición inválido' }, 400);
  }

  if (!items || !items.length) {
    return json({ error: 'Carrito vacío' }, 400);
  }
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'Falta configurar STRIPE_SECRET_KEY en Cloudflare Pages (Settings → Environment variables).' }, 500);
  }

  const origin = request.headers.get('origin') || 'https://www.resellyourorder.com';

  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('locale', 'es');
  params.append('payment_method_types[]', 'card');
  params.set('success_url', `${origin}/gracias.html?session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${origin}/#carrito`);
  params.set('billing_address_collection', 'required');
  params.append('shipping_address_collection[allowed_countries][]', 'ES');
  params.set('custom_text[submit][message]', 'Recibirás confirmación por email. Envío 24-48h.');
  params.set('metadata[source]', 'resell-your-order');
  params.set('metadata[items_count]', String(items.length));

  items.forEach((item, i) => {
    params.set(`line_items[${i}][price_data][currency]`, 'eur');
    params.set(`line_items[${i}][price_data][product_data][name]`, item.title || 'Producto');
    const desc = [item.brand, item.size ? `Talla: ${item.size}` : null].filter(Boolean).join(' · ');
    if (desc) params.set(`line_items[${i}][price_data][product_data][description]`, desc);
    if (item.image) params.append(`line_items[${i}][price_data][product_data][images][]`, item.image);
    params.set(`line_items[${i}][price_data][unit_amount]`, String(Math.round(item.price * 100)));
    params.set(`line_items[${i}][quantity]`, String(item.qty || 1));
  });

  if (shipping > 0) {
    const i = items.length;
    params.set(`line_items[${i}][price_data][currency]`, 'eur');
    params.set(`line_items[${i}][price_data][product_data][name]`, 'Envío estándar 24-48h');
    params.set(`line_items[${i}][price_data][unit_amount]`, String(Math.round(shipping * 100)));
    params.set(`line_items[${i}][quantity]`, '1');
  }

  try {
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await stripeRes.json();
    if (!stripeRes.ok) {
      return json({ error: data.error?.message || 'Error de Stripe' }, 500);
    }
    return json({ url: data.url });
  } catch (err) {
    return json({ error: err.message || 'Error interno' }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
