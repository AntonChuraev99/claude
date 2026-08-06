#!/usr/bin/env node
// docs-length-guard.js — PostToolUse(Write|Edit|MultiEdit) hook.
//
// Enforcement для раздела «Бюджет длины» в agents/doc-writer.md. Правило само себя не
// удержало: замер 2026-08-06 показал, что первый же документ, написанный агентом ПОСЛЕ
// введения потолков, превысил их в 4 раза и не поставил обязательную строку
// `> Объём: <N> слов — <причина>`. Прозаический потолок исполнителю-haiku не виден,
// арифметику должен считать не он.
//
// Хук НЕ блокирует и НЕ откатывает запись: PostToolUse отрабатывает уже после неё.
// Он возвращает агенту замечание через hookSpecificOutput.additionalContext — канал
// проверен живьём, в том числе из ФОНОВОГО субагента (в отличие от PreToolUse,
// который фоновыми агентами не наследуется).
//
// ПОЧЕМУ NODE, А НЕ PWSH, как соседние хуки: matcher безусловный (Write|Edit — это
// каждая правка любого файла), поэтому цена холодного старта платится всегда,
// а не на срабатывании. Замер 2026-08-06: pwsh ~644 мс/запуск против node ~44–70 мс.
// Штатное поле `if:` (фильтр по пути на хендлере) проверено живьём и НЕ работает на
// CLI 2.1.223: с несовпадающим и с совпадающим паттерном хук одинаково не запускался,
// то есть поле ломает хендлер целиком вместо фильтрации. Отсюда: фильтр — в скрипте.
//
// Область: <...>/docs/solutions/*.md и <...>/docs/decisions/*.md — постоянные документы,
// которые читаются годами. Только ПРЯМЫЕ дети каталога; active/, todos/, backlog/,
// reference/, вложенные подкаталоги и INDEX* не трогаются. docs/analytics/decisions/
// тоже вне области (перед `decisions` нет сегмента `docs`) — там свой жизненный цикл.
//
// ЛЕГАСИ НЕ ТРОГАЕМ. Прогон по реальному корпусу: из 132 документов solutions/ двух
// проектов 115 превышают потолок слов, а хотя бы одно правило нарушают все 132. Если бы
// хук ругался на каждую правку такого документа, единственным дешёвым выходом стал бы
// маркер ради тишины — enforcement превратился бы в no-op ровно там, где корпус хуже
// всего. Поэтому сравниваем с версией из HEAD и говорим, только когда ЭТА правка
// ухудшила документ: появилось нарушение, которого не было, либо объём вырос на четверть.
//
// Строка `> Объём: <N>` снимает проверку, но требует ЧИСЛА и протухает: разошлось с
// фактом больше чем на четверть — снова считаем.
//
// Fail-open: любая ошибка ДО вынесения вердикта, а равно непригодный git => тихий выход
// без вывода. Ошибка git НЕ должна превращаться в «документа нет в истории»: это самая
// громкая ветка, и на symlink/junction она поднимала весь легаси-корпус разом.
//
// ВАЖНО: файл публикуется в открытый репозиторий — никаких абсолютных путей,
// имён проектов и логинов в коде.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Копия таблицы из agents/doc-writer.md. Расходятся эти два места — правит человек:
// молчаливая рассинхронизация хуже отсутствия хука. Тест `docs-length-guard.tests.js`
// проверяет только поведение, совпадение таблиц он утверждать не умеет.
const LIMIT_DOC = 400;
const LIMIT_CODE_LINES = 15;
const LIMIT_SUT_LINES = 3;
const LIMIT_CODE_PER_SECTION = 1;
// Список, а не объект: порядок пунктов вердикта должен быть стабильным.
// Первый элемент — регулярная альтернатива имён: в таблице потолков секция записана
// как «## Проблема / Контекст», то есть слэш читается как «или».
const SECTION_LIMITS = [
    ['Проблема|Контекст', 60, 'Проблема / Контекст'],
    ['Решение', 150, 'Решение'],
    ['Почему именно так', 80, 'Почему именно так'],
];
// Насколько документ должен ухудшиться, чтобы уже раздутый легаси-док снова заговорил.
const GROWTH_TOLERANCE = 1.25;
// Маркер объёма ставится первой строкой под заголовком документа; дальше по тексту
// это уже не заявление автора, а цитата или пример.
const MARKER_HEAD_LINES = 15;
// stdin без EOF не должен держать процесс: matcher безусловный, а таймаут хука в
// settings — 10 с. Инцидент этого профиля (error-logs/README.md — «stdin-EOF гонка
// под нагрузкой») уже случался с соседним node-хуком.
const STDIN_TIMEOUT_MS = 2000;
const GIT_TIMEOUT_MS = 5000;

