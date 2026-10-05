# Рендер живой сцены в MP4 / WebM

Статус: подход сверен с первоисточниками 2026-10-05 (Playwright clock docs, WebKit, web.dev LCP, ffmpeg-user); команды, скелет и замеры скорости проверены первым прогоном эталонной реализации 2026-10-05 (раздел «Скелет скрипта»).

## Схема

```
npm run build  →  out/ (static export)
      ↓
render.mjs: статический HTTP-сервер на out/ → Playwright (системный Chrome, DSF 2)
      ↓  режим рендера на рамке сцены (кнопка скрыта, IO-пауза выключена), формат кадра
      ↓  ждать .live + document.fonts.ready + проверка шрифта
      ↓  f = 0..N−1:  getAnimations() → pause(); currentTime = f*1000/fps  →  screenshot
ffmpeg: кадры → даунскейл Lanczos → yuv420p → MP4 (H.264) + WebM (VP9) + постер PNG
```

- **Почему HTTP, а не `file://`:** Next static export ссылается на `/_next/...` абсолютными путями. Поднять минимальный сервер на `node:http` внутри скрипта на свободном порту.
- **Кадр N не снимать:** при бесшовной петле он равен кадру 0. N = fps × длительность (петля 3 сюжетов по 10 с при 30 fps — 900 кадров, один сюжет — 300).
- **Перемотка:** `document.getAnimations().forEach(a => { a.pause(); a.currentTime = t })`. Анимация на rAF или `setTimeout` этим не перематывается — поэтому сцена только на CSS keyframes / WAAPI.
- **Шрифт:** до первого кадра `await document.fonts.ready` и `document.fonts.check('16px "<Family>"', "Ц")` — не загрузился → падать громко, а не снимать системным шрифтом (векторы полёта замеряются по шрифту).
- **Резкость текста:** снимать с `deviceScaleFactor: 2` и уменьшать Lanczos перед `format=yuv420p`. `yuv444p` / `high444` не брать — Safari и часть браузеров не играют.

## Форматы кадра для соцсетей

Рамку сцены не перестраивать — масштабировать: сцена в em от ширины, поэтому достаточно задать рамке ширину и положение в кадре формата.

| Формат | Кадр | Рамка сцены | Подпись |
|---|---|---|---|
| Reels / Shorts 9:16 | 1080×1920, фон — светлый фон сайта | x 110, ширина 820, y 420 (радиус ≈ 5,7 % ширины кадра) | 64 px / 800, низ блока y 390, переключается со сценой той же анимацией видимости (цикл = петля) |
| Пост 4:5 | 1080×1350 | 720×960 по центру, y 250 | y 60–200 |
| Квадрат 1:1 | 1080×1080 | 690×920 по центру | нет |
| Панель как на сайте | размер рамки | — | нет |

Нижние ~400 px кадра 9:16 и правая колонка кнопок закрыты интерфейсом площадки — safe zone сверять по актуальному источнику на дату публикации. Тексты подписей — к маркетологу (`@marketing-expert`), если он есть в наборе.

## Кодирование (CRF 20 / 32 проверены на прогоне, другие не замерялись)

Цветовая разметка обязательна: без `out_range=limited:out_color_matrix=bt709` и тегов плееры сдвигают контраст и жёлтый; без `format=rgb24` перед даунскейлом белый из JPEG Chrome уходит в 251.

```bash
VF="format=rgb24,scale=1080:1920:flags=lanczos:out_range=limited:out_color_matrix=bt709,format=yuv420p"
TAGS="-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv"
ffmpeg -f image2pipe -framerate 30 -c:v mjpeg -i - \
  -vf "$VF" -c:v libx264 -preset slow -crf 20 -tune animation -profile:v high $TAGS -movflags +faststart -an out.mp4 \
  -vf "$VF" -c:v libvpx-vp9 -crf 32 -b:v 0 -row-mt 1 $TAGS -an out.webm
```

С кадрами на диске вместо pipe — `-framerate 30 -i frames/%04d.png` вместо `-f image2pipe … -i -`, фильтр и теги те же.

Постер — кадр финала первого сюжета (t ≈ 8 с), PNG. Выход класть в gitignored-каталог: видео — артефакт для публикации, не исходник.

## Проверка результата

