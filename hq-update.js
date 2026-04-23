#!/usr/bin/env node
/**
 * HQ Data Updater — Safe data.json editor with validation + git push
 *
 * Usage:
 *   node hq-update.js task              # Increment tasksDone by 1
 *   node hq-update.js task 5            # Increment tasksDone by 5
 *   node hq-update.js deploy "T4 Folsom" "Fix hero image" "abc1234"
 *   node hq-update.js site 6            # Set liveSites count
 *   node hq-update.js deploys 5         # Set deploys count
 *   node hq-update.js roadmap p1 "3/5"  # Update phase progress
 *   node hq-update.js show              # Print current stats
 *   node hq-update.js validate          # Run validation only
 *   node hq-update.js push "commit msg" # Git add, commit, push
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RED = '\x1b[91m', GREEN = '\x1b[92m', GOLD = '\x1b[93m', DIM = '\x1b[90m', RESET = '\x1b[0m';
const DATA_PATH = path.join(__dirname, 'data.json');

// Cross-platform git — tries `git` in PATH first, falls back to Windows default
let GIT_CMD = null;
function git(argsStr) {
    if (!GIT_CMD) {
        for (const candidate of ['git', '"C:\\Program Files\\Git\\bin\\git.exe"']) {
            try { execSync(`${candidate} --version`, { stdio: 'pipe' }); GIT_CMD = candidate; break; }
            catch { /* try next */ }
        }
        if (!GIT_CMD) throw new Error('git not found in PATH or default Windows location');
    }
    return execSync(`${GIT_CMD} ${argsStr}`, { cwd: __dirname, stdio: 'pipe' });
}

// ===== HELPERS =====
function load() {
    const raw = fs.readFileSync(DATA_PATH);
    // Strip null bytes if found
    let clean = raw;
    let hadNulls = false;
    if (raw.includes(0)) {
        clean = Buffer.from(raw.filter(b => b !== 0));
        hadNulls = true;
    }
    const data = JSON.parse(clean);
    if (hadNulls) {
        console.log(`${GOLD}⚠ Stripped null bytes from data.json${RESET}`);
        save(data);
    }
    return data;
}

// Matches on-disk format: ASCII-escaped unicode + inline string-arrays (tags).
// Keeps git diffs to just the lines that actually changed. Must match hq-audit.js.
function serialize(data) {
    let s = JSON.stringify(data, null, 4);
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        out += code < 0x80 ? s[i] : '\\u' + code.toString(16).padStart(4, '0');
    }
    out = out.replace(/\[\n((?:[ \t]+"(?:[^"\\]|\\.)*",?\n)+)[ \t]+\]/g, (_, inner) => {
        const items = inner.match(/"(?:[^"\\]|\\.)*"/g) || [];
        return '[' + items.join(', ') + ']';
    });
    return out + '\n';
}

function save(data) {
    data.lastUpdated = new Date().toISOString().replace(/\.\d{3}Z$/, '');
    fs.writeFileSync(DATA_PATH, serialize(data), 'utf-8');

    // Verify what we wrote
    const verify = fs.readFileSync(DATA_PATH);
    if (verify.includes(0)) {
        console.error(`${RED}CRITICAL: Null bytes detected after write! Aborting.${RESET}`);
        process.exit(1);
    }
    try {
        JSON.parse(verify);
    } catch (e) {
        console.error(`${RED}CRITICAL: Written JSON is invalid! ${e.message}${RESET}`);
        process.exit(1);
    }
}

function validate(data) {
    const errors = [];
    const required = ['stats','roadmap','deploys','portfolio','quickActions','tools','aiTools','systems','ventures','lastUpdated'];
    required.forEach(k => { if (!(k in data)) errors.push(`Missing key: ${k}`); });
    ['liveSites','tasksDone','deploys'].forEach(f => {
        if (typeof data.stats?.[f] !== 'number') errors.push(`stats.${f} is not a number`);
    });
    ['portfolio','quickActions','tools','systems','deploys','ventures'].forEach(k => {
        if (!data[k]?.length) errors.push(`${k} is empty`);
    });
    return errors;
}

function showStats(data) {
    console.log(`\n${GOLD}━━━ HQ STATUS ━━━${RESET}`);
    console.log(`  Live Sites:  ${GREEN}${data.stats.liveSites}${RESET}`);
    console.log(`  Tasks Done:  ${GREEN}${data.stats.tasksDone}${RESET}`);
    console.log(`  Deploys:     ${GREEN}${data.stats.deploys}${RESET}`);
    console.log(`  Portfolio:   ${data.portfolio.length} sites`);
    console.log(`  Roadmap:     P1=${data.roadmap.p1.progress} P2=${data.roadmap.p2.progress} P3=${data.roadmap.p3.progress} P4=${data.roadmap.p4.progress}`);
    console.log(`  Last Deploy: ${data.deploys[0]?.project} — ${data.deploys[0]?.msg}`);
    console.log(`  Updated:     ${data.lastUpdated}`);
    console.log(`${GOLD}━━━━━━━━━━━━━━━━━${RESET}\n`);
}

