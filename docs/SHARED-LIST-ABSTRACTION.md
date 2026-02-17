# Shared List Abstraction Plan

## Current State

Three list implementations exist with overlapping behavior:

| Feature | DriveTable | EmailList | ContactsList |
|---------|-----------|-----------|--------------|
| **Location** | `packages/ui/.../drive/drive-table.tsx` | `apps/mail/.../email-list.tsx` | `apps/contacts/.../contacts-list.tsx` |
| **Element type** | `<Table>` + `<TableRow>` | `<div>` rows | `<Link>` inside letter groups |
| **Keyboard nav** | `useKeyboardListNavigation` | `useKeyboardListNavigation` | **Missing** — needs adding |
| **Context menu** | `useContextMenu<DrivePath>` | `useContextMenu<EmailSummary>` | `useContextMenu<Contact>` |
| **Drag-drop** | `useTableDragDrop` (internal, file→folder) | None | None |
| **Selection** | Single (`activeItemId`) | Single (`activeRowId`) | Single (URL param `contactId`) |
| **CSS classes** | `eigen-list-item`, `eigen-list-item-active` | Same + `eigen-list-item-unread` | Same |
| **Item rendering** | Icon + name + share + date columns | From + subject + preview + date | Avatar + name + email |
| **Context menu items** | Open, Download, Share, Rename, Delete | Reply, Reply All, Forward, Archive, Spam, Delete, Download, Move | Edit, Delete, Assign Label |

### Shared hooks already in place
- **`useKeyboardListNavigation<T>`** — `packages/ui/src/hooks/use-keyboard-list-navigation.ts`
- **`useContextMenu<T>`** — `packages/ui/src/components/layout/context-menu/use-context-menu.ts`
- **`ContextMenuAnchor`** — `packages/ui/src/components/layout/context-menu/context-menu-anchor.tsx`
- **`useTableDragDrop`** — `packages/ui/src/components/layout/drive/use-table-drag-drop.ts` (drive-specific, typed to `DrivePath`)

---

## Recommendation: Hooks Over Components

**Do NOT create a single `<SelectableList>` component.** The three lists have very different rendering (table vs divs vs grouped links) and very different context menus. Forcing them into one component would be over-engineering.

**Instead: create composable hooks** that each list can opt into. This keeps rendering flexible while sharing all behavioral logic.

### New hooks to create (all in `packages/ui/src/hooks/`):

| Hook | File | Purpose |
|------|------|---------|
| `useListSelection<T>` | `use-list-selection.ts` | Multi-select state: selected IDs, shift-click, ctrl-click, select-all |
| `useListDrag<T>` | `use-list-drag.ts` | Generic drag-from-list behavior, works with selection |
| `useListDropTarget` | `use-list-drop-target.ts` | Accept drops on sidebar items (folders, labels) |

### Existing hooks to extend:
| Hook | Changes |
|------|---------|
| `useKeyboardListNavigation` | Add Shift+Arrow for range-select, Ctrl/Cmd+A for select-all |
| `useTableDragDrop` | Replace with generic `useListDrag` or keep as drive-specific wrapper |

### New shared component:
| Component | File | Purpose |
|-----------|------|---------|
| `ListCheckbox` | `packages/ui/src/components/layout/list-checkbox.tsx` | Optional checkbox for list rows on desktop |

---

## Implementation Plan

### Phase 1: `useListSelection<T>` hook

**File:** `packages/ui/src/hooks/use-list-selection.ts`

This is the foundation. All other features depend on it.

