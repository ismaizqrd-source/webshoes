/**
 * public/imgnorm.js
 * ════════════════════════════════════════════════════════════
 * Unifica las fotos de producto: recorta el fondo, orienta la zapatilla
 * (punta a la derecha), la centra y la pone sobre fondo blanco 900×900.
 *
 * Funciona sobre píxeles RGBA (Uint8ClampedArray), así que el mismo
 * código se usa en el navegador (panel) y en las pruebas con Node.
 *
 * Recorte con IA: modelo U²-Net pequeño (u2netp, Apache-2.0) ejecutado
 * con onnxruntime-web (MIT) dentro del navegador. Si el modelo no está
 * disponible se usa un recorte por color del fondo (flood fill).
 * ════════════════════════════════════════════════════════════
 */
(function (root) {
  'use strict';

  const MODEL_SIZE = 320;
  const DEFAULTS = { size: 900, margin: 0.07, maxSide: 1400 };

  /* ───────────────────────── utilidades de imagen ───────────────────────── */

  /** Remuestreo bilineal de un buffer con `ch` canales (entrada u8 o float). */
  function resizeBilinear(src, sw, sh, dw, dh, ch) {
    const out = new Float32Array(dw * dh * ch);
    const xr = sw / dw, yr = sh / dh;
    for (let y = 0; y < dh; y++) {
      const fy = Math.max(0, Math.min(sh - 1, (y + 0.5) * yr - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < dw; x++) {
        const fx = Math.max(0, Math.min(sw - 1, (x + 0.5) * xr - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
        for (let c = 0; c < ch; c++) {
          const a = src[(y0 * sw + x0) * ch + c], b = src[(y0 * sw + x1) * ch + c];
          const d = src[(y1 * sw + x0) * ch + c], e = src[(y1 * sw + x1) * ch + c];
          out[(y * dw + x) * ch + c] = (a + (b - a) * wx) * (1 - wy) + (d + (e - d) * wx) * wy;
        }
      }
    }
    return out;
  }

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smoothstep = (lo, hi, v) => { const t = clamp01((v - lo) / (hi - lo)); return t * t * (3 - 2 * t); };

  /** Reduce la imagen si el lado mayor supera maxSide (acelera todo lo demás). */
  function limitSize(rgba, w, h, maxSide) {
    const m = Math.max(w, h);
    if (m <= maxSide) return { rgba, w, h };
    const s = maxSide / m;
    const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
    const f = resizeBilinear(rgba, w, h, nw, nh, 4);
    return { rgba: Uint8ClampedArray.from(f, (v) => Math.round(v)), w: nw, h: nh };
  }

  /* ─────────────────────────── recorte con U²-Net ───────────────────────── */

  /** RGBA -> tensor CHW float32 [3,320,320] como en rembg. */
  function preprocessU2(rgba, w, h) {
    const r = resizeBilinear(rgba, w, h, MODEL_SIZE, MODEL_SIZE, 4);
    let max = 1e-6;
    for (let i = 0; i < MODEL_SIZE * MODEL_SIZE; i++) {
      max = Math.max(max, r[i * 4], r[i * 4 + 1], r[i * 4 + 2]);
    }
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    const plane = MODEL_SIZE * MODEL_SIZE;
    const out = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      for (let c = 0; c < 3; c++) out[c * plane + i] = (r[i * 4 + c] / max - mean[c]) / std[c];
    }
    return out;
  }

  /** Salida del modelo (320×320) -> alfa 0..255 al tamaño original. */
  function postprocessU2(pred, w, h) {
    let mi = Infinity, ma = -Infinity;
    for (let i = 0; i < pred.length; i++) { if (pred[i] < mi) mi = pred[i]; if (pred[i] > ma) ma = pred[i]; }
    const span = Math.max(1e-6, ma - mi);
    const norm = new Float32Array(pred.length);
    for (let i = 0; i < pred.length; i++) norm[i] = (pred[i] - mi) / span;
    const up = resizeBilinear(norm, MODEL_SIZE, MODEL_SIZE, w, h, 1);
    const a = new Uint8ClampedArray(w * h);
    for (let i = 0; i < a.length; i++) a[i] = Math.round(smoothstep(0.30, 0.70, up[i]) * 255);
    return a;
  }

  /** Ejecuta el modelo. `ort` es onnxruntime-web (o -node); `session` ya cargada. */
  async function aiAlpha(ort, session, rgba, w, h) {
    const input = new ort.Tensor('float32', preprocessU2(rgba, w, h), [1, 3, MODEL_SIZE, MODEL_SIZE]);
    const feeds = {}; feeds[session.inputNames[0]] = input;
    const res = await session.run(feeds);
    const out = res[session.outputNames[0]];
    return postprocessU2(out.data, w, h);
  }

  /* ─────────────────── recorte por color (respaldo sin IA) ──────────────── */

  /** Quita un fondo liso conectado con el borde. Útil si la IA no está disponible. */
  function floodAlpha(rgba, w, h, tol) {
    tol = tol || 14;
    // color de fondo = mediana por canal del anillo exterior
    const ring = [];
    for (let x = 0; x < w; x++) { ring.push(x, (h - 1) * w + x); }
    for (let y = 0; y < h; y++) { ring.push(y * w, y * w + w - 1); }
    const med = [0, 1, 2].map((c) => {
      const v = ring.map((p) => rgba[p * 4 + c]).sort((a, b) => a - b);
      return v[v.length >> 1];
    });
    const dist = (p) => Math.max(
      Math.abs(rgba[p * 4] - med[0]), Math.abs(rgba[p * 4 + 1] - med[1]), Math.abs(rgba[p * 4 + 2] - med[2]));

    const bg = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let sp = 0;
    const push = (p) => { if (!bg[p] && dist(p) <= tol) { bg[p] = 1; stack[sp++] = p; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p / w) | 0;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    const a = new Uint8ClampedArray(w * h);
    for (let p = 0; p < a.length; p++) {
      if (bg[p]) { a[p] = 0; continue; }
      // borde suave: píxeles de primer plano pegados al fondo
      const x = p % w, y = (p / w) | 0;
      const nearBg = (x > 0 && bg[p - 1]) || (x < w - 1 && bg[p + 1]) || (y > 0 && bg[p - w]) || (y < h - 1 && bg[p + w]);
      a[p] = nearBg ? Math.round(255 * smoothstep(tol * 0.5, tol * 2.5, dist(p))) : 255;
    }
    return a;
  }

  /* ───────────────────────── limpieza y geometría ───────────────────────── */

  /** Quita motas: conserva el objeto mayor y los que midan ≥ minRatio de él (pares de zapatillas). */
  function keepMainBlobs(alpha, w, h, minRatio) {
    minRatio = minRatio === undefined ? 0.08 : minRatio;
    const label = new Int32Array(w * h);
    const areas = [0];
    const stack = new Int32Array(w * h);
    let n = 0;
    for (let s = 0; s < w * h; s++) {
      if (alpha[s] <= 128 || label[s]) continue;
      n++; let sp = 0, area = 0;
      label[s] = n; stack[sp++] = s;
      while (sp) {
        const p = stack[--sp]; area++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && alpha[p - 1] > 128 && !label[p - 1]) { label[p - 1] = n; stack[sp++] = p - 1; }
        if (x < w - 1 && alpha[p + 1] > 128 && !label[p + 1]) { label[p + 1] = n; stack[sp++] = p + 1; }
        if (y > 0 && alpha[p - w] > 128 && !label[p - w]) { label[p - w] = n; stack[sp++] = p - w; }
        if (y < h - 1 && alpha[p + w] > 128 && !label[p + w]) { label[p + w] = n; stack[sp++] = p + w; }
      }
      areas.push(area);
    }
    const biggest = Math.max(1, ...areas);
    const keep = areas.map((a) => a >= biggest * minRatio);
    const out = new Uint8ClampedArray(alpha);
    for (let p = 0; p < out.length; p++) {
      if (alpha[p] > 0 && label[p] && !keep[label[p]]) out[p] = 0;
      else if (alpha[p] > 0 && !label[p]) {
        // píxel semitransparente sin etiqueta: se queda solo si toca un objeto conservado
        const x = p % w, y = (p / w) | 0;
        const near = [x > 0 ? label[p - 1] : 0, x < w - 1 ? label[p + 1] : 0, y > 0 ? label[p - w] : 0, y < h - 1 ? label[p + w] : 0];
        if (!near.some((l) => l && keep[l])) out[p] = 0;
      }
    }
    return out;
  }

  function alphaBox(alpha, w, h, thr) {
    thr = thr === undefined ? 40 : thr;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alpha[y * w + x] > thr) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x0, y0, x1, y1 };
  }

  /**
   * ¿Hacia dónde apunta la punta de la zapatilla (vista lateral)?
   * Pistas: el talón es más alto que la puntera, y la puntera sube un poco
   * por abajo (toe spring). Devuelve { dir: 'left'|'right', score, confidence }.
   * score > 0 => punta a la derecha.
   */
  function toeDirection(alpha, w, h, box) {
    const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
    const top = new Int32Array(bw).fill(-1), bot = new Int32Array(bw).fill(-1);
    for (let x = 0; x < bw; x++) {
      for (let y = box.y0; y <= box.y1; y++) {
        if (alpha[y * w + box.x0 + x] > 128) { if (top[x] < 0) top[x] = y; bot[x] = y; }
      }
    }
    const win = Math.max(3, Math.round(bw * 0.2)), skip = Math.max(1, Math.round(bw * 0.03));
    const meanOver = (arr, from, to, fn) => {
      let s = 0, n = 0;
      for (let x = from; x < to && x < bw; x++) if (arr[x] >= 0) { s += fn(x); n++; }
      return n ? s / n : 0;
    };
    const hOf = (x) => bot[x] - top[x] + 1;
    const hL = meanOver(top, skip, skip + win, hOf), hR = meanOver(top, bw - skip - win, bw - skip, hOf);
    const A = (hL - hR) / Math.max(hL, hR, 1);                       // >0 talón a la izquierda
    const bL = meanOver(bot, skip, skip + Math.round(win * 0.6), (x) => bot[x]);
    const bR = meanOver(bot, bw - skip - Math.round(win * 0.6), bw - skip, (x) => bot[x]);
    const B = (bL - bR) / Math.max(bh, 1);                             // >0 la derecha sube (puntera)
    const score = A + 1.5 * B;
    return { dir: score >= 0 ? 'right' : 'left', score, confidence: Math.abs(score), A, B };
  }

  /* ───────────────────────────── composición final ──────────────────────── */

  /**
   * Recorta al objeto, lo espeja si hace falta, lo escala y lo pone sobre blanco.
   * Devuelve RGBA (size×size) con fondo blanco opaco.
   */
  function composeOnWhite(rgba, alpha, w, h, box, opts) {
    const size = opts.size, margin = opts.margin, flip = !!opts.flip;
    const cw = box.x1 - box.x0 + 1, ch = box.y1 - box.y0 + 1;
    // recorte premultiplicado (r*a, g*a, b*a, a)
    const crop = new Float32Array(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const sx = flip ? box.x0 + (cw - 1 - x) : box.x0 + x;
        const p = (box.y0 + y) * w + sx;
        const a = alpha[p] / 255, o = (y * cw + x) * 4;
        crop[o] = rgba[p * 4] * a; crop[o + 1] = rgba[p * 4 + 1] * a; crop[o + 2] = rgba[p * 4 + 2] * a; crop[o + 3] = a;
      }
    }
    const inner = size * (1 - 2 * margin);
    const s = Math.min(inner / cw, inner / ch);
    const dw = Math.max(1, Math.round(cw * s)), dh = Math.max(1, Math.round(ch * s));
    const rs = resizeBilinear(crop, cw, ch, dw, dh, 4);
    const out = new Uint8ClampedArray(size * size * 4).fill(255);
    const ox = Math.round((size - dw) / 2), oy = Math.round((size - dh) / 2);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const i = (y * dw + x) * 4, a = rs[i + 3];
        const o = ((oy + y) * size + ox + x) * 4;
        out[o] = rs[i] + 255 * (1 - a);
        out[o + 1] = rs[i + 1] + 255 * (1 - a);
        out[o + 2] = rs[i + 2] + 255 * (1 - a);
        out[o + 3] = 255;
      }
    }
    return { rgba: out, size, drawn: { x: ox, y: oy, w: dw, h: dh } };
  }

  /**
   * ¿Se puede fiar del recorte por color de fondo (rápido, ~60 ms) sin pasar por la IA (~1 s)?
   * Sí cuando el fondo es liso, el objeto tiene forma de zapatilla (no un rectángulo lleno),
   * ocupa un tamaño normal y no es casi blanco (zapatillas blancas sobre fondo blanco se "escapan").
   */
  function flatBackgroundTrusted(rgba, w, h, alpha) {
    // 1) fondo liso: desviación de los píxeles del borde respecto a su mediana
    const ring = [];
    const add = (x, y) => { const o = (y * w + x) * 4; ring.push(rgba[o], rgba[o + 1], rgba[o + 2]); };
    for (let x = 0; x < w; x += 3) { add(x, 0); add(x, h - 1); }
    for (let y = 0; y < h; y += 3) { add(0, y); add(w - 1, y); }
    const n = ring.length / 3, med = [0, 1, 2].map((c) => { const v = []; for (let i = 0; i < n; i++) v.push(ring[i * 3 + c]); return v.sort((a, b) => a - b)[n >> 1]; });
    let dev = 0;
    for (let i = 0; i < n; i++) dev += Math.abs(ring[i * 3] - med[0]) + Math.abs(ring[i * 3 + 1] - med[1]) + Math.abs(ring[i * 3 + 2] - med[2]);
    dev /= n * 3;
    if (dev > 4) return false;
    // 2) forma y tamaño del objeto, y cuánto blanco hay dentro
    let fg = 0, white = 0, x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (alpha[k] <= 128) continue;
      fg++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const o = k * 4; if (Math.min(rgba[o], rgba[o + 1], rgba[o + 2]) > 215) white++;
    }
    if (!fg) return false;
    const frac = fg / (w * h), bw = (x1 - x0 + 1) / w, fill = fg / ((x1 - x0 + 1) * (y1 - y0 + 1));
    return frac >= 0.08 && frac <= 0.32 && bw >= 0.4 && fill < 0.8 && white / fg < 0.35;
  }

  /* ───────────────────────────── color del producto ─────────────────────── */

  // Nombre en español del color de un píxel (RGB 0-255)
  function colorNameOf(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    const v = mx, sat = mx === 0 ? 0 : d / mx;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    if (v < 0.2) return 'Negro';
    if (sat < 0.12) return v > 0.86 ? 'Blanco' : v > 0.62 ? 'Gris claro' : v > 0.25 ? 'Gris' : 'Negro';
    if (h >= 345 || h < 15) return v < 0.5 ? 'Burdeos' : (sat < 0.5 && v > 0.75) ? 'Rosa' : 'Rojo';
    if (h < 45) return (sat < 0.3 && v > 0.78) ? 'Crema' : v < 0.55 ? 'Marrón' : sat < 0.5 ? 'Beige' : h < 30 ? 'Naranja' : 'Mostaza';
    if (h < 70) return sat < 0.3 ? 'Crema' : v < 0.55 ? 'Verde oliva' : 'Amarillo';
    if (h < 165) return v < 0.4 ? 'Verde oscuro' : (sat < 0.4 && v > 0.6) ? 'Verde menta' : 'Verde';
    if (h < 200) return sat < 0.35 && v > 0.7 ? 'Azul claro' : 'Turquesa';
    if (h < 255) return v < 0.45 ? 'Azul marino' : (sat < 0.4 && v > 0.7) ? 'Azul claro' : 'Azul';
    if (h < 290) return (sat < 0.4 && v > 0.7) ? 'Lila' : 'Morado';
    return sat > 0.6 ? 'Fucsia' : 'Rosa';
  }

  /** Color dominante del objeto (y un segundo si ocupa >30 %): "Rojo", "Blanco y negro"… */
  function dominantColor(rgba, alpha, w, h) {
    const count = {}; let total = 0;
    for (let p = 0; p < w * h; p += 3) {
      if (alpha[p] < 240) continue;
      const o = p * 4, name = colorNameOf(rgba[o], rgba[o + 1], rgba[o + 2]);
      count[name] = (count[name] || 0) + 1; total++;
    }
    if (total < 50) return '';
    const sorted = Object.entries(count).sort((a, b) => b[1] - a[1]);
    // los grises/blancos/negros vecinos se tratan como distintos solo si son claramente distintos
    const first = sorted[0][0];
    const second = sorted.find(([n, c], i) => i > 0 && c / total > 0.3 && n !== first && !(/Gris/.test(n) && /Gris/.test(first)));
    return second ? `${first} y ${second[0].toLowerCase()}` : first;
  }

  /* ───────────────────────────── API principal ──────────────────────────── */

  /**
   * Normaliza una foto.
   * @param {Uint8ClampedArray} rgba  píxeles RGBA de la foto original
   * @param {number} w,h              tamaño
   * @param {object} opts
   *   ort, session   onnxruntime-web y sesión del modelo (opcional; sin ellos se usa flood fill)
   *   fast           true: usa el recorte por color cuando el fondo es liso y fiable (sin IA)
   *   orient         true: girar para que la punta mire a la derecha (calzado)
   *   forceFlip      true/false para forzar el espejo (botón manual); null = automático
   *   size, margin   tamaño final (900) y margen (0.07)
   * @returns {{rgba, size, flipped, direction, method, warnings}}
   */
  async function normalize(rgba, w, h, opts) {
    opts = Object.assign({ orient: true, forceFlip: null }, DEFAULTS, opts || {});
    const warnings = [];
    const lim = limitSize(rgba, w, h, opts.maxSide);
    rgba = lim.rgba; w = lim.w; h = lim.h;

    // 1) matte: transparencia propia > IA > color de fondo
    let alpha = null, method = '';
    let transparent = 0;
    for (let p = 0; p < w * h; p++) if (rgba[p * 4 + 3] < 250) transparent++;
    if (transparent > w * h * 0.03) {
      alpha = new Uint8ClampedArray(w * h);
      for (let p = 0; p < alpha.length; p++) alpha[p] = rgba[p * 4 + 3];
      method = 'transparencia';
    }
    // Modo rápido: si el fondo es liso y el recorte por color es fiable, no hace falta la IA
    let flood = null;
    if (!alpha && opts.fast) {
      flood = floodAlpha(rgba, w, h);
      if (flatBackgroundTrusted(rgba, w, h, keepMainBlobs(flood, w, h))) { alpha = flood; method = 'color'; }
    }
    if (!alpha && opts.ort && opts.session) {
      try { alpha = await aiAlpha(opts.ort, opts.session, rgba, w, h); method = 'ia'; }
      catch (e) { warnings.push('Falló el recorte con IA: ' + (e.message || e)); }
    }
    const fraction = (a) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] > 128) n++; return n / a.length; };
    if (alpha && method === 'ia') {
      const f = fraction(alpha);
      if (f < 0.02 || f > 0.9) { warnings.push('El recorte con IA no parece correcto; se usa el color del fondo.'); alpha = null; }
    }
    if (!alpha) {
      alpha = flood || floodAlpha(rgba, w, h);
      method = 'color';
      const f = fraction(alpha);
      if (f < 0.02 || f > 0.9) {
        warnings.push('No se pudo separar el fondo; se deja la foto entera.');
        alpha = new Uint8ClampedArray(w * h).fill(255); method = 'ninguno';
      }
    }

    // 2) limpiar y medir
    if (method !== 'ninguno') alpha = keepMainBlobs(alpha, w, h);
    let box = alphaBox(alpha, w, h);
    if (!box) { alpha = new Uint8ClampedArray(w * h).fill(255); box = { x0: 0, y0: 0, x1: w - 1, y1: h - 1 }; method = 'ninguno'; warnings.push('No se detectó ningún objeto.'); }

    // 3) orientación
    let direction = null, flip = false;
    if (opts.forceFlip === true || opts.forceFlip === false) {
      flip = opts.forceFlip;
    } else if (opts.orient) {
      direction = toeDirection(alpha, w, h, box);
      flip = direction.dir === 'left';
      if (direction.confidence < 0.06) warnings.push('Orientación poco clara: revisa si hay que girarla.');
    }

    // 4) composición
    const out = composeOnWhite(rgba, alpha, w, h, box, { size: opts.size, margin: opts.margin, flip });
    return { rgba: out.rgba, size: out.size, flipped: flip, direction, method, warnings, color: method === 'ninguno' ? '' : dominantColor(rgba, alpha, w, h) };
  }

  const ImgNorm = {
    MODEL_SIZE, DEFAULTS,
    resizeBilinear, preprocessU2, postprocessU2, aiAlpha, floodAlpha, keepMainBlobs,
    alphaBox, toeDirection, composeOnWhite, flatBackgroundTrusted, colorNameOf, dominantColor, normalize,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ImgNorm;
  else root.ImgNorm = ImgNorm;
})(typeof self !== 'undefined' ? self : globalThis);
