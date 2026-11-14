/** React context giving lane components access to the imperative timeline view. */
import { createContext, useContext } from 'react'
import type { TimelineView } from './view.ts'

export const TimelineViewContext = createContext<TimelineView | null>(null)

export const useTimelineView = (): TimelineView => {
  const view = useContext(TimelineViewContext)
  if (!view) throw new Error('Timeline components must be rendered inside <Timeline>')
  return view
}
