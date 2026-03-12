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
