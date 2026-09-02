export const now = (): string => new Date().toISOString();
export const asIsoTime = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date');
  return date.toISOString();
};
