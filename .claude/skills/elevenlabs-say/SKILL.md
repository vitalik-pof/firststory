---
name: elevenlabs-say
description: Озвучування тексту вголос із термінала за допомогою `elevenlabs say`. Використовуйте, коли просять сказати, промовити чи прочитати щось уголос, оголосити або озвучити результат, відтворити текст як аудіо, швидко створити озвучення чи MP3 з тексту, зробити так, щоб мовлення звучало схвильовано, пошепки чи емоційно за допомогою аудіотегів v4, або задати типовий голос, модель чи програвач для CLI.
---

# `elevenlabs say`

Перетворює текст на мовлення й відтворює його, не вимагаючи вибирати
ідентифікатор голосу, шлях до файлу чи програвач.

```bash
elevenlabs say "this came from the terminal"
```

Потрібні облікові дані: або `elevenlabs auth login`, або `ELEVENLABS_API_KEY`
у змінних середовища.

> Якщо `say` не може зробити те, що просить користувач, повідомте про це, а не
> імпровізуйте: `elevenlabs feedback missing-capability "<what you needed>"`.
> Команда фіксує прогалину й повертає керування; вона не зриває вашого завдання.

## Зчитування тексту

Три рівноцінні джерела — оберіть те, що зручніше для того, хто викликає:

```bash
elevenlabs say "hello there"          # positional (quote it)
elevenlabs say hello there            # bare words are joined with spaces
echo "build finished" | elevenlabs say  # piped stdin
elevenlabs say -                      # explicit stdin
```

Якщо немає ні аргументу, ні даних із конвеєра, `say` завершується з помилкою,
а не зависає.

> `config` — це підкоманда, тож щоб промовити саме це слово, потрібно
> `elevenlabs say -- config`. Усі прапорці ставте **перед** `--`.

## Типові значення

Зберігаються для кожного користувача окремо у `~/.elevenlabs/config.json` під
ключем `say`, поруч із налаштуванням `residency`. До цього файлу не потрапляє
нічого конфіденційного — облікові дані залишаються у сховищі ключів ОС.

```bash
elevenlabs say config                                 # show everything
elevenlabs say config voice 21m00Tcm4TlvDq8ikWAM
elevenlabs say config model eleven_multilingual_v2
elevenlabs say config output-format wav_44100
elevenlabs say config player mpv
elevenlabs say config voice                           # show just this one
elevenlabs say config voice --unset                   # back to the built-in
```

| Ключ | Поле конфігурації | Вбудоване типове значення |
|---|---|---|
| `voice` | `say.voice_id` | `JBFqnCBsd6RMkjVDRZzb` (George) |
| `model` | `say.model_id` | `eleven_v4` |
| `output-format` | `say.output_format` | залежить від програвача |
| `player` | `say.player` | перший знайдений у `PATH` |

`eleven_v4` — найвиразніша модель, і лише сімейства v4 та v3 розуміють
наведені нижче аудіотеги. `eleven_v4_turbo` — заміна на випадок, коли затримка
важливіша за подачу: її створено для роботи в реальному часі, і вона теж
сприймає теги. `eleven_flash_v2_5` ще швидша, але читає теги як слова.

Ідентифікатори голосів шукайте за допомогою `elevenlabs voices search`, а
ідентифікатори моделей — за допомогою `elevenlabs models list`.

## Перевизначення для одного запуску

Для кожного типового значення є прапорець, який має пріоритет під час одного
виклику:

```bash
elevenlabs say "one off" \
  --voice JBFqnCBsd6RMkjVDRZzb \
  --model eleven_multilingual_v2 \
  --output-format mp3_44100_192 \
  --player mpv
```

Пріоритет завжди такий: **прапорець > файл конфігурації > вбудоване типове значення**.

## Аудіотеги (лише v4 і v3)

`eleven_v4` (як і `eleven_v4_turbo` та `eleven_v3`) сприймає вбудовані в текст
вказівки у квадратних дужках як режисерські ремарки, а не як слова, — саме завдяки цьому репліка звучить як живе мовлення, а не як начитка:

```bash
elevenlabs say "[excited] The build passed!"
elevenlabs say "[whispers] don't tell anyone [laughs]"
elevenlabs say "[sarcastic] Oh, brilliant. [sighs]"
```

Три умовні групи:

- **Подача та емоції** — `[excited]`, `[curious]`, `[sarcastic]`,
  `[whispers]`, `[mischievously]`, `[crying]`