function toNativePath(p) {
    if (!p || typeof p !== 'string') return '';
    let s = p.trim();
    if (process.platform !== 'win32') return s;
    // git-bash / WSL формы приходят только на Windows: /c/foo, //c/foo, /mnt/c/foo.
    const mnt = s.match(/^\/+mnt\/([a-zA-Z])\/(.*)$/);
    const drv = s.match(/^\/+([a-zA-Z])\/(.*)$/);
    if (mnt) s = `${mnt[1]}:/${mnt[2]}`;
    else if (drv) s = `${drv[1]}:/${drv[2]}`;
    return s.replace(/\//g, '\\').replace(/\\+$/, '');
}

// Слова считаются одинаково для кириллицы и латиницы; markdown-разметка остаётся —
// она тоже занимает контекст читающего агента.
function wordCount(text) {
    if (!text) return 0;
    return text.split(/\s+/).filter((w) => /\S/.test(w)).length;
}

// Фенсы МАСКИРУЮТСЯ (строка заменяется на пустую), а не вырезаются: индексы строк,
// на которые опираются границы секций и позиции блоков, обязаны остаться прежними.
// Всё, что анализирует структуру, работает по маске — иначе `## Связанные файлы`
// или `> Объём:` внутри ```-примера меняли бы смысл документа. Такой пример есть в
// любом документе про саму систему документации.
function maskFences(body) {
    const lines = body.split(/\r?\n/);
    const kept = [];
    const blocks = [];
    let fence = null;
    let count = 0;
    for (const line of lines) {
        const open = line.match(/^\s*(?:>\s*)?(`{3,}|~{3,})/);
        if (!fence && open) {
            fence = open[1];
            count = 0;
            kept.push('');
            continue;
        }
        if (fence) {
            const close = line.match(/^\s*(?:>\s*)?(`{3,}|~{3,})\s*$/);
            if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
                blocks.push({ lines: count, at: kept.length });
                fence = null;
                kept.push('');
                continue;
            }
            count++;
            kept.push('');
            continue;
        }
        kept.push(line);
    }
    if (fence) blocks.push({ lines: count, at: kept.length });
    return { text: kept.join('\n'), blocks };
}

// Frontmatter срезается, только если между рамками действительно есть `ключ:` —
// иначе документ, начинающийся с горизонтальной черты, терял бы кусок текста.
// BOM снимается всегда: с ним не матчится ни первая секция, ни маркер.
function stripFrontmatter(raw) {
    const s = raw.replace(/^﻿/, '');
    const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (m && /^[ \t]*[\w-]+[ \t]*:/m.test(m[1])) return s.slice(m[0].length);
    return s;
}

