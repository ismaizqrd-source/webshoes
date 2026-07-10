# Resell Your Order — Setup desde cero

Repo listo para desplegar. Diseño y los 87 productos actuales se mantienen tal cual; lo que cambia es la infraestructura por debajo: todo vive en Cloudflare (web + checkout), sin depender de Netlify.

---

## PASO 1 — Repositorio de GitHub nuevo

1. Ve a **github.com/new**
2. Nombre: `resell-your-order` (o el que prefieras) → **Private**
3. No marques "Add README" (ya tienes uno)
4. Crea el repo, y en tu ordenador:
   ```bash
   cd resell-your-order        # esta carpeta que te he dado
   git init
   git add .
   git commit -m "Setup inicial"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/resell-your-order.git
   git push -u origin main
   ```

---

## PASO 2 — Proyecto de Cloudflare nuevo

1. **Cloudflare Dashboard → Workers & Pages → Create → Import a Git repository**
2. Conecta tu cuenta de GitHub si no lo está, selecciona el repo `resell-your-order`
3. Cloudflare detectará el `wrangler.toml` automáticamente. Si te pide configuración de build:
   - Build command: (déjalo vacío o `wrangler deploy` si te lo pide)
   - Deploy command: `npx wrangler deploy`
4. Dale a **Deploy**. En 1-2 minutos tendrás una URL tipo `resell-your-order.tuusuario.workers.dev` funcionando.

### Configura la clave de Stripe

**Settings → Variables and Secrets → Add variable**
- Nombre: `STRIPE_SECRET_KEY`
- Valor: tu clave `sk_live_...` (o `sk_test_...` para probar primero)
- Tipo: **Secret**
- Guarda y vuelve a desplegar (Deployments → Retry deployment, o simplemente vuelve a hacer push)

---

## PASO 3 — Conectar tu dominio (sin transferirlo desde Wix)

No necesitas mover el dominio de registrador. Dos formas, de más a menos recomendable:

**Opción A — Cambiar nameservers (recomendado, más simple de mantener):**
1. Cloudflare Dashboard → añade tu dominio como sitio (Cloudflare → Websites → Add a site) — esto es gratis, plan Free
2. Cloudflare te da 2 nameservers (tipo `xxx.ns.cloudflare.com`)
3. En Wix, ve a la gestión de dominios de esa web → DNS/Nameservers → cámbialos por los que te dio Cloudflare
4. Espera la propagación (puede tardar de minutos a 24h)
5. Una vez el dominio esté "activo" en Cloudflare, ve a tu Worker → **Settings → Domains & Routes → Add → Custom domain** → escribe tu dominio

**Opción B — Sin tocar nameservers (si Wix te deja gestionar DNS aparte):**
1. En el Worker → Settings → Domains & Routes → Add → Custom domain → te dará un registro CNAME
2. Añade ese CNAME en el panel de DNS de Wix apuntando a tu Worker
   (esto solo funciona si Wix te permite editar registros DNS sueltos sin mover nameservers — revísalo en su panel)

Si tienes dudas en este paso dímelo con capturas de lo que ves en Wix y te digo exactamente qué tocar.

---

## PASO 4 — Verifica que todo funciona

- Abre la URL de tu Worker (o tu dominio si ya está conectado)
- Añade un producto al carrito → paga → deberías llegar al Checkout real de Stripe
- Prueba primero con clave de test (`sk_test_...`) y tarjeta `4242 4242 4242 4242` antes de poner la clave live

---

## PASO 5 — Panel de administración

Ya no cambia nada de lo que te di antes: abre `admin.html`, pega un token de GitHub con acceso al **repo nuevo**, y listo. Solo tienes que actualizar en el panel el campo "Repositorio" (Configuración avanzada) al nombre que le hayas puesto si no es exactamente `resell-your-order`, y el "Propietario" a tu usuario de GitHub real.

## PASO 6 — Importador de Nike/JD

Sin cambios, sigue funcionando igual (`nike_jd_importer.py`), es independiente del hosting.

---

## Qué me falta saber para ayudarte más rápido si algo falla

- Tu usuario de GitHub (para que te dé comandos exactos, no genéricos)
- Screenshot de cualquier pantalla de Cloudflare o Wix donde te atasques — así te digo el botón exacto en vez de ir a ciegas