```ts
// PSEUDO-CODE — use-list-selection.ts

type UseListSelectionOptions<T> = {
  items: T[];
  getId: (item: T) => string;
  activeId?: string;           // currently focused/viewed item (URL-driven)
  allowMultiple?: boolean;     // default true
}

type UseListSelectionReturn<T> = {
  selectedIds: Set<string>;
  isSelected: (id: string) => boolean;
  selectedItems: T[];
  selectedCount: number;
  hasSelection: boolean;       // true if >= 1 selected

  // Actions
  select: (id: string) => void;            // replace selection with single item
  toggle: (id: string) => void;            // add/remove from selection (Ctrl+click)
  selectRange: (id: string) => void;       // select from anchor to id (Shift+click)
  selectAll: () => void;                   // select all items
  clearSelection: () => void;              // deselect all

  // Event handler for click events (detects Shift/Ctrl modifiers)
  handleItemClick: (id: string, e: React.MouseEvent) => void;

  // For keyboard integration
  anchorId: string | null;                 // last single-selected item (range anchor)
}

function useListSelection<T>({items, getId, activeId, allowMultiple = true}: UseListSelectionOptions<T>): UseListSelectionReturn<T> {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);

  // select(id): clear selection, set to just this item, update anchor
  // toggle(id): add if not present, remove if present (Ctrl+click)
  // selectRange(id): find anchor index and target index, select everything between
  // selectAll(): set selectedIds to all item IDs
  // clearSelection(): empty set

  // handleItemClick(id, e):
  //   if (e.shiftKey && allowMultiple) → selectRange(id)
  //   else if ((e.metaKey || e.ctrlKey) && allowMultiple) → toggle(id)
  //   else → select(id)

  // Sync: if activeId changes externally (URL nav), update selection to match
  // unless user is actively multi-selecting

  // selectedItems: derived from selectedIds + items array

  return { selectedIds, isSelected, selectedItems, selectedCount, hasSelection,
           select, toggle, selectRange, selectAll, clearSelection,
           handleItemClick, anchorId };
}
```

**Key behaviors:**
- **Click** = select single item (clears multi-select)
- **Ctrl/Cmd+Click** = toggle item in/out of selection
- **Shift+Click** = range-select from anchor to clicked item
- **Anchor** = the last item that was single-selected or Ctrl-clicked
- When `allowMultiple` is false, behaves exactly like current single-select

**Integration with existing `onRowClick`/`onItemClick`:**
Each list currently calls something like `onRowClick(id)` on click. With multi-select, the click handler changes:

```tsx
// BEFORE (EmailList):
onClick={() => onRowClick(email.id)}

// AFTER:
onClick={(e) => {
  selection.handleItemClick(email.id, e);
  // Only navigate to detail if single-select (no modifier keys)
  if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
    onRowClick(email.id);
  }
}}
```

### Phase 2: Extend `useKeyboardListNavigation`

**File:** `packages/ui/src/hooks/use-keyboard-list-navigation.ts`

Add optional selection integration:

```ts
// CHANGES to UseKeyboardListNavigationOptions<T>:
type UseKeyboardListNavigationOptions<T> = {
  // ... existing options ...
  selection?: UseListSelectionReturn<T>;  // NEW optional parameter
}

// NEW keyboard behaviors (only when selection is provided):

// Shift+ArrowDown / Shift+ArrowUp:
//   Move selectedIndex AND call selection.selectRange(newItem.id)
//   This extends the selection while navigating

// Ctrl/Cmd+A (or just 'a' when container is focused):
//   Call selection.selectAll()
//   Prevent default (important to avoid browser select-all)

// Escape:
//   Call selection.clearSelection()

// Delete:
//   If selection.hasSelection → call onDelete for ALL selected items
//   (change onDelete signature to accept T[])
```

**Pseudo-code for Shift+Arrow:**
```ts
case 'ArrowDown':
  e.preventDefault();
  setSelectedIndex(prev => {
    const newIndex = Math.min(prev + 1, items.length - 1);
    if (newIndex !== prev) {
      const newItem = items[newIndex];
      if (e.shiftKey && selection) {
        selection.selectRange(getId(newItem));
      } else if (selection) {
        selection.select(getId(newItem));
      }
      notify(newItem, newIndex);
      scrollToRow(newIndex);
    }
    return newIndex;
  });
  break;
```

### Phase 3: `ListCheckbox` component

**File:** `packages/ui/src/components/layout/list-checkbox.tsx`

```tsx
// PSEUDO-CODE — list-checkbox.tsx

type ListCheckboxProps = {
  checked: boolean;
  onChange: (e: React.MouseEvent) => void;
  className?: string;
}

function ListCheckbox({ checked, onChange, className }: ListCheckboxProps) {
  return (
    <div
      className={cn(
        "w-5 h-5 shrink-0 flex items-center justify-center",
        className
      )}
      onClick={(e) => {
        e.stopPropagation(); // don't trigger row click
        onChange(e);
      }}
    >
      <Checkbox checked={checked} />
    </div>
  );
}
```