// `## Связанные файлы` выведена из-под потолка документа: это ссылки, а не проза.
// Обнуляется построчно по той же причине, что и фенсы, — ради сохранности индексов.
function blankRelated(masked) {
    const lines = masked.split('\n');
    let inside = false;
    return lines
        .map((l) => {
            if (/^##\s+Связанные файлы/.test(l)) {
                inside = true;
                return '';
            }
            if (inside && /^##\s+\S/.test(l)) inside = false;
            return inside ? '' : l;
        })
        .join('\n');
}

function sectionBody(clean, namePattern) {
    // Граница слова здесь НЕ `\b`: в JS он ASCII-only и после кириллицы не срабатывает
    // вовсе — секции молча не находились. Хвост заголовка («## Проблема / Контекст»)
    // допускается, другое слово с тем же корнем («## Решения») — нет.
    const re = new RegExp(`(?:^|\\n)##\\s+(?:${namePattern})(?![\\p{L}\\p{N}])[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'u');
    const m = clean.match(re);
    return m ? m[1] : null;
}

// Число обязательно, `~`/`≈` допускаются: первый же маркер, поставленный в бою,
// выглядел как «> Объём: ~5600 слов» — без разбора тильды число терялось, маркер
// становился безусловным и отключал проверку документа НАВСЕГДА. Маркер без
// распознанного числа не действует: молчание тогда неотличимо от «поставил, чтобы
// замолчало», а ровно от этого маркер и защищает.
function findMarker(clean) {
    const head = clean.split('\n').slice(0, MARKER_HEAD_LINES).join('\n');
    const m = head.match(/^\s*>\s*Объ[её]м\s*:\s*[~≈]?\s*(\d+)/m);
    return m ? { declared: parseInt(m[1], 10) } : null;
}

// Возвращает нарушения как {code, text}: сравнение версий идёт по кодам, иначе рост
// код-блоков на легаси-документе не виден вовсе (слова считаются по тексту без фенсов).
function analyze(raw) {
    const body = stripFrontmatter(raw);
    const { text: masked, blocks } = maskFences(body);
    const clean = blankRelated(masked);
    const problems = [];
    const docWords = wordCount(clean);
    const codeLines = blocks.reduce((n, b) => n + b.lines, 0);

    if (docWords > LIMIT_DOC) {
        problems.push({ code: 'doc', text: `документ — ${docWords} слов при потолке ${LIMIT_DOC}` });
    }

    for (const [pattern, limit, label] of SECTION_LIMITS) {
        const sec = sectionBody(clean, pattern);
        if (sec === null) continue;
        const w = wordCount(sec);
        if (w > limit) {
            problems.push({ code: `section:${label}`, text: `## ${label} — ${w} слов при потолке ${limit}` });
        }
    }

    const sut = clean.match(/(?:^|\n)\s*\*\*Суть:?\*\*:?([\s\S]*?)(?=\n\s*\n|\n##\s|$)/);
    if (sut) {
        const n = sut[1].split('\n').filter((l) => l.trim()).length;
        if (n > LIMIT_SUT_LINES) {
            problems.push({ code: 'sut', text: `блок Суть — ${n} строк при потолке ${LIMIT_SUT_LINES}` });
        }
    }

    const long = blocks.filter((b) => b.lines > LIMIT_CODE_LINES).map((b) => b.lines);
    if (long.length) {
        problems.push({
            code: 'codeblock',
            text: `код-блоков длиннее ${LIMIT_CODE_LINES} строк: ${long.length} (самый длинный — ${Math.max(...long)} строк)`,
        });
    }

    const secStarts = [];
    clean.split('\n').forEach((l, i) => {
        if (/^##\s+\S/.test(l)) secStarts.push(i);
    });
    if (blocks.length > 1) {
        const perSection = new Map();
        for (const b of blocks) {
            let idx = 0;
            for (let i = 0; i < secStarts.length; i++) if (b.at > secStarts[i]) idx = i + 1;
            perSection.set(idx, (perSection.get(idx) || 0) + 1);
        }
        const crowded = [...perSection.values()].filter((n) => n > LIMIT_CODE_PER_SECTION).length;
        if (crowded) {
            problems.push({
                code: 'codeper',
                text: `секций с более чем ${LIMIT_CODE_PER_SECTION} код-блоком: ${crowded}`,
            });
        }
    }

    return { problems, docWords, codeLines, marker: findMarker(clean) };
}

// `HEAD:./<имя>` резолвится самим git относительно каталога из `-C`. Арифметика путей
// через `--show-toplevel` + `path.relative` ломалась на symlink/junction: git отдаёт
// РЕАЛЬНЫЙ корень, а путь приходит через линк, и `git show` падал. Падение уходило в
// ветку «файла нет в истории», то есть в полную проверку — и весь легаси-корпус
// начинал ругаться на каждой правке. Профиль этого пользователя держит junction между
// двумя каталогами, так что случай не гипотетический.
function gitShowHead(target) {
    const opts = {
        cwd: undefined,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
    };
    const dir = path.dirname(target);
    const spec = `HEAD:./${path.basename(target)}`;
    // Сначала пригодность самого git: `rev-parse --verify HEAD` даёт 0 в репозитории
    // с коммитами, 1 в пустом репозитории и 128 вне репозитория; git не в PATH или
    // таймаут — исключение. Всё это «сверить не с чем», и молчать здесь обязательно:
    // иначе непригодный git попадал бы в ветку «документ новый», то есть в полную
    // проверку, и весь легаси-корпус заговорил бы разом.
    try {
        execFileSync('git', ['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD'], opts);
    } catch {
        return { state: 'unavailable' };
    }
    // Репозиторий валиден, значит ненулевой код здесь означает ровно «пути нет в HEAD»
    // (git отдаёт на это 128, а не 1 — проверено, различать по коду нельзя).
    try {
        execFileSync('git', ['-C', dir, 'cat-file', '-e', spec], opts);
    } catch {
        return { state: 'absent' };
    }
    try {
        return { state: 'present', content: execFileSync('git', ['-C', dir, 'show', spec], opts) };
    } catch {
        return { state: 'unavailable' };
    }
}

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        let done = false;
        const finish = (v) => {
            if (!done) {
                done = true;
                resolve(v);
            }
        };
        // Голый setTimeout не спас бы при readFileSync(0) — тот блокирует event loop.
        // Поэтому чтение асинхронное, а watchdog unref'нут, чтобы не держать процесс.
        const timer = setTimeout(() => finish(data), STDIN_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => {
            data += c;
        });
        process.stdin.on('end', () => {
            clearTimeout(timer);
            finish(data);
        });
        process.stdin.on('error', () => {
            clearTimeout(timer);
            finish('');
        });
    });
}

