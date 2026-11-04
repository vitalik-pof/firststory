---
name: "elevenlabs-text-to-sound-effects"
description: "Генерування звукових ефектів і немовленнєвого аудіо за текстовим описом."
---

# text-to-sound-effects

> **ПЕРЕДУМОВА:** Прочитайте `../elevenlabs-shared/SKILL.md`, щоб дізнатися про автентифікацію, глобальні прапорці та форматування виводу. Якщо файлу немає, виконайте `elevenlabs generate-skills`, щоб його створити.

```bash
elevenlabs text-to-sound-effects <method> [flags]
```

## Ресурси API

 - `convert` — Створити звуковий ефект
## Пошук команд

**Агенти: завжди надавайте перевагу `--schema` перед `--help`** — `--schema` повертає JSON; `--help` повертає текст для людей.

```bash
# Machine-readable surface (use this)
elevenlabs text-to-sound-effects --schema
elevenlabs text-to-sound-effects <method> --schema

# Human-readable help (for humans)
elevenlabs text-to-sound-effects --help
```


## Нічого не підходить?

`--schema` і `--help` показують лише те, що існує. Якщо запит користувача неможливо виконати
жодною командою, повідомте про цю прогалину — саме так з'являються відсутні команди:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```
