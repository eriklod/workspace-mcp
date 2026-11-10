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

/** Actions that take a time RANGE (`timeMin`/`timeMax`) rather than an event's own start/end. */
const RANGE_ACTIONS: ReadonlySet<string> = new Set(['listEvents', 'findFreeTime'])

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

/**
 * Range bounds for listEvents/findFreeTime must be RFC 3339 date-times.
 * A bare YYYY-MM-DD is widened to midnight UTC so callers can pass dates.
 */
function normalizeRangeBound(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00:00Z`
  return trimmed
}

export const calendar = (input: DomainRunInput) => {
  const normalized: DomainRunInput = { ...input }
  if (RANGE_ACTIONS.has(String(input.action))) {
    // `start`/`end` were silently wrapped into event objects here and then
    // ignored by the service, so listEvents always returned its 30-day default.
    if ('start' in normalized) {
      if (normalized.timeMin === undefined) normalized.timeMin = normalizeRangeBound(normalized.start)
      delete normalized.start
    }
    if ('end' in normalized) {
      if (normalized.timeMax === undefined) normalized.timeMax = normalizeRangeBound(normalized.end)
      delete normalized.end
    }
    if ('timeMin' in normalized) normalized.timeMin = normalizeRangeBound(normalized.timeMin)
    if ('timeMax' in normalized) normalized.timeMax = normalizeRangeBound(normalized.timeMax)
    return baseRun(normalized)
  }
  if ('start' in normalized) normalized.start = normalizeEventTime(normalized.start)
  if ('end' in normalized) normalized.end = normalizeEventTime(normalized.end)
  return baseRun(normalized)
}
