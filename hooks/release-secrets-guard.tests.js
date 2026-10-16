#!/usr/bin/env node
// Tests for release-secrets-guard.js.
//
// Pin: релизная gradle-команда в linked worktree без секретов главного checkout —
// deny со списком; повтор той же команды проходит один раз; каталог сборки
// берётся из команды (cd, -p, путь к gradlew), а не из каталога сессии;
// совпавшие файлы и сборка из главного checkout молчат; копии внутри
// .claude/worktrees и build/ не считаются исходниками; паттерны и исключения
// `!x` берутся из .worktreeinclude, если он есть.
//
// Usage: node hooks/release-secrets-guard.tests.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsg-'));
// Журнал событий — во временный каталог, не в настоящий ~/.claude/stats.
process.env.CLAUDE_HOME = path.join(tmp, 'home');
const { releaseVerdict, buildDir, toPathspec, RELEASE_CMD, STATE_DIR } = require('./release-secrets-guard.js');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
    if (actual === expected) {
        console.log(`  PASS ${name}`);
        passed++;
    } else {
        console.log(`  FAIL ${name}`);
        console.log(`    expected: ${expected}`);
        console.log(`    actual:   ${actual}`);
        failed++;
    }
}

function git(cwd, ...args) {
    const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function put(root, rel, content) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
}

const main = path.join(tmp, 'main');
const wt = path.join(tmp, 'wt');
const run = `t-${process.pid}-${Date.now()}`;
const key = (k) => `${run}-${k}`;
const BUILD = './gradlew :app:bundleRelease';
const started = Date.now();

