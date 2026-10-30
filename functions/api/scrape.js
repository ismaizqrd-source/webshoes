// functions/api/scrape.js
// POST /api/scrape   Body: { "url": "...", "max_pages": 10 (opcional) }
// Universal Scraper: WooCommerce, Shopify, Yupoo, JSON-LD, y HTML Genérico.

const DEFAULT_MAX_PAGES = 10;
const HARD_MAX_PAGES = 20;
const DEFAULT_CATEGORY = 'Calzado';

import { detectBrandFromText } from './brands.js';

const KNOWN_BRANDS = [
  'The North Face', 'New Balance', 'Off-White', 'Louis Vuitton', 'Ralph Lauren',
  'Tommy Hilfiger', 'Calvin Klein', 'Hugo Boss', 'Under Armour', 'Stone Island',
  'Nike', 'Adidas', 'Jordan', 'Puma', 'Asics', 'Converse', 'Vans', 'Reebok',
  'Yeezy', 'Salomon', 'Stussy', 'Carhartt', 'Supreme', 'Balenciaga', 'Gucci',
  'Dior', 'Lacoste', 'Armani', 'Fila', 'Hoka', 'Crocs', 'Birkenstock', 'Timberland',
  'Dr. Martens', 'Champion', 'Levi\'s', 'Zara', 'Bape', 'Palace', 'Trapstar', 'Corteiz',
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' };
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

const RE_FOOTBALL = /f[uú]tbol|football|soccer|\b(real madrid|barcelona|bar[cç]a|atl[eé]tico de madrid|manchester (united|city)|liverpool|chelsea|arsenal|juventus|milan|inter de milan|psg|bayern|dortmund|selecci[oó]n)\b.*\b(camiseta|jersey|shirt|kit|home|away|local|visitante|tercera)\b|\b\d{2}[\/-]\d{2}\b.*\b(home|away|local|visitante|tercera|third)\b/i;
export const looksFootball = (text) => RE_FOOTBALL.test(String(text || ''));

const withPanelFields = (p, sourceUrl, hint = '') => ({
  ...p,
  football: looksFootball(`${p.title || ''} ${hint || ''}`),
  sizes: p.sizes && p.sizes.length ? p.sizes : [],
  category_guess: p.category_guess || guessCategory(p.title, hint),
  source_url: sourceUrl,
});

/* ------------------- Categorización inteligente ---------------- ------------- */

const RE_TECH = /\b(airpods?|iphone|ipad|macbook|airtag|apple watch|smartwatch|auriculares|cascos|altavoz|speaker|jbl|bose|samsung|galaxy|playstation|ps[345]|xbox|nintendo|consola|cargador|power ?bank|tablet|port[aá]til|laptop|c[aá]mara|gopro|dji|dyson|secador|teclado|monitor|televisor|airfryer|drone|tecnolog[ií]a|electr[oó]nica)\b/i;
const RE_CLOTHES = /\b(camiseta|camisa|polo|sudadera|hoodie|jersey|su[eé]ter|sweater|cardigan|chaqueta|cazadora|jacket|puffer|abrigo|parka|chaleco|gilet|pantal[oó]n|pants|vaquero|jeans|shorts?|bermuda|ch[aá]ndal|tracksuit|falda|vestido|ba[nñ]ador|fleece|t-?shirt|tee|ropa)\b/i;
const RE_ACCESS = /\b(bolso|bolsa|cartera|monedero|cintur[oó]n|gafas|sunglasses|gorra|gorro|cap|beanie|reloj|watch|mochila|backpack|bufanda|calcetines|socks|llavero|ri[nñ]onera|cadena|collar|pulsera|anillo|perfume|colonia|neceser|maleta|paraguas|guantes|accesorios?)\b/i;

function guessCategory(title, hint = '') {
  const pick = (t) => (RE_TECH.test(t) ? 'Electrónica' : RE_CLOTHES.test(t) ? 'Ropa' : RE_ACCESS.test(t) ? 'Accesorios' : '');
  const t = String(title || '');
  return pick(t) || pick(decodeURIComponentSafe(hint).replace(/[-_/]+/g, ' ')) || DEFAULT_CATEGORY;
}
const decodeURIComponentSafe = (x) => { try { return decodeURIComponent(String(x || '')); } catch { return String(x || ''); } };

/* ----------------------------- Utilidades ----------------------------- */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  euro: '€', pound: '£', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  ndash: '–', mdash: '—', hellip: '…', reg: '®', trade: '™', copy: '©',
};

