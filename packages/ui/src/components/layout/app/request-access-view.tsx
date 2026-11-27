// The page a person sees on a link to a file, folder or chat they may not open: who owns it, and a form that asks the
// owner for access with an optional message. Drive, Chat and the document editors show it when the server says no.
// Cmd+Enter sends from the message box. A guest can't ask, so a guest is told to ask the owner to share instead, and a
// visitor without a login, such as one whose public link just closed, goes to log in as the route guard sends one.

import { useRouter } from '@tanstack/react-router';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { useRequestAccess } from '@workspace/lib/drive';
import { usePublicUser } from '@workspace/lib/public';
import { Button } from '@workspace/ui/components/button';
import { Textarea } from '@workspace/ui/components/textarea';
import { LockKeyhole } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDialogPending } from '../../../hooks/use-dialog-pending';
import { FormShell } from '../../form-shell';
import { UserAvatar } from '../../user/user-avatar';
import { loginLocation } from '../pages/auth-route';
import { useLayout } from './layout-context';

type RequestAccessViewProps = {
    ownerId: string;
    mountId: string;
    pathId: string;
};

export function RequestAccessView({ ownerId, mountId, pathId }: RequestAccessViewProps) {
    const { user } = useAuth();
    const isGuest = useIsGuest();
    const { setSidebarHidden } = useLayout();
    const { data: owner } = usePublicUser(ownerId);
    const requestAccess = useRequestAccess(ownerId, mountId, pathId);
    const [message, setMessage] = useState('');
    const [showMessage, setShowMessage] = useState(false);
    const { pending, run } = useDialogPending();
    const router = useRouter();
    const signedOut = !user;

    useEffect(() => {
        setSidebarHidden(true);
        return () => setSidebarHidden(false);
    }, [setSidebarHidden]);

    // Once, from the page as it is now: the location changes while the login page loads.
    useEffect(() => {
        if (signedOut) router.navigate({ ...loginLocation(router.state.location), replace: true });
    }, [signedOut, router]);

    if (signedOut) return null;

    return (
        <div className="flex flex-col items-center justify-center h-full w-full gap-6 p-8 text-center">
            <LockKeyhole className="h-12 w-12 text-muted-foreground" />
            <div className="space-y-1">
                <h2 className="text-lg font-medium">You need access</h2>
                {owner && (
                    <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                        <UserAvatar email={ownerId} size="sm" />
                        <span>{owner.name}</span>
                    </div>
                )}
            </div>

            {isGuest ? (
                <p className="text-sm text-muted-foreground">Ask the owner to share it with you.</p>
            ) : (
                <FormShell
                    className="flex flex-col items-center gap-3 w-full max-w-sm"
                    onSubmit={() =>
                        run(async () => {
                            await requestAccess.mutateAsync({ message: message || undefined });
                        })
                    }
                >
                    {showMessage ? (
                        <Textarea
                            aria-label="Message"
                            placeholder="Add a message (optional)"
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            rows={3}
                            className="w-full"
                            autoFocus
                        />
                    ) : (
                        !requestAccess.isSuccess && (
                            <button
                                type="button"
                                className="text-sm text-muted-foreground hover:text-foreground underline"
                                onClick={() => setShowMessage(true)}
                            >
                                Add a message
                            </button>
                        )
                    )}

                    <Button type="submit" pending={pending} disabled={requestAccess.isSuccess}>
                        {requestAccess.isSuccess ? 'Access requested' : 'Request access'}
                    </Button>
                </FormShell>
            )}

            <p className="text-xs text-muted-foreground">Signed in as {user.email}</p>
        </div>
    );
}
