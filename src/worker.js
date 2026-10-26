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

    // Endpoint de scraping completo
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
          return new Response(JSON.stringify({ error: `La tienda respondió con estado ${response.status}` }), {
            status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
          });
        }

        const html = await response.text();

        // 1. Título
        const titleMatch = html.match(/<h1[^>]*class="[^"]*product_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || 
                           html.match(/<meta property="og:title" content="([^"]+)"/i);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : "Producto importado";

        // 2. Precio (búsqueda mejorada para etiquetas ins, bdi, WooCommerce y OpenGraph)
        let price = 0;
        const priceMatch = html.match(/<ins>[\s\S]*?<bdi>([\d.,]+)&nbsp;€<\/bdi>/i) ||
                           html.match(/<bdi>([\d.,]+)&nbsp;€<\/bdi>/i) ||
                           html.match(/<bdi>([\d.,]+)\s*€<\/bdi>/i) ||
                           html.match(/woocommerce-Price-amount amount">[\s\S]*?([\d.,]+)/i) ||
                           html.match(/<meta property="product:price:amount" content="([^"]+)"/i) ||
                           html.match(/itemprop="price"[^>]*content="([^"]+)"/i);

        if (priceMatch) {
          const rawPrice = priceMatch[1].replace(/\./g, '').replace(',', '.').trim();
          price = parseFloat(rawPrice) || 0;
        }

        // 3. Imagen principal
        const imageMatch = html.match(/data-large_image="([^"]+)"/i) || 
                           html.match(/<meta property="og:image" content="([^"]+)"/i);
        const image = imageMatch ? imageMatch[1] : "";

        // 4. Marca inteligente
        let brand = "New Balance";
        if (title.toLowerCase().includes("nike")) brand = "Nike";
        if (title.toLowerCase().includes("adidas")) brand = "Adidas";
        if (title.toLowerCase().includes("jordan")) brand = "Jordan";
        if (title.toLowerCase().includes("asics")) brand = "Asics";

        // 5. Extracción de Tallas
        const foundSizes = new Set();
        const sizeMatches = html.match(/>\s*(3[5-9]|4[0-8](\.\d)?)\s*</g);
        if (sizeMatches) {
          sizeMatches.forEach(s => foundSizes.add(s.replace(/[<>]/g, '').trim()));
        }

        const productData = {
          title,
          price,
          brand,
          image,
          sizes: Array.from(foundSizes).sort(),
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

    // Servir assets estáticos de Cloudflare
    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return new Response("Servicio activo. Accede a /admin para gestionar tu panel.", {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};
