import type {Context} from "../context";
import {copy} from "./selection";

// Keyboard Ctrl+X and the Edit > Cut menu item both call this. Equivalent to
// copy-then-mark-as-cut: handlePaste reads luckysheet_paste_iscut to decide
// whether to clear the source range after writing.
export function handleCut(ctx: Context) {
    copy(ctx);
    ctx.luckysheet_paste_iscut = true;
}

// Pending copy data — set by the copy handler, consumed by the native copy event listener
let _pendingCopyHtml: string | null = null;
let _pendingPlainText: string | null = null;

export function setPendingCopy(html: string) {
    _pendingCopyHtml = html;
    const el = document.createElement("div");
    el.innerHTML = html;
    _pendingPlainText = el.innerText || el.textContent || "";
    sessionStorage.setItem("localClipboard", _pendingPlainText);
}

export function consumePendingCopy(): { html: string; plainText: string } | null {
    if (!_pendingCopyHtml) return null;
    const result = {html: _pendingCopyHtml, plainText: _pendingPlainText || ""};
    _pendingCopyHtml = null;
    _pendingPlainText = null;
    return result;
}
