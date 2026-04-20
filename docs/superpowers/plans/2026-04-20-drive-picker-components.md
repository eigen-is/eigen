# Drive Picker Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build shared `DriveFilePicker` and `DriveLocationPicker` dialog components for attaching files from drive and selecting drive destinations.

**Architecture:** A shared `DriveBrowser` primitive handles mount selection + folder navigation. Two dialog components (`DriveFilePicker`, `DriveLocationPicker`) wrap it with different configs and footer actions. A `DriveMountList` renders the selectable left column.

**Tech Stack:** React 19, TanStack Query hooks (`useFolderContent`, `useRootFolder`, `useBreadcrumb`, `useMyTeams`, `useCreateFolder`), existing `DriveTable` component, shadcn Dialog/Breadcrumb, Tailwind CSS 4, Lucide icons.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/ui/src/components/layout/drive/drive-mount-list.tsx` | Standalone selectable mount list (personal + team mounts) |
| `packages/ui/src/components/layout/drive/drive-browser.tsx` | Shared browsing core: mount list + folder list + breadcrumb + navigation state |
| `packages/ui/src/components/layout/drive/drive-file-picker.tsx` | Dialog: attach file from drive (wraps DriveBrowser mode="file") |
| `packages/ui/src/components/layout/drive/drive-location-picker.tsx` | Dialog: choose destination folder (wraps DriveBrowser mode="folder", 3 sub-modes) |
| `packages/ui/src/components/layout/drive/index.ts` | Add exports for new components |

---

### Task 1: DriveMountList

**Files:**
- Create: `packages/ui/src/components/layout/drive/drive-mount-list.tsx`

- [ ] **Step 1: Create DriveMountList component**

```tsx
import { useRootFolder } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import { cn } from '@workspace/ui/lib/utils';
import { HardDrive, Users } from 'lucide-react';

type DriveMountListProps = {
    ownerId: string;
    activeMountId: string;
    activeOwnerId: string;
    onMountSelect: (ownerId: string, mountId: string) => void;
};

export function DriveMountList({ ownerId, activeMountId, activeOwnerId, onMountSelect }: DriveMountListProps) {
    const { data: myTeams } = useMyTeams();

    return (
        <div className="w-44 flex-shrink-0 border-r overflow-y-auto">
            <div className="px-3 pt-2 pb-1">
                <span className="text-xs font-medium text-muted-foreground uppercase">My Drive</span>
            </div>
            <MountItem
                label="Drive"
                icon={<HardDrive className="h-4 w-4" />}
                active={activeOwnerId === ownerId && activeMountId === 'default'}
                onClick={() => onMountSelect(ownerId, 'default')}
            />

            {myTeams?.some((t) => t.mounts.length > 0) && (
                <>
                    <div className="px-3 pt-3 pb-1">
                        <span className="text-xs font-medium text-muted-foreground uppercase">Teams</span>
                    </div>
                    {myTeams.flatMap((team) =>
                        team.mounts.map((mount) => (
                            <MountItem
                                key={`${team.id}-${mount.id}`}
                                label={mount.name}
                                icon={<Users className="h-4 w-4" />}
                                active={activeOwnerId === teamOwnerId(team.id) && activeMountId === mount.id}
                                onClick={() => onMountSelect(teamOwnerId(team.id), mount.id)}
                            />
                        )),
                    )}
                </>
            )}
        </div>
    );
}

function MountItem({
    label,
    icon,
    active,
    onClick,
}: {
    label: string;
    icon: React.ReactNode;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-accent rounded-sm mx-1',
                active && 'bg-accent font-medium',
            )}
            onClick={onClick}
        >
            {icon}
            <span className="truncate">{label}</span>
        </button>
    );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bun run typecheck`
Expected: No errors in the new file.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/layout/drive/drive-mount-list.tsx
git commit -m "feat(drive): add DriveMountList component"
```

---

### Task 2: DriveBrowser

**Files:**
- Create: `packages/ui/src/components/layout/drive/drive-browser.tsx`

