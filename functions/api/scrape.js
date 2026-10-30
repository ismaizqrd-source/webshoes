// functions/api/scrape.js
// POST /api/scrape   Body: { "url": "...", "max_pages": 10 (opcional) }
// - Categoría  -> { is_category: true, source_url, count, pages, products: [...] }
// - Producto   -> { is_category: false, ...campos del producto, products: [producto] }
//
// La lógica vive en handleScrape(). La usan:
//   - src/worker.js (despliegue con wrangler.toml: main = src/worker.js)
//   - onRequestPost / onRequestOptions al final (Cloudflare Pages Functions)

const DEFAULT_MAX_PAGES = 10; // páginas de categoría que se siguen por defecto
const HARD_MAX_PAGES = 20;    // tope absoluto aunque se pida más (límite de subrequests)
const DEFAULT_SIZES = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'];
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

// Campos que espera admin.html además de los del scraper
// Camisetas de fútbol (selecciones, clubes, temporadas): se marcan para dejarlas fuera por defecto
const RE_FOOTBALL = /f[uú]tbol|football|soccer|\b(real madrid|barcelona|bar[cç]a|atl[eé]tico de madrid|manchester (united|city)|liverpool|chelsea|arsenal|juventus|milan|inter de milan|psg|bayern|dortmund|selecci[oó]n)\b.*\b(camiseta|jersey|shirt|kit|home|away|local|visitante|tercera)\b|\b\d{2}[\/-]\d{2}\b.*\b(home|away|local|visitante|tercera|third)\b/i;
export const looksFootball = (text) => RE_FOOTBALL.test(String(text || ''));

const withPanelFields = (p, sourceUrl, hint = '') => ({
  ...p,
  football: looksFootball(`${p.title || ''} ${hint || ''}`),
  sizes: p.sizes && p.sizes.length ? p.sizes : [],   // el panel pone tallas por defecto según la categoría
  category_guess: p.category_guess || guessCategory(p.title, hint),
  source_url: sourceUrl,
});

/* ------------------- categoría del panel (Calzado, Ropa…) ------------- */

const RE_TECH = /\b(airpods?|iphone|ipad|macbook|airtag|apple watch|smartwatch|auriculares|cascos|altavoz|speaker|jbl|bose|samsung|galaxy|playstation|ps[345]|xbox|nintendo|consola|cargador|power ?bank|tablet|port[aá]til|laptop|c[aá]mara|gopro|dji|dyson|secador|teclado|monitor|televisor|airfryer|drone|tecnolog[ií]a|electr[oó]nica)\b/i;
const RE_CLOTHES = /\b(camiseta|camisa|polo|sudadera|hoodie|jersey|su[eé]ter|sweater|cardigan|chaqueta|cazadora|jacket|puffer|abrigo|parka|chaleco|gilet|pantal[oó]n|pants|vaquero|jeans|shorts?|bermuda|ch[aá]ndal|tracksuit|falda|vestido|ba[nñ]ador|fleece|t-?shirt|tee|ropa)\b/i;
const RE_ACCESS = /\b(bolso|bolsa|cartera|monedero|cintur[oó]n|gafas|sunglasses|gorra|gorro|cap|beanie|reloj|watch|mochila|backpack|bufanda|calcetines|socks|llavero|ri[nñ]onera|cadena|collar|pulsera|anillo|perfume|colonia|neceser|maleta|paraguas|guantes|accesorios?)\b/i;

// Adivina la categoría del panel por el nombre (y, si no basta, por la ruta de la categoría)
function guessCategory(title, hint = '') {
  const pick = (t) => (RE_TECH.test(t) ? 'Electrónica' : RE_CLOTHES.test(t) ? 'Ropa' : RE_ACCESS.test(t) ? 'Accesorios' : '');
  const t = String(title || '');
  return pick(t) || pick(decodeURIComponentSafe(hint).replace(/[-_/]+/g, ' ')) || DEFAULT_CATEGORY;
}
const decodeURIComponentSafe = (x) => { try { return decodeURIComponent(String(x || '')); } catch { return String(x || ''); } };

/* ----------------------------- utilidades ----------------------------- */

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

// "1.234,56 €" -> 1234.56 | "49,99" -> 49.99 | "49.99" -> 49.99
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

/* ------------------------------- precios ------------------------------ */

