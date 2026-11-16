#!/usr/bin/env bash
# Шаблон device-flow: детерминированный повтор пути по дереву UI через Android CLI, без LLM.
# Копия ложится в проект: tests/device-flows/<flow>.sh, строка — в tests/device-flows/README.md.
# Процедура и конвенции — ~/.claude/references/android-device-flows.md.
#
# flow:       <slug, совпадает с именем файла>
# checks:     <что доказывает зелёный прогон — одной строкой>
# start:      <стартовое состояние: вход выполнен? какие данные? скрипт сам открывает приложение>
# requires:   <тестовый аккаунт, license tester, флаг сборки; нет — «нет»>
# last-green: <YYYY-MM-DD · versionName · serial>
#
# Запуск из корня репозитория: DEVICE=<serial из adb devices> APP=<applicationId> bash tests/device-flows/<flow>.sh
# Нужен Android CLI >= 1.1.16919734 (`android --version`).

set -Eeuo pipefail   # -E: ловушка ERR срабатывает и внутри функций

: "${DEVICE:?DEVICE=<serial из adb devices>}"
: "${APP:?APP=<applicationId debug-сборки>}"
WAIT_MS="${WAIT_MS:-10000}"      # сколько ждать появления элемента для tap/text/scroll
OUT="${OUT:-build/device-flows}" # куда класть дерево и кадр при сбое

# Git Bash превращает аргумент `text=/regex/` в путь Windows — regex перестаёт находить элементы.
export MSYS_NO_PATHCONV=1
# На Windows Android CLI пишет stdout в кодировке консоли — кириллица в дереве становится `?`.
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Dstdout.encoding=UTF-8"

FLOW="$(basename "$0" .sh)"
CURRENT_STEP="start"

step() { CURRENT_STEP="$*"; printf '\n== %s\n' "$*" >&2; }

# ---- действия по селектору `android input` ---------------------------------
# Пары key=value через запятую: id= / text= / desc= / class= / clickable=true ...
# Строка — подстрока без учёта регистра. Точное совпадение, запятая или кириллица в тексте — regex:
# text=/^Оплатить$/ . Несколько совпадений — ошибка (по умолчанию --match=single): уточни селектор.
tap()       { android input tap "$1" --wait="${2:-$WAIT_MS}" --device="$DEVICE" >&2; }
type_into() { android input text "$2" "$1" --wait="$WAIT_MS" --device="$DEVICE" >&2; }          # type_into <селектор поля> <текст>
submit()    { android input text "$2" "$1" --submit --wait="$WAIT_MS" --device="$DEVICE" >&2; } # то же + Enter
key()       { android input key "$1" --device="$DEVICE" >&2; }                                   # back | enter | home | tab ...
scroll_to() { android input scroll "$1" --until="$2" --dir="${3:-down}" --wait="$WAIT_MS" --device="$DEVICE" >&2; } # <контейнер> <цель>

# ---- проверки без нажатия: опрос дерева `android layout` -------------------
_layout() { android layout --flat --no-idle --device="$DEVICE" 2>/dev/null || true; }

# _wait_for <секунды> <1 — ждать появления | 0 — исчезновения> <аргументы grep...>
_wait_for() {
  local secs=$1 want=$2; shift 2
  local deadline=$((SECONDS + secs)) tree found
  while :; do
    tree="$(_layout)"
    found=0; grep -q "$@" <<<"$tree" && found=1
    [[ $found == "$want" ]] && return 0
    if (( SECONDS >= deadline )); then echo "ожидание не выполнено за ${secs} с: grep $*" >&2; return 1; fi
    sleep 1
  done
}

# Строка в том виде, в каком она лежит в JSON дерева: Android CLI экранирует & < > = ' как \u00XX.
_json_str() {
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}
  s=${s//&/\\u0026}; s=${s//</\\u003c}; s=${s//>/\\u003e}; s=${s//=/\\u003d}; s=${s//\'/\\u0027}
  printf '%s' "$s"
}

expect()      { _wait_for "${2:-10}" 1 -E "$1"; }                                      # ERE по JSON дерева
expect_gone() { _wait_for "${2:-10}" 0 -E "$1"; }
expect_text() { _wait_for "${2:-10}" 1 -F "\"text\":\"$(_json_str "$1")\""; }         # точный видимый текст
expect_id()   { _wait_for "${2:-10}" 1 -E "\"resource-id\":\"([^\"]*[:/])?$1\""; }   # testTag или view id
expect_no_id(){ _wait_for "${2:-10}" 0 -E "\"resource-id\":\"([^\"]*[:/])?$1\""; }

launch() {
  adb -s "$DEVICE" shell am force-stop "$APP"
  adb -s "$DEVICE" shell monkey -p "$APP" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
}

on_fail() {
  local code=$?
  trap - ERR
  mkdir -p "$OUT"
  android layout --flat --no-idle --device="$DEVICE" --output="$OUT/$FLOW-fail-layout.json" >/dev/null 2>&1 || true
  android screen capture --device="$DEVICE" --output="$OUT/$FLOW-fail.png" >/dev/null 2>&1 || true
  echo "FAIL $FLOW на шаге: $CURRENT_STEP (exit $code); дерево и кадр — $OUT/$FLOW-fail-*" >&2
  exit "$code"
}
trap on_fail ERR

# ---- шаги flow -------------------------------------------------------------

step "Открыть приложение"
launch
expect_id "home_screen" 15

step "Пример: открыть экран и проверить результат"
tap 'id=open_details'
expect_text "Детали"

# ---------------------------------------------------------------------------

echo "PASS $FLOW" >&2
