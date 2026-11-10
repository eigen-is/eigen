// The right-click rows of a link in the Docs body, which the editor's selection menu shows in MenuSections' groups: open,
// copy, edit and remove, as the sheet's link card offers them. A right-click on a link opens the menu even with no
// selection, which would otherwise leave the browser's own menu.

import { getMarkRange } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { copyToClipboard } from '@workspace/lib/clipboard';
import { webLinkHref } from '@workspace/lib/validation';
import type { MenuSectionsProps } from '@workspace/ui/components/context-menu';
import { DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { Copy, ExternalLink, Pencil, Unlink } from 'lucide-react';

export type LinkAtPointer = { from: number; to: number; href: string };

export function linkAtPointer(editor: Editor, event: MouseEvent): LinkAtPointer | null {
    const type = editor.schema.marks['link'];
    const onLink = event.target instanceof Element && event.target.closest('a') != null;
    const at = onLink && editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
    const range = type && at && getMarkRange(editor.state.doc.resolve(at.pos), type);
    if (!range) return null;
    const href = editor.state.doc.nodeAt(range.from)?.marks.find((mark) => mark.type === type)?.attrs['href'];
    return href ? { ...range, href } : null;
}

// onEdit opens the link dialog on the link.
export function linkMenuSections(editor: Editor, link: LinkAtPointer, onEdit: () => void): MenuSectionsProps {
    const opens = webLinkHref(link.href);
    return {
        open: opens && (
            <DropdownMenuItem onClick={() => window.open(opens, '_blank', 'noopener,noreferrer')}>
                <ExternalLink className="h-4 w-4" /> Open link
            </DropdownMenuItem>
        ),
        clipboard: (
            <DropdownMenuItem onClick={() => copyToClipboard(link.href, 'Link copied to clipboard')}>
                <Copy className="h-4 w-4" /> Copy link
            </DropdownMenuItem>
        ),
        organize: (
            <>
                <DropdownMenuItem onClick={onEdit}>
                    <Pencil className="h-4 w-4" /> Edit link
                </DropdownMenuItem>
                <DropdownMenuItem
                    variant="destructive"
                    onClick={() => editor.chain().focus().setTextSelection(link).unsetLink().run()}
                >
                    <Unlink className="h-4 w-4" /> Remove link
                </DropdownMenuItem>
            </>
        ),
    };
}
