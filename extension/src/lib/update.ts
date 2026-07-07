// Проверка обновлений: сравнение версии расширения с тегом релиза на GitHub.

export const REPO = 'dimalebedeff/downy';

/** true, если тег релиза (v0.4, 0.4.1, …) строго новее текущей версии. */
export function isNewerVersion(current: string, tag: string): boolean {
  const parse = (s: string): number[] | null => {
    const clean = s.trim().replace(/^v/i, '');
    if (!/^\d+(\.\d+)*$/.test(clean)) return null;
    return clean.split('.').map(Number);
  };
  const cur = parse(current);
  const next = parse(tag);
  if (!cur || !next) return false;
  for (let i = 0; i < Math.max(cur.length, next.length); i++) {
    const a = cur[i] ?? 0;
    const b = next[i] ?? 0;
    if (a !== b) return b > a;
  }
  return false;
}
