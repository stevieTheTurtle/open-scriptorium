// The PDF tab's page: renders with PDF.js and talks to the extension through messages.
import * as pdfjsLib from 'pdfjs-entry';

const vscode = acquireVsCodeApi();
const config = JSON.parse(document.getElementById('config').textContent);

const dom = Object.fromEntries(
  [
    'viewer',
    'empty',
    'prev',
    'next',
    'page',
    'total',
    'zoom',
    'zoom-in',
    'zoom-out',
    'fit',
    'message',
    'compile-status',
    'compile-bar',
    'auto-compile',
    'to-code',
    'compile',
    'toggle-outline',
    'outline-panel',
    'outline-resizer',
    'outline-tree',
    'outline-close',
    'toggle-find',
    'find-bar',
    'find-input',
    'find-count',
    'find-case',
    'find-prev',
    'find-next',
    'find-close',
    'selection-action',
    'pdf-context-menu',
    'ctx-find-citation',
    'ctx-copy-selection',
  ].map((id) => [id, document.getElementById(id)]),
);

const saved = vscode.getState() ?? {};
const view = {
  zoom: saved.zoom ?? 100, // percent of the width that fits the pane
  scale: 1,
  pages: [], // { num, page, width, height, div, canvas, textDiv, rendered, rendering, task, textContent, plainText }
  generation: 0,
  document: null,
  pageNumber: 1,
  latestLoad: 0,
  needsLayout: false,
  deferredAnchor: null,
  outlineOpen: Boolean(saved.outlineOpen),
  outlineWidth: Number.isFinite(saved.outlineWidth) ? saved.outlineWidth : 240,
};
let pendingAnchor = saved.anchor ?? null;

const RENDER_MARGIN_PX = 800;
const EVICT_MARGIN_PX = 5000;
const MIN_ZOOM = 30;
const MAX_ZOOM = 300;
const MAX_CONCURRENT_RENDERS = 3;

let activeRenders = 0;
const renderWaiters = new Map(); // pageNum -> Array<() => void>

// ---- Loading --------------------------------------------------------------------------------

// Webviews can only start workers from blob: or data: URIs, so the worker source is fetched once
// and wrapped. Each document gets its own worker: a recompile opens the new PDF before the old
// one is destroyed, and destroying a document also shuts down its PDFWorker.
let workerBlobUrl = null;
async function createWorker() {
  if (!workerBlobUrl) {
    const response = await fetch(config.workerUrl);
    if (!response.ok) throw new Error(`could not load the PDF worker (HTTP ${response.status})`);
    workerBlobUrl = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
  }
  return new Worker(workerBlobUrl, { type: 'module' });
}

