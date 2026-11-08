// The clipboard as handlePaste reads it, for tests that drive a paste without a DOM: a paste of the workbook's own copy
// or of text from elsewhere.

import type { Context } from '../../../state/context';
import { handlePaste } from '../../../state/events/paste';

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
