// The PDF tab's page: renders with PDF.js and talks to the extension through messages.
import * as pdfjsLib from 'pdfjs-entry';

const vscode = acquireVsCodeApi();
const config = JSON.parse(document.getElementById('config').textContent);

const dom = Object.fromEntries(
  ['viewer', 'empty', 'prev', 'next', 'page', 'total', 'zoom', 'zoom-in', 'zoom-out', 'fit', 'message', 'to-code', 'compile'].map((id) => [
    id,
    document.getElementById(id),
  ]),
);

const saved = vscode.getState() ?? {};
const view = {
  zoom: saved.zoom ?? 100, // percent of the width that fits the pane
  scale: 1,
  pages: [], // { num, page, width, height, div, canvas, textDiv, rendered, rendering, task, textContent }
  generation: 0,
  document: null,
  pageNumber: 1,
  latestLoad: 0,
};
let pendingAnchor = saved.anchor ?? null;

const RENDER_MARGIN_PX = 800;
const EVICT_MARGIN_PX = 5000;
const MIN_ZOOM = 30;
const MAX_ZOOM = 300;

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

async function loadPdf(data) {
  const loadId = ++view.latestLoad;
  const anchor = pendingAnchor ?? currentAnchor();
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

  // Old canvases stay in the new page shells until the fresh ones are painted, so a recompile
  // does not flash an empty pane.
  const fragment = document.createDocumentFragment();
  for (const p of pages) {
    p.div = document.createElement('div');
    p.div.className = 'pdf-page';
    p.div.dataset.page = String(p.num);
    const previous = view.pages[p.num - 1];
    if (previous?.canvas && previous.width === p.width && previous.height === p.height) {
      p.canvas = previous.canvas;
      p.div.appendChild(p.canvas);
    }
    fragment.appendChild(p.div);
  }
  for (const p of view.pages) p.task?.cancel();
  const previousDocument = view.document;
  view.document = opened;
  view.pages = pages;
  view.generation++;
  dom.viewer.replaceChildren(fragment);
  dom.empty.hidden = true;
  if (previousDocument) void previousDocument.close();

  dom.total.textContent = `/ ${pages.length}`;
  dom.page.max = String(pages.length);
  applyScale();
  restoreAnchor(anchor);
  renderVisiblePages();
  updatePageIndicator();
  setMessage('');
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
    p.rendered = false;
  }
  dom.zoom.textContent = `${view.zoom}%`;
}

function renderVisiblePages() {
  const top = dom.viewer.scrollTop - RENDER_MARGIN_PX;
  const bottom = dom.viewer.scrollTop + dom.viewer.clientHeight + RENDER_MARGIN_PX;
  for (const p of view.pages) {
    const pageTop = p.div.offsetTop;
    const pageBottom = pageTop + p.div.offsetHeight;
    if (pageBottom >= top && pageTop <= bottom) void renderPage(p);
    else if (p.canvas && (pageBottom < top - EVICT_MARGIN_PX || pageTop > bottom + EVICT_MARGIN_PX)) evictPage(p);
  }
}

function evictPage(p) {
  p.canvas?.remove();
  p.textDiv?.remove();
  p.canvas = null;
  p.textDiv = null;
  p.rendered = false;
}

async function renderPage(p) {
  if (p.rendered || p.rendering) return;
  const generation = view.generation;
  p.rendering = true;
  try {
    const scale = view.scale;
    const viewport = p.page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
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

    p.textContent ??= await p.page.getTextContent();
    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';
    await new pdfjsLib.TextLayer({ textContentSource: p.textContent, container: textDiv, viewport }).render();
    if (generation !== view.generation) return;

    p.canvas?.remove();
    p.textDiv?.remove();
    p.canvas = canvas;
    p.textDiv = textDiv;
    p.div.prepend(canvas);
    p.div.appendChild(textDiv);
    p.rendered = true;
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException') console.warn('PDF page render failed', p.num, error);
  } finally {
    p.rendering = false;
    p.task = null;
    // A zoom during rendering leaves the page stale: try again at the new scale.
    if (!p.rendered && generation !== view.generation) renderVisiblePages();
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
  if (!view.pages.length) return null;
  const p = pageAtY(dom.viewer.scrollTop);
  return { num: p.num, fraction: (dom.viewer.scrollTop - p.div.offsetTop) / p.div.offsetHeight };
}

function restoreAnchor(anchor) {
  if (!anchor) return;
  const p = view.pages[Math.min(anchor.num, view.pages.length) - 1];
  if (p) dom.viewer.scrollTop = p.div.offsetTop + anchor.fraction * p.div.offsetHeight;
}

function saveState() {
  vscode.setState({ zoom: view.zoom, anchor: currentAnchor() });
}

function updatePageIndicator() {
  if (!view.pages.length) return;
  const p = pageAtY(dom.viewer.scrollTop + dom.viewer.clientHeight / 3);
  view.pageNumber = p.num;
  if (document.activeElement !== dom.page) dom.page.value = String(p.num);
  vscode.postMessage({ type: 'state', page: p.num, zoom: view.zoom });
}

function scrollToPage(num) {
  const p = view.pages[Math.max(1, Math.min(num, view.pages.length)) - 1];
  if (p) dom.viewer.scrollTop = p.div.offsetTop - 8;
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
  void renderPage(p);
  vscode.postMessage({ type: 'revealed', page: box.page });
}

// ---- Events ---------------------------------------------------------------------------------

let scrollTimer;
dom.viewer.addEventListener(
  'scroll',
  () => {
    updatePageIndicator();
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      renderVisiblePages();
      saveState();
    }, 60);
  },
  { passive: true },
);

// Keep "fit width" when the pane is resized.
let lastWidth = 0;
let resizeTimer;
new ResizeObserver(() => {
  const width = dom.viewer.clientWidth;
  if (!view.pages.length || !width || Math.abs(width - lastWidth) < 2) return;
  lastWidth = width;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => setZoom(view.zoom), 120);
}).observe(dom.viewer);

dom.viewer.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    setZoom(view.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  },
  { passive: false },
);

dom.viewer.addEventListener('dblclick', (event) => {
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
      setMessage(message.busy ? 'Compiling…' : '');
      break;
  }
});

vscode.postMessage({ type: 'ready' });
