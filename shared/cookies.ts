/**
 * Формат кук, общий для расширения и хоста. Расширение забирает куки у
 * браузера, хост отдаёт их yt-dlp (файлом) или кладёт в заголовок прямого
 * запроса. Формат один, чтобы обе стороны понимали друг друга без оговорок.
 *
 * Всё, что здесь получается, равно входу на сайт. Поэтому набор кук собирает
 * расширение — ровно те, что браузер сам отправил бы на этот адрес, — а не
 * хост, который про домены знать не обязан.
 */

/** То, что нужно от chrome.cookies.Cookie — без привязки к типам браузера */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  /** Кука только своего хоста: поддоменам не достаётся */
  hostOnly: boolean;
  /** Живёт до закрытия браузера — срока у неё нет */
  session: boolean;
  expirationDate?: number;
}

const TSV_UNSAFE = /[\t\r\n]/;

/**
 * Файл в формате Netscape — его понимают yt-dlp, curl и wget. Поля разделены
 * табами: домен, отдавать ли поддоменам, путь, только по https, срок, имя,
 * значение.
 *
 * Куку с табом или переводом строки внутри выбрасываем целиком: в формате,
 * где строка — это запись, а таб — разделитель, такое значение дописало бы
 * в файл строки от себя. Возвращаем null, если писать нечего.
 */
export function toNetscapeCookieFile(cookies: BrowserCookie[]): string | null {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const c of cookies) {
    if (TSV_UNSAFE.test(c.name) || TSV_UNSAFE.test(c.value) || TSV_UNSAFE.test(c.domain) || TSV_UNSAFE.test(c.path)) {
      continue;
    }
    const key = `${c.domain} ${c.path} ${c.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const expires = c.session || c.expirationDate == null ? 0 : Math.floor(c.expirationDate);
    rows.push(
      [c.domain, c.hostOnly ? 'FALSE' : 'TRUE', c.path, c.secure ? 'TRUE' : 'FALSE', String(expires), c.name, c.value].join('\t'),
    );
  }
  if (rows.length === 0) return null;
  return ['# Netscape HTTP Cookie File', ...rows].join('\n');
}

/**
 * Тот же набор, но заголовком одного запроса. Домены здесь уже не различить,
 * поэтому такой файл расширение собирает под конкретный адрес — ровно те
 * куки, что браузер отправил бы туда сам.
 */
export function cookiesToHeader(netscape?: string): string | undefined {
  if (!netscape) return undefined;
  const pairs: string[] = [];
  for (const line of netscape.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    const [, , , , , name, value] = cols;
    if (!name) continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs.length ? pairs.join('; ') : undefined;
}
