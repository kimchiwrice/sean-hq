#!/usr/bin/env node
/**
 * HQ Log — Natural-language → HQ updates. Free by default.
 *
 * Default parser is pure regex — zero API calls, zero cost. Handles ~80%
 * of what you'd say. If a sentence is too complex, --ai falls back to
 * Claude Haiku, guarded by a hard daily spending cap.
 *
 * Chains into your existing tools: calls hq-update.js for each op, then
 * hq-audit.js --fix --yes to self-heal any drift.
 *
 * Usage:
 *   node hq-log.js "deployed aura with cursor glow"
 *   node hq-log.js "finished 3 tasks"
 *   node hq-log.js "got $500 from aura retainer"
 *   node hq-log.js "new lead jenny cafe from IG $800 follow up fri"
 *   node hq-log.js "jenny won"                 → moves stage + auto-logs revenue
 *   node hq-log.js --dry "..."                 preview only
 *   node hq-log.js --yes "..."                 skip y/n prompt
 *   node hq-log.js --ai "..."                  use Claude (needs key + budget)
 *   node hq-log.js --spending                  show today + MTD AI spend
 *
 * AI mode setup (optional):
 *   echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
 *   echo "HQ_DAILY_BUDGET_CENTS=10" >> .env   # default 10¢/day
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');
const { execFileSync } = require('child_process');

const RED='\x1b[91m', GREEN='\x1b[92m', GOLD='\x1b[93m', CYAN='\x1b[96m', DIM='\x1b[90m', RESET='\x1b[0m';
const DATA_PATH = path.join(__dirname, 'data.json');
const ENV_PATH = path.join(__dirname, '.env');
const COST_LOG = path.join(__dirname, '.hq-costs.jsonl');
const MODEL = 'claude-haiku-4-5-20251001';
const HAIKU_IN_PER_M = 100;  // cents per 1M input tokens  ($1/M)
const HAIKU_OUT_PER_M = 500; // cents per 1M output tokens ($5/M)
const DEFAULT_DAILY_CAP_CENTS = 10;

const args = process.argv.slice(2);
const FLAGS = {
    dry: args.includes('--dry'),
    yes: args.includes('--yes'),
    ai: args.includes('--ai'),
    noAudit: args.includes('--no-audit'),
    spending: args.includes('--spending'),
};
const text = args.filter(a => !a.startsWith('--')).join(' ').trim();

// ===== ENV =====
function readEnv(key) {
    if (process.env[key]) return process.env[key];
    if (fs.existsSync(ENV_PATH)) {
        const env = fs.readFileSync(ENV_PATH, 'utf-8');
        const m = env.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'));
        if (m) return m[1].replace(/^["']|["']$/g, '');
    }
    return null;
}

// ===== COST TRACKING =====
function logCost(record) {
    fs.appendFileSync(COST_LOG, JSON.stringify(record) + '\n');
}
function readCosts() {
    if (!fs.existsSync(COST_LOG)) return [];
    return fs.readFileSync(COST_LOG, 'utf-8').split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
}
function todayKey() { return new Date().toISOString().slice(0,10); }
function monthKey() { return new Date().toISOString().slice(0,7); }
function todayCents() {
    return readCosts().filter(c => c.when?.startsWith(todayKey())).reduce((s,c) => s + (c.cents||0), 0);
}
function mtdCents() {
    return readCosts().filter(c => c.when?.startsWith(monthKey())).reduce((s,c) => s + (c.cents||0), 0);
}
function dailyCap() {
    const v = parseInt(readEnv('HQ_DAILY_BUDGET_CENTS'));
    return isNaN(v) ? DEFAULT_DAILY_CAP_CENTS : v;
}

function showSpending() {
    const cap = dailyCap();
    const today = todayCents(), month = mtdCents(), total = readCosts().reduce((s,c) => s + (c.cents||0), 0);
    const calls = readCosts().length;
    console.log(`\n${GOLD}━━ HQ AI SPEND ━━${RESET}`);
    console.log(`  Today:    ${today >= cap ? RED : GREEN}${(today/100).toFixed(4)}¢ / ${cap}¢ cap${RESET}  ${today >= cap ? '(LIMIT HIT)' : ''}`);
    console.log(`  Month:    $${(month/100).toFixed(4)}`);
    console.log(`  All-time: $${(total/100).toFixed(4)}  (${calls} call${calls===1?'':'s'})`);
    console.log(`${DIM}  log: ${COST_LOG}${RESET}`);
    console.log(`${GOLD}━━━━━━━━━━━━━━━━━${RESET}\n`);
}

// ===== REGEX PARSER (free, default) =====
function fuzzy(s, candidates) {
    const n = s.toLowerCase().trim();
    // exact
    let hit = candidates.find(c => c.toLowerCase() === n);
    if (hit) return hit;
    // substring either way
    hit = candidates.find(c => c.toLowerCase().includes(n) || n.includes(c.toLowerCase()));
    if (hit) return hit;
    // token overlap
    const tokens = n.split(/\s+/);
    hit = candidates.find(c => tokens.some(t => t.length > 2 && c.toLowerCase().includes(t)));
    return hit || null;
}

function parseRegex(input, data) {
    const projects = [
        ...data.portfolio.map(p => p.name),
        ...data.ventures.map(v => v.name.replace(/\s+—.*$/, '').replace(/\s+-\s+.*$/, '')),
        'HQ Command Center',
    ];
    const ops = [];
    const reasons = [];
    let text = input.trim();
    let amountConsumed = false;

    // Extract + strip task phrases first so they don't leak into deploy msg
    let taskCount = 0;
    text = text.replace(/\b(?:and\s+)?(?:finished|done|completed|did|knocked\s+out)\s+(\d+)\s+tasks?\b/gi, (_, n) => { taskCount += parseInt(n); return ''; })
               .replace(/\b(\d+)\s+tasks?\s+(?:done|finished|completed)\b/gi, (_, n) => { taskCount += parseInt(n); return ''; })
               .replace(/\s{2,}/g, ' ').trim();

    // LEAD first (consumes $amount into lead.cents)
    const leadHead = text.match(/\b(?:new\s+)?lead\s*:?\s+(.+)/i);
    if (leadHead) {
        let rest = leadHead[1];
        let cents = 0;
        rest = rest.replace(/\$\s?([\d,]+(?:\.\d{1,2})?)\s*/, (_, n) => {
            cents = Math.round(parseFloat(n.replace(/,/g,'')) * 100);
            amountConsumed = true;
            return ' ';
        });
        const fromIdx = rest.toLowerCase().search(/\bfrom\b/);
        let name = 'unknown', source = 'unknown', nextAction = '';
        if (fromIdx >= 0) {
            name = rest.slice(0, fromIdx).trim().replace(/[.,;]+$/, '');
            const after = rest.slice(fromIdx + 4).trim();
            // Strict action phrases — single "call/email/dm/text" alone are channels, not actions
            const actionRe = /\b(?:follow\s+up|fu\b|reach\s+out|needs?\s+\w+|wants?\s+\w+|next\s+\w+|at\s+\d|by\s+\w+)/i;
            const aIdx = after.search(actionRe);
            if (aIdx >= 0) {
                source = after.slice(0, aIdx).trim().replace(/[.,;]+$/, '');
                nextAction = after.slice(aIdx).trim().slice(0, 80);
            } else {
                source = after.replace(/[.,;]+$/, '').trim();
            }
        } else {
            name = rest.trim().replace(/[.,;]+$/, '');
        }
        ops.push({
            type: 'lead_add',
            name: name || 'unknown',
            source: source || 'unknown',
            stage: 'new',
            cents,
            nextAction: nextAction || `follow up with ${name}`,
        });
        reasons.push(`new lead: ${name}`);
    }

    // lead stage change: "<name> won|lost|qualified|proposed"  (only if no lead_add above)
    if (!ops.some(o => o.type === 'lead_add')) {
        const stageM = text.match(/\b([a-z][\w\s.'&]+?)\s+(won|lost|qualified|proposed)\b/i);
        if (stageM) {
            const name = stageM[1].trim();
            const stage = stageM[2].toLowerCase();
            if (name.split(/\s+/).length <= 3) {
                ops.push({ type: 'lead_stage', name, stage });
                reasons.push(`${name} → ${stage}`);
            }
        }
    }

    // revenue: "$N from X", "got $N", "earned $N" — skip if lead already consumed the $
    if (!amountConsumed) {
        const revM = text.match(/\$\s?([\d,]+(?:\.\d{1,2})?)\b(?:\s+(?:from|for|via|on)?\s*([^.,;]+?))?(?=\s*(?:\.|,|;|$))/i);
        if (revM) {
            const dollars = parseFloat(revM[1].replace(/,/g,''));
            const note = (revM[2] || 'revenue').trim().slice(0, 60);
            ops.push({ type: 'revenue_add', cents: Math.round(dollars * 100), note });
            reasons.push(`$${dollars} → revenue`);
        }
    }

    // tasks were stripped + counted at the top of this fn
    if (taskCount > 0) {
        ops.push({ type: 'task', count: taskCount });
        reasons.push(`+${taskCount} tasks`);
    }

    // deploy: "deployed X", "shipped X", "pushed X", "launched X", "released X"
    const deployM = text.match(/\b(?:deployed|shipped|pushed|launched|released|just\s+did)\s+(.+?)(?=\s*(?:\.|,|;|$))/i);
    if (deployM) {
        const chunk = deployM[1].trim();
        const project = fuzzy(chunk, projects);
        if (project) {
            // Strip every project token (len > 2) from chunk to get clean msg
            let msg = chunk;
            for (const tok of project.toLowerCase().split(/\s+/)) {
                if (tok.length > 2) msg = msg.replace(new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b\\s*`, 'gi'), '');
            }
            msg = msg.replace(/^(?:with|for|to|and|on)\s+/i, '').replace(/\s{2,}/g, ' ').replace(/[,;]+/g, ' ').trim();
            if (!msg) msg = 'ship';
            if (msg.length > 80) msg = msg.slice(0, 77) + '...';
            ops.push({ type: 'deploy', project, msg, hash: 'auto' });
            if (!ops.some(o => o.type === 'task')) ops.push({ type: 'task', count: 1 });
            reasons.push(`deploy: ${project}`);
        } else {
            reasons.push(`couldn't match project in "${chunk}"`);
        }
    }

    // roadmap: "p1 4/5", "roadmap p2 to 1/5"
    const rmM = text.match(/\b(?:roadmap\s+)?(p[1-4])\s+(?:to\s+|=\s*)?(\d+\/\d+)\b/i);
    if (rmM) {
        ops.push({ type: 'roadmap', phase: rmM[1].toLowerCase(), progress: rmM[2] });
        reasons.push(`${rmM[1]} → ${rmM[2]}`);
    }

    return { ops, summary: reasons.join(' · ') || 'nothing matched — try --ai for complex input' };
}

// ===== LLM PARSER (opt-in, capped) =====
function buildSystemPrompt(data) {
    const projects = [
        ...data.portfolio.map(p => p.name),
        ...data.ventures.map(v => v.name.replace(/\s+—.*$/, '').replace(/\s+-\s+.*$/, '')),
        'HQ Command Center',
    ];
    return `Parse operator free-text into ops. Output ONLY valid JSON:
{
  "ops": [
    {"type":"task","count":<int>},
    {"type":"deploy","project":"<exact from list>","msg":"<short>","hash":"auto"},
    {"type":"revenue_add","cents":<int>,"note":"<short>"},
    {"type":"lead_add","name":"","source":"","stage":"new|qualified|proposed|won|lost","cents":<int>,"nextAction":""},
    {"type":"lead_stage","name":"<fuzzy ok>","stage":"new|qualified|proposed|won|lost"},
    {"type":"roadmap","phase":"p1|p2|p3|p4","progress":"x/y"}
  ],
  "summary":"<one-line>"
}
PROJECTS (use exact): ${projects.join(', ')}
Money ALWAYS in cents (int). "shipped X" implies deploy+task. Never invent projects.`;
}

function callClaude(key, systemPrompt, userMsg) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ model: MODEL, max_tokens: 800, system: systemPrompt, messages: [{ role: 'user', content: userMsg }] });
        const req = https.request({
            hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(body) },
            timeout: 20000,
        }, res => {
            let chunks = '';
            res.on('data', d => chunks += d);
            res.on('end', () => {
                try {
                    const j = JSON.parse(chunks);
                    if (j.error) return reject(new Error(`${j.error.type}: ${j.error.message}`));
                    resolve({ text: j.content?.[0]?.text || '', usage: j.usage });
                } catch (e) { reject(new Error(`bad API response: ${e.message}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('API timeout')); });
        req.write(body); req.end();
    });
}

async function parseAI(input, data) {
    const key = readEnv('ANTHROPIC_API_KEY');
    if (!key) throw new Error('ANTHROPIC_API_KEY not set — add to .env to use --ai');

    const cap = dailyCap(), today = todayCents();
    if (today >= cap) throw new Error(`daily cap hit (${today}¢ / ${cap}¢) — raise HQ_DAILY_BUDGET_CENTS or wait until tomorrow`);

    const sys = buildSystemPrompt(data);
    const { text: resp, usage } = await callClaude(key, sys, input);

    // Log cost
    const cents = (usage.input_tokens * HAIKU_IN_PER_M / 1_000_000) + (usage.output_tokens * HAIKU_OUT_PER_M / 1_000_000);
    logCost({ when: new Date().toISOString(), model: MODEL, in: usage.input_tokens, out: usage.output_tokens, cents, prompt: input.slice(0, 80) });

    const m = resp.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON block in AI response');
    const parsed = JSON.parse(m[0]);
    return { ...parsed, cents, usage };
}

// ===== DIFF RENDERING =====
function gitHead() {
    try { return execFileSync('git', ['rev-parse','--short','HEAD'], { cwd: __dirname, stdio: ['ignore','pipe','ignore'] }).toString().trim(); }
    catch { return 'latest'; }
}
function renderDiff(data, ops) {
    const lines = [];
    let taskDelta = 0;
    for (const op of ops) {
        if (op.type === 'task') taskDelta += op.count;
        else if (op.type === 'deploy') lines.push(`  ${GREEN}+${RESET} deploy: ${CYAN}${op.project}${RESET} — "${op.msg}" ${DIM}(${op.hash==='auto'?gitHead():op.hash})${RESET}`);
        else if (op.type === 'revenue_add') lines.push(`  ${GREEN}+${RESET} revenue: $${(op.cents/100).toFixed(2)} — "${op.note}"`);
        else if (op.type === 'lead_add') lines.push(`  ${GREEN}+${RESET} lead: ${CYAN}${op.name}${RESET} (${op.source}) · ${op.stage} · $${(op.cents/100).toFixed(2)}`);
        else if (op.type === 'lead_stage') lines.push(`  ${GOLD}~${RESET} lead: ${CYAN}${op.name}${RESET} → ${op.stage}${op.stage==='won'?` ${DIM}(auto-logs revenue)${RESET}`:''}`);
        else if (op.type === 'roadmap') lines.push(`  ${GOLD}~${RESET} roadmap.${op.phase}: ${data.roadmap[op.phase]?.progress||'?'} → ${GREEN}${op.progress}${RESET}`);
    }
    if (taskDelta) lines.unshift(`  ${GREEN}+${RESET} tasks: ${data.stats.tasksDone} → ${GREEN}${data.stats.tasksDone + taskDelta}${RESET}`);
    return lines.join('\n');
}

// ===== APPLY (shells out to hq-update.js) =====
function apply(op) {
    const cmd = ['hq-update.js'];
    if (op.type === 'task')        cmd.push('task', String(op.count));
    else if (op.type === 'deploy') cmd.push('deploy', op.project, op.msg, op.hash === 'auto' ? gitHead() : op.hash);
    else if (op.type === 'revenue_add') cmd.push('revenue', 'add', String(op.cents), op.note);
    else if (op.type === 'lead_add')    cmd.push('lead', 'add', op.name, op.source, op.stage, String(op.cents), op.nextAction || '');
    else if (op.type === 'lead_stage')  cmd.push('lead', 'stage', op.name, op.stage);
    else if (op.type === 'roadmap')     cmd.push('roadmap', op.phase, op.progress);
    else { console.error(`${RED}skip unknown op: ${op.type}${RESET}`); return; }
    execFileSync('node', cmd, { cwd: __dirname, stdio: 'inherit' });
}

function runAudit() {
    console.log(`\n${CYAN}↻ auditing + self-healing...${RESET}`);
    try { execFileSync('node', ['hq-audit.js', '--offline', '--fix', '--yes'], { cwd: __dirname, stdio: 'inherit' }); }
    catch { /* exit 1 on review items is informational */ }
}

function prompt(q) {
    return new Promise(r => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); r(a.trim().toLowerCase()); }); });
}

// ===== MAIN =====
async function main() {
    if (FLAGS.spending) { showSpending(); return; }
    if (!text) { console.error(`${RED}✗ no input${RESET}\n${DIM}usage: node hq-log.js "what you just did"\n        node hq-log.js --spending${RESET}`); process.exit(2); }

    const data = JSON.parse(fs.readFileSync(DATA_PATH));

    console.log(`\n${GOLD}━━ parsing ${FLAGS.ai ? '(AI)' : '(free)'} ━━${RESET}`);
    console.log(`  ${DIM}"${text}"${RESET}\n`);

    let result;
    try {
        result = FLAGS.ai ? await parseAI(text, data) : parseRegex(text, data);
    } catch (e) {
        console.error(`${RED}✗ ${e.message}${RESET}`);
        process.exit(2);
    }

    if (!result.ops || !result.ops.length) {
        console.log(`${GOLD}nothing to log${RESET} — ${result.summary}`);
        if (!FLAGS.ai) console.log(`${DIM}try --ai to enable Claude parsing (capped at ${dailyCap()}¢/day)${RESET}`);
        process.exit(1);
    }

    console.log(`${CYAN}${result.summary}${RESET}\n`);
    console.log(renderDiff(data, result.ops));
    if (result.cents) {
        const newTotal = todayCents();
        console.log(`\n${DIM}AI cost: $${(result.cents/100).toFixed(4)} · today: ${newTotal}¢/${dailyCap()}¢${RESET}`);
    }

    if (FLAGS.dry) { console.log(`\n${DIM}dry-run: nothing written${RESET}`); return; }

    let go = FLAGS.yes;
    if (!go) {
        const ans = await prompt(`\n${GOLD}apply? [y/N] ${RESET}`);
        go = ans === 'y' || ans === 'yes';
    }
    if (!go) { console.log(`${DIM}skipped.${RESET}`); process.exit(1); }

    console.log();
    for (const op of result.ops) apply(op);
    if (!FLAGS.noAudit) runAudit();
    console.log(`\n${GREEN}✓ logged${RESET}\n`);
}

main().catch(e => { console.error(`${RED}crashed: ${e.stack}${RESET}`); process.exit(2); });
