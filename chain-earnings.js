const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Verified against DeRouter's public settlement feed and finalized transactions.
const PROGRAM = '6qFJXFPbmenYRDUuCUnQaHsZNio9WpbAKVMbszLdFwTn';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SETTLE = crypto.createHash('sha256').update('global:settle').digest().subarray(0, 8);
const FILE = path.join(__dirname, 'chain_state.json');

function readState() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function writeState(state) {
    fs.writeFileSync(FILE, JSON.stringify(state), { mode: 0o600 });
}
function decode58(value) {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = 0n;
    for (const c of value || '') {
        const digit = alphabet.indexOf(c);
        if (digit < 0) return Buffer.alloc(0);
        n = n * 58n + BigInt(digit);
    }
    let hex = n.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    return Buffer.concat([Buffer.alloc((value?.match(/^1*/) || [''])[0].length), Buffer.from(hex, 'hex')]);
}

function settlementAmount(tx, wallet) {
    if (!tx?.meta || tx.meta.err) return 0n;
    const keys = tx.transaction.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey);
    const destinations = new Set();
    for (const balance of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]) {
        if (balance.mint === USDC && balance.owner === wallet && balance.uiTokenAmount.decimals === 6) {
            destinations.add(keys[balance.accountIndex]);
        }
    }
    let total = 0n;
    for (const inner of tx.meta.innerInstructions || []) {
        const parent = tx.transaction.message.instructions[inner.index];
        if (parent?.programId !== PROGRAM || !decode58(parent.data).subarray(0, 8).equals(SETTLE)) continue;
        for (const ix of inner.instructions) {
            const { type, info } = ix.parsed || {};
            if (ix.programId !== TOKEN || !['transfer', 'transferChecked'].includes(type)
                || !destinations.has(info?.destination) || destinations.has(info.source)) continue;
            const raw = info.amount ?? info.tokenAmount?.amount;
            if (/^\d+$/.test(raw)) total += BigInt(raw);
        }
    }
    return total;
}

async function rpc(method, params) {
    const url = process.env.DEROUTER_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const { data } = await axios.post(url, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 10000 });
    if (data.error || !Object.hasOwn(data, 'result')) throw new Error(`Solana ${method} 查詢失敗`);
    return data.result;
}

let running;
async function fetchChainEarnings() {
    if (running) return running;
    running = scanChain().finally(() => { running = null; });
    return running;
}

async function scanChain() {
    let state = readState();
    let wallet = process.env.DEROUTER_WALLET?.trim() || state.wallet;
    if (!wallet) {
        const { data } = await axios.get('https://api.derouter.network/api/containers', {
            headers: { Authorization: `Bearer ${process.env.DEROUTER_MGMT_KEY}` }, timeout: 10000,
        });
        const wallets = [...new Set((data || []).map(c => c.wallet).filter(Boolean))];
        if (wallets.length !== 1) throw new Error('請在 .env 設定 DEROUTER_WALLET（接收收益的 Solana 錢包地址）');
        [wallet] = wallets;
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new Error('DEROUTER_WALLET 不是有效 Solana 地址');
    if (state.wallet !== wallet) state = { wallet, transactions: {} };
    state.transactions ||= {};
    // Persist discovered wallet before any RPC request, so fallback survives an API outage.
    writeState(state);
    const accounts = await rpc('getTokenAccountsByOwner', [wallet, { mint: USDC }, { encoding: 'jsonParsed', commitment: 'finalized' }]);
    const addresses = [...new Set([...(state.tokenAccounts || []), ...accounts.value.map(a => a.pubkey)])];
    state.tokenAccounts = addresses;
    writeState(state);
    if (!addresses.length) throw new Error('錢包尚無可查詢的 USDC 帳戶，無法確認歷史收益');
    const now = new Date();
    const todayStart = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) / 1000;
    const monday = new Date(todayStart * 1000);
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    const weekStart = monday.getTime() / 1000;
    const limit = Math.max(1, Math.min(1000, Number(process.env.DEROUTER_CHAIN_MAX_TRANSACTIONS) || 100));
    const signatures = new Map();
    let historyComplete = true;
    for (const address of addresses) {
        const list = await rpc('getSignaturesForAddress', [address, { limit, commitment: 'finalized' }]);
        if (list.length === limit) historyComplete = false;
        for (const item of list) if (!item.err) signatures.set(item.signature, item);
    }
    const sorted = [...signatures.values()].sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0));
    let processed = 0;
    let interrupted = sorted.length > limit;
    for (const item of sorted.slice(0, limit)) {
        if (!state.transactions[item.signature]) {
            try {
                const tx = await rpc('getTransaction', [item.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' }]);
                if (!tx || !Number.isFinite(tx.blockTime)) { interrupted = true; break; }
                state.transactions[item.signature] = { time: tx.blockTime, amount: settlementAmount(tx, wallet).toString() };
            } catch (e) {
                interrupted = true;
                if (!processed) throw e;
                break;
            }
        }
        processed += 1;
    }
    writeState(state);
    const selected = sorted.slice(0, processed).map(s => state.transactions[s.signature]);
    const oldest = selected.length ? Math.min(...selected.map(t => t.time)) : now.getTime() / 1000;
    const sum = since => Number(selected.filter(t => t.time >= since).reduce((s, t) => s + BigInt(t.amount), 0n)) / 1e6;
    return {
        today: sum(todayStart), week: sum(weekStart), scanned: sum(0), wallet,
        todayComplete: !interrupted && (historyComplete || oldest <= todayStart),
        weekComplete: !interrupted && (historyComplete || oldest <= weekStart),
        since: new Date(oldest * 1000).toISOString(), count: processed,
        weekStart: monday.toISOString().slice(0, 10),
    };
}

function formatChainEarnings(data, automatic = false) {
    return [
        '⛓ <b>DeRouter 鏈上已結算收益</b>',
        automatic ? 'API 無法讀取，已切換 Solana 鏈上統計' : '資料來源：Solana（手動切換）',
        '',
        `📅 今日入帳${data.todayComplete ? '' : '（部分）'}：<b>${data.today.toFixed(6)} USDC</b>`,
        `🗓 本週入帳${data.weekComplete ? '' : '（部分）'}：<b>${data.week.toFixed(6)} USDC</b>`,
        `🔎 掃描入帳合計：${data.scanned.toFixed(6)} USDC（${data.count} 筆交易）`,
        `掃描範圍起點：${data.since.slice(0, 19).replace('T', ' ')} UTC`,
        `本週起點：${data.weekStart} 00:00 UTC（週一）`,
        '',
        '<i>只計已確認的 DeRouter USDC 結算；不含充值、一般轉帳與未結算收益。部分表示尚未掃描完整期間；不提供 API task 數或累計收益，亦不混入 API 收益紀錄。</i>',
        '/derouter auto｜/derouter api｜/derouter chain',
    ].join('\n');
}

module.exports = { fetchChainEarnings, formatChainEarnings, settlementAmount };
