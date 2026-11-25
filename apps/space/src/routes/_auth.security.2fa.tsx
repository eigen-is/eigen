// Space's two-factor authentication page. With it off, it walks through the setup steps; with it on, it shows the
// state and the form that turns it off again. It reads which from the session as it opens.

import { createFileRoute } from '@tanstack/react-router';
import { authClient } from '@workspace/lib/auth';
import { SettingsPage } from '@workspace/ui/components/layout/app';
import { Separator } from '@workspace/ui/components/separator';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TwoFactorSecret } from '../components/space/fa2';
import {
    TwoFactorCodesStep,
    TwoFactorDisable,
    TwoFactorPasswordStep,
    TwoFactorQrStep,
    TwoFactorVerifyStep,
} from '../components/space/fa2';

export const Route = createFileRoute('/_auth/security/2fa')({
    component: TwoFaComponent,
});

type SetupStep = 'qrcode' | 'verification' | 'recoverycodes';

function TwoFaComponent() {
    const [twoFactorEnabled, setTwoFactorEnabled] = useState<boolean | null>(null);
    // The secret the password step turned on, and the step after it that shows.
    const [setup, setSetup] = useState<{ secret: TwoFactorSecret; step: SetupStep } | null>(null);

    useEffect(() => {
        authClient
            .getSession()
            .then(({ data }) => {
                setTwoFactorEnabled(data?.user?.twoFactorEnabled ?? false);
            })
            .catch(() => {
                setTwoFactorEnabled(false);
            });
    }, []);

    if (twoFactorEnabled === null) return null;

    if (twoFactorEnabled) {
        return (
            <SettingsPage title="Two-factor authentication">
                <div className="space-y-6">
                    <div className="flex items-center gap-3 text-sm">
                        <ShieldCheck className="h-5 w-5 text-primary" />
                        <span>Two-factor authentication is enabled on your account.</span>
                    </div>
                    <Separator />
                    <TwoFactorDisable onDisabled={() => setTwoFactorEnabled(false)} />
                </div>
            </SettingsPage>
        );
    }

    const goTo = (step: SetupStep) => setSetup((current) => current && { ...current, step });

    return (
        <SettingsPage title="Two-factor authentication">
            <div className="space-y-8 pb-20">
                <p className="text-muted-foreground">
                    Add an extra layer of security to your account by enabling two-factor authentication.
                </p>
                <Separator />
                {!setup && <TwoFactorPasswordStep onEnabled={(secret) => setSetup({ secret, step: 'qrcode' })} />}
                {setup?.step === 'qrcode' && (
                    <TwoFactorQrStep
                        totpURI={setup.secret.totpURI}
                        onBack={() => setSetup(null)}
                        onContinue={() => goTo('verification')}
                    />
                )}
                {setup?.step === 'verification' && (
                    <TwoFactorVerifyStep onBack={() => goTo('qrcode')} onVerified={() => goTo('recoverycodes')} />
                )}
                {setup?.step === 'recoverycodes' && <TwoFactorCodesStep backupCodes={setup.secret.backupCodes} />}
            </div>
        </SettingsPage>
    );
}
