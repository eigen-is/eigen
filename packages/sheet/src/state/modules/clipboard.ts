import type { Context } from '../context';
import { handleCopy } from '../events/copy';

export function handleCut(ctx: Context) {
    if (handleCopy(ctx)) {
        ctx.pasteIsCut = true;
    }
}

// Pending copy data — set by the copy handler, consumed by the native copy event listener
let _pendingCopyHtml: string | null = null;
let _pendingPlainText: string | null = null;
let _pendingCellText: string | null = null;

export function setPendingCopy(html: string, plainText: string, cellText: string) {
    _pendingCopyHtml = html;
    _pendingPlainText = plainText;
    _pendingCellText = cellText;
    sessionStorage.setItem('localClipboard', plainText);
}

export function consumePendingCopy(): { html: string; plainText: string; cellText: string } | null {
    if (!_pendingCopyHtml) return null;
    const result = { html: _pendingCopyHtml, plainText: _pendingPlainText || '', cellText: _pendingCellText || '' };
    _pendingCopyHtml = null;
    _pendingPlainText = null;
    _pendingCellText = null;
    return result;
}

// Menu-triggered cut/copy run outside a native clipboard event, so the browser
// never writes the system clipboard on its own — a later Ctrl-V would paste stale
// OS-clipboard content. execCommand('copy') synthesizes that event synchronously;
// the Workbook 'copy' listener then writes every MIME type (the eigen marker and
// application/eigen-clipboard included), which navigator.clipboard.write cannot.
export function flushPendingCopy() {
    if (_pendingCopyHtml == null) return;
    document.execCommand('copy');
}

export async function readClipboardText(): Promise<string> {
    try {
        const text = await navigator.clipboard.readText();
        if (text) return text;
    } catch {
        // Clipboard read can be blocked by permissions — fall back to the session copy.
    }
    return sessionStorage.getItem('localClipboard') ?? '';
}