function decode(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m)
    .trim();
}

const stripTags = (h) => decode(String(h ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? decode(m[1] ?? m[2]) : '';
}

function absUrl(u, base) {
  if (!u) return '';
  try { return new URL(u, base).href; } catch { return ''; }
}

function parseNumber(text) {
  const m = String(text ?? '').match(/\d[\d.,]*/);
  if (!m) return null;
  let n = m[0].replace(/[.,]+$/, '');
  const hasDot = n.includes('.');
  const hasComma = n.includes(',');
  if (hasDot && hasComma) {
    n = n.lastIndexOf(',') > n.lastIndexOf('.')
      ? n.replace(/\./g, '').replace(',', '.')
      : n.replace(/,/g, '');
  } else if (hasComma) {
    n = /,\d{3}$/.test(n) && n.split(',').length > 2 ? n.replace(/,/g, '') : n.replace(',', '.');
  } else if (hasDot && /\.\d{3}$/.test(n)) {
    n = n.replace(/\./g, '');
  }
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : null;
}

function currencyOf(text) {
  if (/€|eur/i.test(text)) return 'EUR';
  if (/\$|usd/i.test(text)) return 'USD';
  if (/£|gbp/i.test(text)) return 'GBP';
  return 'EUR';
}

function parsePrice(fragment) {
  const start = fragment.search(/class=["'][^"']*\bprice\b/i);
  if (start === -1) return { price: null, regular_price: null, sale_price: null, price_text: '', currency: 'EUR' };

  const tagStart = fragment.lastIndexOf('<', start);
  let seg = fragment.slice(tagStart === -1 ? start : tagStart, start + 1500);
  const ins = seg.match(/<ins[\s\S]*?<\/ins>/i);
  const del = seg.match(/<del[\s\S]*?<\/del>/i);

  if (ins) {
    const sale = parseNumber(stripTags(ins[0]));
    const regular = del ? parseNumber(stripTags(del[0])) : null;
    return { price: sale, regular_price: regular, sale_price: sale, price_text: stripTags(ins[0]), currency: currencyOf(stripTags(seg)) };
  }

  const text = stripTags(seg.split(/<\/p>|<\/li>/i)[0]);
  const value = parseNumber(text);
  return { price: value, regular_price: value, sale_price: null, price_text: text, currency: currencyOf(text) };
}

function matchKnownBrand(text) {
  return detectBrandFromText(text);
}

function detectBrand(classes, title, fallbackText = '') {
  const fromTitle = matchKnownBrand(title);
  if (fromTitle) return fromTitle;
  return matchKnownBrand(fallbackText) || '';
}

function fullSize(u) {
  return u.replace(/-\d{2,4}x\d{2,4}(?=\.(?:jpe?g|png|webp|gif)(?:\?|$))/i, '');
}

function extractImage(block, base) {
  const imgs = block.match(/<img\b[^>]*>/gi) || [];
  for (const tag of imgs) {
    const candidates = [
      attr(tag, 'data-lazy-src'),
      attr(tag, 'data-src'),
      attr(tag, 'data-orig-src'),
      attr(tag, 'src'),
    ];
    const found = candidates.find((c) => c && !c.startsWith('data:'));
    if (found) return fullSize(absUrl(found, base));
  }
  return '';
}

/* ------------------------------- SHOPIFY API -------------------------- */
async function tryShopifyApi(target, maxPages) {
  let baseUrl = target.origin + target.pathname;
  if (!baseUrl.endsWith('.json')) {
    baseUrl = baseUrl.replace(/\/$/, '') + '.json';
  }

  const products = [];
  let page = 1;

  while (page <= maxPages) {
    try {
      const res = await fetch(`${baseUrl}?page=${page}&limit=250`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) break;
      const data = await res.json();
      const items = data.products || [];
      if (!items.length) break;

      for (const item of items) {
        const variant = item.variants?.[0] || {};
        const price = parseNumber(variant.price);
        const regular = parseNumber(variant.compare_at_price || variant.price);
        products.push(withPanelFields({
          id: String(item.id),
          sku: variant.sku || '',
          title: decode(item.title),
          price,
          regular_price: regular,
          sale_price: regular && price && sale < regular ? price : null,
          price_text: variant.price ? String(variant.price) : '',
          currency: 'USD',
          image: item.images?.[0]?.src ? fullSize(item.images[0].src) : '',
          url: `${target.origin}/products/${item.handle}`,
          brand: item.vendor || matchKnownBrand(item.title),
          in_stock: variant.available !== false,
          sizes: [...new Set((item.variants || []).map(v => v.title).filter(Boolean))],
        }, target.href, item.product_type));
      }

      if (items.length < 250) break;
      page++;
      await sleep(300);
    } catch {
      break;
    }
  }

  if (!products.length) return null;
  return {
    is_category: true,
    via: 'shopify-api',
    source_url: target.href,
    count: products.length,
    pages: page,
    has_more_pages: false,
    products,
  };
}

/* --------------------------- WooCommerce Store API -------------------- */
const STORE_PER_PAGE = 100;
const WC_MARKERS = ['categoria-producto', 'product-category', 'tienda', 'shop', 'producto', 'product', 'categoria'];

async function fetchJsonRetry(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return { data, total: parseInt(res.headers.get('x-wp-total'), 10) || 0, totalPages: parseInt(res.headers.get('x-wp-totalpages'), 10) || 0 };
}

function storeApiCandidates(target) {
  const segs = target.pathname.split('/').filter(Boolean);
  const idx = segs.findIndex((x) => WC_MARKERS.includes(x.toLowerCase()));
  const prefixes = [];
  if (idx > 0) prefixes.push('/' + segs.slice(0, idx).join('/'));
  prefixes.push('');
  return [...new Set(prefixes)].map((pre) => target.origin + pre.replace(/\/$/, '') + '/wp-json/wc/store/v1');
}

async function tryStoreApi(target) {
  let base = '';
  for (const cand of storeApiCandidates(target)) {
    try {
      const r = await fetchJsonRetry(`${cand}/products?per_page=1`);
      if (Array.isArray(r.data)) { base = cand; break; }
    } catch { /* siguiente */ }
  }
  if (!base) return null;
  
  // Petición inicial rápida
  try {
    const r = await fetchJsonRetry(`${base}/products?per_page=50`);
    if (!Array.isArray(r.data)) return null;
    const products = r.data.map(p => {
      const pr = p.prices || {};
      const price = pr.price ? Number(pr.price) / 100 : null;
      return withPanelFields({
        id: String(p.id),
        sku: p.sku || '',
        title: decode(p.name),
        price,
        regular_price: price,
        image: p.images?.[0]?.src ? fullSize(p.images[0].src) : '',
        url: p.permalink || '',
        brand: matchKnownBrand(p.name),
        in_stock: p.is_in_stock !== false,
      }, p.permalink || target.href);
    });
    return { is_category: true, via: 'store-api', source_url: target.href, count: products.length, products };
  } catch {
    return null;
  }
}

/* ------------------------ Extracción por JSON-LD Universal ------------ */
function ldProducts(html, base) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const t = [].concat(n['@type'] || []).join(' ');
    if (/Product/i.test(t) && n.name) {
      const offer = [].concat(n.offers || [])[0] || {};
      const price = parseNumber(offer.price ?? offer.lowPrice ?? (offer.priceSpecification || {}).price);
      const img = [].concat(n.image || [])[0];
      out.push({
        title: decode(String(n.name)), 
        image: img ? absUrl(typeof img === 'string' ? img : img.url || '', base) : '',
        url: n.url ? absUrl(n.url, base) : (offer.url ? absUrl(offer.url, base) : ''),
        price: price > 0 ? price : null,
        brand: typeof n.brand === 'string' ? n.brand : (n.brand && n.brand.name) || '',
      });
    }
    for (const k of ['itemListElement', 'item', '@graph', 'mainEntity']) if (n[k]) walk(n[k]);
  };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* ignorar */ }
  }
  return out;
}

