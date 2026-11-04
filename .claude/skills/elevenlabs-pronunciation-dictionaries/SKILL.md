---
name: "elevenlabs-pronunciation-dictionaries"
description: "Керування словниками вимови, які перевизначають, як вимовляються певні слова."
---

# pronunciation-dictionaries

> **ПЕРЕДУМОВА:** Прочитайте `../elevenlabs-shared/SKILL.md`, щоб дізнатися про автентифікацію, глобальні прапорці та форматування виводу. Якщо файлу немає, виконайте `elevenlabs generate-skills`, щоб його створити.

```bash
elevenlabs pronunciation-dictionaries <method> [flags]
```

## Ресурси API

 - `create_from_file` — Створити словник вимови з файлу
 - `create_from_rules` — Створити словник вимови з правил
 - `download` — Отримати словник вимови за версією
 - `get` — Отримати словник вимови
 - `list` — Список словників вимови
 - `update` — Оновити словник вимови

### rules

 - `add` — Додати правила словника вимови
 - `remove` — Вилучити правила словника вимови
 - `set` — Встановити правила словника вимови
## Пошук команд

**Агенти: завжди надавайте перевагу `--schema` перед `--help`** — `--schema` повертає JSON; `--help` повертає текст для людей.

```bash
# Machine-readable surface (use this)
elevenlabs pronunciation-dictionaries --schema
elevenlabs pronunciation-dictionaries <method> --schema

# Human-readable help (for humans)
elevenlabs pronunciation-dictionaries --help
```


## Нічого не підходить?

`--schema` і `--help` показують лише те, що існує. Якщо запит користувача неможливо виконати
жодною командою, повідомте про цю прогалину — саме так з'являються відсутні команди:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```
