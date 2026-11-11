// The clipboard as handlePaste reads it, for tests that drive a paste without a DOM: a paste of the workbook's own copy
// or of text from elsewhere, and what a copy writes there.

import type { Context } from '../../../state/context';
import { handlePaste } from '../../../state/events/paste';
import { consumePendingCopy, copy } from '../../../state/modules/clipboard';
import type { Selection } from '../../../state/types';

export function clipboardWith({ html = '', text = '' }: { html?: string; text?: string }) {
    const types: Record<string, string> = { 'text/html': html, 'text/plain': text };
    return { getData: (type: string) => types[type] ?? '', files: [] };
}

export function pasteCopy(ctx: Context) {
    handlePaste(ctx, clipboardWith({ html: `<table data-copy-id="${ctx.copyState?.id}"></table>` }));
}

export function pasteText(ctx: Context, text: string) {
    handlePaste(ctx, clipboardWith({ text }));
}

// What a copy of the ranges puts on the clipboard.
export function copied(ctx: Context, ranges: Selection[]) {
    ctx.selections = ranges;
    copy(ctx);
    return consumePendingCopy();
}
