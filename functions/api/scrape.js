export async function onRequestPost(context) {
  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  try {
    const body = await context.request.json();
    const targetUrl = body.url;

    if (!targetUrl) {
      return new Response(JSON.stringify({ error: "URL no proporcionada" }), {
        status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
      }
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `La tienda respondió con estado ${res.status}` }), {
        status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const html = await res.text();

    let productData = {
      title: null,
      price: null,
      brand: null,
      model: null,
      color: null,
      images: [],
      sizes: [],
      source_url: targetUrl,
      category_guess: "Calzado"
    };

    // 1. Extracción mediante Datos Estructurados JSON-LD (La más precisa si existe)
    const jsonLdRegex = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = jsonLdRegex.exec(html)) !== null) {
      try {
        const json = JSON.parse(match[1]);
        const items = Array.isArray(json) ? json : (json['@graph'] || [json]);
        for (const item of items) {
          if (item['@type'] === 'Product' || (Array.isArray(item['@type']) && item['@type'].includes('Product'))) {
            productData.title = item.name || productData.title;
            if (item.brand) {
              productData.brand = typeof item.brand === 'object' ? item.brand.name : item.brand;
            }
            if (item.offers) {
              const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
              productData.price = parseFloat(offer.price || offer.lowPrice) || productData.price;
            }
            if (item.image) {
              const imgs = Array.isArray(item.image) ? item.image : [item.image];
              productData.images = imgs.map(img => typeof img === 'object' ? img.url : img).filter(Boolean);
            }
          }
        }
      } catch (e) {
        // Ignorar bloques JSON con formato incorrecto
      }
    }

    // 2. Fallback / Complemento HTML específico para WooCommerce / OpenGraph
    if (!productData.title) {
      const titleMatch = html.match(/<h1[^>]*class="[^"]*product_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
                         html.match(/<meta property="og:title" content="([^"]+)"/i);
      if (titleMatch) {
        productData.title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
      }
    }

    if (productData.price === null || isNaN(productData.price)) {
      const priceMatch = html.match(/<span class="price">[\s\S]*?<bdi>([\d.,]+)\s*€<\/bdi>/i) ||
                         html.match(/<meta property="product:price:amount" content="([^"]+)"/i) ||
                         html.match(/itemprop="price"[^>]*content="([^"]+)"/i);
      if (priceMatch) {
        productData.price = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
      }
    }

    if (productData.images.length === 0) {
      // Buscar imágenes en alta definición de la galería de WooCommerce
      const imgRegex = /data-large_image="([^"]+)"/gi;
      let imgMatch;
      while ((imgMatch = imgRegex.exec(html)) !== null) {
        if (!productData.images.includes(imgMatch[1])) {
          productData.images.push(imgMatch[1]);
        }
      }
      if (productData.images.length === 0) {
        const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/i);
        if (ogImage) productData.images.push(ogImage[1]);
      }
    }

    // 3. Extracción automática de Tallas (Variantes, selectores y etiquetas)
    const foundSizes = new Set();
    const sizeRegex = /value="(3[0-9]|4[0-9]|XS|S|M|L|XL|XXL|XXXL|\d{1,2}(\.\d)?)"/gi;
    let sizeMatch;
    while ((sizeMatch = sizeRegex.exec(html)) !== null) {
      foundSizes.add(sizeMatch[1]);
    }
    const textSizes = html.match(/>\s*(3[0-9]|4[0-9]|XS|S|M|L|XL|XXL|XXXL|\d{1,2}(\.\d)?)\s*</gi);
    if (textSizes) {
      textSizes.forEach(t => {
        const clean = t.replace(/[<>]/g, '').trim();
        if (clean) foundSizes.add(clean);
      });
    }
    productData.sizes = Array.from(foundSizes).slice(0, 20);

    // 4. Detección inteligente de Marca
    if (!productData.brand && productData.title) {
      const knownBrands = ["New Balance", "Nike", "Adidas", "Jordan", "Balenciaga", "Asics", "Dior", "Louis Vuitton", "Converse", "Prada", "Amiri", "Off White"];
      for (const b of knownBrands) {
        if (productData.title.toLowerCase().includes(b.toLowerCase())) {
          productData.brand = b;
          break;
        }
      }
    }

    // 5. Desglose de Modelo y Color a partir del título
    if (productData.title) {
      const parts = productData.title.split(' ');
      productData.model = parts.slice(0, 2).join(' '); // Ej: "530" o "Air Force"
      productData.color = parts.slice(2).join(' ') || "Estándar"; // Ej: "Munsell White"
    }

    return new Response(JSON.stringify(productData), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Error en el servidor: " + err.message }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    }
  });
}
