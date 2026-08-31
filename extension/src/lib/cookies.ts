/**
 * Когда имеет смысл повторить загрузку с куками. Сам формат кук общий для
 * расширения и хоста и живёт в shared/cookies.
 */

/**
 * Отказ, который лечится входом на сайт. Только по такому поводу стоит
 * повторять загрузку с куками: гонять сессию на каждый таймаут или опечатку
 * в адресе — значит раздавать её сайтам, которые о ней не просили.
 */
const AUTH_FAILURE = [
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

export function looksLikeAuthFailure(message?: string): boolean {
  if (!message) return false;
  return AUTH_FAILURE.some((re) => re.test(message));
}

/**
 * Что сказать человеку вместо английской ругани качалки. Сайт отказал по
 * входу — значит либо тумблер выключен и о нём никто не знает, либо cookies
 * уже уехали и не помогли. Разные беды, разные ответы; во всех остальных
 * случаях молчим, чтобы не приплетать cookies к обычной сетевой поломке.
 */
export function authFailureHint(o: { message?: string; cookiesOn: boolean; cookiesTried?: boolean }): string | null {
  if (!looksLikeAuthFailure(o.message)) return null;
  if (!o.cookiesOn) return 'Сайт отдаёт файл только своим. Включите cookies в настройках расширения.';
  // Тумблер включён, но повтор ещё впереди — вот-вот сходим с cookies сами
  if (!o.cookiesTried) return null;
  return 'Сайт не пустил даже с вашими cookies — проверьте, вошли ли вы на нём в браузере.';
}
