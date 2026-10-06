# video-expert — справочник

Сверено 2026-10-06 (скаут по README и докам вендоров). Цифры и команды — снимок на эту дату: перед обновлением копии и публикацией сверить с первоисточником, по памяти не воспроизводить.

## Скиллы движков — локальная копия, читаются через `Read`

Решение пользователя 2026-10-06: скиллы доступны агенту, но их описания не попадают в контекст главного. Поэтому они лежат **вне** каталога скиллов — в gitignored `~/.claude/agent-memory/video-expert/vendor/` (sparse-клоны, только каталог `skills/`), а агент открывает `SKILL.md` по пути. Инструмент `Skill` их не видит, и это намеренно.

| Движок | Корень скиллов | Вход | Лицензия на 2026-10-06 |
|---|---|---|---|
| HyperFrames (дефолт) | `~/.claude/agent-memory/video-expert/vendor/hyperframes/skills/` | `hyperframes/SKILL.md` — роутер, читать первым | Apache-2.0, 21 скилл; CLI `npx hyperframes …` (Node 22+, FFmpeg) |
| Remotion | `~/.claude/agent-memory/video-expert/vendor/remotion-skills/skills/` | `remotion-best-practices/SKILL.md` — роутер | репозиторий скиллов без лицензии (поэтому не в публичном репо); сам Remotion бесплатен физлицам, некоммерческим и компаниям ≤3 человек, больше — Company License (remotion.pro/license) |
| ui-demo-video (свой) | `~/.claude/skills/ui-demo-video/` | `SKILL.md`, рендер — `references/render-pipeline.md` | — |

Как читать:
- Ссылка `/name` внутри скилла HyperFrames означает файл `<корень>/name/SKILL.md`; относительные пути (`references/…`, `../media-use/…`) — от каталога текущего скилла.
- Частые входы HyperFrames: промо по URL или брифу — `product-launch-video`; короткая типографика, стат, логотип — `motion-graphics`; субтитры к готовому видео — `embedded-captions`; объяснялка без съёмки — `faceless-explainer`; остальное — `general-video`. Контракт композиции — `hyperframes-core` (читать до первой строки HTML), CLI — `hyperframes-cli`.
- **Скиллы никуда не ставить.** Не запускать `npx hyperframes skills update`, `npx hyperframes skills`, `npx skills add` — роутер HyperFrames просит их на шаге «Install and enter the workflow». `npx hyperframes init` тоже ставит core-набор скиллов (`hyperframes-cli/references/init-and-scaffold.md`; флаг `--skip-skills` временно игнорируется) — поэтому **каждая** команда `npx hyperframes …` идёт с `HYPERFRAMES_SKIP_SKILLS=1`. Иначе скиллы попадают в общий или проектный каталог, и их описания уезжают в контекст главного. Все 21 скилл уже лежат в копии.
- Копия читается роутером как standalone-установка (`plugin.json` в sparse-копию не попадает) — шаги «plugin installs» и «Keep the project's CLI current» про скиллы не относятся к нам; `upgrade --check` CLI-пина в проекте — можно, с той же переменной.
- Workflow HyperFrames ждут одобрений пользователя (план, скетчи, «render only after approval») и открывают Studio preview. Субагент работает в autonomous mode: бриф заменяет интервью и одобрения, preview не запускается.
- Каталога нет — `STATUS: NEEDS_INPUT` с командами из «Обновление копии».

Обновление копии (раз в месяц или когда скилл ссылается на отсутствующий файл):

```bash
# обновить (shallow-клон: pull падает на «unrelated histories», поэтому fetch + reset; sparse-шаблон сохраняется)
cd ~/.claude/agent-memory/video-expert/vendor
for r in hyperframes remotion-skills; do git -C $r fetch --depth 1 origin && git -C $r reset --hard FETCH_HEAD; done
# с нуля:
mkdir -p ~/.claude/agent-memory/video-expert/vendor && cd ~/.claude/agent-memory/video-expert/vendor
git clone --depth 1 --filter=blob:none --sparse https://github.com/heygen-com/hyperframes.git hyperframes
git clone --depth 1 --filter=blob:none --sparse https://github.com/remotion-dev/skills.git remotion-skills
MSYS_NO_PATHCONV=1 git -C hyperframes sparse-checkout set --no-cone '/skills/'
MSYS_NO_PATHCONV=1 git -C remotion-skills sparse-checkout set --no-cone '/skills/'
```