// Recibe un fragmento HTML que contiene el bloque class="price"
function parsePrice(fragment) {
  const start = fragment.search(/class=["'][^"']*\bprice\b/i);
  if (start === -1) return { price: null, regular_price: null, sale_price: null, price_text: '', currency: 'EUR' };

  const tagStart = fragment.lastIndexOf('<', start);
  let seg = fragment.slice(tagStart === -1 ? start : tagStart, start + 1500);
  seg = seg.split(/<a\s[^>]*class=["'][^"']*button/i)[0];

  const ins = seg.match(/<ins[\s\S]*?<\/ins>/i);
  const del = seg.match(/<del[\s\S]*?<\/del>/i);

  if (ins) {
    const sale = parseNumber(stripTags(ins[0]));
    const regular = del ? parseNumber(stripTags(del[0])) : null;
    return {
      price: sale,
      regular_price: regular,
      sale_price: sale,
      price_text: stripTags(ins[0]),
      currency: currencyOf(stripTags(seg)),
    };
  }

  const text = stripTags(seg.split(/<\/p>|<\/li>/i)[0]);
  const value = parseNumber(text);
  return {
    price: value,
    regular_price: value,
    sale_price: null,
    price_text: text,
    currency: currencyOf(text),
  };
}

/* -------------------------------- marca ------------------------------- */

const brandRegex = (b) =>
  new RegExp(`(^|[^a-z0-9])${b.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i');

function matchKnownBrand(text) {
  return detectBrandFromText(text);
}

function detectBrand(classes, title, fallbackText = '') {
  // 1) taxonomías de marca de plugins habituales
  const bm = classes.match(/(?:product_brand|pwb-brand|yith_product_brand|berocket_brand|pa_marca|pa_brand)-([a-z0-9-]+)/i);
  if (bm) {
    return matchKnownBrand(bm[1]) || bm[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  // 2) marca conocida en el título
  const fromTitle = matchKnownBrand(title);
  if (fromTitle) return fromTitle;
  // 3) marca conocida en las categorías del producto (product_cat-xxx)
  const cats = [...classes.matchAll(/product_cat-([a-z0-9-]+)/gi)].map((m) => m[1]).join(' ');
  return matchKnownBrand(cats) || matchKnownBrand(fallbackText) || '';
}

/* ------------------------------- imágenes ----------------------------- */

function bestFromSrcset(srcset) {
  let best = '', bestW = -1;
  for (const part of srcset.split(',')) {
    const [u, w] = part.trim().split(/\s+/);
    const width = parseInt(w, 10) || 0;
    if (u && width >= bestW) { best = u; bestW = width; }
  }
  return best;
}

// Quita el sufijo de miniatura de WordPress: foto-300x300.jpg -> foto.jpg
const fullSize = (u) => String(u)
  .replace(/-\d{2,4}x\d{2,4}(?=\.(?:jpe?g|png|webp|gif)(?:\?|$))/i, '')   // WooCommerce / WordPress
  .replace(/_(?:\d{2,4}x\d{0,4}|pico|icon|thumb|small|compact|medium|large|grande)(?=\.(?:jpe?g|png|webp|gif)(?:\?|$))/i, '');   // Shopify

function extractImage(block, base) {
  const imgs = block.match(/<img\b[^>]*>/gi) || [];
  for (const tag of imgs) {
    const candidates = [
      attr(tag, 'data-lazy-src'),
      attr(tag, 'data-src'),
      attr(tag, 'data-orig-src'),
      bestFromSrcset(attr(tag, 'data-lazy-srcset') || attr(tag, 'data-srcset') || attr(tag, 'srcset')),
      attr(tag, 'src'),
    ];
    const found = candidates.find((c) => c && !c.startsWith('data:'));
    if (found) return fullSize(absUrl(found, base));
  }
  return '';
}

/* ------------------------- extracción de categoría -------------------- */

function extractLoopItems(html) {
  const startRe = /<li\b[^>]*\bclass=["']([^"']*)["'][^>]*>/gi;
  const starts = [];
  let m;
  while ((m = startRe.exec(html))) {
    const tokens = m[1].split(/\s+/);
    const isProduct = tokens.includes('product') || tokens.includes('type-product');
    if (isProduct && !tokens.includes('product-category')) {
      starts.push({ index: m.index, classes: m[1] });
    }
  }
  return starts.map((s, i) => {
    let end = i + 1 < starts.length ? starts[i + 1].index : html.indexOf('</ul>', s.index);
    if (end === -1) end = Math.min(html.length, s.index + 6000);
    return { classes: s.classes, block: html.slice(s.index, end) };
  });
}

function parseLoopItem({ classes, block }, base, categoryHint) {
  const titleM =
    block.match(/<h[1-6][^>]*woocommerce-loop-product__title[^>]*>([\s\S]*?)<\/h[1-6]>/i) ||
    block.match(/<h[2-4][^>]*class=["'][^"']*product-title[^"']*["'][^>]*>([\s\S]*?)<\/h[2-4]>/i);
  let title = titleM ? stripTags(titleM[1]) : '';

  const linkTag =
    (block.match(/<a\b[^>]*woocommerce-LoopProduct-link[^>]*>/i) ||
      block.match(/<a\b[^>]*woocommerce-loop-product__link[^>]*>/i) ||
      block.match(/<a\b[^>]*href=[^>]*>/i) || [''])[0];

  if (!title) title = attr(linkTag, 'aria-label') || attr(linkTag, 'title');
  if (!title) {
    const img = (block.match(/<img\b[^>]*>/i) || [''])[0];
    title = attr(img, 'alt');
  }

  const url = absUrl(attr(linkTag, 'href'), base);
  const cartTag = (block.match(/<a\b[^>]*add_to_cart_button[^>]*>/i) || [''])[0];
  const idFromClass = (classes.match(/\bpost-(\d+)\b/) || [])[1];

  const price = parsePrice(block);

  return {
    id: attr(cartTag, 'data-product_id') || idFromClass || '',
    sku: attr(cartTag, 'data-product_sku') || '',
    title,
    ...price,
    image: extractImage(block, base),
    url,
    brand: detectBrand(classes, title, categoryHint),
    in_stock: !/\boutofstock\b/.test(classes),
  };
}

function findNextPage(html, base) {
  const a =
    html.match(/<a\b[^>]*class=["'][^"']*\bnext\b[^"']*["'][^>]*href=["']([^"']+)["']/i) ||
    html.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bnext\b[^"']*["']/i) ||
    html.match(/<link\b[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i);
  if (a) return absUrl(decode(a[1]), base);

  // Respaldo: enlace a la página N+1 aunque ningún enlace lleve la clase "next"
  let cur = 1;
  try {
    const u = new URL(base);
    const m = u.pathname.match(/\/page\/(\d+)\/?/) || [null, u.searchParams.get('paged')];
    cur = parseInt(m[1], 10) || 1;
  } catch { /* base inválida: se asume página 1 */ }
  const wanted = new RegExp(`href=["']([^"']*(?:/page/${cur + 1}/?|[?&]paged=${cur + 1})(?:[^"']*))["']`, 'i');
  const f = html.match(wanted);
  return f ? absUrl(decode(f[1]), base) : '';
}

function pageNumberOf(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/page\/(\d+)\/?/) || [null, u.searchParams.get('paged')];
    return parseInt(m[1], 10) || 1;
  } catch { return 1; }
}

// Misma categoría pero en la página n (formato WooCommerce /page/n/)
function buildPageUrl(url, n) {
  const u = new URL(url);
  u.searchParams.delete('paged');
  u.pathname = u.pathname.replace(/\/page\/\d+\/?$/, '/').replace(/\/?$/, '/');
  if (n > 1) u.pathname += `page/${n}/`;
  return u.href;
}

// Nº total de páginas según los enlaces de paginación (0 si no se ve)
function totalPagesOf(html) {
  let max = 0;
  const re = /href=["'][^"']*(?:\/page\/(\d+)\/?|[?&]paged=(\d+))[^"']*["']/gi;
  let m;
  while ((m = re.exec(html))) max = Math.max(max, parseInt(m[1] || m[2], 10) || 0);
  return max;
}

/* ------------------- API pública de WooCommerce (Store API) ------------ */
// Devuelve 100 productos por petición, sin parsear HTML: mucho más rápida y estable.

const STORE_PER_PAGE = 100;
const WC_MARKERS = ['categoria-producto', 'product-category', 'tienda', 'shop', 'producto', 'product', 'categoria', 'etiqueta-producto', 'product-tag'];

async function fetchJsonRetry(url) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36', Accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = await res.json();
        return { data, total: parseInt(res.headers.get('x-wp-total'), 10) || 0, totalPages: parseInt(res.headers.get('x-wp-totalpages'), 10) || 0 };
      }
      last = new Error(`HTTP ${res.status}`); last.status = res.status;
      if (![429, 500, 502, 503, 504].includes(res.status)) throw last;
      const ra = parseInt(res.headers.get('retry-after'), 10);
      await sleep(ra > 0 ? Math.min(ra, 5) * 1000 : 1200 * (attempt + 1));
    } catch (e) {
      if (e.status && ![429, 500, 502, 503, 504].includes(e.status)) throw e;
      last = e;
      if (!e.status) await sleep(800 * (attempt + 1));
    }
  }
  throw last;
}

