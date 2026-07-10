// Персистентное состояние бота: какие сообщения уже обработаны и как
// достучаться до чатов после рестарта (StringSession кэш пиров не хранит).
// Нужно, чтобы ссылки, присланные пока комп был выключен, не пропадали.

import fs from 'node:fs';

export interface PeerRef {
  type: 'user' | 'chat' | 'channel';
  id: string;
  accessHash?: string;
}

export interface BotState {
  peers: Record<string, PeerRef>;
  /** Последний обработанный message id по каждому чату */
  lastMsgId: Record<string, number>;
}

export function loadState(file: string): BotState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BotState>;
    return { peers: raw.peers ?? {}, lastMsgId: raw.lastMsgId ?? {} };
  } catch {
    return { peers: {}, lastMsgId: {} };
  }
}

export function saveState(file: string, state: BotState): void {
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch {
    // потеряем только backfill после рестарта — не смертельно
  }
}
