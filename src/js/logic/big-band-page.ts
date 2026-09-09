// Logic for the "Big Band" guided workflow page: upload an arbitrary number
// of PDFs, strip password protection from all of them, merge into one
// document, edit/redact it, then hand it off to the PDF Multi Tool — all in
// one page, in memory, with no re-upload required between steps.
import { createIcons, icons } from 'lucide';
import Sortable from 'sortablejs';
import { showAlert, showLoader, hideLoader } from '../ui.js';
import {
  downloadFile,
  readFileAsArrayBuffer,
  formatBytes,
} from '../utils/helpers.js';
import { batchDecryptIfNeeded } from '../utils/password-prompt.js';
import { decryptPdfBytes } from '../utils/pdf-decrypt.js';
import { mergePdfs } from '../utils/pdf-operations.js';
import { getEditorDisabledCategories } from '../utils/disabled-tools.js';
import { editorFontFallback } from '../config/editor-fonts.js';
import {
  redactAllOccurrences,
  openRedactionPanel,
  type PluginRegistryLite,
} from '../utils/redact-search.js';
import {
  scanForWatermarks,
  removeWatermarks,
} from '../utils/watermark-removal.js';

const embedPdfWasmUrl = new URL(
  'bentopdf-pdfium/editcore.wasm',
  import.meta.url
).href;

import type { EmbedPdfContainer } from 'bentopdf-viewer';
import type {
  AnnotationCapabilityLite,
  AnnotationPluginLite,
  DocManagerPlugin,
  FreeTextSystemFontAnnotation,
} from '@/types';

const REDACT_TOOL_DEFAULTS = {
  color: '#FFFFFF',
  overlayColor: '#FFFFFF',
  strokeColor: '#FFFFFF',
};

const FREETEXT_SUBTYPE = 3;
const MERGED_FILE_NAME = 'big-band-merged.pdf';
const MULTI_TOOL_ORIGIN_MSG_PREFIX = 'big-band:';

type Step = 1 | 2 | 3 | 4;

let uploadedFiles: File[] = [];
let mergedBytes: Uint8Array | null = null;
let fileListSortable: Sortable | null = null;

let viewerInstance: EmbedPdfContainer | null = null;
let docManagerPlugin: DocManagerPlugin | null = null;
let viewerRegistry: PluginRegistryLite | null = null;
let exportPluginRef: {
  saveAsCopy: () => { toPromise: () => Promise<ArrayBuffer> };
} | null = null;
let annotationPluginRef: AnnotationPluginLite | null = null;
let editorInitialized = false;

