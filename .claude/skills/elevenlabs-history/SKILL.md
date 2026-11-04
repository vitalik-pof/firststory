---
name: "elevenlabs-history"
description: "Доступ до історії вашого згенерованого мовлення."
---

# history

> **ПЕРЕДУМОВА:** Прочитайте `../elevenlabs-shared/SKILL.md`, щоб дізнатися про автентифікацію, глобальні прапорці та форматування виводу. Якщо файлу немає, виконайте `elevenlabs generate-skills`, щоб його створити.

```bash
elevenlabs history <method> [flags]
```

## Ресурси API

 - `delete` — Видалити елемент історії
 - `download` — Завантажити елементи історії
 - `get` — Отримати елемент історії
 - `get_audio` — Отримати аудіо з елемента історії
 - `list` — Отримати згенеровані елементи
## Пошук команд

**Агенти: завжди надавайте перевагу `--schema` перед `--help`** — `--schema` повертає JSON; `--help` повертає текст для людей.

```bash
# Machine-readable surface (use this)
elevenlabs history --schema
elevenlabs history <method> --schema

# Human-readable help (for humans)
elevenlabs history --help
```


## Нічого не підходить?

`--schema` і `--help` показують лише те, що існує. Якщо запит користувача неможливо виконати
жодною командою, повідомте про цю прогалину — саме так з'являються відсутні команди:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```
