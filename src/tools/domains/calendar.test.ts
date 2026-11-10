import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { listEventsMock, findFreeTimeMock, createEventMock, mockMethods } = vi.hoisted(() => {
  const listEventsMock = vi.fn()
  const findFreeTimeMock = vi.fn()
  const createEventMock = vi.fn()
  return {
    listEventsMock,
    findFreeTimeMock,
    createEventMock,
    mockMethods: { listEvents: listEventsMock, findFreeTime: findFreeTimeMock, createEvent: createEventMock }
  }
})

vi.mock('../../vendored/services/CalendarService.js', () => ({
  CalendarService: vi.fn().mockImplementation(function CalendarServiceMock() {
    return mockMethods
  })
}))

import { calendar } from './calendar.js'

const ok = { content: [{ type: 'text', text: 'ok' }] }

describe('calendar mega-tool time normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listEventsMock.mockResolvedValue(ok)
    findFreeTimeMock.mockResolvedValue(ok)
    createEventMock.mockResolvedValue(ok)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('wraps start/end into Google event objects for createEvent', async () => {
    await calendar({ action: 'createEvent', summary: 'x', start: '2026-11-13T09:00:00+01:00', end: '2026-11-14' })

    expect(createEventMock).toHaveBeenCalledWith({
      summary: 'x',
      start: { dateTime: '2026-11-13T09:00:00+01:00' },
      end: { date: '2026-11-14' }
    })
  })

  it('maps start/end to timeMin/timeMax for listEvents instead of wrapping them', async () => {
    await calendar({ action: 'listEvents', calendarId: 'c', start: '2026-11-10T00:00:00+01:00', end: '2026-11-18' })

    expect(listEventsMock).toHaveBeenCalledWith({
      calendarId: 'c',
      timeMin: '2026-11-10T00:00:00+01:00',
      timeMax: '2026-11-18T00:00:00Z'
    })
  })

  it('leaves an explicit timeMin/timeMax alone and drops a conflicting start/end', async () => {
    await calendar({
      action: 'listEvents',
      start: '2026-01-01',
      timeMin: '2026-11-10T00:00:00Z',
      timeMax: '2026-11-11T00:00:00Z'
    })

    expect(listEventsMock).toHaveBeenCalledWith({ timeMin: '2026-11-10T00:00:00Z', timeMax: '2026-11-11T00:00:00Z' })
  })

  it('applies the same range mapping to findFreeTime', async () => {
    await calendar({ action: 'findFreeTime', attendees: ['a@x'], duration: 30, start: '2026-11-10', end: '2026-11-11' })

    expect(findFreeTimeMock).toHaveBeenCalledWith({
      attendees: ['a@x'],
      duration: 30,
      timeMin: '2026-11-10T00:00:00Z',
      timeMax: '2026-11-11T00:00:00Z'
    })
  })
})
