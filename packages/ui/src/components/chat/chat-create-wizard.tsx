import { openDocument } from '@workspace/lib/api';
import { AppError } from '@workspace/lib/api-error';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { useChatSections, useCreateChatRoom, useFindChatByMembers } from '@workspace/lib/chat';
import { useMyTeams } from '@workspace/lib/home';
import { CHATS_FOLDER_NAME, type ChatMatch } from '@workspace/lib/types/chat';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { useDebouncedValue } from '@workspace/lib/use-debounced-value';
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
import { ChevronDown, MessageSquare, User, Users, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ContactAddRow } from '../contacts/contact-add-row';
import { useContactInput } from '../contacts/use-contact-input';
import { DriveLocationField, type DriveLocationValue } from '../drive/drive-location-field';
import { InfoBlock } from '../info-block';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { UserItem } from '../user/user-item';

const MATCH_DEBOUNCE_MS = 300;

type PickedPerson = { email: string; displayName: string };

// Prefill for callers that already know who the chat is with (contacts' "Start chat").
type InitialPerson = { email: string; name?: string };

type ChatCreateWizardProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialPeople?: InitialPerson[];
    // Typed router navigation for the target room; omitted → openDocument (window.location) fallback.
    onNavigate?: (path: DrivePath) => void;
};

// A 1:1 carries both names (the file name is shared); groups list the picked members only.
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
    // Mounts arrive enabled-filtered, so the first is the team drive (team homes have no 'default' id).
    const teamMount = selectedTeam?.mounts[0] ?? null;
    const teamChatOwnerId = selectedTeam ? teamOwnerId(selectedTeam.id) : '';
    const teamRootId = teamMount?.rootPathId ?? '';
    // The aggregate backs only the team-mode panel — closed or person-mode wizards skip the fetch.
    const { teams: teamSections, isLoading: teamChatsLoading } = useChatSections(open && teamMode);
    const teamChats = teamSections.find((t) => t.id === selectedTeamId)?.chats ?? [];

    // An untouched location sends no parentId, letting the route resolve the `chats` folder.
    const createMountId = locationTouched ? location.mountId : DEFAULT_MOUNT_ID;
    const createRoom = useCreateChatRoom(myOwnerId, createMountId);
    const createTeamRoom = useCreateChatRoom(teamChatOwnerId, teamMount?.id ?? '');

    const pickedEmails = useMemo(() => picked.map((p) => p.email), [picked]);
    const pickedKey = pickedEmails.join(',');
    const debouncedKey = useDebouncedValue(pickedKey, MATCH_DEBOUNCE_MS);
    const debouncedEmails = useMemo(() => (debouncedKey ? debouncedKey.split(',') : []), [debouncedKey]);
    // Gated on open + person mode: a closed or team-mode wizard runs no by-members lookup.
    const { data: fetchedMatches = [], isPending: matchesPending } = useFindChatByMembers(
        myOwnerId,
        open && !teamMode ? debouncedEmails : [],
    );
    // Settled = debounce caught up AND the current key resolved or errored (isPending covers the
    // pre-fetch idle frame isLoading misses). One predicate gates both the match panel and step 1,
    // so they can't disagree; an errored lookup settles and falls through to create.
    const personLookupPending = debouncedKey !== pickedKey || matchesPending;
    const matches = personLookupPending ? [] : fetchedMatches;

    // Already-picked people and self are excluded from the ACL suggestion popover (mirrors the share dialog).
    const excludeEmails = useMemo(() => (myEmail ? [...pickedEmails, myEmail] : pickedEmails), [pickedEmails, myEmail]);

    // Every match shares the picked set's membership by definition (+1 = me).
    const memberCount = picked.length + 1;
    // When any existing chat matches, the primary opens the first; "Create new chat" leads to step 2.
    const hasMatches = teamMode ? teamChats.length > 0 : matches.length > 0;
    const isBusy = createRoom.isPending || createTeamRoom.isPending;
    // Both modes need a name — an emptied one would create a bare '.eigenchat' file.
    const canCreate = !!name.trim() && (teamMode ? !!teamRootId : picked.length > 0);
    // Open-first is only trustworthy once the lookup settles — hold step 1 so a quick Enter can't
    // race past an existing match. Mountless teams stay on step 1 ("no drive yet" note).
    const lookupPending = teamMode ? teamChatsLoading : personLookupPending;
    const step1CanProceed = (teamMode ? !!teamRootId : picked.length > 0) && !lookupPending;

    const addPerson = (person: PickedPerson) => {
        const email = person.email.toLowerCase();
        if (email === myEmail) return;
        setPicked((prev) =>
            prev.some((p) => p.email === email) ? prev : [...prev, { email, displayName: person.displayName || email }],
        );
    };

    // Typed input and picked suggestions join the picked set — same flow as the share dialog.
    const contactInput = useContactInput((contact) => {
        addPerson(contact);
        return true;
    });

    // Serialized so a caller's fresh array literal can't re-run the reset effect mid-edit.
    const initialPeopleKey = JSON.stringify(initialPeople ?? []);

    // Reset to a clean form each time the dialog opens (or its prefill changes).
    useEffect(() => {
        if (!open) return;
        const seed: InitialPerson[] = JSON.parse(initialPeopleKey);
        // Drop self from the prefill — a chat is always with other people.
        setPicked(
            seed
                .map((p) => ({ email: p.email.toLowerCase(), displayName: p.name?.trim() || p.email }))
                .filter((p) => p.email !== myEmail),
        );
        setStep(1);
        contactInput.setValue('');
        setName('');
        setNameDirty(false);
        setSelectedTeamId(null);
        setLocation({ ownerId: myOwnerId, mountId: DEFAULT_MOUNT_ID, folderId: '' });
        setLocationTouched(false);
        setLocationExpanded(false);
        setCreateError(null);
    }, [open, initialPeopleKey, myOwnerId, myEmail, contactInput.setValue]);

    // Live-default the name until the user edits it; team mode requires a typed topic instead.
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

    // openDocument works from any app's route tree — this shared component can't own a typed navigate.
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
            // Team membership is implicit, so team rooms take no members. A default (non-dirty)
            // name lets the server dedupe a collision; a user-typed one 409s, surfaced inline below.
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
                    /* Step 1 — who: an ACL-style people picker mirroring the share dialog. */
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
                                                <div className="invisible group-hover:visible pointer-coarse:visible">
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

                        {/* Spacer pins the existing-chat panel just above the footer. */}
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
                    /* Step 2 — confirm: name + location. */
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

function MatchRow({ name, subtitle, onOpen }: { name: string; subtitle: string | null; onOpen: () => void }) {
    return (
        // The whole row opens the chat; the button stops propagation so a press doesn't double-fire.
        <div
            className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 eigen-list-item"
            onClick={onOpen}
        >
            <div className="min-w-0">
                <p className="truncate text-sm font-medium">{name}</p>
                {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
            </div>
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
        </div>
    );
}
