# Git for Windows prompt override — версионируемый оригинал.
# Устанавливается копированием в ~/.config/git/git-prompt.sh (файл вне репозитория).
#
# ЗАЧЕМ. /etc/profile.d/git-prompt.sh грузит git-completion.bash (81 функция __git_*)
# ради интерактивной подсказки. Claude Code снимает с login-шелла снапшот всех функций
# и сорсит его НА КАЖДЫЙ вызов Bash-тула, а каждая функция в снапшоте записана как
# eval "$(echo '<base64>' | base64 -d)" — два процесса на функцию.
#
# Замер 2026-08-19 (Windows 11, Git for Windows, 12 CPU / 15.6 ГБ):
#   снапшот с completion   87 725 Б → source 10.80 с
#   снапшот без completion  6 490 Б → source  0.39 с   (×28)
#   голый bash                       0.06 с
# За 2026-08-18 субагенты сделали 3 908 «дешёвых» Bash-вызовов = 10.1 ч только на этом.
#
# КАК РАБОТАЕТ. /etc/profile.d/git-prompt.sh проверяет наличие ~/.config/git/git-prompt.sh
# и, если файл есть, сорсит ЕГО ВМЕСТО своей ветки с загрузкой completion. То есть это
# штатная точка расширения: файлы Git for Windows не патчятся и переживают апгрейд.
#
# $CLAUDECODE выставлен в 1 в каждом подпроцессе Claude Code (документированная переменная),
# поэтому интерактивный терминал получает ровно прежнее поведение.

if [ -n "${CLAUDECODE:-}" ]; then
	# Неинтерактивный шелл Claude Code: подсказка не нужна, completion — тем более.
	PS1='\w\n$ '
else
	# Интерактив: воспроизводим штатное поведение Git for Windows один в один.
	PS1='\[\033]0;$TITLEPREFIX:$PWD\007\]' # set window title
	PS1="$PS1"'\n'                 # new line
	PS1="$PS1"'\[\033[32m\]'       # change to green
	PS1="$PS1"'\u@\h '             # user@host<space>
	PS1="$PS1"'\[\033[35m\]'       # change to purple
	PS1="$PS1"'$MSYSTEM '          # show MSYSTEM
	PS1="$PS1"'\[\033[33m\]'       # change to brownish yellow
	PS1="$PS1"'\w'                 # current working directory
	if test -z "$WINELOADERNOEXEC"
	then
		GIT_EXEC_PATH="$(git --exec-path 2>/dev/null)"
		COMPLETION_PATH="${GIT_EXEC_PATH%/libexec/git-core}"
		COMPLETION_PATH="${COMPLETION_PATH%/lib/git-core}"
		COMPLETION_PATH="$COMPLETION_PATH/share/git/completion"
		if test -f "$COMPLETION_PATH/git-prompt.sh"
		then
			. "$COMPLETION_PATH/git-completion.bash"
			. "$COMPLETION_PATH/git-prompt.sh"
			PS1="$PS1"'\[\033[36m\]'  # change color to cyan
			PS1="$PS1"'`__git_ps1`'   # bash function
		fi
	fi
	PS1="$PS1"'\[\033[0m\]'        # change color
	PS1="$PS1"'\n'                 # new line
	PS1="$PS1"'$ '                 # prompt: always $
fi
