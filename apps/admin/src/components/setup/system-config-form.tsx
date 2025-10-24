import {useState} from 'react'
import {configureSystem} from '@workspace/lib/admin'
import {Button} from '@workspace/ui/components/button'
import {Input} from '@workspace/ui/components/input'
import {Label} from '@workspace/ui/components/label'
import {RadioGroup, RadioGroupItem} from '@workspace/ui/components/radio-group'

interface SystemConfigFormProps {
    onSuccess: () => void
    onError: (error: string) => void
}

type StorageType = 'local-fullnames' | 'local-id' | 's3'

export function SystemConfigForm({onSuccess, onError}: SystemConfigFormProps) {
    const [loading, setLoading] = useState(false)
    const [storageType, setStorageType] = useState<StorageType>('local-id')

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        setLoading(true)
        onError('')

        const formData = new FormData(e.currentTarget)
        const data: any = {storageType}

        if (storageType === 's3') {
            data.s3Bucket = formData.get('s3Bucket') as string
            data.s3Region = formData.get('s3Region') as string
            data.s3AccessKey = formData.get('s3AccessKey') as string
            data.s3SecretKey = formData.get('s3SecretKey') as string
            data.s3Endpoint = formData.get('s3Endpoint') as string
        }

        try {
            const result = await configureSystem(data)
            if (result?.success) {
                onSuccess()
            } else {
                onError(result?.error || 'Failed to configure storage')
            }
        } catch (err: any) {
            onError(err?.message || 'Network error. Please try again.')
        } finally {
            setLoading(false)
        }
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-4">
                <div>
                    <Label className="text-base font-semibold">Storage Type</Label>
                    <RadioGroup value={storageType} onValueChange={(value) => setStorageType(value as StorageType)}
                                className="mt-3">
                        <div className="flex items-start space-x-3">
                            <RadioGroupItem value="local-fullnames" id="local-fullnames" className="mt-1"/>
                            <Label htmlFor="local-fullnames" className="flex-1 cursor-pointer font-normal">
                                <div className="font-medium">Local storage (full names)</div>
                                <p className="text-sm text-muted-foreground mt-1">
                                    Files stored locally with original filenames
                                </p>
                            </Label>
                        </div>

                        <div className="flex items-start space-x-3">
                            <RadioGroupItem value="local-id" id="local-id" className="mt-1"/>
                            <Label htmlFor="local-id" className="flex-1 cursor-pointer font-normal">
                                <div className="font-medium">Local storage (ID-based)</div>
                                <p className="text-sm text-muted-foreground mt-1">
                                    Files stored locally with unique IDs (recommended)
                                </p>
                            </Label>
                        </div>

                        <div className="flex items-start space-x-3">
                            <RadioGroupItem value="s3" id="s3" className="mt-1"/>
                            <Label htmlFor="s3" className="flex-1 cursor-pointer font-normal">
                                <div className="font-medium">S3-compatible storage</div>
                                <p className="text-sm text-muted-foreground mt-1">
                                    Use Amazon S3 or compatible object storage
                                </p>
                            </Label>
                        </div>
                    </RadioGroup>
                </div>

                {storageType === 's3' && (
                    <div className="space-y-4 pt-4 border-t">
                        <div>
                            <Label htmlFor="s3Bucket">Bucket Name</Label>
                            <Input id="s3Bucket" name="s3Bucket" required className="mt-1.5"/>
                        </div>

                        <div>
                            <Label htmlFor="s3Region">Region</Label>
                            <Input id="s3Region" name="s3Region" required placeholder="us-east-1"
                                   className="mt-1.5"/>
                        </div>

                        <div>
                            <Label htmlFor="s3AccessKey">Access Key</Label>
                            <Input id="s3AccessKey" name="s3AccessKey" required className="mt-1.5"/>
                        </div>

                        <div>
                            <Label htmlFor="s3SecretKey">Secret Key</Label>
                            <Input id="s3SecretKey" name="s3SecretKey" type="password" required className="mt-1.5"/>
                        </div>

                        <div>
                            <Label htmlFor="s3Endpoint">Endpoint URL (optional)</Label>
                            <Input id="s3Endpoint" name="s3Endpoint" placeholder="https://s3.amazonaws.com"
                                   className="mt-1.5"/>
                            <p className="text-xs text-muted-foreground mt-1.5">
                                Leave empty for AWS S3, or provide custom endpoint for S3-compatible services
                            </p>
                        </div>
                    </div>
                )}
            </div>

            <Button type="submit" disabled={loading} className="w-full">
                {loading ? 'Configuring...' : 'Continue'}
            </Button>
        </form>
    )
}