function storeApiCandidates(target) {
  const segs = target.pathname.split('/').filter(Boolean);
  const idx = segs.findIndex((x) => WC_MARKERS.includes(x.toLowerCase()));
  const prefixes = [];
  if (idx > 0) prefixes.push('/' + segs.slice(0, idx).join('/'));
  else if (idx === -1 && segs.length) prefixes.push('/' + segs.filter((x) => !/^page$|^\d+$/.test(x)).join('/'));
  if (segs.length) prefixes.push('/' + segs[0]);
  prefixes.push('');
  return [...new Set(prefixes)].map((pre) => target.origin + pre.replace(/\/$/, '') + '/wp-json/wc/store/v1');
}

function categorySlugOf(target) {
  const segs = target.pathname.split('/').filter(Boolean).map((x) => decodeURIComponentSafe(x));
  const i = segs.findIndex((x) => ['categoria-producto', 'product-category'].includes(x.toLowerCase()));
  if (i === -1) return '';
  const rest = segs.slice(i + 1).filter((x) => !/^page$|^\d+$/.test(x));
  return rest[rest.length - 1] || '';
}

function mapStoreProduct(p, sourceUrl) {
  const pr = p.prices || {};
  const div = 10 ** (pr.currency_minor_unit ?? 2);
  const num = (v) => (v !== undefined && v !== null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) / div : null);
  const price = num(pr.price), regular = num(pr.regular_price), sale = num(pr.sale_price);
  const title = decode(p.name);
  const catNames = (p.categories || []).map((c) => decode(c.name));
  const brand = decode(((p.brands || [])[0] || {}).name || '') || matchKnownBrand(title) || matchKnownBrand(catNames.join(' '));
  const sizeAttr = (p.attributes || []).find((a) => /talla|size/i.test(`${a.name || ''} ${a.taxonomy || ''}`));
  const sizes = sizeAttr ? [...new Set((sizeAttr.terms || []).map((t) => decode(t.name)).filter(Boolean))] : [];
  const img = (p.images || [])[0];
  return withPanelFields({
    id: String(p.id ?? ''),
    sku: p.sku || '',
    title,
    price,
    regular_price: regular ?? price,
    sale_price: sale && regular && sale < regular ? sale : null,
    price_text: price != null ? String(price) : '',
    currency: pr.currency_code || 'EUR',
    image: img && img.src ? fullSize(img.src) : '',
    url: p.permalink || '',
    brand,
    in_stock: p.is_in_stock !== false,
    sizes,
  }, p.permalink || sourceUrl, catNames.join(' '));
}

// Devuelve la respuesta ya montada, o null si el sitio no ofrece la API (se usa el HTML)
async function tryStoreApi(target, startPage, maxPages, via) {
  const ob = (target.searchParams.get('orderby') || '').toLowerCase();
  const orderParam = ['popularity', 'date', 'price', 'price-desc', 'rating', 'title'].includes(ob) ? `&orderby=${ob === 'price-desc' ? 'price&order=desc' : ob}` : '';
  let base = '', probe = null;
  for (const cand of storeApiCandidates(target)) {
    try {
      const r = await fetchJsonRetry(`${cand}/products?per_page=1`);
      if (Array.isArray(r.data)) { base = cand; probe = r; break; }
    } catch { /* se prueba el siguiente */ }
  }
  if (!base) return null;

  let catParam = '';
  const slug = categorySlugOf(target);
  if (slug) {
    let found = null;
    for (let pg = 1; pg <= 6 && !found; pg++) {
      let r;
      try { r = await fetchJsonRetry(`${base}/products/categories?per_page=100&page=${pg}`); } catch { break; }
      if (!Array.isArray(r.data)) break;
      found = r.data.find((c) => String(c.slug).toLowerCase() === slug.toLowerCase());
      if (r.data.length < 100) break;
    }
    if (!found) return via === 'store-api' ? null : null;
    catParam = `&category=${found.id}`;
  }

  const first = Math.max(startPage || 1, 1);
  const products = [], seen = new Set();
  let page = first, totalPages = 0, total = 0, rateLimited = false, pagesDone = 0;
  while (pagesDone < maxPages) {
    let r;
    try { r = await fetchJsonRetry(`${base}/products?per_page=${STORE_PER_PAGE}&page=${page}${catParam}${orderParam}`); }
    catch (e) {
      if (e.status === 400 && page > 1) break;                      // página fuera de rango
      if (!e.status || [429, 500, 502, 503, 504].includes(e.status)) { rateLimited = true; break; }
      if (pagesDone === 0) return null;
      break;
    }
    totalPages = r.totalPages || totalPages; total = r.total || total;
    if (!Array.isArray(r.data) || !r.data.length) break;
    for (const it of r.data) {
      const m = mapStoreProduct(it, target.href);
      const key = m.url || m.id || m.title;
      if (!m.title || seen.has(key)) continue;
      seen.add(key); products.push(m);
    }
    pagesDone++; page++;
    if (totalPages && page > totalPages) break;
    if (pagesDone < maxPages) await sleep(250);
  }
  if (pagesDone === 0 && !rateLimited && !products.length) return { is_category: true, via: 'store-api', source_url: target.href, count: 0, pages: 0, has_more_pages: false, products: [] };
  const lastPage = first + Math.max(pagesDone, 1) - 1;
  const hasMore = rateLimited || (totalPages ? page <= totalPages : false);
  return {
    is_category: true, via: 'store-api', source_url: target.href, per_page: STORE_PER_PAGE,
    count: products.length, total_products: total || probe.total || 0,
    pages: pagesDone, page_start: first, page_end: lastPage, total_pages: totalPages || lastPage,
    has_more_pages: hasMore, rate_limited: rateLimited, next_page: hasMore ? (rateLimited ? page : lastPage + 1) : 0,
    products,
  };
}

/* ---------- respaldo: listados que no usan la estructura li.product ----- */

const isProductHref = (h) => /\/(producto|product|p)\/[^/?#]+/i.test(h) && !/\/(product-category|categoria-producto)\//i.test(h);

function extractGenericItems(html, base) {
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
  const marks = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(html))) {
    const href = decode(m[1]);
    if (!isProductHref(href)) continue;
    const abs = absUrl(href, base).split('?')[0];
    if (seen.has(abs)) continue;
    seen.add(abs); marks.push({ index: m.index, url: abs });
  }
  return marks.map((mk, i) => ({ url: mk.url, block: html.slice(mk.index, i + 1 < marks.length ? marks[i + 1].index : mk.index + 5000) }));
}

