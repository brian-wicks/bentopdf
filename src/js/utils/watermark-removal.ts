// Detects and structurally removes watermarks from a PDF.
//
// Unlike redaction (which just draws an opaque box on top of content), this
// deletes the actual `Do` invocation that draws the watermark XObject out of
// each page's content stream, leaving every other drawing instruction byte-
// identical. Nothing else on the page is touched.
//
// pdf-lib has no built-in way to read/rewrite an *existing* content stream's
// operators (it only knows how to write new ones), so this implements a
// small, deliberately narrow PDF content-stream tokenizer: just enough to
// find `q`/`Q` save/restore pairs and `/Name Do` XObject invocations,
// without needing to semantically understand any other operator. Anything
// the tokenizer can't safely reason about (an unterminated string, an
// unclosed `q`, a `Do` with no enclosing `q...Q` block) causes that specific
// occurrence — or, if the stream itself can't be parsed, that whole page —
// to be left completely untouched rather than guessed at.
//
// Two independent signals mark something as a watermark, either is enough:
//
// 1. Adobe's own watermark marker. Acrobat's "Add Watermark" (and other
//    tools that follow its convention) tags the XObject it draws with
//    `/PieceInfo/ADBE_CompoundType/Private /Watermark` — this is almost
//    certainly what Acrobat's own "Remove Watermark" button keys off, so an
//    XObject carrying it is treated as a watermark unconditionally, no
//    repetition required. Watermarks made this way are Form XObjects with
//    real drawn text (not a raster image), and often get a fresh object per
//    page rather than one shared ref — this module matches those by content
//    hash instead of by reference identity for exactly that reason.
// 2. Repetition heuristic, for watermarks with no such marker (e.g. a plain
//    image, from this app's own Add Watermark tool or a third-party one):
//    the exact same XObject (by content hash, not just by object reference)
//    is drawn on every page of a multi-page document, or 3+ times on a
//    single-page document (a tiled watermark). Genuine page content
//    essentially never repeats identically across 100% of pages, so this
//    stays conservative. Both Image and Form XObjects are matched this way.

import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFPage,
} from 'pdf-lib';

export interface WatermarkCandidate {
  id: string;
  pageCount: number;
  totalPages: number;
  occurrenceCount: number;
  approxSizeBytes: number;
}

interface TokenSpan {
  start: number;
  end: number;
  text: string | null; // populated for name ("/Foo") and bare ("q", "Do", ...) tokens
}

interface DoOccurrence {
  pageIndex: number;
  hash: string;
  sizeBytes: number;
  adobeMarked: boolean;
  removable: boolean;
  rangeStart: number;
  rangeEnd: number;
}

interface PageAnalysis {
  page: PDFPage;
  contentBytes: Uint8Array;
  occurrences: DoOccurrence[];
}

