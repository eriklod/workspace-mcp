import { CalendarService } from '../../vendored/services/CalendarService.js'
import { type DomainRunInput, makeDomainRun } from './factory.js'

export const CALENDAR_ACTIONS = [
  'listCalendars',
  'createEvent',
  'listEvents',
  'getEvent',
  'deleteEvent',
  'updateEvent',
  'respondToEvent',
  'findFreeTime'
] as const

const baseRun = makeDomainRun(CalendarService, CALENDAR_ACTIONS)

/**
 * The tool schema exposes `start`/`end` as plain strings, but the vendored
 * CalendarService (and its validation) expects Google's shape:
 * `{ dateTime }` for timed events or `{ date }` for all-day events.
 * Accept both: a bare ISO string is wrapped, an object is passed through.
 */
function normalizeEventTime(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { date: trimmed }
  return { dateTime: trimmed }
}

export const calendar = (input: DomainRunInput) => {
  const normalized: DomainRunInput = { ...input }
  if ('start' in normalized) normalized.start = normalizeEventTime(normalized.start)
  if ('end' in normalized) normalized.end = normalizeEventTime(normalized.end)
  return baseRun(normalized)
}
