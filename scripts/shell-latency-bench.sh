#!/usr/bin/env bash
# Shell-latency bench — цена одного вызова Bash-тула на этой машине.
#
# Зачем: Claude Code запускает Bash-тул через login shell, который грузит
# /etc/profile и /etc/profile.d/*.sh. На Windows (Git for Windows + Defender)
# это стоит секунды НА КАЖДЫЙ вызов, а субагент делает их сотнями.
#
# Как пользоваться:
#   bash scripts/shell-latency-bench.sh              # человекочитаемая таблица
#   bash scripts/shell-latency-bench.sh --json       # JSON (для diff до/после)
#   bash scripts/shell-latency-bench.sh --repo PATH  # добавить замеры поиска по репозиторию
#
# Замер до и после правок делать на одной машине без параллельных сборок:
#   bash scripts/shell-latency-bench.sh --json > /tmp/before.json
#   ...правки...
#   bash scripts/shell-latency-bench.sh --json > /tmp/after.json

set -u

RUNS=5
JSON=0
REPO=""

while [ $# -gt 0 ]; do
    case "$1" in
        --json)  JSON=1; shift ;;
        --runs)  RUNS="$2"; shift 2 ;;
        --repo)  REPO="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

now_ms() { date +%s%3N; }

# median of N runs of a command, in milliseconds
bench() {
    local label="$1"; shift
    local times=()
    local i start end
    for i in $(seq 1 "$RUNS"); do
        start=$(now_ms)
        "$@" >/dev/null 2>&1
        end=$(now_ms)
        times+=($((end - start)))
    done
    local sorted median
    sorted=$(printf '%s\n' "${times[@]}" | sort -n)
    median=$(printf '%s\n' "$sorted" | sed -n "$(( (RUNS + 1) / 2 ))p")
    RESULTS="${RESULTS}${label}\t${median}\n"
}

RESULTS=""

# 1. Login shell — ровно то, чем Claude Code запускает Bash-тул.
bench "login_shell(bash -lc true)" bash -lc true

# 2. Обычный шелл без профиля — нижняя граница, к которой стремимся.
bench "plain_shell(bash -c true)" bash -c true
bench "no_profile(bash --noprofile --norc)" bash --noprofile --norc -c true

# 3. Профиль целиком и по кускам — видно, какой файл сколько стоит.
bench "source /etc/profile" bash --noprofile --norc -c 'source /etc/profile'
for f in /etc/profile.d/*.sh; do
    [ -r "$f" ] || continue
    bench "  source $(basename "$f")" bash --noprofile --norc -c "source $f"
done

# 4. Поиск по репозиторию: ast-index против текстового grep.
if [ -n "$REPO" ] && [ -d "$REPO" ]; then
    if command -v ast-index >/dev/null 2>&1; then
        bench "ast-index symbol (repo)" bash --noprofile --norc -c "cd '$REPO' && ast-index symbol ViewModel"
        bench "ast-index stats (repo)"  bash --noprofile --norc -c "cd '$REPO' && ast-index stats"
    fi
    bench "grep -rn --include=*.kt (repo)" bash --noprofile --norc -c "cd '$REPO' && grep -rn ViewModel --include=*.kt ."
    bench "git status (repo)"             bash --noprofile --norc -c "cd '$REPO' && git status --porcelain"
fi

# Проверка дрейфа установленного фикса: файл живёт вне репозитория, и его
# отсутствие иначе ничем не детектируется — после переустановки Git for Windows
# или на новой машине бенч молча показал бы «медленно» без объяснения.
INSTALLED="$HOME/.config/git/git-prompt.sh"
ORIGIN="$(dirname "$0")/git-prompt-claude-slim.sh"
if [ ! -f "$INSTALLED" ]; then
    echo "ВНИМАНИЕ: $INSTALLED не установлен — фикс не применён. Скопируй туда $ORIGIN" >&2
elif [ -f "$ORIGIN" ] && ! cmp -s "$INSTALLED" "$ORIGIN"; then
    echo "ВНИМАНИЕ: установленный $INSTALLED разошёлся с $ORIGIN" >&2
fi

# printf '%b' с фиксированной format-строкой: $RESULTS содержит имена файлов из
# /etc/profile.d, и `%` в имени иначе съелся бы как спецификатор.
if [ "$JSON" = "1" ]; then
    printf '{\n  "runs": %s,\n  "results": {\n' "$RUNS"
    printf '%b' "$RESULTS" | awk -F'\t' 'NF==2 {
        gsub(/^ +/, "", $1);
        if (n++) printf ",\n";
        printf "    \"%s\": %s", $1, $2
    } END { printf "\n" }'
    printf '  }\n}\n'
else
    echo "shell-latency bench — медиана из $RUNS прогонов, миллисекунды"
    echo "-------------------------------------------------------------"
    printf '%b' "$RESULTS" | awk -F'\t' 'NF==2 { printf "%-42s %8s ms\n", $1, $2 }'
    echo "-------------------------------------------------------------"
    echo "Ориентир: login_shell — это цена КАЖДОГО вызова Bash-тула."
fi
