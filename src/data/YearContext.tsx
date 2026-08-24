import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { YearView } from '../shared/types'
import { fetchCurrentYear } from './api'

/**
 * The current Baháʼí year, fetched once and shared.
 *
 * The app shell, the dashboard and the Feast report all need the Assembly's
 * name and the year's totals; fetching in each would mean three round trips
 * that could disagree with one another mid-render.
 */

export type YearState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; year: YearView }

const YearContext = createContext<YearState>({ status: 'loading' })

export function YearProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<YearState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    fetchCurrentYear()
      .then((year) => {
        if (!cancelled) setState({ status: 'ready', year })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return <YearContext.Provider value={state}>{children}</YearContext.Provider>
}

export function useYearState(): YearState {
  return useContext(YearContext)
}

/**
 * The loaded year. Throws if called outside a ready state, so a component that
 * needs the data cannot silently render an empty ledger.
 */
export function useYear(): YearView {
  const state = useContext(YearContext)
  if (state.status !== 'ready') {
    throw new Error('useYear() requires a loaded year; render inside <RequireYear>.')
  }
  return state.year
}
