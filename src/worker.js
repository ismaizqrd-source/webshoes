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
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
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
        let title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').replace(/–.*$/, '').trim() : "Producto importado";

        // 2. EXTRACCIÓN DE PRECIO (Estrategia Multicapa)
        let price = 0;

        // Capa A: Buscar en JSON de variaciones WooCommerce (data-product_variations)
        const variationsMatch = html.match(/data-product_variations="([^"]+)"/i);
        if (variationsMatch) {
          try {
            const decodedJson = variationsMatch[1].replace(/&quot;/g, '"');
            const varsData = JSON.parse(decodedJson);
            if (Array.isArray(varsData) && varsData.length > 0) {
              price = parseFloat(varsData[0].display_price || varsData[0].display_regular_price) || 0;
            }
          } catch(e) {}
        }

        // Capa B: Buscar en JSON-LD (Schema.org / WooCommerce)
        if (!price) {
          const jsonLdMatches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
          if (jsonLdMatches) {
            for (const scriptStr of jsonLdMatches) {
              try {
                const cleanJson = scriptStr.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
                const parsed = JSON.parse(cleanJson);
                const items = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
                for (const item of items) {
                  if (item.offers) {
                    const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
                    if (offer.price) {
                      price = parseFloat(offer.price);
                      break;
                    }
                  }
                }
              } catch(e) {}
              if (price) break;
            }
          }
        }

        // Capa C: Buscar etiquetas HTML comunes de WooCommerce (<ins>, <bdi>, amount)
        if (!price) {
          const priceRegexes = [
            /<ins>[\s\S]*?<bdi>([\d.,]+)/i,
            /<span class="[^\"]*amount[^\"]*">[\s\S]*?<bdi>([\d.,]+)/i,
            /<bdi>([\d.,]+)/i,
            /class="price"[^>]*>[\s\S]*?([\d.,]+)\s*€/i,
            /property="product:price:amount" content="([^"]+)"/i,
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
        }

        // 3. IMAGEN
        const imageMatch = html.match(/data-large_image="([^"]+)"/i) || 
                           html.match(/wp-post-image"[^>]*src="([^"]+)"/i) ||
                           html.match(/<meta property="og:image" content="([^"]+)"/i);
        const image = imageMatch ? imageMatch[1] : "";

        // 4. MARCA Y CATEGORÍA
        let brand = "New Balance";
        const lowerTitle = title.toLowerCase();
        if (lowerTitle.includes("nike")) brand = "Nike";
        else if (lowerTitle.includes("adidas")) brand = "Adidas";
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