async function openDocument(data) {
  const rawWorker = await createWorker();
  const pdfWorker = new pdfjsLib.PDFWorker({ port: rawWorker });
  const task = pdfjsLib.getDocument({
    data,
    worker: pdfWorker,
    isEvalSupported: false,
    wasmUrl: config.wasmUrl,
    iccUrl: config.iccUrl,
    standardFontDataUrl: config.standardFontDataUrl,
    cMapUrl: config.cMapUrl,
    cMapPacked: true,
  });
  const close = async () => {
    await task.destroy().catch(() => undefined);
    pdfWorker.destroy();
    rawWorker.terminate();
  };
  try {
    return { doc: await task.promise, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function isViewerVisible() {
  return dom.viewer.clientWidth > 0 && dom.viewer.clientHeight > 0;
}

async function loadPdf(data) {
  const loadId = ++view.latestLoad;
  const anchor = pendingAnchor ?? view.deferredAnchor ?? currentAnchor();
  pendingAnchor = null;

  let opened;
  try {
    opened = await openDocument(data);
  } catch (error) {
    if (loadId === view.latestLoad) {
      setMessage('Could not load the PDF');
      vscode.postMessage({ type: 'loadFailed', message: String(error?.message ?? error) });
    }
    return;
  }

  const pages = [];
  for (let num = 1; num <= opened.doc.numPages; num++) {
    const page = await opened.doc.getPage(num);
    const viewport = page.getViewport({ scale: 1 });
    pages.push({ num, page, width: viewport.width, height: viewport.height, rendered: false, rendering: false });
  }
  if (loadId !== view.latestLoad) {
    await opened.close();
    return;
  }

  // Cancel any in-flight page renders cleanly before replacing DOM shells.
  for (const p of view.pages) {
    try {
      p.task?.cancel();
    } catch {
      // Ignore already-finished tasks
    }
  }
  renderWaiters.clear();

  // Old canvases stay in the new page shells as placeholders until fresh ones are painted,
  // avoiding a white flash during rebuilds.
  const fragment = document.createDocumentFragment();
  for (const p of pages) {
    p.div = document.createElement('div');
    p.div.className = 'pdf-page';
    p.div.dataset.page = String(p.num);
    const previous = view.pages[p.num - 1];
    if (previous?.canvas && previous.rendered && previous.width === p.width && previous.height === p.height) {
      p.canvas = previous.canvas;
      p.div.appendChild(p.canvas);
    }
    fragment.appendChild(p.div);
  }

  const previousDocument = view.document;
  view.document = opened;
  view.pages = pages;
  view.generation++;
  dom.viewer.replaceChildren(fragment);
  dom.empty.hidden = true;
  if (previousDocument) void previousDocument.close();

  dom.total.textContent = `/ ${pages.length}`;
  dom.page.max = String(pages.length);

  if (isViewerVisible()) {
    view.needsLayout = false;
    view.deferredAnchor = null;
    applyScale();
    restoreAnchor(anchor);
    renderVisiblePages();
    // Run once more on next animation frame after layout metrics are guaranteed flushed.
    requestAnimationFrame(() => {
      if (loadId === view.latestLoad && isViewerVisible()) renderVisiblePages();
    });
    updatePageIndicator();
  } else {
    // Tab is currently hidden (0x0 viewport): defer scale & rendering until visible so we
    // never compute NaN scroll anchors or spawn renders for all 77 pages simultaneously.
    view.needsLayout = true;
    view.deferredAnchor = anchor;
  }

  setMessage('');
  void loadOutline(opened.doc, loadId);
  if (findState.open && findState.query) {
    void runFind(findState.query, { preserveIndex: true });
  } else {
    clearFindHighlights();
  }
  vscode.postMessage({ type: 'loaded', numPages: pages.length });
}

// ---- Layout and rendering -------------------------------------------------------------------

function computeScale() {
  if (!view.pages.length) return 1;
  const widest = Math.max(...view.pages.map((p) => p.width));
  const available = Math.max(200, dom.viewer.clientWidth - 28);
  return (available / widest) * (view.zoom / 100);
}

function applyScale() {
  if (!view.pages.length || !isViewerVisible()) return;
  view.scale = computeScale();
  for (const p of view.pages) {
    p.div.style.width = `${Math.floor(p.width * view.scale)}px`;
    p.div.style.height = `${Math.floor(p.height * view.scale)}px`;
    p.div.style.setProperty('--scale-factor', String(view.scale));
    p.div.style.setProperty('--user-unit', '1');
    p.div.style.setProperty('--total-scale-factor', String(view.scale));
    if (p.canvas) {
      p.canvas.style.width = p.div.style.width;
      p.canvas.style.height = p.div.style.height;
    }
    p.div.querySelectorAll('.cite-unindexed').forEach((el) => el.remove());
    p.rendered = false;
  }
  dom.zoom.textContent = `${view.zoom}%`;
}

function renderVisiblePages() {
  if (!view.pages.length || !isViewerVisible()) return;
  const viewTop = dom.viewer.scrollTop;
  const viewMid = viewTop + dom.viewer.clientHeight / 2;
  const top = viewTop - RENDER_MARGIN_PX;
  const bottom = viewTop + dom.viewer.clientHeight + RENDER_MARGIN_PX;

  const toRender = [];
  for (const p of view.pages) {
    const pageTop = p.div.offsetTop;
    const pageHeight = p.div.offsetHeight;
    if (!pageHeight) continue;
    const pageBottom = pageTop + pageHeight;
    if (pageBottom >= top && pageTop <= bottom) {
      if (!p.rendered && !p.rendering) {
        const dist = Math.abs(pageTop + pageHeight / 2 - viewMid);
        toRender.push({ p, dist });
      }
    } else if (p.canvas && (pageBottom < top - EVICT_MARGIN_PX || pageTop > bottom + EVICT_MARGIN_PX)) {
      evictPage(p);
    }
  }

  // Prioritize pages closest to the viewport center and cap concurrency so Chromium never
  // exhausts GPU canvas memory on rapid scrolls or reloads.
  toRender.sort((a, b) => a.dist - b.dist);
  for (const { p } of toRender) {
    if (activeRenders >= MAX_CONCURRENT_RENDERS) break;
    void renderPage(p);
  }
}

function evictPage(p) {
  p.canvas?.remove();
  p.textDiv?.remove();
  p.div?.querySelectorAll('.cite-unindexed').forEach((el) => el.remove());
  p.canvas = null;
  p.textDiv = null;
  p.rendered = false;
}

function notifyPageRendered(pageNum) {
  const list = renderWaiters.get(pageNum);
  if (!list) return;
  renderWaiters.delete(pageNum);
  for (const fn of list) fn();
}

function ensurePageRendered(p) {
  if (p.rendered) return Promise.resolve();
  return new Promise((resolve) => {
    const list = renderWaiters.get(p.num) ?? [];
    list.push(resolve);
    renderWaiters.set(p.num, list);
    void renderPage(p, true);
  });
}

async function renderPage(p, bypassLimit = false) {
  if (p.rendered || p.rendering) return;
  if (!bypassLimit && activeRenders >= MAX_CONCURRENT_RENDERS) return;
  const generation = view.generation;
  p.rendering = true;
  activeRenders++;
  try {
    const scale = view.scale;
    const viewport = p.page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    p.task = p.page.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    await p.task.promise;
    if (generation !== view.generation) return; // zoom or reload happened meanwhile

    // Attach the freshly painted canvas immediately so a TextLayer hiccup can NEVER leave
    // the page stuck as a blank white box.
    p.canvas?.remove();
    p.canvas = canvas;
    p.div.prepend(canvas);
    p.rendered = true;

    try {
      p.textContent ??= await p.page.getTextContent();
      if (generation !== view.generation) return;
      const textDiv = document.createElement('div');
      textDiv.className = 'textLayer';
      await new pdfjsLib.TextLayer({ textContentSource: p.textContent, container: textDiv, viewport }).render();
      if (generation !== view.generation) return;
      p.textDiv?.remove();
      p.textDiv = textDiv;
      p.div.appendChild(textDiv);
      if (findState.query && findState.matches.length) {
        applyFindHighlightsForPage(p);
      }
    } catch (textErr) {
      if (textErr?.name !== 'RenderingCancelledException') {
        console.warn('PDF text layer failed', p.num, textErr);
      }
    }

    void pageCiteLinks(p).then(() => {
      if (generation === view.generation) paintCiteMarks(p);
    });
    notifyPageRendered(p.num);
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException') console.warn('PDF page render failed', p.num, error);
  } finally {
    p.rendering = false;
    p.task = null;
    activeRenders = Math.max(0, activeRenders - 1);
    notifyPageRendered(p.num);
    // Pump remaining visible pages in the queue or re-render after a zoom/reload.
    if (isViewerVisible()) renderVisiblePages();
  }
}

// ---- Position -------------------------------------------------------------------------------

function pageAtY(y) {
  let found = view.pages[0];
  for (const p of view.pages) {
    if (p.div.offsetTop <= y + 1) found = p;
    else break;
  }
  return found;
}

function currentAnchor() {
  if (!view.pages.length || !isViewerVisible()) return null;
  const p = pageAtY(dom.viewer.scrollTop);
  if (!p || !p.div.offsetHeight) return { num: view.pageNumber || 1, fraction: 0 };
  const raw = (dom.viewer.scrollTop - p.div.offsetTop) / p.div.offsetHeight;
  const fraction = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
  return { num: p.num, fraction };
}

function restoreAnchor(anchor) {
  if (!anchor || !view.pages.length) return;
  const num = Math.max(1, Math.min(anchor.num || 1, view.pages.length));
  const p = view.pages[num - 1];
  const fraction = Number.isFinite(anchor.fraction) ? Math.max(0, Math.min(1, anchor.fraction)) : 0;
  if (p) dom.viewer.scrollTop = p.div.offsetTop + fraction * p.div.offsetHeight;
}

function saveState() {
  const anchor = currentAnchor() ?? view.deferredAnchor ?? saved.anchor ?? null;
  vscode.setState({ zoom: view.zoom, anchor, outlineOpen: view.outlineOpen, outlineWidth: view.outlineWidth });
}

function updatePageIndicator() {
  if (!view.pages.length || !isViewerVisible()) return;
  const p = pageAtY(dom.viewer.scrollTop + dom.viewer.clientHeight / 3);
  if (!p) return;
  view.pageNumber = p.num;
  if (document.activeElement !== dom.page) dom.page.value = String(p.num);
  updateActiveOutline();
  vscode.postMessage({ type: 'state', page: p.num, zoom: view.zoom });
}

function scrollToPage(num, pdfY = null, smooth = false) {
  const p = view.pages[Math.max(1, Math.min(num, view.pages.length)) - 1];
  if (!p) return;
  let offset = p.div.offsetTop - 8;
  if (pdfY !== null && Number.isFinite(pdfY)) {
    const topFromPageTop = Math.max(0, (p.height - pdfY) * view.scale);
    offset = Math.max(0, p.div.offsetTop + topFromPageTop - 24);
  }
  const far = Math.abs(offset - dom.viewer.scrollTop) > 2 * dom.viewer.clientHeight;
  dom.viewer.scrollTo({ top: Math.max(0, offset), behavior: smooth && !far ? 'smooth' : 'auto' });
  renderVisiblePages();
}

function setZoom(zoom) {
  const anchor = currentAnchor();
  view.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom)));
  view.generation++;
  applyScale();
  restoreAnchor(anchor);
  renderVisiblePages();
  saveState();
}

function setMessage(text) {
  dom.message.textContent = text;
}

// ---- Compilation status UI & Auto-compile toggle --------------------------------------------

let statusFadeTimer = null;

