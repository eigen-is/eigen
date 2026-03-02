# Layout System

Responsive multi-column layout with per-column toolbars and declarative mobile column switching.

## Overview

```
AppShell
├── Topbar              (blue header bar, app logo, user dropdown)
└── Content Area
    ├── SidebarContainer (collapsible sidebar)
    └── Main
        └── ColumnLayout
            ├── Column "list"    (fixed width, toolbar + content)
            └── Column "detail"  (flex width, toolbar + content)
```

**Desktop:** All columns visible side-by-side. Each column renders its own toolbar (h-12) above its content.
**Mobile:** Only the `mobileColumn` is visible. Its toolbar includes a ← back button when `onBack` is provided.

## File Locations

| Purpose | Location |
|---------|----------|
| AppShell | `packages/ui/src/components/layout/app-shell.tsx` |
| LayoutContext | `packages/ui/src/components/layout/layout-context.tsx` |
| Column / ColumnLayout | `packages/ui/src/components/layout/column-layout.tsx` |
| Topbar | `packages/ui/src/components/layout/topbar.tsx` |
| SidebarContainer | `packages/ui/src/components/layout/sidebar/sidebar-container.tsx` |
| TooltipButton | `packages/ui/src/components/layout/tooltip-button/tooltip-button.tsx` |

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

## 2. ColumnLayout & Column

Routes define their column structure using `ColumnLayout` and `Column`. The `mobileColumn` prop on `ColumnLayout` declaratively controls which column is visible on mobile:

```tsx
function ContactsRoute() {
    return (
        <ColumnLayout mobileColumn={contactId ? 'detail' : 'list'}>
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

| Prop       | Type         | Description                                                                 |
|------------|--------------|-----------------------------------------------------------------------------|
| `id`       | `string`     | Unique identifier (must match `mobileColumn` value to be visible on mobile) |
| `width`    | `string`     | CSS width (`"350px"`) or `"flex"` to fill remaining space                   |
| `toolbar`  | `ReactNode`  | Rendered as a h-12 bar above column content                                 |
| `onBack`   | `() => void` | Back navigation callback. Renders a ← button in the toolbar on mobile.      |
| `children` | `ReactNode`  | Column content                                                              |

### Single-Column Routes

For routes like edit/create, use `ColumnLayout` with `mobileColumn` set to the single column's id:

```tsx
function EditContactRoute() {
    return (
        <ColumnLayout mobileColumn="editor">
            <Column id="editor" width="flex" onBack={handleCancel} toolbar={<EditToolbar/>}>
                <ContactEdit/>
            </Column>
        </ColumnLayout>
    );
}
```

## 3. Toolbars

Toolbar content is defined as a React component, co-located with the view it belongs to. Each file exports both the view and its toolbar:

```
contacts-list.tsx    → ContactsList + ContactsListToolbar
contact-detail.tsx   → ContactDetail + ContactDetailToolbar
contact-edit.tsx     → ContactEdit + ContactEditToolbar
```

Use `TooltipButton` for icon buttons in toolbars:

```tsx
<TooltipButton icon={Edit} tooltipText="Edit" onClick={handleEdit}/>
```

## 4. Mobile Navigation

On mobile, only one column is visible at a time. The `mobileColumn` prop on `ColumnLayout` controls which one:

```tsx
<ColumnLayout mobileColumn={contactId ? 'detail' : 'list'}>
```

This is **declarative** — when the URL changes, React re-renders and `mobileColumn` updates automatically. No imperative
navigation needed.

The `onBack` prop on `Column` should navigate the URL to go "back":

```tsx
<Column id="detail" width="flex" onBack={handleBackToList} toolbar={<DetailToolbar/>}>
```

## 5. LayoutContext

`useLayout()` provides:

| Field            | Type             | Description                  |
|------------------|------------------|------------------------------|
| `appName`        | `string`         | Current app name             |
| `setAppName`     | `(name) => void` | Update app name              |
| `sidebarOpen`    | `boolean`        | Mobile sidebar overlay state |
| `setSidebarOpen` | `(open) => void` | Toggle mobile sidebar        |
| `sidebarMode`    | `string`         | Current sidebar mode         |
| `isMobile`       | `boolean`        | Mobile breakpoint            |
| `isTablet`       | `boolean`        | Tablet breakpoint            |

Convenience hooks: `useApp()` returns `{appName, setAppName}`. `useSidebar()` returns `{sidebarOpen, setSidebarOpen}`.

## 6. DriveLayout (Shared Component)

`DriveLayout` is a shared component in `packages/ui/src/components/layout/drive/drive-layout.tsx` used by the Drive,
Docs, and Stickies apps. It internally uses `ColumnLayout` + `Column` and `useLayout()` for responsive behavior.

```tsx
<DriveLayout
    ownerId={ownerId}
    mountId={mountId}
    folderContents={folderContents}
    isLoading={isLoading}
    error={error}
    onRowSelect={onRowSelect}
    onRowActivate={onRowActivate}
    onBackToList={handleBackToList}
    onAfterAction={handleAfterAction}
    showBreadcrumb={true}
    pid={pid}
/>
```

- **List column**: `DriveList` renders its own internal toolbar (breadcrumb + "New" button on mobile).
- **Detail column**: `DriveDetailToolbar` is extracted and passed to `Column` via `toolbar` prop.
- **Mobile**: `mobileColumn` switches between list and detail based on selection state.
- **Desktop**: detail Column conditionally renders when an item is selected.

## 7. Summary

| Component | Desktop | Mobile |
|-----------|---------|--------|
| `Topbar` | Logo + user dropdown | Logo + burger menu + user dropdown |
| `Column` toolbar | h-12 bar above column content | h-12 bar with ← back button (if `onBack`) |
| `Column` | All columns visible side-by-side | Only `mobileColumn` visible |
| `ColumnLayout` | Flex row container | Same, but only matching child renders |

### Adding a New App

1. Create `__root.tsx` with `AppShell` wrapper.
2. Define routes with `ColumnLayout` and `Column`.
3. Set `mobileColumn` on `ColumnLayout` based on URL params.
4. Export toolbar components alongside view components.
5. Provide `onBack` on non-root columns for mobile back navigation.
