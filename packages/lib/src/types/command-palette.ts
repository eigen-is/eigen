import type { LucideIcon } from 'lucide-react';
import type { Contact } from './contact';
import type { DrivePath, EigenDocType } from './drive';
import type { EmailSummary } from './mail';

export type AppName =
    | 'mail'
    | 'drive'
    | 'docs'
    | 'sheets'
    | 'slides'
    | 'stickies'
    | 'calendar'
    | 'contacts'
    | 'chat'
    | 'space'
    | 'admin'
    | 'index'
    | 'settings';

export type PaletteScope = 'mail' | 'actions' | 'contacts';

export type ResultGroup = 'top-hit' | 'suggested' | 'actions' | 'mail' | 'contacts';

// A 1-item selection from an eigendoc viewer is identical in shape to a 1-item
// Drive selection — both surface the same actions (Share, Mail to…, Copy link, …).
export type PaletteSelection = { items: DrivePath[] } | null;

// Handlers a route publishes alongside the selection. Pure cross-app actions (Open
// in new tab, Copy link, Mail to…) live in the catalog and don't need this — only
// actions that depend on route-local dialog state (Rename, Share, Delete, Quick
// preview, Download, Email collaborators) come through here. Drive's DriveLayout
// is the canonical publisher; the eigendoc viewers can wire their own subset.
export type PaletteSelectionActions = {
    onQuickLook?: (item: DrivePath) => void;
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
    currentApp: AppName;
    selection: PaletteSelection;
    selectionActions: PaletteSelectionActions;
    navigate: (to: string) => void;
    openDriveCreate: (kind: EigenDocType | 'folder') => void;
    openMailComposeWith: (opts: { to?: string; attachments?: DrivePath[] }) => void;
    toggleTheme: () => void;
};

// Static catalog entry. Engine wraps these into `PaletteResult` of kind 'action'
// after applying availability + boosts.
export type Command = {
    id: string;
    title: string;
    keywords?: string[];
    shortcut?: string;
    icon: LucideIcon;
    baseRank?: number;
    availability?: (ctx: CommandContext) => boolean;
    run: (ctx: CommandContext) => void;
};

export type PaletteResult =
    | {
          kind: 'action';
          id: string;
          title: string;
          subtitle?: string;
          keywords?: string[];
          shortcut?: string;
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
          subtitle?: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          payload: Contact;
          run: (ctx: CommandContext) => void;
      }
    | {
          kind: 'mail';
          id: string;
          title: string;
          subtitle?: string;
          icon: LucideIcon;
          group: ResultGroup;
          rank: number;
          payload: EmailSummary;
          run: (ctx: CommandContext) => void;
      };

export type Sections = {
    topHit?: PaletteResult;
    groups: { id: Exclude<ResultGroup, 'top-hit'>; heading: string; items: PaletteResult[] }[];
};