**Usage in a list row:**
```tsx
// In EmailList row:
<div className="flex items-start py-2 px-3 eigen-list-item" ...>
  {showCheckboxes && (
    <ListCheckbox
      checked={selection.isSelected(email.id)}
      onChange={(e) => selection.handleItemClick(email.id, e)}
    />
  )}
  <div className="flex-1 min-w-0">
    {/* existing content */}
  </div>
</div>
```

**When to show checkboxes:**
- On desktop: always show (optional prop `showCheckboxes`)
- On mobile: never show (use long-press or context menu instead)
- Alternative: show only when `selection.selectedCount > 0` (Gmail-style)

Decision: make it a prop `showCheckboxes?: boolean` on each list. The parent route decides based on `useLayout().isMobile`.

### Phase 4: Context menu multi-select support

Each list already has its own context menu content. The change is behavioral:

**Rule:** When right-clicking an item that is part of a multi-selection, the context menu applies to ALL selected items. When right-clicking an unselected item, clear selection and select only that item.

```ts
// PSEUDO-CODE for context menu integration:
onContextMenu={(e) => {
  if (!selection.isSelected(item.id)) {
    // Right-clicked an unselected item → select only this one
    selection.select(item.id);
  }
  contextMenu.handleContextMenu(e, item);
}}
```

**Context menu content changes per selection count:**

| Action | Single select | Multi select |
|--------|--------------|--------------|
| **Edit** (contacts) | Show | **Hide** |
| **Open** (drive) | Show | **Hide** |
| **Delete** | Show — delete 1 | Show — "Delete N items" |
| **Move** (mail, drive) | Show — move 1 | Show — "Move N items" |
| **Assign label** (contacts) | Show | Show — apply to all |
| **Reply/Forward** (mail) | Show | **Hide** |
| **Download** (drive) | Show | Show — download all |
| **Share/Rename** (drive) | Show | **Hide** |

Each list's context menu receives `selectedCount` and `selectedItems` instead of just a single item:

```tsx
// PSEUDO-CODE for multi-aware context menu:

// In contacts-list.tsx:
<ContextMenuAnchor isOpen={contextMenu.isOpen} onClose={contextMenu.close}>
  <DropdownMenuContent style={{...}}>
    {selection.selectedCount === 1 && onEdit && (
      <DropdownMenuItem onClick={() => { onEdit(selection.selectedItems[0]); }}>
        <Edit /> Edit
      </DropdownMenuItem>
    )}
    {onDelete && (
      <DropdownMenuItem onClick={() => {
        onDelete(selection.selectedItems);  // note: array now
        contextMenu.close();
      }}>
        <Trash2 />
        {selection.selectedCount > 1
          ? `Delete ${selection.selectedCount} contacts`
          : 'Delete'}
      </DropdownMenuItem>
    )}
    {/* Label sub-menu always available */}
  </DropdownMenuContent>
</ContextMenuAnchor>
```

**Callback signature changes:**
```ts
// BEFORE:
onDelete?: (contact: Contact) => void;

// AFTER:
onDelete?: (contacts: Contact[]) => void;
```

This is a breaking change for each list. Update all three lists and their parent routes.

### Phase 5: `useListDrag<T>` hook (generic drag-from-list)

**File:** `packages/ui/src/hooks/use-list-drag.ts`

Replaces drive-specific `useTableDragDrop` with a generic hook that works with multi-select.

