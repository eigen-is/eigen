import {createFileRoute, useNavigate} from '@tanstack/react-router'
import {useState, useEffect} from 'react'
import {checkSetupRequired} from '@workspace/lib/admin'
import {SystemConfigForm} from '../components/setup/system-config-form'
import {AdminUserForm} from '../components/setup/admin-user-form'

export const Route = createFileRoute('/setup')({
    component: SetupWizard,
})

function SetupWizard() {
    const navigate = useNavigate()
    const [step, setStep] = useState<'storage' | 'user'>('storage')
    const [isCheckingSetup, setIsCheckingSetup] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [shouldShowWizard, setShouldShowWizard] = useState(false)

    useEffect(() => {
        checkSetupRequired().then((setupStatus) => {
            if (!setupStatus?.setupRequired) {
                window.location.href = '/admin'
                return
            }

            if (!setupStatus.systemSetupRequired && setupStatus.userSetupRequired) {
                setStep('user')
            }
            setIsCheckingSetup(false)
            setShouldShowWizard(true)
        }).catch(() => {
            setError('Failed to check setup status')
            setIsCheckingSetup(false)
        })
    }, [navigate])

    const handleStorageSuccess = () => {
        setError(null)
        setStep('user')
    }

    const handleUserSuccess = () => {
        setError(null)
        window.location.href = '/admin'
    }

    const handleError = (err: string) => {
        setError(err)
    }

    if (isCheckingSetup || !shouldShowWizard) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="text-muted-foreground">Loading...</div>
            </div>
        )
    }

    return (
        <div className="min-h-screen flex items-center justify-center px-4 py-8">
            <div className="max-w-md w-full space-y-8">
                <div className="text-center">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-app/10 mb-4">
                        <div className="w-12 h-12 rounded-full bg-app flex items-center justify-center text-white text-xl font-bold">
                            {step === 'storage' ? '1' : '2'}
                        </div>
                    </div>
                    <h2 className="text-3xl font-extrabold">
                        {step === 'storage' ? 'Storage Configuration' : 'Create Admin User'}
                    </h2>
                    <p className="mt-2 text-sm text-muted-foreground">
                        {step === 'storage'
                            ? 'Choose how to store your files'
                            : 'Create your first admin user'}
                    </p>
                </div>

                {error && (
                    <div className="bg-destructive/10 border border-destructive/20 text-destructive px-4 py-3 rounded-lg">
                        {error}
                    </div>
                )}

                <div className="bg-card border rounded-lg p-6">
                    {step === 'storage' ? (
                        <SystemConfigForm onSuccess={handleStorageSuccess} onError={handleError}/>
                    ) : (
                        <AdminUserForm onSuccess={handleUserSuccess} onError={handleError}/>
                    )}
                </div>

                <div className="flex justify-center">
                    <div className="flex space-x-2">
                        <div className={`w-2 h-2 rounded-full ${step === 'storage' ? 'bg-app' : 'bg-muted'}`}/>
                        <div className={`w-2 h-2 rounded-full ${step === 'user' ? 'bg-app' : 'bg-muted'}`}/>
                    </div>
                </div>
            </div>
        </div>
    )
}
