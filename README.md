# Telegram-бот для расчета базиса какао

Бот сравнивает российский фьючерс на какао на MOEX с зарубежным рынком после закрытия внешней сессии и показывает:

- справедливую цену локального контракта в рублях и долларах
- текущее отклонение локального контракта от справедливой цены
- рекомендацию `лонг / шорт / нейтрально`
- раскрывающийся блок с деталями расчета

## Источники данных

- локальное какао: в обычном режиме `MOEX ISS`, в live-режиме через `T-Bank Invest API`
- курс доллара: в обычном режиме `USDRUBF` из TradingView, в live-режиме через `T-Bank Invest API`
- зарубежное какао на закрытии: `COCOA` из TradingView
- ставка для расчетного базиса: ключевая ставка ЦБ РФ или ручной override через `.env`

По умолчанию бот работает с такими параметрами внешнего рынка:

- открытие: `11:45` МСК
- закрытие: `20:29` МСК
- праздники 2026 года: `2026-01-01,2026-01-19,2026-02-16,2026-04-03,2026-05-25,2026-06-19,2026-07-03,2026-09-07,2026-11-26,2026-12-25`

## Что считает бот

Модель построена вокруг базиса.

- `Локальный контракт в долларах = локальная цена × 1000 / курс доллара`
- `Текущий базис = локальный контракт в долларах - COCOA close`
- `Расчетный базис = COCOA close × ставка × дни до экспирации / база_дней`
- `Справедливая цена локального контракта в долларах = COCOA close + расчетный базис`
- `Справедливая цена локального контракта в рублях = курс доллара × справедливая цена в долларах / 1000`

Это не официальный биржевой базис, а рабочая carry-модель. Ее можно калибровать через `FAIR_BASIS_*` и `SIGNAL_*`.

## Команды

- `/start` или `/help` — показать краткую справку
- `/cocoa` — расчет с автоматически выбранным актуальным контрактом
- `/cocoa CCJ6` — разовый расчет по конкретному MOEX-контракту

Без аргументов бот сам выбирает ближайший неистекший контракт по `RU_COCOA_ASSET_CODE`.

## Локальный запуск

1. Скопируйте `.env.example` в `.env`.
2. Заполните `BOT_TOKEN`.
3. При необходимости поправьте символы, время внешнего рынка и список праздников.
4. Установите зависимости и запустите бота.

```bash
pnpm install
pnpm dev
```

Для production-запуска без Docker:

```bash
pnpm build
pnpm start
```

Локальный запуск использует файл `.env` в корне проекта.

## Основные переменные `.env`

- `BOT_TOKEN` — токен Telegram-бота
- `RU_COCOA_ASSET_CODE` — код базового актива MOEX для автопоиска контрактов
- `TV_USDRUBF_SYMBOL` — fallback-символ курса доллара в TradingView для обычного режима
- `TV_WORLD_COCOA_SYMBOL` — символ зарубежного какао в TradingView
- `LIVE_QUOTES_ENABLED` — включает live-режим для локального какао и `USDRUBF` через `T-Bank Invest API`
- `TBANK_API_TOKEN` — токен `T-Bank Invest API`
- `TBANK_API_BASE_URL` — базовый URL REST API `T-Bank Invest`
- `TBANK_FUTURES_CLASS_CODE` — class code фьючерсов для запросов по тикеру, по умолчанию `SPBFUT`
- `TBANK_USDRUB_SYMBOL` — тикер долларового фьючерса для live-режима
- `TBANK_ORDERBOOK_DEPTH` — глубина стакана для live-режима
- `FOREIGN_OPEN_TIME_MSK` — время открытия внешнего рынка в формате `HH:mm`
- `FOREIGN_CLOSE_TIME_MSK` — время закрытия внешнего рынка в формате `HH:mm`
- `FOREIGN_MARKET_SESSION_CHECK_ENABLED` — включает блокировку расчета во время торгов внешнего рынка; для временного отключения можно поставить `false`
- `FOREIGN_MARKET_HOLIDAYS_MSK` — полные праздничные нерабочие даты через запятую
- `FAIR_BASIS_RATE_PCT` — ручной override ставки; если пусто, ставка берется с сайта ЦБ РФ
- `FAIR_BASIS_DAY_COUNT` — база дней для carry-модели
- `CBR_KEY_RATE_CACHE_ENABLED` — включить кеш ставки ЦБ до конца московского дня
- `TV_WORLD_CLOSE_CACHE_ENABLED` — включить кеш закрытия `COCOA` до следующего открытия внешнего рынка
- `SIGNAL_NEUTRAL_SPREAD_RUB`, `SIGNAL_NEUTRAL_SPREAD_PCT` — пороги нейтральной зоны
- `SIGNAL_CAUTIOUS_SPREAD_RUB`, `SIGNAL_CAUTIOUS_SPREAD_PCT` — пороги осторожного сигнала
- `SIGNAL_STRONG_SPREAD_RUB`, `SIGNAL_STRONG_SPREAD_PCT` — пороги сильного сигнала
- `BOT_ALLOWED_CHAT_IDS` — необязательное ограничение списка чатов

