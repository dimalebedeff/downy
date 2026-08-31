/**
 * Разбор ругани качалки на классы и перевод её на человеческий.
 *
 * Пока объяснялся только отказ по входу, всё остальное проваливалось молча:
 * качества не приезжали, а в списке висело бодрое «Лучшее», и система
 * выглядела здоровой. Двое суток такой тишины стоили дороже самой поломки —
 * о ней никто не знал, пока не полезли в лог руками.
 */

export type YtdlpErrorKind =
  | 'auth'
  | 'js-runtime'
  | 'rate-limit'
  | 'unsupported'
  | 'cli'
  | 'network'
  | 'unknown';

/** Отказ, который лечится входом на сайт */
const AUTH = [
  /login required/i,
  /log ?in to/i,
  /sign ?in to/i,
  /private (video|account)|video is private/i,
  /members[- ]only|subscriber/i,
  /age[- ]restricted|age[- ]verification/i,
  /rate[- ]limit reached/i,
  /not available.*(login|account)/i,
  /--cookies/i,
  /authentication/i,
  /HTTP Error 40[13]\b/i,
  /\b(401|403) (Unauthorized|Forbidden)\b/i,
];

/** Нет движка JavaScript — ютуб не отдаёт даже список качеств */
const JS_RUNTIME = [/javascript runtime/i, /needs to be reloaded/i, /\bEJS\b/, /challenge solver/i];

/** Сайт попросил сбавить обороты */
const RATE_LIMIT = [/HTTP Error 429\b/i, /too many requests/i];

/** Экстрактор не знает этот сайт или отстал от его вёрстки */
const UNSUPPORTED = [/unsupported url/i, /unable to extract/i, /no video formats found/i];

/** Мы сами передали качалке флаг, которого она не знает */
const CLI = [/no such option/i, /unrecognized arguments/i];

/** Не достучались */
const NETWORK = [/unable to download webpage/i, /timed out/i, /connection (reset|refused|aborted)/i, /getaddrinfo/i];

/**
 * Порядок проверок важен. Ютуб отдаёт 429 вместе с бот-чеком, но лечится это
 * входом, а не паузой, — поэтому вход старше частоты. А неизвестный флаг
 * старше всех: это не сайт сломался, это мы.
 */
export function classifyYtdlpError(message?: string): YtdlpErrorKind {
  if (!message) return 'unknown';
  const has = (list: RegExp[]): boolean => list.some((re) => re.test(message));
  if (has(CLI)) return 'cli';
  if (has(AUTH)) return 'auth';
  if (has(JS_RUNTIME)) return 'js-runtime';
  if (has(RATE_LIMIT)) return 'rate-limit';
  if (has(UNSUPPORTED)) return 'unsupported';
  if (has(NETWORK)) return 'network';
  return 'unknown';
}

/** Совместимость: решение о повторе с куками принимается по этому же разбору */
export function looksLikeAuthFailure(message?: string): boolean {
  return classifyYtdlpError(message) === 'auth';
}

/**
 * Что сказать человеку вместо английской ругани. Возвращает null там, где
 * сказать нечего: либо класс неизвестен и пересказывать нечего, либо мы
 * прямо сейчас сами всё исправим повтором с куками.
 */
export function explainYtdlpError(o: { message?: string; cookiesOn: boolean; cookiesTried?: boolean }): string | null {
  switch (classifyYtdlpError(o.message)) {
    case 'auth':
      if (!o.cookiesOn) return 'Сайт отдаёт файл только своим. Включите cookies в настройках расширения.';
      // Повтор с куками ещё впереди — сейчас сходим сами
      if (!o.cookiesTried) return null;
      return 'Сайт не пустил даже с вашими cookies — проверьте, вошли ли вы на нём в браузере.';
    case 'js-runtime':
      return 'Сайту нужен движок JavaScript, а Downy его не нашёл. Переустановите помощника через install.bat.';
    case 'rate-limit':
      return 'Сайт попросил сбавить обороты — слишком много запросов подряд. Подождите пару минут.';
    case 'unsupported':
      return 'Качалка не знает этот сайт или отстала от его вёрстки. Помогает обновление Downy.';
    case 'cli':
      return 'Downy передал качалке команду, которой та не знает. Это наша недоработка — помогает обновление.';
    case 'network':
      return 'До сайта не достучались. Проверьте связь и попробуйте ещё раз.';
    default:
      return null;
  }
}
