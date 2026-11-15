// Minifica src/bookmarklet.js y lo inyecta como href del botón #bm en index.html.
// Uso: npm install && npm run build
import { readFile, writeFile } from 'node:fs/promises';
import { minify } from 'terser';

const src = await readFile(new URL('./src/bookmarklet.js', import.meta.url), 'utf8');
const { code } = await minify(src, {
  ecma: 2020,
  compress: { passes: 2 },
  mangle: true,
  format: { comments: false },
});

const href = 'javascript:' + encodeURIComponent(code);
const htmlPath = new URL('./index.html', import.meta.url);
const html = await readFile(htmlPath, 'utf8');
const re = /(<a id="bm"[^>]*?href=")[^"]*(")/;
if (!re.test(html)) throw new Error('No encontré <a id="bm" href="…"> en index.html');
await writeFile(htmlPath, html.replace(re, (_, a, b) => a + href + b));
console.log(`Bookmarklet: ${code.length} bytes minificado, ${href.length} bytes como URL.`);
