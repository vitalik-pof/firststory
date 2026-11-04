---
name: "elevenlabs-music"
description: "Генерування музики за текстовим описом."
---

# music

> **ПЕРЕДУМОВА:** Прочитайте `../elevenlabs-shared/SKILL.md` про автентифікацію, глобальні прапорці та форматування виводу. Якщо файлу немає, запустіть `elevenlabs generate-skills`, щоб створити його.

```bash
elevenlabs music <method> [flags]
```

## Ресурси API

 - `compose` — Створити музику
 - `compose_detailed` — Створити музику з детальною відповіддю
 - `compose_detailed_stream` — Потокове передавання створеної музики з детальною відповіддю
 - `separate_stems` — Розділення на стеми
 - `stream` — Потокове передавання створеної музики
 - `upload` — Завантажити музику
 - `video_to_music` — Музика з відео

### composition-plan

 - `create` — Згенерувати план композиції

### finetunes

 - `create` — Створити донавчену музичну модель
 - `delete` — Видалити донавчену музичну модель
 - `get` — Отримати донавчену музичну модель
 - `list` — Отримати список донавчених музичних моделей
 - `update` — Оновити донавчену музичну модель
## Як знайти команди

**Агентам: завжди надавайте перевагу `--schema`, а не `--help`** — `--schema` повертає JSON; `--help` повертає текст для людей.

```bash
# Machine-readable surface (use this)
elevenlabs music --schema
elevenlabs music <method> --schema

# Human-readable help (for humans)
elevenlabs music --help
```


## Нічого не підходить?

`--schema` і `--help` показують лише те, що існує. Якщо запит користувача неможливо виконати
жодною командою, повідомте про прогалину — саме так з’являються відсутні команди:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```