- [ ] **Step 1: Create DriveBrowser component**

```tsx
import { useBreadcrumb, useFolderContent, useCreateFolder, useRootFolder } from '@workspace/lib/drive';
import { isFolderType, type DrivePath } from '@workspace/lib/types/drive';
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@workspace/ui/components/breadcrumb';
import { Button } from '@workspace/ui/components/button';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
} from '@workspace/ui/components/context-menu';
import { cn } from '@workspace/ui/lib/utils';
import { FolderPlus } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { defaultDriveSort, DriveTable } from './drive-table';
import { DriveMountList } from './drive-mount-list';
import { getFileIcon } from './file-icon-helper';
import { DriveCreateItemDialog } from './drive-create-folder-item';

type DriveBrowserProps = {
    ownerId: string;
    mode: 'file' | 'folder';
    mimeFilter?: string[];
    selectedId?: string | null;
    onSelect: (path: DrivePath) => void;
    onConfirm?: (path: DrivePath) => void;
    onFolderChange?: (folder: DrivePath, mountId: string) => void;
    defaultMountId?: string;
    defaultFolderId?: string;
    showNewFolder?: boolean;
    className?: string;
};

function matchesMimeFilter(mimeType: string, filters: string[]): boolean {
    return filters.some((filter) => {
        if (filter.endsWith('/*')) {
            return mimeType.startsWith(filter.slice(0, -1));
        }
        return mimeType === filter;
    });
}

export function DriveBrowser({
    ownerId,
    mode,
    mimeFilter,
    selectedId,
    onSelect,
    onConfirm,
    onFolderChange,
    defaultMountId = 'default',
    defaultFolderId,
    showNewFolder = mode === 'folder',
    className,
}: DriveBrowserProps) {
    const [activeOwnerId, setActiveOwnerId] = useState(ownerId);
    const [activeMountId, setActiveMountId] = useState(defaultMountId);
    const [currentFolderId, setCurrentFolderId] = useState<string | null>(defaultFolderId ?? null);
    const [createFolderOpen, setCreateFolderOpen] = useState(false);

    const { data: rootFolder } = useRootFolder(activeOwnerId, activeMountId);

    const folderId = currentFolderId || rootFolder?.id || '';
    const { data: folderContents = [], isLoading } = useFolderContent(activeOwnerId, activeMountId, folderId);
    const { data: breadcrumbPaths = [] } = useBreadcrumb(activeOwnerId, activeMountId, folderId);
    const createFolderMutation = useCreateFolder(activeOwnerId, activeMountId);

    useEffect(() => {
        if (!currentFolderId && rootFolder?.id) {
            setCurrentFolderId(rootFolder.id);
        }
    }, [rootFolder?.id, currentFolderId]);

    const handleMountSelect = useCallback(
        (newOwnerId: string, newMountId: string) => {
            setActiveOwnerId(newOwnerId);
            setActiveMountId(newMountId);
            setCurrentFolderId(null);
        },
        [],
    );

    const displayItems = useMemo(() => {
        if (mode === 'folder') {
            return folderContents.filter((item) => isFolderType(item.type));
        }
        return folderContents;
    }, [folderContents, mode]);

    const handleItemClick = useCallback(
        (item: DrivePath) => {
            if (isFolderType(item.type)) {
                setCurrentFolderId(item.id);
                onFolderChange?.(item, activeMountId);
            } else if (mode === 'file') {
                if (mimeFilter && !matchesMimeFilter(item.mimeType, mimeFilter)) return;
                onSelect(item);
            }
        },
        [mode, mimeFilter, onSelect, onFolderChange, activeMountId],
    );

    const handleItemOpen = useCallback(
        (item: DrivePath) => {
            if (isFolderType(item.type)) {
                setCurrentFolderId(item.id);
                onFolderChange?.(item, activeMountId);
            } else if (mode === 'file') {
                if (mimeFilter && !matchesMimeFilter(item.mimeType, mimeFilter)) return;
                onConfirm?.(item);
            }
        },
        [mode, mimeFilter, onConfirm, onFolderChange, activeMountId],
    );

    const handleBreadcrumbClick = (path: DrivePath) => {
        setCurrentFolderId(path.id);
        onFolderChange?.(path, activeMountId);
    };

    const handleCreateFolder = async (folderName: string) => {
        const newPath = await createFolderMutation.mutateAsync({ parentId: folderId, folderName });
        setCreateFolderOpen(false);
        if (newPath) {
            setCurrentFolderId(newPath.id);
            onFolderChange?.(newPath, activeMountId);
        }
    };

    const currentFolder = breadcrumbPaths[breadcrumbPaths.length - 1] ?? null;

    return (
        <div className={cn('flex h-full', className)}>
            <DriveMountList
                ownerId={ownerId}
                activeMountId={activeMountId}
                activeOwnerId={activeOwnerId}
                onMountSelect={handleMountSelect}
            />

            <div className="flex-1 flex flex-col overflow-hidden">
                {/* Breadcrumb bar */}
                <div className="flex items-center justify-between px-3 py-1.5 border-b min-h-9">
                    <Breadcrumb className="overflow-hidden">
                        <BreadcrumbList>
                            {breadcrumbPaths.map((path, index) => (
                                <Fragment key={path.id}>
                                    {index > 0 && <BreadcrumbSeparator />}
                                    <BreadcrumbItem>
                                        {index === breadcrumbPaths.length - 1 ? (
                                            <BreadcrumbPage>{path.name || 'Drive'}</BreadcrumbPage>
                                        ) : (
                                            <BreadcrumbLink
                                                onClick={() => handleBreadcrumbClick(path)}
                                                className="cursor-pointer"
                                            >
                                                {path.name || 'Drive'}
                                            </BreadcrumbLink>
                                        )}
                                    </BreadcrumbItem>
                                </Fragment>
                            ))}
                        </BreadcrumbList>
                    </Breadcrumb>

                    {showNewFolder && (
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setCreateFolderOpen(true)}>
                            <FolderPlus className="h-3.5 w-3.5 mr-1" />
                            New folder
                        </Button>
                    )}
                </div>

                {/* Mime filter chip */}
                {mimeFilter && mode === 'file' && (
                    <div className="px-3 py-1 border-b">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-accent text-accent-foreground">
                            {mimeFilter.length === 1 && mimeFilter[0].endsWith('/*')
                                ? `${mimeFilter[0].split('/')[0]} files only`
                                : 'Filtered'}
                        </span>
                    </div>
                )}

                {/* File/folder list */}
                <ContextMenu>
                    <ContextMenuTrigger asChild>
                        <div className="flex-1 overflow-auto">
                            <DriveTable
                                items={displayItems}
                                currentPath={currentFolder}
                                activeItemId={selectedId ?? undefined}
                                onItemClick={handleItemClick}
                                onItemOpen={handleItemOpen}
                                getFileIcon={(mimeType, type, props) => {
                                    if (mode === 'file' && mimeFilter && !isFolderType(type as any)) {
                                        const dimmed = !matchesMimeFilter(mimeType, mimeFilter);
                                        return getFileIcon(mimeType, type, {
                                            ...props,
                                            className: cn(
                                                (props as any)?.className,
                                                dimmed && 'opacity-35',
                                            ),
                                        });
                                    }
                                    return getFileIcon(mimeType, type, props);
                                }}
                                sortFn={defaultDriveSort}
                                showParentRow={breadcrumbPaths.length > 1}
                            />
                        </div>
                    </ContextMenuTrigger>
                    {showNewFolder && (
                        <ContextMenuContent>
                            <ContextMenuItem onSelect={() => setCreateFolderOpen(true)}>
                                <FolderPlus className="h-4 w-4 mr-2" />
                                New folder
                            </ContextMenuItem>
                        </ContextMenuContent>
                    )}
                </ContextMenu>
            </div>

            {/* Create folder dialog */}
            {showNewFolder && currentFolder && (
                <DriveCreateItemDialog
                    open={createFolderOpen}
                    onOpenChange={setCreateFolderOpen}
                    onCreateItem={handleCreateFolder}
                    isPending={createFolderMutation.isPending}
                    type="Folder"
                    path={currentFolder}
                />
            )}
        </div>
    );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bun run typecheck`
