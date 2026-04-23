#!/usr/bin/env node
/**
 * HQ Audit — Reconcile data.json against reality. Self-correcting.
 *
 * Compares stated state (data.json) vs actual state (git log, live URLs,
 * filesystem, schema) and reports drift. Auto-fixes deterministic drift,
 * flags judgment calls. Re-validates after fixing to confirm corrections held.
 *
 * Usage:
 *   node hq-audit.js               # Full audit (network + local), read-only
 *   node hq-audit.js --offline     # Skip URL checks (fast)
 *   node hq-audit.js --fix         # Apply safe auto-fixes (prompts y/n)
 *   node hq-audit.js --fix --yes   # Apply fixes without prompting
 *   node hq-audit.js --json        # Machine-readable output
 *
 * Exit codes:
 *   0 = clean or all drift fixed
 *   1 = drift remaining after audit/fix pass
 *   2 = hard error (bad json, missing file)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const readline = require('readline');

const RED = '\x1b[91m', GREEN = '\x1b[92m', GOLD = '\x1b[93m', CYAN = '\x1b[96m', DIM = '\x1b[90m', RESET = '\x1b[0m';
const DATA_PATH = path.join(__dirname, 'data.json');
const DEPLOY_CAP = 6; // matches hq-update.js
const REQUIRED_KEYS = ['stats','roadmap','deploys','portfolio','quickActions','tools','aiTools','systems','ventures','lastUpdated'];

const args = process.argv.slice(2);
const FLAGS = {
    offline: args.includes('--offline'),
    fix: args.includes('--fix'),
    yes: args.includes('--yes'),
    json: args.includes('--json'),
};

// ===== FILE OPS (null-byte-safe, mirrors hq-update.js) =====
function load() {
    if (!fs.existsSync(DATA_PATH)) { die(`data.json not found at ${DATA_PATH}`); }
    const raw = fs.readFileSync(DATA_PATH);
    if (raw.includes(0)) {
        const clean = Buffer.from(raw.filter(b => b !== 0));
        try { const d = JSON.parse(clean); d.__hadNulls = true; return d; }
        catch (e) { die(`JSON parse failed even after null-strip: ${e.message}`); }
    }
    try { return JSON.parse(raw); }
    catch (e) { die(`JSON parse error: ${e.message}`); }
}

// Matches the on-disk format: 4-space indent, ASCII-escape all non-ASCII
// (\uXXXX), and collapse pure-string arrays (tags) onto one line.
function serialize(data) {
    let s = JSON.stringify(data, null, 4);
    s = s.replace(/[-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    s = s.replace(/\[\n((?:[ \t]+"(?:[^"\\]|\\.)*",?\n)+)[ \t]+\]/g, (_, inner) => {
        const items = inner.match(/"(?:[^"\\]|\\.)*"/g) || [];
        return '[' + items.join(', ') + ']';
    });
    return s + '\n';
}

function save(data) {
    delete data.__hadNulls;
    data.lastUpdated = new Date().toISOString().replace(/\.\d{3}Z$/, '');
    fs.writeFileSync(DATA_PATH, serialize(data), 'utf-8');
    const verify = fs.readFileSync(DATA_PATH);
    if (verify.includes(0)) die('CRITICAL: null bytes after write');
    try { JSON.parse(verify); } catch (e) { die(`CRITICAL: invalid JSON after write: ${e.message}`); }
}

function die(msg) {
    if (FLAGS.json) console.log(JSON.stringify({ error: msg }));
    else console.error(`${RED}✗ ${msg}${RESET}`);
    process.exit(2);
}

// ===== GIT HELPER (cross-platform) =====
let GIT_CMD = null;
function git(args) {
    if (!GIT_CMD) {
        for (const candidate of ['git', '"C:\\Program Files\\Git\\bin\\git.exe"']) {
            try { execSync(`${candidate} --version`, { stdio: 'pipe' }); GIT_CMD = candidate; break; }
            catch { /* try next */ }
        }
        if (!GIT_CMD) throw new Error('git not found');
    }
    return execSync(`${GIT_CMD} ${args}`, { cwd: __dirname, stdio: 'pipe' }).toString().trim();
}