function applyCompileStatus(status) {
  clearTimeout(statusFadeTimer);
  const pill = dom['compile-status'];
  if (!status || status.state === 'idle') {
    dom['compile-bar'].hidden = true;
    pill.hidden = true;
    pill.className = 'status-pill';
    return;
  }

  if (status.state === 'compiling') {
    dom['compile-bar'].hidden = false;
    pill.hidden = false;
    pill.className = 'status-pill compiling';
    pill.textContent = 'Compiling…';
    pill.title = 'Tectonic is compiling the document';
    dom.compile.disabled = true;
    return;
  }

  dom['compile-bar'].hidden = true;
  dom.compile.disabled = false;

  if (status.state === 'success') {
    const secs = status.durationMs ? ` (${(status.durationMs / 1000).toFixed(1)}s)` : '';
    const warns = status.warnings || 0;
    pill.hidden = false;
    if (warns > 0) {
      pill.className = 'status-pill warn';
      pill.textContent = `✓ Updated${secs} · ${warns} warn`;
      pill.title = 'Click to view compiler log & Problems';
    } else {
      pill.className = 'status-pill success';
      pill.textContent = `✓ Updated${secs}`;
      pill.title = 'Compilation succeeded';
    }
    statusFadeTimer = setTimeout(() => {
      if (pill.classList.contains('success')) pill.hidden = true;
    }, 3500);
    return;
  }

  if (status.state === 'error') {
    const errs = status.errors || 0;
    pill.hidden = false;
    pill.className = 'status-pill error';
    pill.textContent = errs ? `✕ ${errs} ${errs === 1 ? 'error' : 'errors'} · Log` : '✕ Compile failed · Log';
    pill.title = status.message || 'Compilation failed — click to open compiler log & Problems';
  }
}

function applyAutoCompileMode(mode) {
  const active = mode !== 'off';
  const btn = dom['auto-compile'];
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  btn.title = active
    ? `Auto-compile is ON (${mode}). Click to disable automatic builds on save.`
    : 'Auto-compile is OFF. Click to re-enable automatic compilation when saving LaTeX files.';
}

// ---- Hierarchical PDF Outline Navigator -----------------------------------------------------

const outlineState = {
  flat: [], // { page, pdfY, rowEl }
  activeRow: null,
};

function applyOutlineWidth(widthPx) {
  const maxW = Math.max(220, Math.floor(window.innerWidth * 0.65));
  const clamped = Math.max(150, Math.min(maxW, Math.round(widthPx)));
  view.outlineWidth = clamped;
  dom['outline-panel'].style.width = `${clamped}px`;
}

function setOutlineOpen(open, persist = true) {
  view.outlineOpen = Boolean(open);
  dom['outline-panel'].hidden = !view.outlineOpen;
  dom['outline-resizer'].hidden = !view.outlineOpen;
  if (view.outlineOpen) applyOutlineWidth(view.outlineWidth);
  dom['toggle-outline'].setAttribute('aria-pressed', view.outlineOpen ? 'true' : 'false');
  if (persist) saveState();
  // Re-fit zoom cleanly if the pane width changed.
  if (view.pages.length && isViewerVisible()) {
    requestAnimationFrame(() => setZoom(view.zoom));
  }
}

function setupOutlineResizer() {
  const resizer = dom['outline-resizer'];
  let dragging = false;
  let startX = 0;
  let startWidth = 240;

  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    startX = event.clientX;
    startWidth = dom['outline-panel'].getBoundingClientRect().width || view.outlineWidth;
    resizer.classList.add('dragging');
    document.body.classList.add('resizing-outline');
    resizer.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  resizer.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    applyOutlineWidth(startWidth + (event.clientX - startX));
  });

  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing-outline');
    saveState();
  };

  resizer.addEventListener('pointerup', stopDrag);
  resizer.addEventListener('pointercancel', stopDrag);
  resizer.addEventListener('dblclick', () => {
    applyOutlineWidth(240);
    saveState();
  });
}

setupOutlineResizer();

async function resolveOutlineDest(doc, dest) {
  try {
    let explicit = dest;
    if (typeof dest === 'string') explicit = await doc.getDestination(dest);
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const ref = explicit[0];
    const pageIndex = typeof ref === 'number' ? ref : await doc.getPageIndex(ref);
    let pdfY = null;
    if (explicit[1]?.name === 'XYZ' && typeof explicit[3] === 'number') pdfY = explicit[3];
    else if ((explicit[1]?.name === 'FitH' || explicit[1]?.name === 'FitBH') && typeof explicit[2] === 'number') pdfY = explicit[2];
    return { page: pageIndex + 1, pdfY };
  } catch {
    return null;
  }
}

async function buildOutlineNodes(doc, items, depth) {
  const out = [];
  for (const item of items || []) {
    const target = item.dest ? await resolveOutlineDest(doc, item.dest) : null;
    const children = item.items?.length ? await buildOutlineNodes(doc, item.items, depth + 1) : [];
    out.push({
      title: String(item.title ?? '').trim() || '(Untitled)',
      page: target?.page ?? null,
      pdfY: target?.pdfY ?? null,
      depth,
      children,
    });
  }
  return out;
}

function renderOutlineList(nodes, container) {
  for (const node of nodes) {
    const wrap = document.createElement('div');
    wrap.className = 'outline-node';
    // Collapse deeper sub-levels (subsections+) by default for large documents while keeping chapters & sections open.
    if (node.depth >= 2 && node.children.length) wrap.classList.add('collapsed');

    const row = document.createElement('div');
    row.className = 'outline-row';
    row.title = node.title;

    const caret = document.createElement('span');
    caret.className = node.children.length ? 'outline-caret' : 'outline-caret leaf';
    caret.textContent = '▾';
    if (node.children.length) {
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        wrap.classList.toggle('collapsed');
      });
    }

    const label = document.createElement('span');
    label.className = 'outline-label';
    label.textContent = node.title;

    row.appendChild(caret);
    row.appendChild(label);

    if (node.page !== null) {
      const pg = document.createElement('span');
      pg.className = 'outline-page';
      pg.textContent = String(node.page);
      row.appendChild(pg);
      outlineState.flat.push({ page: node.page, pdfY: node.pdfY, rowEl: row });
    }

    row.addEventListener('click', () => {
      if (node.page !== null) scrollToPage(node.page, node.pdfY, true);
      else if (node.children.length) wrap.classList.toggle('collapsed');
    });

    wrap.appendChild(row);

    if (node.children.length) {
      const kids = document.createElement('div');
      kids.className = 'outline-children';
      renderOutlineList(node.children, kids);
      wrap.appendChild(kids);
    }

    container.appendChild(wrap);
  }
}

