// Конфиг бота: bot/config.json (в .gitignore, секреты в git не едут).

import fs from 'node:fs';

export interface BotConfig {
  /** my.telegram.org → API development tools */
  apiId: number;
  apiHash: string;
  /** Токен от @BotFather */
  botToken: string;
  /** Кому можно пользоваться ботом; пусто — режим первого контакта */
  allowedChatIds: number[];
  /** Дефолтная планка качества; нет — 1080 */
  maxHeight?: number;
}

export const CONFIG_EXAMPLE: BotConfig = {
  apiId: 0,
  apiHash: 'взять на my.telegram.org → API development tools',
  botToken: 'взять у @BotFather',
  allowedChatIds: [],
  maxHeight: 1080,
};

/** Читает и проверяет конфиг; строка — человеческое описание проблемы */
export function loadConfig(file: string): BotConfig | string {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return `Нет файла ${file}. Создай его по образцу config.example.json и заполни apiId, apiHash, botToken.`;
  }
  let cfg: Partial<BotConfig>;
  try {
    cfg = JSON.parse(raw) as Partial<BotConfig>;
  } catch (e) {
    return `${file} — битый JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!cfg.apiId || typeof cfg.apiId !== 'number') return 'В конфиге нет apiId (число с my.telegram.org).';
  if (!cfg.apiHash || /взять/.test(cfg.apiHash)) return 'В конфиге нет apiHash (строка с my.telegram.org).';
  if (!cfg.botToken || /взять/.test(cfg.botToken)) return 'В конфиге нет botToken (выдаёт @BotFather).';
  if (!Array.isArray(cfg.allowedChatIds)) return 'allowedChatIds должен быть массивом чисел (можно пустым).';
  return cfg as BotConfig;
}
