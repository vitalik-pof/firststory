---
name: "elevenlabs-text-to-voice"
description: "Проєктування та генерування власних голосів за текстовим описом."
---

# text-to-voice

> **ПЕРЕДУМОВА:** Прочитайте `../elevenlabs-shared/SKILL.md` про автентифікацію, глобальні прапорці та форматування виводу. Якщо файлу немає, запустіть `elevenlabs generate-skills`, щоб створити його.

```bash
elevenlabs text-to-voice <method> [flags]
```

## Ресурси API

 - `create` — Створити новий голос на основі попереднього прослуховування
 - `create_previews` — Дизайн голосу
 - `design` — Спроєктувати голос.
 - `remix` — Зробити ремікс голосу.

### preview

 - `stream` — Потокове попереднє прослуховування голосу, створеного з тексту
## Як знайти команди

**Агентам: завжди надавайте перевагу `--schema`, а не `--help`** — `--schema` повертає JSON; `--help` повертає текст для людей.

```bash
# Machine-readable surface (use this)
elevenlabs text-to-voice --schema
elevenlabs text-to-voice <method> --schema

# Human-readable help (for humans)
elevenlabs text-to-voice --help
```


## Нічого не підходить?

`--schema` і `--help` показують лише те, що існує. Якщо запит користувача неможливо виконати
жодною командою, повідомте про прогалину — саме так з’являються відсутні команди:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```
