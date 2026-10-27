// The quote a reply carries below its own text: an "On <date> <name> <address> wrote:" line over the earlier
// message in a blockquote. React-free, so the mail composer quotes with it on reply and the API's demo seed writes
// its threads with it, and a seeded reply reads like one sent from Eigen.

import { formatFullDateTime } from '@workspace/lib/date';
import { escapeHtml } from '@workspace/lib/html';

// `html` goes in as it is, so the caller passes HTML that is already safe: a sanitized body or escaped text.
export function formatReplyQuote(from: { name: string; address: string }, date: Date, html: string): string {
    const header = `On ${escapeHtml(formatFullDateTime(date))} ${escapeHtml(from.name)} &lt;${escapeHtml(from.address)}&gt; wrote:`;
    return `<br><br><p>${header}</p><blockquote>${html}</blockquote>`;
}