`--filter=blob:none` обязателен: без него `.git` HyperFrames весит ~600 МБ, с ним — десятки МБ. Шаблон `'/skills/'` — с ведущим слешем, иначе в копию попадают служебные `.claude/skills/` репозитория; `MSYS_NO_PATHCONV=1` нужен в Git Bash, иначе слеш превращается в путь Windows.

Грабли:
- HyperFrames на Windows: ниже v0.7.27 `npx spawn` без `shell:true` падал молча — брать свежий релиз.
- HyperFrames без `chrome-headless-shell` откатывается в медленный screenshot-режим (вторичный источник, сверить в доке): поставить `chrome-headless-shell` либо явно `PRODUCER_FORCE_SCREENSHOT=true`.
- Remotion не видит CSS-анимации и Tailwind `animate-*`: всё движение через `useCurrentFrame()` / `interpolate()`. Сайт с CSS-сценой в Remotion не переносить — это переписывание.
- Playwright `page.clock` CSS-анимации не останавливает — перемотка через `document.getAnimations()`.
- Claude Design: нативный экспорт MP4 не подтверждён официальным списком (противоречие вторичных источников) — проверять в интерфейсе, а не обещать.

## Что Opus 5.5 видит

- Вход — только картинки (JPEG/PNG/GIF/WebP), у GIF читается первый кадр. Видеофайл на вход не подаётся: ролик проверяется кадрами `ffmpeg -ss <t> -i out.mp4 -frames:v 1 f.png`.
- До 600 картинок на запрос; длинная сторона до 2576 px, при >20 картинках — ужимать до 2000 px. Контакт-лист (`ffmpeg -vf "fps=2,scale=360:-1,tile=6x4"`) дешевле десятков отдельных кадров для проверки темпа.
- Источник: platform.claude.com/docs/en/build-with-claude/vision.

## Форматы и кодирование

| Куда | Кадр | fps | Длина |
|---|---|---|---|
| Reels / Shorts / TikTok | 1080×1920 (9:16) | 30 | 7–30 с, петля или CTA в конце |
| Пост в ленту | 1080×1350 (4:5) или 1080×1080 | 30 | до 60 с |
| Сайт, hero | живая сцена, а не `<video>` (см. `ui-demo-video`) | — | петля 10 с × N |
| YouTube / презентация | 1920×1080 | 30 / 60 | по сценарию |

- Кодек по умолчанию: H.264 `yuv420p`, `-profile:v high -movflags +faststart`, CRF 18–22; для веба рядом WebM VP9. `yuv444p` / `high444` не брать — Safari и часть плееров не играют.
- Цветовая разметка обязательна: `out_range=limited:out_color_matrix=bt709` в scale и теги `-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv`, иначе плееры сдвигают контраст. Детали и проверенный pipe — `~/.claude/skills/ui-demo-video/references/render-pipeline.md`.
- Звук: `-c:a aac -b:a 192k -ar 48000`; громкость под соцсети около −14 LUFS (`loudnorm=I=-14:TP=-1.5:LRA=11`). Без звука — `-an`, а не тихая дорожка.

## Safe zones 9:16 (1080×1920)

Сводка вторичных источников 2026, первоисточники платформ не сверены — закладывать с запасом и сверять на дату публикации:
- общая безопасная зона ≈ 900×1400 по центру;
- Reels: низ ≥ 440–500 px, справа ≥ 120 px;
- Shorts: верх и низ ≥ 380 px;
- TikTok: справа ≈ 120 px, снизу ≈ 20 % кадра.

## Ремесло (общая практика, не сверено первоисточниками)

- Хук в первые 1–1,5 с: результат, вопрос или движение в первом кадре; логотип и заставка в начале убивают досмотр.
- Одна мысль — один кадр. Смена плана или акцент каждые 1,5–3 с в рилсе; в объяснялке — по смыслу, но без статики дольше 4 с.
- Текст на экране: строка до ~6–7 слов, держится на экране не меньше времени чтения (≈ 0,3 с на слово, минимум 1,5 с); 1–2 шрифта; контраст ≥ 4,5:1.
- Большинство смотрит без звука: смысл несут текст и субтитры, звук усиливает. Субтитры вжигать в кадр для соцсетей.
- Движение с easing (ease-out на появление, ease-in на уход), без линейных переходов; одна «звезда» движения в кадре.
- Финал — CTA или петля: последний кадр стыкуется с первым без скачка.
- Музыка, голос, шрифты, стоковые кадры — только с подтверждённой лицензией; TTS-голос не выдавать за живого человека.