Expected: No errors in the new file.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/layout/drive/drive-browser.tsx
git commit -m "feat(drive): add DriveBrowser shared browsing component"
```

---

### Task 3: DriveFilePicker

**Files:**
- Create: `packages/ui/src/components/layout/drive/drive-file-picker.tsx`

- [ ] **Step 1: Create DriveFilePicker component**

```tsx
import { useAuth } from '@workspace/lib/auth';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Upload } from 'lucide-react';
import { useCallback, useState } from 'react';
import { DriveBrowser } from './drive-browser';

type DriveFilePickerProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (paths: DrivePath[]) => void;
    onUploadFromDevice?: () => void;
    mimeFilter?: string[];
    title?: string;
    multiple?: boolean;
};

export function DriveFilePicker({
    open,
    onOpenChange,
    onSelect,
    onUploadFromDevice,
    mimeFilter,
    title = 'Attach file',
    multiple = false,
}: DriveFilePickerProps) {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const [selected, setSelected] = useState<DrivePath | null>(null);

    const handleSelect = useCallback((path: DrivePath) => {
        setSelected(path);
    }, []);

    const handleConfirm = useCallback(
        (path: DrivePath) => {
            onSelect([path]);
            onOpenChange(false);
            setSelected(null);
        },
        [onSelect, onOpenChange],
    );

    const handleSubmit = () => {
        if (selected) {
            onSelect([selected]);
            onOpenChange(false);
            setSelected(null);
        }
    };

    const handleOpenChange = (nextOpen: boolean) => {
        if (!nextOpen) setSelected(null);
        onOpenChange(nextOpen);
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent size="lg" className="flex flex-col p-0 gap-0 h-[480px]">
                <DialogHeader className="px-6 py-4 border-b">
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>

                <div className="flex-1 overflow-hidden">
                    <DriveBrowser
                        ownerId={ownerId}
                        mode="file"
                        mimeFilter={mimeFilter}
                        selectedId={selected?.id}
                        onSelect={handleSelect}
                        onConfirm={handleConfirm}
                        showNewFolder={false}
                        className="h-full"
                    />
                </div>

                <DialogFooter className="px-6 py-3 border-t flex-row justify-between sm:justify-between">
                    {onUploadFromDevice ? (
                        <Button variant="outline" onClick={onUploadFromDevice}>
                            <Upload className="h-4 w-4 mr-2" />
                            Upload from device
                        </Button>
                    ) : (
                        <div />
                    )}
                    <div className="flex gap-2">
                        <Button variant="outline" onClick={() => handleOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleSubmit} disabled={!selected}>
                            Select
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/layout/drive/drive-file-picker.tsx
git commit -m "feat(drive): add DriveFilePicker dialog component"
```

---

### Task 4: DriveLocationPicker

**Files:**
- Create: `packages/ui/src/components/layout/drive/drive-location-picker.tsx`

- [ ] **Step 1: Create DriveLocationPicker component**

```tsx
import { useAuth } from '@workspace/lib/auth';
import { useBreadcrumb, useRootFolder } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@workspace/ui/components/breadcrumb';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown, Download } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { DriveBrowser } from './drive-browser';

type DriveLocationPickerProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode: 'create' | 'save-as' | 'folder';
    onConfirm: (location: { ownerId: string; mountId: string; folderId: string; name?: string }) => void;
    onDownloadInstead?: () => void;
    title?: string;
    defaultName?: string;
    defaultMountId?: string;
    defaultFolderId?: string;
    nameLabel?: string;
    confirmLabel?: string;
};

export function DriveLocationPicker({
    open,
    onOpenChange,
    mode,
    onConfirm,
    onDownloadInstead,
    title,
    defaultName = '',
    defaultMountId = 'default',
    defaultFolderId,
    nameLabel,
    confirmLabel,
}: DriveLocationPickerProps) {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const [name, setName] = useState(defaultName);
    const [expanded, setExpanded] = useState(mode !== 'create');
    const [activeMountId, setActiveMountId] = useState(defaultMountId);
    const [activeOwnerId, setActiveOwnerId] = useState(ownerId);
    const [folderId, setFolderId] = useState<string | null>(defaultFolderId ?? null);

    const { data: rootFolder } = useRootFolder(activeOwnerId, activeMountId);
    const currentFolderId = folderId || rootFolder?.id || '';
    const { data: breadcrumbPaths = [] } = useBreadcrumb(activeOwnerId, activeMountId, currentFolderId);

    useEffect(() => {
        setName(defaultName);
        setExpanded(mode !== 'create');
        setActiveMountId(defaultMountId);
        setActiveOwnerId(ownerId);
        setFolderId(defaultFolderId ?? null);
    }, [open, defaultName, mode, defaultMountId, defaultFolderId, ownerId]);

    const handleFolderChange = useCallback((folder: DrivePath, mountId: string) => {
        setFolderId(folder.id);
        setActiveMountId(mountId);
        setActiveOwnerId(folder.ownerId);
    }, []);

    const handleSubmit = () => {
        if (mode !== 'folder' && !name.trim()) return;
        onConfirm({
            ownerId: activeOwnerId,
            mountId: activeMountId,
            folderId: currentFolderId,
            name: mode !== 'folder' ? name.trim() : undefined,
        });
        onOpenChange(false);
    };

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen);
    };

    const resolvedTitle = title || (mode === 'create' ? 'New item' : mode === 'save-as' ? 'Save to Drive' : 'Choose destination');
    const resolvedConfirmLabel = confirmLabel || (mode === 'create' ? 'Create' : mode === 'save-as' ? 'Save here' : 'Select');
    const resolvedNameLabel = nameLabel || (mode === 'save-as' ? 'Save as' : 'Name');
    const hasName = mode === 'create' || mode === 'save-as';

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                size={expanded ? undefined : 'sm'}
                className={cn('flex flex-col p-0 gap-0', expanded && 'h-[450px]')}
            >
                <DialogHeader className="px-6 py-4 border-b">
                    <DialogTitle>{resolvedTitle}</DialogTitle>
                </DialogHeader>

                {/* Name field */}
                {hasName && (
                    <div className="px-6 pt-4 pb-2">
                        <Label htmlFor="picker-name" className="text-sm text-muted-foreground">
                            {resolvedNameLabel}
                        </Label>
                        <Input
                            id="picker-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="mt-1.5"
                            autoFocus
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && name.trim()) {
                                    e.preventDefault();
                                    handleSubmit();
                                }
                            }}
                        />
                    </div>
                )}

                {/* Collapsed breadcrumb (create mode only) */}
                {mode === 'create' && !expanded && (
                    <div className="px-6 pb-2">
                        <Label className="text-sm text-muted-foreground">Location</Label>
                        <button
                            type="button"
                            className="mt-1.5 flex w-full items-center gap-1.5 rounded-md border px-3 py-2 text-sm hover:bg-accent"
                            onClick={() => setExpanded(true)}
                        >
                            <Breadcrumb className="overflow-hidden flex-1">
                                <BreadcrumbList>
                                    {breadcrumbPaths.map((path, index) => (
                                        <Fragment key={path.id}>
                                            {index > 0 && <BreadcrumbSeparator />}
                                            <BreadcrumbItem>
                                                <BreadcrumbPage className="text-xs">
                                                    {path.name || 'Drive'}
                                                </BreadcrumbPage>
                                            </BreadcrumbItem>
                                        </Fragment>
                                    ))}
                                </BreadcrumbList>
                            </Breadcrumb>
                            <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        </button>
                    </div>
                )}

                {/* Expanded browser */}
                {expanded && (
                    <div className="flex-1 overflow-hidden border-t">
                        <DriveBrowser
                            ownerId={ownerId}
                            mode="folder"
                            selectedId={folderId}
                            onSelect={(path) => {
                                setFolderId(path.id);
                                setActiveOwnerId(path.ownerId);
                            }}
                            onFolderChange={handleFolderChange}
                            defaultMountId={activeMountId}
                            defaultFolderId={folderId ?? undefined}
                            showNewFolder
                            className="h-full"
                        />
                    </div>
                )}

                <DialogFooter className="px-6 py-3 border-t flex-row justify-between sm:justify-between">
                    {onDownloadInstead ? (
                        <Button variant="outline" onClick={onDownloadInstead}>
                            <Download className="h-4 w-4 mr-2" />
                            Download instead
                        </Button>
                    ) : (
                        <div />
                    )}
                    <div className="flex gap-2">
                        <Button variant="outline" onClick={() => handleOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleSubmit} disabled={hasName && !name.trim()}>
                            {resolvedConfirmLabel}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/layout/drive/drive-location-picker.tsx
