// Живёт в «главном мире» вкладки Telegram Web, рядом с его собственным кодом.
//
// Видео Telegram отдаёт плееру через свой service worker, и читать такие
// адреса надёжнее всего ровно оттуда, откуда их читает сам плеер. Контент-
// скрипт Downy просит кусок — мы приносим следующий мегабайт и ждём, пока
// попросят ещё. Наружу ничего не уходит: только в соседний контент-скрипт.

import { PAGE_CHUNK_BYTES, parseContentRange } from './lib/telegram';

interface Req {
  __downy: 'tg-req';
  id: string;
  cmd: 'open' | 'next' | 'close';
  url?: string;
  offset?: number;
}

interface Reader {
  url: string;
  offset: number;
  total?: number;
  blob?: Blob;
  body?: ReadableStreamDefaultReader<Uint8Array>;
  /** Сервер отдал файл целиком, хотя просили с середины — столько надо пропустить */
  skip: number;
  left?: Uint8Array;
}

const readers = new Map<string, Reader>();

function reply(id: string, data: Record<string, unknown>, transfer: Transferable[] = []): void {
  window.postMessage({ __downy: 'tg-res', id, ...data }, location.origin, transfer);
}

async function openBody(r: Reader): Promise<void> {
  const resp = await fetch(r.url, { headers: { Range: `bytes=${r.offset}-` } });
  if (!resp.ok) throw new Error(`Telegram не отдал файл: HTTP ${resp.status}`);
  if (!resp.body) throw new Error('Telegram отдал пустой ответ');
  if (resp.status === 206) {
    const range = parseContentRange(resp.headers.get('content-range'));
    if (range?.total) r.total = range.total;
    r.skip = range && range.start < r.offset ? r.offset - range.start : 0;
  } else {
    // Range проигнорировали — весь файл с начала, лишнее выбросим
    const len = Number(resp.headers.get('content-length'));
    if (len > 0) r.total = len;
    r.skip = r.offset;
  }
  r.body = resp.body.getReader();
}

/** Следующий кусок до PAGE_CHUNK_BYTES; пустой — файл кончился */
async function nextPiece(r: Reader): Promise<Uint8Array> {
  if (r.url.startsWith('blob:')) {
    if (!r.blob) {
      const resp = await fetch(r.url).catch(() => null);
      if (!resp?.ok) throw new Error('Файл пропал из вкладки — кликни по нему прицелом ещё раз');
      r.blob = await resp.blob();
      r.total = r.blob.size;
    }
    return new Uint8Array(await r.blob.slice(r.offset, r.offset + PAGE_CHUNK_BYTES).arrayBuffer());
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  let empty = 0;
  if (r.left) {
    parts.push(r.left);
    size = r.left.length;
    r.left = undefined;
  }
  while (size < PAGE_CHUNK_BYTES) {
    if (r.total != null && r.offset + size >= r.total) break;
    if (!r.body) await openBody(r);
    const { done, value } = await r.body!.read();
    if (done) {
      r.body = undefined;
      // Service worker отдаёт файл ломтями: ответ кончился, а файл нет —
      // просим продолжение. Размер неизвестен — значит, это и был конец
      if (r.total == null || r.offset + size >= r.total) break;
      if (size > 0) break; // отдадим накопленное, следующий запрос — с нового места
      // Пустой ответ посреди файла раз за разом — дальше Telegram не отдаёт
      if (++empty >= 3) throw new Error('Telegram перестал отдавать файл на середине');
      continue;
    }
    let chunk = value;
    if (r.skip > 0) {
      const cut = Math.min(r.skip, chunk.length);
      r.skip -= cut;
      chunk = chunk.subarray(cut);
      if (!chunk.length) continue;
    }
    parts.push(chunk);
    size += chunk.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  if (size > PAGE_CHUNK_BYTES) {
    r.left = out.slice(PAGE_CHUNK_BYTES);
    return out.slice(0, PAGE_CHUNK_BYTES);
  }
  return out;
}

async function serve(id: string): Promise<void> {
  const r = readers.get(id);
  if (!r) return;
  try {
    const piece = await nextPiece(r);
    if (!readers.has(id)) return;
    if (piece.length === 0) {
      readers.delete(id);
      reply(id, { done: true, total: r.total });
      return;
    }
    const offset = r.offset;
    r.offset += piece.length;
    const buf = piece.buffer as ArrayBuffer;
    reply(id, { piece: buf, offset, total: r.total }, [buf]);
  } catch (e) {
    readers.delete(id);
    void r.body?.cancel().catch(() => {});
    reply(id, { error: e instanceof Error ? e.message : String(e) });
  }
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  const msg = e.data as Req;
  if (msg?.__downy !== 'tg-req' || typeof msg.id !== 'string') return;
  if (msg.cmd === 'open' && msg.url) {
    readers.set(msg.id, { url: msg.url, offset: msg.offset ?? 0, skip: 0 });
    void serve(msg.id);
  } else if (msg.cmd === 'next') {
    void serve(msg.id);
  } else if (msg.cmd === 'close') {
    const r = readers.get(msg.id);
    readers.delete(msg.id);
    void r?.body?.cancel().catch(() => {});
  }
});
