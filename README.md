# OpenCode_GoCost

> TUI-плагин для OpenCode V2: показывает в футере сессии **оценку стоимости**
> для моделей провайдера **OpenCode Go** (`opencode-go`), у которых встроенный
> счётчик стоимости показывает `0` и поэтому скрыт. Сумма считается по
> истории сообщений и ценам из каталога моделей и встаёт на место встроенной
> стоимости.

```
470.3K (48%) · $0.17
```

## Описание

OpenCode 2.2.5 умеет показывать стоимость сессии в строке статуса под
промптом, но для OpenCode Go (`providerID === "opencode-go"`) она равна нулю.
Встроенный футер рисует сумму только при `session.cost > 0`, поэтому у
OpenCode Go счётчика стоимости просто нет.

Плагин закрывает этот пробел: на время своей работы он подменяет общий метод
`context.data.session.cost`. Встроенный футер (`opencode.prompt.footer`) и
встроенный компонент Context в боковой панели вызывают именно этот метод,
поэтому оценка появляется там же, где была бы родная стоимость — сразу после
счётчика токенов и в том же формате:

```
470.3K (48%) · $0.17
```

Что делает плагин:

- возвращает оценку `$<сумма>` из `session.cost` только для OpenCode Go;
- считает сумму по фактическим токенам каждого assistant-сообщения и записи
  компактификации: вход, выход, reasoning, чтение и запись кэша;
- загружает **всю** историю через публичный cursor API `client.message.list()`,
  а не только последние 20 сообщений из TUI-кэша;
- использует ту модель, которая была указана **в самом сообщении**, поэтому
  переключение модели не пересчитывает старую историю по новым ценам;
- выбирает контекстный tier отдельно для каждого сообщения, а не по суммарным
  токенам всей сессии;
- сохраняет уже известные стоимости сообщений OpenCode и добавляет только
  оценки для сообщений `opencode-go` с нулевой стоимостью;
- для корневой сессии складывает оценку самой сессии и её субагентов, для
  субагента — только его собственную (так же ведёт себя нативный метод);
- не трогает сессии, в которых никогда не использовался Go: нативная стоимость
  возвращается как есть;
- если объект данных заморожен и метод не перезаписывается, откатывается на
  старую метку `≈$0.12` в `prompt.footer.status` с диалогом по клику;
- показывает в правой панели лимиты подписки OpenCode Go: 5-часовое окно,
  неделю и месяц;
- стоимость считает локально; полная история загружается через
  `client.message.list()`, а сеть для лимитов Go используется только при
  обновлении через OpenCode Console и когда панель видима.

Это **оценка по прайс-листу каталога**, а не счёт провайдера. Скидки,
округления на стороне OpenCode Go и изменения цен могут дать другую сумму.

## Правая панель: лимиты Go

В боковой панели сессии (слот `sidebar.content`) плагин рисует карточку
подписки OpenCode Go:

```
OpenCode Go                              ↻
5-hour window   1% used   Resets in 3h 14m
█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
Weekly         49% used   Resets in 4h 10m
██████████████████░░░░░░░░░░░░░░░░░░
Monthly        32% used   Resets in 22d 16h
██████████████░░░░░░░░░░░░░░░░░░░░░░
```

Данные берутся из `context.data.location.usage.limits(location)` — того же
кэша, который читает встроенный диалог Usage, — поэтому отдельный запрос к
Console не нужен. Плагин обновляет данные при открытии панели, после
завершения хода и по клику на `↻`; обратный отсчёт пересчитывается локально
каждые 30 секунд.

Заголовок `OpenCode Go` сворачивает блок по клику (`▼` / `▶`), как секции MCP.
Состояние хранится в `context.storage` и сохраняется между запусками. В
свёрнутом виде рядом с заголовком остаётся сводка по месячному лимиту:
`(monthly N%)`.

Цвет полосы берётся из темы: акцентный цвет до 74 %, `warning` с 75 %,
`error` с 90 % или когда `limited === true`. `feedback.success` специально не
используется — в некоторых темах (например, `orng`) он синий. Если вход в
OpenCode Console не выполнен или у workspace нет тарифа Go, панель скрыта.
`BAR_WIDTH = 36` рассчитан на боковую панель шириной 42 колонки.

## Требования

- OpenCode **V2**, проверено на **2.4.1** (API лимитов Go — experimental).
- Node.js **18+** — только для запуска юнит-тестов (OpenCode уже включает
  Node.js).
