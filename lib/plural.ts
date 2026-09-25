/** "1 person" / "2 people" — plural defaults to singular + "s" (e.g. "fact" → "facts"). */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}