async function loadOutline(doc, loadId) {
  outlineState.flat = [];
  outlineState.activeRow = null;
  try {
    const raw = await doc.getOutline();
    if (loadId !== view.latestLoad) return;
    const tree = await buildOutlineNodes(doc, raw, 0);
    if (loadId !== view.latestLoad) return;
    dom['outline-tree'].replaceChildren();
    if (!tree.length) {
      const empty = document.createElement('div');
      empty.className = 'outline-empty';
      empty.textContent = 'No outline bookmarks in this PDF.';
      dom['outline-tree'].appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    renderOutlineList(tree, frag);
    dom['outline-tree'].appendChild(frag);
    updateActiveOutline();
  } catch {
    dom['outline-tree'].replaceChildren();
  }
}

function updateActiveOutline() {
  if (!outlineState.flat.length || !view.pages.length || dom['outline-panel'].hidden) return;
  const scrollY = dom.viewer.scrollTop + 48;
  let best = null;
  for (const item of outlineState.flat) {
    const p = view.pages[item.page - 1];
    if (!p) continue;
    const y = p.div.offsetTop + (item.pdfY !== null ? Math.max(0, (p.height - item.pdfY) * view.scale) : 0);
    if (y <= scrollY) best = item;
  }
  const nextRow = best?.rowEl ?? outlineState.flat[0]?.rowEl ?? null;
  if (nextRow === outlineState.activeRow) return;
  outlineState.activeRow?.classList.remove('active');
  outlineState.activeRow = nextRow;
  if (nextRow) {
    nextRow.classList.add('active');
    nextRow.scrollIntoView({ block: 'nearest' });
  }
}

// ---- In-PDF Text Search (Ctrl+F) ------------------------------------------------------------

const findState = {
  open: false,
  query: '',
  caseSensitive: false,
  matches: [], // { pageNum, pageMatchIdx }
  byPage: new Map(), // pageNum -> Array<{ globalIdx, start, length }>
  activeIdx: -1,
  searchGen: 0,
};

function openFindBar() {
  findState.open = true;
  dom['find-bar'].hidden = false;
  const sel = window.getSelection()?.toString().trim();
  if (sel && sel.length < 120 && !sel.includes('\n')) {
    dom['find-input'].value = sel;
  }
  dom['find-input'].focus();
  dom['find-input'].select();
  if (dom['find-input'].value) void runFind(dom['find-input'].value, { preserveIndex: true });
}

function closeFindBar() {
  findState.open = false;
  findState.query = '';
  findState.matches = [];
  findState.byPage.clear();
  findState.activeIdx = -1;
  dom['find-bar'].hidden = true;
  dom['find-count'].textContent = '';
  dom['find-count'].classList.remove('no-matches');
  clearFindHighlights();
}

function clearFindHighlightsForPage(p) {
  if (!p?.textDiv) return;
  const marks = p.textDiv.querySelectorAll('mark.find-match');
  if (!marks.length) return;
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
    parent.normalize();
  }
}

function clearFindHighlights() {
  for (const p of view.pages) clearFindHighlightsForPage(p);
}

async function getPageSearchText(p) {
  if (typeof p.plainText === 'string') return p.plainText;
  p.textContent ??= await p.page.getTextContent();
  p.plainText = p.textContent.items.map((item) => item.str || '').join('');
  return p.plainText;
}

function applyFindHighlightsForPage(p) {
  clearFindHighlightsForPage(p);
  if (!p?.textDiv || !findState.query) return;
  const pageMatches = findState.byPage.get(p.num);
  if (!pageMatches?.length) return;

  const walker = document.createTreeWalker(p.textDiv, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue) textNodes.push(n);
  }
  const needle = findState.caseSensitive ? findState.query : findState.query.toLowerCase();
  if (!needle) return;

  // Map concatenated textLayer text offsets back to individual text nodes.
  const segments = [];
  let cursor = 0;
  for (const node of textNodes) {
    const len = node.nodeValue.length;
    segments.push({ node, start: cursor, end: cursor + len });
    cursor += len;
  }
  const fullText = textNodes.map((tn) => tn.nodeValue).join('');
  const hay = findState.caseSensitive ? fullText : fullText.toLowerCase();

  const domRanges = [];
  let pos = 0;
  let localIdx = 0;
  while (pos <= hay.length - needle.length) {
    const hit = hay.indexOf(needle, pos);
    if (hit === -1) break;
    const globalIdx = pageMatches[localIdx]?.globalIdx ?? -1;
    domRanges.push({ start: hit, end: hit + needle.length, globalIdx });
    localIdx++;
    pos = hit + Math.max(1, needle.length);
  }
  if (!domRanges.length) return;

  // Apply highlights in reverse document order so earlier text node offsets stay valid.
  for (let i = domRanges.length - 1; i >= 0; i--) {
    const r = domRanges[i];
    for (let s = segments.length - 1; s >= 0; s--) {
      const seg = segments[s];
      if (seg.end <= r.start || seg.start >= r.end) continue;
      const localStart = Math.max(0, r.start - seg.start);
      const localEnd = Math.min(seg.node.nodeValue.length, r.end - seg.start);
      if (localStart >= localEnd) continue;

      const node = seg.node;
      const before = node.nodeValue.slice(0, localStart);
      const matchText = node.nodeValue.slice(localStart, localEnd);
      const after = node.nodeValue.slice(localEnd);
      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      const mark = document.createElement('mark');
      mark.className = r.globalIdx === findState.activeIdx ? 'find-match active' : 'find-match';
      mark.dataset.matchIdx = String(r.globalIdx);
      mark.textContent = matchText;
      frag.appendChild(mark);
      if (after) frag.appendChild(document.createTextNode(after));
      node.parentNode?.replaceChild(frag, node);
    }
  }
}

function updateFindCount() {
  const total = findState.matches.length;
  if (!findState.query) {
    dom['find-count'].textContent = '';
    dom['find-count'].classList.remove('no-matches');
  } else if (!total) {
    dom['find-count'].textContent = 'No matches';
    dom['find-count'].classList.add('no-matches');
  } else {
    dom['find-count'].textContent = `${findState.activeIdx + 1} / ${total}`;
    dom['find-count'].classList.remove('no-matches');
  }
}

async function focusFindMatch(idx) {
  const total = findState.matches.length;
  if (!total) {
    updateFindCount();
    return;
  }
  const wrapped = ((idx % total) + total) % total;
  findState.activeIdx = wrapped;
  updateFindCount();

  // Refresh active class on rendered marks.
  dom.viewer.querySelectorAll('mark.find-match.active').forEach((m) => m.classList.remove('active'));
  const target = findState.matches[wrapped];
  const p = view.pages[target.pageNum - 1];
  if (!p) return;

  if (!p.rendered) {
    scrollToPage(p.num);
    await ensurePageRendered(p);
  }
  if (findState.activeIdx !== wrapped) return;

  applyFindHighlightsForPage(p);
  const marks = p.textDiv?.querySelectorAll(`mark.find-match[data-match-idx="${wrapped}"]`);
  const firstMark = marks?.[0];
  if (firstMark) {
    firstMark.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  } else {
    scrollToPage(p.num, null, true);
  }
}

async function runFind(rawQuery, { preserveIndex = false } = {}) {
  const gen = ++findState.searchGen;
  const query = rawQuery;
  findState.query = query;
  findState.matches = [];
  findState.byPage.clear();
  clearFindHighlights();

  if (!query) {
    findState.activeIdx = -1;
    updateFindCount();
    return;
  }

  const needle = findState.caseSensitive ? query : query.toLowerCase();
  const matches = [];
  const byPage = new Map();

  for (const p of view.pages) {
    const text = await getPageSearchText(p);
    if (gen !== findState.searchGen) return;
    const hay = findState.caseSensitive ? text : text.toLowerCase();
    let pos = 0;
    const pageHits = [];
    while (pos <= hay.length - needle.length) {
      const hit = hay.indexOf(needle, pos);
      if (hit === -1) break;
      const globalIdx = matches.length;
      matches.push({ pageNum: p.num, start: hit, length: needle.length });
      pageHits.push({ globalIdx, start: hit, length: needle.length });
      pos = hit + Math.max(1, needle.length);
    }
    if (pageHits.length) byPage.set(p.num, pageHits);
  }

  if (gen !== findState.searchGen) return;
  findState.matches = matches;
  findState.byPage = byPage;

  if (!matches.length) {
    findState.activeIdx = -1;
    updateFindCount();
    return;
  }

  // Pick first match on or after current visible page unless preserving previous index.
  let startIdx = 0;
  if (preserveIndex && findState.activeIdx >= 0) {
    startIdx = Math.min(findState.activeIdx, matches.length - 1);
  } else {
    const nearIdx = matches.findIndex((m) => m.pageNum >= view.pageNumber);
    startIdx = nearIdx >= 0 ? nearIdx : 0;
  }
  findState.activeIdx = startIdx;

  for (const p of view.pages) {
    if (p.rendered && byPage.has(p.num)) applyFindHighlightsForPage(p);
  }
  await focusFindMatch(startIdx);
}

