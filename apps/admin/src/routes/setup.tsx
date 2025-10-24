import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { checkSetupRequired } from '@workspace/lib/admin'
import { SystemConfigForm } from '../components/setup/system-config-form'
import { AdminUserForm } from '../components/setup/admin-user-form'

export const Route = createFileRoute('/setup')({
  component: SetupWizard,
})

function SetupWizard() {
  const navigate = useNavigate()
  const [step, setStep] = useState<'system' | 'user'>('system')
  const [isCheckingSetup, setIsCheckingSetup] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    checkSetupRequired().then((setupStatus) => {
      if (!setupStatus?.setupRequired) {
        navigate({ to: '/' })
        return
      }
      
      if (!setupStatus.systemSetupRequired && setupStatus.userSetupRequired) {
        setStep('user')
      }
      setIsCheckingSetup(false)
    }).catch(() => {
      setError('Failed to check setup status')
      setIsCheckingSetup(false)
    })
  }, [navigate])

  const handleSystemSuccess = () => {
    setSuccess('System configured successfully!')
    setError(null)
    setTimeout(() => {
      setSuccess(null)
      setStep('user')
    }, 1000)
  }

  const handleUserSuccess = () => {
    setSuccess('Admin user created successfully! Redirecting...')
    setError(null)
    setTimeout(() => navigate({ to: '/' }), 2000)
  }

  const handleError = (err: string) => {
    setError(err)
    setSuccess(null)
  }

  if (isCheckingSetup) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div>Loading...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <h2 className="text-3xl font-extrabold text-gray-900">
            {step === 'system' ? 'System Configuration' : 'Create Admin User'}
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            {step === 'system' 
              ? 'Configure your Eigen instance'
              : 'Create your first admin user to get started'}
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
            {error}
          </div>
        )}

        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded">
            {success}
          </div>
        )}

        {step === 'system' ? (
          <SystemConfigForm onSuccess={handleSystemSuccess} onError={handleError} />
        ) : (
          <AdminUserForm onSuccess={handleUserSuccess} onError={handleError} />
        )}
      </div>
    </div>
  )
}
