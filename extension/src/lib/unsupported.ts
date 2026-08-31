/**
 * Площадки, где Downy бессилен по устройству самого сайта, а не по недоделке.
 *
 * Молчать здесь хуже всего: прицел просто выключается по клику, попап пишет
 * «найти медиа не получилось», и человек думает, что расширение сломалось.
 * Раз уж помочь нечем, надо хотя бы сказать почему — одной строкой, без
 * технических подробностей, которые ничего не меняют.
 */

interface Rule {
  /** Домен целиком или его хвост: match идёт по границе точки */
  host: RegExp;
  why: string;
}

const RULES: Rule[] = [
  {
    host: /(^|\.)web\.whatsapp\.com$/,
    why: 'WhatsApp шифрует переписку целиком: файлы существуют только внутри вкладки, снаружи их не забрать',
  },
  {
    host: /(^|\.)web\.telegram\.org$/,
    why: 'Telegram Web качает медиа своим протоколом мимо браузера — перехватывать нечего',
  },
  {
    // Подписки с защитой контента: ключ выдаёт только их плеер
    host: /(^|\.)(netflix\.com|primevideo\.com|disneyplus\.com|hulu\.com|max\.com)$/,
    why: 'Кино под защитой: сегменты зашифрованы, а ключ сервис отдаёт только своему плееру',
  },
  {
    host: /(^|\.)(kinopoisk\.ru|okko\.tv|ivi\.ru|more\.tv|premier\.one|wink\.ru|start\.ru|kion\.ru)$/,
    why: 'Кино под защитой: сегменты зашифрованы, а ключ сервис отдаёт только своему плееру',
  },
  {
    host: /(^|\.)(open\.spotify\.com|music\.apple\.com|music\.yandex\.(ru|com|by|kz))$/,
    why: 'Стриминг музыки отдаёт треки только своему плееру — забрать файл неоткуда',
  },
];

/** Почему здесь ничего не выйдет. null — площадка обычная, работаем как всегда. */
export function unsupportedReason(pageUrl: string): string | null {
  let host: string;
  try {
    host = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  return RULES.find((r) => r.host.test(host))?.why ?? null;
}
