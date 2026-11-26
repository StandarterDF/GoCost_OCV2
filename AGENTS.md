# AGENTS.md — архитектура OpenCode_GoCost

## Назначение

TUI-плагин OpenCode V2, который показывает в футере сессии оценку стоимости
для провайдера **OpenCode Go** (`opencode-go`). В OpenCode 2.2.5 такие сессии
приходят с `session.cost = 0`, а встроенный футер рисует стоимость только при
`session.cost > 0`. Плагин считает сумму по истории сообщений и ценам каталога
моделей и подменяет общий метод `context.data.session.cost`, поэтому оценка
встаёт на место встроенной стоимости — сразу после счётчика токенов:

```
470.3K (48%) · $0.17
```

Формат — родной для OpenCode (`Intl.NumberFormat`, `style: "currency"`,
`currency: "USD"`), без префикса `≈` и без второй метки. Тот же метод читает
встроенный компонент Context в боковой панели, поэтому «spent» там тоже
показывает оценку. Сам расчёт локальный; полная история загружается через
`client.message.list()`, а лимиты Go панель обновляет через OpenCode Console API
(см. ниже).

Если объект данных заморожен и метод не перезаписывается, плагин
откатывается на прежнее поведение: метка `≈$0.12` в `prompt.footer.status` и
диалог с расшифровкой по клику.

Кроме стоимости, плагин показывает в правой панели лимиты подписки OpenCode Go
(5-часовое окно, неделя, месяц) с процентами, полосами и обратным отсчётом.
Данные берутся из `context.data.location.usage.limits(location)` — того же
кэша, который читает встроенный диалог Usage.

## Файлы

| Файл | Роль |
|---|---|
| `plugin/tui.tsx` | TUI-плагин. `Plugin.define({ id, setup })`: слот `sidebar.content` с лимитами Go, подмена `session.cost`, cleanup. Fallback — слот `prompt.footer.status` и диалог по клику. |
| `plugin/patch.js` | Подмена общего метода стоимости: `installCostOverride(data, estimate, options)` → restore или `undefined`. Без импортов OpenCode. |
| `plugin/cost.js` | Чистая логика: `pickCostTier`, `estimateCost`, `hasPricing`, `formatCost`, `estimateMessagesCost`, `sumEstimatedCosts`, `estimateSessionCost`, `tokensTotal`. Без импортов OpenCode. |
| `plugin/history.js` | Полная загрузка истории через `client.message.list()` и слияние live-обновлений по message ID. Без импортов OpenCode. |
| `plugin/usage.js` | Чистая логика панели лимитов: `USAGE_WINDOWS`, `meterPercent`, `meterTone`, `barFill`, `formatReset`, `resetLabel`, `usageRows`, `usageSummary`, `BAR_WIDTH`. Без импортов OpenCode. |
| `plugin/index.js` | Серверная заглушка: чтобы каталог был корректным пакетом и был виден в `opencode plugin list`. Ничего не делает. |
| `plugin/package.json` | `"type": "module"`, `main: index.js`, `exports` (`.`, `./tui`). |
| `opencode.json` | Проектный конфиг (только `$schema`). |
| `install.bat` | Копирует `plugin/` в глобальный каталог плагинов (Windows), учитывает `XDG_CONFIG_HOME`. |
| `tmp/test-cost.mjs` | Юнит-тесты `cost.js` на Node (`node tmp/test-cost.mjs`). |
| `tmp/test-history.mjs` | Юнит-тесты полной загрузки и слияния истории (`node tmp/test-history.mjs`). |
| `tmp/test-patch.mjs` | Юнит-тесты `patch.js` на моке общего data layer (`node tmp/test-patch.mjs`). |
| `tmp/test-usage.mjs` | Юнит-тесты `usage.js` на Node (`node tmp/test-usage.mjs`). |
| `README.md` | Описание, установка, формула, проверка, ограничения. |
| `CHANGES.md` | История версий. |
| `AGENTS.md` | Этот файл. |
| `LICENSE` | MIT. |

## Точка входа

`plugin/tui.tsx` экспортирует по умолчанию:

```ts
export default Plugin.define({
  id: "opencode.go-cost",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => <GoUsage context={context} sessionID={input.sessionID} />,
    })

    const restore = installCostOverride(context.data, estimateSessionCost)
    if (typeof restore === "function") return restore

    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <GoCost context={context} sessionID={input.sessionID} />,
    })
  },
})
```

