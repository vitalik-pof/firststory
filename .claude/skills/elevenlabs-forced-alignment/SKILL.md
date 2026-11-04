---
name: "elevenlabs-forced-alignment"
description: "Примусове вирівнювання аудіофайлу з текстовою транскрипцією для отримання точних часових міток на рівні слів і символів."
---

# forced-alignment

> **ПЕРЕДУМОВА:** Прочитайте `../elevenlabs-shared/SKILL.md`, щоб дізнатися про автентифікацію, глобальні прапорці та форматування виводу. Якщо файлу немає, виконайте `elevenlabs generate-skills`, щоб його створити.

```bash
elevenlabs forced-alignment <method> [flags]
```

## Ресурси API

 - `create` — Створити примусове вирівнювання
## Пошук команд

**Агенти: завжди надавайте перевагу `--schema` перед `--help`** — `--schema` повертає JSON; `--help` повертає текст для людей.

```bash
# Machine-readable surface (use this)
elevenlabs forced-alignment --schema
elevenlabs forced-alignment <method> --schema

# Human-readable help (for humans)
elevenlabs forced-alignment --help
```


## Нічого не підходить?

`--schema` і `--help` показують лише те, що існує. Якщо запит користувача неможливо виконати
жодною командою, повідомте про цю прогалину — саме так з'являються відсутні команди:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```