git commit -m "feat(drive): add DriveLocationPicker dialog component"
```

---

### Task 5: Export and Integration

**Files:**
- Modify: `packages/ui/src/components/layout/drive/index.ts`

- [ ] **Step 1: Add exports to index**

Add the following lines to `packages/ui/src/components/layout/drive/index.ts`:

```tsx
export * from './drive-browser';
export * from './drive-file-picker';
export * from './drive-location-picker';
export * from './drive-mount-list';
```

- [ ] **Step 2: Run full check**

Run: `bun run check`
Expected: Lint passes, typecheck passes, tests pass.

- [ ] **Step 3: Fix any lint/type issues found**

Address any issues reported by biome or TypeScript. Common fixes:
- Import ordering (biome auto-fix: `bun run lint:fix`)
- Unused variables from over-broad destructuring

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/layout/drive/index.ts
git commit -m "feat(drive): export picker components from drive layout index"
```

---

### Task 6: Manual Testing

**Files:** None (verification only)

- [ ] **Step 1: Create a test page to render both pickers**

Add a temporary test to any app that already renders drive content (e.g. `apps/drive`). In a component that has auth context, render:

```tsx
import { DriveFilePicker } from '@workspace/ui/components/layout/drive/drive-file-picker';
import { DriveLocationPicker } from '@workspace/ui/components/layout/drive/drive-location-picker';
import { useState } from 'react';

function PickerTest() {
    const [fileOpen, setFileOpen] = useState(false);
    const [locOpen, setLocOpen] = useState(false);

    return (
        <>
            <button onClick={() => setFileOpen(true)}>Open File Picker</button>
            <button onClick={() => setLocOpen(true)}>Open Location Picker</button>

            <DriveFilePicker
                open={fileOpen}
                onOpenChange={setFileOpen}
                onSelect={(paths) => console.log('Selected:', paths)}
                onUploadFromDevice={() => console.log('Upload from device')}
                mimeFilter={['image/*']}
            />
            <DriveLocationPicker
                open={locOpen}
                onOpenChange={setLocOpen}
                mode="save-as"
                defaultName="test-file.pdf"
                onConfirm={(loc) => console.log('Location:', loc)}
                onDownloadInstead={() => console.log('Download instead')}
            />
        </>
    );
}
```

- [ ] **Step 2: Run the dev server and test**

Run: `bun serve:drive`

Verify:
1. File picker opens, shows mounts on left, files on right
2. Clicking mount switches the file list
3. Clicking a folder navigates into it
4. Breadcrumb renders and is clickable
5. Mime filter dims non-matching files
6. Selecting a file enables the "Select" button
7. Double-clicking a file confirms selection
8. Location picker opens with name field at top
9. Folder browser shows only folders
10. "New folder" button creates a folder and navigates into it
11. Create mode starts collapsed, "Change" expands the browser
12. "Download instead" button triggers callback

- [ ] **Step 3: Remove test page and commit final state**

Remove the temporary test component. Run `bun run check` one final time.

```bash
git add -A
git commit -m "feat(drive): drive picker components complete"
```
