// Прогрессбар и ETA для консольной загрузки бинарников (fetch-bins).
// Чистые функции — покрыты тестами; рисование строки живёт в fetch-bins.mjs.

/** «12.3 МБ» / «1.4 ГБ» / «870 КБ»; ноль и мусор — пустая строка */
export function fmtSize(bytes) {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} ГБ`;
  if (mb >= 1) return `${mb.toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** «2.1 МБ/с»; неизвестную или совсем мелкую скорость не показываем */
export function fmtSpeed(bps) {
  if (!bps || bps < 1024) return '';
  return `${fmtSize(bps)}/с`;
}

/** «05:06» / «1:05:06»; нет данных или явное враньё — пустая строка */
export function fmtEta(sec) {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.max(1, Math.round(sec));
  if (s > 100 * 3600) return ''; // оценка на сотни часов — не позоримся
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sc = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sc)}` : `${pad(m)}:${pad(sc)}`;
}

/** Шкала из блоков: «████████░░░░░░░░»; долю зажимаем в 0..1 */
export function renderBar(fraction, width = 24) {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(f * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Вес свежего замера в EMA скорости: выше — живее, ниже — ровнее */
const ALPHA = 0.3;

/**
 * Новый трек скорости по свежему замеру (байты, время в мс).
 * Откат байтов — начинаем заново; замер в тот же миг — держим прежнюю оценку.
 */
export function nextSpeed(prev, bytes, at) {
  if (!prev || bytes < prev.bytes) return { bytes, at };
  const dtMs = at - prev.at;
  if (dtMs <= 0) return prev.bytes === bytes ? prev : { ...prev, bytes };
  const inst = ((bytes - prev.bytes) * 1000) / dtMs;
  const bps = prev.bps == null ? inst : prev.bps + ALPHA * (inst - prev.bps);
  return { bytes, at, bps };
}

/**
 * Строка прогресса без управляющих символов.
 * total>0 — процент, шкала и ETA; иначе только скачанный объём и скорость.
 */
export function renderLine({ name, downloaded, total, speedBps, barWidth = 24 }) {
  const speed = fmtSpeed(speedBps);
  if (total && total > 0) {
    const ratio = Math.min(1, downloaded / total);
    const parts = [
      name,
      `[${renderBar(ratio, barWidth)}]`,
      `${String(Math.round(ratio * 100)).padStart(3)}%`,
      `${fmtSize(downloaded)} / ${fmtSize(total)}`,
    ];
    if (speed) parts.push(speed);
    const eta = speedBps ? fmtEta((total - downloaded) / speedBps) : '';
    if (eta) parts.push(`осталось ${eta}`);
    return parts.join('  ');
  }
  // Размер неизвестен — без бара и ETA не соврём
  const parts = [name, fmtSize(downloaded) || '0 КБ'];
  if (speed) parts.push(speed);
  return parts.join('  ');
}
