async function importFromCloudflare() {
  const url = document.getElementById('importUrl').value.trim();
  if(!url) return alert('Introduce un link válido');

  const btn = document.getElementById('btnImport');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Extrayendo catálogo...';

  try {
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    
    const rawText = await res.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      throw new Error(`Respuesta inválida del servidor: ${rawText.substring(0, 80)}`);
    }

    if(!res.ok || data.error) {
      throw new Error(data.error || 'Error desconocido en el servidor');
    }

    if (data.is_category) {
      if (!data.products || data.products.length === 0) {
        throw new Error("No se encontraron productos en esta categoría.");
      }
      data.products.forEach(p => {
        products.push({
          title: p.title,
          brand: p.brand,
          cat: p.category_guess || 'Calzado',
          price: p.price || 0,
          image: p.image || ''
        });
      });
      saveStorage();
      renderProducts();
      alert(`¡Se han importado ${data.products.length} productos de la categoría al inventario con éxito!`);
      document.getElementById('importResult').classList.remove('on');
    } else {
      currentScraped = data;
      document.getElementById('impTitle').textContent = data.title;
      document.getElementById('impMeta').textContent = `${data.brand} — ${data.price} €`;
      document.getElementById('impImg').src = data.image;
      document.getElementById('importResult').classList.add('on');
    }
  } catch(err) {
    alert('Error al importar: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Extraer datos desde Cloudflare';
  }
}