// ---- SyncTeX --------------------------------------------------------------------------------

function wordAtPoint(clientX, clientY) {
  const range = document.caretRangeFromPoint?.(clientX, clientY);
  const node = range?.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.parentElement.closest('.textLayer')) return null;
  const text = node.textContent;
  const isWord = (c) => /[\p{L}\p{N}'’-]/u.test(c);
  let start = range.startOffset;
  let end = range.startOffset;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  return { word: text.slice(start, end), context: text };
}

function postInverseSearch(page, x, y, word, context) {
  vscode.postMessage({ type: 'inverseSearch', page, x, y, word, context });
}

// "Go to source": the selected text if there is one, otherwise the area in view.
function syncViewToCode() {
  if (!view.pages.length) return;
  const selection = window.getSelection();
  if (selection?.rangeCount && !selection.isCollapsed && dom.viewer.contains(selection.anchorNode)) {
    const anchorElement = selection.anchorNode.parentElement ?? selection.anchorNode;
    const pageDiv = anchorElement.closest('.pdf-page');
    if (pageDiv) {
      const bounds = selection.getRangeAt(0).getBoundingClientRect();
      const pageBounds = pageDiv.getBoundingClientRect();
      postInverseSearch(
        Number(pageDiv.dataset.page),
        (bounds.left + bounds.width / 2 - pageBounds.left) / view.scale,
        (bounds.top + bounds.height / 2 - pageBounds.top) / view.scale,
        selection.toString(),
        anchorElement.textContent ?? '',
      );
      return;
    }
  }
  const y = dom.viewer.scrollTop + dom.viewer.clientHeight / 3;
  const p = pageAtY(y);
  postInverseSearch(p.num, p.width / 2, (y - p.div.offsetTop) / view.scale, '', '');
}

// A long source line maps to several typeset lines: estimate which from the cursor column, then
// refine with the word under the cursor.
async function pickBox({ boxes, character, lineLength, word }) {
  if (boxes.length === 1) return boxes[0];
  const estimate = Math.round((lineLength ? character / lineLength : 0) * (boxes.length - 1));
  if (!word || word.length < 2) return boxes[estimate];
  const matches = [];
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const p = view.pages[box.page - 1];
    if (!p) continue;
    p.textContent ??= await p.page.getTextContent();
    const hasWord = p.textContent.items.some((item) => {
      if (!item.str?.includes(word)) return false;
      const baseline = p.height - item.transform[5];
      return baseline >= box.y - 1 && baseline <= box.y + box.height + 3;
    });
    if (hasWord) matches.push(i);
  }
  if (!matches.length) return boxes[estimate];
  return boxes[matches.reduce((a, i) => (Math.abs(i - estimate) < Math.abs(a - estimate) ? i : a), matches[0])];
}

async function reveal(request) {
  const box = await pickBox(request);
  const p = view.pages[box.page - 1];
  if (!p) return;
  const pad = 2;
  const highlight = document.createElement('div');
  highlight.className = 'synctex-highlight';
  highlight.style.left = `${box.x * view.scale - pad}px`;
  highlight.style.top = `${box.y * view.scale - pad}px`;
  highlight.style.width = `${box.width * view.scale + 2 * pad}px`;
  highlight.style.height = `${box.height * view.scale + 2 * pad}px`;
  p.div.appendChild(highlight);
  setTimeout(() => highlight.remove(), 2300);

  // Keep the highlighted line about a third from the top of the pane.
  const target = p.div.offsetTop + box.y * view.scale - dom.viewer.clientHeight / 3;
  const far = Math.abs(target - dom.viewer.scrollTop) > 2 * dom.viewer.clientHeight;
  dom.viewer.scrollTo({ top: Math.max(0, target), behavior: far ? 'auto' : 'smooth' });
  void renderPage(p, true);
  vscode.postMessage({ type: 'revealed', page: box.page });
}

// ---- Citation highlights & hover tooltips ---------------------------------------------------

