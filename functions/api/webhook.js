/**
 * functions/api/webhook.js
 * ════════════════════════════════════════════════════════════
 * Recibe eventos de Stripe (POST /api/webhook). Cuando un pago se
 * completa (checkout.session.completed), guarda el pedido en KV
 * para que el panel de administración pueda mostrarlo.
 *
 * Requiere:
 * - Binding de KV llamado ORDERS_KV (Settings → Functions → KV namespace bindings)
 * - Secret STRIPE_WEBHOOK_SECRET (del endpoint de webhook que crees en Stripe)
 * ════════════════════════════════════════════════════════════
 */

async function verifyStripeSignature(payload, sigHeader, secret) {
  // Stripe firma como: t=timestamp,v1=firma
  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => p.split('=').map(s => s.trim()))
  );
  const signedPayload = `${parts.t}.${payload}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const expected = [...new Uint8Array(sigBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');

  return expected === parts.v1;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ORDERS_KV) {
    return new Response('Falta el binding ORDERS_KV', { status: 500 });
  }
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return new Response('Falta STRIPE_WEBHOOK_SECRET', { status: 500 });
  }

  const payload = await request.text();
  const sig = request.headers.get('stripe-signature') || '';

  let valid = false;
  try {
    valid = await verifyStripeSignature(payload, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    valid = false;
  }
  if (!valid) {
    return new Response('Firma inválida', { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response('JSON inválido', { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Pedimos los line items a Stripe para saber qué se compró
    let items = [];
    try {
      const liRes = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${session.id}/line_items?limit=50`,
        { headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` } }
      );
      const liData = await liRes.json();
      items = (liData.data || []).map(li => ({
        title: li.description,
        qty: li.quantity,
        amount: li.amount_total / 100,
      }));
    } catch {
      // si falla, guardamos el pedido igualmente sin el detalle de items
    }

    const order = {
      id: session.id,
      amount: (session.amount_total || 0) / 100,
      currency: session.currency,
      customer_email: session.customer_details?.email || null,
      customer_name: session.customer_details?.name || null,
      shipping_address: session.shipping_details?.address || null,
      items,
      status: 'paid',
      created: new Date().toISOString(),
    };

    await env.ORDERS_KV.put(`order:${session.id}`, JSON.stringify(order));
    // índice simple para poder listar ordenado por fecha
    const indexRaw = await env.ORDERS_KV.get('order_index');
    const index = indexRaw ? JSON.parse(indexRaw) : [];
    index.unshift(session.id);
    await env.ORDERS_KV.put('order_index', JSON.stringify(index.slice(0, 500)));
  }

  return new Response('ok', { status: 200 });
}
