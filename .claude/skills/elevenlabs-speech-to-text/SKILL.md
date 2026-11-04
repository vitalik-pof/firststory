---
name: "elevenlabs-speech-to-text"
description: "Транскрибуйте свої аудіофайли з детальною розміткою мовців і точними часовими мітками за допомогою нашої передової моделі."
---

# speech-to-text

> **ПЕРЕДУМОВА:** Прочитайте `../elevenlabs-shared/SKILL.md`, щоб дізнатися про автентифікацію, глобальні прапорці та форматування виводу. Якщо файлу немає, виконайте `elevenlabs generate-skills`, щоб його створити.

```bash
elevenlabs speech-to-text <method> [flags]
```

## Ресурси API

 - `convert` — Створити транскрипцію

### transcripts

 - `delete` — Видалити транскрипцію за ID
 - `get` — Отримати транскрипцію за ID
## Пошук команд

**Агенти: завжди надавайте перевагу `--schema` перед `--help`** — `--schema` повертає JSON; `--help` повертає текст для людей.

```bash
# Machine-readable surface (use this)
elevenlabs speech-to-text --schema
elevenlabs speech-to-text <method> --schema

# Human-readable help (for humans)
elevenlabs speech-to-text --help
```


## Нічого не підходить?

`--schema` і `--help` показують лише те, що існує. Якщо запит користувача неможливо виконати
жодною командою, повідомте про цю прогалину — саме так з'являються відсутні команди:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```
