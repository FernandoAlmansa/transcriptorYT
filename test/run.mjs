// Prueba el bookmarklet contra páginas que imitan youtube.com (con Trusted Types activado).
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const href = html.match(/<a id="bm"[^>]*?href="([^"]*)"/)[1];
const code = decodeURIComponent(href.replace(/^javascript:/, ''));

const CSP = "require-trusted-types-for 'script'; trusted-types default";
const VID = 'dQw4w9WgXcQ';

const segsJson = {
  actions: [{ updateEngagementPanelAction: { content: { transcriptRenderer: { content: { transcriptSearchPanelRenderer: { body: { transcriptSegmentListRenderer: { initialSegments: [
    { transcriptSegmentRenderer: { startMs: '0', endMs: '2500', snippet: { runs: [{ text: 'Hola a todos,' }] } } },
    { transcriptSegmentRenderer: { startMs: '2500', endMs: '6100', snippet: { runs: [{ text: 'hoy vemos ' }, { text: 'motores.' }] } } },
    { transcriptSectionHeaderRenderer: { snippet: { simpleText: 'Capítulo 1' } } },
    { transcriptSegmentRenderer: { startMs: '3725000', endMs: '3729000', snippet: { simpleText: 'Final\ncon salto' } } },
  ] } } } } } } } }],
};

