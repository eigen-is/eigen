# Layout System

Responsive multi-column layout with toolbar management across desktop and mobile.

## Overview

```
AppShell
├── Topbar              (blue header bar, app logo, toolbar slots, user dropdown)
├── SecondaryToolbar    (mobile only: back button + active column toolbar)
└── Content Area
    ├── SidebarContainer (collapsible sidebar)
    └── Main
        └── ColumnLayout
            ├── Column "list"    (fixed width, e.g. 350px)
            └── Column "detail"  (flex, fills remaining space)
```

**Desktop:** All columns visible side-by-side. Toolbars render in the Topbar, aligned with their column widths.

**Mobile:** Only the active column is visible. Toolbars render in the SecondaryToolbar below the Topbar.

---

## File Locations

| Purpose | Location |
|---------|----------|
| AppShell | `packages/ui/src/components/layout/app-shell.tsx` |
| LayoutContext | `packages/ui/src/components/layout/layout-context.tsx` |
| Column / ColumnLayout | `packages/ui/src/components/layout/column-layout.tsx` |
| Topbar | `packages/ui/src/components/layout/topbar.tsx` |
| SecondaryToolbar | `packages/ui/src/components/layout/secondary-toolbar.tsx` |
| SidebarContainer | `packages/ui/src/components/layout/sidebar/sidebar-container.tsx` |
| TooltipButton | `packages/ui/src/components/layout/tooltip-button/tooltip-button.tsx` |

---

## 1. AppShell

Every app wraps its root route in `AppShell`:

```tsx
export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: () => (
        <AppShell
            appName="contacts"
            rootRoute={Route}
            sidebar={({condensed, isMobile, onClose}) => (
                <ContactsSidebar condensed={condensed} isMobile={isMobile} onClose={onClose}/>
            )}
        >
            <Outlet/>
        </AppShell>
    ),
});
```

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `appName` | `string` | required | Shown in Topbar and `document.title` |
| `rootRoute` | `{ useNavigate }` | required | TanStack Router root route for navigation |
| `sidebar` | `ReactNode \| (props) => ReactNode` | `undefined` | Sidebar content. If omitted, no sidebar. |
| `sidebarMode` | `'collapsible' \| 'hidden' \| 'none'` | `'collapsible'` | `collapsible`: full sidebar on desktop, sheet on mobile. `hidden`: icon-only on desktop. `none`: no sidebar at all. |

---

## 2. ColumnLayout & Column

Routes define their column structure using `ColumnLayout` and `Column`:

```tsx
function ContactsRoute() {
    const {isMobile, navigateToColumn} = useLayout();

    // Control which column is active on mobile
    const targetCol = isMobile ? (contactId ? 'detail' : 'list') : 'list';
    useEffect(() => {
        navigateToColumn(targetCol);
    }, [targetCol, navigateToColumn]);

    return (
        <ColumnLayout>
            <Column id="list" width="350px" toolbar={<ListToolbar/>}>
                <ContactsList/>
            </Column>
            <Column id="detail" width="flex" onBack={handleBackToList} toolbar={<DetailToolbar/>}>
                <ContactDetail/>
            </Column>
        </ColumnLayout>
    );
}
```

### Column Props

| Prop | Type | Description |
|------|------|-------------|
| `id` | `string` | Unique column identifier |
| `width` | `string` | CSS width (`"350px"`) or `"flex"` to fill remaining space |
| `toolbar` | `ReactNode` | Toolbar content rendered in Topbar (desktop) or SecondaryToolbar (mobile) |
| `onBack` | `() => void` | Back navigation callback. Shown as ← button in SecondaryToolbar on mobile. |
| `children` | `ReactNode` | Column content |

### Single-Column Routes

For routes like edit/create that don't need multiple columns, still use `ColumnLayout` for consistency:

```tsx
function EditContactRoute() {
    const {navigateToColumn} = useLayout();

    useEffect(() => {
        navigateToColumn('editor');
    }, [navigateToColumn]);

    return (
        <ColumnLayout>
            <Column id="editor" width="flex" onBack={handleCancel} toolbar={<EditToolbar/>}>
                <ContactEdit/>
            </Column>
        </ColumnLayout>
    );
}
```

---

## 3. Toolbars

Toolbar content is defined as a React component, co-located with the view it belongs to. Each file exports both the view and its toolbar:

```
contacts-list.tsx    → ContactsList + ContactsListToolbar
contact-detail.tsx   → ContactDetail + ContactDetailToolbar
contact-edit.tsx     → ContactEdit + ContactEditToolbar
```

### How It Works (Portal-Based)

