export async function onRequestPost(context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  try {
    const body = await context.request.json();
    const targetUrl = body.url;

    if (!targetUrl) {
      return new Response(JSON.stringify({ error: "URL no proporcionada" }), { status: 400, headers: corsHeaders });
    }

    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ error: `La tienda externa respondió con estado ${response.status}` }), { status: 502, headers: corsHeaders });
    }

    const html = await response.text();

    // Extracción básica y segura para WooCommerce
    const titleMatch = html.match(/<h1[^>]*class="[^"]*product_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<meta property="og:title" content="([^"]+)"/i);
    const priceMatch = html.match(/<span class="price">[\s\S]*?<bdi>([\d.,]+)\s*€<\/bdi>/i) || html.match(/<meta property="product:price:amount" content="([^"]+)"/i);
    const imageMatch = html.match(/data-large_image="([^"]+)"/i) || html.match(/<meta property="og:image" content="([^"]+)"/i);

    const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : "Producto importado";
    const price = priceMatch ? parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.')) : 0;
    const image = imageMatch ? imageMatch[1] : "";

    const productData = {
      title,
      price,
      brand: title.toLowerCase().includes("nike") ? "Nike" : (title.toLowerCase().includes("adidas") ? "Adidas" : "New Balance"),
      image,
      category_guess: "Calzado",
      source_url: targetUrl
    };

    return new Response(JSON.stringify(productData), { status: 200, headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Error en Cloudflare: " + err.message }), { status: 500, headers: corsHeaders });
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
