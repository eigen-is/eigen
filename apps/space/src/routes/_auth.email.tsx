import { createFileRoute } from '@tanstack/react-router';
import { useMailEnabled } from '@workspace/lib/public';
import { SettingsPage } from '@workspace/ui';
import { MailOffState } from '@workspace/ui/components/mail';
import { Separator } from '@workspace/ui/components/separator';
import { MailPrefsSection } from '../components/space/mail-prefs-section';
import { SignatureSection } from '../components/space/signature-section';

export const Route = createFileRoute('/_auth/email')({
    component: RouteComponent,
});

function RouteComponent() {
    const mailEnabled = useMailEnabled();

    if (!mailEnabled) {
        return (
            <SettingsPage title="Mail">
                <MailOffState />
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
