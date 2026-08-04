import { setupApi } from '@workspace/lib/api';
import { AppError } from '@workspace/lib/api-error';
import { EMPTY_S3 } from '@workspace/lib/types';
import type { S3Config } from '@workspace/lib/types/mount';
import type { ServerStorageType } from '@workspace/lib/types/settings';
import { LoadingState } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card';
import { Input } from '@workspace/ui/components/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@workspace/ui/components/input-group';
import { Label } from '@workspace/ui/components/label';
import { EigenLoader } from '@workspace/ui/components/layout/braket/eigen-loader';
import { CheckCircle2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { StorageTypePicker } from './storage-type-picker';

async function checkS3ViaSetup(config: S3Config): Promise<{ ok: boolean; message: string }> {
    const res = await setupApi.s3check.post(config);
    if (res.error) return { ok: false, message: new AppError(res).message };
    return res.data;
}

export function SetupWizard() {
    const [step, setStep] = useState<'loading' | 'config' | 'complete' | 'already-setup'>('loading');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const [domain, setDomain] = useState('');
    const [domainFromEnv, setDomainFromEnv] = useState(false);
    const [mailDomain, setMailDomain] = useState('');
    const [orgName, setOrgName] = useState('');
    const [storageType, setStorageType] = useState<ServerStorageType>('local-fullnames');
    const [s3Config, setS3Config] = useState<S3Config>(EMPTY_S3);
    const [adminUsername, setAdminUsername] = useState('');
    const [adminPassword, setAdminPassword] = useState('');
    const [adminName, setAdminName] = useState('');
    const [s3Verified, setS3Verified] = useState(true);
    const onS3Verified = useCallback((verified: boolean) => setS3Verified(verified), []);

    // Mirrors backend getMailDomain(): MAIL_DOMAIN env → DOMAIN env → user-typed domain.
    const effectiveMailDomain = mailDomain || domain;
    const formReady = !!(domain && orgName && adminUsername && adminName && adminPassword.length >= 8 && s3Verified);

    useEffect(() => {
        setupApi.status
            .get()
            .then((res) => {
                const data = res.data;
                if (!data?.setupRequired) {
                    setStep('already-setup');
                } else {
                    if (data.domain) {
                        setDomain(data.domain === 'localhost' ? 'eigen.localhost' : data.domain);
                        setDomainFromEnv(data.domain !== 'localhost');
                    }
                    setMailDomain(data.mailDomain ?? '');
                    setStep('config');
                }
            })
            .catch(() => {
                setError('Failed to connect to server');
                setStep('config');
            });
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formReady) return;
        setLoading(true);
        setError(null);

        try {
            const res = await setupApi.complete.post({
                domain,
                orgName,
                storageType,
                adminEmail: `${adminUsername}@${effectiveMailDomain}`,
                adminPassword,
                adminName,
                ...(storageType === 's3'
                    ? {
                          s3Endpoint: s3Config.endpoint,
                          s3Bucket: s3Config.bucket,
                          s3Region: s3Config.region ?? '',
                          s3AccessKeyId: s3Config.accessKeyId,
                          s3SecretAccessKey: s3Config.secretAccessKey,
                      }
                    : {}),
            });
            if (res.error) {
                setError(new AppError(res).message);
                return;
            }
            setStep('complete');
        } catch {
            setError('Network error. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    if (step === 'loading') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <LoadingState />
            </div>
        );
    }

    if (step === 'already-setup') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background p-4">
                <Card className="w-full max-w-md">
                    <CardHeader className="text-center">
                        <CardTitle className="text-2xl">Already Configured</CardTitle>
                        <CardDescription>Eigen has already been set up. Please proceed to login.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Button className="w-full" onClick={() => (window.location.href = '/')}>
                            Go to Login
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (step === 'complete') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background p-4">
                <Card className="w-full max-w-md">
                    <CardHeader className="text-center">
                        <CheckCircle2 className="mx-auto h-16 w-16 text-success mb-4" />
                        <CardTitle className="text-2xl">Setup Complete!</CardTitle>
                        <CardDescription>
                            Eigen has been configured successfully. You can now log in with your admin account.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Button className="w-full" onClick={() => (window.location.href = '/')}>
                            Go to Login
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4">
            <Card className="w-full max-w-lg">
                <CardHeader className="text-center">
                    <div className="mx-auto mb-4">
                        <EigenLoader className="h-12 w-auto" />
                    </div>
                    <CardTitle className="text-2xl">Welcome to Eigen</CardTitle>
                    <CardDescription>Let's configure your instance</CardDescription>
                </CardHeader>
                <CardContent>
                    {error && (
                        <div className="bg-destructive/10 border border-destructive/20 text-destructive px-4 py-3 rounded-lg mb-6">
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div className="space-y-4">
                            <h3 className="font-medium text-lg">Server Configuration</h3>

                            <div>
                                <Label htmlFor="domain">Domain</Label>
                                <Input
                                    id="domain"
                                    value={domain}
                                    onChange={(e) => setDomain(e.target.value)}
                                    placeholder="eigen.example.com"
                                    required
                                    readOnly={domainFromEnv}
                                    className="mt-1.5"
                                />
                                <p className="text-xs text-muted-foreground mt-1">
                                    {domainFromEnv
                                        ? 'Set via DOMAIN environment variable'
                                        : 'The domain where Eigen will be accessible'}
                                </p>
                            </div>

                            <div>
                                <Label htmlFor="orgName">Organization Name</Label>
                                <Input
                                    id="orgName"
                                    value={orgName}
                                    onChange={(e) => setOrgName(e.target.value)}
                                    placeholder="My Organization"
                                    required
                                    className="mt-1.5"
                                />
                            </div>

                            <StorageTypePicker
                                storageType={storageType}
                                onStorageTypeChange={setStorageType}
                                s3Config={s3Config}
                                onS3ConfigChange={setS3Config}
                                checkS3={checkS3ViaSetup}
                                onS3Verified={onS3Verified}
                            />
                        </div>

                        <div className="space-y-4 pt-6 border-t">
                            <h3 className="font-medium text-lg">Admin Account</h3>

                            <div>
                                <Label htmlFor="adminName">Full Name</Label>
                                <Input
                                    id="adminName"
                                    value={adminName}
                                    onChange={(e) => setAdminName(e.target.value)}
                                    required
                                    className="mt-1.5"
                                />
                            </div>

                            <div>
                                <Label htmlFor="adminUsername">Username</Label>
                                <InputGroup className="mt-1.5">
                                    <InputGroupInput
                                        id="adminUsername"
                                        value={adminUsername}
                                        onChange={(e) => setAdminUsername(e.target.value)}
                                        placeholder="admin"
                                        required
                                    />
                                    <InputGroupAddon align="inline-end">
                                        <InputGroupText>@{effectiveMailDomain}</InputGroupText>
                                    </InputGroupAddon>
                                </InputGroup>
                            </div>

                            <div>
                                <Label htmlFor="adminPassword">Password</Label>
                                <Input
                                    id="adminPassword"
                                    type="password"
                                    value={adminPassword}
                                    onChange={(e) => setAdminPassword(e.target.value)}
                                    minLength={8}
                                    required
                                    className="mt-1.5"
                                />
                                <p className="text-xs text-muted-foreground mt-1">At least 8 characters</p>
                            </div>
                        </div>

                        <Button type="submit" disabled={!formReady || loading} className="w-full">
                            {loading ? 'Setting up...' : 'Complete Setup'}
                        </Button>
                    </form>
                </CardContent>
            </Card>
        </div>
    );
}
