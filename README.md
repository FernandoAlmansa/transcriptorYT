# Transcriptor YT

Bookmarklet para sacar la transcripción de un video de YouTube: buscar, saltar a un momento, copiar y exportar `.txt` / `.srt`. Sin servidor ni API key; todo corre dentro de youtube.com.

## Publicar en GitHub Pages

1. Creá el repo (ej. `yt-transcriptor`) y subí estos archivos.
2. Settings → Pages → *Deploy from a branch* → `main` / `root`.
3. Queda en `https://fernandoalmansa.github.io/yt-transcriptor/`.

`index.html` ya trae el bookmarklet compilado, así que no hace falta build para publicar.

## Cambiar el bookmarklet

El código legible está en `src/bookmarklet.js`. Después de editarlo:

```bash
npm install
npm run build      # minifica e inyecta el href en index.html
```

## Cómo obtiene la transcripción

Prueba en este orden:

1. **API interna** `youtubei/v1/get_transcript` (mismo origen, con tu sesión). Saca los `params` de `ytInitialData` o, si navegaste dentro de YouTube sin recargar, de `/watch?v=…`. Trae inicio y fin exactos.
2. **La misma API sin cookies**, por si la sesión logueada da problemas.
3. **Panel "Mostrar transcripción"**: lo abre, espera a que termine de cargar y lee los segmentos del DOM. El fin de cada subtítulo se toma del inicio del siguiente.

Si algo deja de andar, el panel muestra qué falló en cada intento.

Detalle técnico: YouTube exige **Trusted Types**, así que el overlay se arma solo con `createElement` / `textContent` (nada de `innerHTML`).

## Tests

`test/run.mjs` levanta Chrome headless con Playwright contra páginas que imitan youtube.com, con Trusted Types activo. Cubre la API, la navegación SPA, el fallback al panel, un video sin transcripción, Shorts, SRT/TXT, copiar, búsqueda, seek y toggle.

```bash
npm i -D playwright && npx playwright install chromium
node test/run.mjs
```
