'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Nav from '@/components/Nav'
import { useSession } from '@/lib/useSession'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { status } = useSession()

  useEffect(() => {
    if (status === 'signed-out') router.replace('/')
  }, [status, router])

  if (status !== 'signed-in') return null

  return (
    <>
      <Nav />
      <main className="main">{children}</main>
    </>
  )
}
