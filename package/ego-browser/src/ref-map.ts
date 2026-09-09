export class RefMap {
  map: Map<string, any>;
  /**
   * Token of the document these refs were taken from. A backendNodeId is only
   * meaningful inside one document, and Chrome reuses the numbers after a
   * navigation, so without this a `@N` could read an unrelated element of the
   * new page and look perfectly successful.
   */
  documentToken: string | null;

  constructor() {
    this.map = new Map();
    this.documentToken = null;
  }

  add(refId, backendNodeId, role, name, nth = undefined) {
    this.addWithFrame(refId, backendNodeId, role, name, nth, undefined);
  }

  addWithFrame(
    refId,
    backendNodeId,
    role,
    name,
    nth = undefined,
    frameId = undefined,
  ) {
    this.map.set(refId, {
      backendNodeId,
      role,
      name,
      nth,
      selector: undefined,
      frameId,
    });
  }

  get(refId) {
    return this.map.get(refId);
  }

  remove(refId) {
    this.map.delete(refId);
  }

  clear() {
    this.map.clear();
    this.documentToken = null;
  }
}

export function parseRef(input) {
  const trimmed = String(input || "").trim();
  for (const candidate of [
    trimmed.startsWith("@") ? trimmed.slice(1) : null,
    trimmed.startsWith("ref=") ? trimmed.slice(4) : null,
    trimmed,
  ]) {
    if (candidate && /^\d+$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** One wording for "@… is not a ref", used by every path that can meet one. */
export function invalidRefMessage(value: unknown): string {
  return `${String(value).trim()} is not a valid ref: a ref is "@" plus the number a snapshot row prints, such as "@1522". Run page.snapshot() and copy one from a row, or use a semantic locator like page.getByRole(role, { name }).`;
}

/** Per-document token, created on first read and gone after a navigation. */
export const DOCUMENT_TOKEN_JS =
  "(() => { const w = globalThis; if (!w.__egoRefDoc) { w.__egoRefDoc = String(Date.now()) + Math.random().toString(36).slice(2); } return w.__egoRefDoc; })()";

/** The message for a ref taken from a page that is no longer loaded. */
export function refFromOtherDocumentMessage(refId: unknown): string {
  return `Ref @${refId} was taken from a page that is no longer loaded (the tab navigated or reloaded), so it cannot be resolved here. Waiting will not bring it back: run page.snapshot() again and use a ref from the new page, or use a semantic locator such as page.getByRole(role, { name }).`;
}
