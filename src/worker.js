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
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          }
        });

        if (!response.ok) {
          return new Response(JSON.stringify({ error: `La tienda respondió con estado ${response.status}` }), {
            status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
          });
        }

        const html = await response.text();

        // 1. TÍTULO
        const titleMatch = html.match(/<h1[^>]*class="[^"]*product_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || 
                           html.match(/<meta property="og:title" content="([^"]+)"/i) ||
                           html.match(/<title>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').replace(/–.*$/, '').trim() : "Producto importado";

        // 2. EXTRACCIÓN EXACTA DE PRECIO BASADA EN TU HALLAZGO (WooCommerce <ins> <bdi>)
        let price = 0;
        
        // Expresión regular ajustada al HTML exacto que encontraste
        const priceMatch = html.match(/<ins[^>]*>[\s\S]*?<span class="woocommerce-Price-amount amount">[\s\S]*?<bdi>\s*"?([\d.,]+)"?\s*</i) ||
                           html.match(/<span class="woocommerce-Price-amount amount">[\s\S]*?<bdi>\s*"?([\d.,]+)"?\s*</i) ||
                           html.match(/<bdi>\s*"?([\d.,]+)"?\s*<span class="woocommerce-Price-currencySymbol">€<\/span>/i);

        if (priceMatch && priceMatch[1]) {
          const cleanPrice = priceMatch[1].replace(/\./g, '').replace(',', '.').trim();
          price = parseFloat(cleanPrice) || 0;
        }

        // Si por alguna razón el precio sigue en 0, buscamos cualquier cantidad numérica seguida de €
        if (!price) {
          const fallbackMatch = html.match(/([\d]+[.,][\d]{2})\s*€/);
          if (fallbackMatch) {
            price = parseFloat(fallbackMatch[1].replace(',', '.')) || 0;
          }
        }

        // 3. IMAGEN PRINCIPAL
        const imageMatch = html.match(/data-large_image="([^"]+)"/i) || 
                           html.match(/wp-post-image"[^>]*src="([^"]+)"/i) ||
                           html.match(/<meta property="og:image" content="([^"]+)"/i);
        const image = imageMatch ? imageMatch[1] : "";

        // 4. MARCA AUTOMÁTICA
        let brand = "New Balance";
        const lowerTitle = title.toLowerCase();
        if (lowerTitle.includes("nike") || lowerTitle.includes("air force") || lowerTitle.includes("dunk")) brand = "Nike";
        else if (lowerTitle.includes("adidas") || lowerTitle.includes("campus") || lowerTitle.includes("samba")) brand = "Adidas";
        else if (lowerTitle.includes("jordan")) brand = "Jordan";
        else if (lowerTitle.includes("balenciaga")) brand = "Balenciaga";

        const productData = {
          title,
          price,
          brand,
          image,
          sizes: ["36", "37", "38", "39", "40", "41", "42", "43", "44", "45"],
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

    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return new Response("Servicio activo. Accede a /admin para gestionar tu panel.", {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};