// ===== HTTP (mirrors smoke-test.js) =====
function fetchHead(url, timeout = 8000) {
    return new Promise(resolve => {
        try {
            const req = https.request(url, { method: 'GET', headers: { 'User-Agent': 'HQ-Audit/1.0' }, timeout }, res => {
                res.on('data', () => {}); // drain
                res.on('end', () => resolve({ status: res.statusCode }));
            });
            req.on('error', e => resolve({ status: 0, err: e.code || e.message }));
            req.on('timeout', () => { req.destroy(); resolve({ status: 0, err: 'timeout' }); });
            req.end();
        } catch (e) { resolve({ status: 0, err: e.message }); }
    });
}

// ===== FINDING BUILDER =====
// severity: 'pass' | 'fix' | 'review'
const findings = [];
function pass(id, msg)                { findings.push({ id, severity: 'pass', msg }); }
function autofix(id, msg, fix)        { findings.push({ id, severity: 'fix', msg, fix }); }
function review(id, msg, detail)      { findings.push({ id, severity: 'review', msg, detail }); }

// ===== CHECKS =====
function checkSchema(data) {
    if (data.__hadNulls) autofix('schema-nullbytes',
        'null bytes found in data.json (stripped on load)',
        () => { /* save() rewrites clean, no further mutation needed */ });

    const missing = REQUIRED_KEYS.filter(k => !(k in data));
    if (missing.length) {
        review('schema-missing-keys', `Missing required keys: ${missing.join(', ')}`, { missing });
        return false;
    }
    pass('schema-keys', `All ${REQUIRED_KEYS.length} required keys present`);

    for (const f of ['liveSites','tasksDone','deploys']) {
        if (typeof data.stats?.[f] !== 'number') {
            review('schema-stat-type', `stats.${f} is not a number: ${data.stats?.[f]}`);
            return false;
        }
    }
    pass('schema-types', 'stats fields are numeric');

    for (let i = 0; i < data.portfolio.length; i++) {
        for (const k of ['name','url','emoji','desc','tags']) {
            if (!(k in data.portfolio[i])) {
                review('schema-portfolio-field', `portfolio[${i}] (${data.portfolio[i].name||'?'}) missing "${k}"`);
            }
        }
    }
    return true;
}

function checkStatsDrift(data) {
    // liveSites vs portfolio.length
    if (data.stats.liveSites !== data.portfolio.length) {
        const old = data.stats.liveSites, want = data.portfolio.length;
        autofix('stats-livesites',
            `stats.liveSites=${old} but portfolio has ${want} entries`,
            () => { data.stats.liveSites = want; });
    } else {
        pass('stats-livesites', `liveSites matches portfolio (${data.stats.liveSites})`);
    }

    // stats.deploys vs deploys.length — this is intentional-ish: hq-update.js:134
    // sets stats.deploys = deploys.length AFTER capping to 6. So they should match.
    // If they don't, something wrote them independently — drift.
    const expectedMin = Math.min(data.deploys.length, DEPLOY_CAP);
    if (data.stats.deploys !== data.deploys.length) {
        const old = data.stats.deploys, want = data.deploys.length;
        autofix('stats-deploys-count',
            `stats.deploys=${old} but deploys array has ${want} entries`,
            () => { data.stats.deploys = want; });
    } else {
        pass('stats-deploys-count', `stats.deploys matches array (${data.stats.deploys})`);
    }

    // Deploy array exceeds cap — judgment call, don't auto-prune (lose history)
    if (data.deploys.length > DEPLOY_CAP) {
        review('deploys-over-cap',
            `deploys array has ${data.deploys.length} entries, hq-update.js caps at ${DEPLOY_CAP}`,
            { hint: `run: node hq-update.js prune (not yet built) or manually trim oldest ${data.deploys.length - DEPLOY_CAP}` });
    }
}