- Сборка не нужна: TUI-часть (`tui.tsx`) компилирует сам OpenCode.

## Структура

```
GoCost_OCV2/
├── opencode.json          # пустой проектный конфиг (только $schema)
├── install.bat            # установка в глобальный каталог OpenCode (Windows)
├── plugin/
│   ├── index.js           # серверная заглушка (чтобы пакет был корректным)
│   ├── tui.tsx            # TUI-плагин: лимиты Go в сайдбаре + подмена session.cost
│   ├── patch.js           # подмена общего метода стоимости (без OpenCode)
│   ├── cost.js            # чистый расчёт по истории сообщений (тестируется отдельно)
│   ├── history.js         # загрузка всех страниц истории и слияние live-обновлений
│   ├── usage.js           # чистая логика панели лимитов (тестируется отдельно)
│   └── package.json       # "type": "module", exports ".", "./tui"
├── tmp/
│   ├── test-cost.mjs      # юнит-тест логики: node tmp/test-cost.mjs
│   ├── test-history.mjs   # юнит-тест пагинации истории: node tmp/test-history.mjs
│   ├── test-patch.mjs     # юнит-тест подмены: node tmp/test-patch.mjs
│   └── test-usage.mjs     # юнит-тест панели лимитов: node tmp/test-usage.mjs
├── README.md
├── CHANGES.md             # история изменений
├── AGENTS.md              # описание архитектуры проекта
└── LICENSE                # MIT
```

## Формула

Цены в каталоге моделей заданы в **USD за 1 000 000 токенов**. Расчёт применяется
отдельно к каждому assistant-сообщению и записи компактификации, с ценой модели
из `message.model`. Если у записи уже есть положительная `message.cost`,
используется она, а не оценка каталога.

### Выбор тарифа

Сначала считается размер входного контекста **конкретного сообщения**:

```
total = tokens.input + tokens.cache.read + tokens.cache.write
```

Правило совпадает с OpenCode:

1. Среди записей `cost` с `tier.type === "context"` выбираются те, для которых
   `total > tier.size` (строго больше).
2. Из подходящих выбирается запись с **наибольшим** `tier.size`.
3. Если подходящих tier-записей нет, используется базовая запись без `tier`
   (`tier === undefined`).
4. Если нет ни tier-записи, ни базовой — оценка не строится.

Например, при `total = 1000` и tier `size: 1000` базовая цена ещё действует:
`1000 > 1000` ложно. Tier включается только на `1001` токене.

### Стоимость

Для каждого assistant-сообщения или записи компактификации:

```
amount = (
    tokens.input        * price.input
  + (tokens.output + tokens.reasoning) * price.output
  + tokens.cache.read   * price.cache.read
  + tokens.cache.write  * price.cache.write
) / 1_000_000
```

`output` и `reasoning` тарифицируются одинаково — по цене выхода. Если какое-то
поле отсутствует или отрицательное, оно считается нулём; функция не возвращает
`NaN`.

### Формат

В обычном режиме плагин возвращает из `session.cost` **число**, а форматирует
его сам встроенный футер:

```js
new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount)
```

Поэтому в строке статуса видно `$0.17` или `$1,234.50` — ровно так же, как
встроенную стоимость, без префикса `≈`.

`formatCost` (используется fallback-меткой и диалогом) отдаёт строку без `≈`:

| Значение | Вывод |
|---|---|
| `0` | `$0.00` |
| `0.005` | `<$0.01` |
| `0.1193` | `$0.12` |
| `1234.5` | `$1,234.50` |

Только в fallback-режиме UI добавляет `≈`: `≈$0.12`, `≈$1,234.50`,
`≈<$0.01`.

## Установка

### Вариант 1. Автоматически, силами нейросети (рекомендуется)

Скопируй промт ниже и отправь его OpenCode. Агент установит плагин и проверит
результат.

