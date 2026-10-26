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

    // Cloudflare realiza la petición HTTP a la tienda externa de forma nativa
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

    // Extracción adaptada a WooCommerce (título, precio, imagen de la galería principal)
    const titleMatch = html.match(/<h1[^>]*class="[^"]*product_title[^"]*"[^>]*>([^<]+)<\/h1>/i) || html.match(/<meta property="og:title" content="([^"]+)"/);
    const imageMatch = html.match(/data-large_image="([^"]+)"/i) || html.match(/<meta property="og:image" content="([^"]+)"/);
    const priceMatch = html.match(/<span class="price">.*?<bdi>([\d.,]+)\s*€<\/bdi>/is) || html.match(/<meta property="product:price:amount" content="([^"]+)"/);

    const title = titleMatch ? titleMatch[1].trim() : "Producto importado";
    const price = priceMatch ? parseFloat(priceMatch[1].replace(/\./g, "").replace(",", ".")) : 0;
    const image = imageMatch ? imageMatch[1] : "";

    const productData = {
      title: title,
      price: price,
      image: image,
      source_url: targetUrl,
      brand: title.toLowerCase().includes("new balance") ? "New Balance" : (title.toLowerCase().includes("nike") ? "Nike" : "Desconocida"),
      category_guess: "Calzado"
    };

    return new Response(JSON.stringify(productData), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });

  } anuv (err) { // Nota: en catch por sintaxis JS standard se usa catch (err)
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