const cites = {
  data: {},
  tip: null,
  showTimer: null,
  hideTimer: null,
  overTip: false,
  current: null,
  noteCache: new Map(),
  pendingFileReq: new Map(),
  nextReqId: 1,
};

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function rectToViewport(vp, rect) {
  const [x1, y1] = vp.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = vp.convertToViewportPoint(rect[2], rect[3]);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function pageAnnotations(p) {
  if (p.pdfLinks) return Promise.resolve({ pdfLinks: p.pdfLinks, citeLinks: p.citeLinks });
  if (!p.annotationsPromise) {
    p.annotationsPromise = p.page
      .getAnnotations({ intent: 'display' })
      .then((annots) => {
        const pdfLinks = [];
        const citeLinks = [];
        for (const a of annots) {
          if (a.subtype !== 'Link' || !Array.isArray(a.rect) || a.rect.length !== 4) continue;
          const rect = [
            Math.min(a.rect[0], a.rect[2]),
            Math.min(a.rect[1], a.rect[3]),
            Math.max(a.rect[0], a.rect[2]),
            Math.max(a.rect[1], a.rect[3]),
          ];
          const url = typeof a.url === 'string' && a.url ? a.url : typeof a.unsafeUrl === 'string' && a.unsafeUrl ? a.unsafeUrl : null;
          const dest = a.dest ?? null;
          if (url || dest !== null) {
            pdfLinks.push({ rect, url, dest });
          }
          if (typeof a.dest === 'string' && a.dest.startsWith('cite.')) {
            citeLinks.push({ key: a.dest.slice(5), rect });
          }
        }
        p.pdfLinks = pdfLinks;
        p.citeLinks = citeLinks;
        return { pdfLinks, citeLinks };
      })
      .catch(() => {
        p.pdfLinks = [];
        p.citeLinks = [];
        return { pdfLinks: [], citeLinks: [] };
      });
  }
  return p.annotationsPromise;
}

function pageCiteLinks(p) {
  return pageAnnotations(p).then((res) => res.citeLinks);
}

const navHistory = [];

function pdfLinkAt(event) {
  const pageDiv = event.target?.closest?.('.pdf-page');
  if (!pageDiv) return null;
  const p = view.pages[Number(pageDiv.dataset.page) - 1];
  if (!p || !p.pdfLinks) {
    if (p) void pageAnnotations(p);
    return null;
  }
  const rect = pageDiv.getBoundingClientRect();
  const vp = p.page.getViewport({ scale: view.scale });
  const [px, py] = vp.convertToPdfPoint(event.clientX - rect.left, event.clientY - rect.top);
  return p.pdfLinks.find((l) => px >= l.rect[0] && px <= l.rect[2] && py >= l.rect[1] && py <= l.rect[3]) ?? null;
}

async function followPdfLink(link) {
  if (!link) return;
  if (link.url) {
    vscode.postMessage({ type: 'openExternal', url: link.url });
    return;
  }
  if (link.dest !== null && view.document?.doc) {
    const target = await resolveOutlineDest(view.document.doc, link.dest);
    if (!target) return;
    const prev = currentAnchor();
    if (prev) {
      navHistory.push(prev);
      if (navHistory.length > 40) navHistory.shift();
    }
    scrollToPage(target.page, target.pdfY, true);
  }
}

// Highlight boxes over citations whose paper is not in the library index.
// Yellow: second-hand (other papers in the library cite it). Red: no trace in the library.
function paintCiteMarks(p) {
  if (!p.rendered || !p.citeLinks || !p.div) return;
  p.div.querySelectorAll('.cite-unindexed').forEach((el) => el.remove());
  const vp = p.page.getViewport({ scale: view.scale });
  for (const link of p.citeLinks) {
    const entry = cites.data[link.key];
    if (!entry || entry.indexed !== false || !entry.citedIn) continue;
    const box = rectToViewport(vp, link.rect);
    const el = document.createElement('div');
    el.className = `cite-unindexed ${entry.citedIn.count > 0 ? 'cite-secondhand' : 'cite-unsourced'}`;
    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    p.div.appendChild(el);
  }
}

function repaintAllCiteMarks() {
  for (const p of view.pages) {
    if (p.rendered) void pageCiteLinks(p).then(() => paintCiteMarks(p));
  }
}

function citeLinkAt(event) {
  const pageDiv = event.target?.closest?.('.pdf-page');
  if (!pageDiv) return null;
  const p = view.pages[Number(pageDiv.dataset.page) - 1];
  if (!p || !p.citeLinks) {
    if (p) void pageCiteLinks(p);
    return null;
  }
  const rect = pageDiv.getBoundingClientRect();
  const vp = p.page.getViewport({ scale: view.scale });
  const [px, py] = vp.convertToPdfPoint(event.clientX - rect.left, event.clientY - rect.top);
  const link = p.citeLinks.find((l) => px >= l.rect[0] && px <= l.rect[2] && py >= l.rect[1] && py <= l.rect[3]);
  if (!link) return null;
  const vpBox = rectToViewport(vp, link.rect);
  return {
    p,
    link,
    box: {
      left: rect.left + vpBox.left,
      right: rect.left + vpBox.right,
      top: rect.top + vpBox.top,
      bottom: rect.top + vpBox.bottom,
    },
    sx: (event.clientX - rect.left) / view.scale,
    sy: (event.clientY - rect.top) / view.scale,
  };
}

function resolveCiteSourceFile(page, x, y) {
  return new Promise((resolve) => {
    const requestId = cites.nextReqId++;
    const timer = setTimeout(() => {
      cites.pendingFileReq.delete(requestId);
      resolve(null);
    }, 1500);
    cites.pendingFileReq.set(requestId, (file) => {
      clearTimeout(timer);
      resolve(file);
    });
    vscode.postMessage({ type: 'resolveCiteFile', requestId, page, x, y });
  });
}

async function pickCiteNote(hit, entry) {
  const notes = entry.notes || [];
  if (notes.length <= 1) return notes[0] || null;
  const cacheKey = `${hit.p.num}:${hit.link.rect.join(',')}`;
  if (cites.noteCache.has(cacheKey)) return cites.noteCache.get(cacheKey);
  let pick = notes[0];
  const file = await resolveCiteSourceFile(hit.p.num, hit.sx, hit.sy);
  if (file) pick = notes.find((n) => n.file === file) || pick;
  cites.noteCache.set(cacheKey, pick);
  return pick;
}

function formatAuthors(bibAuthors) {
  const names = (bibAuthors || '')
    .split(/\s+and\s+/)
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => (n.includes(',') ? `${n.split(',').slice(1).join(' ').trim()} ${n.split(',')[0].trim()}` : n));
  if (names.length > 4) return `${names.slice(0, 3).join(', ')} et al.`;
  return names.join(', ');
}

function citeProvenanceHtml(citedIn) {
  if (!citedIn.count) {
    return '<div class="cite-tip-warn cite-tip-warn-red">This paper is not in Zotero, and no paper in your library cites it: verify that it exists</div>';
  }
  const rows = (citedIn.papers || [])
    .map((paper) => {
      const qPage = paper.quotePage ?? paper.quote_page;
      const loc =
        qPage && qPage !== paper.page
          ? ` (cited p. ${escapeHtml(String(qPage))}${paper.page ? `, ref. p. ${escapeHtml(String(paper.page))}` : ''})`
          : paper.page
            ? ` (p. ${escapeHtml(String(paper.page))})`
            : '';
      const quote = paper.quote ? `<blockquote class="cite-tip-cite-quote">“${escapeHtml(paper.quote)}”</blockquote>` : '';
      return `<li>${escapeHtml(paper.title)}${loc}${quote}</li>`;
    })
    .join('');
  const more = citedIn.count > (citedIn.papers?.length ?? 0) ? `<div>and ${citedIn.count - citedIn.papers.length} more</div>` : '';
  return `<div class="cite-tip-warn">This paper is not in Zotero. Second-hand: it is cited by these papers in your library<ul>${rows}</ul>${more}</div>`;
}

function scheduleHideCiteTip() {
  if (cites.hideTimer || cites.overTip) return;
  cites.hideTimer = setTimeout(hideCiteTip, 350);
}

function cancelHideCiteTip() {
  clearTimeout(cites.hideTimer);
  cites.hideTimer = null;
}

function hideCiteTip() {
  cancelHideCiteTip();
  cites.overTip = false;
  clearTimeout(cites.showTimer);
  cites.current = null;
  if (cites.tip) cites.tip.classList.remove('visible');
  if (dom.viewer.dataset.title) {
    dom.viewer.title = dom.viewer.dataset.title;
    delete dom.viewer.dataset.title;
  }
}

