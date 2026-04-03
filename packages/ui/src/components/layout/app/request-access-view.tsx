import { useAuth } from '@workspace/lib/auth';
import { useRequestAccess } from '@workspace/lib/drive';
import { usePublicUser } from '@workspace/lib/public';
import { Button } from '@workspace/ui/components/button';
import { Textarea } from '@workspace/ui/components/textarea';
import { LockKeyhole } from 'lucide-react';
import { useState } from 'react';
import { UserAvatar } from '../user-avatar';

type RequestAccessViewProps = {
    ownerId: string;
    mountId: string;
    pathId: string;
};

export function RequestAccessView({ ownerId, mountId, pathId }: RequestAccessViewProps) {
    const auth = useAuth();
    const { data: owner } = usePublicUser(ownerId);
    const requestAccess = useRequestAccess(ownerId, mountId, pathId);
    const [message, setMessage] = useState('');
    const [showMessage, setShowMessage] = useState(false);

    const handleSubmit = () => {
        requestAccess.mutate({ message: message || undefined });
    };

    return (
        <div className="flex flex-col items-center justify-center h-full w-full gap-6 p-8 text-center">
            <LockKeyhole className="h-12 w-12 text-muted-foreground" />
            <div className="space-y-1">
                <h2 className="text-lg font-semibold">You need access</h2>
                {owner && (
                    <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                        <UserAvatar email={ownerId} size="sm" />
                        <span>{owner.name}</span>
                    </div>
                )}
            </div>

            <div className="flex flex-col items-center gap-3 w-full max-w-sm">
                {showMessage ? (
                    <Textarea
                        placeholder="Add a message (optional)"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        rows={3}
                        className="w-full"
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

                <Button onClick={handleSubmit} disabled={requestAccess.isPending || requestAccess.isSuccess}>
                    {requestAccess.isSuccess ? 'Access requested' : 'Request access'}
                </Button>
            </div>

            {auth.user?.email && <p className="text-xs text-muted-foreground">Signed in as {auth.user.email}</p>}
        </div>
    );
}