1. `ffmpeg -ss <t> -i out.mp4 -frames:v 1 check-<t>.png` на 3–4 моментах (маркер, полёт, финал каждого сюжета) — открыть и посмотреть самому: текст резкий, чипы попадают в цели, цвета не уехали.
2. Шов петли: кадр 0 и последний кадр — состояния соседние, без скачка (сцена в начале и в конце погашена).
3. Отчитать вес файлов и время рендера.

## Скелет скрипта (проверен первым прогоном 2026-10-05)

Замер эталонной реализации (Windows 11, системный Chrome, DSF 2, JPEG q95 по pipe): reel 1080×1920 — 85 мс/кадр, петля 900 кадров за ~80 с, MP4 30 с ≈ 1,6 МБ (CRF 20), WebM ≈ 1,6 МБ (CRF 32); panel 720×960 — 37 мс/кадр, сюжет 10 с ≈ 430 КБ MP4. Увеличенный фрагмент MP4 по резкости почти не отличается от PNG-постера.

Решения, которые не очевидны:
- **JPEG q95 по `image2pipe`, а не PNG на диск:** при DSF 2 кадр ~8 Мп, PNG дороже по времени, промежуточные файлы не нужны. Один процесс ffmpeg пишет и MP4, и WebM.
- **`format=rgb24` перед даунскейлом:** без него swscale читает YUV-разметку JPEG из Chrome неточно — белый уходит в 251, выход становится `yuvj420p`. Плюс явная разметка limited/BT.709, иначе плееры сдвигают контраст и жёлтый.
- **Рамка сцены переносится в отдельный `#video-frame`**, остальная страница `display:none` — кадр формата собирается поверх собранного сайта без отдельного роута в приложении.
- **Режим рендера — атрибутами на корне сцены** (`data-render` скрывает кнопку паузы и выключает IO-паузу, `data-scene="k"` — один сюжет); их ставит скрипт, React их не перетирает.
- **Подписи сюжетов** берутся из `data-caption` на слоях сюжетов и анимируются теми же `@keyframes` видимости слоёв — перематываются вместе со сценой.

```js
// render.mjs — node scripts/video/render.mjs --format panel|reel|portrait|square --scene all|1|2|3 --fps 30 [--limit n]
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { chromium } from "@playwright/test";

const FORMATS = {
  panel: { w: 720, h: 960, panel: { x: 0, y: 0, w: 720, radius: 0 }, caption: null },
  reel: { w: 1080, h: 1920, panel: { x: 110, y: 420, w: 820, radius: 61 }, caption: { x: 110, y: 230, w: 860, h: 160 } },
  portrait: { w: 1080, h: 1350, panel: { x: 180, y: 250, w: 720, radius: 53 }, caption: { x: 110, y: 60, w: 860, h: 140 } },
  square: { w: 1080, h: 1080, panel: { x: 195, y: 80, w: 690, radius: 51 }, caption: null },
};
// 1. static-сервер на out/ (node:http, порт 0, защита от выхода за корень, dir → index.html, MIME для woff2/webp/js/css)
// 2. chromium.launch({ channel: "chrome" }); newPage({ viewport: {width: f.w, height: f.h}, deviceScaleFactor: 2, reducedMotion: "no-preference" })
// 3. goto → document.fonts.ready → fonts.check('16px "<Family>"', "Ц") иначе throw → waitForSelector("<root>.<live-class>")
// 4. page.evaluate: поставить data-render / data-scene, перенести рамку в #video-frame, вставить <style> с раскладкой формата и подписями
// 5. ffmpeg -f image2pipe -framerate FPS -c:v mjpeg -i - \
//      -vf "format=rgb24,scale=W:H:flags=lanczos:out_range=limited:out_color_matrix=bt709,format=yuv420p" \
//      -c:v libx264 -preset slow -crf 20 -tune animation -profile:v high <bt709 tags> -movflags +faststart -an out.mp4 \
//      -vf <то же> -c:v libvpx-vp9 -crf 32 -b:v 0 -row-mt 1 <bt709 tags> -an out.webm
//    tags: -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv
// 6. for f in 0..N-1: getAnimations().forEach(a => { a.pause(); a.currentTime = f*1000/fps }) → screenshot({type:"jpeg", quality:95, caret:"hide"}) → ff.stdin (с учётом drain)
// 7. постер: seek(8000) → PNG → ffmpeg scale lanczos → <name>.png; pageerror'ы собрать и упасть, если были
```

Ошибки — громко с понятным текстом (нет `out/`, шрифт не загрузился, сцена не стартовала, ffmpeg не в PATH), без `try/catch` «чтобы не падало».
