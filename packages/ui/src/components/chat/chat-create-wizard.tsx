// The New chat dialog: step 1 picks people or a team, step 2 names the chat and picks where it lives. Before it
// creates anything it looks for an existing chat with exactly those members and offers to open that one instead.
// Person-first surfaces open it, such as the chat sidebar's New chat button or a contact's Start chat. It creates
// the chat already shared with the picked people, through useCreateChatRoom.

import { openDocument } from '@workspace/lib/api';
import { AppError } from '@workspace/lib/api-error';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { useChatSections, useCreateChatRoom, useFindChatByMembers } from '@workspace/lib/chat';
import { useMyTeams } from '@workspace/lib/home';
import { CHATS_FOLDER_NAME } from '@workspace/lib/types/chat';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { useDebouncedValue } from '@workspace/lib/use-debounced-value';
import { Button } from '@workspace/ui/components/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { cn, HOVER_REVEAL_CLASS } from '@workspace/ui/lib/utils';
import { ChevronDown, MessageSquare, User, Users, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { ContactAddRow } from '../contacts/contact-add-row';
import { useContactInput } from '../contacts/use-contact-input';
import type { DriveLocationValue } from '../drive/drive-browser';
import { useResolvedDriveLocation } from '../drive/drive-browser';
import { DriveLocationField } from '../drive/drive-location-field';
import { InfoBlock, STRETCHED_TRIGGER_CLASS } from '../info-block';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { UserItem } from '../user/user-item';

const MATCH_DEBOUNCE_MS = 300;

type PickedPerson = { email: string; displayName: string };

// The people a chat starts with, for a caller that already knows them, such as a contact's Start chat.
type InitialPerson = { email: string; name?: string };

type ChatCreateWizardProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialPeople?: InitialPerson[];
    // Opens the room through the app's typed router. Without it, openDocument loads the room's page.
    onNavigate?: (path: DrivePath) => void;
};

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
    const destination = useResolvedDriveLocation(location);

    const selectedTeam = myTeams?.find((t) => t.id === selectedTeamId) ?? null;
    const teamMode = !!selectedTeam;
    // A team's mounts arrive without the disabled ones, so the first is the team drive. A team home has no
    // 'default' mount.
    const teamMount = selectedTeam?.mounts[0] ?? null;
    const teamChatOwnerId = selectedTeam ? teamOwnerId(selectedTeam.id) : '';
    const teamRootId = teamMount?.rootPathId ?? '';
    // Only the team-mode panel needs the chat sections, so a closed or person-mode wizard skips the fetch.
    const { teams: teamSections, isLoading: teamChatsLoading } = useChatSections(open && teamMode);
    const teamChats = teamSections.find((t) => t.id === selectedTeamId)?.chats ?? [];

    // An untouched location sends no parentId, letting the route resolve the `chats` folder.
    const createMountId = locationTouched ? location.mountId : DEFAULT_MOUNT_ID;
    const createRoom = useCreateChatRoom(myOwnerId, createMountId);
    const createTeamRoom = useCreateChatRoom(teamChatOwnerId, teamMount?.id ?? '');

    const pickedEmails = useMemo(() => picked.map((person) => person.email), [picked]);
    const pickedKey = pickedEmails.join(',');
    const debouncedKey = useDebouncedValue(pickedKey, MATCH_DEBOUNCE_MS);
    const debouncedEmails = useMemo(() => (debouncedKey ? debouncedKey.split(',') : []), [debouncedKey]);
    const { data: fetchedMatches = [], isPending: matchesPending } = useFindChatByMembers(
        myOwnerId,
        open && !teamMode ? debouncedEmails : [],
    );
    // isPending also covers the idle frame before the fetch starts, which isLoading misses. A failed lookup
    // settles too, and the wizard falls through to create.
    const personLookupPending = debouncedKey !== pickedKey || matchesPending;
    const matches = personLookupPending ? [] : fetchedMatches;

    // The suggestions leave out the people already picked and the user, as the share dialog's do.
    const excludeEmails = useMemo(() => (myEmail ? [...pickedEmails, myEmail] : pickedEmails), [pickedEmails, myEmail]);

    // Every match has exactly the picked people and me as its members.
    const memberCount = picked.length + 1;
    const hasMatches = teamMode ? teamChats.length > 0 : matches.length > 0;
    const isBusy = createRoom.isPending || createTeamRoom.isPending;
    // An empty name would create a file called just '.eigenchat'. A location the user opened has no folder
    // until its drive's root has loaded.
    const canCreate =
        !!name.trim() && (teamMode ? !!teamRootId : picked.length > 0 && (!locationTouched || !!destination.folderId));
    // Step 1 waits for the lookup to settle, so a quick Enter can't skip past an existing chat. A team
    // without a drive stays on step 1, which says so.
    const lookupPending = teamMode ? teamChatsLoading : personLookupPending;
    const step1CanProceed = (teamMode ? !!teamRootId : picked.length > 0) && !lookupPending;

    const addPerson = (person: PickedPerson) => {
        const email = person.email.toLowerCase();
        if (email === myEmail) return;
        setPicked((prev) =>
            prev.some((pickedPerson) => pickedPerson.email === email)
                ? prev
                : [...prev, { email, displayName: person.displayName || email }],
        );
    };

    // Typed input and picked suggestions join the picked set, as in the share dialog.
    const contactInput = useContactInput((contact) => {
        addPerson(contact);
        return true;
    });

    // A caller may pass a new array on every render. Its JSON stays the same, so the reset below doesn't run again
    // while the user edits.
    const initialPeopleKey = JSON.stringify(initialPeople ?? []);

    // The form starts clean each time the dialog opens, and again when its prefill changes.
    useEffect(() => {
        if (!open) return;
        const seed: InitialPerson[] = JSON.parse(initialPeopleKey);
        // A chat is always with other people, so the prefill drops the user.
        setPicked(
            seed
                .map((person) => ({
                    email: person.email.toLowerCase(),
                    displayName: person.name?.trim() || person.email,
                }))
                .filter((person) => person.email !== myEmail),
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

    // Until the user edits the name, it follows the picked people. A team chat starts with no name, because it needs a
    // typed topic.
    useEffect(() => {
        if (!open || nameDirty) return;
        setName(
            teamMode
                ? ''
                : defaultChatName(
                      picked.map((person) => person.displayName),
                      myName,
                  ),
        );
    }, [open, nameDirty, teamMode, picked, myName]);

    if (!user || isGuest) return null;

    // This shared component has no typed router of its own, and openDocument works from any app.
    const goToRoom = (path: DrivePath) => {
        onOpenChange(false);
        if (onNavigate) onNavigate(path);
        else openDocument(path);
    };

    const goToCreateStep = () => {
        setCreateError(null);
        setStep(2);
    };

    // Step 1's main button opens the first existing match. Without one, it moves on to step 2.
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
            // A team chat takes no members, because the whole team is in it. The server renames a default
            // name that collides. A name the user typed gets a 409 instead, which shows under the name field.
            goToRoom(
                teamMode
                    ? await createTeamRoom.mutateAsync({ fileName, members: [] })
                    : await createRoom.mutateAsync({
                          parentId: locationTouched ? destination.folderId : undefined,
                          fileName,
                          members: pickedEmails,
                          dedupeName: !nameDirty,
                      }),
            );
        } catch (e) {
            // The hook has already toasted any other failure. A 409 means the typed name is taken.
            if (!(e instanceof AppError) || e.status !== 409) return;
            setCreateError(`A chat named "${fileName}" already exists here. Rename it, or open the existing one.`);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex flex-col p-0 gap-0 sm:max-w-[560px] max-w-[90vw] h-[620px] max-h-[85vh]">
                <DialogHeader className="px-6 py-4 border-b shrink-0">
                    <DialogTitle>New chat</DialogTitle>
                    <DialogDescription className="sr-only">
                        Choose who to chat with, then name the chat.
                    </DialogDescription>
                </DialogHeader>

                {step === 1 ? (
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
                                        tooltipText={`Remove ${selectedTeam.name}`}
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
                                        {picked.map((person) => (
                                            <div
                                                key={person.email}
                                                className="group flex items-center justify-between rounded-md pr-1 hover:bg-muted/50"
                                            >
                                                <UserItem email={person.email} />
                                                <div className={HOVER_REVEAL_CLASS}>
                                                    <TooltipButton
                                                        icon={X}
                                                        tooltipText={`Remove ${person.email}`}
                                                        variant="ghost"
                                                        className="h-7 w-7"
                                                        onClick={() =>
                                                            setPicked((prev) =>
                                                                prev.filter((other) => other.email !== person.email),
                                                            )
                                                        }
                                                    />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}

                        {/* This spacer pushes the existing-chat panel down to just above the footer. */}
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
                                      {matches.map((m) => (
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
                                <InfoBlock className="relative mt-1.5 w-full gap-1.5 text-sm hover:bg-muted">
                                    <span className="text-xs">My Drive › {CHATS_FOLDER_NAME}</span>
                                    <button
                                        type="button"
                                        aria-label="Change location"
                                        aria-expanded={false}
                                        className={cn(
                                            STRETCHED_TRIGGER_CLASS,
                                            'ml-auto flex shrink-0 items-center gap-0.5',
                                        )}
                                        onClick={() => {
                                            setLocationTouched(true);
                                            setLocationExpanded(true);
                                        }}
                                    >
                                        <span className="mr-1 text-xs text-muted-foreground">Change</span>
                                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                    </button>
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
                                                <User className="h-4 w-4" />
                                                Personal chat
                                            </DropdownMenuItem>
                                        )}
                                        {myTeams.map((team) => (
                                            <DropdownMenuItem
                                                key={team.id}
                                                onClick={() => setSelectedTeamId(team.id)}
                                                disabled={team.id === selectedTeamId}
                                            >
                                                <Users className="h-4 w-4" />
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

// Both people see a 1:1 chat under the same file name, so it carries both names. A group lists only the picked people.
function defaultChatName(pickedNames: readonly string[], myName: string): string {
    if (pickedNames.length === 0) return '';
    if (pickedNames.length === 1) return `${pickedNames[0]} & ${myName}`;
    return `${pickedNames.slice(0, -1).join(', ')} & ${pickedNames[pickedNames.length - 1]}`;
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
        // The whole row opens the chat. The button stops the click there, so one press opens it once.
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
