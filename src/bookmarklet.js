/*
 * Transcriptor YT — bookmarklet
 * Corre dentro de youtube.com (tu IP, tu sesión). Estrategias, en orden:
 *   1. API interna de YouTube (youtubei/v1/get_transcript), mismo origen → trae inicio y fin exactos.
 *   2. Lo mismo sin cookies (por si la sesión logueada molesta).
 *   3. Abre el panel "Mostrar transcripción" y lee el DOM.
 * Todo el DOM se arma con createElement/textContent: YouTube exige Trusted Types,
 * así que innerHTML está prohibido.
 */
(() => {
  const ID = 'ytx-overlay';
  const prev = document.getElementById(ID);
  if (prev) { prev.__ytxClose ? prev.__ytxClose() : prev.remove(); return; }

  if (!/(^|\.)youtube\.com$/.test(location.hostname)) {
    alert('Transcriptor YT: abrí un video en youtube.com y tocá el favorito ahí.');
    return;
  }

  /* ---------- utilidades ---------- */
  const q = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => Array.from(r.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();

  const getVideoId = () => {
    const u = new URL(location.href);
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/);
    return m ? m[1] : null;
  };

  const getTitle = () =>
    clean(
      (q('ytd-watch-metadata h1') || {}).textContent ||
        document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, '')
    ) || 'transcripcion';

  const parseTs = (s) =>
    String(s).split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);

  const fmtTs = (sec) => {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  };

  const fmtSrt = (sec) => {
    const ms = Math.max(0, Math.round(sec * 1000));
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
  };

  const walk = (o, fn) => {
    if (!o || typeof o !== 'object') return;
    fn(o);
    for (const k in o) walk(o[k], fn);
  };

  const runsText = (x) =>
    !x ? '' : x.simpleText != null ? x.simpleText : (x.runs || []).map((r) => r.text).join('');

  /* Completa los "end" que faltan (el DOM solo da inicios). */
  const finish = (segs) => {
    segs = segs.filter((s) => s.text && isFinite(s.start)).sort((a, b) => a.start - b.start);
    segs.forEach((s, i) => {
      if (!(s.end > s.start)) s.end = segs[i + 1] ? segs[i + 1].start : s.start + 4;
    });
    return segs;
  };

  /* ---------- estrategia 1/2: API interna ---------- */
  const authHeaders = async () => {
    const c = document.cookie.match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/);
    if (!c || !crypto.subtle) return {};
    const ts = Math.floor(Date.now() / 1000);
    const buf = await crypto.subtle.digest(
      'SHA-1',
      new TextEncoder().encode(`${ts} ${c[1]} ${location.origin}`)
    );
    const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    return {
      Authorization: `SAPISIDHASH ${ts}_${hex}`,
      'X-Origin': location.origin,
      'X-Goog-AuthUser': '0',
    };
  };

  const findParams = async (vid) => {
    const init = window.ytInitialData;
    const sameVideo =
      init && init.currentVideoEndpoint &&
      init.currentVideoEndpoint.watchEndpoint &&
      init.currentVideoEndpoint.watchEndpoint.videoId === vid;
    let params = null;
    if (sameVideo) {
      walk(init, (o) => {
        if (!params && o.getTranscriptEndpoint && o.getTranscriptEndpoint.params)
          params = o.getTranscriptEndpoint.params;
      });
    }
    if (params) return params;
    /* Navegación SPA: ytInitialData quedó viejo → pido la página del video (mismo origen). */
    const html = await (await fetch(`/watch?v=${vid}`, { credentials: 'include' })).text();
    const m = html.match(/"getTranscriptEndpoint":\{"params":"([^"]+)"/);
    if (!m) throw new Error('este video no ofrece transcripción');
    return m[1];
  };

  const viaApi = async (vid, withCookies) => {
    const cfg = window.ytcfg && window.ytcfg.get ? window.ytcfg : null;
    const ctx = cfg && cfg.get('INNERTUBE_CONTEXT');
    if (!ctx) throw new Error('no encontré la config de YouTube (ytcfg)');
    const params = await findParams(vid);
    const key = cfg.get('INNERTUBE_API_KEY');
    const headers = {
      'Content-Type': 'application/json',
      'X-Youtube-Client-Name': String(cfg.get('INNERTUBE_CONTEXT_CLIENT_NAME') || 1),
      'X-Youtube-Client-Version': String(
        cfg.get('INNERTUBE_CLIENT_VERSION') || (ctx.client && ctx.client.clientVersion) || ''
      ),
      ...(withCookies ? await authHeaders() : {}),
    };
    const res = await fetch(
      `/youtubei/v1/get_transcript?prettyPrint=false${key ? `&key=${key}` : ''}`,
      {
        method: 'POST',
        credentials: withCookies ? 'include' : 'omit',
        headers,
        body: JSON.stringify({ context: ctx, params }),
      }
    );
    if (!res.ok) throw new Error(`get_transcript HTTP ${res.status}`);
    const json = await res.json();
    const segs = [];
    walk(json, (o) => {
      const s = o.transcriptSegmentRenderer;
      if (s) segs.push({ start: +s.startMs / 1000, end: +s.endMs / 1000, text: clean(runsText(s.snippet)) });
    });
    if (!segs.length) throw new Error('la API respondió sin segmentos');
    return finish(segs);
  };

  /* ---------- estrategia 3: panel "Mostrar transcripción" ---------- */
  const SEG_SEL = [
    'ytd-transcript-segment-renderer',
    'transcript-segment-view-model',
    '[class*="transcript-segment"]',
  ].join(',');

  const segNodes = () => {
    const nodes = qa(SEG_SEL).filter((n) => !n.closest(`#${ID}`));
    /* Si un selector genérico agarró hijos de otro segmento, me quedo con el de afuera. */
    return nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)));
  };

  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    let last = [];
    let stableSince = 0;
    while (Date.now() - t0 < ms) {
      const r = fn();
      if (r.length) {
        if (r.length === last.length) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince > 600) return r; /* dejó de crecer */
        } else stableSince = 0;
        last = r;
      }
      await sleep(150);
    }
    return last;
  };

  const viaDom = async () => {
    let nodes = segNodes();
    if (!nodes.length) {
      const expand = q('#description-inline-expander #expand, ytd-text-inline-expander #expand');
      if (expand) { expand.click(); await sleep(400); }
      const btn =
        q('ytd-video-description-transcript-section-renderer button') ||
        qa('button, yt-button-shape button, tp-yt-paper-item').find(
          (b) =>
            !b.closest(`#${ID}`) &&
            /transcri/i.test(`${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`)
        );
      if (btn) btn.click();
      else {
        const panel = q('ytd-engagement-panel-section-list-renderer[target-id*="transcript"]');
        if (panel) panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
        else throw new Error('no encontré el botón "Mostrar transcripción"');
      }
      nodes = await waitFor(segNodes, 12000);
    }
    const segs = [];
    for (const n of nodes) {
      const raw = (n.innerText || n.textContent || '').trim();
      const m = raw.match(/^(\d{1,2}(?::\d{2}){1,2})\s+([\s\S]+)$/);
      if (m) segs.push({ start: parseTs(m[1]), text: clean(m[2]) });
    }
    if (!segs.length) throw new Error('el panel no mostró segmentos');
    return finish(segs);
  };

  /* ---------- UI ---------- */
  const C = {
    bg: '#0f0f0f', panel: '#1b1b1b', line: '#2e2e2e', text: '#f1f1f1',
    dim: '#aaaaaa', accent: '#3ea6ff', hi: '#263850', red: '#ff4e45',
  };

  const el = (tag, style, props, kids) => {
    const e = document.createElement(tag);
    if (style) Object.assign(e.style, style);
    if (props) for (const k in props) {
      if (k.startsWith('on')) e.addEventListener(k.slice(2), props[k]);
      else e[k] = props[k];
    }
    (kids || []).forEach((k) => k && e.append(k));
    return e;
  };

  const btnStyle = {
    background: C.panel, color: C.text, border: `1px solid ${C.line}`, borderRadius: '18px',
    padding: '6px 12px', font: '500 12px Roboto,Arial,sans-serif', cursor: 'pointer',
  };

  const video = q('video.html5-main-video') || q('video');
  const vid = getVideoId();
  const title = getTitle();
  let segs = [];
  let rows = [];
  let withTs = true;

  const status = el('div', { color: C.dim, font: '12px Roboto,Arial,sans-serif', padding: '0 16px 8px' }, {
    textContent: 'Buscando transcripción…',
  });
  const list = el('div', { overflowY: 'auto', flex: '1', padding: '0 8px 12px' });
  const search = el('input', {
    flex: '1', minWidth: '0', background: C.bg, color: C.text, border: `1px solid ${C.line}`,
    borderRadius: '18px', padding: '7px 12px', font: '13px Roboto,Arial,sans-serif', outline: 'none',
  }, { type: 'search', placeholder: 'Buscar en la transcripción', oninput: () => filter() });

  const asText = () =>
    withTs
      ? segs.map((s) => `[${fmtTs(s.start)}] ${s.text}`).join('\n')
      : segs.map((s) => s.text).join(' ').replace(/\s+/g, ' ');

  const asSrt = () =>
    segs.map((s, i) => `${i + 1}\n${fmtSrt(s.start)} --> ${fmtSrt(s.end)}\n${s.text}\n`).join('\n');

  const fileBase = () => title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 90).trim() || 'transcripcion';

  const download = (content, ext, mime) => {
    const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
    const a = el('a', null, { href: url, download: `${fileBase()}.${ext}` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const flash = (b, txt) => {
    const o = b.textContent;
    b.textContent = txt;
    setTimeout(() => { b.textContent = o; }, 1400);
  };

  const copy = async (b) => {
    const t = asText();
    try {
      await navigator.clipboard.writeText(t);
    } catch (e) {
      const ta = el('textarea', { position: 'fixed', opacity: '0' }, { value: t });
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    flash(b, '¡Copiado!');
  };

  const needSegs = (fn) => (ev) => { if (segs.length) fn(ev.currentTarget); };

  const bCopy = el('button', btnStyle, { textContent: 'Copiar', onclick: needSegs((b) => copy(b)) });
  const bTxt = el('button', btnStyle, { textContent: '.txt', onclick: needSegs(() => download(asText(), 'txt', 'text/plain')) });
  const bSrt = el('button', btnStyle, { textContent: '.srt', onclick: needSegs(() => download(asSrt(), 'srt', 'application/x-subrip')) });
  const tsBox = el('input', { accentColor: C.accent, margin: '0' }, {
    type: 'checkbox', checked: true,
    onchange: (e) => { withTs = e.target.checked; },
  });
  const tsLabel = el('label', {
    display: 'flex', alignItems: 'center', gap: '6px', color: C.dim,
    font: '12px Roboto,Arial,sans-serif', cursor: 'pointer', marginRight: 'auto',
  }, null, [tsBox, document.createTextNode('Timestamps al copiar/.txt')]);

  const close = () => {
    if (video) video.removeEventListener('timeupdate', onTime);
    document.removeEventListener('keydown', onKey, true);
    root.remove();
  };

  const header = el('div', { display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '14px 16px 6px' }, null, [
    el('div', { flex: '1', minWidth: '0' }, null, [
      el('div', { font: '700 15px Roboto,Arial,sans-serif', color: C.text }, { textContent: '📝 Transcripción' }),
      el('div', {
        font: '12px Roboto,Arial,sans-serif', color: C.dim, whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis', marginTop: '2px',
      }, { textContent: title, title }),
    ]),
    el('button', { ...btnStyle, padding: '2px 10px', fontSize: '16px', borderRadius: '50%' }, {
      textContent: '×', title: 'Cerrar (Esc)', onclick: close,
    }),
  ]);

  const root = el('div', {
    position: 'fixed', top: '72px', right: '16px', bottom: '16px', width: '400px',
    maxWidth: 'calc(100vw - 32px)', zIndex: '2147483647', background: C.bg, color: C.text,
    border: `1px solid ${C.line}`, borderRadius: '14px', boxShadow: '0 12px 40px rgba(0,0,0,.55)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  }, { id: ID }, [
    header,
    el('div', { display: 'flex', gap: '8px', padding: '6px 16px' }, null, [search]),
    el('div', { display: 'flex', gap: '6px', alignItems: 'center', padding: '4px 16px 10px', flexWrap: 'wrap' }, null, [
      tsLabel, bCopy, bTxt, bSrt,
    ]),
    status,
    list,
  ]);
  root.__ytxClose = close;

  const seek = (t) => {
    if (!video) return;
    video.currentTime = t;
    if (video.paused) video.play().catch(() => {});
  };

  const render = () => {
    list.textContent = '';
    rows = segs.map((s) => {
      const r = el('div', {
        display: 'flex', gap: '10px', padding: '6px 8px', borderRadius: '8px',
        font: '14px/1.45 Roboto,Arial,sans-serif',
      }, null, [
        el('button', {
          background: 'none', border: 'none', color: C.accent, cursor: 'pointer', padding: '0',
          font: '500 12px/1.9 Roboto,Arial,sans-serif', minWidth: '44px', textAlign: 'left',
          fontVariantNumeric: 'tabular-nums',
        }, { textContent: fmtTs(s.start), title: 'Ir a este momento', onclick: () => seek(s.start) }),
        el('span', { color: C.text }, { textContent: s.text }),
      ]);
      r.__seg = s;
      r.__txt = s.text.toLowerCase();
      list.append(r);
      return r;
    });
  };

  const filter = () => {
    const t = search.value.trim().toLowerCase();
    let n = 0;
    rows.forEach((r) => {
      const ok = !t || r.__txt.includes(t);
      r.style.display = ok ? 'flex' : 'none';
      if (ok) n++;
    });
    if (segs.length) status.textContent = t ? `${n} de ${segs.length} segmentos` : status.__base;
  };

  let current = null;
  const onTime = () => {
    const t = video.currentTime;
    const r = rows.find((x) => t >= x.__seg.start && t < x.__seg.end);
    if (r === current) return;
    if (current) current.style.background = 'transparent';
    if (r) r.style.background = C.hi;
    current = r;
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (root.contains(e.target)) e.stopPropagation(); /* que no se disparen atajos de YouTube al tipear */
  };

  document.body.append(root);
  document.addEventListener('keydown', onKey, true);

  /* ---------- main ---------- */
  (async () => {
    if (!vid) {
      status.textContent = 'Abrí un video (youtube.com/watch?v=…) y volvé a tocar el favorito.';
      status.style.color = C.red;
      return;
    }
    const errors = [];
    const tries = [
      ['API', () => viaApi(vid, true)],
      ['API (sin sesión)', () => viaApi(vid, false)],
      ['panel', () => viaDom()],
    ];
    for (const [name, fn] of tries) {
      try {
        segs = await fn();
        status.__base = `${segs.length} segmentos · ${fmtTs(segs[segs.length - 1].end)} · fuente: ${name}`;
        status.textContent = status.__base;
        render();
        if (video) video.addEventListener('timeupdate', onTime);
        return;
      } catch (e) {
        errors.push(`${name}: ${e.message}`);
      }
    }
    status.style.color = C.red;
    status.textContent = 'No pude obtener la transcripción. ' +
      'Fijate que el video tenga subtítulos (aunque sean automáticos). Detalle → ' + errors.join(' | ');
  })();
})();
void 0;
