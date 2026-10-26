export async function onRequestPost(context) {
  const { request } = context;
  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };

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

    // Detección automática por contenido HTML (infalible para WooCommerce)
    const productBlocks = html.split(/<(li|div|article)[^>]*class="[^"]*\bproduct\b[^"]*"/gi);
    const hasLoopTitle = html.includes("woocommerce-loop-product__title");
    const isCategory = productBlocks.length > 3 || hasLoopTitle || targetUrl.includes("categoria-producto") || targetUrl.includes("shop");

    if (isCategory) {
      const productsMap = new Map();
      
      for (let i = 1; i < productBlocks.length; i++) {
        const block = productBlocks[i];
        
        const tMatch = block.match(/<h[23][^>]*class="[^"]*woocommerce-loop-product__title[^"]*">([\s\S]*?)<\/h[23]>/i) ||
                       block.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i) ||
                       block.match(/class="[^"]*woocommerce-LoopProduct-link[^"]*">([\s\S]*?)<\/a>/i);
        const rawTitle = tMatch ? tMatch[1].replace(/<[^>]*>/g, '').trim() : "";
        if (!rawTitle || rawTitle.length < 2) continue;

        let price = 68.99;
        const pMatch = block.match(/<ins[^>]*>[\s\S]*?<bdi>\s*"?([\d.,]+)"?\s*</i) ||
                       block.match(/<span class="woocommerce-Price-amount amount">[\s\S]*?<bdi>\s*"?([\d.,]+)"?\s*</i) ||
                       block.match(/<bdi>\s*"?([\d.,]+)"?\s*</i);
        if (pMatch && pMatch[1]) {
          price = parseFloat(pMatch[1].replace(/\./g, '').replace(',', '.')) || 68.99;
        }

        const imgMatch = block.match(/data-lazy-src="([^"]+)"/i) ||
                         block.match(/data-src="([^"]+)"/i) ||
                         block.match(/src="([^"]+)"/i);
        let image = imgMatch ? imgMatch[1] : "";
        if (image && !image.startsWith('http')) image = '';

        let brand = "New Balance";
        const lower = rawTitle.toLowerCase();
        if (lower.includes("nike") || lower.includes("dunk") || lower.includes("force")) brand = "Nike";
        else if (lower.includes("adidas") || lower.includes("campus") || lower.includes("samba")) brand = "Adidas";
        else if (lower.includes("jordan")) brand = "Jordan";
        else if (lower.includes("balenciaga")) brand = "Balenciaga";

        if (!productsMap.has(rawTitle)) {
          productsMap.set(rawTitle, {
            title: rawTitle,
            price: price,
            brand: brand,
            image: image,
            sizes: ["36", "37", "38", "39", "40", "41", "42", "43", "44", "45"],
            category_guess: "Calzado",
            source_url: targetUrl
          });
        }
      }

      const scrapedList = Array.from(productsMap.values());

      if (scrapedList.length > 0) {
        return new Response(JSON.stringify({
          is_category: true,
          count: scrapedList.length,
          products: scrapedList
        }), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
    }

    // Producto individual (respaldo)
    const titleMatch = html.match(/<h1[^>]*class="[^"]*product_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || 
                       html.match(/<meta property="og:title" content="([^"]+)"/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').replace(/–.*$/, '').trim() : "Producto importado";

    let price = 68.99;
    const priceMatch = html.match(/<ins[^>]*>[\s\S]*?<bdi>\s*"?([\d.,]+)"?\s*</i) ||
                       html.match(/<span class="woocommerce-Price-amount amount">[\s\S]*?<bdi>\s*"?([\d.,]+)"?\s*</i);
    if (priceMatch && priceMatch[1]) {
      price = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.')) || 68.99;
    }

    const imageMatch = html.match(/data-large_image="([^"]+)"/i) || 
                       html.match(/wp-post-image"[^>]*src="([^"]+)"/i) ||
                       html.match(/<meta property="og:image" content="([^"]+)"/i);
    const image = imageMatch ? imageMatch[1] : "";

    let brand = "New Balance";
    const lowerTitle = title.toLowerCase();
    if (lowerTitle.includes("nike")) brand = "Nike";
    else if (lowerTitle.includes("adidas")) brand = "Adidas";
    else if (lowerTitle.includes("jordan")) brand = "Jordan";

    const productData = {
      is_category: false,
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

export async function onRequestOptions() {
  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
  return new Response(null, { headers: CORS_HEADERS });
}
