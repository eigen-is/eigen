import { openDocument } from '@workspace/lib/api';
import { AppError } from '@workspace/lib/api-error';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { useChatSections, useCreateChatRoom, useFindChatByMembers } from '@workspace/lib/chat';
import { useDebouncedValue } from '@workspace/lib/command-palette';
import { useMyTeams } from '@workspace/lib/home';
import { CHATS_FOLDER_NAME, type ChatMatch } from '@workspace/lib/types/chat';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { teamOwnerId } from '@workspace/lib/types/owner';
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
import { useContactInput } from '../contacts/use-contact-input';
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
    // Seeds the location as already-touched so step 2 confirms this folder instead of the auto
    // `chats` default (Drive's "+ New → New chat" passes the browsed folder).
    initialLocation?: DriveLocationValue;
    // Opens directly in team mode for that team (Drive passes it when the current drive is a team drive).
    initialTeamId?: string;
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

export function ChatCreateWizard({
    open,
    onOpenChange,
    initialPeople,
    initialLocation,
    initialTeamId,
    onNavigate,
}: ChatCreateWizardProps) {
    const { user } = useAuth();
    const isGuest = useIsGuest();

    const myOwnerId = user?.id ?? '';
    const myName = user?.name ?? '';
    const myEmail = (user?.email ?? '').toLowerCase();

    const { data: myTeams } = useMyTeams();

    const [step, setStep] = useState<1 | 2>(1);
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
    // The chat aggregate backs only the team-mode panel — fetch it once a team is actually
    // selected, not for every (possibly closed) wizard mounted in a contacts toolbar.
    const { teams: teamSections } = useChatSections(open && teamMode);
    const teamChats = teamSections.find((t) => t.id === selectedTeamId)?.chats ?? [];

    // Own mounts only, so the owner never changes: an untouched location sends no parentId and lets the
    // route resolve the `chats` folder, a touched one carries the browsed folder.
    const createMountId = locationTouched ? location.mountId : DEFAULT_MOUNT_ID;
    const createRoom = useCreateChatRoom(myOwnerId, createMountId);
    const createTeamRoom = useCreateChatRoom(teamChatOwnerId, teamMount?.id ?? '');

    const pickedEmails = useMemo(() => picked.map((p) => p.email), [picked]);
    const pickedKey = pickedEmails.join(',');
    const debouncedKey = useDebouncedValue(pickedKey, MATCH_DEBOUNCE_MS);
    const debouncedEmails = useMemo(() => (debouncedKey ? debouncedKey.split(',') : []), [debouncedKey]);
    // Gated on open + person mode: a closed or team-mode wizard runs no by-members lookup.
    const { data: fetchedMatches = [] } = useFindChatByMembers(myOwnerId, open && !teamMode ? debouncedEmails : []);
    // The lookup lags the picked set by the debounce window; hide its result until the key settles
    // so the primary action can never open a chat found for a previous picked set.
    const matches = debouncedKey === pickedKey ? fetchedMatches : [];

    // Already-picked people and self are excluded from the ACL suggestion popover (mirrors the share dialog).
    const excludeEmails = useMemo(() => (myEmail ? [...pickedEmails, myEmail] : pickedEmails), [pickedEmails, myEmail]);

    // Every match shares the picked set's membership by definition, so the count is uniform (+1 = me).
    const memberCount = picked.length + 1;
    // Existing chats to open before creating a new one: by-members matches in person mode, the team's
    // chats in team mode. When any exist the primary opens the first and "Create new chat" makes a new one.
    const hasMatches = teamMode ? teamChats.length > 0 : matches.length > 0;
    const isBusy = createRoom.isPending || createTeamRoom.isPending;
    // Both modes need a non-empty name — an emptied person-mode name would otherwise create a bare
    // '.eigenchat' file (team mode never defaults the name, person mode only loses it when edited).
    const canCreate = !!name.trim() && (teamMode ? !!teamRootId : picked.length > 0);
    const step1CanProceed = teamMode || picked.length > 0;

    const addPerson = (person: PickedPerson) => {
        const email = person.email.toLowerCase();
        if (email === myEmail) return;
        setPicked((prev) =>
            prev.some((p) => p.email === email) ? prev : [...prev, { email, displayName: person.displayName || email }],
        );
    };

    // Typed input and picked "Name <email>" suggestions join the picked set through the shared
    // contact-input plumbing — the same flow as the share dialog and calendar attendees.
    const contactInput = useContactInput((contact) => {
        addPerson(contact);
        return true;
    });

    // Serialized so a fresh array/object literal from the caller doesn't re-run the reset effect (which
    // would wipe in-progress edits); the effect re-seeds only when the prefill's contents actually change.
    const initialPeopleKey = JSON.stringify(initialPeople ?? []);
    const initialLocationKey = JSON.stringify(initialLocation ?? null);

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
        setStep(1);
        contactInput.setValue('');
        setName('');
        setNameDirty(false);
        setSelectedTeamId(initialTeamId ?? null);
        const rawSeed: DriveLocationValue | null = JSON.parse(initialLocationKey);
        // Person-mode create is own-drive only (own mounts, owner never changes), so a foreign-owner
        // seed can't be its location — treat it as absent and fall back to the auto `chats` default.
        const seedLocation = rawSeed && rawSeed.ownerId === myOwnerId ? rawSeed : null;
        // A seeded location lands step 2 on the real folder; otherwise the auto `chats` default.
        setLocation(seedLocation ?? { ownerId: myOwnerId, mountId: DEFAULT_MOUNT_ID, folderId: '' });
        setLocationTouched(!!seedLocation);
        setLocationExpanded(false);
        setCreateError(null);
    }, [open, initialPeopleKey, initialLocationKey, initialTeamId, myOwnerId, myEmail, contactInput.setValue]);

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

    // Prefer the consumer's in-app router navigation (onNavigate); fall back to openDocument
    // (window.location) so apps whose route trees lack the chat room route still work — this shared
    // component can't depend on a typed navigate itself. openDocument is what contacts' "start chat" uses.
    const goToRoom = (path: DrivePath) => {
        onOpenChange(false);
        if (onNavigate) onNavigate(path);
        else openDocument(path);
    };

    const goToCreateStep = () => {
        setCreateError(null);
        setStep(2);
    };

    // Step 1 primary: open the first existing match if there is one, otherwise advance to confirm.
    const advanceOrOpen = () => {
        if (hasMatches) {
            goToRoom(teamMode ? teamChats[0] : matches[0].path);
            return;
        }
        if (step1CanProceed) goToCreateStep();
    };

    const createChat = async () => {
        if (!canCreate || isBusy) return;
        setCreateError(null);
        const fileName = name.trim();
        try {
            // A team room takes no members (membership is implicit) and lands in the team drive's
            // `chats` folder (no parentId, lazily ensured). A personal chat is born shared with the
            // picked people; a default (non-dirty) name lets the server dedupe a collision
            // (" (2)", " (3)"…), while a user-typed name is created verbatim so its collision
            // surfaces the 409 inline below.
            goToRoom(
                teamMode
                    ? await createTeamRoom.mutateAsync({ fileName, members: [] })
                    : await createRoom.mutateAsync({
                          parentId: locationTouched ? location.folderId || undefined : undefined,
                          fileName,
                          members: pickedEmails,
                          dedupeName: !nameDirty,
                      }),
            );
        } catch (e) {
            if (!(e instanceof AppError) || e.status !== 409) return; // non-409 already toasted by the hook
            setCreateError(`A chat named "${fileName}" already exists here. Rename it, or open the existing one.`);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex flex-col p-0 gap-0 sm:max-w-[560px] max-w-[90vw] h-[620px] max-h-[85vh]">
                <DialogHeader className="px-6 py-4 border-b shrink-0">
                    <DialogTitle>New chat</DialogTitle>
                </DialogHeader>

                {step === 1 ? (
                    /* Step 1 — who. An ACL-style people picker (mirrors the share dialog): ContactAddRow with an
                       absolute suggestion popover, picked people as removable rows, and the existing-chat panel
                       anchored to the bottom just above the footer. */
                    <div className="flex flex-1 flex-col min-h-0">
                        {teamMode ? (
                            <div className="shrink-0 px-6 pt-4 pb-2">
                                <InfoBlock className="w-full text-sm">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
                                        <span className="truncate">
                                            Everyone in <span className="font-medium">{selectedTeam.name}</span> is a
                                            member
                                        </span>
                                    </div>
                                    <TooltipButton
                                        icon={X}
                                        tooltipText="Remove"
                                        variant="ghost"
                                        className="h-7 w-7 shrink-0"
                                        onClick={() => setSelectedTeamId(null)}
                                    />
                                </InfoBlock>
                                {!teamRootId && (
                                    <p className="mt-1.5 text-sm text-muted-foreground">This team has no drive yet.</p>
                                )}
                            </div>
                        ) : (
                            <>
                                <div className="shrink-0 px-6 pt-4 pb-2">
                                    <ContactAddRow
                                        id="chat-wizard-people"
                                        value={contactInput.value}
                                        onChange={contactInput.handleChange}
                                        onSubmit={contactInput.submit}
                                        onEmptyEnter={advanceOrOpen}
                                        excludeEmails={excludeEmails}
                                        placeholder="Add people by name or email…"
                                    />
                                </div>
                                {picked.length > 0 && (
                                    <div className="shrink-0 px-6 pb-2 max-h-32 space-y-0.5 overflow-y-auto">
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

                        {/* Flexible spacer keeps the existing-chat panel pinned to the bottom, just above the footer. */}
                        <div className="flex-1" />

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
                                          matches.length === 1
                                              ? 'You already have a chat with these people'
                                              : 'Existing chats with these people'
                                      }
                                  >
                                      {matches.map((m: ChatMatch) => (
                                          <MatchRow
                                              key={m.path.id}
                                              name={stripEigenExtension(m.path.name)}
                                              subtitle={`${memberCount} ${memberCount === 1 ? 'member' : 'members'}${m.canWrite ? '' : ' · view only'}`}
                                              onOpen={() => goToRoom(m.path)}
                                          />
                                      ))}
                                  </MatchPanel>
                              )}
                    </div>
                ) : (
                    /* Step 2 — confirm. Name + location; the location browser flex-grows into the fixed
                       frame when expanded, otherwise trailing space keeps the footer pinned. */
                    <div className="flex flex-1 flex-col min-h-0">
                        <div className="shrink-0 px-6 pt-4 pb-2">
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
                                        void createChat();
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
                                    <span className="text-xs">
                                        {selectedTeam.name} team drive › {CHATS_FOLDER_NAME}
                                    </span>
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

                        <p className="shrink-0 px-6 pb-2 text-xs text-muted-foreground">
                            {teamMode
                                ? 'Each chat is saved as a file on the team drive.'
                                : 'Each chat is saved as a file in your Drive.'}
                        </p>
                    </div>
                )}

                <DialogFooter className="px-6 py-3 border-t flex-row justify-between sm:justify-between shrink-0">
                    {step === 1 ? (
                        <>
                            {myTeams && myTeams.length > 0 ? (
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button variant="outline" className="gap-2">
                                            <Users className="h-4 w-4" />
                                            Team chat
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
                                {hasMatches && (
                                    <Button variant="outline" disabled={!step1CanProceed} onClick={goToCreateStep}>
                                        Create new chat
                                    </Button>
                                )}
                                <Button onClick={advanceOrOpen} disabled={!step1CanProceed}>
                                    Let's chat
                                </Button>
                            </div>
                        </>
                    ) : (
                        <>
                            <Button
                                variant="outline"
                                onClick={() => {
                                    setCreateError(null);
                                    setStep(1);
                                }}
                            >
                                Back
                            </Button>
                            <div className="flex gap-2">
                                <Button variant="outline" onClick={() => onOpenChange(false)}>
                                    Cancel
                                </Button>
                                <Button onClick={() => void createChat()} disabled={!canCreate || isBusy}>
                                    Let's chat
                                </Button>
                            </div>
                        </>
                    )}
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
        // Whole row opens the chat when it has an Open target; the button keeps its own click and
        // stops propagation so a button press doesn't also fire the row handler.
        <div
            className={cn(
                'flex items-center justify-between gap-2 rounded-md px-2 py-1.5',
                onOpen && 'cursor-pointer eigen-list-item',
            )}
            onClick={onOpen}
        >
            <div className="min-w-0">
                <p className="truncate text-sm font-medium">{name}</p>
                {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
            </div>
            {onOpen && (
                <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={(e) => {
                        e.stopPropagation();
                        onOpen();
                    }}
                >
                    Open
                </Button>
            )}
        </div>
    );
}
