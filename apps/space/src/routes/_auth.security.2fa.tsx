import {createFileRoute, useNavigate} from '@tanstack/react-router'
import {toast} from 'sonner';
import {useState} from 'react';

import {TwoFactorSetup} from '../components/space/fa2'
import {authClient} from '@workspace/lib/auth';

export const Route = createFileRoute('/_auth/security/2fa')({
    component: TwoFaComponent,
})

function TwoFaComponent() {
    const navigate = useNavigate();
    const [totpUri, setTotpUri] = useState<string | null>(null);
    const [secretKey, setSecretKey] = useState<string>("");
    const [setupStep, setSetupStep] = useState<"password" | "qrcode" | "verification">("password");

    // Step 1: Initialize 2FA with password
    const handleInitialize2FA = async (password: string) => {
        try {
            const result = await authClient.twoFactor.enable({
                password
            });

            if (result.data) {
                // Get the TOTP URI from the response
                setTotpUri(result.data.totpURI);
                setSecretKey(result.data.totpURI.split('secret=')[1].split('&')[0]);
                setSetupStep("qrcode");
                toast.success('Two-factor authentication initialized. Please scan the QR code.');
            } else {
                console.log(result.error)
                toast.error(result.error?.message ?? (result.error?.status + " - " + result.error?.statusText));
            }
        } catch (error) {
            console.error('Error initializing 2FA:', error);
            toast.error('Failed to initialize two-factor authentication');
        }
    };

    // Step 2: Verify TOTP code to complete 2FA setup
    const handleVerifyTotp = async (code: string, enableTwoFactor: boolean) => {
        try {
            const result = await authClient.twoFactor.verifyTotp({
                code
            });

            if (result.data) {
                toast.success('Two-factor authentication ' + (enableTwoFactor ? 'enabled' : 'disabled'));

                // Wait 350ms before navigating
                await new Promise(resolve => setTimeout(resolve, 350));

                // Navigate back to the root
                navigate({
                    to: '/',
                });
            } else {
                toast.error(result.error?.message ?? 'Failed to verify verification code');
            }
        } catch (error) {
            console.error('Error verifying TOTP:', error);
            toast.error('Failed to verify verification code');
        }
    };

    // Handle back button in the flow
    const handleBack = () => {
        if (setupStep === "verification") {
            setSetupStep("qrcode");
        } else if (setupStep === "qrcode") {
            setSetupStep("password");
        }
    };

    return (

        <div className="flex flex-col min-h-screen">
            <div className="w-full max-w-3xl m-8">
                <h1 className="text-2xl font-semibold mb-6">Two-Factor Authentication</h1>

                <TwoFactorSetup
                    onInitialize2FA={handleInitialize2FA}
                    onVerifyTotp={handleVerifyTotp}
                    onBack={handleBack}
                    totpUri={totpUri}
                    secretKey={secretKey}
                    currentStep={setupStep}
                    setCurrentStep={setSetupStep}
                />
            </div>
        </div>
    );
}