```ts
// PSEUDO-CODE — use-list-drag.ts

type UseListDragOptions<T> = {
  selection: UseListSelectionReturn<T>;
  getId: (item: T) => string;
  getType: () => string;            // e.g. 'email', 'contact', 'drive-item'
  onDragStart?: (items: T[]) => void;
  onDragEnd?: () => void;
}

type UseListDragReturn<T> = {
  isDragging: boolean;
  draggedItems: T[];

  // Attach to each row:
  getDragProps: (item: T) => {
    draggable: boolean;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  };
}

function useListDrag<T>({ selection, getId, getType, onDragStart, onDragEnd }: UseListDragOptions<T>): UseListDragReturn<T> {
  const [isDragging, setIsDragging] = useState(false);
  const [draggedItems, setDraggedItems] = useState<T[]>([]);

  const getDragProps = useCallback((item: T) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      // If the dragged item is not in the selection, select only it
      if (!selection.isSelected(getId(item))) {
        selection.select(getId(item));
      }

      // Collect all selected items for the drag
      const items = selection.hasSelection ? selection.selectedItems : [item];
      setDraggedItems(items);
      setIsDragging(true);

      // Set drag data
      e.dataTransfer.setData('application/eigen-drag', JSON.stringify({
        type: getType(),
        ids: items.map(getId),
      }));
      e.dataTransfer.effectAllowed = 'move';

      // Custom drag image showing count (optional)
      if (items.length > 1) {
        const badge = document.createElement('div');
        badge.textContent = `${items.length} items`;
        badge.className = 'drag-badge'; // style in globals.css
        document.body.appendChild(badge);
        e.dataTransfer.setDragImage(badge, 0, 0);
        requestAnimationFrame(() => document.body.removeChild(badge));
      }

      onDragStart?.(items);
    },
    onDragEnd: () => {
      setIsDragging(false);
      setDraggedItems([]);
      onDragEnd?.();
    },
  }), [selection, getId, getType, onDragStart, onDragEnd]);

  return { isDragging, draggedItems, getDragProps };
}
```

**Usage in a list row:**
```tsx
const drag = useListDrag({
  selection,
  getId: (email) => email.id,
  getType: () => 'email',
});

// In JSX:
<div
  className="eigen-list-item ..."
  {...drag.getDragProps(email)}
  onClick={(e) => selection.handleItemClick(email.id, e)}
>
  ...
</div>
```

### Phase 6: `useListDropTarget` hook (accept drops on sidebar items)

**File:** `packages/ui/src/hooks/use-list-drop-target.ts`

Sidebar items (mail folders, contact labels) need to accept drops.

```ts
// PSEUDO-CODE — use-list-drop-target.ts

type UseListDropTargetOptions = {
  acceptTypes: string[];           // e.g. ['email', 'contact']
  onDrop: (dragData: { type: string; ids: string[] }) => void;
}

type UseListDropTargetReturn = {
  isOver: boolean;
  canDrop: boolean;
  getDropProps: () => {
    onDragOver: (e: React.DragEvent) => void;
    onDragEnter: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

function useListDropTarget({ acceptTypes, onDrop }: UseListDropTargetOptions): UseListDropTargetReturn {
  const [isOver, setIsOver] = useState(false);

  const canAccept = (e: React.DragEvent) => {
    return e.dataTransfer.types.includes('application/eigen-drag');
  };

  const getDropProps = useCallback(() => ({
    onDragOver: (e: React.DragEvent) => {
      if (canAccept(e)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }
    },
    onDragEnter: (e: React.DragEvent) => {
      if (canAccept(e)) {
        e.preventDefault();
        setIsOver(true);
      }
    },
    onDragLeave: () => setIsOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setIsOver(false);
      try {
        const raw = e.dataTransfer.getData('application/eigen-drag');
        const data = JSON.parse(raw);
        if (acceptTypes.includes(data.type)) {
          onDrop(data);
        }
      } catch { /* ignore invalid drops */ }
    },
  }), [acceptTypes, onDrop]);

  return { isOver, canDrop: true, getDropProps };
}
```

**Integration into `SidebarItem`:**

Add an optional `dropTarget` prop to `SidebarItem`:

```tsx
// PSEUDO-CODE changes to sidebar-item.tsx:

type SidebarItemProps = {
  // ... existing props ...
  dropTarget?: UseListDropTargetReturn;  // NEW optional
}

function SidebarItem({ ..., dropTarget }: SidebarItemProps) {
  const dropProps = dropTarget?.getDropProps() ?? {};

  return (
    <Link
      className={cn(
        baseStyles,
        dropTarget?.isOver && "bg-primary/20 ring-2 ring-primary/50" // highlight on hover
      )}
      {...dropProps}
    >
      {content}
    </Link>
  );
}
```

**Usage in EmailSidebar:**
```tsx
function EmailSidebar({ ... }) {
  const inboxDrop = useListDropTarget({
    acceptTypes: ['email'],
    onDrop: ({ ids }) => onMoveEmails(ids, 'INBOX'),
  });

  return (
    <SidebarItem
      icon={<Inbox />}
      label="Inbox"
      to="/box/inbox"
      dropTarget={inboxDrop}
    />
  );
}
```

