---
name: "elevenlabs-audio-effects"
description: "Перелік пресетів фільтрів, середовищ реверберації та фонових шумів, які можна застосувати до згенерованого мовлення."
---

# audio-effects

> **ПЕРЕДУМОВА:** Прочитайте `../elevenlabs-shared/SKILL.md`, щоб дізнатися про автентифікацію, глобальні прапорці та форматування виводу. Якщо файлу немає, виконайте `elevenlabs generate-skills`, щоб його створити.

```bash
elevenlabs audio-effects <method> [flags]
```

## Ресурси API

 - `get_catalog` — Отримати каталог аудіоефектів
## Пошук команд

**Агенти: завжди надавайте перевагу `--schema` перед `--help`** — `--schema` повертає JSON; `--help` повертає текст для людей.

```bash
# Machine-readable surface (use this)
elevenlabs audio-effects --schema
elevenlabs audio-effects <method> --schema

# Human-readable help (for humans)
elevenlabs audio-effects --help
```


## Нічого не підходить?

`--schema` і `--help` показують лише те, що існує. Якщо запит користувача неможливо виконати
жодною командою, повідомте про цю прогалину — саме так з'являються відсутні команди:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```