function collectSystemFontFreeTexts(
  annotationPlugin: AnnotationPluginLite | null
): FreeTextSystemFontAnnotation[] {
  if (!annotationPlugin) return [];
  try {
    const state = annotationPlugin.getState();
    const out: FreeTextSystemFontAnnotation[] = [];
    for (const tracked of Object.values(state.byUid)) {
      const obj = tracked.object;
      if (obj.type !== FREETEXT_SUBTYPE) continue;
      if (obj.intent === 'FreeTextCallout') continue;
      if (!obj.fontPostScriptName || !obj.fontPostScriptName.trim()) continue;
      if (!obj.id || obj.pageIndex == null || !obj.rect) continue;
      if ((obj.rotation ?? 0) !== 0) continue;
      out.push({
        id: obj.id,
        pageIndex: obj.pageIndex,
        contents: obj.contents ?? '',
        fontSize: obj.fontSize ?? 12,
        fontColor: obj.fontColor ?? '#000000',
        textAlign: obj.textAlign ?? 0,
        verticalAlign: obj.verticalAlign ?? 0,
        opacity: obj.opacity ?? 1,
        backgroundColor: obj.color ?? obj.backgroundColor,
        rect: obj.rect,
        fontPostScriptName: obj.fontPostScriptName,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function goToStep(step: Step) {
  for (const panel of ['upload', 'process', 'edit', 'multitool'] as const) {
    const panelStep = { upload: 1, process: 2, edit: 3, multitool: 4 }[panel];
    const panelEl = el(`bb-panel-${panel}`);
    if (panelEl) panelEl.classList.toggle('hidden', panelStep !== step);
  }

  document.querySelectorAll<HTMLElement>('.bb-step').forEach((stepEl) => {
    const n = Number(stepEl.dataset.step);
    stepEl.classList.toggle('bb-step-active', n === step);
    stepEl.classList.toggle('bb-step-done', n < step);
  });

  const downloadCurrentBtn = el<HTMLButtonElement>('bb-download-current');
  const startOverBtn = el<HTMLButtonElement>('bb-start-over');
  if (downloadCurrentBtn)
    downloadCurrentBtn.classList.toggle('hidden', step < 2);
  if (startOverBtn) startOverBtn.classList.toggle('hidden', step < 2);
}

function resetAll() {
  uploadedFiles = [];
  mergedBytes = null;
  editorInitialized = false;
  viewerInstance = null;
  docManagerPlugin = null;
  viewerRegistry = null;
  exportPluginRef = null;
  annotationPluginRef = null;

  if (fileListSortable) {
    fileListSortable.destroy();
    fileListSortable = null;
  }
  const uploadArea = el('bb-file-display-area');
  if (uploadArea) uploadArea.innerHTML = '';
  const startBtn = el<HTMLButtonElement>('bb-start-btn');
  if (startBtn) startBtn.classList.add('hidden');
  const fileInput = el<HTMLInputElement>('bb-file-input');
  if (fileInput) fileInput.value = '';

  const editContainer = el('bb-embed-pdf-container');
  if (editContainer) editContainer.textContent = '';

  const multiToolFrame = el<HTMLIFrameElement>('bb-multitool-frame');
  if (multiToolFrame) multiToolFrame.src = 'about:blank';

  goToStep(1);
}

function renderFileList() {
  const container = el('bb-file-display-area');
  const startBtn = el<HTMLButtonElement>('bb-start-btn');
  if (!container) return;
  container.innerHTML = '';

  uploadedFiles.forEach((file, index) => {
    const fileDiv = document.createElement('div');
    fileDiv.className =
      'flex items-center justify-between bg-gray-700 p-3 rounded-lg text-sm cursor-grab active:cursor-grabbing';

    const dragHandle = document.createElement('div');
    dragHandle.className =
      'text-gray-400 p-1 mr-2 flex-shrink-0 pointer-events-none';
    dragHandle.innerHTML = '<i data-lucide="menu" class="w-4 h-4"></i>';

    const infoContainer = document.createElement('div');
    infoContainer.className = 'flex flex-col overflow-hidden flex-1';

    const nameSpan = document.createElement('div');
    nameSpan.className = 'truncate font-medium text-gray-200 text-sm mb-1';
    nameSpan.textContent = file.name;

    const metaSpan = document.createElement('div');
    metaSpan.className = 'text-xs text-gray-400';
    metaSpan.textContent = formatBytes(file.size);

    infoContainer.append(nameSpan, metaSpan);

    const removeBtn = document.createElement('button');
    removeBtn.className =
      'bb-remove-btn ml-4 text-red-400 hover:text-red-300 flex-shrink-0 cursor-pointer';
    removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>';
    removeBtn.onclick = () => {
      uploadedFiles.splice(index, 1);
      renderFileList();
    };

    fileDiv.append(dragHandle, infoContainer, removeBtn);
    container.appendChild(fileDiv);
  });

  createIcons({ icons });
  setupFileListSortable(container);

  if (startBtn) startBtn.classList.toggle('hidden', uploadedFiles.length === 0);
}

function setupFileListSortable(container: HTMLElement) {
  if (fileListSortable) {
    fileListSortable.destroy();
    fileListSortable = null;
  }
  if (uploadedFiles.length < 2) return;

  fileListSortable = Sortable.create(container, {
    animation: 150,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    filter: '.bb-remove-btn',
    preventOnFilter: false,
    onEnd: (evt) => {
      const { oldIndex, newIndex } = evt;
      if (
        oldIndex === undefined ||
        newIndex === undefined ||
        oldIndex === newIndex
      ) {
        return;
      }
      const [moved] = uploadedFiles.splice(oldIndex, 1);
      uploadedFiles.splice(newIndex, 0, moved);
      renderFileList();
    },
  });
}

function handleFileSelect(files: FileList | null) {
  if (!files || files.length === 0) return;
  const pdfFiles = Array.from(files).filter(
    (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
  );
  if (pdfFiles.length > 0) {
    uploadedFiles.push(...pdfFiles);
    renderFileList();
  }
}

function setProcessStatus(text: string) {
  const statusEl = el('bb-process-status');
  if (statusEl) statusEl.textContent = text;
}

async function startProcessing() {
  if (uploadedFiles.length === 0) return;

  goToStep(2);
  const spinner = el('bb-process-spinner');
  // .solid-spinner sets its own `display`, which can win over the .hidden
  // utility class at equal CSS specificity depending on stylesheet order —
  // toggle the inline style directly so hiding it is never ambiguous.
  if (spinner) spinner.style.display = '';

  setProcessStatus(`Checking ${uploadedFiles.length} file(s) for passwords...`);

  let files: File[];
  try {
    files = await batchDecryptIfNeeded(uploadedFiles);
  } catch (err) {
    console.error('Big Band: batch decrypt failed', err);
    showAlert('Error', 'Something went wrong while checking for passwords.');
    goToStep(1);
    return;
  }

  if (files.length === 0) {
    showAlert(
      'No Files Remaining',
      'All files were skipped or could not be unlocked. Please try again.'
    );
    goToStep(1);
    return;
  }

  // batchDecryptIfNeeded only handles files that need a real open password.
  // PDFs restricted only by an owner/permissions password still need this
  // unconditional empty-password pass to actually strip that protection.
  const strippedBytesList: Uint8Array[] = [];
  for (let i = 0; i < files.length; i++) {
    setProcessStatus(
      `Removing owner/permission restrictions (${i + 1}/${files.length})...`
    );
    const buf = await readFileAsArrayBuffer(files[i]);
    const inputBytes = new Uint8Array(buf as ArrayBuffer);
    try {
      const { bytes } = await decryptPdfBytes(inputBytes, '');
      strippedBytesList.push(bytes);
    } catch {
      // Already plaintext (e.g. decrypted above with a real password), or
      // has no owner-level restrictions to strip — use as-is.
      strippedBytesList.push(inputBytes);
    }
  }

  setProcessStatus(
    `Merging ${strippedBytesList.length} file(s) into one PDF...`
  );
  try {
    mergedBytes = await mergePdfs(strippedBytesList);
  } catch (err) {
    console.error('Big Band: merge failed', err);
    showAlert(
      'Merge Failed',
      'Could not merge the decrypted PDFs. Please check the files and try again.'
    );
    goToStep(1);
    return;
  }

  setProcessStatus('Loading editor...');
  try {
    await initEditor(mergedBytes);
  } catch (err) {
    console.error('Big Band: editor init failed', err);
    showAlert('Error', 'Failed to load the PDF editor.');
    goToStep(1);
    return;
  } finally {
    if (spinner) spinner.style.display = 'none';
  }

  goToStep(3);
}

const DOC_EVENT_TIMEOUT_MS = 15000;

// Some rejection paths inside the viewer's document manager (e.g. hitting
// its document-count limit) settle an internal task without ever emitting
// onDocumentOpened/onDocumentError, which would otherwise hang these waits
// forever. A timeout turns that into a clear error instead of a stuck UI.
function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(message)),
      DOC_EVENT_TIMEOUT_MS
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// openDocumentBuffer only *starts* the load — it returns before the
// document is actually parsed, so treating the document as ready right
// after calling it can leave the viewer showing nothing if the load is
// still in flight (or fails) when the caller moves on. Wait for the
// plugin's own "loaded" signal, or surface its "error" signal, instead of
// assuming success.
function openDocumentAndWait(
  plugin: DocManagerPlugin,
  buffer: ArrayBuffer,
  name: string
): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      plugin.onDocumentOpened(() => resolve());
      plugin.onDocumentError((data) => {
        reject(new Error(data.message || 'Failed to load the document.'));
      });
      plugin.openDocumentBuffer({ buffer, name, autoActivate: true });
    }),
    'Timed out waiting for the document to load.'
  );
}

async function initEditor(bytes: Uint8Array) {
  if (editorInitialized) return;
  const container = el('bb-embed-pdf-container');
  if (!container) return;

  const { default: EmbedPDF } = await import('bentopdf-viewer');
  const disabledCategories = getEditorDisabledCategories();
  viewerInstance = EmbedPDF.init({
    disabledCategories,
    type: 'container',
    target: container,
    worker: true,
    wasmUrl: embedPdfWasmUrl,
    fontFallback: editorFontFallback,
    export: {
      defaultFileName: MERGED_FILE_NAME,
    },
    documentManager: {
      // 2, not 1: Big Band only ever shows one document at a time, but
      // reloading after watermark removal closes the old one and opens the
      // cleaned copy — if that open starts before the close has actually
      // taken effect, a limit of 1 would silently reject it.
      maxDocuments: 2,
    },
    tabBar: 'never',
  });

  const registry = await viewerInstance.registry;
  viewerRegistry = registry as unknown as PluginRegistryLite;
  docManagerPlugin = registry
    .getPlugin('document-manager')
    .provides() as unknown as DocManagerPlugin;
  exportPluginRef = registry.getPlugin('export').provides() as unknown as {
    saveAsCopy: () => { toPromise: () => Promise<ArrayBuffer> };
  };

  try {
    const annotationCapability = registry
      .getPlugin('annotation')
      .provides() as unknown as AnnotationCapabilityLite;
    annotationCapability.setToolDefaults('redact', REDACT_TOOL_DEFAULTS);
    annotationPluginRef = registry
      .getPlugin('annotation')
      .provides() as unknown as AnnotationPluginLite;
  } catch {
    // Annotation plugin unavailable (e.g. redaction disabled); keep viewer defaults.
  }

  const file = new File([bytes.slice().buffer], MERGED_FILE_NAME, {
    type: 'application/pdf',
  });
  const buffer = await file.arrayBuffer();
  await openDocumentAndWait(docManagerPlugin, buffer, MERGED_FILE_NAME);

  editorInitialized = true;
}

async function exportCurrentEditorBytes(): Promise<Uint8Array> {
  if (!exportPluginRef) {
    throw new Error('Editor is not initialized.');
  }
  const arrayBuffer = await exportPluginRef.saveAsCopy().toPromise();
  let outBytes: Uint8Array = new Uint8Array(arrayBuffer);

  const customFontAnnots = collectSystemFontFreeTexts(annotationPluginRef);
  if (customFontAnnots.length > 0) {
    try {
      const { embedFreeTextSystemFonts } =
        await import('../utils/freetext-font-embed.js');
      outBytes = await embedFreeTextSystemFonts(outBytes, customFontAnnots);
    } catch (err) {
      console.error('Font embed pass failed:', err);
    }
  }

  return outBytes;
}

async function downloadCurrentPdf() {
  try {
    let bytes: Uint8Array;
    if (editorInitialized) {
      bytes = await exportCurrentEditorBytes();
    } else if (mergedBytes) {
      bytes = mergedBytes;
    } else {
      return;
    }
    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
    downloadFile(blob, MERGED_FILE_NAME);
  } catch (err) {
    console.error('Big Band: download failed', err);
    showAlert('Error', 'Failed to download the current PDF.');
  }
}

async function findAndRedactAll() {
  const input = el<HTMLInputElement>('bb-redact-search-input');
  const query = input?.value.trim() ?? '';
  if (!query) {
    showAlert('Search Text Required', 'Enter the text you want to redact.');
    return;
  }
  if (!viewerRegistry || !docManagerPlugin) {
    showAlert('Error', 'The editor is not ready yet.');
    return;
  }
  const documentId = docManagerPlugin.getActiveDocumentId();
  if (!documentId) {
    showAlert('Error', 'No document is open.');
    return;
  }

  showLoader(`Searching for "${query}"...`);
  try {
    const count = await redactAllOccurrences(viewerRegistry, documentId, query);
    if (count === 0) {
      showAlert('No Matches', `"${query}" was not found in this document.`);
      return;
    }
    openRedactionPanel(viewerRegistry, documentId);
  } catch (err) {
    console.error('Big Band: find and redact failed', err);
    showAlert('Error', 'Failed to search and mark redactions.');
  } finally {
    hideLoader();
  }
}

async function removeWatermarksFromDocument() {
  if (!editorInitialized || !docManagerPlugin) {
    showAlert('Error', 'The editor is not ready yet.');
    return;
  }
  const documentId = docManagerPlugin.getActiveDocumentId();
  if (!documentId) {
    showAlert('Error', 'No document is open.');
    return;
  }

  showLoader('Scanning for watermarks...');
  try {
    const currentBytes = await exportCurrentEditorBytes();
    const scan = await scanForWatermarks(currentBytes);

    if (scan.candidates.length === 0) {
      showAlert(
        'No Watermarks Found',
        'No repeated watermark images were detected in this document.'
      );
      return;
    }

    showLoader('Removing watermarks...');
    const { bytes: cleanedBytes, removedCount } = await removeWatermarks(
      scan,
      scan.candidates.map((c) => c.id)
    );

    // Reload the cleaned document into the same viewer instance so the
    // result is visible immediately and further edits/redactions apply on
    // top of it. Wait for the close to actually take effect before opening
    // the replacement — starting the open too early raced the close in
    // testing (maxDocuments is 2, not 1, for the same reason).
    await withTimeout(
      new Promise<void>((resolve) => {
        docManagerPlugin?.onDocumentClosed(() => resolve());
        docManagerPlugin?.closeDocument(documentId);
      }),
      'Timed out waiting for the previous document to close.'
    );
    const file = new File([cleanedBytes.slice().buffer], MERGED_FILE_NAME, {
      type: 'application/pdf',
    });
    const buffer = await file.arrayBuffer();
    await openDocumentAndWait(docManagerPlugin, buffer, MERGED_FILE_NAME);
    mergedBytes = cleanedBytes;

    showAlert(
      'Watermarks Removed',
      `Removed ${removedCount} watermark instance(s) from this document.`,
      'success'
    );
  } catch (err) {
    console.error('Big Band: watermark removal failed', err);
    showAlert('Error', 'Failed to scan or remove watermarks.');
  } finally {
    hideLoader();
  }
}

let multiToolMessageHandler: ((event: MessageEvent) => void) | null = null;

function goToMultiTool(bytes: Uint8Array) {
  const frame = el<HTMLIFrameElement>('bb-multitool-frame');
  if (!frame) return;

  if (multiToolMessageHandler) {
    window.removeEventListener('message', multiToolMessageHandler);
    multiToolMessageHandler = null;
  }

  multiToolMessageHandler = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    if (event.source !== frame.contentWindow) return;
    const data = event.data as { type?: string } | null;
    if (!data || data.type !== `${MULTI_TOOL_ORIGIN_MSG_PREFIX}multitool-ready`)
      return;

    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    frame.contentWindow?.postMessage(
      {
        type: `${MULTI_TOOL_ORIGIN_MSG_PREFIX}load-files`,
        files: [{ name: MERGED_FILE_NAME, buffer }],
      },
      window.location.origin,
      [buffer]
    );
  };
  window.addEventListener('message', multiToolMessageHandler);

  frame.src =
    import.meta.env.BASE_URL + 'pdf-multi-tool.html?embedded=big-band';
  goToStep(4);
}

