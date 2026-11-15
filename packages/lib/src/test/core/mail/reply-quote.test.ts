// A reply's text sits straight above its quote: the quote opens with its "On … wrote:" line, never with blank lines of
// its own, so a reply the seed writes reads like one sent from Eigen.
import { expect, test } from 'bun:test';
import { formatReplyQuote } from '../../../core/mail/reply-quote';

test('the quote opens with its header line over the quoted message', () => {
    const quote = formatReplyQuote(
        { name: 'Ada', address: 'ada@example.com' },
        new Date('2026-05-04T09:05:00Z'),
        '<p>Old</p>',
    );

    expect(quote).toStartWith('<p>On ');
    expect(quote).toEndWith(' Ada &lt;ada@example.com&gt; wrote:</p><blockquote><p>Old</p></blockquote>');
});
