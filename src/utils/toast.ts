import type { ToastVariants } from '@heroui/styles'
import type { HeroUIToastOptions } from 'node_modules/@heroui/react/dist/components/toast/toast-queue'
import { ToastQueue } from '@heroui/react'

export type Placement = NonNullable<ToastVariants['placement']>
export const placements = [
  'top start',
  'top',
  'top end',
  'bottom start',
  'bottom',
  'bottom end',
] as const

export const queues = Object.fromEntries(
  placements.map(p => [p, new ToastQueue({ maxVisibleToasts: 3 })]),
) as Record<Placement, ToastQueue>

const placementsKeys = new Map<string, Placement>()

export function toast(
  message: string,
  options: HeroUIToastOptions & { placement?: Placement },
) {
  const { placement = 'top', ...rest } = options
  const key = queues[placement].add({ title: message, ...rest })
  placementsKeys.set(key, placement)
  return key
}

function close(key: string) {
  const placement = placementsKeys.get(key)
  placementsKeys.delete(key)
  if (placement)
    queues[placement].close(key)
}

function clear() {
  placementsKeys.clear()
  placements.forEach(p => queues[p].clear())
}

toast.close = close
toast.clear = clear