const page = (opts) => `<!doctype html><html><head><title>(3) Video de prueba - YouTube</title></head><body>
<ytd-watch-metadata><h1>Video de prueba: "motores"</h1></ytd-watch-metadata>
<video class="html5-main-video"></video>
${opts.button ? `<ytd-video-description-transcript-section-renderer><button aria-label="Mostrar transcripción">Mostrar transcripción</button></ytd-video-description-transcript-section-renderer>
<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript"><div id="segs"></div></ytd-engagement-panel-section-list-renderer>` : ''}
<script>
  window.ytcfg = { d: { INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.20261110' } }, INNERTUBE_API_KEY: 'KEY', INNERTUBE_CONTEXT_CLIENT_NAME: 1, INNERTUBE_CLIENT_VERSION: '2.20261110' }, get(k) { return this.d[k]; } };
  window.ytInitialData = ${JSON.stringify(opts.initialData || {})};
  const v = document.querySelector('video'); let t = 0;
  Object.defineProperty(v, 'currentTime', { get: () => t, set: (x) => { t = x; v.dispatchEvent(new Event('timeupdate')); } });
  Object.defineProperty(v, 'paused', { get: () => true }); v.play = () => Promise.resolve();
  ${opts.button ? `document.querySelector('ytd-video-description-transcript-section-renderer button').addEventListener('click', () => {
    const data = [['0:00','Primer segmento'],['0:04','Segundo  segmento\\ncon salto'],['1:02:05','Tercero']];
    let i = 0; const box = document.getElementById('segs');
    const add = () => { if (i >= data.length) return; const [ts, tx] = data[i++];
      const s = document.createElement('ytd-transcript-segment-renderer');
      const a = document.createElement('div'); a.className = 'segment-timestamp'; a.textContent = ts;
      const b = document.createElement('yt-formatted-string'); b.className = 'segment-text'; b.textContent = tx;
      a.style.display = 'block'; b.style.display = 'block';
      s.append(a, b); box.append(s); setTimeout(add, 300); };
    setTimeout(add, 500);
  });` : ''}
</script></body></html>`;

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) failures++; };

async function scenario(name, { url, opts, api, watchHtml }) {
  console.log(`\n— ${name}`);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  let apiCalls = [];
  await p.route('https://www.youtube.com/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/youtubei/v1/get_transcript') {
      apiCalls.push({ body: route.request().postDataJSON(), headers: route.request().headers() });
      return api ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(api) })
                 : route.fulfill({ status: 400, body: '{}' });
    }
    if (u.pathname === '/watch' && route.request().resourceType() === 'fetch')
      return route.fulfill({ status: 200, contentType: 'text/html', body: watchHtml || '<html>sin transcript</html>' });
    return route.fulfill({ status: 200, contentType: 'text/html', headers: { 'content-security-policy': CSP }, body: page(opts) });
  });
  await p.goto(url);
  const tt = await p.evaluate(() => { try { document.body.innerHTML = '<b>x</b>'; return 'innerHTML permitido'; } catch (e) { return 'TT activo'; } });
  if (tt !== 'TT activo') throw new Error('El mock no aplica Trusted Types');
  await p.waitForTimeout(150); errs.length = 0;
  await p.evaluate(code);
  await p.waitForFunction(() => {
    const s = document.querySelector('#ytx-overlay')?.innerText || '';
    return /segmentos|No pude|Abrí un video/.test(s);
  }, null, { timeout: 20000 });
  const r = { p, errs, apiCalls, text: await p.locator('#ytx-overlay').innerText() };
  return r;
}

/* 1. API directa con ytInitialData del mismo video */
{
  const initialData = { currentVideoEndpoint: { watchEndpoint: { videoId: VID } },
    engagementPanels: [{ x: { getTranscriptEndpoint: { params: 'PARAMS_INIT' } } }] };
  const { p, errs, apiCalls, text } = await scenario('API (ytInitialData)', { url: `https://www.youtube.com/watch?v=${VID}`, opts: { initialData }, api: segsJson });
  check(/3 segmentos .* fuente: API$/m.test(text), `status: ${text.split('\n').find((l) => /segmentos/.test(l))}`);
  check(apiCalls[0]?.body.params === 'PARAMS_INIT', 'manda params de ytInitialData');
  check(apiCalls[0]?.headers['x-youtube-client-name'] === '1', 'header client-name');
  check(/Video de prueba: "motores"/.test(text), 'título');
  check(/hoy vemos motores\./.test(text) && /Final con salto/.test(text), 'textos limpios (runs unidos, \\n → espacio)');
  check(/1:02:05/.test(text), 'timestamp con horas');

  const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: '.srt' }).click()]);
  const srt = await readFile(await dl.path(), 'utf8');
  check(dl.suggestedFilename() === 'Video de prueba motores.srt', `nombre de archivo: ${dl.suggestedFilename()}`);
  check(srt.startsWith('1\n00:00:00,000 --> 00:00:02,500\nHola a todos,\n\n2\n00:00:02,500 --> 00:00:06,100'), 'SRT formato');
  check(/3\n01:02:05,000 --> 01:02:09,000\nFinal con salto/.test(srt), 'SRT con horas');

  const [dl2] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: '.txt' }).click()]);
  const txt = await readFile(await dl2.path(), 'utf8');
  check(txt === '[0:00] Hola a todos,\n[0:02] hoy vemos motores.\n[1:02:05] Final con salto', 'TXT con timestamps');

  await p.locator('#ytx-overlay input[type=checkbox]').uncheck();
  await p.getByRole('button', { name: 'Copiar' }).click();
  const clip = await p.evaluate(() => navigator.clipboard.readText());
  check(clip === 'Hola a todos, hoy vemos motores. Final con salto', `copiar sin timestamps: "${clip}"`);

  await p.locator('#ytx-overlay input[type=search]').fill('motor');
  const visible = await p.locator('#ytx-overlay span:visible').count();
  check(visible === 1, `búsqueda filtra (${visible} visible)`);
  check(/1 de 3 segmentos/.test(await p.locator('#ytx-overlay').innerText()), 'status de búsqueda');

  await p.locator('#ytx-overlay input[type=search]').fill('');
  await p.getByRole('button', { name: '0:02' }).click();
  const t = await p.evaluate(() => document.querySelector('video').currentTime);
  check(t === 2.5, `click en timestamp hace seek (${t})`);
  const hi = await p.evaluate(() => [...document.querySelectorAll('#ytx-overlay span')].find((s) => s.parentElement.style.background.includes('rgb(38, 56, 80)'))?.textContent);
  check(hi === 'hoy vemos motores.', `resalta el segmento actual (${hi})`);

  await p.keyboard.press('Escape');
  check(await p.locator('#ytx-overlay').count() === 0, 'Esc cierra');
  await p.evaluate(code);
  await p.waitForSelector('#ytx-overlay');
  await p.evaluate(code);
  check(await p.locator('#ytx-overlay').count() === 0, 'segundo clic al favorito cierra (toggle)');
  check(errs.length === 0, `sin errores de consola/Trusted Types ${errs.join(' | ')}`);
  await p.screenshot({ path: 'test/shot-api.png' });
  await p.close();
}