try {
    console.log('=== command filter ===');
    check('bundleRelease', RELEASE_CMD.test('./gradlew :app:bundleRelease'), true);
    check('assembleProdRelease via .bat', RELEASE_CMD.test('gradlew.bat assembleProdRelease'), true);
    check('publishReleaseBundle', RELEASE_CMD.test('./gradlew publishReleaseBundle'), true);
    check('assembleDebug ignored', RELEASE_CMD.test('./gradlew assembleDebug'), false);
    check('testReleaseUnitTest ignored', RELEASE_CMD.test('./gradlew testReleaseUnitTest'), false);
    check('no gradlew ignored', RELEASE_CMD.test('echo bundleRelease'), false);
    check('&& after debug build not a release', RELEASE_CMD.test('./gradlew assembleDebug && echo assembleRelease'), false);

    console.log('=== pathspec ===');
    check('no slash -> any depth', toPathspec('*.jks'), ':(glob)**/*.jks');
    check('with slash -> anchored', toPathspec('app/keys/x.json'), ':(glob)app/keys/x.json');
    check('dir/ -> any depth, all inside', toPathspec('keys/'), ':(glob)**/keys/**');
    check('/x -> root', toPathspec('/x.json'), ':(glob)x.json');
    check('**/x kept', toPathspec('**/x.json'), ':(glob)**/x.json');
    check('exclude', toPathspec('.env.local', true), ':(exclude,glob)**/.env.local');

    console.log('=== build dir ===');
    const S = path.resolve('/s');
    check('plain -> session cwd', buildDir('./gradlew bundleRelease', S), S);
    check('cd before gradlew', buildDir('cd /ws/x && ./gradlew bundleRelease', S), path.resolve('/ws/x'));
    check('relative cd', buildDir('cd sub && ./gradlew bundleRelease', S), path.join(S, 'sub'));
    check('quoted cd', buildDir('cd "/ws/a b" && ./gradlew bundleRelease', S), path.resolve('/ws/a b'));
    check('gradlew by path', buildDir('/ws/y/gradlew bundleRelease', S), path.resolve('/ws/y'));
    check('-p wins', buildDir('./gradlew -p /ws/z bundleRelease', S), path.resolve('/ws/z'));
    check('cd after gradlew ignored', buildDir('./gradlew bundleRelease && cd /ws/q', S), S);
    if (process.platform === 'win32') check('git bash drive path', buildDir('cd /c/w && ./gradlew bundleRelease', S), 'C:\\w');

    fs.mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    put(main, '.gitignore', 'google-services.json\n*.jks\nbuild/\n.claude/\nsecrets.txt\n');
    put(main, 'README.md', 'x');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);

    put(main, 'app/google-services.json', '{"key":"real"}');
    put(main, 'release.jks', 'KEYSTORE');
    put(main, 'app/build/intermediates/google-services.json', 'copy');
    put(main, '.claude/worktrees/other/app/google-services.json', 'copy');

    console.log('=== missing files ===');
    const k1 = key('a');
    const r1 = releaseVerdict(BUILD, wt, k1);
    check('deny when secrets missing', r1 !== null, true);
    check('lists google-services.json', /app\/google-services\.json` — нет/.test(r1 || ''), true);
    check('lists keystore', /release\.jks` — нет/.test(r1 || ''), true);
    check('skips build/ copy', /intermediates/.test(r1 || ''), false);
    check('skips nested worktree copy', /worktrees\/other/.test(r1 || ''), false);
    check('copy command', /cp ".*main\/release\.jks" ".*wt\/release\.jks"/.test(r1 || ''), true);
    check('copy advice creates dir', /mkdir -p ".*wt\/app" && cp/.test(r1 || ''), true);
    check('retry passes', releaseVerdict(BUILD, wt, k1), null);
    check('third run checks again', releaseVerdict(BUILD, wt, k1) !== null, true);
    check('other release task not covered by repeat', releaseVerdict('./gradlew assembleRelease', wt, k1) !== null, true);
    check('non-release command silent', releaseVerdict('./gradlew assembleDebug', wt, key('b')), null);
    check('main checkout silent', releaseVerdict(BUILD, main, key('c')), null);
    check('session in main, cd into worktree -> checked', releaseVerdict(`cd "${wt}" && ${BUILD}`, main, key('k')) !== null, true);
    check('session in worktree, cd into main -> silent', releaseVerdict(`cd "${main}" && ${BUILD}`, wt, key('l')), null);
    const log = fs.readFileSync(path.join(tmp, 'home', 'stats', 'release-secrets-events.jsonl'), 'utf8');
    check('deny and repeat logged', /"event":"deny"/.test(log) && /"event":"repeat"/.test(log), true);

    console.log('=== content differs ===');
    put(wt, 'app/google-services.json', '{"key":"stale"}');
    put(wt, 'release.jks', 'KEYSTORE');
    const r2 = releaseVerdict(BUILD, wt, key('d'));
    check('deny on stale key', /app\/google-services\.json` — отличается/.test(r2 || ''), true);
    check('identical keystore not listed', /release\.jks/.test(r2 || ''), false);

    console.log('=== all in place ===');
    put(wt, 'app/google-services.json', '{"key":"real"}');
    check('silent when identical', releaseVerdict(BUILD, wt, key('e')), null);

    console.log('=== .worktreeinclude ===');
    put(main, '.worktreeinclude', '# secrets\nsecrets.txt\n*.jks\n!release.jks\n');
    put(main, 'secrets.txt', 'S');
    put(main, 'other.jks', 'O');
    fs.unlinkSync(path.join(wt, 'release.jks'));
    const r3 = releaseVerdict(BUILD, wt, key('f'));
    check('custom pattern detected', /secrets\.txt` — нет/.test(r3 || ''), true);
    check('says source is .worktreeinclude', /паттерны — \.worktreeinclude/.test(r3 || ''), true);
    check('default list not used', /google-services/.test(r3 || ''), false);
    check('!pattern excluded', /release\.jks/.test(r3 || ''), false);
    check('positive glob still checked', /other\.jks` — нет/.test(r3 || ''), true);

    console.log('=== wired into prefilter ===');
    const payload = JSON.stringify({
        tool_name: 'Bash', cwd: wt, transcript_path: key('j'),
        tool_input: { command: BUILD },
    });
    const pre = spawnSync('node', [path.join(__dirname, 'credentials-guard-prefilter.js')], { input: payload, encoding: 'utf8', env: process.env });
    let decision = null;
    try { decision = JSON.parse(pre.stdout).hookSpecificOutput.permissionDecision; } catch (e) { /* пусто */ }
    check('prefilter emits deny', decision, 'deny');
    check('prefilter reason is ours', /secrets\.txt/.test(pre.stdout), true);

    console.log('=== robustness ===');
    check('outside git silent', releaseVerdict(BUILD, tmp, key('g')), null);
    check('no cwd silent', releaseVerdict(BUILD, '', key('h')), null);
    check('non-string command', releaseVerdict(null, wt, key('i')), null);
} finally {
    // Ключ состояния хешируется, поэтому файлы этого прогона чистим по времени создания.
    try {
        for (const name of fs.readdirSync(STATE_DIR)) {
            const p = path.join(STATE_DIR, name);
            if (fs.statSync(p).mtimeMs >= started) fs.unlinkSync(p);
        }
    } catch (e) { /* каталога нет */ }
    try { spawnSync('git', ['-C', main, 'worktree', 'remove', '--force', wt]); } catch (e) { /* */ }
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
