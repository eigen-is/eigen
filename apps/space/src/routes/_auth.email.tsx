import { createFileRoute } from '@tanstack/react-router';
import { useMailEnabled } from '@workspace/lib/public';
import { EmptyState, SettingsPage } from '@workspace/ui';
import { Separator } from '@workspace/ui/components/separator';
import { MailX } from 'lucide-react';
import { MailPrefsSection } from '../components/space/mail-prefs-section';
import { SignatureSection } from '../components/space/signature-section';

export const Route = createFileRoute('/_auth/email')({
    component: RouteComponent,
});

function RouteComponent() {
    const mailEnabled = useMailEnabled();

    // The sidebar hides this page on a server without hosted mail; this catches the bookmark or typed URL.
    if (!mailEnabled) {
        return (
            <SettingsPage title="Mail">
                <EmptyState
                    icon={<MailX className="h-8 w-8" />}
                    message="Mail is turned off on this server"
                    hint="Your administrator runs Eigen without hosted mailboxes. Use your own mail app instead."
                />
            </SettingsPage>
        );
    }

    return (
        <SettingsPage title="Mail">
            <div className="space-y-8">
                <SignatureSection />
                <Separator />
                <MailPrefsSection />
            </div>
        </SettingsPage>
    );
}
