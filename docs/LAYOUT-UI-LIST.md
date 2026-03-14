# List Patterns

> **TLDR**: Interactive lists use composable hooks: `useListSelection` → `useKeyboardListNavigation` → `useListDrag` →
`useContextMenu`. No shared list component — each list owns its rendering. CSS classes in
`packages/ui/src/styles/globals.css`.

## Hooks

| Hook                           | File                                                                 | Purpose                                                  |
|--------------------------------|----------------------------------------------------------------------|----------------------------------------------------------|
| `useListSelection<T>`          | `packages/ui/src/hooks/use-list-selection.ts`                        | Multi-select: click, Ctrl+click, Shift+click, select-all |
| `useKeyboardListNavigation<T>` | `packages/ui/src/hooks/use-keyboard-list-navigation.ts`              | Arrow keys, Home/End, Shift+Arrow, Ctrl+A, Escape        |
| `useListDrag<T>`               | `packages/ui/src/hooks/use-list-drag.ts`                             | Drag from list (multi-drag badge)                        |
| `useListDropTarget`            | `packages/ui/src/hooks/use-list-drop-target.ts`                      | Drop on sidebar items                                    |
| `useContextMenu<T>`            | `packages/ui/src/components/layout/context-menu/use-context-menu.ts` | Right-click context menu                                 |

## CSS Classes

Defined in `packages/ui/src/styles/globals.css`:

| Class                      | Purpose                                      |
|----------------------------|----------------------------------------------|
| `eigen-list-item`          | Base row (white bg, pointer, no user-select) |
| `eigen-list-item-active`   | Keyboard-focused / URL-active row            |
| `eigen-list-item-selected` | Multi-selected (blue highlight)              |
| `eigen-list-item-unread`   | Unread indicator (red left border)           |
| `drag-badge`               | Off-screen badge for multi-drag image        |

## Setup Pattern

### 1. Selection + Keyboard

```tsx
const selection = useListSelection({ items, getId: (item) => item.id });
const { selectedIndex, handleKeyDown } = useKeyboardListNavigation({
    items, activeId, getId: (item) => item.id,
    onSelect: (id) => navigate(id),
    containerRef: listRef, selection,
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
                if (!e.shiftKey && !e.metaKey && !e.ctrlKey) onRowClick(item.id);
            }}
        >
            {/* content */}
        </div>
    ))}
</div>
```

### 3. Context Menu

```tsx
const contextMenu = useContextMenu<MyItem>();
const contextItems = contextMenu.item
    ? (selection.selectedCount > 1 ? selection.selectedItems : [contextMenu.item])
    : [];
```

### 4. Drag-and-Drop

```tsx
const drag = useListDrag({ selection, getId: (item) => item.id, dragType: 'my-type' });
// On rows: {...drag.getDragProps(item)}
// Sidebar: <DroppableSidebarItem acceptTypes={['my-type']} onDrop={...} />
```

## Existing Lists

| List           | File                                                      | Drag type    |
|----------------|-----------------------------------------------------------|--------------|
| `DriveTable`   | `packages/ui/src/components/layout/drive/drive-table.tsx` | `drive-item` |
| `EmailList`    | `apps/mail/src/components/mail/email-list.tsx`            | `email`      |
| `ContactsList` | `apps/contacts/src/components/contacts/contacts-list.tsx` | `contact`    |
