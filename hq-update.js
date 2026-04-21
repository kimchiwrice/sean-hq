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
 *   node hq-update.js push              # Git add, commit, push
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RED = '\x1b[91m', GREEN = '\x1b[92m', GOLD = '\x1b[93m', DIM = '\x1b[90m', RESET = '\x1b[0m';
const DATA_PATH = path.join(__dirname, 'data.json');
const GIT = '"C:\\Program Files\\Git\\bin\\git.exe"';

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

function save(data) {
    data.lastUpdated = new Date().toISOString().replace(/\.\d{3}Z$/, '');
    const json = JSON.stringify(data, null, 4) + '\n';
    fs.writeFileSync(DATA_PATH, json, 'utf-8');

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
    const required = ['stats','roadmap','deploys','portfolio','quickActions','tools','systems','ventures','lastUpdated'];
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
        execSync(`${GIT} add data.json`, { cwd: __dirname, stdio: 'pipe' });
        execSync(`${GIT} commit -m "${message}"`, { cwd: __dirname, stdio: 'pipe' });
        execSync(`${GIT} push origin master`, { cwd: __dirname, stdio: 'pipe' });
        console.log(`${GREEN}✓ Pushed to GitHub → Vercel auto-deploy${RESET}`);
    } catch (e) {
        const stderr = e.stderr?.toString() || '';
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
    console.log(`  node hq-update.js show                        Print current stats`);
    console.log(`  node hq-update.js validate                    Run validation only`);
    console.log(`  node hq-update.js push                        Git commit + push\n`);
    process.exit(0);
}

const data = load();

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
    default:
        console.error(`${RED}Unknown command: ${cmd}${RESET}`);
        process.exit(1);
}