function gitPush(message) {
    try {
        git('add data.json');
        git(`commit -m "${message.replace(/"/g, '\\"')}"`);
        git('push origin master');
        console.log(`${GREEN}✓ Pushed to GitHub → Vercel auto-deploy${RESET}`);
    } catch (e) {
        const stderr = e.stderr?.toString() || e.message || '';
        if (stderr.includes('nothing to commit')) {
            console.log(`${DIM}No changes to commit${RESET}`);
        } else {
            console.error(`${RED}Git error: ${stderr}${RESET}`);
        }
    }
}

// ===== COMMANDS =====
const [,, cmd, ...args] = process.argv;

if (!cmd) {
    console.log(`\n${GOLD}HQ Data Updater${RESET}`);
    console.log(`  node hq-update.js task [n]                    Increment tasks by n (default 1)`);
    console.log(`  node hq-update.js deploy "project" "msg" "hash"  Add deploy entry`);
    console.log(`  node hq-update.js site <n>                    Set liveSites count`);
    console.log(`  node hq-update.js deploys <n>                 Set deploys stat count`);
    console.log(`  node hq-update.js roadmap <p1-p4> "x/y"      Update phase progress`);
    console.log(`  node hq-update.js revenue add <cents> "note"  Log revenue (integer cents)`);
    console.log(`  node hq-update.js revenue set-mtd <cents>     Set MTD revenue directly`);
    console.log(`  node hq-update.js lead add "name" "source" <stage> <cents> "next"  Add lead`);
    console.log(`  node hq-update.js lead stage <name|idx> <stage>  Move lead stage`);
    console.log(`  node hq-update.js lead rm <name|idx>          Remove lead`);
    console.log(`  node hq-update.js show                        Print current stats`);
    console.log(`  node hq-update.js validate                    Run validation only`);
    console.log(`  node hq-update.js push                        Git commit + push\n`);
    process.exit(0);
}

const data = load();

// Auto-init optional fields on first use — doesn't alter existing data
function ensureRevenue() {
    if (!data.revenue) data.revenue = { mtdCents: 0, ytdCents: 0, entries: [] };
    return data.revenue;
}
function ensureLeads() {
    if (!Array.isArray(data.leads)) data.leads = [];
    return data.leads;
}
const STAGES = ['new','qualified','proposed','won','lost'];
function findLead(needle) {
    const leads = ensureLeads();
    const idx = parseInt(needle);
    if (!isNaN(idx) && leads[idx]) return idx;
    const n = String(needle).toLowerCase();
    return leads.findIndex(l => l.name.toLowerCase().includes(n));
}
function monthKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function centsToStr(c) { return `$${(c/100).toFixed(2)}`; }

