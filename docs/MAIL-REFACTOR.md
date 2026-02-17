# Mail App Refactor Plan

Actionable list of refactors for `apps/mail/`. Each item describes what to change, why, and how.

---

## 1. Use shared `SearchBar` in `EmailListToolbar`

**File:** `apps/mail/src/components/mail/email-list.tsx`

**Why:** `EmailListToolbar` hand-rolls a search input with `<Search>` icon + `<Input>`, duplicating the shared `SearchBar` component in `packages/ui/src/components/layout/search-bar/search-bar.tsx`.

**Before:**
```tsx
export function EmailListToolbar({searchQuery, onSearchChange}: EmailListToolbarProps) {
    return (
        <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"/>
            <Input
                placeholder="Search emails..."
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                className="pl-8 w-full h-8 bg-white"
            />
        </div>
    );
}
```

**After:**
```tsx
import {SearchBar} from '@workspace/ui/components/layout/search-bar/search-bar';

export function EmailListToolbar({searchQuery, onSearchChange}: EmailListToolbarProps) {
    return (
        <SearchBar
            placeholder="Search emails..."
            value={searchQuery}
            onChange={onSearchChange}
            maxWidth="full"
            inputClassName="h-8 bg-white"
        />
    );
}
```

**Also apply to:** `apps/contacts/src/components/contacts/contacts-list.tsx` — `ContactsListToolbar` has the same pattern.

**Cleanup:** Remove unused `Search` and `Input` imports from both files after replacing.

---

## 2. Extract right-click context menu into a shared hook

**File:** `apps/mail/src/components/mail/email-list.tsx`

**Why:** The email list implements a custom right-click context menu with manual position tracking, click-outside handling, and a hidden `DropdownMenuTrigger`. This is ~40 lines of boilerplate that could be a reusable hook.

**Current pattern (lines 66-71, 170-191, 282-309):**
```tsx
const [contextMenuEmail, setContextMenuEmail] = useState<EmailSummary | null>(null);
const [menuPosition, setMenuPosition] = useState({x: 0, y: 0});
const contextMenuRef = useRef<HTMLDivElement>(null);

const handleContextMenu = (e: React.MouseEvent, email: EmailSummary) => {
    e.preventDefault();
    setContextMenuEmail(email);
    setMenuPosition({x: e.clientX, y: e.clientY});
};

// + click-outside useEffect (lines 177-191)
// + hidden DropdownMenuTrigger + positioned DropdownMenuContent (lines 282-309)
```

**Create shared hook:** `packages/ui/src/components/layout/context-menu/use-context-menu.ts`

```tsx
export function useContextMenu<T>() {
    const [item, setItem] = useState<T | null>(null);
    const [position, setPosition] = useState({x: 0, y: 0});

    const handleContextMenu = useCallback((e: React.MouseEvent, item: T) => {
        e.preventDefault();
        setItem(item);
        setPosition({x: e.clientX, y: e.clientY});
    }, []);

    const close = useCallback(() => setItem(null), []);

    return {item, position, isOpen: !!item, handleContextMenu, close};
}
```

**Create shared wrapper:** `packages/ui/src/components/layout/context-menu/context-menu-anchor.tsx`

```tsx
// Renders the hidden DropdownMenuTrigger + positions DropdownMenuContent
export function ContextMenuAnchor({isOpen, position, onClose, children}) {
    return (
        <DropdownMenu open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DropdownMenuTrigger className="hidden"/>
            {children} {/* DropdownMenuContent with style={{position: 'absolute', top, left}} */}
        </DropdownMenu>
    );
}
```

**Refactored email-list.tsx:**
```tsx
const {item: contextMenuEmail, position, isOpen, handleContextMenu, close} = useContextMenu<EmailSummary>();

// In the row:
<div onContextMenu={(e) => handleContextMenu(e, email)}>

// At the bottom:
<ContextMenuAnchor isOpen={isOpen} position={position} onClose={close}>
    <EmailContextMenu messageId={contextMenuEmail?.id} ... onClose={close}/>
</ContextMenuAnchor>
```

This removes ~40 lines of boilerplate from `email-list.tsx` and makes the pattern reusable for Drive file lists or any future list with right-click menus.

---

## 3. Extract keyboard list navigation into a shared hook

**File:** `apps/mail/src/components/mail/email-list.tsx`

**Why:** The email list has ~60 lines of keyboard navigation (ArrowUp, ArrowDown, Enter, Home, End) with scroll-into-view. This is a generic pattern for any selectable list.

**Current pattern (lines 64, 75-167):**
```tsx
const [selectedIndex, setSelectedIndex] = useState<number>(-1);
const tableRef = useRef<HTMLDivElement>(null);

const scrollToRow = (index: number) => { ... };
const handleKeyDown = (e: KeyboardEvent) => { ... ArrowDown, ArrowUp, Enter, Home, End ... };
```