Актуальные пороги из `.env.example`:

- нейтрально: `2.00 ₽` и `0.7%`
- осторожный сигнал: `2.80 ₽` и `1.0%`
- сильный сигнал: `4.90 ₽` и `1.75%`

## Docker Compose из исходников

Можно запускать бота через [compose.yaml](/Users/ma.martynov/work/t-cocoa/compose.yaml), собирая образ прямо на сервере.

В этом варианте:

- Docker-образ собирается локально из [Dockerfile](/Users/ma.martynov/work/t-cocoa/Dockerfile)
- `.env` лежит на сервере рядом с `compose.yaml`
- `node` и `pnpm` внутри хоста не обязательны

Команды:

```bash
docker compose build
docker compose up -d
docker compose logs -f
```

Обновление:

```bash
git pull
docker compose up -d --build
```

## GHCR и VPS без исходников

Проект публикует Docker-образ в GHCR через GitHub Actions:

- workflow: [publish-ghcr.yml](/Users/ma.martynov/work/t-cocoa/.github/workflows/publish-ghcr.yml)
- deploy compose: [compose.ghcr.yaml](/Users/ma.martynov/work/t-cocoa/compose.ghcr.yaml)
- образ: `ghcr.io/pe4enko/t-cocoa:latest`

В этом сценарии на VPS нужны только:

- Docker
- `compose.ghcr.yaml`
- `.env`

Файл `.env` должен лежать на файловой системе сервера рядом с `compose.ghcr.yaml`. Он не запекается в Docker-образ.

Запуск:

```bash
docker compose -f compose.ghcr.yaml pull
docker compose -f compose.ghcr.yaml up -d
```

Если пакет в GHCR приватный, перед этим нужен вход:

```bash
echo <GITHUB_PAT> | docker login ghcr.io -u pe4enko --password-stdin
```

Если пакет публичный, `docker login` не нужен.

Для обновления можно использовать скрипт [update-ghcr.sh](/Users/ma.martynov/work/t-cocoa/update-ghcr.sh):

```bash
chmod +x update-ghcr.sh
./update-ghcr.sh
```

С очисткой старых dangling images:

```bash
PRUNE_OLD_IMAGES=true ./update-ghcr.sh
```

## Важные замечания

- если `LIVE_QUOTES_ENABLED=true` и задан `TBANK_API_TOKEN`, локальное какао и `USDRUBF` берутся через `T-Bank Invest API`
- цены фьючерсов из `T-Bank` нормализуются до цены за единицу базового актива: для `USDRUBF` это курс за 1 доллар, для какао — цена за 1 кг
- для локального какао в live-режиме бот сначала пытается использовать лучшие `bid/ask`, а если стакан пустой, падает обратно на `last price`
- для `USDRUBF` в live-режиме бот берет прямой `last price` из `T-Bank`
- если `TBANK_API_TOKEN` не задан или `T-Bank Invest API` не ответил, бот автоматически возвращается к старым источникам
- через `LIVE_QUOTES_ENABLED=false` можно полностью отключить live-режим
- контракт выбирается автоматически как ближайший неистекший по `LASTTRADEDATE`
- если указать тикер вручную, например `/cocoa CCM6`, бот использует именно его
- `COCOA` по-прежнему берется как цена закрытия из TradingView, мы его не переводили на новый источник
- в интервале между открытием и закрытием внешнего рынка бот не строит расчет и просит дождаться закрытия
- если нужно временно разрешить расчет и во время внешней сессии, можно поставить `FOREIGN_MARKET_SESSION_CHECK_ENABLED=false`
- по выходным и праздникам внешний рынок считается закрытым, поэтому бот берет последнее закрытие предыдущего торгового дня
- в `FOREIGN_MARKET_HOLIDAYS_MSK` нужно указывать только полные нерабочие дни; ранние закрытия туда добавлять не нужно
- в каналах бот должен быть администратором, иначе он не сможет публиковать ответы