async function showCiteTip(hit) {
  const entry = cites.data[hit.link.key];
  const tip = cites.tip;
  let html;
  if (!entry) {
    html = `<div class="cite-tip-title">${escapeHtml(hit.link.key)}</div><div class="cite-tip-meta">Not found in the .bib files</div>`;
  } else {
    const note = await pickCiteNote(hit, entry);
    if (cites.current !== hit.link) return;
    const meta = [formatAuthors(entry.authors), entry.year].filter(Boolean).join(' · ');
    html =
      `<div class="cite-tip-title">${escapeHtml(entry.title || hit.link.key)}</div>` +
      `<div class="cite-tip-meta">${escapeHtml(meta)}${entry.venue ? `<br><span class="cite-tip-venue">${escapeHtml(entry.venue)}</span>` : ''}</div>`;
    if (entry.inside?.title) {
      const pg = entry.inside.page ? ` (p. ${escapeHtml(String(entry.inside.page))})` : '';
      html += `<div class="cite-tip-inside">In library inside: ${escapeHtml(entry.inside.title)}${pg}</div>`;
    }
    if (entry.indexed === false && entry.citedIn) {
      html += citeProvenanceHtml(entry.citedIn);
    }
    if (note) {
      const more = entry.notes.length > 1 ? ` · ${entry.notes.length} notes` : '';
      html +=
        `<blockquote class="cite-tip-quote">“${escapeHtml(note.quote)}”</blockquote>` +
        `<div class="cite-tip-src">${note.page ? `p. ${escapeHtml(String(note.page))}` : ''}${more}</div>`;
    }
  }
  tip.innerHTML = html;
  tip.style.left = '0px';
  tip.style.top = '0px';
  tip.classList.add('visible');
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const left = Math.min(Math.max(8, hit.box.left), window.innerWidth - w - 8);
  let top = hit.box.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, hit.box.top - h - 6);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function setupCitationTooltips() {
  cites.tip = document.createElement('div');
  cites.tip.className = 'cite-tip';
  document.body.appendChild(cites.tip);

  cites.tip.addEventListener('mouseenter', () => {
    cites.overTip = true;
    cancelHideCiteTip();
  });
  cites.tip.addEventListener('mouseleave', (e) => {
    if (e.buttons & 1) {
      document.addEventListener(
        'mouseup',
        () => {
          if (cites.tip.matches(':hover')) return;
          cites.overTip = false;
          scheduleHideCiteTip();
        },
        { once: true },
      );
      return;
    }
    cites.overTip = false;
    scheduleHideCiteTip();
  });

  let raf = 0;
  let lastEvt = null;
  dom.viewer.addEventListener('mousemove', (e) => {
    lastEvt = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const hit = citeLinkAt(lastEvt);
      if (!hit) {
        if (!cites.current) return;
        if (cites.tip.classList.contains('visible')) scheduleHideCiteTip();
        else hideCiteTip();
        return;
      }
      if (cites.current === hit.link) {
        cancelHideCiteTip();
        return;
      }
      hideCiteTip();
      cites.current = hit.link;
      if (dom.viewer.title) {
        dom.viewer.dataset.title = dom.viewer.title;
        dom.viewer.title = '';
      }
      cites.showTimer = setTimeout(() => void showCiteTip(hit), 250);
    });
  });

  dom.viewer.addEventListener('mouseleave', () => {
    if (cites.tip.classList.contains('visible')) scheduleHideCiteTip();
    else hideCiteTip();
  });
}

setupCitationTooltips();

// Restore saved outline sidebar preference before first PDF loads.
if (view.outlineOpen) {
  dom['outline-panel'].hidden = false;
  dom['outline-resizer'].hidden = false;
  applyOutlineWidth(view.outlineWidth);
  dom['toggle-outline'].setAttribute('aria-pressed', 'true');
}

// ---- Events ---------------------------------------------------------------------------------

let scrollTimer;
dom.viewer.addEventListener(
  'scroll',
  () => {
    if (!cites.overTip) hideCiteTip();
    updatePageIndicator();
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      renderVisiblePages();
      saveState();
    }, 60);
  },
  { passive: true },
);

function handleBecomeVisible() {
  if (!view.pages.length || !isViewerVisible()) return;
  if (view.needsLayout) {
    const anchor = view.deferredAnchor;
    view.needsLayout = false;
    view.deferredAnchor = null;
    view.generation++;
    applyScale();
    restoreAnchor(anchor);
    renderVisiblePages();
    updatePageIndicator();
  } else {
    renderVisiblePages();
  }
}

// Keep "fit width" when the pane is resized, and recover cleanly when returning from a hidden tab.
let lastWidth = 0;
let resizeTimer;
new ResizeObserver(() => {
  const width = dom.viewer.clientWidth;
  const height = dom.viewer.clientHeight;
  if (!width || !height) {
    // Reset lastWidth while hidden so returning to the same pane width still triggers repaint.
    lastWidth = 0;
    return;
  }
  if (!view.pages.length) return;
  if (view.needsLayout) {
    lastWidth = width;
    handleBecomeVisible();
    return;
  }
  if (Math.abs(width - lastWidth) < 2) {
    renderVisiblePages();
    return;
  }
  lastWidth = width;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => setZoom(view.zoom), 100);
}).observe(dom.viewer);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) handleBecomeVisible();
});

dom.viewer.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    setZoom(view.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  },
  { passive: false },
);

// Ctrl+Click (Cmd+Click on macOS) follows embedded PDF hyperlinks (URLs or internal sections/refs).
let lastMouseEvent = null;
function updateCtrlLinkCursor(event) {
  const active = Boolean((event?.ctrlKey || event?.metaKey) && event && pdfLinkAt(event));
  dom.viewer.classList.toggle('ctrl-link-hover', active);
}

dom.viewer.addEventListener('mousemove', (event) => {
  lastMouseEvent = event;
  updateCtrlLinkCursor(event);
});
dom.viewer.addEventListener('mouseleave', () => {
  lastMouseEvent = null;
  dom.viewer.classList.remove('ctrl-link-hover');
});

dom.viewer.addEventListener('click', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  const link = pdfLinkAt(event);
  if (!link) return;
  event.preventDefault();
  event.stopPropagation();
  void followPdfLink(link);
});

dom.viewer.addEventListener('dblclick', (event) => {
  if (event.ctrlKey || event.metaKey) return;
  const pageDiv = event.target.closest?.('.pdf-page');
  if (!pageDiv) return;
  const bounds = pageDiv.getBoundingClientRect();
  const hit = wordAtPoint(event.clientX, event.clientY);
  const word = hit?.word || window.getSelection()?.toString().trim() || '';
  postInverseSearch(
    Number(pageDiv.dataset.page),
    (event.clientX - bounds.left) / view.scale,
    (event.clientY - bounds.top) / view.scale,
    word,
    hit?.context ?? '',
  );
});

// Keyboard shortcuts: Ctrl+F / Cmd+F for find, Escape to close find bar, Alt+Left to go back from PDF link jump.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Control' || event.key === 'Meta') {
    if (lastMouseEvent) updateCtrlLinkCursor({ ...lastMouseEvent, target: lastMouseEvent.target, clientX: lastMouseEvent.clientX, clientY: lastMouseEvent.clientY, ctrlKey: true, metaKey: true });
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openFindBar();
  } else if (event.key === 'Escape' && findState.open) {
    event.preventDefault();
    closeFindBar();
  } else if (event.altKey && event.key === 'ArrowLeft' && navHistory.length) {
    event.preventDefault();
    restoreAnchor(navHistory.pop());
    renderVisiblePages();
    updatePageIndicator();
  } else if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'c') {
    event.preventDefault();
    triggerFindCitationFromSelection();
  } else if (event.key === 'Escape') {
    hideSelectionMenus();
  }
});

window.addEventListener('keyup', (event) => {
  if (event.key === 'Control' || event.key === 'Meta') {
    dom.viewer.classList.remove('ctrl-link-hover');
  }
});
window.addEventListener('blur', () => {
  dom.viewer.classList.remove('ctrl-link-hover');
});

let findTimer;
dom['find-input'].addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => void runFind(dom['find-input'].value), 120);
});
dom['find-input'].addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (!findState.matches.length && dom['find-input'].value) {
      void runFind(dom['find-input'].value);
    } else {
      void focusFindMatch(findState.activeIdx + (event.shiftKey ? -1 : 1));
    }
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeFindBar();
  }
});
dom['find-prev'].addEventListener('click', () => void focusFindMatch(findState.activeIdx - 1));
dom['find-next'].addEventListener('click', () => void focusFindMatch(findState.activeIdx + 1));
dom['find-case'].addEventListener('click', () => {
  findState.caseSensitive = !findState.caseSensitive;
  dom['find-case'].setAttribute('aria-pressed', findState.caseSensitive ? 'true' : 'false');
  if (dom['find-input'].value) void runFind(dom['find-input'].value);
});
dom['find-close'].addEventListener('click', closeFindBar);
dom['toggle-find'].addEventListener('click', () => {
  if (findState.open) closeFindBar();
  else openFindBar();
});