**Usage in ContactsSidebar (drag contact to label):**
```tsx
function ContactsSidebar({ ..., onAssignLabel }) {
  // For each label, create a drop target:
  {labels.map(label => {
    const labelDrop = useListDropTarget({
      acceptTypes: ['contact'],
      onDrop: ({ ids }) => onAssignLabel(ids, label.id),
    });

    return (
      <SidebarItem
        key={label.id}
        label={label.name}
        colorDot={label.color}
        to={getLabelPath(label)}
        dropTarget={labelDrop}
      />
    );
  })}
}
```

> **Note on hooks in loops:** The `useListDropTarget` calls inside `.map()` violate
> React's rules of hooks. Instead, create a wrapper component `DroppableSidebarItem`
> that calls the hook internally:
>
> ```tsx
> function DroppableSidebarItem({ dropConfig, ...sidebarProps }) {
>   const dropTarget = useListDropTarget(dropConfig);
>   return <SidebarItem {...sidebarProps} dropTarget={dropTarget} />;
> }
> ```

### Phase 7: Drive-specific internal drag-drop

The existing `useTableDragDrop` handles dragging files INTO folders within the same list. This is different from the generic list drag (which drags TO the sidebar).

**Keep `useTableDragDrop` for drive's internal folder-move behavior.** But also add the generic `useListDrag` for multi-select drag support. The two can coexist:

- `useListDrag` — sets `application/eigen-drag` data (for sidebar drops)
- `useTableDragDrop` — handles `dragOver`/`drop` on folder rows within the table

DriveTable rows get both sets of drag handlers:
```tsx
<TableRow
  {...drag.getDragProps(item)}              // from useListDrag
  onDragOver={(e) => internalDrag.handleDragOver(e, item)}  // from useTableDragDrop
  onDrop={(e) => internalDrag.handleDrop(e, item)}
>
```

---

## Migration Order

Execute these phases in order. Each phase is independently testable.

### Step 1: Add `useKeyboardListNavigation` to ContactsList
- ContactsList is the only list missing this. Add it now before any multi-select work.
- Wire it up exactly like EmailList does.

### Step 2: Create `useListSelection<T>` hook
- Implement in `packages/ui/src/hooks/use-list-selection.ts`
- Export from `packages/ui/src/hooks/index.ts`
- Write unit tests for: select, toggle, selectRange, selectAll, clearSelection, handleItemClick

### Step 3: Integrate `useListSelection` into all three lists
- Start with ContactsList (simplest rendering)
- Then EmailList
- Then DriveTable
- Update CSS: add `eigen-list-item-selected` class for multi-select highlight (different from `eigen-list-item-active`)
- Each row gets: `className={cn("eigen-list-item", isActive && "eigen-list-item-active", selection.isSelected(id) && "eigen-list-item-selected")}`

### Step 4: Create `ListCheckbox` component
- Add to `packages/ui/src/components/layout/list-checkbox.tsx`
- Integrate into each list (conditional on `showCheckboxes` prop)
- Parents pass `showCheckboxes={!isMobile}`

### Step 5: Extend `useKeyboardListNavigation` with selection
- Add Shift+Arrow range selection
- Add Ctrl/Cmd+A select-all
- Add Escape to clear selection
- Pass `selection` as optional parameter

### Step 6: Update context menus for multi-select
- Change callback signatures from single item to array
- Update context menu rendering per selection count (see Phase 4 table)
- Update all parent routes to handle array callbacks

### Step 7: Create `useListDrag<T>` hook
- Implement in `packages/ui/src/hooks/use-list-drag.ts`
- Uses selection to determine dragged items
- Sets `application/eigen-drag` transfer data

### Step 8: Create `useListDropTarget` hook + `DroppableSidebarItem`
- Implement hook in `packages/ui/src/hooks/use-list-drop-target.ts`
- Create `DroppableSidebarItem` wrapper component
- Add visual feedback (highlight) for valid drop targets

### Step 9: Wire up drag-drop in EmailList + EmailSidebar
- Add `useListDrag` to EmailList
- Add `DroppableSidebarItem` to EmailSidebar folder items
- Sidebar's `onDrop` calls `onMoveEmails(ids, folderId)`
- Parent route provides the batch move handler

