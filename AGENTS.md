# AGENTS.md — архитектура OpenCode_GoCost

## Назначение

TUI-плагин OpenCode V2, который показывает в футере сессии оценку стоимости
для провайдера **OpenCode Go** (`opencode-go`). В OpenCode 2.2.5 такие сессии
приходят с `session.cost = 0`, а встроенный футер рисует стоимость только при
`session.cost > 0`. Плагин считает сумму по токенам сессии и ценам каталога
моделей и подменяет общий метод `context.data.session.cost`, поэтому оценка
встаёт на место встроенной стоимости — сразу после счётчика токенов:

```
470.3K (48%) · $0.17
```

Формат — родной для OpenCode (`Intl.NumberFormat`, `style: "currency"`,
`currency: "USD"`), без префикса `≈` и без второй метки. Тот же метод читает
встроенный компонент Context в боковой панели, поэтому «spent» там тоже
показывает оценку. Сеть не используется.

Если объект данных заморожен и метод не перезаписывается, плагин
откатывается на прежнее поведение: метка `≈$0.12` в `prompt.footer.status` и
диалог с расшифровкой по клику.

## Файлы

| Файл | Роль |
|---|---|
| `plugin/tui.tsx` | TUI-плагин. `Plugin.define({ id, setup })`: ставит подмену `session.cost`, возвращает cleanup. Fallback — слот `prompt.footer.status` и диалог по клику. |
| `plugin/patch.js` | Подмена общего метода стоимости: `installCostOverride(data, estimateSessionCost)` → restore или `undefined`. Без импортов OpenCode. |
| `plugin/cost.js` | Чистая логика: `pickCostTier`, `estimateCost`, `hasPricing`, `formatCost`, `estimateSessionCost`, `tokensTotal`. Без импортов OpenCode. |
| `plugin/index.js` | Серверная заглушка: чтобы каталог был корректным пакетом и был виден в `opencode plugin list`. Ничего не делает. |
| `plugin/package.json` | `"type": "module"`, `main: index.js`, `exports` (`.`, `./tui`). |
| `opencode.json` | Проектный конфиг (только `$schema`). |
| `install.bat` | Копирует `plugin/` в глобальный каталог плагинов (Windows), учитывает `XDG_CONFIG_HOME`. |
| `tmp/test-cost.mjs` | Юнит-тесты `cost.js` на Node (`node tmp/test-cost.mjs`). |
| `tmp/test-patch.mjs` | Юнит-тесты `patch.js` на моке общего data layer (`node tmp/test-patch.mjs`). |
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
    const restore = installCostOverride(context.data, estimateSessionCost)
    if (typeof restore === "function") return restore

    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <GoCost context={context} sessionID={input.sessionID} />,
    })
  },
})
```

В обычном пути `setup` ничего не регистрирует: он только подменяет метод на
общем объекте данных и возвращает функцию восстановления (cleanup). Слот
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

1. `setup(context)` вызывает
   `installCostOverride(context.data, estimateSessionCost)`.
2. `installCostOverride` (`patch.js`) проверяет `data.session`,
   `session.cost` и `session.get`, сохраняет `original = session.cost` и
   присваивает `session.cost = patched`. Если присваивание бросило исключение
   или `session.cost !== patched` (замороженный или неперезаписываемый
   объект), возвращается `undefined` — тогда `setup` включает fallback.
3. Все TUI-плагины получают один и тот же `context.data` (`data: r.data` в
   фабрике контекста). Поэтому `patched` видят и встроенный футер
   (`opencode.prompt.footer`, он рендерит `usage.join(" · ")`), и встроенный
   компонент Context в боковой панели.
4. `patched(sessionID)` сначала вызывает `original.call(session, sessionID)`.
   Положительное конечное значение возвращается без изменений. Иначе:
   - `info = session.get(sessionID)`; если сессии нет — вернуть `base` (0);
   - для субагента (`info.parentID`) список — `[sessionID]`, для корневой
     сессии — `unique([sessionID, ...session.family(sessionID)])` (нативный
     метод тоже суммирует семейство);
   - для каждого id: `item = session.get(id)`,
     `models = data.location?.model?.list?.(item.location) ?? []`,
     `estimateSessionCost(item, models)`; `{ amount }` прибавляется к сумме,
     битые записи пропускаются;
   - вернуть `total > 0 ? total : base`.
5. Ошибки внутри `patched` не пробрасываются: сломанный `session.get`,
   отсутствующий каталог или бросающий оценщик дают нативное значение.
6. `setup` возвращает `restore`; при выгрузке плагина он присваивает
   `original` обратно, но только если `session.cost === patched` (чужую
   подмену не затирает).
7. Fallback (только если `installCostOverride` вернул `undefined`): слот
   `prompt.footer.status` с `append`. `GoCost` реактивно читает
   `context.data.session.get(props.sessionID)` и каталог
   `context.data.location.model.list(session.location) ?? []`, вызывает
   `estimateSessionCost` и рисует `≈$0.12`; клик открывает
   `context.ui.dialog.alert` с моделью, токенами, тарифом, ценами и итогом.

## Формула (`plugin/cost.js`)

### Токены

`tokensTotal(tokens)` суммирует `input + output + reasoning + cache.read +
cache.write`. Используется как проверка «в сессии есть токены» и в диалоге.

### Тариф

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

Оценка строится, только если одновременно выполнено всё:

1. `session` — объект;
2. `session.model.providerID === "opencode-go"`;
3. встроенная стоимость отсутствует: `Number(session.cost)` не является
   положительным числом (при положительном — `undefined`);
4. `session.tokens` есть и `tokensTotal(tokens) > 0`;
5. у ссылки на модель есть `id` или `modelID`;
6. в каталоге есть запись с тем же `providerID` и совпадающим `id`/`modelID`;
7. `hasPricing(model.cost)` — хотя бы одна цена больше нуля;
8. итоговая сумма больше нуля.

Возвращает `{ amount, model }` или `undefined`.

`patched` вызывает оценщик только после того, как нативная стоимость
оказалась нулевой, и складывает результат по сессии и её семейству.

## Константы

| Константа | Значение | Смысл |
|---|---|---|
| `OPENCODE_GO_PROVIDER` (`cost.js`) | `"opencode-go"` | Провайдер, для которого работает плагин. |
| `TOKENS_PER_MILLION` (`cost.js`) | `1_000_000` | Цены каталога заданы за 1M токенов. |
| `TITLE` (`tui.tsx`) | `"OpenCode Go: стоимость сессии"` | Заголовок fallback-диалога. |

## Внешние зависимости

Нет. TUI-плагин импортирует `@opencode/plugin/tui` и `solid-js` — их
резолвит рантайм OpenCode. `cost.js` и `patch.js` не импортируют ничего.
Сеть не используется.

## Архитектурные ограничения

- Сумма — **оценка по каталогу**, а не счёт провайдера. Скидки и изменения
  цен могут расходиться с фактической оплатой.
- При `session.cost > 0` возвращается нативное значение: оценка не
  подмешивается и встроенный счётчик не искажается.
- Поддерживается только `opencode-go`; для других провайдеров `patched`
  возвращает ноль или нативную стоимость.
- Подмена завязана на то, что `context.data.session.cost` — обычное
  записываемое свойство. Если OpenCode заморозит объект данных или
  переименует метод, сработает fallback-метка.
- Если модель отсутствует в каталоге, все цены нулевые или токенов нет,
  стоимость остаётся нулевой.
- Токены берутся из `session.tokens` — это сумма по всей сессии. Если в
  сессии переключали модели, оценка использует цены текущей модели и потому
  приблизительна.
- Формула и правило tier завязаны на поведение OpenCode 2.2.5. При изменении
  API (`session.get`, `session.family`, `location.model.list`, `ModelCost`)
  файлы `tui.tsx`, `patch.js` и `cost.js` нужно обновить.
- `dialog.alert` — простой текстовый диалог fallback-режима; richer UI не
  используется.
- `tui.tsx` проверяется сборкой esbuild и рантаймом OpenCode; отдельного шага
  сборки в репозитории нет.
