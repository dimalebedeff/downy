import { describe, expect, it } from 'vitest';
import { authFailureHint } from '../src/lib/cookies';

describe('authFailureHint', () => {
  it('сайт просит войти, а тумблер выключен — говорим про тумблер', () => {
    const hint = authFailureHint({ message: 'ERROR: login required', cookiesOn: false });
    expect(hint).toMatch(/cookies/i);
    expect(hint).toMatch(/настройк/i);
  });

  it('cookies уже отправляли, и всё равно отказ — тумблер тут больше не поможет', () => {
    const hint = authFailureHint({ message: 'HTTP Error 403: Forbidden', cookiesOn: true, cookiesTried: true });
    expect(hint).toMatch(/не пустил|вошли/i);
    // Второй раз звать в настройки бессмысленно — там уже включено
    expect(hint).not.toMatch(/включите/i);
  });

  it('тумблер включён, но попытка ещё впереди — молчим, сейчас повторим сами', () => {
    expect(authFailureHint({ message: 'login required', cookiesOn: true })).toBeNull();
  });

  it('обычная поломка про cookies ничего не говорит', () => {
    expect(authFailureHint({ message: 'Unable to download webpage: timed out', cookiesOn: false })).toBeNull();
    expect(authFailureHint({ message: 'HTTP Error 404: Not Found', cookiesOn: false })).toBeNull();
  });

  it('пустое сообщение — не повод гадать', () => {
    expect(authFailureHint({ cookiesOn: false })).toBeNull();
    expect(authFailureHint({ message: '', cookiesOn: false })).toBeNull();
  });
});
