import {
    Download,
    FileText,
    FolderPlus,
    Home,
    Image,
    MessageSquare,
    Plus,
    Presentation,
    Sheet,
    StickyNote,
    Upload as UploadIcon,
    UsersRound,
} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {SidebarHeader} from '@workspace/ui/components/layout/sidebar/sidebar-header';
import {SidebarItem, StorageUsage, UserAvatar} from "@workspace/ui";
import {Separator} from '@workspace/ui/components/separator';
import {DrivePath} from '@workspace/lib/types/drive';
import {useState} from 'react';
import {useMatch, useNavigate} from '@tanstack/react-router';
import {usePathInfo, useRootFolder} from '@workspace/lib/drive';
import {usePublicConfig} from '@workspace/lib/public';
import {usePeopleTeams} from '@workspace/lib/people';
import {useTeamMounts} from '@workspace/lib/team';
import {teamOwnerId} from '@workspace/lib/types';
import type {MountSettings} from '@workspace/lib/types/settings';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from '@workspace/ui/components/dropdown-menu';
import {DriveCreateFolder} from '@workspace/ui/components/layout/drive/drive-create-folder';
import {DriveCreateDoc} from '@workspace/ui/components/layout/drive/drive-create-doc';
import {DriveCreateStickies} from '@workspace/ui/components/layout/drive/drive-create-stickies';
import {DriveCreateChat} from '@workspace/ui/components/layout/drive/drive-create-chat';
import {DriveCreateSlides} from '@workspace/ui/components/layout/drive/drive-create-slides';
import {DriveCreateSheets} from '@workspace/ui/components/layout/drive/drive-create-sheets';
import {DriveUploadFiles} from '@workspace/ui/components/layout/drive/drive-upload-files';

interface DriveSidebarProps {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
    rootPath: DrivePath | null;
}

function TeamMountItem({ownerId, mountId, label, icon, condensed}: {
    ownerId: string; mountId: string; label: string; icon: React.ReactNode; condensed: boolean
}) {
    const {data: root} = useRootFolder(ownerId, mountId);
    if (!root) return null;
    return (
        <SidebarItem
            icon={icon}
            to={`/fs/${root.ownerId}/${root.mountId}/${root.id}`}
            label={label}
            condensed={condensed}
        />
    );
}

function TeamDriveItems({teamId, teamName, icon, condensed}: {
    teamId: string; teamName: string; icon: React.ReactNode; condensed: boolean
}) {
    const ownerId = teamOwnerId(teamId);
    const {data: mounts} = useTeamMounts(teamId);

    const enabledMounts = mounts
        ? Object.entries(mounts).filter(([, m]: [string, MountSettings]) => m.enabled)
        : [];

    if (enabledMounts.length === 0) return null;

    return (
        <>
            {enabledMounts.map(([id, mount]) => (
                <TeamMountItem
                    key={id}
                    ownerId={ownerId}
                    mountId={id}
                    label={mount.name || id}
                    icon={icon}
                    condensed={condensed}
                />
            ))}
        </>
    );
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
    const [createSlidesOpen, setCreateSlidesOpen] = useState(false);
    const [createSheetsOpen, setCreateSheetsOpen] = useState(false);
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

    // Fetch org data for shared drives section
    const {data: config} = usePublicConfig();
    const {data: teams} = usePeopleTeams(config?.orgId);

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
            {isMobile && <SidebarHeader appName="drive" onClose={onClose}/>}

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
                        <DropdownMenuItem onClick={() => setCreateSlidesOpen(true)}>
                            <Presentation className="h-4 w-4 mr-2"/>
                            Create slides
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setCreateSheetsOpen(true)}>
                            <Sheet className="h-4 w-4 mr-2"/>
                            Create sheets
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
                <SidebarItem
                    icon={<MessageSquare className="h-4 w-4"/>}
                    to="/mime/application-eigenchat"
                    label="All chats"
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<Presentation className="h-4 w-4"/>}
                    to="/mime/application-eigenslides"
                    label="All slides"
                    condensed={condensed}
                />
                <SidebarItem
                    icon={<Sheet className="h-4 w-4"/>}
                    to="/mime/application-eigensheets"
                    label="All sheets"
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

            {config && teams && teams.length > 0 && (
                <>
                    <Separator/>
                    <SidebarSection condensed={condensed} title={condensed ? undefined : "Shared Drives"}>
                        {teams.map((team) => (
                            <TeamDriveItems
                                key={team.id}
                                teamId={team.id}
                                teamName={team.name}
                                icon={<UserAvatar email={teamOwnerId(team.id)} className="h-4 w-4"/>}
                                condensed={condensed}
                            />
                        ))}
                    </SidebarSection>
                </>
            )}

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

            {/* Create Slides Dialog */}
            {targetPath && (
                <DriveCreateSlides
                    path={targetPath}
                    open={createSlidesOpen}
                    onOpenChange={setCreateSlidesOpen}
                    onSave={() => {
                    }}
                    onAfterAction={handleAfterAction}
                />
            )}

            {/* Create Sheets Dialog */}
            {targetPath && (
                <DriveCreateSheets
                    path={targetPath}
                    open={createSheetsOpen}
                    onOpenChange={setCreateSheetsOpen}
                    onSave={() => {
                    }}
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