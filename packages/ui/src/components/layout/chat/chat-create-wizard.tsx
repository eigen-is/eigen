import { openDocument } from '@workspace/lib/api';
import { AppError } from '@workspace/lib/api-error';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { useChatSections, useCreateChat, useCreateChatRoom, useFindChatByMembers } from '@workspace/lib/chat';
import { useDebouncedValue } from '@workspace/lib/command-palette';
import { useMyTeams } from '@workspace/lib/home';
import { CHATS_FOLDER_NAME, type ChatMatch } from '@workspace/lib/types/chat';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { parseContactInput } from '@workspace/lib/validation';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown, MessageSquare, User, Users, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ContactAddRow } from '../contacts/contact-add-row';
import { DriveLocationField, type DriveLocationValue } from '../drive/drive-location-field';
import { InfoBlock } from '../info-block';
import { TooltipButton } from '../toolbar/tooltip-button';
import { UserItem } from '../user-item';

const MATCH_DEBOUNCE_MS = 300;

type PickedPerson = { email: string; displayName: string };

// Prefill for callers that already know who the chat is with (e.g. contacts' "Start chat"). The
// name seeds the picked row and thus the live 1:1 name default; it falls back to the email when absent.
type InitialPerson = { email: string; name?: string };

type ChatCreateWizardProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialPeople?: InitialPerson[];
    // In-app router navigation for the target room. Chat apps pass a typed TanStack navigate; when
    // omitted the wizard falls back to openDocument (window.location) so route-tree-agnostic consumers work.
    onNavigate?: (path: DrivePath) => void;
};

// One person reads as "<Them> & <Me>" (both names, since the file name is shared); two or more read
// as the picked members alone, comma-joined with a trailing ampersand ("Alice, Bob & Carol"),
// WhatsApp's optional-auto-name model.
function defaultChatName(pickedNames: string[], myName: string): string {
    if (pickedNames.length === 0) return '';
    if (pickedNames.length === 1) return `${pickedNames[0]} & ${myName}`;
    return `${pickedNames.slice(0, -1).join(', ')} & ${pickedNames[pickedNames.length - 1]}`;
}

