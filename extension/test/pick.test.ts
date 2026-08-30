import { describe, expect, it } from 'vitest';
import { assetIds, bestFromSrcset, imageStem, previewSiblings } from '../src/lib/pick';

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

describe('assetIds', () => {
  it('находит идентификатор ролика в пути обложки', () => {
    const ids = assetIds('https://ir.ozone.ru/s3/video-72/01M150ZCBMS472FSXW9NC9QH47/cover/wc100/cover.jpg');
    expect(ids).toContain('01M150ZCBMS472FSXW9NC9QH47');
  });

  it('тот же идентификатор виден и в адресе самого видео', () => {
    const cover = assetIds('https://ir.ozone.ru/s3/video-72/01M150ZCBMS472FSXW9NC9QH47/cover/wc100/cover.jpg');
    const video = 'https://vr-1.ozone.ru/vod/video-72/01M150ZCBMS472FSXW9NC9QH47/asset_1_h264.mp4';
    expect(cover.some((id) => video.includes(id))).toBe(true);
  });

  it('обычные слова пути за идентификатор не сходят', () => {
    expect(assetIds('https://site.com/images/photos/summer/beach.jpg')).toEqual([]);
  });

  it('длинное слово без цифр не идентификатор', () => {
    expect(assetIds('https://site.com/verylongdirectoryname/pic.jpg')).toEqual([]);
  });

  it('короткие сегменты с цифрами не в счёт', () => {
    expect(assetIds('https://site.com/v2/img7/pic.jpg')).toEqual([]);
  });

  it('битый адрес не роняет разбор', () => {
    expect(assetIds('не адрес')).toEqual([]);
  });
});

describe('assetIds: имя файла не идентификатор', () => {
  it('одинаковые имена файлов у разных роликов не дают общего ключа', () => {
    const a = assetIds('https://cdn.site/vod/video-71/01M026/asset_1_h264.mp4');
    const b = assetIds('https://cdn.site/vod/video-72/01KZXM/asset_1_h264.mp4');
    expect(a.some((id) => b.includes(id))).toBe(false);
  });

  it('полный ролик и его превью делят идентификатор каталога', () => {
    const full = assetIds('https://vr-1.ozone.ru/vod/video-71/01M026G6STB3E8TQXRQ8J0MS2W/asset_1_h264.mp4');
    const prev = assetIds('https://vr-1.ozone.ru/vod/video-71/01M026G6STB3E8TQXRQ8J0MS2W/preview.mp4');
    expect(full).toEqual(['01M026G6STB3E8TQXRQ8J0MS2W']);
    expect(prev).toEqual(full);
  });
});

describe('previewSiblings', () => {
  const PREVIEW = 'https://vr-1.ozone.ru/vod/video-73/01M00NGFHAC4B6913XB17G6R91/preview.mp4';

  it('предлагает полные дорожки от лучшей к худшей', () => {
    expect(previewSiblings(PREVIEW)).toEqual([
      'https://vr-1.ozone.ru/vod/video-73/01M00NGFHAC4B6913XB17G6R91/asset_2_h264.mp4',
      'https://vr-1.ozone.ru/vod/video-73/01M00NGFHAC4B6913XB17G6R91/asset_1_h264.mp4',
      'https://vr-1.ozone.ru/vod/video-73/01M00NGFHAC4B6913XB17G6R91/asset_0_h264.mp4',
    ]);
  });

  it('сохраняет query адреса', () => {
    const list = previewSiblings(PREVIEW + '?type=review');
    expect(list[0]).toContain('asset_2_h264.mp4?type=review');
  });

  it('обычный файл соседей не имеет', () => {
    expect(previewSiblings('https://site.com/video/clip.mp4')).toEqual([]);
    expect(previewSiblings('https://site.com/video/preview-2.mp4')).toEqual([]);
    expect(previewSiblings('https://vr-1.ozone.ru/vod/x/01M0/asset_1_h264.mp4')).toEqual([]);
  });

  it('битый адрес не роняет разбор', () => {
    expect(previewSiblings('не адрес')).toEqual([]);
  });
});