Слот правой панели регистрируется всегда и не зависит от подмены
`session.cost`. В обычном пути `setup` дополнительно подменяет метод на общем
объекте данных и возвращает функцию восстановления (cleanup). Слот футера
создаётся лишь в fallback-ветке.

OpenCode (TUI) загружает `./tui` из каталога плагина. Для локального каталога
`Host.resolve` ищет файл `<dir>/tui` с расширениями `.ts/.tsx/.js/.jsx/...`,
поэтому имя файла — `tui.tsx`.

Серверная часть — пустая заглушка:

```js
export default {
  id: "opencode.go-cost",
  setup() {},
}
```

Она нужна только для корректного пакета и отображения в `opencode plugin
list`; вся логика находится в TUI-части.

## Поток данных

1. `setup(context)` сначала регистрирует слот `sidebar.content` (`GoUsage`),
   создаёт `createHistoryReader(context)`, затем вызывает
   `installCostOverride(context.data, estimate, { syncMessages: !history.canLoadAll })`,
   где `estimate` подмешивает полную историю в `estimateSessionCost`.
2. `installCostOverride` (`patch.js`) проверяет `data.session`,
   `session.cost` и `session.get`, сохраняет `original = session.cost` и
   присваивает `session.cost = patched`. Опция `syncMessages: false` отключает
   одностраничный data-sync, когда полная история загружается через client.
   Если присваивание бросило исключение или `session.cost !== patched`
   (замороженный или неперезаписываемый объект), возвращается `undefined` —
   тогда `setup` включает fallback.
3. Все TUI-плагины получают один и тот же `context.data` (`data: r.data` в
   фабрике контекста). Поэтому `patched` видят и встроенный футер
   (`opencode.prompt.footer`, он рендерит `usage.join(" · ")`), и встроенный
   компонент Context в боковой панели.
4. `createHistoryReader(context)` (`tui.tsx`) через `loadAllMessages()`
   (`history.js`) загружает все страницы `client.message.list()` с `limit: 200`
   и cursor. TUI-кэш содержит только последнюю страницу, поэтому он используется
   для live-обновлений, а не как полная история. Solid signal пересчитывает
   футер после завершения загрузки. Ошибки повторяются до `MAX_RETRIES` с
   задержкой `RETRY_MS`; до готовности всей семьи возвращается нативная сумма.
5. `patched(sessionID)` сначала вызывает `original.call(session, sessionID)`
   и сохраняет положительное значение как `base`. Если недоступны и TUI API
   сообщений, и полная загрузка через client, положительный `base` возвращается
   сразу. Иначе:
   - `info = session.get(sessionID)`; если сессии нет — вернуть `base`;
   - для субагента (`info.parentID`) список — `[sessionID]`, для корневой
     сессии — `unique([sessionID, ...session.family(sessionID)])`;
   - нативная стоимость root отделяется от суммы `item.cost` детей, чтобы при
     частично загруженной истории не потерять и не удвоить расходы;
   - для каждого id читаются `item`, каталог `item.location`, полная история
     `history.read()` и live-кэш `session.message.list(id)`;
   - `estimateSessionCost(item, models, messages)` считает assistant-сообщения
     и записи компактификации по их собственным моделям и tier. Положительная
     `message.cost` имеет приоритет над оценкой каталога;
   - для участника семьи берётся `max(native, reported) + estimated`: нативные
     расходы сохраняются даже вне загруженной страницы, а оценка Go не
     дублирует уже известные сообщения;
   - если хотя бы одно сообщение было от `opencode-go`, все полные истории
     семьи готовы и данные всех участников загружены, возвращается собранная
     сумма; иначе возвращается `base`.
6. Ошибки внутри `patched` не пробрасываются: сломанный `session.get`,
   отсутствующий каталог или бросающий оценщик дают нативное значение.
7. `setup` возвращает `restore`; при выгрузке плагина он присваивает
   `original` обратно, но только если `session.cost === patched` (чужую
   подмену не затирает).
8. Fallback (только если `installCostOverride` вернул `undefined`): слот
   `prompt.footer.status` с `append`. `GoCost` собирает ту же семью, вызывает
   `sumEstimatedCosts()` и рисует только недостающую оценку Go `≈$…` — нативная
   стоимость остаётся встроенным футером. Клик открывает диалог с разбивкой.

### Правая панель (лимиты Go)

1. `GoUsage` вычисляет локацию сессии:
   `session.location ?? context.data.location.default()`.
