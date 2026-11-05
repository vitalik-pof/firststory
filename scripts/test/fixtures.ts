// Тестовий проєкт у тимчасовій теці: власні зразки документів за форматами ролей.
// Нічого не пише в stories/ і work/ справжнього репозиторію.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { setRoot } from '../lib/paths';

export const STORY = 'T1-test';

export const SCRIPT_MD = `# Сценарій: Тестова історія

Мова озвучення: українська
Обсяг: 150 знаків, близько 11 секунд при 14 знаках на секунду

## Фрагменти

### 1
Ми виїхали влітку. Було спекотно.

### 2
Дочки мали піти в перший клас.

### 3
Але не судилося.

## Що змінено порівняно з оригіналом і чому

Нічого суттєвого.

## Питання

1. Режисерові. Скільки було доньок?
`;

export const VOICE_MD = `# Озвучення: Тестова історія

Голос: tester

## Фрагмент 1
[calmly] Ми виїхали влітку. [pause] [quietly] Було спекотно.

## Фрагмент 2
[softly] Дочки мали піти в перший клас.

## Фрагмент 3
[pause] Але не судилося. [pause]

## Вимова

Нічого особливого.

## Питання

Немає.
`;

export const VOICES_MD = `# Голоси

## tester
Для історії: ${STORY}
Образ голосу: Тепла жінка років сорока.
Опис для Voice Design (англійською): A Ukrainian woman around 45 years old, warm low voice, calm and sincere, close microphone, unhurried pace.
Текст проби: Дочки мали піти в перший клас. Тому ми думали, що скоро повернемося. Але не судилося. Ближче до вересня зрозуміли, що треба вирішувати, як бути далі.
voice_id:

## Питання
`;

export const STYLE_MD = `# Візуальний стиль

## Задум

Гуаш на кремовому папері.

## Текст стилю для генератора (англійською)

Hand-painted gouache illustration on warm cream paper, matte paint, muted palette.

## Питання

1. Технікові. Аркуші в 16:9.
`;

export const HERO_MD = `# Наталя

З'являється в: \`${STORY}\`, оповідачка.

Каштанове волосся, теракотова блузка.

## Версія «2014»: літо

Близько тридцяти.

### Текст для генератора аркуша героя (англійською)

Character sheet of a woman about 30, terracotta blouse, plain grey background.

## Версія «тепер»: Дніпро

Близько сорока двох.

### Текст для генератора аркуша героя (англійською)

Character sheet of a woman about 42, oatmeal sweater, plain grey background.

## Ресурси

Поки порожньо. Технік впише id аркушів окремо для кожної версії.
`;

export const SON_MD = `# Син

З'являється в: \`${STORY}\`.

Немовля в конверті.

## Текст для генератора аркуша героя (англійською)

Reference sheet of a newborn in a white envelope with a blue ribbon.

## Ресурси

Поки порожньо.
`;

export const STORYBOARD_MD = `# Розкадровка: Тестова історія

Формат кадру: 9:16, вертикальний, для Reels.

Тут пояснення під шапкою.

## Кадр 1
Фрагмент сценарію: 1
У кадрі: місто влітку.
Герої: немає
Камера: наїзд.
Світло і настрій: спека.
Для генератора (англійською): A hot summer city street, no people.

## Кадр 2
Фрагмент сценарію: 1
У кадрі: машина їде.
Герої: natalia (версія «2014», у кардигані), natalia-son — тільки силуети, аркуші не обов'язкові.
Камера: від'їзд.
Світло і настрій: марево.
Для генератора (англійською): A small car drives away on a steppe road.

## Кадр 3
Фрагмент сценарію: 2
У кадрі: дитяча кімната.
Герої: немає (доньки присутні через свої речі)
Камера: наїзд.
Світло і настрій: тепло.
Для генератора (англійською): A children's room with two backpacks.

## Кадр 4
Фрагмент сценарію: 3
У кадрі: та сама кімната в сутінках.
Герої: немає
Камера: статика.
Світло і настрій: холод.
Для генератора (англійською): The same room at cold dusk, as the reference image.

## Приймання

Кадри 1–2 прийнято.

## Питання

1. Режисерові. Чи додавати титр?
`;

