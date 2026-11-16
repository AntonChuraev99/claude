# android-platform-expert — справочник по условию

Справочник агента `@android-platform-expert` (`~/.claude/agents/android-platform-expert.md`). Инвариант — в теле агента; здесь механика.

## Физическое устройство: экран не должен гаснуть

Когда: instrumented-тест, baseline profile, Macrobenchmark или прогон сценария на устройстве с serial не на `emulator-` (USB или Wi-Fi). Эмулятор не трогать — он и так не гаснет.

```bash
adb -s <serial> shell settings get system screen_off_timeout   # запомнить значение
adb -s <serial> shell settings put system screen_off_timeout 1800000 && adb -s <serial> shell input keyevent KEYCODE_WAKEUP
# ... прогон ...
adb -s <serial> shell settings put system screen_off_timeout <исходное>
```

- Прошивка вернула `null` (значение не задано) — возврат не `put null`, а `adb -s <serial> shell settings delete system screen_off_timeout`.
- Возвращать и после падения прогона.
- В отчёт: исходное значение и факт возврата. Вернуть не удалось (устройство отключилось) — исходное значение в отчёт, чтобы главный вернул его сам.
- Экран уже заблокирован PIN-кодом — таймаут не поможет: `STATUS: NEEDS_INPUT`, разблокирует пользователь.