export interface WatermarkScanResult {
  candidates: WatermarkCandidate[];
  doc: PDFDocument;
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMS = new Set(
  ['(', ')', '<', '>', '[', ']', '{', '}', '/', '%'].map((c) => c.charCodeAt(0))
);

function isWhitespace(b: number): boolean {
  return WHITESPACE.has(b);
}
function isDelimiter(b: number): boolean {
  return DELIMS.has(b);
}

function skipWhitespaceAndComments(bytes: Uint8Array, pos: number): number {
  const len = bytes.length;
  while (pos < len) {
    if (isWhitespace(bytes[pos])) {
      pos++;
    } else if (bytes[pos] === 0x25 /* % */) {
      while (pos < len && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d) pos++;
    } else {
      break;
    }
  }
  return pos;
}

// Scans exactly one "value" token (string, hex string, dict, array, name, or
// a bare run of characters) starting at `pos` and returns its end offset.
// Throws if the input is malformed in a way that would make position
// tracking unreliable (unterminated string/array/dict) — callers treat this
// as "abandon this page untouched."
function skipValue(bytes: Uint8Array, pos: number): number {
  const len = bytes.length;
  pos = skipWhitespaceAndComments(bytes, pos);
  if (pos >= len) throw new Error('Unexpected end of content stream');
  const c = bytes[pos];

  if (c === 0x28 /* ( */) {
    let depth = 1;
    let i = pos + 1;
    while (depth > 0) {
      if (i >= len) throw new Error('Unterminated string');
      if (bytes[i] === 0x5c /* backslash */) {
        i += 2;
      } else if (bytes[i] === 0x28) {
        depth++;
        i++;
      } else if (bytes[i] === 0x29 /* ) */) {
        depth--;
        i++;
      } else {
        i++;
      }
    }
    return i;
  }

  if (c === 0x3c /* < */) {
    if (bytes[pos + 1] === 0x3c) {
      // Dict: << ... >>
      let depth = 1;
      let i = pos + 2;
      while (depth > 0) {
        i = skipWhitespaceAndComments(bytes, i);
        if (i >= len) throw new Error('Unterminated dict');
        if (bytes[i] === 0x3c && bytes[i + 1] === 0x3c) {
          depth++;
          i += 2;
        } else if (bytes[i] === 0x3e && bytes[i + 1] === 0x3e) {
          depth--;
          i += 2;
        } else {
          i = skipValue(bytes, i);
        }
      }
      return i;
    }
    // Hex string: < ... >
    let i = pos + 1;
    while (i < len && bytes[i] !== 0x3e) i++;
    if (i >= len) throw new Error('Unterminated hex string');
    return i + 1;
  }

  if (c === 0x5b /* [ */) {
    let i = pos + 1;
    while (true) {
      i = skipWhitespaceAndComments(bytes, i);
      if (i >= len) throw new Error('Unterminated array');
      if (bytes[i] === 0x5d /* ] */) return i + 1;
      i = skipValue(bytes, i);
    }
  }

  if (c === 0x2f /* / */) {
    let i = pos + 1;
    while (i < len && !isWhitespace(bytes[i]) && !isDelimiter(bytes[i])) i++;
    return i;
  }

  // Bare token: number, keyword/operator, or a lone delimiter we don't
  // otherwise special-case (treated as a one-byte token so we never stall).
  if (isDelimiter(c)) return pos + 1;
  let i = pos;
  while (i < len && !isWhitespace(bytes[i]) && !isDelimiter(bytes[i])) i++;
  return i;
}

function tokenText(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

// Tokenizes a whole content stream into a flat list of spans, resolving the
// literal text only for name ("/Foo") and bare-word tokens (operators,
// numbers, "BI"/"ID"/"EI") since those are the only ones this module
// inspects. Inline images (BI...ID<binary>EI) are skipped as one opaque
// span using the standard whitespace-delimited "EI" heuristic, since their
// binary payload isn't safely tokenizable as PDF syntax.
function tokenize(bytes: Uint8Array): TokenSpan[] {
  const len = bytes.length;
  const tokens: TokenSpan[] = [];
  let pos = 0;

  while (true) {
    pos = skipWhitespaceAndComments(bytes, pos);
    if (pos >= len) break;

    const c = bytes[pos];
    if (
      c === 0x2f ||
      (!isDelimiter(c) && c !== 0x28 && c !== 0x3c && c !== 0x5b)
    ) {
      // Name or bare token — the only kinds we need text for.
      const end = skipValue(bytes, pos);
      const text = tokenText(bytes, pos, end);
      tokens.push({ start: pos, end, text });

      if (text === 'BI') {
        // Inline image: skip dict-ish key/value pairs up to "ID", then the
        // raw binary payload up to a whitespace-delimited "EI".
        let i = end;
        while (true) {
          i = skipWhitespaceAndComments(bytes, i);
          if (i >= len) throw new Error('Unterminated inline image');
          const keyEnd = skipValue(bytes, i);
          const keyText = tokenText(bytes, i, keyEnd);
          i = keyEnd;
          if (keyText === 'ID') break;
          i = skipValue(bytes, i);
        }
        // One whitespace byte separates "ID" from the binary data.
        let dataStart = i;
        if (dataStart < len && isWhitespace(bytes[dataStart])) dataStart++;
        let i2 = dataStart;
        let eiEnd = -1;
        while (i2 < len - 1) {
          if (
            isWhitespace(bytes[i2]) &&
            bytes[i2 + 1] === 0x45 /* E */ &&
            bytes[i2 + 2] === 0x49 /* I */ &&
            (i2 + 3 >= len ||
              isWhitespace(bytes[i2 + 3]) ||
              isDelimiter(bytes[i2 + 3]))
          ) {
            eiEnd = i2 + 3;
            break;
          }
          i2++;
        }
        if (eiEnd === -1)
          throw new Error('Could not find inline image terminator');
        tokens.push({ start: dataStart, end: eiEnd, text: null });
        pos = eiEnd;
        continue;
      }
    } else {
      const end = skipValue(bytes, pos);
      tokens.push({ start: pos, end, text: null });
    }
    pos = tokens[tokens.length - 1].end;
  }

  return tokens;
}

function hashBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${bytes.length}-${(h >>> 0).toString(16)}`;
}

// Adobe Acrobat (and tools following its convention) tags a watermark
// XObject's dict with /PieceInfo/ADBE_CompoundType/Private /Watermark —
// an explicit, unambiguous marker, not a guess.
function isAdobeWatermarkTagged(dict: PDFDict): boolean {
  try {
    const pieceInfo = dict.lookup(PDFName.of('PieceInfo'), PDFDict);
    const compoundType = pieceInfo.lookup(
      PDFName.of('ADBE_CompoundType'),
      PDFDict
    );
    const priv = compoundType.lookup(PDFName.of('Private'));
    return priv instanceof PDFName && priv.asString() === '/Watermark';
  } catch {
    return false;
  }
}

interface WatermarkableXObject {
  ref: PDFRef;
  hash: string;
  size: number;
  adobeMarked: boolean;
}

function getWatermarkableXObjects(
  page: PDFPage
): Map<string, WatermarkableXObject> {
  const map = new Map<string, WatermarkableXObject>();
  const { context } = page.doc;
  const resources = page.node.normalizedEntries().Resources;
  const xObjectDict = resources.lookup(PDFName.of('XObject'));
  if (!xObjectDict || !('entries' in xObjectDict)) return map;

  for (const [name, value] of (
    xObjectDict as { entries: () => [PDFName, unknown][] }
  ).entries()) {
    if (!(value instanceof PDFRef)) continue;
    let stream: unknown;
    try {
      stream = context.lookup(value, PDFStream);
    } catch {
      continue;
    }
    if (!(stream instanceof PDFStream)) continue;
    const subtype = stream.dict.lookup(PDFName.of('Subtype'));
    const subtypeName = subtype instanceof PDFName ? subtype.asString() : '';
    if (subtypeName !== '/Image' && subtypeName !== '/Form') continue;

    const bytes = stream.getContents();
    map.set(name.asString().slice(1), {
      ref: value,
      hash: hashBytes(bytes),
      size: bytes.length,
      adobeMarked: isAdobeWatermarkTagged(stream.dict),
    });
  }
  return map;
}

function decodeContentStreamBytes(stream: PDFStream): Uint8Array | null {
  if (stream instanceof PDFRawStream) {
    try {
      return decodePDFRawStream(stream).decode();
    } catch {
      return null;
    }
  }
  const maybe = stream as unknown as {
    getUnencodedContents?: () => Uint8Array;
  };
  if (typeof maybe.getUnencodedContents === 'function') {
    return maybe.getUnencodedContents();
  }
  return null;
}

function getPageContentBytes(page: PDFPage): Uint8Array | null {
  const contentsArray = page.node.normalizedEntries().Contents;
  if (!contentsArray) return null;
  const { context } = page.doc;
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < contentsArray.size(); i++) {
    const ref = contentsArray.get(i);
    if (!(ref instanceof PDFRef)) continue;
    let stream: unknown;
    try {
      stream = context.lookup(ref, PDFStream);
    } catch {
      continue;
    }
    if (!(stream instanceof PDFStream)) continue;
    const decoded = decodeContentStreamBytes(stream);
    if (!decoded) continue;
    chunks.push(decoded);
    chunks.push(new Uint8Array([0x0a]));
  }
  if (chunks.length === 0) return null;
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function analyzePage(page: PDFPage, pageIndex: number): PageAnalysis | null {
  const contentBytes = getPageContentBytes(page);
  if (!contentBytes) return null;

  let tokens: TokenSpan[];
  try {
    tokens = tokenize(contentBytes);
  } catch (err) {
    console.warn(
      `[watermark-removal] Skipping page ${pageIndex + 1}: ${(err as Error).message}`
    );
    return null;
  }

  const xObjects = getWatermarkableXObjects(page);
  if (xObjects.size === 0) return { page, contentBytes, occurrences: [] };

  // Pass A: match every "q" to its "Q", and record the innermost open "q"
  // token index at the moment each other token is reached.
  const qStack: number[] = [];
  const qToQ = new Map<number, number>();
  const enclosingQAt: (number | null)[] = new Array(tokens.length).fill(null);
  for (let i = 0; i < tokens.length; i++) {
    enclosingQAt[i] = qStack.length > 0 ? qStack[qStack.length - 1] : null;
    if (tokens[i].text === 'q') {
      qStack.push(i);
    } else if (tokens[i].text === 'Q' && qStack.length > 0) {
      const qi = qStack.pop() as number;
      qToQ.set(qi, i);
    }
  }

  // Pass B: find "/Name Do" invocations of known Image/Form XObjects.
  const occurrences: DoOccurrence[] = [];
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].text !== 'Do') continue;
    const nameTok = tokens[i - 1];
    if (!nameTok.text || !nameTok.text.startsWith('/')) continue;
    const xObject = xObjects.get(nameTok.text.slice(1));
    if (!xObject) continue;

    const qi = enclosingQAt[i];
    const Qi = qi != null ? qToQ.get(qi) : undefined;
    const removable = qi != null && Qi != null;
    occurrences.push({
      pageIndex,
      hash: xObject.hash,
      sizeBytes: xObject.size,
      adobeMarked: xObject.adobeMarked,
      removable,
      rangeStart: removable ? tokens[qi as number].start : -1,
      rangeEnd: removable ? tokens[Qi as number].end : -1,
    });
  }

  return { page, contentBytes, occurrences };
}

/**
 * Loads a PDF and scans every page for images that repeat across the whole
 * document (or are heavily tiled on a single-page document) — the signature
 * of a watermark. Returns candidates for the caller to present for review,
 * plus the loaded document so `removeWatermarks` can act on the same
 * in-memory copy without re-parsing.
 */
export async function scanForWatermarks(
  pdfBytes: Uint8Array
): Promise<WatermarkScanResult> {
  const loadOpts = { ignoreEncryption: true, throwOnInvalidObject: false };
  let doc: PDFDocument;
  let pages: PDFPage[];
  try {
    doc = await PDFDocument.load(pdfBytes, loadOpts);
    // pdf-lib's `throwOnInvalidObject: false` can swallow corruption during
    // load() itself and only surface it here, once the page tree actually
    // needs to be walked — so this call has to be inside the try too.
    pages = doc.getPages();
  } catch (err) {
    // Real-world PDFs (especially ones that have already passed through
    // other watermarking/editing tools) are often structurally messy in
    // ways pdf-lib's parser alone can't recover from. Fall back to the
    // same qpdf-repair pass used everywhere else in this app before
    // giving up.
    console.warn(
      '[watermark-removal] Direct load failed, retrying with repair:',
      err
    );
    const { loadPdfDocument } = await import('./load-pdf-document.js');
    doc = await loadPdfDocument(pdfBytes, loadOpts);
    pages = doc.getPages();
  }
  const totalPages = pages.length;

  const byHash = new Map<
    string,
    {
      pages: Set<number>;
      occurrenceCount: number;
      sizeBytes: number;
      adobeMarked: boolean;
    }
  >();

  for (let i = 0; i < pages.length; i++) {
    const analysis = analyzePage(pages[i], i);
    if (!analysis) continue;
    for (const occ of analysis.occurrences) {
      let entry = byHash.get(occ.hash);
      if (!entry) {
        entry = {
          pages: new Set(),
          occurrenceCount: 0,
          sizeBytes: occ.sizeBytes,
          adobeMarked: false,
        };
        byHash.set(occ.hash, entry);
      }
      entry.pages.add(occ.pageIndex);
      entry.occurrenceCount++;
      if (occ.adobeMarked) entry.adobeMarked = true;
    }
  }

  const candidates: WatermarkCandidate[] = [];
  for (const [hash, entry] of byHash) {
    // Adobe's explicit watermark marker is trusted outright, no repetition
    // required. Otherwise: "appears on every page" is only a meaningful
    // signal once there's more than one page to repeat across — for a
    // single-page document it's trivially true of any image used at all, so
    // that case instead requires genuine tiling (drawn 3+ times on the page).
    const isWatermark =
      entry.adobeMarked ||
      (totalPages > 1
        ? entry.pages.size === totalPages
        : entry.occurrenceCount >= 3);
    if (!isWatermark) continue;
    candidates.push({
      id: hash,
      pageCount: entry.pages.size,
      totalPages,
      occurrenceCount: entry.occurrenceCount,
      approxSizeBytes: entry.sizeBytes,
    });
  }

  candidates.sort((a, b) => b.occurrenceCount - a.occurrenceCount);
  return { candidates, doc };
}

function excise(
  bytes: Uint8Array,
  ranges: Array<[number, number]>
): Uint8Array {
  if (ranges.length === 0) return bytes;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  const chunks: Uint8Array[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    chunks.push(bytes.subarray(cursor, start));
    cursor = end;
  }
  chunks.push(bytes.subarray(cursor));

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Removes the selected watermark candidates (by id, from a prior
 * `scanForWatermarks` call) from every page they appear on, by deleting
 * just the `q ... Do ... Q` block that draws them — nothing else in any
 * page's content stream is modified. Pages with no selected occurrences are
 * left completely untouched. Returns the saved PDF bytes and how many
 * watermark instances were actually removed.
 */
export async function removeWatermarks(
  scan: WatermarkScanResult,
  selectedIds: string[]
): Promise<{ bytes: Uint8Array; removedCount: number }> {
  const selected = new Set(selectedIds);
  const pages = scan.doc.getPages();
  let removedCount = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const analysis = analyzePage(page, i);
    if (!analysis) continue;

    const toRemove = analysis.occurrences.filter(
      (o) => selected.has(o.hash) && o.removable
    );
    if (toRemove.length === 0) continue;

    const ranges: Array<[number, number]> = toRemove.map((o) => [
      o.rangeStart,
      o.rangeEnd,
    ]);
    const newBytes = excise(analysis.contentBytes, ranges);
    removedCount += toRemove.length;

    const newStream = scan.doc.context.flateStream(newBytes);
    const newRef = scan.doc.context.register(newStream);
    page.node.set(PDFName.Contents, newRef);
  }

  const bytes = await scan.doc.save();
  return { bytes, removedCount };
}