/* ------------------------------- Yupoo --------------------------------- */
const isYupooHost = (h) => /(^|\.)yupoo\.com$/i.test(h);
const yupooAbs = (u, base) => absUrl(String(u || '').startsWith('//') ? 'https:' + u : u, base);

async function yupooScrape(target) {
  const res = await fetchHtmlOnce(target.href, { Referer: `${target.origin}/` });
  const albums = [];
  const re = /<a\b[^>]*href=["']([^"']*\/albums\/(\d+)[^"']*)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(res.html))) {
    albums.push({ id: m[2], url: yupooAbs(m[1], res.finalUrl), title: 'Álbum Yupoo ' + m[2] });
  }
  return { is_category: true, via: 'yupoo', source_url: target.href, count: albums.length, products: albums };
}

/* ------------------------------- Fetching ----------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtmlOnce(url, extra = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      ...extra,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { html: await res.text(), finalUrl: res.url || url };
}

export function isBlockedHost(hostname) {
  return hostname === 'localhost' || /^0\./.test(hostname) || hostname.endsWith('.local');
}

/* -------------------------------- Handler Principal ------------------- */
export async function handleScrape(request) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Cuerpo JSON inválido' }, 400); }
  if (!body || !body.url) return json({ error: 'URL no proporcionada' }, 400);

  let target;
  try { target = new URL(String(body.url).trim()); } catch { return json({ error: 'URL no válida' }, 400); }

  const maxPages = Math.min(Math.max(parseInt(body.max_pages, 10) || DEFAULT_MAX_PAGES, 1), HARD_MAX_PAGES);

  // 1. Soporte Yupoo
  if (isYupooHost(target.hostname)) {
    try { return json(await yupooScrape(target)); } catch (e) { return json({ error: e.message }, 502); }
  }

  // 2. Soporte Shopify API (.json automático)
  try {
    const shopifyResult = await tryShopifyApi(target, maxPages);
    if (shopifyResult) return json(shopifyResult);
  } catch { /* Continuar con WooCommerce o HTML */ }

  // 3. Soporte WooCommerce Store API
  try {
    const wcResult = await tryStoreApi(target);
    if (wcResult) return json(wcResult);
  } catch { /* Continuar con HTML genérico */ }

  // 4. Extracción universal mediante HTML y JSON-LD (para cualquier otra web: Magento, PrestaShop, Wix, etc.)
  try {
    const { html, finalUrl } = await fetchHtmlOnce(target.href);
    
    // Buscar mediante JSON-LD estructurado de la página (muy común en Shopify, Wix, etc.)
    const ldItems = ldProducts(html, finalUrl);
    if (ldItems.length > 0) {
      const products = ldItems.map(p => withPanelFields({
        id: '', sku: '', title: p.title, price: p.price, regular_price: p.price,
        image: p.image, url: p.url, brand: p.brand || matchKnownBrand(p.title), in_stock: true
      }, finalUrl));
      return json({ is_category: true, via: 'json-ld', source_url: finalUrl, count: products.length, products });
    }

    return json({ error: 'No se pudieron extraer productos automáticamente de esta plataforma. Usa el método de "Pegar código de la página".' }, 422);
  } catch (err) {
    return json({ error: 'Error al conectar con la web: ' + err.message }, 502);
  }
}

export async function onRequestPost({ request }) { return handleScrape(request); }
export async function onRequestOptions() { return new Response(null, { headers: CORS_HEADERS }); }
