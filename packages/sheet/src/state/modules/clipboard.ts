// The grid's side of the system clipboard. A copy or a cut of cells keeps what it wrote here as the pending copy,
// and the Workbook's copy listener takes it and puts it on the clipboard. A menu row has no copy event of its own, so
// it fires one, for cells and for a selected image or chart alike. A paste from a menu reads the clipboard's text.

type PendingCopy = { html: string; plainText: string; cellText: string };

let pending: PendingCopy | null = null;

export function setPendingCopy(html: string, plainText: string, cellText: string) {
    pending = { html, plainText, cellText };
    sessionStorage.setItem('localClipboard', plainText);
}

export function consumePendingCopy(): PendingCopy | null {
    const result = pending;
    pending = null;
    return result;
}

// A copy from a menu runs outside a copy event, so the browser never writes the system clipboard by itself, and a
// later Ctrl-V would paste what was there before. execCommand('copy') fires the event at once. The Workbook's listener
// then writes every MIME type, the Eigen ones included, which navigator.clipboard.write cannot.
export function flushPendingCopy() {
    if (pending == null) return;
    document.execCommand('copy');
}

// A selected image or chart writes itself in the Workbook's copy and cut listener, which a menu row reaches through
// the event execCommand fires, so a menu copies and cuts the way ⌘C and ⌘X do.
export function copyActiveObject(cut: boolean) {
    document.execCommand(cut ? 'cut' : 'copy');
}

export async function readClipboardText(): Promise<string> {
    try {
        const text = await navigator.clipboard.readText();
        if (text) return text;
    } catch {
        // The browser can refuse the read, so the text of the last copy in this tab stands in.
    }
    return sessionStorage.getItem('localClipboard') ?? '';
}
