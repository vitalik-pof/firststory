---
name: "elevenlabs-text-to-speech"
description: "Перетворення тексту на реалістичне мовлення голосом на ваш вибір."
---

# text-to-speech

> **ПЕРЕДУМОВА:** Прочитайте `../elevenlabs-shared/SKILL.md` про автентифікацію, глобальні прапорці та форматування виводу. Якщо файлу немає, запустіть `elevenlabs generate-skills`, щоб створити його.

```bash
elevenlabs text-to-speech <method> [flags]
```

## Ресурси API

 - `convert` — Створити мовлення
 - `convert_with_timestamps` — Створити мовлення з часовими мітками
 - `stream` — Потокове передавання мовлення
 - `stream_with_timestamps` — Потокове передавання мовлення з часовими мітками
## Як знайти команди

**Агентам: завжди надавайте перевагу `--schema`, а не `--help`** — `--schema` повертає JSON; `--help` повертає текст для людей.

```bash
# Machine-readable surface (use this)
elevenlabs text-to-speech --schema
elevenlabs text-to-speech <method> --schema

# Human-readable help (for humans)
elevenlabs text-to-speech --help
```


## Модель

Передайте `--model-id eleven_v4` — найвиразнішу модель, яка також сприймає
аудіотеги на кшталт `[whispers]` як вказівки щодо подачі. Без цього прапорця API
використовує старішу типову модель. Для потокового передавання в реальному часі
натомість використовуйте `eleven_v4_turbo`.

## Нічого не підходить?

`--schema` і `--help` показують лише те, що існує. Якщо запит користувача неможливо виконати
жодною командою, повідомте про прогалину — саме так з’являються відсутні команди:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```
