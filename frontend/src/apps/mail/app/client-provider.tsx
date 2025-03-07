'use client'

import { usePathname } from 'next/navigation'
import { createContext, useContext, useState, useEffect } from 'react'

type RouterContextType = {
  currentRoute: string
  navigate: (path: string) => void
}

const RouterContext = createContext<RouterContextType>({
  currentRoute: '/',
  navigate: () => {}
})

export const useClientRouter = () => useContext(RouterContext)

export default function ClientProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [currentRoute, setCurrentRoute] = useState(pathname)
  
  useEffect(() => {
    setCurrentRoute(pathname)
  }, [pathname])
  
  const navigate = (path: string) => {
    window.history.pushState({}, '', path)
    setCurrentRoute(path)
  }
  
  return (
    <RouterContext.Provider value={{ currentRoute, navigate }}>
      {children}
    </RouterContext.Provider>
  )
}
