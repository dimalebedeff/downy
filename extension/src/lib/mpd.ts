// Лёгкий разбор DASH-манифестов (.mpd). Полный XML-парсинг не нужен:
// скачивает yt-dlp, нам достаточно опознать манифест и вытащить длительность.

/** Похож ли текст на DASH-манифест */
export function looksLikeMpd(text: string): boolean {
  return /<MPD[\s>]/.test(text.slice(0, 2000));
}

/**
 * Длительность из mediaPresentationDuration (ISO 8601, например PT1H2M3.5S)
 * в секундах; null для live-манифестов без длительности.
 */
export function mpdDuration(text: string): number | null {
  const m = text.match(/mediaPresentationDuration="P(?:[\d.]+Y)?(?:[\d.]+M)?(?:[\d.]+D)?T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?"/);
  if (!m) return null;
  const sec = (parseFloat(m[1] ?? '0') * 3600) + (parseFloat(m[2] ?? '0') * 60) + parseFloat(m[3] ?? '0');
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

/**
 * Манифест объявляет защиту контента. Сегменты зашифрованы ключом от
 * лицензионного сервера (Widevine, PlayReady, FairPlay): скачать их можно,
 * посмотреть — нет. Обещать такую загрузку — значит отдать человеку файл
 * с шумом внутри и отрапортовать «готово».
 */
export function isProtectedMpd(text: string): boolean {
  return /<ContentProtection[\s>]/.test(text);
}

/** Эфир: динамический манифест дописывается по ходу трансляции */
export function isLiveMpd(text: string): boolean {
  return /<MPD[^>]*\stype="dynamic"/.test(text.slice(0, 2000));
}