- **Невербальні звуки** — `[laughs]`, `[laughs harder]`, `[starts laughing]`,
  `[sighs]`, `[exhales]`, `[snorts]`
- **Експериментальні** — `[strong French accent]`, `[sings]` та ефекти на
  кшталт `[applause]` чи `[gunshot]`

Теги належать до сімейств v4 і v3. У `eleven_flash_v2_5`, `eleven_turbo_v2_5` чи
`eleven_multilingual_v2` вони не є вказівками — їх зачитують як звичайний
текст, тож `[excited] hello` буде промовлено як слово «excited», а за ним
«hello».

Наскільки добре спрацює тег, залежить від голосу: голос, чиє навчання суперечить
вказівці (`[shout]` для м’якого оповідача), її проігнорує; теги можна поєднувати,
а експериментальні варто випробувати, перш ніж на них покладатися.

Докладніше: <https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices#audio-tags>

## Збереження замість відтворення

`--output` записує аудіо й повністю пропускає відтворення, тож працює навіть на
машині без аудіопрогравача та звукового пристрою:

```bash
elevenlabs say "saved to a file" --output out.mp3
elevenlabs say "as wav" -o out.wav        # extension picks the format
```

## Аудіоформати

`output_format` має вигляд `codec_samplerate[_bitrate]`, наприклад `mp3_44100_128`,
`wav_44100`, `pcm_24000`, `opus_48000_128`, `ulaw_8000`. Який із них буде використано:

1. `--output-format`, якщо його вказано.
2. Розширення імені файлу в `--output` (`.mp3`, `.wav`, `.opus`/`.ogg`,
   `.pcm`/`.raw`, `.ulaw`, `.alaw`) — ім’я файлу має пріоритет над збереженим
   типовим значенням, тож `out.wav` ніколи не міститиме байтів MP3.
3. Налаштоване значення `say.output_format`.
4. Вимога програвача: WAV для наведених нижче програвачів, що підтримують лише
   WAV, інакше `mp3_44100_128`.

## Програвачі

Для відтворення запускається зовнішня програма; у двійковий файл нічого не
вбудовано. Використовується перший із цих програвачів, знайдений у `PATH`, якщо
тільки `--player` або `say config player` не вказує конкретний:

| Програвач | Читає stdin | Приймає | Примітки |
|---|---|---|---|
| `ffplay` | так | будь-який формат | із пакета ffmpeg |
| `mpv` | так | будь-який формат | |
| `afplay` | ні | будь-який формат | macOS, є завжди |
| `paplay` | ні | лише WAV | Linux/PulseAudio |
| `aplay` | ні | лише WAV | Linux/ALSA |
| PowerShell `Media.SoundPlayer` | ні | лише WAV | Windows |

Програвачам, які вміють читати stdin, надається перевага, бо відтворення
починається з першого фрагмента, а не після завантаження всього файлу. Решта
отримують тимчасовий файл, який відтворюється після завершення потоку.

`--player` також приймає команду, якої немає в цій таблиці (скажімо,
скрипт-обгортку). Невідомими програвачами керують обережно: аудіо записується в
тимчасовий файл, а шлях до нього передається як єдиний аргумент.

Аргументи завжди передаються окремо, ніколи через оболонку.

## Усунення несправностей

**`No audio player found.`** — встановіть ffmpeg або mpv, передайте `--player`
або використайте `--output <path>`, щоб пропустити відтворення.

**`Audio player 'x' was not found on PATH.`** — налаштованого або запитаного
програвача немає. `elevenlabs say config player --unset` повертає
автоматичне визначення.

**`The 'aplay' player only handles WAV, but the format is 'mp3_44100_128'.`**
— або вкажіть `--output-format wav_44100`, або перейдіть на програвач, що декодує MP3.

**У разі 401/422 виводиться JSON-обгортка з помилкою, а команда завершується з ненульовим кодом.**
Запит надсилається, а його статус перевіряється *ще до* запуску будь-якого
програвача чи створення файлу, тож невдалий виклик ніколи не відтворює тіло
помилки й не залишає після себе частково записаного файлу. Коди виходу
відповідають домовленостям CLI: `1` — помилка API, `3` — помилка валідації.

**Запити надходять не в той регіон.** `say` враховує `elevenlabs residency`,
`ELEVENLABS_BASE_URL` і `--base-url`, як і будь-яка інша команда.
