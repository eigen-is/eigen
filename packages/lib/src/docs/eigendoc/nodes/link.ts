import { combineTransactionSteps, getChangedRanges } from '@tiptap/core';
import type { LinkOptions } from '@tiptap/extension-link';
import Link, { isAllowedUri } from '@tiptap/extension-link';
import type { MarkType, Node } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { tokenize } from 'linkifyjs';

const TRAILING_WORD = /(\S+)\s*$/;

// A textblock's text from its start to `to`, each character beside its position. A node other than text is one space
// at its own position, a footnote included, whose note is no part of the sentence around its reference.
function textWithPositions(block: Node, start: number, to: number): { text: string; positions: number[] } {
    let text = '';
    const positions: number[] = [];
    block.forEach((child, offset) => {
        const pos = start + offset;
        if (pos >= to) return;
        const chars = child.isText ? (child.text ?? '').slice(0, to - pos) : ' ';
        for (let i = 0; i < chars.length; i++) positions.push(pos + i);
        text += chars;
    });
    return { text, positions };
}

// Adapted from @tiptap/extension-link's autolink (MIT): a link alone, or one in brackets.
function isLinkStructure(tokens: { isLink: boolean; value: string }[]): boolean {
    if (tokens.length === 1) return tokens[0]?.isLink ?? false;
    return (
        tokens.length === 3 && !!tokens[1]?.isLink && ['()', '[]'].includes(`${tokens[0]?.value}${tokens[2]?.value}`)
    );
}

// Adapted from @tiptap/extension-link's autolink (MIT): it links the word a space or a new paragraph ends, read
// through its own text walk. TipTap's reads the paragraph with textBetween, which reads a footnote's note in its
// reference's place, so past a reference its offsets miss the doc's positions: it linked "hen example" for a typed
// "then example.com".
function autolink(type: MarkType, options: EigenLinkOptions): Plugin {
    const { protocols, defaultProtocol } = options;
    const allowed = (url: string) =>
        options.isAllowedUri(url, {
            defaultValidate: (href) => !!isAllowedUri(href, protocols),
            protocols,
            defaultProtocol,
        });
    return new Plugin({
        key: new PluginKey('eigenAutolink'),
        appendTransaction(transactions, oldState, newState) {
            if (
                !transactions.some((tr) => tr.docChanged) ||
                oldState.doc.eq(newState.doc) ||
                transactions.some((tr) => tr.getMeta('preventAutolink') || options.remote(tr))
            )
                return null;
            const { tr } = newState;
            for (const { newRange } of getChangedRanges(combineTransactionSteps(oldState.doc, [...transactions]))) {
                // The first textblock the change reaches, whole when it reaches more than one (a new paragraph), else up
                // to the change's end, which a space ends.
                const blocks: { node: Node; pos: number }[] = [];
                newState.doc.nodesBetween(newRange.from, newRange.to, (node, pos) => {
                    if (node.isTextblock) blocks.push({ node, pos });
                    return !node.isTextblock;
                });
                const [block] = blocks;
                if (!block) continue;
                if (blocks.length === 1 && !/\s$/.test(newState.doc.textBetween(newRange.from, newRange.to, ' ', ' ')))
                    continue;
                const to = blocks.length > 1 ? block.pos + block.node.nodeSize - 1 : newRange.to;
                const { text, positions } = textWithPositions(block.node, block.pos + 1, to);
                const word = TRAILING_WORD.exec(text);
                if (!word?.[1]) continue;
                const tokens = tokenize(word[1]).map((token) => token.toObject(defaultProtocol));
                if (!isLinkStructure(tokens)) continue;
                for (const link of tokens) {
                    const from = positions[word.index + link.start];
                    const last = positions[word.index + link.end - 1];
                    if (!link.isLink || from === undefined || last === undefined) continue;
                    const end = last + 1;
                    const code = newState.schema.marks['code'];
                    if (code && newState.doc.rangeHasMark(from, end, code)) continue;
                    if (!allowed(link.value) || !options.shouldAutoLink(link.value)) continue;
                    if (newState.doc.rangeHasMark(from, end, type)) continue;
                    tr.addMark(from, end, type.create({ href: link.href }));
                }
            }
            return tr.steps.length > 0 ? tr : null;
        },
    });
}

// remote: a transaction the editor's binding applied, a peer's change or an undo, which y-tiptap writes as a replace of
// the whole doc, so the first textblock would link again here what its writer never linked.
type EigenLinkOptions = LinkOptions & { remote: (tr: Transaction) => boolean };

// StarterKit's link with the autolink above in place of TipTap's, which is configured off (`autolink: false`); the mark
// stays inclusive, as it is with TipTap's on, so text typed at a link's end joins it. Clear formatting keeps it, as
// Google Docs' does.
export const EigenLink = Link.extend<EigenLinkOptions>({
    inclusive: () => true,
    clearable: false,
    addOptions() {
        return { ...Link.options, remote: () => false };
    },
    addProseMirrorPlugins() {
        return [autolink(this.type, this.options), ...(this.parent?.() ?? [])];
    },
});
