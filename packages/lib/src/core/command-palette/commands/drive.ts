import { getDriveItemUrl, getDriveShareUrl, openDocument } from '@workspace/lib/api';
import { copyToClipboard } from '@workspace/lib/clipboard';
import type { Command } from '@workspace/lib/types/command-palette';
import { isOpenable } from '@workspace/lib/types/drive';
import { Download, ExternalLink, Eye, Link, Mail, Pencil, Trash2, UserRoundPlus } from 'lucide-react';

// Selection-aware commands. They surface only when the palette has a non-empty
// selection (published by DriveList for multi-select tables, or by each eigendoc
// viewer for the open document). Pure cross-app actions resolve via direct imports
// (URL helpers + clipboard); dialog-state actions read from ctx.selectionActions,
// which DriveLayout publishes when it's mounted.
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
        id: 'drive.quick-preview',
        title: 'Quick preview',
        keywords: ['preview', 'look'],
        icon: Eye,
        baseRank: 16,
        availability: (ctx) =>
            ctx.selection?.items.length === 1 &&
            ctx.selection.items[0].type !== 'folder' &&
            !!ctx.selectionActions?.onQuickLook,
        run: (ctx) => {
            const item = ctx.selection?.items[0];
            if (item) ctx.selectionActions?.onQuickLook?.(item);
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
    {
        id: 'drive.download',
        title: 'Download',
        keywords: ['save'],
        icon: Download,
        baseRank: 13,
        availability: (ctx) =>
            ctx.selection?.items.length === 1 &&
            ctx.selection.items[0].type === 'file' &&
            !!ctx.selectionActions?.onDownload,
        run: (ctx) => {
            const item = ctx.selection?.items[0];
            if (item) ctx.selectionActions?.onDownload?.(item);
        },
    },
    {
        id: 'drive.rename',
        title: 'Rename',
        keywords: ['name'],
        icon: Pencil,
        baseRank: 12,
        availability: (ctx) => ctx.selection?.items.length === 1 && !!ctx.selectionActions?.onRename,
        run: (ctx) => {
            const item = ctx.selection?.items[0];
            if (item) ctx.selectionActions?.onRename?.(item);
        },
    },
    {
        id: 'drive.share',
        title: 'Share',
        keywords: ['access', 'permissions'],
        icon: UserRoundPlus,
        baseRank: 11,
        availability: (ctx) => ctx.selection?.items.length === 1 && !!ctx.selectionActions?.onShare,
        run: (ctx) => {
            const item = ctx.selection?.items[0];
            if (item) ctx.selectionActions?.onShare?.(item);
        },
    },
    {
        id: 'drive.email-collaborators',
        title: 'Email collaborators',
        keywords: ['notify'],
        icon: Mail,
        baseRank: 10,
        availability: (ctx) => ctx.selection?.items.length === 1 && !!ctx.selectionActions?.onEmailCollaborators,
        run: (ctx) => {
            const item = ctx.selection?.items[0];
            if (item) ctx.selectionActions?.onEmailCollaborators?.(item);
        },
    },
    {
        id: 'drive.delete',
        title: 'Move to trash',
        keywords: ['delete', 'remove'],
        icon: Trash2,
        baseRank: 9,
        availability: (ctx) => (ctx.selection?.items.length ?? 0) > 0 && !!ctx.selectionActions?.onDelete,
        run: (ctx) => {
            const items = ctx.selection?.items;
            if (items && items.length > 0) ctx.selectionActions?.onDelete?.(items);
        },
    },
];