/* 2. Navegación SPA: ytInitialData de otro video → busca params en /watch */
{
  const initialData = { currentVideoEndpoint: { watchEndpoint: { videoId: 'OTROVIDEO00' } }, z: { getTranscriptEndpoint: { params: 'VIEJO' } } };
  const { apiCalls, text, errs, p } = await scenario('SPA (params desde /watch)', {
    url: `https://www.youtube.com/watch?v=${VID}&t=30s`, opts: { initialData }, api: segsJson,
    watchHtml: '<script>var ytInitialData = {"a":{"getTranscriptEndpoint":{"params":"PARAMS_FETCH"}}};</script>',
  });
  check(apiCalls[0]?.body.params === 'PARAMS_FETCH', `usa params frescos (${apiCalls[0]?.body.params})`);
  check(/fuente: API/.test(text), 'fuente API');
  check(errs.length === 0, 'sin errores');
  await p.close();
}

/* 3. API falla → panel del DOM */
{
  const initialData = { currentVideoEndpoint: { watchEndpoint: { videoId: VID } }, z: { getTranscriptEndpoint: { params: 'P' } } };
  const { text, errs, apiCalls, p } = await scenario('fallback al panel', { url: `https://www.youtube.com/watch?v=${VID}`, opts: { initialData, button: true }, api: null });
  check(apiCalls.length === 2, `probó API con y sin sesión (${apiCalls.length})`);
  check(/3 segmentos .* fuente: panel/.test(text), 'esperó a que cargue todo y usó el panel');
  check(/Segundo segmento con salto/.test(text), 'texto del DOM limpio');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: '.srt' }).click()]);
  const srt = await readFile(await dl.path(), 'utf8');
  check(/1\n00:00:00,000 --> 00:00:04,000\n/.test(srt) && /01:02:05,000 --> 01:02:09,000/.test(srt), 'SRT con fines calculados');
  check(errs.length === 0, `sin errores ${errs.join(' | ')}`);
  await p.screenshot({ path: 'test/shot-panel.png' });
  await p.close();
}

/* 4. Video sin transcripción */
{
  const { text, p } = await scenario('sin transcripción', { url: `https://www.youtube.com/watch?v=${VID}`, opts: {}, api: null });
  check(/No pude obtener la transcripción/.test(text), 'mensaje de error claro');
  await p.close();
}

/* 5. Shorts y página que no es video */
{
  const initialData = { currentVideoEndpoint: { watchEndpoint: { videoId: VID } }, z: { getTranscriptEndpoint: { params: 'P' } } };
  const { text, p } = await scenario('shorts', { url: `https://www.youtube.com/shorts/${VID}`, opts: { initialData }, api: segsJson });
  check(/fuente: API/.test(text), 'funciona en /shorts/');
  await p.close();
  const r = await scenario('home', { url: 'https://www.youtube.com/', opts: {}, api: null });
  check(/Abrí un video/.test(r.text), 'en la home pide abrir un video');
  await r.p.close();
}

await browser.close();
console.log(failures ? `\n${failures} fallas` : '\nTodo OK');
process.exit(failures ? 1 : 0);
