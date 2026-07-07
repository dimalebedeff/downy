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