```text
Установи мне плагин OpenCode V2 GoCost из репозитория
https://github.com/StandarterDF/GoCost_OCV2 (замени URL на свой форк,
если он у тебя другой).

Что нужно сделать:
1. Определи каталог глобального конфига OpenCode:
   - Windows: %USERPROFILE%\.config\opencode  (или %XDG_CONFIG_HOME%\opencode)
   - Linux/macOS: ~/.config/opencode  (или $XDG_CONFIG_HOME/opencode)
   Каталог глобальных плагинов — <config>/plugins/.
2. Установи плагин: скопируй файлы из папки plugin/ репозитория
   (index.js, cost.js, history.js, patch.js, usage.js, tui.tsx, package.json) в
   <config>/plugins/go-cost/.
   Каталог plugins/<имя> подхватывается автоматически; править cli.json
   и opencode.json не нужно.
3. Перезапусти сервис: opencode service restart. Затем попроси меня заново
   открыть OpenCode (TUI подхватывает плагин при запуске).
4. Проверь, что нет ошибок плагина opencode.go-cost в
   ~/.local/share/opencode/log/opencode.log. Покажи мне, какая оценка должна
   быть в футере для текущей сессии OpenCode Go: она должна стоять на месте
   встроенной стоимости, сразу после счётчика токенов (например
   "470.3K (48%) · $0.17").

Действуй автономно. В конце кратко отчитайся: что установил, какие файлы
изменил. Если стоимость не появилась на месте встроенной — продиагностируй и
доведи до конца.
```

### Вариант 2. Вручную (Windows)

Запусти из корня репозитория:

```bat
install.bat
```

Скрипт скопирует `index.js`, `cost.js`, `history.js`, `patch.js`, `usage.js`,
`tui.tsx` и `package.json` в `%USERPROFILE%\.config\opencode\plugins\go-cost\`. Если задан
`XDG_CONFIG_HOME`, используется
`<XDG_CONFIG_HOME>\opencode\plugins\go-cost\`.

### Вариант 3. Вручную (Linux / macOS)

```bash
mkdir -p ~/.config/opencode/plugins/go-cost
cp plugin/index.js plugin/cost.js plugin/history.js plugin/patch.js plugin/usage.js plugin/tui.tsx plugin/package.json \
  ~/.config/opencode/plugins/go-cost/
```

После установки перезапусти сервис:

```bash
opencode service restart
```

Затем заново открой OpenCode: TUI подхватывает плагины при запуске.
`cli.json` и `opencode.json` менять не нужно — каталог `plugins/<имя>`
загружается автоматически.

## Использование

1. Открой сессию, в которой выбрана модель OpenCode Go и уже есть токены.
2. Стоимость появится на месте встроенной — сразу после счётчика токенов,
   в обычном формате USD: `470.3K (48%) · $0.17`. Та же сумма видна в
   боковой панели в поле «spent» (Context): и футер, и сайдбар читают один и
   тот же `context.data.session.cost`.
3. Отдельной метки и клика нет — это ровно то место, где OpenCode показывает
   стоимость у других провайдеров.

Для корневой сессии сумма складывается из оценки самой сессии и её
субагентов; субагент показывает только свою оценку. Каждое сообщение считается
по своей модели. Переключение модели меняет цену только следующих сообщений;
уже созданная история не пересчитывается по новой модели. Если встроенная
стоимость сообщений другого провайдера уже известна, она включается в общий
итог без повторного оценивания.

Fallback (только если объект данных заморожен и метод не перезаписывается):
в конце `prompt.footer.status` появляется метка `≈$0.12` с **недостающей**
оценкой Go для сессии и её субагентов. Нативная стоимость OpenCode остаётся на
месте и не дублируется. По клику открывается диалог с разбивкой по моделям,
сообщениям, тарифам, ценам и итогом.

Значение обновляется при добавлении сообщений и не зависит от того, какая
модель сейчас выбрана для следующих ответов. Если сессия никогда не использовала
Go, плагин возвращает нативное значение. Перезапуск не нужен: данные читаются
при каждой отрисовке.

## Проверка

Автономные тесты (без OpenCode). Должны пройти все четыре файла:

```bash
node tmp/test-cost.mjs
node tmp/test-history.mjs
node tmp/test-patch.mjs
node tmp/test-usage.mjs
```

Ожидаемый вывод `test-cost.mjs`:

```
ok: base tier real DeepSeek Go example
ok: output + reasoning billed as output
ok: context tier selection (strict >, largest wins)
ok: base fallback below tier
ok: hasPricing and tokensTotal
ok: estimateSessionCost rules
ok: message history keeps each model's own tokens and prices
ok: context tiers are selected per message
ok: reported message costs and mixed providers are preserved
ok: fallback sums only estimated Go costs across the family
ok: formatCost

all tests passed
```

Ожидаемый вывод `test-history.mjs`:

```
ok: all message pages are fetched and reversed
ok: duplicate message IDs are deduplicated
ok: live message updates merge without duplication
ok: long mixed-model histories include every page
ok: a stuck message cursor is rejected
ok: malformed message pages are rejected

