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

/**
 * Площадки, где качать можно, но только одним путём. Список в попапе там
 * пуст по устройству сайта, и без подсказки человек решит, что Downy сломан.
 */
const HINTS: Rule[] = [
  {
    // Медиа живут только во вкладке: сеть их не видит, видит прицел
    host: /(^|\.)web\.telegram\.org$/,
    why: 'В Telegram качаем прицелом: открой фото или видео, нажми Alt+Shift+D и кликни по нему. Работает и в каналах, где сохранение закрыто',
  },
];

/** Что сказать на пустом месте: почему нельзя или как можно. null — молчим. */
export function siteNote(pageUrl: string): string | null {
  const why = unsupportedReason(pageUrl);
  if (why) return why;
  try {
    const host = new URL(pageUrl).hostname.toLowerCase();
    return HINTS.find((r) => r.host.test(host))?.why ?? null;
  } catch {
    return null;
  }
}

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