function checkDeployHashes(data) {
    // "latest" hashes lose specificity. For HQ Command Center entries we can resolve
    // from local git. For client entries we can't (different repos) — flag for review.
    let localRepoName = null;
    try { localRepoName = path.basename(git('rev-parse --show-toplevel')); } catch {}

    for (let i = 0; i < data.deploys.length; i++) {
        const d = data.deploys[i];
        if (d.hash !== 'latest') continue;

        const looksLikeLocal = /HQ Command Center|sean-hq/i.test(d.project);
        if (looksLikeLocal) {
            // Try to find a commit matching the msg around the date
            try {
                const hash = git(`log --all --pretty=format:%h -1 --grep="${d.msg.replace(/"/g,'').slice(0,40)}"`);
                if (hash && /^[a-f0-9]{7,}$/.test(hash)) {
                    autofix(`deploy-hash-${i}`,
                        `deploys[${i}] (${d.project}) hash="latest" → resolved to ${hash}`,
                        () => { data.deploys[i].hash = hash; });
                    continue;
                }
            } catch {}
        }
        review(`deploy-hash-${i}`,
            `deploys[${i}] (${d.project}) has hash="latest" — not in this repo, can't auto-resolve`,
            { suggestion: 'update manually when you know the short hash' });
    }
}

function checkGitReality(data) {
    // Commits touching data.json since the last deploy array mutation — a rough drift signal.
    // Also: latest commit on disk vs "most recent deploy entry" — are we behind?
    try {
        const lastCommit = git('log -1 --pretty=format:"%h %s"');
        pass('git-head', `HEAD: ${lastCommit}`);

        // count commits since the last entry was probably added
        const commitsToday = git(`log --since="24 hours ago" --pretty=format:%h | wc -l`).trim();
        if (parseInt(commitsToday) > data.deploys.length && data.deploys[0]?.when !== new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) {
            // only a soft hint; real logic needs per-project tracking
            pass('git-activity', `${commitsToday} commit(s) in last 24h`);
        }
    } catch (e) {
        review('git-unavailable', `git check skipped: ${e.message}`);
    }
}

function checkSystemsClaims(data) {
    // "READY" or "ACTIVE" systems that have no corresponding code/file on disk
    // are aspirational drift. Flag them.
    const filesOnDisk = fs.readdirSync(__dirname);
    const hasFile = (patterns) => patterns.some(p => filesOnDisk.some(f => f.toLowerCase().includes(p.toLowerCase())));

    const systemChecks = [
        { name: 'Daily Outreach Engine', evidence: ['outreach'], statusIfMissing: 'READY but no outreach.* file on disk' },
        { name: 'Deploy QA System', evidence: ['smoke-test'], statusIfMissing: 'ACTIVE but no smoke-test.* on disk' },
        { name: 'HQ Command Center', evidence: ['index.html', 'data.json'], statusIfMissing: 'LIVE but index/data missing' },
    ];
    for (const check of systemChecks) {
        const sys = data.systems.find(s => s.name === check.name);
        if (!sys) continue;
        if (!hasFile(check.evidence)) {
            review(`system-claim-${check.name}`,
                `system "${check.name}" (${sys.status}) — ${check.statusIfMissing}`,
                { hint: 'either build it or downgrade status' });
        } else {
            pass(`system-claim-${check.name}`, `system "${check.name}" (${sys.status}) — evidence on disk ✓`);
        }
    }
}

async function checkLiveURLs(data) {
    if (FLAGS.offline) { pass('urls-skipped', 'URL checks skipped (--offline)'); return; }
    // Liveness model: we're confirming a server is pointing at the URL, not that WE can
    // see content. Vercel/Cloudflare often 401/403 bots — still "alive". Only flag
    // actually-gone (404/410), server errors (5xx), or unreachable (0/timeout).
    const isDead = (s) => s === 0 || s === 404 || s === 410 || s >= 500;
    const results = [];
    for (const site of data.portfolio) {
        const r = await fetchHead(site.url);
        results.push({ name: site.name, status: r.status, err: r.err });
        if (isDead(r.status)) {
            review(`url-${site.name}`,
                `portfolio site "${site.name}" returned ${r.status || 'UNREACHABLE'}${r.err ? ` (${r.err})` : ''}`,
                { url: site.url, hint: 'likely dead — redeploy or remove from portfolio' });
        }
    }
    const dead = results.filter(r => isDead(r.status));
    if (dead.length === 0) pass('urls-all', `all ${results.length} portfolio URLs reachable (${results.map(r => r.status).join(',')})`);
    else pass('urls-partial', `${results.length - dead.length}/${results.length} portfolio URLs reachable`);
}