function initializePage() {
  createIcons({ icons });

  const fileInput = el<HTMLInputElement>('bb-file-input');
  const dropZone = el('bb-drop-zone');

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      handleFileSelect((e.target as HTMLInputElement).files);
    });
    fileInput.addEventListener('click', () => {
      fileInput.value = '';
    });
  }

  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('bg-gray-700');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('bg-gray-700');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('bg-gray-700');
      handleFileSelect(e.dataTransfer?.files ?? null);
    });
  }

  el<HTMLButtonElement>('bb-start-btn')?.addEventListener('click', () => {
    void startProcessing();
  });

  el<HTMLButtonElement>('bb-download-edited')?.addEventListener('click', () => {
    void downloadCurrentPdf();
  });

  el<HTMLButtonElement>('bb-redact-search-btn')?.addEventListener(
    'click',
    () => {
      void findAndRedactAll();
    }
  );
  el<HTMLInputElement>('bb-redact-search-input')?.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void findAndRedactAll();
      }
    }
  );

  el<HTMLButtonElement>('bb-remove-watermarks-btn')?.addEventListener(
    'click',
    () => {
      void removeWatermarksFromDocument();
    }
  );

  el<HTMLButtonElement>('bb-continue-to-multitool')?.addEventListener(
    'click',
    async () => {
      showLoader('Preparing Multi Tool...');
      try {
        const bytes = await exportCurrentEditorBytes();
        mergedBytes = bytes;
        goToMultiTool(bytes);
      } catch (err) {
        console.error('Big Band: continue to multi tool failed', err);
        showAlert('Error', 'Failed to hand the PDF off to the Multi Tool.');
      } finally {
        hideLoader();
      }
    }
  );

  el<HTMLButtonElement>('bb-download-current')?.addEventListener(
    'click',
    () => {
      void downloadCurrentPdf();
    }
  );

  el<HTMLButtonElement>('bb-start-over')?.addEventListener('click', () => {
    resetAll();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePage);
} else {
  initializePage();
}