export function ChatCreateWizard({ open, onOpenChange, initialPeople, onNavigate }: ChatCreateWizardProps) {
    const { user } = useAuth();
    const isGuest = useIsGuest();

    const myOwnerId = user?.id ?? '';
    const myName = user?.name ?? '';
    const myEmail = (user?.email ?? '').toLowerCase();

    const { data: myTeams } = useMyTeams();
    const { teams: teamSections } = useChatSections();

    const [input, setInput] = useState('');
    const [picked, setPicked] = useState<PickedPerson[]>([]);
    const [name, setName] = useState('');
    const [nameDirty, setNameDirty] = useState(false);
    const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
    const [location, setLocation] = useState<DriveLocationValue>({
        ownerId: myOwnerId,
        mountId: DEFAULT_MOUNT_ID,
        folderId: '',
    });
    const [locationTouched, setLocationTouched] = useState(false);
    const [locationExpanded, setLocationExpanded] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    const selectedTeam = myTeams?.find((t) => t.id === selectedTeamId) ?? null;
    const teamMode = !!selectedTeam;
    // Team homes have no 'default' mount (their mounts get random ids); mounts arrive enabled-filtered,
    // so the first one is the team drive.
    const teamMount = selectedTeam?.mounts[0] ?? null;
    const teamChatOwnerId = selectedTeam ? teamOwnerId(selectedTeam.id) : '';
    const teamRootId = teamMount?.rootPathId ?? '';
    const teamChats = teamSections.find((t) => t.id === selectedTeamId)?.chats ?? [];

    // Own-mounts-only, so the owner never changes; a untouched location sends no parentId and lets the
    // route resolve the Chats folder, a touched one carries the browsed folder.
    const createMountId = locationTouched ? location.mountId : DEFAULT_MOUNT_ID;
    const createRoom = useCreateChatRoom(myOwnerId, createMountId);
    const createTeamChat = useCreateChat(teamChatOwnerId, teamMount?.id ?? '');

    const pickedEmails = useMemo(() => picked.map((p) => p.email), [picked]);
    const debouncedKey = useDebouncedValue(pickedEmails.join(','), MATCH_DEBOUNCE_MS);
    const debouncedEmails = useMemo(() => (debouncedKey ? debouncedKey.split(',') : []), [debouncedKey]);
    const { data: matches = [] } = useFindChatByMembers(myOwnerId, teamMode ? [] : debouncedEmails);

    // Every match shares the picked set's membership by definition, so the count is uniform (+1 = me).
    const memberCount = debouncedEmails.length + 1;
    const singleWritable = !teamMode && matches.length === 1 && matches[0].canWrite;
    const isBusy = createRoom.isPending || createTeamChat.isPending;
    const canCreate = teamMode ? !!name.trim() && !!teamRootId : picked.length > 0;
    const showBrowser = !teamMode && locationTouched && locationExpanded;

    const excludeEmails = useMemo(() => (myEmail ? [...pickedEmails, myEmail] : pickedEmails), [pickedEmails, myEmail]);

    // Serialized so a fresh array literal from the caller doesn't re-run the reset effect (which would
    // wipe in-progress edits); the effect re-seeds only when the prefill's contents actually change.
    const initialPeopleKey = JSON.stringify(initialPeople ?? []);

    // Reset to a clean form each time the dialog opens (or its prefill changes).
    useEffect(() => {
        if (!open) return;
        const seed: InitialPerson[] = JSON.parse(initialPeopleKey);
        // Drop self from the prefill (same guard as addPerson) — a chat is always with other people.
        setPicked(
            seed
                .map((p) => ({ email: p.email.toLowerCase(), displayName: p.name?.trim() || p.email }))
                .filter((p) => p.email !== myEmail),
        );
        setInput('');
        setName('');
        setNameDirty(false);
        setSelectedTeamId(null);
        setLocation({ ownerId: myOwnerId, mountId: DEFAULT_MOUNT_ID, folderId: '' });
        setLocationTouched(false);
        setLocationExpanded(false);
        setCreateError(null);
    }, [open, initialPeopleKey, myOwnerId, myEmail]);

    // Keep the name live-defaulted until the user edits it: team mode requires a typed topic (empty
    // default), person mode tracks the picked set ("Alice & Reinder", "Alice, Bob & Carol").
    useEffect(() => {
        if (!open || nameDirty) return;
        setName(
            teamMode
                ? ''
                : defaultChatName(
                      picked.map((p) => p.displayName),
                      myName,
                  ),
        );
    }, [open, nameDirty, teamMode, picked, myName]);

    if (!user || isGuest) return null;

    const addPerson = (person: PickedPerson) => {
        const email = person.email.toLowerCase();
        if (email === myEmail) return;
        setPicked((prev) =>
            prev.some((p) => p.email === email) ? prev : [...prev, { email, displayName: person.displayName || email }],
        );
    };

    const handleInputChange = (value: string) => {
        if (value.includes('<') && value.includes('>')) {
            const parsed = parseContactInput(value);
            if (parsed) {
                addPerson(parsed);
                setInput('');
                return;
            }
        }
        setInput(value);
    };

    const handleAddClick = () => {
        const parsed = input.includes('<') ? parseContactInput(input) : null;
        if (parsed) {
            addPerson(parsed);
            setInput('');
        }
    };

    // Prefer the consumer's in-app router navigation (onNavigate); fall back to openDocument
    // (window.location) so apps whose route trees lack the chat room route still work — this shared
    // component can't depend on a typed navigate itself. openDocument is what contacts' "start chat" uses.
    const goToRoom = (path: DrivePath) => {
        onOpenChange(false);
        if (onNavigate) onNavigate(path);
        else openDocument(path);
    };

    const createPersonChat = async () => {
        setCreateError(null);
        const base = name.trim();
        const parentId = locationTouched ? location.folderId || undefined : undefined;
        try {
            // A default (non-dirty) name lets the server dedupe a collision (" (2)", " (3)"…); a
            // user-typed name is created verbatim, so its collision surfaces the 409 inline below.
            goToRoom(
                await createRoom.mutateAsync({
                    parentId,
                    fileName: base,
                    members: pickedEmails,
                    dedupeName: !nameDirty,
                }),
            );
        } catch (e) {
            if (!(e instanceof AppError) || e.status !== 409) return; // non-409 already toasted by the hook
            setCreateError(`A chat named "${base}" already exists here. Rename it, or open the existing one.`);
        }
    };

    const createTeamChatRoom = async () => {
        setCreateError(null);
        if (!teamRootId) return;
        try {
            goToRoom(await createTeamChat.mutateAsync({ parentId: teamRootId, fileName: name.trim() }));
        } catch {
            // Errors (incl. a duplicate-name 409) are surfaced by the shared create hook's toast.
        }
    };

    const handlePrimary = () => {
        if (singleWritable) {
            goToRoom(matches[0].path);
            return;
        }
        if (!canCreate || isBusy) return;
        void (teamMode ? createTeamChatRoom() : createPersonChat());
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className={cn(
                    'flex flex-col p-0 gap-0 sm:max-w-[560px] max-w-[90vw] max-h-[85vh]',
                    showBrowser && 'h-[620px]',
                )}
            >
                <DialogHeader className="px-6 py-4 border-b shrink-0">
                    <DialogTitle>New chat</DialogTitle>
                </DialogHeader>

                {/* When the browser is open it fills the fixed-height dialog; otherwise the form sizes to
                    content and scrolls only if it would outgrow max-h, keeping the footer pinned. */}
                <div className={cn('flex flex-col min-h-0', showBrowser ? 'flex-1' : 'overflow-y-auto')}>
                    <div className="shrink-0 px-6 pt-4 pb-2">
                        <Label className="text-sm text-muted-foreground">With</Label>
                        {teamMode ? (
                            <>
                                <InfoBlock className="mt-1.5 w-full justify-start gap-2 text-sm">
                                    <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
                                    <span>
                                        Everyone in <span className="font-medium">{selectedTeam.name}</span> is a
                                        member, now and in the future
                                    </span>
                                </InfoBlock>
                                {!teamRootId && (
                                    <p className="mt-1.5 text-sm text-muted-foreground">This team has no drive yet.</p>
                                )}
                            </>
                        ) : (
                            <>
                                <ContactAddRow
                                    id="chat-wizard-people"
                                    value={input}
                                    onChange={handleInputChange}
                                    onSubmit={handleAddClick}
                                    excludeEmails={excludeEmails}
                                    onlyInternalMails
                                    listOnEmptyQuery
                                    placeholder="Add person…"
                                    className="mt-1.5"
                                />
                                {picked.length > 0 && (
                                    <div className="mt-2 max-h-40 space-y-0.5 overflow-y-auto">
                                        {picked.map((p) => (
                                            <div
                                                key={p.email}
                                                className="group flex items-center justify-between rounded-md pr-1 hover:bg-muted/50"
                                            >
                                                <UserItem email={p.email} />
                                                <div className="invisible group-hover:visible">
                                                    <TooltipButton
                                                        icon={X}
                                                        tooltipText="Remove"
                                                        variant="ghost"
                                                        className="h-7 w-7"
                                                        onClick={() =>
                                                            setPicked((prev) => prev.filter((x) => x.email !== p.email))
                                                        }
                                                    />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    {teamMode
                        ? teamChats.length > 0 && (
                              <MatchPanel title={`Chats in ${selectedTeam.name}`}>
                                  {teamChats.map((chat) => (
                                      <MatchRow
                                          key={chat.id}
                                          name={stripEigenExtension(chat.name)}
                                          subtitle={null}
                                          onOpen={() => goToRoom(chat)}
                                      />
                                  ))}
                              </MatchPanel>
                          )
                        : matches.length > 0 && (
                              <MatchPanel
                                  title={
                                      singleWritable
                                          ? 'You already have a chat with these people'
                                          : 'Existing chats with these people'
                                  }
                              >
                                  {matches.map((m: ChatMatch) => (
                                      <MatchRow
                                          key={m.path.id}
                                          name={stripEigenExtension(m.path.name)}
                                          subtitle={`${memberCount} ${memberCount === 1 ? 'member' : 'members'}${m.canWrite ? '' : ' · view only'}`}
                                          onOpen={singleWritable ? undefined : () => goToRoom(m.path)}
                                      />
                                  ))}
                              </MatchPanel>
                          )}

                    <div className="shrink-0 px-6 pb-2">
                        <Label htmlFor="chat-wizard-name" className="text-sm text-muted-foreground">
                            Name
                        </Label>
                        <Input
                            id="chat-wizard-name"
                            value={name}
                            onChange={(e) => {
                                setNameDirty(true);
                                setName(e.target.value);
                            }}
                            className="mt-1.5"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    handlePrimary();
                                }
                            }}
                        />
                        {createError && <p className="mt-1.5 text-sm text-destructive">{createError}</p>}
                    </div>

                    {teamMode ? (
                        <div className="shrink-0 px-6 pb-2">
                            <Label className="text-sm text-muted-foreground">Location</Label>
                            <InfoBlock className="mt-1.5 w-full justify-start gap-2 text-sm">
                                <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="text-xs">{selectedTeam.name} team drive</span>
                            </InfoBlock>
                        </div>
                    ) : locationTouched ? (
                        <DriveLocationField
                            value={location}
                            onChange={setLocation}
                            expanded={locationExpanded}
                            onExpandedChange={setLocationExpanded}
                            ownMountsOnly
                        />
                    ) : (
                        <div className="shrink-0 px-6 pb-2">
                            <Label className="text-sm text-muted-foreground">Location</Label>
                            <InfoBlock
                                className="mt-1.5 w-full cursor-pointer gap-1.5 text-sm hover:bg-muted"
                                onClick={() => {
                                    setLocationTouched(true);
                                    setLocationExpanded(true);
                                }}
                            >
                                <span className="text-xs">My Drive › {CHATS_FOLDER_NAME}</span>
                                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                                    <span className="mr-1 text-xs text-muted-foreground">Change</span>
                                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                </div>
                            </InfoBlock>
                        </div>
                    )}
                </div>

                <DialogFooter className="px-6 py-3 border-t flex-row justify-between sm:justify-between shrink-0">
                    {myTeams && myTeams.length > 0 ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="outline" className="gap-2">
                                    <Users className="h-4 w-4" />
                                    {selectedTeam ? selectedTeam.name : 'Team chat'}
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                {selectedTeam && (
                                    <DropdownMenuItem onClick={() => setSelectedTeamId(null)}>
                                        <User className="h-4 w-4 mr-2" />
                                        Personal chat
                                    </DropdownMenuItem>
                                )}
                                {myTeams.map((team) => (
                                    <DropdownMenuItem
                                        key={team.id}
                                        onClick={() => setSelectedTeamId(team.id)}
                                        disabled={team.id === selectedTeamId}
                                    >
                                        <Users className="h-4 w-4 mr-2" />
                                        {team.name}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : (
                        <div />
                    )}

                    <div className="flex gap-2">
                        <Button variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        {singleWritable ? (
                            <>
                                <Button variant="outline" onClick={() => void createPersonChat()} disabled={isBusy}>
                                    Create anyway
                                </Button>
                                <Button onClick={handlePrimary} disabled={isBusy}>
                                    Open
                                </Button>
                            </>
                        ) : (
                            <Button onClick={handlePrimary} disabled={!canCreate || isBusy}>
                                Create
                            </Button>
                        )}
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function MatchPanel({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="shrink-0 px-6 pb-2">
            <div className="rounded-md border">
                <div className="flex items-center gap-2 border-b px-3 py-2 text-sm text-muted-foreground">
                    <MessageSquare className="h-4 w-4 shrink-0" />
                    <span className="truncate">{title}</span>
                </div>
                <div className="max-h-40 space-y-0.5 overflow-y-auto p-1">{children}</div>
            </div>
        </div>
    );
}

function MatchRow({ name, subtitle, onOpen }: { name: string; subtitle: string | null; onOpen?: () => void }) {
    return (
        <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5">
            <div className="min-w-0">
                <p className="truncate text-sm font-medium">{name}</p>
                {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
            </div>
            {onOpen && (
                <Button variant="outline" size="sm" className="shrink-0" onClick={onOpen}>
                    Open
                </Button>
            )}
        </div>
    );
}
