import type { ReactNode } from 'react'
import { Toast } from '@heroui/react'
import { placements, queues } from '@/utils/toast'

export function ToastProvider({ children }: { children?: ReactNode }) {
  return (
    <>
      {placements.map(p => (
        <Toast.Provider
          key={p}
          placement={p}
          queue={queues[p]}
        />
      ))}
      {children}
    </>
  )
}
