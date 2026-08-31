// The root barrel is the curated "search here first" tier, and nothing else:
//   1. the AGENTS.md "Key UI Components" (TooltipButton, DeleteDialog, ConfirmDialog,
//      EmptyState/LoadingState/ErrorState, SearchBar, FileMenu, RequestAccessView, ...)
//      plus braket/ — EigenLoader is the loader those states render, Key-UI in all but name,
//   2. the layout system (layout/app + layout/sidebar + layout/toolbar; layout/pages stays
//      out — page scaffolds are wired once per app, not searched for),
//   3. generic leaf primitives that belong to no area (single files under components/).
// Area barrels (drive, chat, comments, editor, media, user, ...) are deliberately NOT
// re-exported here — import those from @workspace/ui/components/<area>. Providers mount
// via eigen-app; page scaffolds live in @workspace/ui/components/layout/pages.

export * from './components/activity-row';
export * from './components/alphabetical-list';
export * from './components/avatar-editor';
export * from './components/braket';
export * from './components/confirm-dialog';
export * from './components/copy-input';
export * from './components/count-badge';
export * from './components/delete/delete-dialog';
export * from './components/file-drop-overlay';
export * from './components/hint-pill';
export * from './components/info-block';
export * from './components/layout/app';
export * from './components/layout/sidebar';
export * from './components/layout/toolbar';
export * from './components/search-bar/search-bar';
export * from './components/shadow-content';
export * from './components/sort-header';
export * from './components/transform/object-transform';
export * from './components/unread-dot';
export * from './components/use-contact-avatar-upload';
