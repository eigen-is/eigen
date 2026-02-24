import {
    Download,
    FileText,
    FolderPlus,
    Home,
    Image,
    MessageSquare,
    Plus,
    StickyNote,
    Upload as UploadIcon,
    UsersRound,
    X
} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import {SidebarItem, StorageUsage} from "@workspace/ui";
import {Separator} from '@workspace/ui/components/separator';
import {DrivePath} from '@workspace/lib/types/drive';
import {useState} from 'react';
import {useMatch, useNavigate} from '@tanstack/react-router';
import {usePathInfo} from '@workspace/lib/drive';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from '@workspace/ui/components/dropdown-menu';

// Import these directly from their files instead of from the index
import {DriveCreateFolder} from '@workspace/ui/components/layout/drive/drive-create-folder';
import {DriveCreateDoc} from '@workspace/ui/components/layout/drive/drive-create-doc';
import {DriveCreateStickies} from '@workspace/ui/components/layout/drive/drive-create-stickies';
import {DriveUploadFiles} from '@workspace/ui/components/layout/drive/drive-upload-files';
import {DriveCreateChat} from '@workspace/ui/components/layout/drive/drive-create-chat';

interface DriveSidebarProps {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
    rootPath: DrivePath | null;
}

export function DriveSidebar({
                                 condensed = false,
                                 onClose,
                                 isMobile = false,
                                 rootPath,
                             }: DriveSidebarProps) {
    // Dialog open states
    const [createFolderOpen, setCreateFolderOpen] = useState(false);
    const [createDocOpen, setCreateDocOpen] = useState(false);
    const [createStickiesOpen, setCreateStickiesOpen] = useState(false);
    const [createChatOpen, setCreateChatOpen] = useState(false);
    const [uploadOpen, setUploadOpen] = useState(false);
    const [uploadFiles, setUploadFiles] = useState<File[]>([]);
    const navigate = useNavigate();

    // Check if we're in a filesystem route and get current path from URL
    const routeMatch = useMatch({
        from: '/_auth/fs/$ownerId/$mountId/$pathId',
        shouldThrow: false,
    });

    // Extract the parameters if we have a match
    const currentPathId = routeMatch?.params?.pathId;
    const currentOwnerId = routeMatch?.params?.ownerId;
    const currentMountId = routeMatch?.params?.mountId;

    // Get path info for the current path
    const {data: currentPath} = usePathInfo(
        currentOwnerId || (rootPath?.ownerId || ''),
        currentMountId || (rootPath?.mountId || 'default'),
        currentPathId || (rootPath?.id || '')
    );

    // Determine which path to use for operations (current or root)
    const targetPath = currentPath || rootPath;

    // Handle file input change
    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            setUploadFiles(Array.from(e.target.files));
            setUploadOpen(true);
        }
    };

    // Define afterAction callback to refresh the content
    const handleAfterAction = () => {
        navigate({
            to: '/fs/$ownerId/$mountId/$pathId',
            params: {
                ownerId: targetPath?.ownerId || '',
                mountId: targetPath?.mountId || 'default',
                pathId: targetPath?.id || '',
            }
        });
    };

    return (
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
            {/* Mobile header with close button */}
            {isMobile && (
                <div className="flex items-center h-12 bg-app px-4">
                    <Button variant="ghost" size="icon" onClick={onClose}
                            className="mr-2 text-white hover:bg-primary/20 hover:text-white">
                        <X className="h-5 w-5"/>
                        <span className="sr-only">Close menu</span>
                    </Button>
                    <AppLogo appName="drive"/>
                </div>
            )}

            {/* New button dropdown */}
            <div className="px-3 py-2">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="default"
                            size={condensed ? "icon" : "default"}
                            className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}
                        >
                            <Plus className="h-4 w-4"/>
                            {!condensed && <span>New</span>}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align={condensed ? "center" : "start"}>
                        <DropdownMenuItem onClick={() => setCreateFolderOpen(true)}>
                            <FolderPlus className="h-4 w-4 mr-2"/>
                            Create folder
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setCreateDocOpen(true)}>
                            <FileText className="h-4 w-4 mr-2"/>
                            Create doc
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setCreateStickiesOpen(true)}>
                            <StickyNote className="h-4 w-4 mr-2"/>
                            Create stickies
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setCreateChatOpen(true)}>
                            <MessageSquare className="h-4 w-4 mr-2"/>
                            Create chat
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setUploadOpen(true)}>
                            <UploadIcon className="h-4 w-4 mr-2"/>
                            Upload file
                            <input
                                type="file"
                                className="hidden"
                                onChange={handleFileChange}
                            />
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            <SidebarSection
                condensed={condensed}
            >
                <SidebarItem
                    icon={<Home className="h-4 w-4"/>}
                    to={rootPath ? `/fs/${rootPath.ownerId}/${rootPath.mountId}/${rootPath.id}` : '/'}
                    label="Drive"
                    condensed={condensed}
                />

                <SidebarItem
                    icon={<Image className="h-4 w-4"/>}
                    to="/mime/image"
                    label="All images"
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<FileText className="h-4 w-4"/>}
                    to="/mime/application-eigendoc"
                    label="All docs"
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<StickyNote className="h-4 w-4"/>}
                    to="/mime/application-eigenstickies"
                    label="All stickies"
                    condensed={condensed}
                />

            </SidebarSection>
            <Separator/>
            <SidebarSection
                condensed={condensed}
            >
                <SidebarItem
                    icon={<UsersRound className="h-4 w-4"/>}
                    to="/shared/by-me"
                    label="Shared by me"
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<Download className="h-4 w-4"/>}
                    to="/shared/with-me"
                    label="Shared with me"
                    condensed={condensed}
                />
            </SidebarSection>

            {/* Storage usage indicator at the bottom of sidebar */}
            <StorageUsage
                className="mt-auto"
                condensed={condensed}
            />

            {/* Create Folder Dialog */}
            {targetPath && (
                <DriveCreateFolder
                    path={targetPath}
                    open={createFolderOpen}
                    onOpenChange={setCreateFolderOpen}
                    onSave={() => {
                    }}
                    onCancel={() => setCreateFolderOpen(false)}
                    onAfterAction={handleAfterAction}
                />
            )}

            {/* Create Doc Dialog */}
            {targetPath && (
                <DriveCreateDoc
                    path={targetPath}
                    open={createDocOpen}
                    onOpenChange={setCreateDocOpen}
                    onSave={() => {
                    }}
                    onCancel={() => setCreateDocOpen(false)}
                    onAfterAction={handleAfterAction}
                />
            )}

            {/* Create Stickies Dialog */}
            {targetPath && (
                <DriveCreateStickies
                    path={targetPath}
                    open={createStickiesOpen}
                    onOpenChange={setCreateStickiesOpen}
                    onSave={() => {
                    }}
                    onAfterAction={handleAfterAction}
                />
            )}

            {/* Create Chat Dialog */}
            {targetPath && (
                <DriveCreateChat
                    path={targetPath}
                    open={createChatOpen}
                    onOpenChange={setCreateChatOpen}
                    onSave={() => {
                    }}
                    onCancel={() => setCreateChatOpen(false)}
                    onAfterAction={handleAfterAction}
                />
            )}

            {/* File Upload Dialog */}
            {targetPath && (
                <DriveUploadFiles
                    path={targetPath}
                    open={uploadOpen}
                    onOpenChange={setUploadOpen}
                    initialFiles={uploadFiles}
                    onAfterUpload={() => setUploadFiles([])}
                    onAfterAction={handleAfterAction}
                />
            )}
        </div>
    );
}