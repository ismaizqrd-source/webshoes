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

  /* ───────────────────────────── API principal ──────────────────────────── */

  /**
   * Normaliza una foto.
   * @param {Uint8ClampedArray} rgba  píxeles RGBA de la foto original
   * @param {number} w,h              tamaño
   * @param {object} opts
   *   ort, session   onnxruntime-web y sesión del modelo (opcional; sin ellos se usa flood fill)
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
      alpha = floodAlpha(rgba, w, h);
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
    return { rgba: out.rgba, size: out.size, flipped: flip, direction, method, warnings };
  }

  const ImgNorm = {
    MODEL_SIZE, DEFAULTS,
    resizeBilinear, preprocessU2, postprocessU2, aiAlpha, floodAlpha, keepMainBlobs,
    alphaBox, toeDirection, composeOnWhite, normalize,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ImgNorm;
  else root.ImgNorm = ImgNorm;
})(typeof self !== 'undefined' ? self : globalThis);
