---
name: device-mirror
description: Выводит экран физического Android-устройства (или эмулятора) на монитор живым окном через scrcpy поверх adb — экран видно в реальном времени, мышь и клавиатура компьютера управляют устройством. Используй, когда пользователь говорит «выведи экран телефона на монитор», «покажи экран устройства», «зеркало устройства», «подключи телефон к экрану», «транслируй экран», «scrcpy», «mirror device screen», «cast phone to desktop», «/device-mirror», а также когда для задачи нужно самому смотреть на живой экран во время прогона сценария. Умеет запись видео экрана в файл, виртуальный дисплей (--new-display) и остановку зеркала. НЕ использовать для: снятия одиночных скриншотов и UI-дерева в контекст агента (это mcp-mobile-test и mcp__mobile__* тулы), разбора дерева layout и перетаскивания элементов (это layout-debug), сборки и установки APK (это install-device / install-emulator), JVM-скриншотов вёрстки до запуска приложения (это screenshot-driven-ui).
allowed-tools: PowerShell, Bash, Read, AskUserQuestion
---

# Зеркало экрана устройства на монитор

`adb` сам экран не показывает — он транспорт. Картинку даёт **scrcpy**: пушит на
устройство свой сервер, забирает H.264-поток по тому же adb-каналу и рисует окно
на компьютере. Root не нужен, приложение на устройство не ставится.

Окно **интерактивное**: мышь и клавиатура компьютера управляют устройством.

## 1. Инструменты и устройство

```powershell
(Get-Command adb -ErrorAction SilentlyContinue).Source
(Get-Command scrcpy -ErrorAction SilentlyContinue).Source
adb devices -l
```

- `adb` пуст → SDK platform-tools нет в PATH. Обычный путь на Windows:
  `$env:LOCALAPPDATA\Android\Sdk\platform-tools`.
- `scrcpy` пуст → поставить: `winget install Genymobile.scrcpy`
  (macOS — `brew install scrcpy`, Linux — пакет дистрибутива).
  После winget PATH подхватывается только в **новом** шелле; в текущем звать по
  полному пути `$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Genymobile.scrcpy_*\scrcpy-win64-*\scrcpy.exe`.
- `adb devices` пуст → устройство не в отладке. Не запускать вслепую: сказать
  пользователю включить USB-отладку и подтвердить отпечаток на экране телефона.
- `unauthorized` в выводе → диалог подтверждения висит **на устройстве**, лечится
  только руками пользователя.

Строка вида `adb-XXXXXXXX-yyyyyy._adb-tls-connect._tcp device` — устройство по Wi-Fi
(беспроводная отладка). Работает так же, но битрейт стоит держать ниже USB.

## 2. Запуск

Одно устройство — флаг `--serial` не нужен:

```powershell
Start-Process scrcpy -ArgumentList '--max-size=1200','--video-bit-rate=8M','--max-fps=60','--stay-awake','--keyboard=uhid'
```

Несколько устройств — обязателен серийник из `adb devices` (первая колонка):

```powershell
Start-Process scrcpy -ArgumentList '--serial=<SERIAL>','--max-size=1200','--stay-awake'
```

Флаги, которые стоит знать (сверено с `scrcpy --help`, v4.0):

| Флаг | Зачем |
|---|---|
| `--max-size=N` | длинная сторона картинки в px. 1200 — комфорт/нагрузка для Wi-Fi; 0 (по умолчанию) — родное разрешение |
| `--video-bit-rate=8M` | по умолчанию 8M; для Wi-Fi при рывках снижать до 4M |
| `--max-fps=60` | ограничить кадры, экономит канал |
| `--stay-awake` | устройство не гасит экран, пока идёт зеркало |
| `--keyboard=uhid` | физическая клавиатура: работают раскладки и нелатинский ввод. Не поднялось — убрать флаг, будет режим по умолчанию |
| `--turn-screen-off` | экран устройства гаснет, зеркало идёт (демо на людях, экономия батареи) |
| `--no-audio` | не тянуть звук устройства |
| `--always-on-top` | окно поверх остальных |
| `--window-title=...` | заголовок окна — см. граблю в §3 |
| `--start-app=<пакет>` | сразу запустить приложение на устройстве |
| `--new-display[=1920x1080/420]` | **отдельный виртуальный дисплей** вместо зеркала основного: телефон живёт своей жизнью, в окне — второй экран |
| `--record=file.mp4` | писать видео в файл (`--record-format=mp4\|mkv`) |
| `--no-control` | только смотреть, ввод не пробрасывается — для демо и записи |