2. `info = context.data.location.usage.limits(location)` — тот же кэш, что у
   встроенного диалога Usage. `usage` может отсутствовать в старых сборках,
   вызов обёрнут в `try`.
3. `usageRows(info)` берёт `info.go` и возвращает окна в порядке
   `rolling → weekly → monthly`, пропуская отсутствующие.
4. Если `info === null` (не выполнен вход в Console) или `go === undefined`
   (нет тарифа Go), панель не рисуется. Пока данных нет (`undefined`), тоже
   ничего не показывается; после первого ответа `lastInfo` сохраняет снимок,
   чтобы `invalidate()` при обновлении не заставлял панель мигать.
5. `onMount` вызывает `load(true)`: `usage.invalidate(location)`, затем
   `usage.sync(location)`. Ошибка sync игнорируется — остаются кэшированные
   значения. Тот же `load(true)` вызывается после
   `session.execution.succeeded` для этой сессии и по клику на заголовок.
6. Локальные часы (`setInterval`, 30 с) обновляют только обратный отсчёт;
   проценты приходят из кэша.
7. Сворачивание: `context.storage.store("usage", { initial: {} })`,
   `view.open !== false` — открыто. Клик по заголовку переключает `▼` / `▶`
   и пишет состояние в storage; в свёрнутом виде справа от заголовка
   показывается `usageSummary(rows())` → `(monthly N%)`. Месячный лимит
   выбран намеренно: максимум часто оказывается недельным.
8. Отрисовка: заголовок `▼ OpenCode Go` (в свёрнутом виде `▶ OpenCode Go
   (monthly N%)`) и `↻`, затем по два ряда на окно —
   `label · N% used · Resets in <countdown>` и полоса из `█` / `░`.
   `BAR_WIDTH = 36` рассчитан на боковую панель шириной 42 колонки с
   двусторонним отступом 2.
9. Цвет: акцент темы (`theme.text.action.primary.$selected`) до 74 %,
   `warning` с 75 %, `error` с 90 % или при `meter.limited === true`. Именно
   акцент, а не `feedback.success`: в теме `orng` success специально синий.

## Формула (`plugin/cost.js`)

### Токены

`tokensTotal(tokens)` суммирует `input + output + reasoning + cache.read +
cache.write`. Используется только в резервной оценке по `session.tokens` и в
диалоге. Основной расчёт складывает токены отдельных assistant/compaction записей.

### Тариф

Правило применяется к токенам **одной assistant/compaction записи**:

```
total = tokens.input + tokens.cache.read + tokens.cache.write
```

- рассматриваются только записи с `tier.type === "context"`;
- tier применяется строго при `total > tier.size`;
- среди подходящих побеждает наибольший `tier.size`;
- иначе берётся базовая запись (`tier === undefined`);
- если нет ни того, ни другого — `undefined`.

`output` и `reasoning` в размер контекста не входят — так же, как в OpenCode.

### Стоимость

```
amount = (
    input * tier.input
  + (output + reasoning) * tier.output
  + cache.read * tier.cache.read
  + cache.write * tier.cache.write
) / 1_000_000
```

Цены каталога — USD за 1M токенов. Отсутствующие, отрицательные и нечисловые
поля считаются нулём; функция не возвращает `NaN`.

### Формат

В обычном пути `patched` возвращает число, а форматирует его встроенный футер:
`Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })` →
`$0.17`, `$1,234.50`, без `≈`.

`formatCost(value)` используется fallback-меткой и диалогом: `$0.00`,
`<$0.01` для положительных значений меньше цента, иначе тот же
`Intl.NumberFormat` с двумя знаками. Префикс `≈` добавляет только fallback-UI,
чтобы тесты проверяли чистые суммы.

## Условия показа (`estimateSessionCost`)

### Основной путь: история сообщений

`estimateMessagesCost(messages, models)`:

1. пропускает пользовательские сообщения и дубликаты по `message.id`;
2. для каждого assistant-сообщения и записи компактификации читает
   `message.model`, `message.tokens` и `message.cost`;
3. положительную `message.cost` использует как есть (включая другие
   провайдеры);
4. нулевую стоимость записи `opencode-go` оценивает по цене её модели;
5. возвращает `{ amount, hasGo, reported, estimated, messageCount, tokens,
   breakdown }` либо `undefined`, если cost-bearing записей нет.

