# Adding Lists to Eigen

Setup guide for building interactive lists with multi-select, keyboard navigation, drag-and-drop, and context menus.

## Hooks

All list behavior is driven by composable hooks. No shared list component — each list owns its own rendering (table, divs, grouped links, etc.).

| Hook | Location | Purpose |
|------|----------|---------|
| `useListSelection<T>` | `packages/ui/src/hooks/use-list-selection.ts` | Multi-select: click, Ctrl+click, Shift+click, select-all |
| `useKeyboardListNavigation<T>` | `packages/ui/src/hooks/use-keyboard-list-navigation.ts` | Arrow keys, Home/End, Shift+Arrow range, Ctrl+A, Escape |
| `useListDrag<T>` | `packages/ui/src/hooks/use-list-drag.ts` | Drag items from list (selection-aware, multi-drag badge) |
| `useListDropTarget` | `packages/ui/src/hooks/use-list-drop-target.ts` | Accept drops on sidebar items (folders, labels) |
| `useContextMenu<T>` | `packages/ui/src/components/layout/context-menu/use-context-menu.ts` | Right-click context menu position + item tracking |

## CSS Classes

Defined in `packages/ui/src/styles/globals.css`:

| Class | Purpose |
|-------|---------|
| `eigen-list-item` | Base row style (white bg, pointer, user-select none) |
| `eigen-list-item-active` | Keyboard-focused or URL-active row |
| `eigen-list-item-selected` | Multi-selected row (blue highlight) |
| `eigen-list-item-unread` | Unread indicator (mail-specific, red left border) |
| `drag-badge` | Off-screen badge used as drag image for multi-drag |

## Minimal Setup

### 1. Selection + Keyboard Nav

```tsx
const selection = useListSelection({items, getId: (item) => item.id});

const {selectedIndex, handleKeyDown} = useKeyboardListNavigation({
    items,
    activeId,                    // URL-driven active item
    getId: (item) => item.id,
    onSelect: (id) => navigate(id),
    containerRef: listRef,
    selection,                   // enables Shift+Arrow, Ctrl+A, Escape
});
```

### 2. Row Rendering

```tsx
<div ref={listRef} tabIndex={0} onKeyDown={handleKeyDown} className="outline-none">
    {items.map((item, index) => (
        <div
            key={item.id}
            className={cn(
                "eigen-list-item",
                (activeId === item.id || selectedIndex === index) && "eigen-list-item-active",
                selection.isSelected(item.id) && "eigen-list-item-selected",
            )}
            onClick={(e) => {
                selection.handleItemClick(item.id, e);
                if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                    onRowClick(item.id);
                }
            }}
        >
            {/* row content */}
        </div>
    ))}
</div>
```

### 3. Context Menu (multi-select aware)

```tsx
const contextMenu = useContextMenu<MyItem>();

const handleContextMenu = (e: React.MouseEvent, item: MyItem) => {
    if (!selection.isSelected(item.id)) selection.select(item.id);
    contextMenu.handleContextMenu(e, item);
};

const contextItems = contextMenu.item
    ? (selection.selectedCount > 1 ? selection.selectedItems : [contextMenu.item])
    : [];
const isSingleSelect = contextItems.length === 1;
```

Add `onContextMenu={(e) => handleContextMenu(e, item)}` to each row. In the menu, use `isSingleSelect` to show/hide single-only actions (Edit, Open, Reply) and `contextItems` for batch actions (Delete N items).

### 4. Drag-and-Drop (optional)

```tsx
const drag = useListDrag({selection, getId: (item) => item.id, dragType: 'my-type'});

// On each row:
{...drag.getDragProps(item)}
```

Sidebar drop targets use `DroppableSidebarItem` (wraps `SidebarItem` + `useListDropTarget`):

```tsx
<DroppableSidebarItem
    acceptTypes={['my-type']}
    onDrop={({ids}) => handleMove(ids, targetId)}
    icon={<Folder />}
    label="Target"
    to="/path"
/>
```

## Existing Lists

| List | Location | Element | Drag type |
|------|----------|---------|-----------|
| `DriveTable` | `packages/ui/src/components/layout/drive/drive-table.tsx` | `<Table>` rows | `drive-item` |
| `EmailList` | `apps/mail/src/components/mail/email-list.tsx` | `<div>` rows | `email` |
| `ContactsList` | `apps/contacts/src/components/contacts/contacts-list.tsx` | Grouped `<div>` rows | `contact` |

All three follow the same pattern: `useListSelection` → `useKeyboardListNavigation` → `useListDrag` → `useContextMenu` → row rendering with CSS classes.

DriveTable additionally handles internal folder-drop (dragging files into folder rows) via inline `onDragOver`/`onDrop` handlers on `<TableRow>`.
