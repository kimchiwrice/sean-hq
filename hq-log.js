#!/usr/bin/env node
/**
 * HQ Log — Natural-language → HQ updates. Chains into existing tools.
 *
 * You say what you did. Claude parses it into ops. You confirm. It runs
 * your existing hq-update.js primitives, then hq-audit.js --fix --yes to
 * self-heal any drift. Zero changes to hq-update.js or data.json schema.
 *
 * Usage:
 *   node hq-log.js "deployed aura with cursor glow + 8 gallery imgs"
 *   node hq-log.js "finished 3 tasks on trinh media"
 *   echo "shipped cleanslate fix" | node hq-log.js
 *   node hq-log.js --dry "..."       Preview only, never writes
 *   node hq-log.js --yes "..."       Skip y/n prompt (for hooks/Shortcuts)
 *   node hq-log.js --no-audit "..."  Skip the post-write audit chain
 *
 * Setup:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   OR create .env with:  ANTHROPIC_API_KEY=sk-ant-...
 *
 * Exit codes:
 *   0 = committed (or dry-run succeeded)
 *   1 = user declined / no ops parsed
 *   2 = hard error (no key, API failure, parse failure)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');
const { execFileSync } = require('child_process');

const RED = '\x1b[91m', GREEN = '\x1b[92m', GOLD = '\x1b[93m', CYAN = '\x1b[96m', DIM = '\x1b[90m', RESET = '\x1b[0m';
const DATA_PATH = path.join(__dirname, 'data.json');
const ENV_PATH = path.join(__dirname, '.env');
const MODEL = 'claude-haiku-4-5-20251001';

const args = process.argv.slice(2);
const FLAGS = {
    dry: args.includes('--dry'),
    yes: args.includes('--yes'),
    noAudit: args.includes('--no-audit'),
};
const text = args.filter(a => !a.startsWith('--')).join(' ').trim();

// ===== KEY LOADING (env → .env → helpful error) =====
function loadKey() {
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    if (fs.existsSync(ENV_PATH)) {
        const env = fs.readFileSync(ENV_PATH, 'utf-8');
        const m = env.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/m);
        if (m) return m[1].replace(/^["']|["']$/g, '');
    }
    console.error(`${RED}✗ ANTHROPIC_API_KEY not set${RESET}`);
    console.error(`${DIM}Quick fix — create .env in ${__dirname}:${RESET}`);
    console.error(`${DIM}  echo "ANTHROPIC_API_KEY=sk-ant-..." > .env${RESET}`);
    console.error(`${DIM}(.env is gitignored — safe to commit around)${RESET}`);
    process.exit(2);
}

// ===== STDIN FALLBACK =====
async function readStdin() {
    return new Promise(resolve => {
        if (process.stdin.isTTY) return resolve('');
        let buf = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', c => buf += c);
        process.stdin.on('end', () => resolve(buf.trim()));
    });
}

// ===== ANTHROPIC API (raw HTTPS, no SDK) =====
function callClaude(key, systemPrompt, userMsg) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model: MODEL,
            max_tokens: 1024,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMsg }],
        });
        const req = https.request({
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': key,
                'anthropic-version': '2023-06-01',
                'content-length': Buffer.byteLength(body),
            },
            timeout: 20000,
        }, res => {
            let chunks = '';
            res.on('data', d => chunks += d);
            res.on('end', () => {
                try {
                    const j = JSON.parse(chunks);
                    if (j.error) return reject(new Error(`${j.error.type}: ${j.error.message}`));
                    const txt = j.content?.[0]?.text || '';
                    resolve({ text: txt, usage: j.usage });
                } catch (e) { reject(new Error(`bad API response: ${e.message}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('API timeout')); });
        req.write(body);
        req.end();
    });
}

// ===== PARSER (LLM with schema + context) =====
function buildSystemPrompt(data) {
    const projects = [
        ...data.portfolio.map(p => p.name),
        ...data.ventures.map(v => v.name.replace(/\s+—.*$/, '')), // strip suffix
        'HQ Command Center',
    ];
    const phases = Object.entries(data.roadmap).map(([k, v]) => `${k}=${v.name} (${v.progress})`).join(', ');

    return `You are parsing operator free-text into structured ops for an HQ dashboard.
Output ONLY valid JSON matching this schema, no prose:

{
  "ops": [
    { "type": "task", "count": <int> },
    { "type": "deploy", "project": "<exact name>", "msg": "<short summary>", "hash": "auto" | "<7-char hash>" },
    { "type": "site", "count": <int> },
    { "type": "deploys", "count": <int> },
    { "type": "roadmap", "phase": "p1"|"p2"|"p3"|"p4", "progress": "<x/y>" }
  ],
  "summary": "<one-line human summary of what you parsed>"
}

KNOWN PROJECTS (use exact names, match fuzzy input): ${projects.join(', ')}
CURRENT ROADMAP: ${phases}
CURRENT STATS: ${data.stats.liveSites} sites, ${data.stats.tasksDone} tasks, ${data.stats.deploys} deploys

RULES:
- Default to a single "deploy" op when the user describes shipping/deploying work, PLUS a "task" op with count=1 (deploy = task done).
- "Finished N tasks" → one "task" op with count=N, no deploy.
- If no specific project mentioned but a deploy is implied, pick the most likely from KNOWN PROJECTS based on context.
- Never invent project names. If you can't match, return empty ops and explain in summary.
- "hash": "auto" means caller will fill in git HEAD; only use a real hash if user said one.
- msg should be short (<80 chars), punchy, active voice. No emojis unless user included them.
- If input is unclear or non-actionable, return {"ops":[],"summary":"<why>"}.`;
}

async function parse(key, data, userText, retries = 2) {
    const sys = buildSystemPrompt(data);
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const userMsg = attempt === 0
            ? userText
            : `${userText}\n\nPrevious attempt failed validation: ${lastErr}\nReturn corrected JSON only.`;
        try {
            const { text, usage } = await callClaude(key, sys, userMsg);
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) { lastErr = 'no JSON block in response'; continue; }
            const parsed = JSON.parse(jsonMatch[0]);
            const err = validateOps(parsed, data);
            if (err) { lastErr = err; continue; }
            return { ...parsed, usage };
        } catch (e) { lastErr = e.message; }
    }
    throw new Error(`parse failed after ${retries + 1} attempts: ${lastErr}`);
}

function validateOps({ ops }, data) {
    if (!Array.isArray(ops)) return 'ops is not an array';
    const knownProjects = new Set([
        ...data.portfolio.map(p => p.name),
        ...data.ventures.map(v => v.name.replace(/\s+—.*$/, '')),
        'HQ Command Center',
    ]);
    for (const [i, op] of ops.entries()) {
        if (!op.type) return `ops[${i}]: missing type`;
        if (op.type === 'deploy') {
            if (!op.project || !op.msg) return `ops[${i}]: deploy needs project+msg`;
            if (!knownProjects.has(op.project)) return `ops[${i}]: unknown project "${op.project}" — must be one of: ${[...knownProjects].join(', ')}`;
            if (op.hash && op.hash !== 'auto' && !/^[a-f0-9]{7,}$/.test(op.hash)) return `ops[${i}]: bad hash "${op.hash}"`;
        } else if (op.type === 'task' || op.type === 'site' || op.type === 'deploys') {
            if (typeof op.count !== 'number') return `ops[${i}]: ${op.type} needs numeric count`;
        } else if (op.type === 'roadmap') {
            if (!['p1','p2','p3','p4'].includes(op.phase)) return `ops[${i}]: bad phase`;
            if (!/^\d+\/\d+$/.test(op.progress) && op.progress !== '—') return `ops[${i}]: progress must be "x/y"`;
        } else {
            return `ops[${i}]: unknown type "${op.type}"`;
        }
    }
    return null;
}

// ===== HASH RESOLUTION =====
function gitHead() {
    try {
        const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname, stdio: ['ignore','pipe','ignore'] });
        return out.toString().trim();
    } catch { return 'latest'; }
}

// ===== DIFF RENDERING =====
function renderDiff(data, ops) {
    const lines = [];
    for (const op of ops) {
        if (op.type === 'task') {
            lines.push(`  ${GREEN}+${RESET} tasks: ${data.stats.tasksDone} → ${GREEN}${data.stats.tasksDone + op.count}${RESET}`);
        } else if (op.type === 'deploy') {
            const hash = op.hash === 'auto' ? gitHead() : op.hash;
            lines.push(`  ${GREEN}+${RESET} deploy: ${CYAN}${op.project}${RESET} — "${op.msg}" ${DIM}(${hash})${RESET}`);
        } else if (op.type === 'site') {
            lines.push(`  ${GOLD}~${RESET} liveSites: ${data.stats.liveSites} → ${GREEN}${op.count}${RESET}`);
        } else if (op.type === 'deploys') {
            lines.push(`  ${GOLD}~${RESET} deploys stat: ${data.stats.deploys} → ${GREEN}${op.count}${RESET}`);
        } else if (op.type === 'roadmap') {
            lines.push(`  ${GOLD}~${RESET} roadmap.${op.phase}: ${data.roadmap[op.phase].progress} → ${GREEN}${op.progress}${RESET}`);
        }
    }
    return lines.join('\n');
}

// ===== APPLY (shells out to existing hq-update.js) =====
function runUpdate(op) {
    const cmd = ['hq-update.js'];
    if (op.type === 'task')     cmd.push('task', String(op.count));
    if (op.type === 'deploy')   cmd.push('deploy', op.project, op.msg, op.hash === 'auto' ? gitHead() : op.hash);
    if (op.type === 'site')     cmd.push('site', String(op.count));
    if (op.type === 'deploys')  cmd.push('deploys', String(op.count));
    if (op.type === 'roadmap')  cmd.push('roadmap', op.phase, op.progress);
    execFileSync('node', cmd, { cwd: __dirname, stdio: 'inherit' });
}

function runAudit() {
    console.log(`\n${CYAN}↻ auditing + self-healing...${RESET}`);
    try {
        execFileSync('node', ['hq-audit.js', '--offline', '--fix', '--yes'], { cwd: __dirname, stdio: 'inherit' });
    } catch {
        // audit exits 1 if review items remain — that's informational, not a failure here
    }
}

// ===== PROMPT =====
function prompt(q) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, a => { rl.close(); resolve(a.trim().toLowerCase()); });
    });
}

// ===== MAIN =====
async function main() {
    let input = text;
    if (!input) input = await readStdin();
    if (!input) {
        console.error(`${RED}✗ no input${RESET}`);
        console.error(`${DIM}usage: node hq-log.js "what you just did"${RESET}`);
        process.exit(2);
    }

    const key = loadKey();
    const data = JSON.parse(fs.readFileSync(DATA_PATH));

    console.log(`\n${GOLD}━━ parsing ━━${RESET}`);
    console.log(`  ${DIM}"${input}"${RESET}\n`);

    let result;
    try { result = await parse(key, data, input); }
    catch (e) { console.error(`${RED}✗ parse failed: ${e.message}${RESET}`); process.exit(2); }

    if (!result.ops.length) {
        console.log(`${GOLD}nothing to log${RESET} — ${result.summary}`);
        process.exit(1);
    }

    console.log(`${CYAN}${result.summary}${RESET}\n`);
    console.log(renderDiff(data, result.ops));
    if (result.usage) {
        const costCents = (result.usage.input_tokens * 0.0001 + result.usage.output_tokens * 0.0005) / 10;
        console.log(`\n${DIM}${result.usage.input_tokens}in + ${result.usage.output_tokens}out tokens · ~$${costCents.toFixed(4)}${RESET}`);
    }

    if (FLAGS.dry) { console.log(`\n${DIM}dry-run: nothing written${RESET}`); process.exit(0); }

    let go = FLAGS.yes;
    if (!go) {
        const ans = await prompt(`\n${GOLD}apply? [y/N] ${RESET}`);
        go = ans === 'y' || ans === 'yes';
    }
    if (!go) { console.log(`${DIM}skipped.${RESET}`); process.exit(1); }

    console.log();
    for (const op of result.ops) runUpdate(op);

    if (!FLAGS.noAudit) runAudit();

    console.log(`\n${GREEN}✓ logged${RESET}\n`);
}

main().catch(e => { console.error(`${RED}crashed: ${e.stack}${RESET}`); process.exit(2); });
