import {useEffect, useState} from 'react'
import {Button} from '@workspace/ui/components/button'
import {Input} from '@workspace/ui/components/input'
import {Label} from '@workspace/ui/components/label'
import {RadioGroup, RadioGroupItem} from '@workspace/ui/components/radio-group'
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@workspace/ui/components/card'
import {setupApi} from '@workspace/lib/core/api'

type StorageType = 'local-id' | 'local-fullnames' | 's3'

interface SetupData {
    domain: string
    orgName: string
    storageType: StorageType
    s3Bucket: string
    s3Region: string
    s3AccessKeyId: string
    s3SecretAccessKey: string
    s3Endpoint: string
    adminUsername: string
    adminPassword: string
    adminName: string
}

async function checkSetupStatus() {
    const res = await setupApi.status.get()
    return res.data as { setupRequired: boolean; domain?: string }
}

async function completeSetup(data: SetupData) {
    const res = await setupApi.complete.post({
        ...data,
        adminEmail: `${data.adminUsername}@${data.domain}`
    })
    return res.data as { success: boolean; error?: string; message?: string }
}

export function SetupWizard() {
    const [step, setStep] = useState<'loading' | 'config' | 'complete' | 'already-setup'>('loading')
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)

    const [formData, setFormData] = useState<SetupData>({
        domain: 'eigen.is',
        orgName: 'Eigen',
        storageType: 'local-fullnames',
        s3Bucket: '',
        s3Region: '',
        s3AccessKeyId: '',
        s3SecretAccessKey: '',
        s3Endpoint: '',
        adminUsername: '',
        adminPassword: '',
        adminName: ''
    })

    useEffect(() => {
        checkSetupStatus().then((status) => {
            if (!status.setupRequired) {
                setStep('already-setup')
            } else {
                setStep('config')
            }
        }).catch(() => {
            setError('Failed to connect to server')
            setStep('config')
        })
    }, [])

    const updateField = (field: keyof SetupData) => (e: React.ChangeEvent<HTMLInputElement>) => {
        setFormData(prev => ({...prev, [field]: e.target.value}))
    }

    const handleStorageTypeChange = (value: string) => {
        setFormData(prev => ({...prev, storageType: value as StorageType}))
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError(null)

        try {
            const result = await completeSetup(formData)
            if (result.success) {
                setStep('complete')
            } else {
                setError(result.error || 'Setup failed')
            }
        } catch (err) {
            setError('Network error. Please try again.')
        } finally {
            setLoading(false)
        }
    }

    if (step === 'loading') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background">
                <div className="text-muted-foreground">Loading...</div>
            </div>
        )
    }

    if (step === 'already-setup') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background p-4">
                <Card className="w-full max-w-md">
                    <CardHeader className="text-center">
                        <CardTitle className="text-2xl">Already Configured</CardTitle>
                        <CardDescription>
                            Eigen has already been set up. Please proceed to login.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Button className="w-full" onClick={() => window.location.href = '/'}>
                            Go to Login
                        </Button>
                    </CardContent>
                </Card>
            </div>
        )
    }

    if (step === 'complete') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background p-4">
                <Card className="w-full max-w-md">
                    <CardHeader className="text-center">
                        <div
                            className="mx-auto w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mb-4">
                            <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24"
                                 stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
                            </svg>
                        </div>
                        <CardTitle className="text-2xl">Setup Complete!</CardTitle>
                        <CardDescription>
                            Eigen has been configured successfully. You can now log in with your admin account.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Button className="w-full" onClick={() => window.location.href = '/'}>
                            Go to Login
                        </Button>
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4">
            <Card className="w-full max-w-lg">
                <CardHeader className="text-center">
                    <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                        <span className="text-2xl font-bold text-primary">E</span>
                    </div>
                    <CardTitle className="text-2xl">Welcome to Eigen</CardTitle>
                    <CardDescription>
                        Let's configure your instance
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {error && (
                        <div
                            className="bg-destructive/10 border border-destructive/20 text-destructive px-4 py-3 rounded-lg mb-6">
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div className="space-y-4">
                            <h3 className="font-semibold text-lg">Server Configuration</h3>

                            <div>
                                <Label htmlFor="domain">Domain</Label>
                                <Input
                                    id="domain"
                                    value={formData.domain}
                                    onChange={updateField('domain')}
                                    placeholder="eigen.example.com"
                                    required
                                    className="mt-1.5"
                                />
                                <p className="text-xs text-muted-foreground mt-1">
                                    The domain where Eigen will be accessible
                                </p>
                            </div>

                            <div>
                                <Label htmlFor="orgName">Organization Name</Label>
                                <Input
                                    id="orgName"
                                    value={formData.orgName}
                                    onChange={updateField('orgName')}
                                    placeholder="Eigen"
                                    required
                                    className="mt-1.5"
                                />
                                <p className="text-xs text-muted-foreground mt-1">
                                    The name of your organization
                                </p>
                            </div>

                            <div>
                                <Label className="text-base">Storage Type</Label>
                                <RadioGroup
                                    value={formData.storageType}
                                    onValueChange={handleStorageTypeChange}
                                    className="mt-3 space-y-2"
                                >
                                    <div className="flex items-start space-x-3">
                                        <RadioGroupItem value="local-id" id="local-id" className="mt-1"/>
                                        <Label htmlFor="local-id" className="flex-1 cursor-pointer font-normal">
                                            <div className="font-medium">Local storage (ID-based)</div>
                                            <p className="text-sm text-muted-foreground">
                                                Files stored with unique IDs.
                                            </p>
                                        </Label>
                                    </div>

                                    <div className="flex items-start space-x-3">
                                        <RadioGroupItem value="local-fullnames" id="local-fullnames" className="mt-1"/>
                                        <Label htmlFor="local-fullnames" className="flex-1 cursor-pointer font-normal">
                                            <div className="font-medium">Local storage (full names)</div>
                                            <p className="text-sm text-muted-foreground">
                                                Recommended. Files stored with original filenames.
                                            </p>
                                        </Label>
                                    </div>

                                    <div className="flex items-start space-x-3">
                                        <RadioGroupItem value="s3" id="s3" className="mt-1"/>
                                        <Label htmlFor="s3" className="flex-1 cursor-pointer font-normal">
                                            <div className="font-medium">S3-compatible storage</div>
                                            <p className="text-sm text-muted-foreground">
                                                Use Amazon S3 or compatible object storage.
                                            </p>
                                        </Label>
                                    </div>
                                </RadioGroup>
                            </div>

                            {formData.storageType === 's3' && (
                                <div className="space-y-4 pt-4 border-t">
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <Label htmlFor="s3Bucket">Bucket Name</Label>
                                            <Input
                                                id="s3Bucket"
                                                value={formData.s3Bucket}
                                                onChange={updateField('s3Bucket')}
                                                required
                                                className="mt-1.5"
                                            />
                                        </div>
                                        <div>
                                            <Label htmlFor="s3Region">Region</Label>
                                            <Input
                                                id="s3Region"
                                                value={formData.s3Region}
                                                onChange={updateField('s3Region')}
                                                placeholder="us-east-1"
                                                required
                                                className="mt-1.5"
                                            />
                                        </div>
                                    </div>
                                    <div>
                                        <Label htmlFor="s3AccessKeyId">Access Key ID</Label>
                                        <Input
                                            id="s3AccessKeyId"
                                            value={formData.s3AccessKeyId}
                                            onChange={updateField('s3AccessKeyId')}
                                            required
                                            className="mt-1.5"
                                        />
                                    </div>
                                    <div>
                                        <Label htmlFor="s3SecretAccessKey">Secret Access Key</Label>
                                        <Input
                                            id="s3SecretAccessKey"
                                            type="password"
                                            value={formData.s3SecretAccessKey}
                                            onChange={updateField('s3SecretAccessKey')}
                                            required
                                            className="mt-1.5"
                                        />
                                    </div>
                                    <div>
                                        <Label htmlFor="s3Endpoint">Endpoint URL (optional)</Label>
                                        <Input
                                            id="s3Endpoint"
                                            value={formData.s3Endpoint}
                                            onChange={updateField('s3Endpoint')}
                                            placeholder="https://s3.amazonaws.com"
                                            className="mt-1.5"
                                        />
                                        <p className="text-xs text-muted-foreground mt-1">
                                            Leave empty for AWS S3
                                        </p>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="space-y-4 pt-6 border-t">
                            <h3 className="font-semibold text-lg">Admin Account</h3>

                            <div>
                                <Label htmlFor="adminName">Full Name</Label>
                                <Input
                                    id="adminName"
                                    value={formData.adminName}
                                    onChange={updateField('adminName')}
                                    required
                                    className="mt-1.5"
                                />
                            </div>

                            <div>
                                <Label htmlFor="adminUsername">Username</Label>
                                <div className="mt-1.5 flex">
                                    <Input
                                        id="adminUsername"
                                        value={formData.adminUsername}
                                        onChange={updateField('adminUsername')}
                                        placeholder="admin"
                                        required
                                        className="rounded-r-none"
                                    />
                                    <span
                                        className="inline-flex items-center px-3 rounded-r-md border border-l-0 border-input bg-muted text-muted-foreground text-sm">
                                        @{formData.domain}
                                    </span>
                                </div>
                            </div>

                            <div>
                                <Label htmlFor="adminPassword">Password</Label>
                                <Input
                                    id="adminPassword"
                                    type="password"
                                    value={formData.adminPassword}
                                    onChange={updateField('adminPassword')}
                                    minLength={8}
                                    required
                                    className="mt-1.5"
                                />
                                <p className="text-xs text-muted-foreground mt-1">
                                    At least 8 characters
                                </p>
                            </div>
                        </div>

                        <Button type="submit" disabled={loading} className="w-full">
                            {loading ? 'Setting up...' : 'Complete Setup'}
                        </Button>
                    </form>
                </CardContent>
            </Card>
        </div>
    )
}