dom['toggle-outline'].addEventListener('click', () => setOutlineOpen(!view.outlineOpen));
dom['outline-close'].addEventListener('click', () => setOutlineOpen(false));

dom['compile-status'].addEventListener('click', () => {
  if (dom['compile-status'].classList.contains('error') || dom['compile-status'].classList.contains('warn')) {
    vscode.postMessage({ type: 'showLog' });
  }
});
dom['auto-compile'].addEventListener('click', () => vscode.postMessage({ type: 'toggleAutoCompile' }));

dom.prev.addEventListener('click', () => scrollToPage(view.pageNumber - 1));
dom.next.addEventListener('click', () => scrollToPage(view.pageNumber + 1));
dom.page.addEventListener('change', () => scrollToPage(parseInt(dom.page.value, 10) || 1));
dom.page.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') dom.page.blur();
});
dom['zoom-in'].addEventListener('click', () => setZoom(view.zoom + 10));
dom['zoom-out'].addEventListener('click', () => setZoom(view.zoom - 10));
dom.fit.addEventListener('click', () => setZoom(100));
dom['to-code'].addEventListener('click', syncViewToCode);
dom.compile.addEventListener('click', () => vscode.postMessage({ type: 'compile' }));

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'pdf':
      void loadPdf(message.data);
      break;
    case 'noPdf':
      dom.empty.hidden = false;
      break;
    case 'reveal':
      void reveal(message);
      break;
    case 'syncToCode':
      syncViewToCode();
      break;
    case 'busy':
      if (message.busy) applyCompileStatus({ state: 'compiling' });
      else dom['compile-bar'].hidden = true;
      break;
    case 'compileStatus':
      applyCompileStatus(message.status);
      break;
    case 'autoCompile':
      applyAutoCompileMode(message.mode);
      break;
    case 'citations':
      cites.data = message.data || {};
      cites.noteCache.clear();
      repaintAllCiteMarks();
      break;
    case 'citeFileResolved': {
      const done = cites.pendingFileReq.get(message.requestId);
      if (done) {
        cites.pendingFileReq.delete(message.requestId);
        done(message.file ?? null);
      }
      break;
    }
    case 'requestFindCitation':
      triggerFindCitationFromSelection();
      break;
  }
});

// ---- PDF text selection -> Find Supporting Citation in Zotero -------------------------------

let cachedSelectionPayload = null;

function hideSelectionMenus() {
  if (dom['selection-action']) dom['selection-action'].hidden = true;
  if (dom['pdf-context-menu']) dom['pdf-context-menu'].hidden = true;
}

function extractPdfSelectionPayload() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const range = sel.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  const ancestorEl = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
  if (!ancestorEl || !dom.viewer.contains(ancestorEl)) return null;

  const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 || r.height > 0.5);
  const endRect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  const topRect = rects.length ? rects[0] : endRect;

  const endNode = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement;
  let pageDiv = endNode?.closest?.('.pdf-page') ?? null;
  const cx = Math.max(endRect.left, endRect.right - 2);
  const cy = endRect.top + endRect.height / 2;
  if (!pageDiv) {
    const elAtPt = document.elementFromPoint(cx, cy);
    pageDiv = elAtPt?.closest?.('.pdf-page') ?? null;
  }

  let page;
  let x;
  let y;
  let word = '';
  let context = '';
  if (pageDiv) {
    const bounds = pageDiv.getBoundingClientRect();
    page = Number(pageDiv.dataset.page);
    x = (cx - bounds.left) / view.scale;
    y = (cy - bounds.top) / view.scale;
    const hit = wordAtPoint(cx, cy);
    if (hit) {
      word = hit.word;
      context = hit.context;
    } else {
      const words = text.split(/\s+/).filter(Boolean);
      word = words[words.length - 1] ?? '';
      context = text.slice(-80);
    }
  }

  return { text, page, x, y, word, context, topRect, endRect };
}

function showSelectionPill(payload) {
  const pill = dom['selection-action'];
  if (!pill || !payload || payload.text.length < 6) {
    if (pill) pill.hidden = true;
    return;
  }
  const wrapRect = dom.viewer.getBoundingClientRect();
  const left = Math.max(8, Math.min(payload.topRect.left - wrapRect.left, wrapRect.width - 130));
  const top = Math.max(8, payload.topRect.top - wrapRect.top - 30);
  pill.style.left = `${Math.round(left)}px`;
  pill.style.top = `${Math.round(top)}px`;
  pill.hidden = false;
}

function triggerFindCitationFromSelection(payload = null) {
  const active = payload ?? extractPdfSelectionPayload() ?? cachedSelectionPayload;
  hideSelectionMenus();
  vscode.postMessage({
    type: 'findCitation',
    text: active?.text ?? '',
    page: active?.page,
    x: active?.x,
    y: active?.y,
    word: active?.word,
    context: active?.context,
  });
}

dom.viewer.addEventListener('mouseup', () => {
  requestAnimationFrame(() => {
    const payload = extractPdfSelectionPayload();
    cachedSelectionPayload = payload;
    if (payload && payload.text.length >= 6) {
      showSelectionPill(payload);
    } else {
      hideSelectionMenus();
    }
  });
});

dom.viewer.addEventListener('contextmenu', (event) => {
  const payload = extractPdfSelectionPayload();
  if (!payload || payload.text.length < 3) {
    hideSelectionMenus();
    return;
  }
  event.preventDefault();
  cachedSelectionPayload = payload;
  if (dom['selection-action']) dom['selection-action'].hidden = true;
  const menu = dom['pdf-context-menu'];
  if (!menu) return;
  const wrapRect = dom.viewer.getBoundingClientRect();
  menu.hidden = false;
  const menuW = menu.offsetWidth || 230;
  const menuH = menu.offsetHeight || 64;
  const left = Math.max(6, Math.min(event.clientX - wrapRect.left, wrapRect.width - menuW - 6));
  const top = Math.max(6, Math.min(event.clientY - wrapRect.top, wrapRect.height - menuH - 6));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
});

dom['selection-action']?.addEventListener('mousedown', (e) => e.preventDefault());
dom['selection-action']?.addEventListener('click', () => triggerFindCitationFromSelection(cachedSelectionPayload));
dom['ctx-find-citation']?.addEventListener('click', () => triggerFindCitationFromSelection(cachedSelectionPayload));
dom['ctx-copy-selection']?.addEventListener('click', () => {
  const text = cachedSelectionPayload?.text || window.getSelection()?.toString() || '';
  if (text && navigator.clipboard?.writeText) void navigator.clipboard.writeText(text);
  hideSelectionMenus();
});

document.addEventListener('mousedown', (event) => {
  const target = event.target;
  if (
    !dom['selection-action']?.contains(target) &&
    !dom['pdf-context-menu']?.contains(target)
  ) {
    hideSelectionMenus();
  }
});
dom.viewer.addEventListener('scroll', hideSelectionMenus, { passive: true });

vscode.postMessage({ type: 'ready' });
