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

    // Endpoint de scraping adaptado a Avviishop / WooCommerce
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

        // 1. Título del producto
        const titleMatch = html.match(/<h1[^>]*class="[^"]*product_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || 
                           html.match(/<meta property="og:title" content="([^"]+)"/i) ||
                           html.match(/<title>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').replace('– Avviishop', '').trim() : "Producto importado";

        // 2. Extracción precisa de Precio en WooCommerce (Prioriza el precio rebajado <ins> o el general)
        let price = 0;
        const priceRegexes = [
          /<ins>\s*<span class="woocommerce-Price-amount amount">[\s\S]*?([\d.,]+)\s*€/i,
          /<span class="woocommerce-Price-amount amount">[\s\S]*?([\d.,]+)\s*€/i,
          /<bdi>([\d.,]+)&nbsp;€<\/bdi>/i,
          /<bdi>([\d.,]+)\s*€<\/bdi>/i,
          /<meta property="product:price:amount" content="([^"]+)"/i,
          /itemprop="price"[^>]*content="([^"]+)"/i
        ];

        for (const rx of priceRegexes) {
          const match = html.match(rx);
          if (match && match[1]) {
            const cleanPrice = match[1].replace(/\./g, '').replace(',', '.').trim();
            const parsed = parseFloat(cleanPrice);
            if (!isNaN(parsed) && parsed > 0) {
              price = parsed;
              break;
            }
          }
        }

        // 3. Imagen principal en alta calidad
        const imageMatch = html.match(/data-large_image="([^"]+)"/i) || 
                           html.match(/wp-post-image"[^>]*src="([^"]+)"/i) ||
                           html.match(/<meta property="og:image" content="([^"]+)"/i);
        const image = imageMatch ? imageMatch[1] : "";

        // 4. Detección automática de Marca basada en el catálogo de Avviishop
        let brand = "Genérica";
        const lowerTitle = title.toLowerCase();
        if (lowerTitle.includes("nike") || lowerTitle.includes("air force") || lowerTitle.includes("dunk") || lowerTitle.includes("tn")) brand = "Nike";
        else if (lowerTitle.includes("adidas") || lowerTitle.includes("campus") || lowerTitle.includes("samba") || lowerTitle.includes("gazelle")) brand = "Adidas";
        else if (lowerTitle.includes("jordan") || lowerTitle.includes("retro")) brand = "Jordan";
        else if (lowerTitle.includes("new balance") || lowerTitle.includes("530") || lowerTitle.includes("2002")) brand = "New Balance";
        else if (lowerTitle.includes("balenciaga")) brand = "Balenciaga";
        else if (lowerTitle.includes("nocta")) brand = "Nocta";
        else if (lowerTitle.includes("syna")) brand = "Syna World";

        // 5. Categoría automática inteligente
        let category_guess = "Calzado";
        if (lowerTitle.includes("tracksuit") || lowerTitle.includes("chaqueta") || lowerTitle.includes("camiseta") || lowerTitle.includes("pantalon")) {
          category_guess = "Ropa";
        } else if (lowerTitle.includes("belt") || lowerTitle.includes("glasses") || lowerTitle.includes("wallet") || lowerTitle.includes("rolex")) {
          category_guess = "Accesorios";
        }

        const productData = {
          title,
          price,
          brand,
          image,
          sizes: ["38", "39", "40", "41", "42", "43", "44"],
          category_guess,
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

    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return new Response("Servicio activo. Accede a /admin para gestionar tu panel.", {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};