all tests passed
```

Ожидаемый вывод `test-patch.mjs`:

```
ok: root session sums its Go subagent family
ok: positive native cost is returned untouched
ok: subagent estimates only itself
ok: non-Go session stays at zero
ok: restore brings the original method back
ok: frozen and non-writable session objects are rejected
ok: failures inside the override never throw
ok: model switching preserves per-message historical costs
ok: positive native costs do not hide Go estimates
ok: empty loaded history does not use the legacy estimate
ok: message cache is synced and then priced from history
ok: partial family history retains native member costs
ok: root native cost is separated from child estimates
ok: rejected message syncs are retried
ok: partial native and estimated costs are additive
ok: full history is not bypassed by a positive native cost
ok: native family cost survives a member catalog error
ok: incomplete family histories keep the native total
ok: switched-away member failures block partial family totals
ok: unresolved family members block full-history totals

all tests passed
```

Ожидаемый вывод `test-usage.mjs`:

```
usage.js: ok
```

Синтаксическая проверка чистых модулей:

```bash
node --check plugin/cost.js
node --check plugin/history.js
node --check plugin/patch.js
node --check plugin/usage.js
node --check plugin/index.js
```

Проверка в TUI:

1. Открой сессию OpenCode Go с ненулевыми токенами. В футере стоимость
   должна стоять на месте встроенной: `470.3K (48%) · $0.17`, без `≈`.
2. Сверь сумму с ручным расчётом по формуле выше и ценам каталога.
3. Открой боковую панель Context — «spent» должен показывать ту же сумму.
4. В правой панели должен появиться блок `OpenCode Go` с тремя лимитами,
   процентами и обратным отсчётом. Проценты должны совпадать с Console
   (Activity → Overview).
5. Переключись на модель с другой ценой — стоимость уже созданных сообщений
   не должна измениться. После нового ответа она должна увеличиться только на
   стоимость этого ответа.
6. Переключись на другого провайдера — нативные стоимости его сообщений должны
   сохраниться, а оценка прежних Go-сообщений — не исчезнуть.
7. Для сессии, в которой никогда не было Go, значение не меняется.

Проверка ошибок загрузки:

```powershell
Select-String -Path "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern "go-cost" | Select-Object -Last 20
```

В логе не должно быть ошибок плагина `opencode.go-cost`.

## Ограничения

- Сумма считается по **прайс-листу каталога моделей**, а не по счёту
  провайдера. Скидки, акции, округления и изменения цен могут расходиться с
  фактической оплатой.
- Плагин работает **только для `opencode-go`**. Для остальных провайдеров
  используются только их реальные `message.cost`; если Go в истории не было,
  плагин возвращает нативную стоимость без изменений.
- Подмена опирается на `context.data.session.cost`, публичный
  `context.client.message.list()` для полной истории и реактивный
  `context.data.session.message.list()` для live-обновлений. Если объект
  заморожен или метод переименуют, плагин откатится на fallback-метку `≈$…`.
- Если модель отсутствует в каталоге, у неё нет цен или все цены нулевые,
  соответствующее сообщение не добавляет оценку.
- Если в каталоге нет контекстных tier-записей, используется базовая цена.
- Если публичный API полной истории недоступен, остаётся резервная оценка по
  суммарным `session.tokens` и текущей модели. TUI-кэш сам по себе содержит
  только последнюю страницу, поэтому для точной истории нужен cursor API.
- Пока в сессии нет токенов, стоимость остаётся нулевой.
- `tui.tsx` компилирует сам OpenCode; отдельного шага сборки в проекте нет.

## Удаление

1. Удали каталог `<config>/plugins/go-cost/`.
2. Перезапусти сервис: `opencode service restart` и заново открой OpenCode.

Оценка пропадёт. Плагин при выгрузке сам возвращает исходный
`session.cost`; встроенный футер и конфиги не менялись, поэтому возвращать
ничего не нужно.

## Ссылки

- [OpenCode V2 — плагины](https://opencode.ai/v2/docs/build/plugins)
- [OpenCode V2 — плагины TUI](https://opencode.ai/v2/docs/build/plugins/cli)
- [Каталог моделей и цены](https://models.dev/)
- [OpenCode V2 — документация](https://opencode.ai/v2/docs/)

## Лицензия

MIT — см. [LICENSE](LICENSE).