**Create shared hook:** `packages/ui/src/hooks/use-keyboard-list-navigation.ts`

```tsx
type UseKeyboardListNavigationOptions<T> = {
    items: T[];
    activeId?: string;
    getId: (item: T) => string;
    onSelect: (id: string) => void;
    containerRef: RefObject<HTMLElement>;
    itemSelector?: string; // default: '.eigen-list-item'
}

export function useKeyboardListNavigation<T>({items, activeId, getId, onSelect, containerRef, itemSelector}: ...) {
    const [selectedIndex, setSelectedIndex] = useState(-1);

    // Sync selectedIndex with activeId
    useEffect(() => { ... }, [activeId, items]);

    const handleKeyDown = (e: KeyboardEvent) => { ... };

    return {selectedIndex, handleKeyDown};
}
```

**Refactored email-list.tsx:**
```tsx
const tableRef = useRef<HTMLDivElement>(null);
const {selectedIndex, handleKeyDown} = useKeyboardListNavigation({
    items: filteredEmails,
    activeId: activeRowId,
    getId: (email) => email.id,
    onSelect: onRowClick,
    containerRef: tableRef,
});
```

This removes ~60 lines from `email-list.tsx` and the hook is reusable for contacts list, drive file list, etc.

---

## 4. Move `EmailDraft` toolbar into `Column` toolbar prop

**File:** `apps/mail/src/components/mail/email-draft.tsx`

**Why:** `EmailDraft` renders its own inline toolbar (back button + send + delete) at lines 188-212. This should be extracted into an `EmailDraftToolbar` component and passed as the `toolbar` prop to the detail `Column`, consistent with how `EmailDetailToolbar` and `ContactDetailToolbar` work.

**Steps:**

1. Create `EmailDraftToolbar` in `email-draft.tsx`:
```tsx
export function EmailDraftToolbar({onSend, onDelete, isSending, hasId}: {
    onSend: () => void;
    onDelete: () => void;
    isSending: boolean;
    hasId: boolean;
}) {
    return (
        <div className="flex items-center gap-1">
            <TooltipButton icon={Send} tooltipText="Send" onClick={onSend} disabled={isSending}/>
            {hasId && <TooltipButton icon={Trash2} tooltipText="Delete" onClick={onDelete} disabled={isSending}/>}
        </div>
    );
}
```

2. Remove the inline toolbar from `EmailDraft` component (lines 188-212).

3. Remove the `onBack` prop from `EmailDraft` — back navigation is handled by `Column`'s `onBack`.

4. Remove the `isMobile` check and `ArrowLeft` button from `EmailDraft`.

5. In the route file `_auth.$filterType.$filterId.tsx`, use `EmailDraftToolbar` as the detail toolbar when `isDraft`:
```tsx
const detailToolbar = isDraft
    ? <EmailDraftToolbar onSend={...} onDelete={...} isSending={...} hasId={...}/>
    : selectedEmail
        ? <EmailDetailToolbar .../>
        : null;
```

**Cleanup:** Remove `ArrowLeft`, `useLayout` imports from `email-draft.tsx`.

---

## 5. Translate Dutch comments to English

**Files:**
- `apps/mail/src/components/mail/email-list.tsx` — lines 63, 72, 74, 92, 104, 114, 116, 128, 130, 150, 152, 160, 162
- `apps/mail/src/components/mail/email-draft.tsx` — lines 228, 245, 263
- `apps/mail/src/components/mail/email-sidebar.tsx` — line 103

**Why:** Project rule: "ALWAYS USE ENGLISH in all code and all texts you generate."

**Action:** Replace all Dutch comments with English equivalents. Examples:
- `// State voor het bijhouden van de huidige geselecteerde index` → `// Track current selected index`
- `// Handel toetsenbord navigatie af` → `// Handle keyboard navigation`
- `// We halen de waarde op via de ref bij het verzenden` → `// Value is read from ref on submit`
- `// Memoize the processed mailboxes to avoid unnecessary recalculations` — this one is already English, keep it.

---

## 6. Remove `console.log` debug statements

**Files:**
- `apps/mail/src/components/mail/email-detail.tsx` — line 163: `console.log('Rendering EmailDetail with email:', email);`
- `apps/mail/src/components/mail/email-draft.tsx` — line 67: `console.log('Rendering EmailDraft with email:', email);`

**Action:** Remove both lines.

---

## Summary — Priority Order

| # | Task | Impact | Effort |
|---|------|--------|--------|
| 4 | Move draft toolbar to Column toolbar prop | Consistency, mobile back works | Medium |
| 1 | Use shared SearchBar | DRY, consistency | Low |
| 2 | Extract context menu hook | DRY, reusable for Drive | Medium |
| 3 | Extract keyboard navigation hook | DRY, reusable for contacts/drive | Medium |
| 5 | Translate Dutch comments | Code quality | Low |
| 6 | Remove console.log | Code quality | Trivial |
