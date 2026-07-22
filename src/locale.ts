export type AppLanguage = 'en' | 'sv'

export function languageFromAcceptLanguage(value: string | undefined): AppLanguage {
  return value?.toLowerCase().split(',').some((part) => part.trim().startsWith('sv')) ? 'sv' : 'en'
}
