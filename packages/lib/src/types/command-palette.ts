import type { LucideIcon } from 'lucide-react';
import type { ContactSuggestion } from './contact';
import type { DocSearchController } from './doc-search';
import type { DrivePath, EigenDocType } from './drive';
import type { EmailSummary } from './mail';
import type { HelpSearchDoc } from './search';

export type PaletteScope = 'mail' | 'file' | 'actions' | 'contacts' | 'help';

export type ResultGroup =
    | 'top-hit'
    | 'suggested'
    | 'smart'
    | 'selection'
    | 'doc-content'
    | 'mail'
    | 'file'
    | 'contacts'
    | 'help'
    | 'actions';

// A 1-item selection from an eigendoc viewer is identical in shape to a 1-item
// Drive selection — both surface the same actions (Share, Mail to…, Copy link, …).
// `isCurrentDocument` flags the eigendoc-viewer case so the "view this file" commands
// (Open / Open in new tab / Quick preview) hide — you're already inside it.
export type PaletteSelection = { items: DrivePath[]; isCurrentDocument?: boolean } | null;

// Handlers a route publishes alongside the selection. Pure cross-app actions (Open
// in new tab, Copy link, Mail to…) live in the catalog and don't need this — only
// actions that depend on route-local dialog state (Rename, Share, Delete, Download,
// Email collaborators) come through here. Quick preview is global (via openPreview
// on CommandContext) and not part of this surface.
export type PaletteSelectionActions = {
    onDownload?: (item: DrivePath) => void;
    onRename?: (item: DrivePath) => void;
    onShare?: (item: DrivePath) => void;
    onEmailCollaborators?: (item: DrivePath) => void;
    onDelete?: (items: DrivePath[]) => void;
} | null;

// The bag command handlers receive. Bundles app-aware navigation + the helpers
// commands actually need to run their side effects. Other helpers are added when a
// real caller needs them.
export type CommandContext = {
    ownerId: string;
    selection: PaletteSelection;
    selectionActions: PaletteSelectionActions;
    // The open eigendoc's search controller (published by DocSearchProvider). null in the drive
    // list and non-eigendoc apps. Drives the palette `doc:` scope; Enter reveals a hit in place.
    docSearch: DocSearchController | null;
    navigate: (to: string) => void;
    openDriveCreate: (kind: EigenDocType | 'folder') => void;
    openMailComposeWith: (opts: { to?: string; attachments?: DrivePath[] }) => void;
    openPreview: (path: DrivePath) => void;
    toggleTheme: () => void;
};

// Static catalog entry. Engine wraps these into `PaletteResult` of kind 'action'
// after applying availability + boosts. `group: 'selection'` marks selection-aware
// commands — they only surface when a selection is present and render in the top
// "Selection" section instead of the catalog's "Actions" section. `dynamicTitle` lets
// a selection command tailor its label to the current item(s) — "Share Q4-budget"
// rather than a generic "Share".
export type Command = {
    id: string;
    title: string;
    keywords?: string[];
    icon: LucideIcon;
    baseRank?: number;
    group?: 'actions' | 'selection';
    availability?: (ctx: CommandContext) => boolean;
    dynamicTitle?: (ctx: CommandContext) => string;
    run: (ctx: CommandContext) => void;
};

export type PaletteResult =
    | {
          kind: 'action';
          id: string;
          title: string;
          subtitle?: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          run: (ctx: CommandContext) => void;
      }
    | {
          kind: 'smart';
          id: string;
          title: string;
          subtitle?: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          run: (ctx: CommandContext) => void;
          deterministic?: boolean;
      }
    | {
          kind: 'contact';
          id: string;
          title: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          payload: ContactSuggestion;
          run: (ctx: CommandContext) => void;
      }
    | {
          kind: 'mail';
          id: string;
          title: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          payload: EmailSummary;
          run: (ctx: CommandContext) => void;
      }
    | {
          kind: 'file';
          id: string;
          title: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          payload: DrivePath;
          run: (ctx: CommandContext) => void;
      }
    | {
          kind: 'help';
          id: string;
          title: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          payload: HelpSearchDoc;
          run: (ctx: CommandContext) => void;
      };

export type Sections = {
    topHit?: PaletteResult;
    groups: { id: Exclude<ResultGroup, 'top-hit'>; heading: string; items: PaletteResult[] }[];
};
