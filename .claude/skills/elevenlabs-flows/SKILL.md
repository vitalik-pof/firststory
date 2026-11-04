---
name: "elevenlabs-flows"
description: "Запуск багатокрокових потоків генерації мовлення, зображень і відео."
---

# flows

> **ПЕРЕДУМОВА:** Прочитайте `../elevenlabs-shared/SKILL.md`, щоб дізнатися про автентифікацію, глобальні прапорці та форматування виводу. Якщо файлу немає, виконайте `elevenlabs generate-skills`, щоб його створити.

```bash
elevenlabs flows <method> [flags]
```

## Ресурси API


### image

 - `create` — Створити генерацію зображення
 - `get` — Отримати генерацію зображення
 - `list` — Список генерацій зображень

### templates

 - `get` — Отримати шаблон
 - `list` — Список шаблонів

#### runs

 - `create` — Створити запуск шаблону
 - `get` — Отримати запуск шаблону
 - `list` — Список запусків шаблону

### text-to-speech

 - `create` — Створити генерацію мовлення
 - `get` — Отримати генерацію мовлення
 - `list` — Список генерацій мовлення

### video

 - `create` — Створити генерацію відео
 - `get` — Отримати генерацію відео
 - `list` — Список генерацій відео
## Пошук команд

**Агенти: завжди надавайте перевагу `--schema` перед `--help`** — `--schema` повертає JSON; `--help` повертає текст для людей.

```bash
# Machine-readable surface (use this)
elevenlabs flows --schema
elevenlabs flows <method> --schema

# Human-readable help (for humans)
elevenlabs flows --help
```


## Нічого не підходить?

`--schema` і `--help` показують лише те, що існує. Якщо запит користувача неможливо виконати
жодною командою, повідомте про цю прогалину — саме так з'являються відсутні команди:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```