// ===== RUNNER =====
async function runAudit(data) {
    findings.length = 0;
    if (!checkSchema(data)) return; // bail early on hard schema errors
    checkStatsDrift(data);
    checkDeployHashes(data);
    checkGitReality(data);
    checkSystemsClaims(data);
    await checkLiveURLs(data);
}

function render() {
    if (FLAGS.json) {
        console.log(JSON.stringify({
            pass: findings.filter(f => f.severity === 'pass').length,
            fix: findings.filter(f => f.severity === 'fix').length,
            review: findings.filter(f => f.severity === 'review').length,
            findings: findings.map(({ fix, ...rest }) => rest),
        }, null, 2));
        return;
    }
    const bar = '━'.repeat(50);
    console.log(`\n${GOLD}${bar}\n  HQ AUDIT ${FLAGS.fix ? '(FIX MODE)' : '(READ-ONLY)'}${FLAGS.offline ? ' [OFFLINE]' : ''}\n${bar}${RESET}\n`);

    const passes = findings.filter(f => f.severity === 'pass');
    const fixes  = findings.filter(f => f.severity === 'fix');
    const revs   = findings.filter(f => f.severity === 'review');

    if (passes.length) {
        console.log(`${GREEN}✓ PASS (${passes.length})${RESET}`);
        passes.forEach(f => console.log(`  ${DIM}·${RESET} ${f.msg}`));
    }
    if (fixes.length) {
        console.log(`\n${GOLD}⚙ AUTO-FIX AVAILABLE (${fixes.length})${RESET}`);
        fixes.forEach(f => console.log(`  ${GOLD}→${RESET} ${f.msg}`));
    }
    if (revs.length) {
        console.log(`\n${RED}⚠ REVIEW (${revs.length})${RESET}`);
        revs.forEach(f => {
            console.log(`  ${RED}✗${RESET} ${f.msg}`);
            if (f.detail?.hint) console.log(`    ${DIM}hint: ${f.detail.hint}${RESET}`);
            if (f.detail?.suggestion) console.log(`    ${DIM}→ ${f.detail.suggestion}${RESET}`);
            if (f.detail?.url) console.log(`    ${DIM}${f.detail.url}${RESET}`);
        });
    }
    console.log(`\n${GOLD}${bar}${RESET}`);
    console.log(`  ${GREEN}${passes.length} pass${RESET} · ${GOLD}${fixes.length} auto-fix${RESET} · ${RED}${revs.length} review${RESET}`);
    console.log(`${GOLD}${bar}${RESET}\n`);
}

function prompt(question) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase()); });
    });
}

async function main() {
    const data = load();
    await runAudit(data);
    render();

    const fixes = findings.filter(f => f.severity === 'fix');
    const revs  = findings.filter(f => f.severity === 'review');

    if (FLAGS.fix && fixes.length) {
        let go = FLAGS.yes;
        if (!go && !FLAGS.json) {
            const ans = await prompt(`${GOLD}Apply ${fixes.length} auto-fix(es)? [y/N] ${RESET}`);
            go = ans === 'y' || ans === 'yes';
        }
        if (go) {
            fixes.forEach(f => { try { f.fix(); } catch (e) { console.error(`${RED}fix failed (${f.id}): ${e.message}${RESET}`); } });
            save(data);
            console.log(`${GREEN}✓ fixes applied + data.json rewritten${RESET}\n`);

            // Self-correction: re-audit to confirm fixes held
            console.log(`${CYAN}↻ re-auditing to verify...${RESET}`);
            const data2 = load();
            await runAudit(data2);
            const remainingFixes = findings.filter(f => f.severity === 'fix').length;
            if (remainingFixes === 0) console.log(`${GREEN}✓ all auto-fixes held${RESET}`);
            else console.log(`${RED}✗ ${remainingFixes} drift remaining after fix — investigate${RESET}`);
            render();
        } else {
            console.log(`${DIM}skipped.${RESET}\n`);
        }
    }

    const stillDirty = findings.filter(f => f.severity === 'fix' || f.severity === 'review').length;
    process.exit(stillDirty > 0 ? 1 : 0);
}

main().catch(e => { console.error(`${RED}audit crashed: ${e.stack}${RESET}`); process.exit(2); });