function parseGenericItem({ url, block }, base, categoryHint) {
  const hm = block.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  let title = hm ? stripTags(hm[1]) : '';
  const firstA = (block.match(/<a\b[^>]*>/i) || [''])[0];
  if (!title) title = attr(firstA, 'title') || attr(firstA, 'aria-label');
  if (!title) title = attr((block.match(/<img\b[^>]*>/i) || [''])[0], 'alt');
  const text = stripTags(block.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ''));
  const pre = [...text.matchAll(/€\s?(\d{1,5}(?:[.,]\d{1,2})?)/g)].map((x) => parseNumber(x[1]));
  const suf = [...text.matchAll(/(\d{1,5}(?:[.,]\d{1,2})?)\s?€(?!\s?\d)/g)].map((x) => parseNumber(x[1]));
  const money = (pre.length ? pre : suf).filter((n) => n > 0);
  const price = money.length ? Math.min(...money) : null;
  const regular = money.length > 1 ? Math.max(...money) : price;
  return {
    id: '', sku: '', title, price, regular_price: regular, sale_price: regular > price ? price : null,
    price_text: price != null ? String(price) : '', currency: 'EUR',
    image: extractImage(block, base), url, brand: detectBrand('', title, categoryHint), in_stock: true,
  };
}

/* ------------- datos estructurados (JSON-LD / Schema.org) y código pegado ------------- */
// Casi todas las plataformas modernas (Shopify, Wix, Squarespace, Magento, PrestaShop, BigCommerce,
// WooCommerce…) publican <script type="application/ld+json"> con el esquema Product.

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const firstStr = (v) => {
  const x = asArray(v)[0];
  if (!x) return '';
  if (typeof x === 'string') return x;
  return String(x.url || x.contentUrl || x['@id'] || x.name || '');
};
const SIZE_KEY = /(^|\b)(size|talla|tamaño|taille|größe|grösse|misura|tamanho)(\b|$)/i;

function ldOffer(n) {
  const offers = asArray(n.offers).flatMap((o) => (o && o.offers ? asArray(o.offers).concat(o) : [o])).filter(Boolean);
  const prices = [], compares = [];
  let currency = '', inStock = null, url = '';
  for (const o of offers) {
    const spec = asArray(o.priceSpecification);
    const raw = o.price ?? o.lowPrice ?? (spec[0] || {}).price;
    const v = parseNumber(raw);
    if (v > 0) prices.push(v);
    const strike = spec.find((x) => x && /list|strike|msrp/i.test(String(x.priceType || '')));
    if (strike && parseNumber(strike.price) > 0) compares.push(parseNumber(strike.price));
    const hi = parseNumber(o.highPrice);
    if (hi > 0) compares.push(hi);
    currency = currency || o.priceCurrency || (spec[0] || {}).priceCurrency || '';
    if (o.availability) inStock = inStock === true ? true : /InStock|LimitedAvailability|PreOrder|OnlineOnly/i.test(String(o.availability));
    url = url || firstStr(o.url);
  }
  const price = prices.length ? Math.min(...prices) : null;
  const regular = compares.filter((c) => c > (price || 0));
  return { price, regular_price: regular.length ? Math.max(...regular) : price, currency: currency || 'EUR', in_stock: inStock !== false, url };
}

function ldProducts(html, base) {
  const out = [];
  const seen = new Set();
  const push = (n, parent) => {
    const name = n.name || (parent && parent.name);
    if (!name) return;
    let offer = ldOffer(n);
    const variants = asArray(n.hasVariant).filter((v) => v && typeof v === 'object');
    if (!offer.price && variants.length) {
      const vo = variants.map(ldOffer).filter((o) => o.price);
      if (vo.length) offer = { ...offer, price: Math.min(...vo.map((o) => o.price)), regular_price: Math.max(...vo.map((o) => o.regular_price || o.price)), currency: vo[0].currency };
    }
    const sizes = [...new Set(variants.map((v) => v.size || (asArray(v.additionalProperty).find((x) => x && SIZE_KEY.test(String(x.name || ''))) || {}).value).filter(Boolean).map(String))];
    const imgs = asArray(n.image).map(firstStr).filter(Boolean).map((u) => fullSize(absUrl(u, base))).filter(Boolean);
    const brand = typeof n.brand === 'string' ? n.brand : (n.brand && n.brand.name) || (parent && parent.brand && (parent.brand.name || parent.brand)) || '';
    const url = absUrl(firstStr(n.url) || offer.url || firstStr(n['@id']).split('#')[0] || '', base) || '';
    const key = url || name;
    if (seen.has(key + '|' + name)) return;
    seen.add(key + '|' + name);
    out.push({
      title: decode(String(name)), image: imgs[0] || '', images: imgs, url: url || base,
      price: offer.price, regular_price: offer.regular_price, sale_price: offer.regular_price > offer.price ? offer.price : null,
      price_text: offer.price ? String(offer.price) : '', currency: offer.currency, in_stock: offer.in_stock,
      brand: decode(String(brand || '')), sku: String(n.sku || n.mpn || ''), sizes,
      description: stripTags(String(n.description || '')).slice(0, 600),
    });
  };
  const walk = (n, parent, depth = 0) => {
    if (!n || typeof n !== 'object' || depth > 8) return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, parent, depth + 1));
    const t = asArray(n['@type']).join(' ');
    if (/\b(Product|ProductGroup|IndividualProduct|Vehicle)\b/i.test(t)) push(n, parent);
    for (const k of ['itemListElement', 'item', '@graph', 'mainEntity', 'mainEntityOfPage', 'hasPart']) if (n[k]) walk(n[k], /ProductGroup/i.test(t) ? n : parent, depth + 1);
  };
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim().replace(/^<!--|-->$/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
    try { walk(JSON.parse(raw)); } catch { /* bloque inválido: se ignora */ }
  }
  return out;
}

