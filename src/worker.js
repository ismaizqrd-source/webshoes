const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // 1. Endpoint de scraping integrado directamente en el Worker
    if (url.pathname === "/api/scrape" && request.method === "POST") {
      try {
        const body = await request.json();
        const targetUrl = body.url;

        if (!targetUrl) {
          return new Response(JSON.stringify({ error: "URL no proporcionada" }), {
            status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
          });
        }

        const response = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
          }
        });

        if (!response.ok) {
          return new Response(JSON.stringify({ error: `La tienda externa respondió con estado ${response.status}` }), {
            status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
          });
        }

        const html = await response.text();

        // Extracción de metadatos básicos de WooCommerce
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

        return new Response(JSON.stringify(productData), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: "Error en el servidor: " + err.message }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
    }

    // 2. Servir Assets estáticos o responder si no coincide con ninguna ruta
    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return new Response("Servicio activo. Accede a /admin para gestionar tu panel.", {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};
