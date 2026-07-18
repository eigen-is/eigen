import { openDocument } from '@workspace/lib/api';
import { AppError } from '@workspace/lib/api-error';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { useChatSections, useCreateChat, useCreateChatRoom, useFindChatByMembers } from '@workspace/lib/chat';
import { useDebouncedValue } from '@workspace/lib/command-palette';
import { useContactSuggestions } from '@workspace/lib/contacts';
import { useMyTeams } from '@workspace/lib/home';
import { CHATS_FOLDER_NAME, type ChatMatch } from '@workspace/lib/types/chat';
import type { ContactSuggestion } from '@workspace/lib/types/contact';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { ChevronDown, MessageSquare, Users, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { ContactSuggestList } from '../contacts/contact-suggest-list';
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
    // Only the open wizard needs the team-chat aggregate; a closed one mounted in a contacts toolbar shouldn't fetch it.
    const { teams: teamSections } = useChatSections(open);

    const [step, setStep] = useState<1 | 2>(1);
    const [query, setQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
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
    // Gated on open + person mode: a closed or team-mode wizard runs no by-members lookup.
    const { data: matches = [] } = useFindChatByMembers(myOwnerId, open && !teamMode ? debouncedEmails : []);

    const excludeEmails = useMemo(() => (myEmail ? [...pickedEmails, myEmail] : pickedEmails), [pickedEmails, myEmail]);
    // Pick-only: internal users from the shared suggestion source (self + picked excluded), teams surfaced on empty query.
    const { suggestions } = useContactSuggestions(query, true, excludeEmails, { listOnEmptyQuery: true });

    // Teams as picker rows, filtered by the same query as person suggestions.
    const teamMatches = useMemo(() => {
        const q = query.trim().toLowerCase();
        return (myTeams ?? []).filter((t) => !q || t.name.toLowerCase().includes(q));
    }, [myTeams, query]);

    // Every match shares the picked set's membership by definition, so the count is uniform (+1 = me).
    const memberCount = debouncedEmails.length + 1;
    const singleWritable = !teamMode && matches.length === 1 && matches[0].canWrite;
    const isBusy = createRoom.isPending || createTeamChat.isPending;
    const canCreate = teamMode ? !!name.trim() && !!teamRootId : picked.length > 0;
    const step1CanProceed = teamMode || picked.length > 0;

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
        setQuery('');
        setSelectedIndex(0);
        setName('');
        setNameDirty(false);
        setSelectedTeamId(initialTeamId ?? null);
        const seedLocation: DriveLocationValue | null = JSON.parse(initialLocationKey);
        // A seeded location lands step 2 on the real folder; otherwise the auto `chats` default.
        setLocation(seedLocation ?? { ownerId: myOwnerId, mountId: DEFAULT_MOUNT_ID, folderId: '' });
        setLocationTouched(!!seedLocation);
        setLocationExpanded(false);
        setCreateError(null);
    }, [open, initialPeopleKey, initialLocationKey, initialTeamId, myOwnerId, myEmail]);

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

    const selectSuggestion = (suggestion: ContactSuggestion) => {
        addPerson({ email: suggestion.email, displayName: suggestion.displayName });
        setQuery('');
        setSelectedIndex(0);
    };

    const selectTeam = (teamId: string) => {
        setSelectedTeamId(teamId);
        setQuery('');
        setSelectedIndex(0);
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

    // Step 1 primary: open the one writable match if there is one, otherwise advance to confirm.
    const advanceOrOpen = () => {
        if (singleWritable) {
            goToRoom(matches[0].path);
            return;
        }
        if (step1CanProceed) setStep(2);
    };

    const createChat = () => {
        if (!canCreate || isBusy) return;
        void (teamMode ? createTeamChatRoom() : createPersonChat());
    };

    const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (suggestions.length > 0 && e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
            return;
        }
        if (suggestions.length > 0 && e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex((prev) => Math.max(prev - 1, 0));
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            // A live query with a highlighted suggestion picks it; an empty query with picks proceeds.
            if (query.trim() && suggestions[selectedIndex]) selectSuggestion(suggestions[selectedIndex]);
            else advanceOrOpen();
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex flex-col p-0 gap-0 sm:max-w-[560px] max-w-[90vw] h-[620px] max-h-[85vh]">
                <DialogHeader className="px-6 py-4 border-b shrink-0">
                    <DialogTitle>New chat</DialogTitle>
                </DialogHeader>

                {step === 1 ? (
                    /* Step 1 — who. Fixed-height picker; the suggestion list is the sole scroller so the
                       frame never jumps as suggestions/matches populate. */
                    <div className="flex flex-1 flex-col min-h-0">
                        {teamMode ? (
                            <div className="shrink-0 px-6 pt-4 pb-2">
                                <div className="group flex items-center justify-between rounded-md pr-1 hover:bg-muted/50">
                                    <div className="flex items-center gap-3">
                                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                                            <Users className="h-4 w-4 text-muted-foreground" />
                                        </div>
                                        <span className="text-sm font-medium">{selectedTeam.name}</span>
                                    </div>
                                    <TooltipButton
                                        icon={X}
                                        tooltipText="Remove"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        onClick={() => setSelectedTeamId(null)}
                                    />
                                </div>
                                {!teamRootId && (
                                    <p className="mt-1.5 text-sm text-muted-foreground">This team has no drive yet.</p>
                                )}
                            </div>
                        ) : (
                            <>
                                <div className="shrink-0 px-6 pt-4 pb-2">
                                    <Input
                                        id="chat-wizard-people"
                                        value={query}
                                        onChange={(e) => {
                                            setQuery(e.target.value);
                                            setSelectedIndex(0);
                                        }}
                                        onKeyDown={handleSearchKeyDown}
                                        placeholder="Search people or teams…"
                                        autoComplete="off"
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

                        {!teamMode && (
                            <>
                                {teamMatches.length > 0 && (
                                    <ul className="shrink-0 px-3">
                                        {teamMatches.map((team) => (
                                            <li key={team.id}>
                                                <button
                                                    type="button"
                                                    onClick={() => selectTeam(team.id)}
                                                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left eigen-list-item"
                                                >
                                                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                                                        <Users className="h-4 w-4 text-muted-foreground" />
                                                    </div>
                                                    <span className="text-sm font-medium">{team.name}</span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                <ContactSuggestList
                                    inline
                                    items={suggestions}
                                    selectedIndex={selectedIndex}
                                    onSelect={selectSuggestion}
                                    className="flex-1 min-h-0 px-3 pb-2"
                                />
                            </>
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
                                        createChat();
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
                )}

                <DialogFooter className="px-6 py-3 border-t flex-row justify-between sm:justify-between shrink-0">
                    {step === 1 ? (
                        <>
                            <div />
                            <div className="flex gap-2">
                                <Button variant="outline" onClick={() => onOpenChange(false)}>
                                    Cancel
                                </Button>
                                {singleWritable && (
                                    <Button variant="outline" onClick={() => setStep(2)}>
                                        New chat anyway
                                    </Button>
                                )}
                                <Button onClick={advanceOrOpen} disabled={!step1CanProceed}>
                                    Let's chat
                                </Button>
                            </div>
                        </>
                    ) : (
                        <>
                            <Button variant="outline" onClick={() => setStep(1)}>
                                Back
                            </Button>
                            <div className="flex gap-2">
                                <Button variant="outline" onClick={() => onOpenChange(false)}>
                                    Cancel
                                </Button>
                                <Button onClick={createChat} disabled={!canCreate || isBusy}>
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
