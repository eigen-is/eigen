import { getDriveItemUrl, getDriveShareUrl, openDocument } from '@workspace/lib/api';
import { copyToClipboard } from '@workspace/lib/clipboard';
import type { Command } from '@workspace/lib/types/command-palette';
import { isOpenable } from '@workspace/lib/types/drive';
import { ExternalLink, Link, Mail } from 'lucide-react';

// Selection-aware commands. They surface only when the palette has a non-empty
// selection (published by DriveList for multi-select tables, or by each eigendoc
// viewer for the open document). The handlers mirror DriveItemMenuItems' pure
// actions — anything that needs route-local dialog state (Rename, Share, Delete,
// Email collaborators) stays in the Drive context menu for now.
export const driveCommands: Command[] = [
    {
        id: 'drive.open',
        title: 'Open',
        keywords: ['open'],
        icon: ExternalLink,
        baseRank: 18,
        availability: (ctx) => ctx.selection?.items.length === 1 && isOpenable(ctx.selection.items[0]),
        run: (ctx) => {
            const item = ctx.selection?.items[0];
            if (item) openDocument(item);
        },
    },
    {
        id: 'drive.open-in-new-tab',
        title: 'Open in new tab',
        keywords: ['open', 'tab'],
        icon: ExternalLink,
        baseRank: 17,
        availability: (ctx) => {
            const item = ctx.selection?.items[0];
            return ctx.selection?.items.length === 1 && !!item && !!getDriveItemUrl(item);
        },
        run: (ctx) => {
            const item = ctx.selection?.items[0];
            if (!item) return;
            const url = getDriveItemUrl(item);
            if (url) window.open(url, '_blank');
        },
    },
    {
        id: 'drive.copy-link',
        title: 'Copy link',
        keywords: ['url', 'share'],
        icon: Link,
        baseRank: 14,
        availability: (ctx) => ctx.selection?.items.length === 1,
        run: (ctx) => {
            const item = ctx.selection?.items[0];
            if (item) copyToClipboard(getDriveShareUrl(item), 'Link copied to clipboard');
        },
    },
    {
        id: 'drive.mail-to',
        title: 'Mail to…',
        keywords: ['send', 'attach', 'compose'],
        icon: Mail,
        baseRank: 15,
        availability: (ctx) => (ctx.selection?.items.length ?? 0) > 0,
        run: (ctx) => {
            if (!ctx.selection || ctx.selection.items.length === 0) return;
            ctx.openMailComposeWith({ attachments: ctx.selection.items });
        },
    },
];
