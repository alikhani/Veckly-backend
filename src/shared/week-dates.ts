export const orderedDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

export function addDays(yyyyMmDd: string, offset: number) {
  const date = new Date(`${yyyyMmDd}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

export function isMonday(yyyyMmDd: string) {
  return new Date(`${yyyyMmDd}T00:00:00.000Z`).getUTCDay() === 1
}

export function isDateInWeek(weekStartDate: string, date: string) {
  return date >= weekStartDate && date <= addDays(weekStartDate, 6)
}

export function isValidISODateString(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function requestToday(value: string | undefined) {
  return isValidISODateString(value) ? value : new Date().toISOString().slice(0, 10)
}

export function defaultTodayForWeek(weekStartDate: string) {
  const currentDate = requestToday(undefined)
  return currentDate >= weekStartDate && currentDate <= addDays(weekStartDate, 6)
    ? currentDate
    : weekStartDate
}

export function getIsoWeekIdentity(yyyyMmDd: string) {
  const date = new Date(`${yyyyMmDd}T00:00:00.000Z`)
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const weekYear = date.getUTCFullYear()
  const yearStart = new Date(Date.UTC(weekYear, 0, 1))
  const weekNumber = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return { weekNumber, weekYear }
}
