# react-ui-expert — справочник

Сверено 2026-11-03 по репозиторию вендора. Команды и пин — снимок на эту дату; перед обновлением копии сверить с первоисточником.

## Stageshow — локальная копия, читается через `Read`

Faux product UI для маркетинговых поверхностей web: hero лендинга, карточка фичи, bento-сетка, анимация с курсором на 10–16 с. Не для продакшен-интерфейса приложения и не для скриншотов стора (там нужен реальный UI).

Скилл лежит **вне** каталога скиллов, по схеме `agents/video-expert/README.md`: описание не попадает в контекст главного, инструмент `Skill` его не видит.

| Что | Путь |
|---|---|
| Корень | `~/.claude/agent-memory/react-ui-expert/vendor/stageshow/` (gitignored) |
| Вход | `SKILL.md` — читать первым, целиком |
| Правила кадра, сюжета, моушена | `references/framing.md`, `craft.md`, `motion.md`, `teaching.md` (источник: дерево копии) |
| Кит | `kit/` — копируется в проект, импорт из `kit/index.ts` (источник: дерево копии) |
| Пин | `benjitaylor/skills@802057409787133703c56001080169e347305572` (2026-10-31), пакет `0.1.0` |
| Лицензия | MIT на код. `assets/app-icons.ts` и часть `kit/brands/*.svg` под чужими лицензиями и товарными знаками (источник: `NOTICE.md` копии) — в проект клиента не копировать без проверки, в публичный `~/.claude` не класть |

Как работать:
- Копия ставится **архивом без `.git`**: guard изоляции worktree не даёт `git -C` в каталоги под `~/.claude`.
- Playground: `npm --prefix <корень> run dev -- --port 5199 --strictPort`. На Windows `portless` не стартует, Vite поднимается напрямую — адрес `http://127.0.0.1:5199`.
- Снимок gold-примера: `node <корень>/scripts/film.mjs "http://127.0.0.1:5199/?capture=<gold>" --select "#example" --still --out <scratchpad>/gold.png`. Без `--still` и с `--gate` — contact sheet всего цикла.
- `kit/brands/` из копии кита не удалять: его импортируют `kit/index.ts:38` и `kit/parts/BrandMark.tsx:3` копии, без каталога кит не собирается. Логотип в сцене клиента — только с лицензией и правом на товарный знак по `kit/brands/SOURCES.md` (источник: дерево копии).
- Свою сцену собирать в `<корень>/examples/<имя>/` (playground подхватывает), после прохода переносить в проект и править путь импорта кита.
- Product studies (Figma, Slack, Gmail и др.) — только механика взаимодействия. Чужой бренд и trade dress в сцену клиента не переносить.
- Кит на plain CSS со своим namespace классов. В проекте на Tailwind 4 он живёт рядом; токены продукта мапить по `references/looks.md` (источник: дерево копии). Совместимость с React 19 автор не заявляет явно («React 18 and later») — первый перенос в проект проверить typecheck и сборкой.
- Рядом с компонентом — `REHEARSAL.md` по шаблону `references/verify.md` (источник: шаг 7 `SKILL.md` копии).

Проверено 2026-11-03 на этой машине: `npm ci` (73 пакета; postinstall `esbuild` заблокирован npm, Vite работает без него), `npm run typecheck`, `npm run check:css` — зелёные; `film.mjs --still` и `--gate` по `hero-demo` снимают кадры (источник: `scripts/film.mjs` копии, прогон 2026-11-03).

Грабли:
- **`--gate` красный на gold-примере автора** (`hero-demo`: 5 строк «never-intentional» и 28 пропусков выборки больше 27 мс; источник: вывод `film.mjs --gate` 2026-11-03). Красный gate своей сцены сравнивать с gate её gold-примера, а не с нулём; пропуски выборки — от нагрузки машины, смотреть кадры глазами.
- Grep-тул не видит копию: каталог агентной памяти в `.gitignore` (источник: `git check-ignore -v` 2026-11-03). Искать по конкретному файлу (`path` на файл) или читать `Read`.
- MP4 из сцены `film.mjs` не делает. Маршрут `?capture=<сцена>` держит нативные часы (источник: `playground/main.tsx:14-16` копии) — для кадров видео он не годится. Виртуальные часы ставит маршрут `?embed=<сцена>` (`main.tsx:21-32`), и они доступны как `window.__stageshow.clock` (`kit/clock.ts:263`). Путь для `@video-expert`: открыть `?embed=<сцена>`, на каждый кадр `await window.__stageshow.clock.step(1)` и снимок, затем ffmpeg по `~/.claude/skills/ui-demo-video/references/render-pipeline.md`. Не проверено end-to-end: как embed-маршрут ведёт себя без родительского iframe. На первом запуске снять кадр N дважды и сравнить.

Обновление копии (когда автор выпустит заметные изменения; пин сменить в таблице выше):

```bash
gh api repos/benjitaylor/skills/commits/main --jq .sha
gh api repos/benjitaylor/skills/tarball/<sha> > <scratchpad>/stageshow.tar.gz   # источник: GitHub REST API, запуск 2026-11-03
rm -rf ~/.claude/agent-memory/react-ui-expert/vendor/stageshow && mkdir -p ~/.claude/agent-memory/react-ui-expert/vendor/stageshow
tar --force-local -xzf <scratchpad>/stageshow.tar.gz -C ~/.claude/agent-memory/react-ui-expert/vendor/stageshow --strip-components=2 --wildcards '*/stageshow/*'
npm --prefix ~/.claude/agent-memory/react-ui-expert/vendor/stageshow ci --no-audit --no-fund
```

`--force-local` обязателен в Git Bash: без него tar читает `C:` как удалённый хост.