switch (cmd) {
    case 'task': {
        const inc = parseInt(args[0]) || 1;
        data.stats.tasksDone += inc;
        save(data);
        console.log(`${GREEN}✓ tasksDone: ${data.stats.tasksDone - inc} → ${data.stats.tasksDone}${RESET}`);
        break;
    }
    case 'deploy': {
        const [project, msg, hash] = args;
        if (!project || !msg) { console.error(`${RED}Usage: deploy "project" "msg" "hash"${RESET}`); process.exit(1); }
        const when = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        data.deploys.unshift({ project, msg, hash: hash || 'latest', when });
        // Keep last 6 deploys
        if (data.deploys.length > 6) data.deploys = data.deploys.slice(0, 6);
        data.stats.deploys = data.deploys.length;
        save(data);
        console.log(`${GREEN}✓ Deploy added: ${project} — ${msg} (${when})${RESET}`);
        break;
    }
    case 'site': {
        const count = parseInt(args[0]);
        if (isNaN(count)) { console.error(`${RED}Usage: site <number>${RESET}`); process.exit(1); }
        const old = data.stats.liveSites;
        data.stats.liveSites = count;
        save(data);
        console.log(`${GREEN}✓ liveSites: ${old} → ${count}${RESET}`);
        break;
    }
    case 'deploys': {
        const count = parseInt(args[0]);
        if (isNaN(count)) { console.error(`${RED}Usage: deploys <number>${RESET}`); process.exit(1); }
        data.stats.deploys = count;
        save(data);
        console.log(`${GREEN}✓ deploys stat: → ${count}${RESET}`);
        break;
    }
    case 'roadmap': {
        const [phase, progress] = args;
        if (!phase || !progress || !data.roadmap[phase]) {
            console.error(`${RED}Usage: roadmap <p1|p2|p3|p4> "x/y"${RESET}`); process.exit(1);
        }
        const old = data.roadmap[phase].progress;
        data.roadmap[phase].progress = progress;
        save(data);
        console.log(`${GREEN}✓ ${phase}: ${old} → ${progress}${RESET}`);
        break;
    }
    case 'show': {
        showStats(data);
        break;
    }
    case 'validate': {
        const errors = validate(data);
        if (errors.length) {
            console.log(`${RED}Validation FAILED:${RESET}`);
            errors.forEach(e => console.log(`  ${RED}✗ ${e}${RESET}`));
            process.exit(1);
        } else {
            console.log(`${GREEN}✓ data.json is valid${RESET}`);
            showStats(data);
        }
        break;
    }
    case 'push': {
        const errors = validate(data);
        if (errors.length) {
            console.log(`${RED}Cannot push — validation failed:${RESET}`);
            errors.forEach(e => console.log(`  ${RED}✗ ${e}${RESET}`));
            process.exit(1);
        }
        const msg = args[0] || `data: update stats (tasks=${data.stats.tasksDone}, deploys=${data.stats.deploys})`;
        gitPush(msg);
        break;
    }
    case 'revenue': {
        const sub = args[0];
        const rev = ensureRevenue();
        if (sub === 'add') {
            const cents = parseInt(args[1]);
            const note = args[2] || '';
            if (isNaN(cents)) { console.error(`${RED}Usage: revenue add <cents> "note"${RESET}`); process.exit(1); }
            const when = new Date().toISOString().slice(0,10);
            rev.entries.unshift({ cents, note, when });
            if (rev.entries.length > 50) rev.entries = rev.entries.slice(0, 50);
            // Recompute MTD + YTD from entries (source of truth)
            const thisMonth = monthKey(), thisYear = String(new Date().getFullYear());
            rev.mtdCents = rev.entries.filter(e => e.when?.startsWith(thisMonth)).reduce((s,e) => s + (e.cents||0), 0);
            rev.ytdCents = rev.entries.filter(e => e.when?.startsWith(thisYear)).reduce((s,e) => s + (e.cents||0), 0);
            save(data);
            console.log(`${GREEN}✓ +${centsToStr(cents)} — "${note}" (${when})${RESET}`);
            console.log(`  MTD: ${centsToStr(rev.mtdCents)} · YTD: ${centsToStr(rev.ytdCents)}`);
        } else if (sub === 'set-mtd') {
            const cents = parseInt(args[1]);
            if (isNaN(cents)) { console.error(`${RED}Usage: revenue set-mtd <cents>${RESET}`); process.exit(1); }
            const old = rev.mtdCents;
            rev.mtdCents = cents;
            save(data);
            console.log(`${GREEN}✓ MTD: ${centsToStr(old)} → ${centsToStr(cents)}${RESET}`);
        } else {
            console.error(`${RED}Usage: revenue add <cents> "note" | revenue set-mtd <cents>${RESET}`);
            process.exit(1);
        }
        break;
    }
    case 'lead': {
        const sub = args[0];
        const leads = ensureLeads();
        if (sub === 'add') {
            const [, name, source, stage, valueCents, nextAction] = args;
            if (!name || !source || !STAGES.includes(stage)) {
                console.error(`${RED}Usage: lead add "name" "source" <${STAGES.join('|')}> <cents> "nextAction"${RESET}`);
                process.exit(1);
            }
            const lead = {
                name, source,
                stage,
                valueCents: parseInt(valueCents) || 0,
                nextAction: nextAction || '',
                added: new Date().toISOString().slice(0,10),
            };
            leads.unshift(lead);
            save(data);
            console.log(`${GREEN}✓ lead added: ${name} (${source}) · ${stage} · ${centsToStr(lead.valueCents)}${RESET}`);
        } else if (sub === 'stage') {
            const i = findLead(args[1]);
            if (i < 0) { console.error(`${RED}lead not found: ${args[1]}${RESET}`); process.exit(1); }
            if (!STAGES.includes(args[2])) { console.error(`${RED}stage must be one of: ${STAGES.join(', ')}${RESET}`); process.exit(1); }
            const old = leads[i].stage;
            leads[i].stage = args[2];
            // If moved to "won", auto-log revenue
            if (args[2] === 'won' && leads[i].valueCents > 0) {
                const rev = ensureRevenue();
                const when = new Date().toISOString().slice(0,10);
                rev.entries.unshift({ cents: leads[i].valueCents, note: `won: ${leads[i].name}`, when });
                if (rev.entries.length > 50) rev.entries = rev.entries.slice(0, 50);
                const tm = monthKey(), ty = String(new Date().getFullYear());
                rev.mtdCents = rev.entries.filter(e => e.when?.startsWith(tm)).reduce((s,e) => s + (e.cents||0), 0);
                rev.ytdCents = rev.entries.filter(e => e.when?.startsWith(ty)).reduce((s,e) => s + (e.cents||0), 0);
                console.log(`${GOLD}  → auto-logged ${centsToStr(leads[i].valueCents)} revenue${RESET}`);
            }
            save(data);
            console.log(`${GREEN}✓ ${leads[i].name}: ${old} → ${args[2]}${RESET}`);
        } else if (sub === 'rm') {
            const i = findLead(args[1]);
            if (i < 0) { console.error(`${RED}lead not found: ${args[1]}${RESET}`); process.exit(1); }
            const gone = leads.splice(i, 1)[0];
            save(data);
            console.log(`${GREEN}✓ removed: ${gone.name}${RESET}`);
        } else {
            console.error(`${RED}Usage: lead add|stage|rm${RESET}`);
            process.exit(1);
        }
        break;
    }
    default:
        console.error(`${RED}Unknown command: ${cmd}${RESET}`);
        process.exit(1);
}
