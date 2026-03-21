import {createFileRoute, useNavigate} from '@tanstack/react-router'
import {toast} from 'sonner';
import {useEffect, useState} from 'react';
import {zodResolver} from '@hookform/resolvers/zod';
import {useForm} from 'react-hook-form';
import {z} from 'zod';
import {TwoFactorSetup} from '../components/space/fa2'
import {authClient} from '@workspace/lib/auth';
import {Button} from '@workspace/ui/components/button';
import {Separator} from '@workspace/ui/components/separator';
import {ShieldCheck} from 'lucide-react';
import {Form, FormControl, FormField, FormItem, FormLabel, FormMessage} from '@workspace/ui/components/form';
import {Input} from '@workspace/ui/components/input';

export const Route = createFileRoute('/_auth/security/2fa')({
    component: TwoFaComponent,
})

const disableSchema = z.object({
    password: z.string().min(1, "Password is required"),
});

function TwoFaComponent() {
    const navigate = useNavigate();
    const [totpUri, setTotpUri] = useState<string | null>(null);
    const [secretKey, setSecretKey] = useState<string>("");
    const [backupCodes, setBackupCodes] = useState<string[]>([]);
    const [setupStep, setSetupStep] = useState<"password" | "qrcode" | "verification" | "recoverycodes">("password");
    const [twoFactorEnabled, setTwoFactorEnabled] = useState<boolean | null>(null);
    const [showDisableForm, setShowDisableForm] = useState(false);
    const [isDisabling, setIsDisabling] = useState(false);

    useEffect(() => {
        authClient.getSession().then(({data}) => {
            setTwoFactorEnabled(data?.user?.twoFactorEnabled ?? false);
        }).catch(() => {
            setTwoFactorEnabled(false);
        });
    }, []);

    const disableForm = useForm<z.infer<typeof disableSchema>>({
        resolver: zodResolver(disableSchema),
        defaultValues: {password: ""},
    });

    const handleInitialize2FA = async (password: string) => {
        try {
            const result = await authClient.twoFactor.enable({
                password
            });

            if (result.data) {
                setTotpUri(result.data.totpURI);
                setSecretKey(new URL(result.data.totpURI).searchParams.get('secret') || '');
                setBackupCodes(result.data.backupCodes ?? []);
                setSetupStep("qrcode");
                toast.success('Two-factor authentication initialized. Please scan the QR code.');
            } else {
                toast.error(result.error?.message ?? 'Failed to initialize two-factor authentication');
            }
        } catch (error) {
            console.error('Error initializing 2FA:', error);
            toast.error('Failed to initialize two-factor authentication');
        }
    };

    const handleVerifyTotp = async (code: string): Promise<boolean> => {
        try {
            const result = await authClient.twoFactor.verifyTotp({code});

            if (result.data) {
                toast.success('Two-factor authentication enabled');
                return true;
            } else {
                toast.error(result.error?.message ?? 'Failed to verify verification code');
                return false;
            }
        } catch (error) {
            console.error('Error verifying TOTP:', error);
            toast.error('Failed to verify verification code');
            return false;
        }
    };

    const handleComplete = () => {
        navigate({to: '/'});
    };

    const handleBack = () => {
        if (setupStep === "verification") {
            setSetupStep("qrcode");
        } else if (setupStep === "qrcode") {
            setSetupStep("password");
        }
    };

    const handleDisable = async (values: z.infer<typeof disableSchema>) => {
        try {
            setIsDisabling(true);
            const result = await authClient.twoFactor.disable({
                password: values.password,
            });
            if (result.data) {
                toast.success('Two-factor authentication disabled');
                setTwoFactorEnabled(false);
                setShowDisableForm(false);
                disableForm.reset();
            } else {
                toast.error(result.error?.message ?? 'Failed to disable two-factor authentication');
            }
        } catch (error) {
            console.error('Error disabling 2FA:', error);
            toast.error('Failed to disable two-factor authentication');
        } finally {
            setIsDisabling(false);
        }
    };

    if (twoFactorEnabled === null) return null;

    if (twoFactorEnabled) {
        return (
            <div className="flex flex-col m-8">
                <div className="w-full max-w-3xl">
                    <h1 className="text-2xl font-semibold mb-6">Two-Factor Authentication</h1>

                    <div className="space-y-6">
                        <div className="flex items-center gap-3 text-sm">
                            <ShieldCheck className="h-5 w-5 text-primary"/>
                            <span>Two-factor authentication is enabled on your account.</span>
                        </div>

                        <Separator/>

                        {!showDisableForm ? (
                            <Button
                                variant="destructive"
                                onClick={() => setShowDisableForm(true)}
                            >
                                Disable Two-Factor Authentication
                            </Button>
                        ) : (
                            <Form {...disableForm}>
                                <form onSubmit={disableForm.handleSubmit(handleDisable)} className="space-y-4 max-w-sm">
                                    <FormField
                                        control={disableForm.control}
                                        name="password"
                                        render={({field}) => (
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
                                                <FormMessage/>
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
                                        <Button type="submit" variant="destructive" disabled={isDisabling}>
                                            {isDisabling ? "Disabling..." : "Disable"}
                                        </Button>
                                    </div>
                                </form>
                            </Form>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col m-8">
            <div className="w-full max-w-3xl">
                <h1 className="text-2xl font-semibold mb-6">Two-Factor Authentication</h1>

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
    );
}