function resolveTarget(payload) {
    const input = payload.tool_input || {};
    let target = toNativePath(String(input.file_path || ''));
    if (!target) return null;
    if (!path.isAbsolute(target)) {
        const cwd = toNativePath(String(payload.cwd || ''));
        if (!cwd) return null;
        target = path.join(cwd, target);
    }
    // Область — по границе сегмента, не подстрокой: каталог `mydocs` и файл
    // `solutions.md` вне каталога не должны подхватываться. Разделитель — любой из
    // двух: на не-Windows пути остаются с прямыми слэшами.
    if (!/[\\/]docs[\\/](solutions|decisions)[\\/][^\\/]+\.md$/i.test(target)) return null;
    if (/^INDEX([-.]|$)/i.test(path.basename(target))) return null;
    return target;
}

// Вердикт выносится, только когда правка УХУДШИЛА документ: появился код нарушения,
// которого в HEAD не было, либо объём вырос сверх допуска. Иначе легаси-документ
// молчит — приводить корпус в порядок это отдельная задача, а не побочный эффект
// правки одного факта.
function compare(now, before) {
    const seen = new Set(before.problems.map((p) => p.code));
    if (now.problems.some((p) => !seen.has(p.code))) return 'Эта правка добавила нарушение бюджета длины';
    if (now.docWords > before.docWords * GROWTH_TOLERANCE || now.codeLines > before.codeLines * GROWTH_TOLERANCE) {
        return `Документ и до правки был вне бюджета (${before.docWords} слов), но вырос — сейчас ${now.docWords}`;
    }
    return null;
}

function buildVerdict(intro, name, now) {
    const bullets = now.problems.map((p) => `  - ${p.text}`).join('\n');
    return `${intro} — ${name}

${bullets}

Потолки заданы в ~/.claude/agents/doc-writer.md, раздел «Бюджет длины»: документ читают
агенты, и каждое лишнее слово оплачивается при каждом чтении.

Выбери одно и сделай сейчас, не откладывая:
  1. Сократить до потолка — вычеркнуть пересказ кода, повтор из «Сути», иллюстрацию
     того, что уже сказано в «## Решение»; секция «## Примеры» опциональна.
  2. Материал действительно не влезает (матрица требований, разбор пяти блокеров) —
     превысить осознанно и первой строкой под заголовком документа поставить
     «> Объём: ${now.docWords} слов — <причина>». Число обязательно: без него маркер
     не действует. Разойдётся с фактом больше чем на четверть — проверка вернётся.

Молча оставить как есть нельзя: без маркера превышение неотличимо от расползания.`;
}

async function main() {
    const raw = await readStdin();
    if (!raw.trim()) return null;

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        return null;
    }

    if (!/^(write|.*edit)$/i.test(String(payload.tool_name || ''))) return null;

    const target = resolveTarget(payload);
    if (!target) return null;

    // Правка, которая не наращивает текст, бюджет не нарушает. У Write и MultiEdit
    // этих полей нет — там считаем всегда.
    const { old_string: oldS, new_string: newS } = payload.tool_input || {};
    if (typeof oldS === 'string' && typeof newS === 'string' && newS.length <= oldS.length) return null;

    let content;
    try {
        content = fs.readFileSync(target, 'utf8');
    } catch {
        return null;
    }
    if (!content.trim()) return null;

    const now = analyze(content);
    if (!now.problems.length) return null;

    if (now.marker && now.docWords <= now.marker.declared * GROWTH_TOLERANCE) return null;

    const head = gitShowHead(target);
    if (head.state === 'unavailable') return null;

    const name = path.basename(target);
    if (head.state === 'absent') return buildVerdict('Бюджет длины документации превышен', name, now);

    const before = analyze(head.content);
    if (!before.problems.length) return buildVerdict('Эта правка вывела документ за бюджет длины', name, now);

    const intro = compare(now, before);
    return intro ? buildVerdict(intro, name, now) : null;
}

if (require.main === module) {
    main()
        .then((verdict) => {
            if (verdict) {
                // process.exitCode, а не process.exit(): на Windows запись в пайп
                // асинхронна, и exit() способен оборвать её недописанной.
                process.stdout.write(
                    JSON.stringify({
                        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: verdict },
                    })
                );
            }
            process.exitCode = 0;
        })
        .catch(() => {
            process.exitCode = 0;
        });
}

module.exports = { analyze, maskFences, blankRelated, stripFrontmatter, sectionBody, findMarker, compare, resolveTarget, toNativePath };
