import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { checkSetupRequired } from '@workspace/lib/admin'

export const Route = createFileRoute('/')({
  component: AdminDashboard,
})

function AdminDashboard() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    checkSetupRequired().then((setupStatus) => {
      if (setupStatus?.setupRequired) {
        navigate({ to: '/setup' })
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [navigate])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div>Loading...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="max-w-4xl w-full p-8">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          Eigen Admin
        </h1>
        <p className="text-gray-600 mb-8">
          Welcome to the Eigen administration panel.
        </p>
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold mb-4">Quick Actions</h2>
          <p className="text-gray-600">
            User management and other admin features will be available here.
          </p>
        </div>
      </div>
    </div>
  )
}
