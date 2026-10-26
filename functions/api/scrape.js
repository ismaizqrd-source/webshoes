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
const withPanelFields = (p, sourceUrl) => ({
  ...p,
  sizes: DEFAULT_SIZES,
  category_guess: DEFAULT_CATEGORY,
  source_url: sourceUrl,
});

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

async function fetchHtml(url) {
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
  if (!res.ok) throw new Error(`La tienda respondió HTTP ${res.status}`);
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

    const items = extractLoopItems(html);

    // ¿Categoría? -> hay listado de productos y NO es la ficha de un producto
    // (las fichas también traen "productos relacionados" con li.product).
    if (!looksSingle && items.length > 0) {
      const categoryHint = decodeURIComponent(new URL(base).pathname);
      const products = [];
      const seen = new Set();
      const add = (list, pageBase) => {
        for (const it of list) {
          const p = parseLoopItem(it, pageBase, categoryHint);
          const key = p.url || p.id || p.title;
          if (!p.title || seen.has(key)) continue;
          seen.add(key);
          products.push(withPanelFields(p, p.url || base));
        }
      };

      add(items, base);
      let pages = 1;
      let lastHtml = html;
      let lastUrl = base;
      let next = findNextPage(lastHtml, lastUrl);

      while (next && pages < maxPages) {
        const page = await fetchHtml(next);
        const before = products.length;
        add(extractLoopItems(page.html), page.finalUrl);
        pages++;
        lastHtml = page.html;
        lastUrl = page.finalUrl;
        if (products.length === before) break; // página sin productos nuevos: parar
        next = findNextPage(lastHtml, lastUrl);
      }

      const hasMore = !!findNextPage(lastHtml, lastUrl);
      const pageStart = pageNumberOf(base);
      const pageEnd = pageNumberOf(lastUrl);
      return json({
        is_category: true,
        source_url: base,
        count: products.length,
        pages,
        page_start: pageStart,
        page_end: pageEnd,
        total_pages: Math.max(totalPagesOf(html), totalPagesOf(lastHtml), pageEnd),
        has_more_pages: hasMore,
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
