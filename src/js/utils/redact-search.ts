// Finds every occurrence of a text string in an open bentopdf-viewer document
// and marks each one as a pending redaction (a reviewable box, matching what
// manually drawing a redact box produces) rather than destructively applying
// it immediately.
//
// bentopdf-viewer doesn't publish TypeScript types for its search/redaction
// plugin capabilities (their .d.ts files re-export from @embedpdf/* packages
// that aren't installed as resolvable modules here), so the shapes below are
// the minimal structural subset needed, confirmed against the plugins'
// actual runtime API — see plugin manifests with provides:["search"] /
// provides:["redaction"] and their buildCapability()/createRedactionScope()
// method lists in the bundled bentopdf-viewer package.

export interface RedactSearchRect {
  origin: { x: number; y: number };
  size: { width: number; height: number };
}

interface SearchResultLite {
  pageIndex: number;
  rects: RedactSearchRect[];
}

interface SearchTaskLite {
  toPromise: () => Promise<{ results: SearchResultLite[]; total: number }>;
}

interface SearchCapabilityLite {
  searchAllPages: (query: string, documentId: string) => SearchTaskLite;
}

interface RedactionItemLite {
  id: string;
  kind: 'text';
  page: number;
  rect: RedactSearchRect;
  rects: RedactSearchRect[];
}

interface RedactionScopeLite {
  addPending: (items: RedactionItemLite[]) => void;
}

interface RedactionCapabilityLite {
  forDocument: (documentId: string) => RedactionScopeLite;
}

export interface PluginRegistryLite {
  getPlugin: (id: string) => { provides: () => unknown };
}

interface ResolvedCommandLite {
  active?: boolean;
}

interface CommandScopeLite {
  execute: (commandId: string, source?: string) => void;
  resolve: (commandId: string) => ResolvedCommandLite;
}

interface CommandsCapabilityLite {
  forDocument: (documentId: string) => CommandScopeLite;
}

const REDACTION_PANEL_COMMAND = 'panel:toggle-redaction';

function boundingRect(rects: RedactSearchRect[]): RedactSearchRect {
  const minX = Math.min(...rects.map((r) => r.origin.x));
  const minY = Math.min(...rects.map((r) => r.origin.y));
  const maxX = Math.max(...rects.map((r) => r.origin.x + r.size.width));
  const maxY = Math.max(...rects.map((r) => r.origin.y + r.size.height));
  return {
    origin: { x: minX, y: minY },
    size: { width: maxX - minX, height: maxY - minY },
  };
}

function generateRedactionId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `redact-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Searches the whole document for `query` and queues every occurrence as a
 * pending redaction. Returns the number of occurrences marked. The caller
 * still needs to apply/commit the pending redactions (e.g. via the viewer's
 * own "Redact All" action) to actually burn them into the page.
 */
export async function redactAllOccurrences(
  registry: PluginRegistryLite,
  documentId: string,
  query: string
): Promise<number> {
  const trimmed = query.trim();
  if (!trimmed) return 0;

  const searchCapability = registry
    .getPlugin('search')
    .provides() as unknown as SearchCapabilityLite;
  const redactionCapability = registry
    .getPlugin('redaction')
    .provides() as unknown as RedactionCapabilityLite;

  const { results } = await searchCapability
    .searchAllPages(trimmed, documentId)
    .toPromise();

  const items: RedactionItemLite[] = results
    .filter((r) => r.rects.length > 0)
    .map((r) => ({
      id: generateRedactionId(),
      kind: 'text',
      page: r.pageIndex,
      rect: boundingRect(r.rects),
      rects: r.rects,
    }));

  if (items.length === 0) return 0;

  redactionCapability.forDocument(documentId).addPending(items);

  return items.length;
}

/**
 * Opens the redaction review panel/sidebar for the given document, if it
 * isn't already open, using the viewer's own "panel:toggle-redaction"
 * command so the user immediately sees the pending redactions just queued.
 * A no-op (logged, not thrown) if the commands plugin isn't available.
 */
export function openRedactionPanel(
  registry: PluginRegistryLite,
  documentId: string
): void {
  try {
    const commandsCapability = registry
      .getPlugin('commands')
      .provides() as unknown as CommandsCapabilityLite;
    const scope = commandsCapability.forDocument(documentId);
    const resolved = scope.resolve(REDACTION_PANEL_COMMAND);
    if (!resolved.active) {
      scope.execute(REDACTION_PANEL_COMMAND);
    }
  } catch (err) {
    console.warn('[redact-search] Could not open redaction panel:', err);
  }
}
