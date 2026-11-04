---
name: "elevenlabs-assets"
description: "Керування завантаженими медіаресурсами."
---

# assets

> **ПЕРЕДУМОВА:** Прочитайте `../elevenlabs-shared/SKILL.md`, щоб дізнатися про автентифікацію, глобальні прапорці та форматування виводу. Якщо файлу немає, виконайте `elevenlabs generate-skills`, щоб його створити.

```bash
elevenlabs assets <method> [flags]
```

## Ресурси API

 - `create` — Завантажити ресурс
 - `delete` — Видалити ресурс
 - `get` — Отримати ресурс
 - `list` — Список ресурсів
## Пошук команд

**Агенти: завжди надавайте перевагу `--schema` перед `--help`** — `--schema` повертає JSON; `--help` повертає текст для людей.

```bash
# Machine-readable surface (use this)
elevenlabs assets --schema
elevenlabs assets <method> --schema

# Human-readable help (for humans)
elevenlabs assets --help
```


## Нічого не підходить?

`--schema` і `--help` показують лише те, що існує. Якщо запит користувача неможливо виконати
жодною командою, повідомте про цю прогалину — саме так з'являються відсутні команди:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```
