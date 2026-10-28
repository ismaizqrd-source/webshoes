/**
 * Detección de marca a partir del texto (título, categorías…). Compartido por el importador y el panel.
 * Cada marca tiene alias (mqueen, mc queen…). Se prueban en orden: la primera que encaje gana,
 * por eso las más específicas (Jordan, Yeezy) van antes que Nike / Adidas.
 */
export const BRAND_DEFS = [
  ['Jordan', ['air jordan', 'jordan']],
  ['Yeezy', ['yeezy', 'yezzy', 'yeezi']],
  ['Golden Goose', ['golden goose', 'goldengoose', 'ggdb']],
  ['Alexander McQueen', ['alexander mcqueen', 'alexander mqueen', 'alexander mc queen', 'mcqueen', 'mqueen', 'mc queen', 'm queen']],
  ['Onitsuka Tiger', ['onitsuka tiger', 'onitsuka', 'mexico 66', 'tokuten', 'tai chi', 'gymnarina', 'gsm', 'serrano', 'okuru', 'lawnship', 'kihachi', 'california 78', 'ultimate 81', 'dualio', 'delegation', 'ohbori']],
  ['Nike', ['nike', 'nocta', 'air force 1', 'air max', 'dunk low', 'dunk high', 'tn plus', 'vomero', 'cortez']],
  ['Adidas', ['adidas', 'adidas originals', 'samba', 'gazelle', 'campus', 'spezial', 'superstar', 'stan smith', 'forum low', 'handball', 'adizero']],
  ['New Balance', ['new balance', 'nb 550', 'nb550', '9060']],
  ['Asics', ['asics', 'gel kayano', 'gel 1130', 'gel nyc', 'kayano']],
  ['Off White', ['off white', 'offwhite']],
  ['Louis Vuitton', ['louis vuitton', 'lv trainer', 'lv skate']],
  ['Ralph Lauren', ['ralph lauren', 'polo ralph', 'polo rl']],
  ['The North Face', ['the north face', 'north face', 'tnf']],
  ['Tommy Hilfiger', ['tommy hilfiger', 'tommy jeans']],
  ['Calvin Klein', ['calvin klein']],
  ['Hugo Boss', ['hugo boss']],
  ['Under Armour', ['under armour']],
  ['Stone Island', ['stone island']],
  ['Saint Laurent', ['saint laurent', 'yves saint laurent', 'ysl']],
  ['Bottega Veneta', ['bottega veneta', 'bottega']],
  ['Maison Margiela', ['maison margiela', 'margiela', 'tabi']],
  ['Miu Miu', ['miu miu']],
  ['Rick Owens', ['rick owens']],
  ['Chrome Hearts', ['chrome hearts']],
  ['Gallery Dept', ['gallery dept']],
  ['Fear of God', ['fear of god', 'essentials fog']],
  ['Dr. Martens', ['dr martens', 'doc martens']],
  ['Arc\'teryx', ['arcteryx', 'arc teryx']],
  ['Levi\'s', ['levis', 'levi s']],
  ['Converse', ['converse', 'chuck taylor']],
  ['Birkenstock', ['birkenstock', 'boston clog']],
  ['Balenciaga', ['balenciaga']], ['Gucci', ['gucci']], ['Dior', ['dior']], ['Prada', ['prada']],
  ['Versace', ['versace']], ['Fendi', ['fendi']], ['Burberry', ['burberry']], ['Moncler', ['moncler']],
  ['Givenchy', ['givenchy']], ['Valentino', ['valentino']], ['Loewe', ['loewe']], ['Chanel', ['chanel']],
  ['Hermès', ['hermes']], ['Armani', ['armani']], ['Amiri', ['amiri']], ['Ami Paris', ['ami paris', 'ami de coeur', 'ami']],
  ['Represent', ['represent']], ['Supreme', ['supreme']], ['Stussy', ['stussy']], ['Carhartt', ['carhartt']],
  ['Puma', ['puma']], ['Reebok', ['reebok']], ['Vans', ['vans']], ['Salomon', ['salomon']], ['Hoka', ['hoka']],
  ['Saucony', ['saucony']], ['Mizuno', ['mizuno']], ['Lacoste', ['lacoste']], ['Fila', ['fila']],
  ['Crocs', ['crocs']], ['Timberland', ['timberland']], ['Champion', ['champion']], ['Lululemon', ['lululemon']],
  ['Patagonia', ['patagonia']], ['Bape', ['bape', 'a bathing ape']], ['Palace', ['palace']],
  ['Trapstar', ['trapstar']], ['Corteiz', ['corteiz', 'crtz']], ['Zara', ['zara']],
  ['Apple', ['apple', 'airpods', 'iphone', 'macbook', 'ipad', 'apple watch']],
  ['Samsung', ['samsung', 'galaxy buds']], ['Sony', ['sony']], ['JBL', ['jbl']], ['Dyson', ['dyson']],
  ['Ray-Ban', ['ray ban', 'rayban']], ['Oakley', ['oakley']],
];

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`´]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const ALIAS_RES = BRAND_DEFS.map(([name, aliases]) => [name, new RegExp('(^| )(' + aliases.map((a) => norm(a).replace(/ /g, ' ')).join('|') + ')( |$)')]);

export function detectBrandFromText(text) {
  const t = norm(text);
  if (!t) return '';
  for (const [name, re] of ALIAS_RES) if (re.test(t)) return name;
  return '';
}
