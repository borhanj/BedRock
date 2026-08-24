import { useMemo, useState, type ReactNode } from 'react'
import { VaultContext } from './vault'

/**
 * Holds the PIN in component state for the session and nothing more.
 *
 * No effect writes it anywhere. See ./vault.ts for why persisting it would
 * defeat the point.
 */
export default function VaultProvider({ children }: { children: ReactNode }) {
  const [pin, setPin] = useState<string | null>(null)

  const value = useMemo(
    () => ({
      pin,
      unlocked: pin !== null,
      unlock: (next: string) => setPin(next),
      lock: () => setPin(null),
    }),
    [pin],
  )

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
}
