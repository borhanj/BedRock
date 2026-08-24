import { createContext, useContext } from 'react'

/**
 * The treasurer's PIN, for the length of a browser session.
 *
 * Held in a React ref and nowhere else. Deliberately NOT in localStorage,
 * sessionStorage, a cookie or the URL: the point of §4 is that walking away
 * from a shared machine should not leave donor names reachable, and anything
 * persisted survives exactly that. Closing the tab forgets it.
 *
 * It travels in the request body on the few routes that need donor detail.
 * Behind Cloudflare Access over HTTPS that is the same exposure as any
 * password, and the alternative — a server-side session holding the derived
 * key — needs state a Worker does not have.
 */
export interface VaultSession {
  readonly pin: string | null
  readonly unlocked: boolean
  unlock(pin: string): void
  lock(): void
}

export const VaultContext = createContext<VaultSession>({
  pin: null,
  unlocked: false,
  unlock: () => {},
  lock: () => {},
})

export function useVault(): VaultSession {
  return useContext(VaultContext)
}