### Step 10: Wire up drag-drop in ContactsList + ContactsSidebar
- Add `useListDrag` to ContactsList
- Add `DroppableSidebarItem` to ContactsSidebar label items
- Sidebar's `onDrop` calls `onAssignLabel(contactIds, labelId)`
- Parent route provides the batch label handler

### Step 11: Update DriveTable
- Add `useListDrag` alongside existing `useTableDragDrop`
- Keep internal folder-move drag-drop as-is
- Add `DroppableSidebarItem` to DriveSidebar if needed (for moving files between drives/mounts)

---

## New CSS Classes

Add to `packages/ui/src/styles/globals.css`:

```css
.eigen-list-item-selected {
    @apply bg-primary/10;
}

.eigen-list-item-selected.eigen-list-item-active {
    @apply bg-primary/15;
}

.drag-badge {
    position: absolute;
    top: -9999px;
    padding: 4px 12px;
    background: hsl(var(--primary));
    color: white;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
}
```

---

## File Summary

### New files to create:
| File | Type |
|------|------|
| `packages/ui/src/hooks/use-list-selection.ts` | Hook |
| `packages/ui/src/hooks/use-list-drag.ts` | Hook |
| `packages/ui/src/hooks/use-list-drop-target.ts` | Hook |
| `packages/ui/src/components/layout/list-checkbox.tsx` | Component |
| `packages/ui/src/components/layout/sidebar/droppable-sidebar-item.tsx` | Component |

### Files to modify:
| File | Changes |
|------|---------|
| `packages/ui/src/hooks/use-keyboard-list-navigation.ts` | Add Shift+Arrow, Ctrl+A, Escape |
| `packages/ui/src/hooks/index.ts` | Export new hooks |
| `packages/ui/src/styles/globals.css` | Add `eigen-list-item-selected`, `drag-badge` |
| `packages/ui/src/components/layout/sidebar/sidebar-item.tsx` | Add optional `dropTarget` prop |
| `apps/contacts/src/components/contacts/contacts-list.tsx` | Add keyboard nav, selection, drag, checkboxes, update context menu |
| `apps/mail/src/components/mail/email-list.tsx` | Add selection, drag, checkboxes, update context menu |
| `apps/mail/src/components/mail/email-context-menu.tsx` | Support multi-select actions |
| `apps/mail/src/components/mail/email-sidebar.tsx` | Add drop targets to folder items |
| `apps/mail/src/routes/_auth.$filterType.$filterId.tsx` | Update callbacks to array signatures, add batch handlers |
| `packages/ui/src/components/layout/drive/drive-table.tsx` | Add selection, update context menu, add generic drag |
| `packages/ui/src/components/layout/drive/drive-list.tsx` | Pass selection props |
| `packages/ui/src/components/layout/drive/drive-layout.tsx` | Update callbacks |
| `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx` | Update callbacks, add batch handlers |
| `apps/contacts/src/components/contacts/contacts-sidebar.tsx` | Add drop targets to label items |

### Files that can be removed after migration:
| File | Reason |
|------|--------|
| `packages/ui/src/components/layout/drive/use-table-drag-drop.ts` | **Keep** — still needed for drive's internal folder-move |

---

## Testing Checklist

For each list (Drive, Mail, Contacts), verify:

- [ ] **Click** selects single item, deselects others
- [ ] **Ctrl/Cmd+Click** toggles item in selection
- [ ] **Shift+Click** range-selects from anchor
- [ ] **Arrow keys** navigate and select
- [ ] **Shift+Arrow** extends selection
- [ ] **Ctrl/Cmd+A** selects all
- [ ] **Escape** clears selection
- [ ] **Delete key** deletes all selected items (with confirmation)
- [ ] **Right-click selected item** shows context menu for all selected
- [ ] **Right-click unselected item** clears selection, selects that item, shows single context menu
- [ ] **Checkboxes** appear on desktop, hidden on mobile
- [ ] **Drag single item** works (mail→folder, contact→label)
- [ ] **Drag multi-selection** moves all selected items
- [ ] **Drag unselected item** selects only that item, then drags it
- [ ] **Drop target highlight** shows on valid sidebar items
- [ ] **Invalid drop** (wrong type) shows no-drop cursor
- [ ] **Context menu shows correct actions** for single vs multi (see Phase 4 table)
