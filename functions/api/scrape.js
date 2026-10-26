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
const withPanelFields = (p, sourceUrl, hint = '') => ({
  ...p,
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
  const t = String(text || '').toLowerCase().replace(/[-_]+/g, ' ');
  for (const b of KNOWN_BRANDS) {
    if (brandRegex(b.replace(/-/g, ' ')).test(t)) return b;
  }
  return '';
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
const fullSize = (u) => u.replace(/-\d{2,4}x\d{2,4}(?=\.(?:jpe?g|png|webp|gif)(?:\?|$))/i, '');

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
    try { r = await fetchJsonRetry(`${base}/products?per_page=${STORE_PER_PAGE}&page=${page}${catParam}`); }
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
async function fetchHtml(url) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await fetchHtmlOnce(url); }
    catch (e) {
      last = e;
      const m = /HTTP (\d+)/.exec(String(e.message));
      if (!m || !['429', '503', '502'].includes(m[1])) throw e;
      await sleep(e.retryAfter || 1200 * (attempt + 1));
    }
  }
  throw last;
}

async function fetchHtmlOnce(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'es-ES,es;q=0.9',
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

  const startPage = parseInt(body.start_page, 10) || 0;
  if (startPage > 1) {
    try { target = new URL(buildPageUrl(target.href, startPage)); } catch { /* se usa la URL tal cual */ }
  }

  // Primero la API pública de WooCommerce (100 productos por petición); si no existe, se lee el HTML
  const singleProductPath = /\/(producto|product)\/[^/]+/i.test(target.pathname) && !/\/(product-category|categoria-producto)\//i.test(target.pathname);
  const urlPage = pageNumberOf(target.href);
  if (body.via !== 'html' && !singleProductPath && (!(urlPage > 1) || startPage > 0)) {
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
    const product = withPanelFields(extractSingle(html, base), base);
    if (!product.title) {
      return json({ error: 'No se encontró ningún producto ni categoría en esa URL' }, 422);
    }
    return json({ is_category: false, ...product, products: [product] });
  } catch (err) {
    return json({ error: 'Error en el servidor: ' + (err.message || 'scraping fallido') }, 502);
  }
}

/* ------------------------ Cloudflare Pages Functions ------------------- */

export async function onRequestPost({ request }) {
  return handleScrape(request);
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
