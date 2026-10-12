---
date: 2026-10-12
slug: play-publish-keep-completed-base
status: applied
goal: play_publish.py не теряет completed-базу трека и notes существующего релиза
metric: число публикаций через эталонный скрипт, после которых трек потерял completed-релиз или языки notes
baseline_date: 2026-10-12
target_date: 2026-10-26
---

# play_publish.py сохраняет completed-базу трека

## Цель

Закрыть issue #50: `edits.tracks.update` заменяет весь список releases трека, а скрипт слал один собранный с нуля release.

## Baseline (2026-10-12)

- Staged rollout (`inProgress`) и halt (`halted`) поверх completed-релиза выкидывали completed — базу для невыкаченной аудитории.
- Promote существующего versionCode пересобирал тело из флагов: языки notes и `name`, не переданные заново, терялись.
- Из-за этого память `google-play-console-expert` велела писать отдельный driver на каждый prod-ramp (4 живые раскатки 2026-07…09 — все отдельным скриптом).

## Гипотеза

Если скрипт в том же edit читает текущие releases, копирует существующий release и completed-базу дословно и проверяет read-back до commit, эталонного скрипта хватит для staged rollout, ramp, halt и promote.

## Изменения

`agents/google-play-console-expert/scripts/play_publish.py`:
- `merge_track_releases` — существующий release с теми же versionCodes копируется дословно (новый `status`; notes/name из флагов — только если переданы; `userFraction` снимается у completed/draft); для `inProgress` и `halted` completed-релизы трека сохраняются дословно, прежние inProgress/halted вытесняются; completed/draft — единственный release.
- `find_notes_elsewhere` — promote internal→production без `--release-notes` берёт notes того же versionCode из другого трека.
- `check_gate` — within-edit read-back до commit; провал → `edits.delete`, выход с ошибкой, ничего не публикуется. Работает и при `--dry-run`.
- `--user-fraction` вместе с `completed`/`draft` отклоняется локально.

README — строки таблицы флагов. Правило из памяти агента о purpose-built driver снимается после первого прод-прогона.

## Target

К 2026-10-26: первый staged rollout или ramp через эталонный скрипт проходит гейт, а read-back после commit показывает completed-базу и notes на месте.

## Replay (заполняется через N дней)

—
