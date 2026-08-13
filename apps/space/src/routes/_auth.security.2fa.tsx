import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { authClient, useDisable2FA, useInitialize2FA, useVerifyTotp } from '@workspace/lib/auth';
import { Button } from '@workspace/ui/components/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@workspace/ui/components/form';
import { Input } from '@workspace/ui/components/input';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { Separator } from '@workspace/ui/components/separator';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { TwoFactorSetup } from '../components/space/fa2';

export const Route = createFileRoute('/_auth/security/2fa')({
    component: TwoFaComponent,
});

const disableSchema = z.object({
    password: z.string().min(1, 'Password is required'),
});

function TwoFaComponent() {
    const navigate = useNavigate();
    const [totpUri, setTotpUri] = useState<string | null>(null);
    const [secretKey, setSecretKey] = useState<string>('');
    const [backupCodes, setBackupCodes] = useState<string[]>([]);
    const [setupStep, setSetupStep] = useState<'password' | 'qrcode' | 'verification' | 'recoverycodes'>('password');
    const [twoFactorEnabled, setTwoFactorEnabled] = useState<boolean | null>(null);
    const [showDisableForm, setShowDisableForm] = useState(false);

    const initialize2FA = useInitialize2FA();
    const verifyTotp = useVerifyTotp();
    const disable2FA = useDisable2FA();

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

    const disableForm = useForm<z.infer<typeof disableSchema>>({
        resolver: zodResolver(disableSchema),
        defaultValues: { password: '' },
    });

    const handleInitialize2FA = async (password: string) => {
        const data = await initialize2FA.mutateAsync(password);
        if (data) {
            setTotpUri(data.totpURI);
            setSecretKey(new URL(data.totpURI).searchParams.get('secret') || '');
            setBackupCodes(data.backupCodes ?? []);
            setSetupStep('qrcode');
        }
    };

    const handleVerifyTotp = async (code: string): Promise<boolean> => {
        const data = await verifyTotp.mutateAsync({ code });
        return !!data;
    };

    const handleComplete = () => {
        navigate({ to: '/' });
    };

    const handleBack = () => {
        if (setupStep === 'verification') {
            setSetupStep('qrcode');
        } else if (setupStep === 'qrcode') {
            setSetupStep('password');
        }
    };

    const handleDisable = async (values: z.infer<typeof disableSchema>) => {
        await disable2FA.mutateAsync(values.password);
        setTwoFactorEnabled(false);
        setShowDisableForm(false);
        disableForm.reset();
    };

    if (twoFactorEnabled === null) return null;

    const toolbar = <ToolbarTitle>Two-Factor Authentication</ToolbarTitle>;

    if (twoFactorEnabled) {
        return (
            <ColumnLayout>
                <Column id="detail" width="flex" onBack="sidebar" toolbar={toolbar}>
                    <div className="h-full overflow-y-auto">
                        <div className="w-full max-w-3xl app-gutter">
                            <div className="space-y-6">
                                <div className="flex items-center gap-3 text-sm">
                                    <ShieldCheck className="h-5 w-5 text-primary" />
                                    <span>Two-factor authentication is enabled on your account.</span>
                                </div>

                                <Separator />

                                {!showDisableForm ? (
                                    <Button variant="destructive" onClick={() => setShowDisableForm(true)}>
                                        Disable Two-Factor Authentication
                                    </Button>
                                ) : (
                                    <Form {...disableForm}>
                                        <form
                                            onSubmit={disableForm.handleSubmit(handleDisable)}
                                            className="space-y-4 max-w-sm"
                                        >
                                            <FormField
                                                control={disableForm.control}
                                                name="password"
                                                render={({ field }) => (
                                                    <FormItem>
                                                        <FormLabel>Confirm your password</FormLabel>
                                                        <FormControl>
                                                            <Input
                                                                type="password"
                                                                placeholder="Enter current password"
                                                                autoComplete="current-password"
                                                                autoFocus
                                                                {...field}
                                                            />
                                                        </FormControl>
                                                        <FormMessage />
                                                    </FormItem>
                                                )}
                                            />
                                            <div className="flex gap-3">
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    onClick={() => {
                                                        setShowDisableForm(false);
                                                        disableForm.reset();
                                                    }}
                                                >
                                                    Cancel
                                                </Button>
                                                <Button
                                                    type="submit"
                                                    variant="destructive"
                                                    disabled={disable2FA.isPending}
                                                >
                                                    {disable2FA.isPending ? 'Disabling...' : 'Disable'}
                                                </Button>
                                            </div>
                                        </form>
                                    </Form>
                                )}
                            </div>
                        </div>
                    </div>
                </Column>
            </ColumnLayout>
        );
    }

    return (
        <ColumnLayout>
            <Column id="detail" width="flex" onBack="sidebar" toolbar={toolbar}>
                <div className="h-full overflow-y-auto">
                    <div className="w-full max-w-3xl app-gutter">
                        <TwoFactorSetup
                            onInitialize2FA={handleInitialize2FA}
                            onVerifyTotp={handleVerifyTotp}
                            onComplete={handleComplete}
                            onBack={handleBack}
                            totpUri={totpUri}
                            secretKey={secretKey}
                            backupCodes={backupCodes}
                            currentStep={setupStep}
                            setCurrentStep={setSetupStep}
                        />
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