## 3. Грабли запуска

**Пробел в значении флага рвёт `-ArgumentList`.** PowerShell разбивает элемент
списка по пробелам, и scrcpy падает мгновенно:

```
ERROR: Unexpected additional argument: 9
```

Значение с пробелом кавычить внутри самого элемента:

```powershell
# ломается
Start-Process scrcpy -ArgumentList '--window-title=Pixel 9'
# правильно
Start-Process scrcpy -ArgumentList '--window-title="Pixel 9"'
```

**Молчаливая смерть процесса.** `Start-Process` без перенаправления не покажет
ни строки: агент увидит «запустил», а окна нет. Поэтому при первом запуске в сессии
проверять живость и читать вывод:

```powershell
$p = Start-Process scrcpy -ArgumentList '--max-size=1200' -PassThru -NoNewWindow `
  -RedirectStandardOutput "$env:TEMP\scrcpy-out.log" -RedirectStandardError "$env:TEMP\scrcpy-err.log"
Start-Sleep -Seconds 4
if (Get-Process -Id $p.Id -ErrorAction SilentlyContinue) { "ALIVE" } else { "DEAD" }
Get-Content "$env:TEMP\scrcpy-out.log","$env:TEMP\scrcpy-err.log" -ErrorAction SilentlyContinue
```

Здоровый старт печатает `Device: [...] (Android NN)`, `Renderer: direct3d11`
и `Texture: WxH`. Строка `1 file pushed` в stderr — это push scrcpy-server, не ошибка.

**Окно точно на экране** — проверять по заголовку, а не по факту процесса:

```powershell
Get-Process -Id $p.Id | Select-Object Id, MainWindowTitle
```

Пустой `MainWindowTitle` при живом процессе — окно ещё не создано, подождать секунду.

**Тормоза и артефакты по Wi-Fi** — снижать `--max-size` и `--video-bit-rate`, а не
поднимать fps. USB-кабель решает вопрос радикально.

## 4. Управление в окне

Модификатор `MOD` — левый **Alt** или левый **Super**. Полезное:

| Клавиши | Действие |
|---|---|
| `MOD+f` / `F11` | полный экран |
| `MOD+h`, средняя кнопка мыши | HOME |
| `MOD+b`, правая кнопка мыши | BACK |
| `MOD+s` | список приложений |
| `MOD+p` | POWER (гасит/будит экран) |
| `MOD+o` / `MOD+Shift+o` | погасить / включить экран устройства, зеркало продолжает идти |
| `MOD+n` | шторка уведомлений |
| `MOD+v` | вставить текст из буфера компьютера |
| `MOD+w` | подогнать окно под картинку без чёрных полей |
| `MOD+q` | выход |

Файл, перетащенный в окно, ставится (APK) или копируется на устройство.

## 5. Остановка

```powershell
Get-Process scrcpy -ErrorAction SilentlyContinue | Stop-Process -Force
```

Зеркало держит на устройстве процесс scrcpy-server; закрытие окна снимает его само.
При `--record` **окно надо закрывать корректно** (`MOD+q` или Stop-Process), иначе
контейнер mp4 останется недописанным.

## 6. Чего этот скилл не делает

- **Не заменяет скриншот в контекст агента.** Картинка в окне живёт на мониторе
  пользователя; агенту она не видна. Нужен кадр самому агенту — `mcp-mobile-test`
  или `adb exec-out screencap -p > shot.png` с последующим `Read`.
- **Не разбирает вёрстку.** Дерево UI, замеры и перетаскивание элементов —
  `layout-debug`.
- **Не собирает и не ставит приложение.** Это `install-device` / `install-emulator`.
