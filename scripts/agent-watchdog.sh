#!/usr/bin/env sh
# agent-watchdog.sh — стоп-сигнал на зависший фоновый субагент.
#
# Субагент, который завис, выглядит в ListAgents как «running» сколько угодно долго, а
# уведомление о его результате не приходит. Прецедент 2026-09-14: Spec-ревьюер гейта
# (general-purpose) 74 минуты «running», главный ждал уведомления; респавн с бюджетом
# «≤25 вызовов» в брифе вернулся за 5,5 мин.
#
# Два разных признака, по типу агента:
#   - доменные агенты (`.claude/agents/*.md`) пишут транскрипт `<tasks>/<agentId>.output`
#     (путь — в ответе Agent) — он и есть признак жизни: растёт → работает;
#   - встроенные типы (general-purpose, Explore, Plan, claude) транскрипт НЕ пишут: файл
#     остаётся 0 байт у живого и у зависшего одинаково (проверено 2026-09-14 на двух
#     завершившихся ревьюерах). Для них работает только потолок по времени + бюджет вызовов
#     в брифе; WATCHDOG_ZERO_SEC на них ставить 0 (выключено), иначе ложный STALLED-ZERO.
#
# Использование (через Bash с run_in_background — одно уведомление на исход):
#   sh ~/.claude/scripts/agent-watchdog.sh <output-file>...                # доменные агенты
#   WATCHDOG_ZERO_SEC=0 WATCHDOG_MAX_SEC=900 sh ~/.claude/scripts/agent-watchdog.sh <file>  # general-purpose
# Переменные окружения:
#   WATCHDOG_ZERO_SEC   — сколько ждать первого байта (дефолт 120; 0 = не проверять)
#   WATCHDOG_STALL_SEC  — сколько терпеть отсутствие роста (дефолт 600; 0 = не проверять)
#   WATCHDOG_MAX_SEC    — потолок наблюдения (дефолт 3600)
#   WATCHDOG_POLL_SEC   — шаг опроса (дефолт 20)
#
# Выход — ОДНА строка на stdout и код 0:
#   STALLED-ZERO <file> after=<s>     файл пуст дольше WATCHDOG_ZERO_SEC → TaskStop + респавн
#   STALLED <file> idle=<s>           файл не растёт дольше WATCHDOG_STALL_SEC → SendMessage
#                                     «заверши сейчас», затем TaskStop
#   CAP elapsed=<s>                   потолок вышел — для general-purpose это и есть сигнал:
#                                     «заверши сейчас», 3 мин, TaskStop
#   GONE <file>                       файл исчез
# Главный получает уведомление о завершении фоновой команды и читает эту строку.
# Завершение агента файлом не видно — уведомление о его результате приходит своим каналом;
# после него сторож останавливают через TaskStop, иначе он доживёт до потолка и скажет CAP.

ZERO_SEC="${WATCHDOG_ZERO_SEC:-120}"
STALL_SEC="${WATCHDOG_STALL_SEC:-600}"
MAX_SEC="${WATCHDOG_MAX_SEC:-3600}"
POLL_SEC="${WATCHDOG_POLL_SEC:-20}"

if [ "$#" -eq 0 ]; then
    echo "usage: agent-watchdog.sh <output-file>..." >&2
    exit 2
fi

now() { date +%s; }
size_of() { stat -c %s "$1" 2>/dev/null || echo -1; }
mtime_of() { stat -c %Y "$1" 2>/dev/null || echo 0; }

start=$(now)
while :; do
    t=$(now)
    elapsed=$((t - start))
    for f in "$@"; do
        s=$(size_of "$f")
        if [ "$s" -lt 0 ]; then
            echo "GONE $f"
            exit 0
        fi
        if [ "$ZERO_SEC" -gt 0 ] && [ "$s" -eq 0 ] && [ "$elapsed" -ge "$ZERO_SEC" ]; then
            echo "STALLED-ZERO $f after=${elapsed}s"
            exit 0
        fi
        if [ "$STALL_SEC" -gt 0 ] && [ "$s" -gt 0 ]; then
            idle=$((t - $(mtime_of "$f")))
            if [ "$idle" -ge "$STALL_SEC" ]; then
                echo "STALLED $f idle=${idle}s"
                exit 0
            fi
        fi
    done
    if [ "$elapsed" -ge "$MAX_SEC" ]; then
        echo "CAP elapsed=${elapsed}s"
        exit 0
    fi
    sleep "$POLL_SEC"
done
