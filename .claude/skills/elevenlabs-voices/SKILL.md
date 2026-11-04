---
name: "elevenlabs-voices"
description: "Доступ до голосів, створених вами або ElevenLabs."
---

# voices

> **ПЕРЕДУМОВА:** Прочитайте `../elevenlabs-shared/SKILL.md` про автентифікацію, глобальні прапорці та форматування виводу. Якщо файлу немає, запустіть `elevenlabs generate-skills`, щоб створити його.

```bash
elevenlabs voices <method> [flags]
```

## Ресурси API

 - `delete` — Видалити голос
 - `find_similar_voices` — Отримати список схожих голосів
 - `get` — Отримати голос
 - `get_all` — Отримати список голосів
 - `get_shared` — Отримати спільні голоси
 - `replicate_to_isolated_environment` — Реплікувати голос в ізольоване середовище
 - `search` — Отримати список голосів
 - `share` — Додати спільний голос
 - `update` — Редагувати голос

### accents

 - `get` — Отримати акценти голосів

### collections

 - `add_voice` — Додати голос до колекції
 - `create` — Створити колекцію голосів
 - `delete` — Видалити колекцію голосів
 - `get` — Отримати колекцію голосів
 - `list` — Отримати список колекцій голосів
 - `remove_voice` — Вилучити голос із колекції
 - `update` — Оновити колекцію голосів

### ivc

 - `create` — Створити клон голосу

### pvc

 - `create` — Створити голос PVC
 - `train` — Запустити навчання PVC
 - `update` — Редагувати голос PVC

#### samples

 - `create` — Додати зразки до голосу PVC
 - `delete` — Видалити зразок голосу PVC
 - `update` — Оновити зразок голосу PVC

##### audio

 - `get` — Отримати аудіо зразка голосу

##### speakers

 - `get` — Отримати стан розділення мовців
 - `separate` — Запустити розділення мовців

###### audio

 - `get` — Отримати аудіо відокремленого мовця

##### waveform

 - `get` — Отримати візуалізацію хвильової форми зразка голосу

#### verification

 - `request` — Надіслати запит на ручну верифікацію

##### captcha

 - `get` — Отримати капчу для голосу PVC
 - `verify` — Перевірити капчу для голосу PVC

### samples


#### audio

 - `get` — Отримати аудіо зі зразка

### settings

 - `get` — Отримати налаштування голосу
 - `get_default` — Отримати типові налаштування голосу
 - `update` — Редагувати налаштування голосу
## Як знайти команди

**Агентам: завжди надавайте перевагу `--schema`, а не `--help`** — `--schema` повертає JSON; `--help` повертає текст для людей.

```bash
# Machine-readable surface (use this)
elevenlabs voices --schema
elevenlabs voices <method> --schema

# Human-readable help (for humans)
elevenlabs voices --help
```


## Нічого не підходить?

`--schema` і `--help` показують лише те, що існує. Якщо запит користувача неможливо виконати
жодною командою, повідомте про прогалину — саме так з’являються відсутні команди:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```