Toolbars use React portals to render content into the correct location:

1. `Column` registers a **toolbar slot** (just `columnId` + `width`) on mount via `registerToolbar()`
2. `Topbar` renders empty `<div data-toolbar-slot="{columnId}">` elements for each slot
3. `ToolbarPortal` (inside `Column`) uses `createPortal()` to render toolbar content into the matching DOM node
4. On mobile, toolbar content portals into `SecondaryToolbar`'s `<div data-secondary-toolbar-slot>` instead

### Toolbar Styling

The Topbar toolbar slots automatically apply white text and hover styles to all buttons:

```
[&_button]:text-white [&_button:hover]:bg-primary/20
```

This means toolbar components don't need to handle Topbar vs SecondaryToolbar color differences — they just render normal buttons and the container handles the styling.

Use `TooltipButton` for icon buttons in toolbars:

```tsx
<TooltipButton icon={Edit} tooltipText="Edit" onClick={handleEdit}/>
```

For buttons that trigger a dropdown, use `Button` with the same sizing as `TooltipButton`:

```tsx
<DropdownMenu>
    <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
            <MoreVertical className="h-4 w-4"/>
        </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent>...</DropdownMenuContent>
</DropdownMenu>
```

---

## 4. Mobile Navigation

On mobile, only one column is visible at a time. The route controls which column is active.

### Pattern

```tsx
const targetCol = isMobile ? (hasSelection ? 'detail' : 'list') : 'list';

useEffect(() => {
    navigateToColumn(targetCol);
}, [targetCol, navigateToColumn]);
```

### Back Navigation

The `onBack` prop on `Column` provides route-specific back navigation:

```tsx
<Column id="detail" width="flex" onBack={handleBackToList} toolbar={...}>
```

- `SecondaryToolbar` shows a ← button when the active column has an `onBack` registered
- The callback should **navigate the URL** (e.g., clear the selected item from search params)
- This ensures the URL and column state stay in sync

### Single-Column Routes on Mobile

Routes that render a single column (edit, create) must call `navigateToColumn()` on mount, otherwise the column won't be visible:

```tsx
useEffect(() => {
    navigateToColumn('editor');
}, [navigateToColumn]);
```

---

## 5. Pitfalls

### Toolbar content must not be stored in state

Early iterations stored toolbar JSX in React state (`useState`). This causes infinite re-render loops because JSX creates a new object reference every render → state update → re-render → new JSX → state update → ∞.

**Solution:** The current system uses React portals. `Column` renders its toolbar content normally in the React tree, and `createPortal()` moves it to the correct DOM node. No state involved for content.

### `onBack` must navigate the URL

If `onBack` only calls `goBack()` (which pops column history), the URL retains stale params (e.g., `?contactId=...`). On the next navigation, the route computes the same `targetCol` as before, the `useEffect` doesn't fire, and the column doesn't switch.

**Solution:** `onBack` should always navigate the URL to clear selection params. The URL change triggers a re-render, which updates `targetCol`, which triggers `navigateToColumn()`.

### Single-column routes need `navigateToColumn()` on mount

When navigating from a multi-column route (e.g., contacts list/detail) to a single-column route (e.g., edit), the `activeColumn` is still set to the previous route's column ID. The new route's `Column` has a different ID, so on mobile it's hidden.

**Solution:** Always call `navigateToColumn('your-column-id')` in a `useEffect` on mount.

### `navigateToColumn` skips if already active

`navigateToColumn(id)` is a no-op if `activeColumn` is already `id`. This prevents duplicate history entries but means you can't "re-navigate" to the same column to force a re-render.

### Portal timing on first render

On the very first render, the Topbar slot DOM nodes don't exist yet when `Column` mounts. `ToolbarPortal` handles this with a `requestAnimationFrame` fallback to retry finding the node on the next frame.

---

## 6. Summary

| Component | Desktop | Mobile |
|-----------|---------|--------|
| `Topbar` | Logo + toolbar slots (aligned with columns) + user dropdown | Logo + burger menu + user dropdown |
| `SecondaryToolbar` | Hidden | Back button (if `onBack`) + active column toolbar |
| `Column` | All columns visible side-by-side | Only `activeColumn` visible |
| `ColumnLayout` | Flex row container | Same, but only one child renders |

### Adding a New App

1. Create `__root.tsx` with `AppShell` wrapper
2. Define routes with `ColumnLayout` and `Column`
3. Export toolbar components alongside view components
4. Call `navigateToColumn()` in `useEffect` to set the active column on mobile
5. Provide `onBack` on non-root columns for mobile back navigation
