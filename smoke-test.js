#!/usr/bin/env node
/**
 * HQ Deploy Smoke Test
 * Runs after every deploy to verify all sites and data integrity.
 *
 * Usage:
 *   node smoke-test.js          # Full test (network + local)
 *   node smoke-test.js --local  # Local data.json validation only
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const RED = '\x1b[91m', GREEN = '\x1b[92m', GOLD = '\x1b[93m', RESET = '\x1b[0m';
const PASS = `${GREEN}PASS${RESET}`, FAIL = `${RED}FAIL${RESET}`;
const LOCAL_ONLY = process.argv.includes('--local');
const results = [];

function test(name, fn) {
    return fn().then(([ok, detail]) => {
        results.push(ok);
        console.log(`  [${ok ? PASS : FAIL}] ${name}: ${detail}`);
    }).catch(e => {
        results.push(false);
        console.log(`  [${FAIL}] ${name}: ${RED}${e.message}${RESET}`);
    });
}

function fetchURL(url, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'HQ-SmokeTest/1.0' }, timeout }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

// ===== LOCAL TESTS =====
async function validateLocalJSON() {
    const filePath = path.join(__dirname, 'data.json');
    if (!fs.existsSync(filePath)) return [false, 'File not found'];

    const raw = fs.readFileSync(filePath);

    // Null byte check
    const nullPositions = [];
    for (let i = 0; i < raw.length; i++) { if (raw[i] === 0) nullPositions.push(i); }
    if (nullPositions.length) return [false, `NULL BYTES at positions: ${nullPositions}`];

    let data;
    try { data = JSON.parse(raw); }
    catch (e) { return [false, `JSON parse error: ${e.message}`]; }

    // Required keys
    const required = ['stats','roadmap','deploys','portfolio','quickActions','tools','aiTools','systems','ventures','lastUpdated'];
    const missing = required.filter(k => !(k in data));
    if (missing.length) return [false, `Missing keys: ${missing}`];

    // Stats type check
    for (const f of ['liveSites','tasksDone','deploys']) {
        const val = data.stats?.[f];
        if (typeof val !== 'number') return [false, `stats.${f} invalid: ${val}`];
    }

    // Non-empty arrays
    const arrays = { portfolio: data.portfolio, quickActions: data.quickActions, tools: data.tools, systems: data.systems, deploys: data.deploys, ventures: data.ventures };
    const empty = Object.entries(arrays).filter(([,v]) => !v?.length).map(([k]) => k);
    if (empty.length) return [false, `Empty arrays: ${empty}`];

    // Portfolio field check
    for (let i = 0; i < data.portfolio.length; i++) {
        for (const key of ['name','url','emoji','desc','tags']) {
            if (!(key in data.portfolio[i])) return [false, `portfolio[${i}] missing "${key}"`];
        }
    }

    // Roadmap structure
    for (const p of ['p1','p2','p3','p4']) {
        if (!data.roadmap?.[p]?.progress) return [false, `roadmap.${p}.progress missing`];
    }

    return [true, `Valid — ${data.portfolio.length} sites, ${data.stats.tasksDone} tasks, ${data.deploys.length} deploys`];
}

async function checkFileSize() {
    const filePath = path.join(__dirname, 'data.json');
    const size = fs.statSync(filePath).size;
    if (size < 500) return [false, `${size} bytes — suspiciously small`];
    if (size > 50000) return [false, `${size} bytes — unusually large`];
    return [true, `${size} bytes`];
}

async function checkIndexHTML() {
    const filePath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(filePath)) return [false, 'File not found'];
    const raw = fs.readFileSync(filePath);
    for (let i = 0; i < raw.length; i++) { if (raw[i] === 0) return [false, 'NULL BYTES detected']; }
    const content = raw.toString('utf-8');
    const checks = {
        'DOCTYPE': content.includes('<!DOCTYPE html>'),
        'GSAP CDN': content.toLowerCase().includes('gsap'),
        'data.json fetch': content.includes("fetch('data.json") || content.includes('fetch("data.json'),
        'error fallback': content.includes('Data sync failed'),
        'counter system': content.includes('animateCounter'),
        'visibility handler': content.includes('visibilitychange'),
    };
    const failed = Object.entries(checks).filter(([,v]) => !v).map(([k]) => k);
    if (failed.length) return [false, `Missing: ${failed.join(', ')}`];
    return [true, `All ${Object.keys(checks).length} checks pass (${content.length} chars)`];
}

// ===== NETWORK TESTS =====
async function checkURL(url) {
    const res = await fetchURL(url);
    return [res.status === 200, `${res.status} OK`];
}

async function checkRemoteJSON() {
    const res = await fetchURL(`https://sean-hq.vercel.app/data.json?t=${Date.now()}`);
    for (let i = 0; i < res.body.length; i++) { if (res.body[i] === 0) return [false, 'NULL BYTES in remote']; }
    const data = JSON.parse(res.body);
    return [true, `Remote valid — ${data.portfolio.length} sites, ${data.stats.tasksDone} tasks`];
}

async function checkPortfolioLive() {
    const res = await fetchURL(`https://sean-hq.vercel.app/data.json?t=${Date.now()}`);
    const data = JSON.parse(res.body);
    const statuses = [];
    let allOk = true;
    for (const site of data.portfolio) {
        try {
            const r = await fetchURL(site.url);
            statuses.push(`${site.name}=${r.status === 200 ? 'OK' : r.status}`);
            if (r.status !== 200) allOk = false;
        } catch {
            statuses.push(`${site.name}=DOWN`);
            allOk = false;
        }
    }
    return [allOk, statuses.join(' | ')];
}

// ===== RUN =====
async function main() {
    const bar = '━'.repeat(40);
    console.log(`\n${GOLD}${bar}`);
    console.log(`  HQ SMOKE TEST ${LOCAL_ONLY ? '(LOCAL)' : '(FULL)'}`);
    console.log(`${bar}${RESET}\n`);

    console.log(`${GOLD}[Local Validation]${RESET}`);
    await test('data.json integrity', validateLocalJSON);
    await test('data.json file size', checkFileSize);
    await test('index.html integrity', checkIndexHTML);

    if (!LOCAL_ONLY) {
        console.log(`\n${GOLD}[Network — Live Sites]${RESET}`);
        await test('HQ Dashboard', () => checkURL('https://sean-hq.vercel.app/'));
        await test('Trinh Media', () => checkURL('https://trinh-media-site.vercel.app/'));
        await test('T4 Folsom', () => checkURL('https://t4-folsom.vercel.app/'));

        console.log(`\n${GOLD}[Network — Data]${RESET}`);
        await test('Remote data.json', checkRemoteJSON);
        await test('Portfolio sites live', checkPortfolioLive);
    }

    const passed = results.filter(Boolean).length;
    console.log(`\n${GOLD}${bar}${RESET}`);
    if (results.every(Boolean)) {
        console.log(`  ${GREEN}ALL PASS (${passed}/${results.length})${RESET}`);
    } else {
        console.log(`  ${RED}${results.length - passed} FAILED / ${results.length} total${RESET}`);
    }
    console.log(`${GOLD}${bar}${RESET}\n`);

    process.exit(results.every(Boolean) ? 0 : 1);
}

main();