`hasGo === true` означает, что в истории был OpenCode Go. `patched` суммирует
историю всей семьи и возвращает собранную сумму только при `hasGo`; для чистых
не-Go сессий остаётся нативная стоимость. `sumEstimatedCosts()` используется
только fallback-меткой: она складывает `estimated` по семье и исключает
`reported`, который уже показывает встроенный футер.

### Резервный путь: API истории недоступен

Оценка по `session.tokens` строится, только если:

1. `session` — объект;
2. `session.model.providerID === "opencode-go"`;
3. `Number(session.cost)` не является положительным числом;
4. `session.tokens` есть и `tokensTotal(tokens) > 0`;
5. модель найдена в каталоге по `providerID` и `id`/`modelID`;
6. `hasPricing(model.cost)` и итоговая сумма больше нуля.

Этот путь может приблизительно оценивать историю после смены модели, поэтому
используется только когда API сообщений отсутствует или бросает исключение.
Если доступен хотя бы TUI-кэш, его записи имеют приоритет; полная точность
обеспечивается cursor API.

## Константы

| Константа | Значение | Смысл |
|---|---|---|
| `OPENCODE_GO_PROVIDER` (`cost.js`) | `"opencode-go"` | Провайдер, для которого работает плагин. |
| `TOKENS_PER_MILLION` (`cost.js`) | `1_000_000` | Цены каталога заданы за 1M токенов. |
| `TITLE` (`tui.tsx`) | `"OpenCode Go: стоимость сессии"` | Заголовок fallback-диалога. |
| `PANEL_TITLE` (`tui.tsx`) | `"OpenCode Go"` | Заголовок панели лимитов. |
| `CLOCK_MS` (`tui.tsx`) | `30_000` | Период локального пересчёта обратного отсчёта. |
| `RETRY_MS` (`tui.tsx`) | `5_000` | Задержка между повторами загрузки истории/sync. |
| `MAX_RETRIES` (`tui.tsx`) | `3` | Максимум автоматических повторов для одной сессии. |
| `BAR_WIDTH` (`usage.js`) | `36` | Ширина полосы в колонках (сайдбар 42 − отступы 4 − запас 2). |

## Внешние зависимости

Нет. TUI-плагин импортирует `@opencode/plugin/tui` и `solid-js` — их
резолвит рантайм OpenCode. `cost.js`, `history.js`, `usage.js` и `patch.js` не
импортируют ничего. Расчёт стоимости локальный; полная история загружается по
страницам через `client.message.list()`, live-обновления читаются из data layer,
панель лимитов обновляется через OpenCode Console API, когда видима.

## Архитектурные ограничения

- Сумма — **оценка по каталогу**, а не счёт провайдера. Скидки и изменения
  цен могут расходиться с фактической оплатой.
- Для чистых не-Go сессий `patched` возвращает нативную стоимость. В смешанной
  сессии реальные `message.cost` других провайдеров складываются с оценкой
  нулевых Go-сообщений.
- Подмена завязана на то, что `context.data.session.cost` — обычное
  записываемое свойство. Если OpenCode заморозит объект данных или
  переименует метод, сработает fallback-метка.
- Основной расчёт зависит от публичного `context.client.message.list()` для
  полной истории, реактивного `context.data.session.message.list()` для
  live-обновлений и форм assistant/compaction (`model`, `tokens`, `cost`). TUI-кэш
  сам по себе содержит только последнюю страницу. При недоступности API истории
  используется приблизительная оценка по `session.tokens` и текущей модели.
- Панель лимитов завязана на experimental-API
  `context.data.location.usage` (`limits`/`sync`/`invalidate`) и форму
  `UsageLimits.Info` (`go.rolling|weekly|monthly`). Если API переименуют или
  уберут, панель просто не отрисуется; стоимость продолжит работать.
- Если модель отсутствует в каталоге, все цены нулевые или токенов нет,
  соответствующее сообщение не добавляет оценку.
- Формула и правило tier завязаны на поведение OpenCode 2.4.1. При изменении
  API (`session.get`, `session.family`, `session.message.list/sync`,
  `client.message.list`, `location.model.list`, assistant/compaction messages,
  `ModelCost`, `location.usage`) файлы `tui.tsx`, `history.js`, `patch.js`,
  `cost.js` и `usage.js` нужно обновить.
- `dialog.alert` — простой текстовый диалог fallback-режима; richer UI не
  используется.
- `tui.tsx` проверяется сборкой esbuild и рантаймом OpenCode; отдельного шага
  сборки в репозитории нет.
