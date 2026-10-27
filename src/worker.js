import { handleScrape } from "../functions/api/scrape.js";
import { handleProducts } from "../functions/api/products.js";
import { handleImages, handleImageProxy } from "../functions/api/images.js";
import { handleDiscounts } from "../functions/api/discounts.js";
import { handleSettings } from "../functions/api/settings.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-key",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS"
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (path === "/api/scrape" && request.method === "POST") {
      return handleScrape(request);
    }

    if (path === "/api/products" || path.startsWith("/api/products/")) {
      return handleProducts(request, env);
    }

    if (path === "/api/img-proxy") {
      return handleImageProxy(request, env);
    }

    if (path === "/api/img" || path.startsWith("/api/img/")) {
      return handleImages(request, env);
    }

    if (path === "/api/settings") {
      return handleSettings(request, env);
    }

    if (path === "/api/discounts") {
      return handleDiscounts(request, env);
    }

    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return new Response("Servicio activo.", {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};