// Respaldo para una ficha de producto sin JSON-LD: etiquetas Open Graph / product:*
function ogProduct(html, base) {
  const meta = (p) => {
    const m = html.match(new RegExp(`<meta[^>]*(?:property|name)=["']${p}["'][^>]*content=["']([^"']*)["']`, 'i')) ||
      html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${p}["']`, 'i'));
    return m ? decode(m[1]) : '';
  };
  const title = meta('og:title') || meta('twitter:title') || stripTags((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const price = parseNumber(meta('product:price:amount') || meta('og:price:amount'));
  const image = absUrl(meta('og:image') || meta('twitter:image'), base);
  if (!title || !(price > 0 || image)) return null;
  return {
    title, image, images: image ? [image] : [], url: absUrl(meta('og:url'), base) || base, price: price > 0 ? price : null,
    regular_price: price > 0 ? price : null, sale_price: null, price_text: price > 0 ? String(price) : '',
    currency: meta('product:price:currency') || meta('og:price:currency') || 'EUR', in_stock: true,
    brand: meta('product:brand') || meta('og:brand') || '', sku: '', sizes: [], description: meta('og:description').slice(0, 600),
  };
}

function ldToPanel(p, base, hint) {
  const price = Number(p.price) > 0 ? Number(p.price) : null;
  return withPanelFields({
    id: '', sku: p.sku || '', title: p.title, price, regular_price: p.regular_price || price, sale_price: p.sale_price || null,
    price_text: price != null ? String(price) : '', currency: p.currency || 'EUR', image: p.image || '', url: p.url || base,
    brand: p.brand || matchKnownBrand(p.title) || '', in_stock: p.in_stock !== false,
    ...(p.images && p.images.length > 1 ? { images: p.images } : {}), ...(p.sizes && p.sizes.length ? { sizes: p.sizes } : {}),
    ...(p.description ? { description: p.description } : {}),
  }, p.url || base, hint);
}

// Código fuente pegado desde el panel (Ctrl+U): nunca lanza error; devuelve [] si no encuentra nada.
function parsePastedHtml(html, target) {
  html = String(html || '');
  const base = target.href;
  const hint = decodeURIComponentSafe(target.pathname);
  const products = [], seen = new Set();
  const push = (p) => {
    try {
      if (!p || !p.title) return;
      const key = (p.url && p.url !== base ? p.url : '') || p.title;
      if (seen.has(key)) return;
      seen.add(key);
      products.push(p.__panel ? p.__panel : ldToPanel(p, base, hint));
    } catch { /* un producto mal formado no rompe el resto */ }
  };
  try { ldProducts(html, base).filter((p) => p.price || p.image).forEach(push); } catch { /* sigue con el HTML */ }
  if (products.length < 2) {
    try {
      const items = extractLoopItems(html);
      if (items.length) items.forEach((it) => { try { const q = parseLoopItem(it, base, hint); push({ title: q.title, __panel: withPanelFields(q, q.url || base, hint) }); } catch { /* sigue */ } });
      else extractGenericItems(html, base).forEach((it) => { try { const q = parseGenericItem(it, base, hint); push({ title: q.title, __panel: withPanelFields(q, q.url || base, hint) }); } catch { /* sigue */ } });
    } catch { /* sigue */ }
  }
  if (!products.length) { try { push(ogProduct(html, base)); } catch { /* nada */ } }
  return products;
}

/* ----------------------------------- Shopify ---------------------------------- */
// Shopify publica el catálogo en JSON: /collections/<handle>/products.json (hasta 250 por página),
// /products.json (toda la tienda) y /products/<handle>.json (una ficha).

const SHOPIFY_PATH = /^((?:\/[a-z]{2}(?:-[a-z]{2})?)?)\/(collections|products)(?:\/([^/?#]+))?/i;

function shopifyEndpoints(target) {
  const m = target.pathname.match(SHOPIFY_PATH);
  if (m) {
    const prefix = m[1] || '', kind = m[2].toLowerCase(), handle = m[3] ? decodeURIComponentSafe(m[3]).replace(/\.json$/i, '') : '';
    if (kind === 'products' && handle) return { prefix, single: `${target.origin}${prefix}/products/${encodeURIComponent(handle)}.json` };
    if (kind === 'collections' && handle) {
      const sub = target.pathname.match(/\/collections\/[^/]+\/products\/([^/?#]+)/i);   // /collections/x/products/y = ficha
      if (sub) return { prefix, single: `${target.origin}${prefix}/products/${encodeURIComponent(decodeURIComponentSafe(sub[1]))}.json` };
      return { prefix, list: `${target.origin}${prefix}/collections/${encodeURIComponent(handle)}/products.json` };
    }
    return { prefix, list: `${target.origin}${prefix}/products.json` };
  }
  if (target.pathname === '/' || target.pathname === '') return { prefix: '', list: `${target.origin}/products.json` };
  return null;
}

async function fetchShopifyJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36' },
    redirect: 'follow', signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  if (!/json/i.test(res.headers.get('content-type') || '')) throw new Error('no es JSON');
  return res.json();
}

function mapShopifyProduct(it, origin, prefix, hint) {
  const variants = asArray(it.variants);
  const prices = variants.map((v) => parseNumber(v.price)).filter((n) => n > 0);
  const price = prices.length ? Math.min(...prices) : null;
  const cmp = variants.map((v) => parseNumber(v.compare_at_price)).filter((n) => n > (price || 0));
  const regular = cmp.length ? Math.max(...cmp) : price;
  const sizeOpt = asArray(it.options).find((o) => o && SIZE_KEY.test(String(o.name || '')));
  let sizes = sizeOpt ? asArray(sizeOpt.values).map(String) : [];
  if (!sizes.length) {
    const t = [...new Set(variants.map((v) => String(v.title || '')).filter((x) => x && !/default title/i.test(x)))];
    if (t.length > 1 && t.every((x) => /^(\d{2}(\.\d)?|XXS|XS|S|M|L|XL|XXL|XXXL|\d{1,2}(\/\d{1,2})?(\s?[A-Z]{1,2})?)(\s*\/.*)?$/i.test(x.trim()))) sizes = t.map((x) => x.split('/')[0].trim());
  }
  const imgs = asArray(it.images).map((i) => (i && i.src ? fullSize(String(i.src)) : '')).filter(Boolean);
  const tags = Array.isArray(it.tags) ? it.tags.join(' ') : String(it.tags || '');
  const title = decode(String(it.title || ''));
  const product = {
    id: String(it.id || ''), sku: (variants[0] && variants[0].sku) || '', title, price, regular_price: regular,
    sale_price: regular > price ? price : null, price_text: price ? String(price) : '', currency: 'EUR',
    image: imgs[0] || '', url: `${origin}${prefix}/products/${it.handle}`,
    brand: matchKnownBrand(title) || decode(String(it.vendor || '')),
    in_stock: variants.length ? variants.some((v) => v.available !== false) : true,
    sizes: [...new Set(sizes)].slice(0, 40), description: stripTags(String(it.body_html || '')).slice(0, 600),
  };
  if (imgs.length > 1) product.images = imgs;
  return withPanelFields(product, product.url, `${it.product_type || ''} ${tags} ${hint}`);
}

async function tryShopify(target, startPage, maxPages) {
  const ep = shopifyEndpoints(target);
  if (!ep) return null;
  const hint = decodeURIComponentSafe(target.pathname);

  if (ep.single) {
    const data = await fetchShopifyJson(ep.single);
    if (!data || !data.product) return null;
    const product = mapShopifyProduct(data.product, target.origin, ep.prefix, hint);
    return { is_category: false, via: 'shopify', ...product, products: [product] };
  }

  const first = Math.max(startPage || 1, 1);
  const products = [], seen = new Set();
  let page = first, pagesDone = 0, hasMore = false, rateLimited = false;
  while (pagesDone < maxPages) {
    let data;
    try { data = await fetchShopifyJson(`${ep.list}?limit=250&page=${page}`); }
    catch (e) {
      if (pagesDone === 0) { if (e.status === 429) throw e; return null; }   // no es Shopify (o error al empezar)
      if (e.status === 429 || (e.status >= 500)) { rateLimited = true; hasMore = true; }
      break;
    }
    const items = data && Array.isArray(data.products) ? data.products : null;
    if (!items) { if (pagesDone === 0) return null; break; }
    for (const it of items) { if (!it || seen.has(it.id)) continue; seen.add(it.id); products.push(mapShopifyProduct(it, target.origin, ep.prefix, hint)); }
    pagesDone++; page++;
    if (items.length < 250) { hasMore = false; break; }
    hasMore = true;
    if (pagesDone < maxPages) await sleep(300);
  }
  if (!products.length && pagesDone === 0) return null;
  return {
    is_category: true, via: 'shopify', source_url: target.href, per_page: 250, count: products.length,
    pages: pagesDone, page_start: first, page_end: page - 1, total_pages: hasMore ? page : page - 1,
    has_more_pages: hasMore, rate_limited: rateLimited, next_page: hasMore ? page : 0, products,
  };
}

/* ------------------------------- Yupoo --------------------------------- */
// Álbumes de proveedores (xxx.x.yupoo.com/albums): cada álbum = un producto con varias fotos.

const isYupooHost = (h) => /(^|\.)yupoo\.com$/i.test(h);
const yupooAbs = (u, base) => absUrl(String(u || '').startsWith('//') ? 'https:' + u : u, base);

// Precio escrito en el título del álbum: "¥150", "150 RMB", "$25", "€30"
function yupooPrice(title) {
  const t = String(title || '');
  let m = t.match(/([¥￥$€£])\s?(\d{1,5}(?:[.,]\d{1,2})?)/);
  if (m) return { value: parseNumber(m[2]), currency: { '¥': 'CNY', '￥': 'CNY', '$': 'USD', '€': 'EUR', '£': 'GBP' }[m[1]] };
  m = t.match(/(\d{1,5}(?:[.,]\d{1,2})?)\s?(RMB|CNY|元|USD|EUR)/i);
  if (m) return { value: parseNumber(m[1]), currency: /usd/i.test(m[2]) ? 'USD' : /eur/i.test(m[2]) ? 'EUR' : 'CNY' };
  return null;
}
// Quita el precio y adornos del título para dejar solo el nombre
const yupooCleanTitle = (t) =>
  decode(t).replace(/[¥￥$€£]\s?\d+(?:[.,]\d+)?/g, '').replace(/\b\d+(?:[.,]\d+)?\s?(RMB|CNY|元)\b/gi, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, '').replace(/\s{2,}/g, ' ').replace(/^[\s\-–|:]+|[\s\-–|:]+$/g, '').trim();

function parseYupooAlbums(html, base) {
  const re = /<a\b[^>]*href=["']([^"']*\/albums\/(\d+)[^"']*)["'][^>]*>/gi;
  const marks = [], seen = new Set();
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]); marks.push({ index: m.index, tag: m[0], href: m[1], id: m[2] });
  }
  return marks.map((mk, i) => {
    const block = html.slice(mk.index, i + 1 < marks.length ? marks[i + 1].index : mk.index + 4000);
    const titleM = block.match(/class=["'][^"']*album__title[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|p|h\d)>/i);
    const img = (block.match(/<img\b[^>]*>/i) || [''])[0];
    const rawTitle = (titleM ? stripTags(titleM[1]) : '') || attr(mk.tag, 'title') || attr(img, 'alt');
    const cover = attr(img, 'data-origin-src') || attr(img, 'data-src') || attr(img, 'src');
    const count = parseInt((block.match(/album__photonumber[^>]*>\s*(\d+)/i) || [])[1], 10) || 0;
    const url = yupooAbs(mk.href, base).replace(/&amp;/g, '&');
    const price = yupooPrice(rawTitle);
    return {
      id: mk.id, title: yupooCleanTitle(rawTitle), image: cover ? yupooAbs(cover, base) : '', url,
      album_url: url, photo_count: count, price_hint: price, source: 'yupoo', brand: matchKnownBrand(rawTitle),
    };
  }).filter((a) => a.title);
}

function parseYupooPhotos(html, base) {
  const out = [], seen = new Set();
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    const origin = attr(tag, 'data-origin-src') || attr(tag, 'data-src') || attr(tag, 'src');
    if (!origin || !/photo\.yupoo\.com\/[^/]+\/[^/]+\//i.test(origin)) continue;
    if (/avatar|logo|banner/i.test(origin)) continue;
    const key = (origin.match(/photo\.yupoo\.com\/[^/]+\/([^/]+)\//i) || [])[1];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // la foto grande: si solo hay miniatura (small/medium/square) se pide la "big"
    out.push(yupooAbs(origin, base).replace(/\/(small|medium|square|thumb)\.(jpe?g|png|webp)/i, '/big.$2'));
  }
  return out;
}

async function yupooScrape(target, startPage, maxPages) {
  const headers = { Referer: `${target.origin}/`, 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' };
  const isAlbumPage = /\/albums\/\d+/.test(target.pathname);

  if (isAlbumPage) {
    const { html, finalUrl } = await fetchHtml(target.href, headers);
    const titleM = html.match(/showalbumheader__gallerytitle[^>]*>([\s\S]*?)<\/(?:span|div|h\d)>/i) ||
      html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i) || html.match(/<title>([\s\S]*?)<\/title>/i);
    const rawTitle = titleM ? stripTags(titleM[1]) : '';
    const photos = parseYupooPhotos(html, finalUrl);
    if (!photos.length) throw new Error('No se encontraron fotos en el álbum.');
    const price = yupooPrice(rawTitle);
    const product = withPanelFields({
      id: (target.pathname.match(/\/albums\/(\d+)/) || [])[1] || '', title: yupooCleanTitle(rawTitle.replace(/\|.*$/, '')) || 'Producto Yupoo',
      price: null, regular_price: null, sale_price: null, price_text: '', currency: 'EUR',
      image: photos[0], photos, url: target.href, album_url: target.href, price_hint: price, source: 'yupoo',
      brand: matchKnownBrand(rawTitle), in_stock: true,
    }, target.href, rawTitle);
    return { is_category: false, via: 'yupoo', ...product, products: [product] };
  }

  // listado de álbumes: /albums, /albums/<categoría>, ?page=N
  const listUrl = new URL(target.href);
  if (startPage > 1) listUrl.searchParams.set('page', String(startPage));
  const first = Math.max(startPage || 0, parseInt(listUrl.searchParams.get('page'), 10) || 1);
  const products = [], seen = new Set();
  let page = first, totalPages = 0, pagesDone = 0, rateLimited = false;
  while (pagesDone < maxPages) {
    const u = new URL(listUrl.href); if (page > 1) u.searchParams.set('page', String(page)); else u.searchParams.delete('page');
    let res;
    try { res = await fetchHtml(u.href, headers); }
    catch (e) {
      if (/HTTP (429|502|503)/.test(String(e.message)) && pagesDone > 0) { rateLimited = true; break; }
      throw e;
    }
    const albums = parseYupooAlbums(res.html, res.finalUrl);
    for (const hr of res.html.matchAll(/[?&]page=(\d+)/g)) totalPages = Math.max(totalPages, parseInt(hr[1], 10) || 0);
    const before = products.length;
    for (const a of albums) { if (seen.has(a.id)) continue; seen.add(a.id); products.push(withPanelFields(a, a.url, a.title)); }
    pagesDone++;
    if (!albums.length || products.length === before) { page++; break; }
    page++;
    if (totalPages && page > totalPages) break;
    if (pagesDone < maxPages) await sleep(500);
  }
  const hasMore = rateLimited || (totalPages ? page <= totalPages : false);
  if (!products.length) throw new Error('No se encontraron álbumes. Puede que Yupoo esté bloqueando la lectura desde el servidor.');
  return {
    is_category: true, via: 'yupoo', source_url: target.href, count: products.length, pages: pagesDone,
    page_start: first, page_end: page - 1, total_pages: totalPages || page - 1, has_more_pages: hasMore,
    rate_limited: rateLimited, next_page: hasMore ? page : 0, products,
  };
}

/* --------------------------- producto individual ---------------------- */

function extractSingle(html, base) {
  const h1 = html.match(/<h1[^>]*product_title[^>]*>([\s\S]*?)<\/h1>/i);
  const og = (p) => {
    const m = html.match(new RegExp(`<meta[^>]*property=["']${p}["'][^>]*content=["']([^"']*)["']`, 'i')) ||
      html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${p}["']`, 'i'));
    return m ? decode(m[1]) : '';
  };

  const title = h1 ? stripTags(h1[1]) : og('og:title');
  const priceBlock = (html.match(/<p[^>]*class=["'][^"']*\bprice\b[^>]*>[\s\S]*?<\/p>/i) || [''])[0];
  const price = parsePrice(priceBlock);

  const gallery = [...html.matchAll(/data-large_image=["']([^"']+)["']/gi)].map((m) => absUrl(decode(m[1]), base));
  const images = [...new Set([...gallery, absUrl(og('og:image'), base)].filter(Boolean))];

  const bodyClass = (html.match(/<body[^>]*class=["']([^"']*)["']/i) || [])[1] || '';
  const sku = (html.match(/class=["']sku["'][^>]*>([^<]*)</i) || [])[1] || '';
  const desc = html.match(/woocommerce-product-details__short-description[^>]*>([\s\S]*?)<\/div>/i);

  return {
    id: (bodyClass.match(/\bpostid-(\d+)\b/) || [])[1] || '',
    sku: decode(sku),
    title,
    ...price,
    image: images[0] || '',
    images,
    url: base,
    brand: detectBrand(bodyClass, title, base),
    description: desc ? stripTags(desc[1]) : '',
    in_stock: !/\boutofstock\b/.test(bodyClass) && !/class=["'][^"']*\bout-of-stock\b/.test(html),
  };
}

/* ------------------------------- fetching ----------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pide la página; si la tienda responde 429/503 (demasiadas peticiones) espera y reintenta
async function fetchHtml(url, extra) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await fetchHtmlOnce(url, extra); }
    catch (e) {
      last = e;
      const m = /HTTP (\d+)/.exec(String(e.message));
      if (!m || !['429', '503', '502'].includes(m[1])) throw e;
      await sleep(e.retryAfter || 1200 * (attempt + 1));
    }
  }
  throw last;
}

async function fetchHtmlOnce(url, extra = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'es-ES,es;q=0.9',
      ...extra,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = new Error(`La tienda respondió HTTP ${res.status}`);
    const ra = parseInt(res.headers.get('retry-after'), 10);
    if (ra > 0) err.retryAfter = Math.min(ra, 5) * 1000;
    throw err;
  }
  return { html: await res.text(), finalUrl: res.url || url };
}

export function isBlockedHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname.startsWith('[') ||
    /^0\./.test(hostname) ||
    hostname.endsWith('.local') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname) ||
    hostname === '[::1]'
  );
}

/* -------------------------------- handler ----------------------------- */

// Procesa una petición POST /api/scrape y devuelve siempre una Response con CORS.
export async function handleScrape(request) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'El cuerpo debe ser JSON: { "url": "..." }' }, 400); }

  if (!body || !body.url) return json({ error: 'URL no proporcionada' }, 400);

  let target;
  try { target = new URL(String(body.url).trim()); }
  catch { return json({ error: 'URL no válida' }, 400); }

  if (!/^https?:$/.test(target.protocol) || isBlockedHost(target.hostname)) {
    return json({ error: 'URL no permitida' }, 400);
  }

  const maxPages = Math.min(
    Math.max(parseInt(body.max_pages, 10) || DEFAULT_MAX_PAGES, 1),
    HARD_MAX_PAGES
  );

  if (typeof body.html === 'string' && body.html.length > 500) {
    const products = parsePastedHtml(body.html.slice(0, 12_000_000), target);
    if (!products.length) return json({ error: 'No se encontraron productos en el código pegado. Copia el código fuente de una página de listado (Ctrl+U en el navegador).' }, 422);
    return json({ is_category: true, via: 'pasted', source_url: target.href, count: products.length, pages: 1, has_more_pages: false, next_page: 0, products });
  }

  if (isYupooHost(target.hostname)) {
    try { return json(await yupooScrape(target, parseInt(body.start_page, 10) || 0, Math.min(maxPages, 5))); }
    catch (e) {
      const msg = String(e.message || e);
      return json({ error: /HTTP (403|567|429|503)/.test(msg) ? 'Yupoo bloquea las lecturas automáticas desde el servidor (' + msg + ').' : msg }, 502);
    }
  }

  const startPage = parseInt(body.start_page, 10) || 0;

  // Shopify: catálogo en JSON (/collections/x/products.json, /products.json, /products/x.json)
  if (body.via !== 'html' && body.via !== 'store-api' && body.via !== 'json-ld') {
    try {
      const viaShopify = await tryShopify(target, startPage, Math.min(maxPages, 5));
      if (viaShopify) return json(viaShopify);
    } catch (e) {
      if (body.via === 'shopify') return json({ error: 'La tienda no respondió (' + String(e.message || e) + '); vuelve a intentarlo.' }, 502);
    }
    if (body.via === 'shopify') return json({ error: 'La tienda Shopify no respondió; vuelve a intentarlo.' }, 502);
  }

  if (startPage > 1) {
    try { target = new URL(buildPageUrl(target.href, startPage)); } catch { /* se usa la URL tal cual */ }
  }

  // Primero la API pública de WooCommerce (100 productos por petición); si no existe, se lee el HTML
  const singleProductPath = /\/(producto|product)\/[^/]+/i.test(target.pathname) && !/\/(product-category|categoria-producto)\//i.test(target.pathname);
  const urlPage = pageNumberOf(target.href);
  if (!['html', 'json-ld', 'shopify'].includes(body.via) && !singleProductPath && (!(urlPage > 1) || startPage > 0)) {
    try {
      const viaApi = await tryStoreApi(target, startPage, Math.min(maxPages, 5), body.via);
      if (viaApi) return json(viaApi);
    } catch { /* se sigue con el HTML */ }
    if (body.via === 'store-api') return json({ error: 'La API de la tienda no respondió; vuelve a intentarlo.' }, 502);
  }

  try {
    let first;
    try { first = await fetchHtml(target.href); }
    catch (e) {
      // Página fuera de rango (404) al pedir una página concreta: no hay más
      if (startPage > 1 && /HTTP 404/.test(String(e.message))) {
        return json({ is_category: true, source_url: target.href, count: 0, pages: 0, has_more_pages: false, products: [] });
      }
      throw e;
    }
    const html = first.html;
    const base = first.finalUrl;

    const bodyClass = (html.match(/<body[^>]*class=["']([^"']*)["']/i) || [])[1] || '';
    const looksSingle = bodyClass
      ? /\bsingle-product\b/.test(bodyClass)
      : /\bproduct_title\b/.test(html);

    let items = extractLoopItems(html);
    let generic = false;
    if (!items.length && !looksSingle) {
      const g = extractGenericItems(html, base);
      if (g.length >= 2) { items = g; generic = true; }
    }

    // Cualquier otra plataforma (Wix, Squarespace, Magento, PrestaShop…): datos estructurados JSON-LD
    let ldSingle = null;
    if (!looksSingle && !items.length) {
      const hint0 = decodeURIComponentSafe(new URL(base).pathname);
      let ld = ldProducts(html, base).filter((q) => q.price || q.image);
      if (ld.length >= 2) {
        const products = [], seenK = new Set();
        const addLd = (list, pageBase) => list.forEach((q) => { const k = q.url || q.title; if (!seenK.has(k)) { seenK.add(k); products.push(ldToPanel(q, pageBase, hint0)); } });
        addLd(ld, base);
        let pages = 1, lastHtml = html, lastUrl = base, next = findNextPage(html, base), rateLimitedLd = false;
        while (next && pages < maxPages) {
          await sleep(350);
          let pg;
          try { pg = await fetchHtml(next); }
          catch (e) { if (/HTTP (429|502|503)/.test(String(e.message))) { rateLimitedLd = true; break; } throw e; }
          const before = products.length;
          addLd(ldProducts(pg.html, pg.finalUrl).filter((q) => q.price || q.image), pg.finalUrl);
          pages++; lastHtml = pg.html; lastUrl = pg.finalUrl;
          if (products.length === before) break;
          next = findNextPage(lastHtml, lastUrl);
        }
        const hasMoreLd = rateLimitedLd || !!findNextPage(lastHtml, lastUrl);
        return json({
          is_category: true, via: 'json-ld', source_url: base, count: products.length, pages,
          page_start: pageNumberOf(base), page_end: pageNumberOf(lastUrl), total_pages: Math.max(totalPagesOf(html), totalPagesOf(lastHtml), pageNumberOf(lastUrl)),
          has_more_pages: hasMoreLd, rate_limited: rateLimitedLd, next_page: hasMoreLd ? pageNumberOf(lastUrl) + 1 : 0, products,
        });
      }
      if (ld.length === 1) ldSingle = ld[0];
    }

    // ¿Categoría? -> hay listado de productos y NO es la ficha de un producto
    // (las fichas también traen "productos relacionados" con li.product).
    if (!looksSingle && items.length > 0) {
      const categoryHint = decodeURIComponent(new URL(base).pathname);
      const products = [];
      const seen = new Set();
      const add = (list, pageBase) => {
        for (const it of list) {
          const p = generic ? parseGenericItem(it, pageBase, categoryHint) : parseLoopItem(it, pageBase, categoryHint);
          const key = p.url || p.id || p.title;
          if (!p.title || seen.has(key)) continue;
          seen.add(key);
          products.push(withPanelFields(p, p.url || base, categoryHint));
        }
      };

      add(items, base);
      let pages = 1;
      let lastHtml = html;
      let lastUrl = base;
      let next = findNextPage(lastHtml, lastUrl);

      let rateLimited = false;
      while (next && pages < maxPages) {
        await sleep(350); // ritmo suave para no saturar la tienda
        let page;
        try { page = await fetchHtml(next); }
        catch (e) {
          // Se devuelve lo ya cargado y se avisa; el panel reintenta desde esta página
          if (/HTTP (429|502|503)/.test(String(e.message))) { rateLimited = true; break; }
          throw e;
        }
        const before = products.length;
        const more = extractLoopItems(page.html);
        add(more.length || !generic ? more : extractGenericItems(page.html, page.finalUrl), page.finalUrl);
        pages++;
        lastHtml = page.html;
        lastUrl = page.finalUrl;
        if (products.length === before) break; // página sin productos nuevos: parar
        next = findNextPage(lastHtml, lastUrl);
      }

      const hasMore = rateLimited || !!findNextPage(lastHtml, lastUrl);
      const pageStart = pageNumberOf(base);
      const pageEnd = pageNumberOf(lastUrl);
      return json({
        is_category: true,
        via: 'html',
        source_url: base,
        count: products.length,
        pages,
        page_start: pageStart,
        page_end: pageEnd,
        total_pages: Math.max(totalPagesOf(html), totalPagesOf(lastHtml), pageEnd),
        has_more_pages: hasMore,
        rate_limited: rateLimited,
        next_page: hasMore ? pageEnd + 1 : 0,
        products,
      });
    }

    // Producto individual
    let product = withPanelFields(extractSingle(html, base), base);
    if (!looksSingle || !product.title) {
      // fuera de WooCommerce: JSON-LD de la ficha (o etiquetas Open Graph como último recurso)
      const hintS = decodeURIComponentSafe(new URL(base).pathname);
      const ld1 = ldSingle || ldProducts(html, base).find((q) => q.price || q.image) || ogProduct(html, base);
      if (ld1 && (!product.title || !(product.price > 0))) product = ldToPanel({ ...ld1, url: ld1.url && ld1.url !== base ? ld1.url : base }, base, hintS);
    }
    if (!product.title) {
      return json({ error: 'No se encontró ningún producto ni categoría en esa URL' }, 422);
    }
    return json({ is_category: false, ...product, products: [product] });
  } catch (err) {
    const m = String(err.message || 'scraping fallido');
    return json({ error: 'Error en el servidor: ' + m + (/HTTP (403|401|5\d\d)/.test(m) && /jdsports|zalando|footlocker|zara|nike\.|adidas\./i.test(target.hostname) ? '. Esta web bloquea al servidor: usa el recuadro "Pegar código de la página".' : '') }, 502);
  }
}

/* ------------------------ Cloudflare Pages Functions ------------------- */

export async function onRequestPost({ request }) {
  return handleScrape(request);
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
