# AGENTS.md — архитектура OpenCode_GoCost

## Назначение

TUI-плагин OpenCode V2, который добавляет в футер сессии оценку стоимости для
провайдера **OpenCode Go** (`opencode-go`). В OpenCode 2.2.5 такие сессии
приходят с `session.cost = 0`, а встроенный футер рисует стоимость только при
`session.cost > 0`. Плагин считает сумму по токенам сессии и ценам каталога
моделей и дописывает метку `≈$0.12` в `prompt.footer.status`.

Плагин ничего не заменяет и не отключает: встроенная часть футера остаётся на
месте, метка добавляется в конец. Сеть не используется.

## Файлы

| Файл | Роль |
|---|---|
| `plugin/tui.tsx` | TUI-плагин. `Plugin.define({ id, setup })`, слот `prompt.footer.status`, диалог по клику. |
| `plugin/cost.js` | Чистая логика: `pickCostTier`, `estimateCost`, `hasPricing`, `formatCost`, `estimateSessionCost`, `tokensTotal`. Без импортов OpenCode. |
| `plugin/index.js` | Серверная заглушка: чтобы каталог был корректным пакетом и был виден в `opencode plugin list`. Ничего не делает. |
| `plugin/package.json` | `"type": "module"`, `main: index.js`, `exports` (`.`, `./tui`). |
| `opencode.json` | Проектный конфиг (только `$schema`). |
| `install.bat` | Копирует `plugin/` в глобальный каталог плагинов (Windows), учитывает `XDG_CONFIG_HOME`. |
| `tmp/test-cost.mjs` | Юнит-тесты `cost.js` на Node (`node tmp/test-cost.mjs`). |
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
      append: "prompt.footer.status",
      render: (input) => <GoCost context={context} sessionID={input.sessionID} />,
    })
  },
})
```

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

1. `setup(context)` регистрирует слот `prompt.footer.status` с
   `append`, поэтому метка рисуется после встроенного содержимого.
2. `GoCost` реактивно читает выбранную сессию:
   `context.data.session.get(props.sessionID)` возвращает
   `SessionInfo | undefined`.
3. Второй `createMemo` читает каталог для локации сессии:
   `context.data.location.model.list(session.location) ?? []`. Оба мемо
   реактивны: смена модели, локации или сессии обновляет метку без перезапуска.
4. Третий `createMemo` вызывает
   `estimateSessionCost(session, models)` из `cost.js`.
5. `<Show when={estimate() !== undefined}>` не рендерит ничего, если условий
   нет. Иначе рисуется компактный `box` с текстом `≈$0.12`; весь `box`
   кликабелен.
6. Клик вызывает `context.ui.dialog.alert` с расшифровкой: модель, токены,
   выбранный тариф, цены за 1M и итоговая оценка. Ошибка диалога не ломает
   футер.

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

`formatCost(value)` отдаёт сумму без `≈`: `$0.00`, `<$0.01` для положительных
значений меньше цента, иначе `Intl.NumberFormat("en-US", …)` с двумя знаками
(`$0.12`, `$1,234.50`). Префикс `≈` добавляет UI, чтобы тесты проверяли
чистые суммы.

## Условия показа (`estimateSessionCost`)

Метка строится, только если одновременно выполнено всё:

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

## Константы

| Константа | Значение | Смысл |
|---|---|---|
| `OPENCODE_GO_PROVIDER` (`cost.js`) | `"opencode-go"` | Провайдер, для которого работает плагин. |
| `TOKENS_PER_MILLION` (`cost.js`) | `1_000_000` | Цены каталога заданы за 1M токенов. |
| `TITLE` (`tui.tsx`) | `"OpenCode Go: стоимость сессии"` | Заголовок диалога. |

## Внешние зависимости

Нет. TUI-плагин импортирует `@opencode/plugin/tui` и `solid-js` — их
резолвит рантайм OpenCode. `cost.js` не импортирует ничего. Сеть не
используется.

## Архитектурные ограничения

- Сумма — **оценка по каталогу**, а не счёт провайдера. Скидки и изменения
  цен могут расходиться с фактической оплатой.
- Плагин намеренно молчит при `session.cost > 0`: встроенный футер уже
  показывает стоимость, дублировать её нельзя.
- Поддерживается только `opencode-go`; для других провайдеров метка не
  рисуется.
- Если модель отсутствует в каталоге, все цены нулевые или токенов нет,
  метки нет.
- Токены берутся из `session.tokens` — это сумма по всей сессии. Если в
  сессии переключали модели, оценка использует цены текущей модели и потому
  приблизительна.
- Формула и правило tier завязаны на поведение OpenCode 2.2.5. При изменении
  API (`session.get`, `location.model.list`, `ModelCost`) файлы `tui.tsx` и
  `cost.js` нужно обновить.
- `dialog.alert` — простой текстовый диалог; richer UI не используется.
- `tui.tsx` проверяется сборкой esbuild и рантаймом OpenCode; отдельного шага
  сборки в репозитории нет.