export const SOUND_MD = `# Звук: Тестова історія

Загальна тривалість: 12 секунд
Задум: Тиша і тепла гітара.

## Музика
Для генератора музики (англійською): Soft solo acoustic guitar, warm and intimate, slow tempo.
Тривалість: 12
Інструментальна: так
Розвиток по фільму: тихо на початку, піднімається до фрагмента 3.

## Шуми
### Шум 1
Для генератора (англійською): Distant city traffic hum in summer.
Тривалість: 4
Де: кадр 1, секунда 0
Гучність під голосом: тихо

### Шум 2
Для генератора (англійською): A car passing on a dusty road.
Тривалість: 3,5
Де: кадр 2, секунда 1
Гучність під голосом: середньо

## Зведення
Музика під голосом тихо.

## Питання

Немає.
`;

export const SAMPLES_MD = `# Зразки стилю: Тестова історія

Задум: Показати стиль на трьох зразках.

## Зразок 1
Що показує: аркуш облич.
Формат: 1:1
Для фрагмента: немає
Герої: немає
Для генератора (англійською): A study sheet of five faces on cream paper.

## Зразок 2
Що показує: пейзаж, місто влітку.
Формат: 9:16
Для фрагмента: 1
Герої: немає
Для генератора (англійською): A hot summer city street, no people.

## Зразок 3
Що показує: героїня в кімнаті.
Формат: 9:16
Для фрагмента: 3
Герої: natalia (версія «2014», у кардигані)
Для генератора (англійською): A woman standing in a children's room at dusk.

## Питання

1. Режисерові. Чи подобається палітра?
`;

export const SOUND_SAMPLES_MD = `# Зразки звуку: Тестова історія

Задум: Дві музичні ідеї і один шум.

## Музика

### Зразок 1
Для генератора музики (англійською): Soft solo acoustic guitar, warm, slow.
Тривалість: 12
Інструментальна: так
Що показує: тепла камерна гітара.

### Зразок 2
Для генератора музики (англійською): Low piano drone with strings, sparse.
Тривалість: 8
Інструментальна: так
Що показує: холодніший варіант.

## Шуми

### Шум 1
Для генератора (англійською): Distant city traffic hum in summer.
Тривалість: 4
Що показує: фон міста.

## Зведення
Зразок музики: 1
Фрагменти для зразка: 1–2
Музика під голосом, дБ відносно голосу: −18
Музика в паузах, дБ відносно голосу: -8
Час зміни гучності, с: 0,6
Задум зведення: Музика тримається під голосом і виходить у паузи.

## Питання

1. Режисерові. Чи не надто тиха музика під голосом?
`;

export function mkProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'firststory-test-'));
  setRoot(root);
  const w = (rel: string, text: string): void => {
    const f = join(root, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  };
  w(`stories/${STORY}/source.md`, '# Тест\n\nАвтор: Наталя, м. Тест\nДжерело: нема\n\n---\n\nТекст.\n');
  w(`stories/${STORY}/script.md`, SCRIPT_MD);
  w(`stories/${STORY}/voice.md`, VOICE_MD);
  w(`stories/${STORY}/storyboard.md`, STORYBOARD_MD);
  w(`stories/${STORY}/sound.md`, SOUND_MD);
  w(`stories/${STORY}/status.md`, '# Статус\n\n## Рішення ролей замість режисера на Етапі 1\n\n- Озвучення з першої проби.\n\n## Журнал\n');
  w('voices.md', VOICES_MD);
  w('art/style.md', STYLE_MD);
  w('art/samples.md', SAMPLES_MD);
  w(`stories/${STORY}/sound-samples.md`, SOUND_SAMPLES_MD);
  w('characters/natalia.md', HERO_MD);
  w('characters/natalia-son.md', SON_MD);
  return root;
}

export async function makePng(file: string, w: number, h: number, seed: number): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  // Шумове зображення, щоб стиснення давало реалістичні розміри.
  const buf = Buffer.alloc(w * h * 3);
  let x = seed * 2654435761;
  for (let i = 0; i < buf.length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    const base = (i / 3) % w;
    buf[i] = ((x >>> 24) & 0x30) + ((base / w) * 160 + seed * 20) % 200;
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).blur(1.2).png().toFile(file);
}

export function makeMp3(file: string, seconds: number, freq = 440): void {
  mkdirSync(dirname(file), { recursive: true });
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`, '-b:a', '128k', file]);
  if (r.status !== 0) throw new Error('ffmpeg не створив тестовий mp3');
}
