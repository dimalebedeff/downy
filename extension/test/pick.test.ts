import { describe, expect, it } from 'vitest';
import { bestFromSrcset, imageStem } from '../src/lib/pick';

describe('bestFromSrcset', () => {
  it('берёт самую большую ширину, а не последнюю запись', () => {
    const srcset = 'small.jpg 320w, huge.jpg 2048w, mid.jpg 1024w';
    expect(bestFromSrcset(srcset)).toBe('huge.jpg');
  });

  it('понимает плотность пикселей', () => {
    expect(bestFromSrcset('a.jpg 1x, b.jpg 3x, c.jpg 2x')).toBe('b.jpg');
  });

  it('ширина весомее плотности: 2x не должен обыграть 1600w', () => {
    expect(bestFromSrcset('dense.jpg 2x, wide.jpg 1600w')).toBe('wide.jpg');
  });

  it('адрес без дескриптора проигрывает любому размеру', () => {
    expect(bestFromSrcset('plain.jpg, sized.jpg 800w')).toBe('sized.jpg');
  });

  it('единственный адрес без дескриптора всё равно годится', () => {
    expect(bestFromSrcset('only.jpg')).toBe('only.jpg');
  });

  it('переносы строк и лишние пробелы не мешают', () => {
    expect(bestFromSrcset('\n  a.jpg   320w ,\n  b.jpg   900w \n')).toBe('b.jpg');
  });

  it('пустой и отсутствующий srcset дают null', () => {
    expect(bestFromSrcset('')).toBeNull();
    expect(bestFromSrcset(null)).toBeNull();
    expect(bestFromSrcset(undefined)).toBeNull();
  });

  it('мусорные дескрипторы не роняют разбор', () => {
    expect(bestFromSrcset('a.jpg xx, b.jpg 500w')).toBe('b.jpg');
  });
});

describe('imageStem', () => {
  it('берёт имя файла без расширения', () => {
    expect(imageStem('https://site.com/media/sunset-over-odessa.jpg')).toBe('sunset-over-odessa');
  });

  it('раскодирует кириллицу в адресе', () => {
    expect(imageStem('https://site.com/%D0%BA%D0%BE%D1%82.png')).toBe('кот');
  });

  it('игнорирует query при выборе сегмента', () => {
    expect(imageStem('https://cdn.site.com/photo-42.webp?w=1200&sig=abc')).toBe('photo-42');
  });

  it('безликое имя уступает заголовку страницы', () => {
    expect(imageStem('https://site.com/image.jpg', 'Пост про котов')).toBe('Пост про котов');
    expect(imageStem('https://site.com/index.png', 'Заголовок')).toBe('Заголовок');
  });

  it('слишком короткий сегмент уступает заголовку', () => {
    expect(imageStem('https://site.com/a.jpg', 'Запасной')).toBe('Запасной');
  });

  it('адрес без расширения годится как имя', () => {
    expect(imageStem('https://cdn.site.com/p/AbCdEf12345')).toBe('AbCdEf12345');
  });

  it('битый адрес отдаёт запасной вариант', () => {
    expect(imageStem('не адрес вовсе', 'Запасной')).toBe('Запасной');
    expect(imageStem('не адрес вовсе')).toBeUndefined();
  });
});
