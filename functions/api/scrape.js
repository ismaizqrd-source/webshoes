export async function onRequestPost(context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  try {
    let body;
    try {
      body = await context.request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Cuerpo de solicitud inválido" }), { status: 400, headers });
    }

    const targetUrl = body.url;
    if (!targetUrl) {
      return new Response(JSON.stringify({ error: "URL no proporcionada" }), { status: 400, headers });
    }

    let res;
    try {
      res = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        }
      });
    } catch (fetchErr) {
      return new Response(JSON.stringify({ error: "No se pudo conectar a la tienda externa: " + fetchErr.message }), { status: 502, headers });
    }

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `La tienda respondió con estado ${res.status}` }), { status: 502, headers });
    }

    const html = await res.text();

    // Extracción segura de datos
    let title = "Producto importado";
    let price = 0;
    let image = "";
    let images = [];
    let brand = "Adidas";

    const titleMatch = html.match(/<h1[^>]*class="[^"]*product_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<meta property="og:title" content="([^"]+)"/i);
    if (titleMatch) {
      title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
    }

    const priceMatch = html.match(/<span class="price">[\s\S]*?<bdi>([\d.,]+)\s*€<\/bdi>/i) || html.match(/<meta property="product:price:amount" content="([^"]+)"/i);
    if (priceMatch) {
      price = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.')) || 0;
    }

    const imgMatch = html.match(/data-large_image="([^"]+)"/i) || html.match(/<meta property="og:image" content="([^"]+)"/i);
    if (imgMatch) {
      image = imgMatch[1];
      images.push(image);
    }

    const productData = {
      title,
      price,
      brand,
      model: title,
      color: "Estándar",
      image,
      images,
      sizes: ["38", "39", "40", "41", "42", "43", "44"],
      source_url: targetUrl,
      category_guess: "Calzado"
    };

    return new Response(JSON.stringify(productData), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Error interno en Cloudflare: " + err.message }), { status: 500, headers });
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
