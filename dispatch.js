// ==========================================
// 🔧 DeRouter 自動調速模組
// ------------------------------------------
// 依時間相位與當日收益，自動調整各帳號的 dispatch_mode。
//
// 帳號與排程規則全部來自 .env 的 DISPATCH_ACCOUNTS（JSON 陣列），沒設定就只留手動指令。
//   [
//     { "alias": "main", "email": "you@example.com",
//       "dayMode": "speed_5x", "nightMode": "normal",
//       "thresholdUsd": 14, "thresholdMode": "speed_2x" },
//     { "alias": "sub",  "email": "sub@example.com",
//       "dayMode": "speed_2x", "nightMode": "normal" }
//   ]
//   alias        指令用的短代號（/speed main speed_2x），選填
//   dayMode      日間相位（台北 DISPATCH_MORNING_HOUR 起）要切到的模式
//   nightMode    夜間相位（台北 00:00 起）要切到的模式
//   thresholdUsd 當日收益達此金額（美元）就切到 thresholdMode，選填
//
// 說明：
//   - 「當日收益」用的是 /api/billing/earnings 的 today（整個容器當日總收益，
//     以 UTC 換日＝台北早上 8 點歸零），跟每日報告同一個口徑。
//   - 帳號 accountId 可能因為移除再加而改變，所以每次都用 email 即時查出當下 ID，
//     不寫死 ID，較穩。
//   - 每個動作每日只做一次（用台北日期當旗標），重啟後不會重複；且啟動時會依
//     當下時間自動補到正確相位。
//   - dispatch_mode 可用值：humanlike / normal / speed_2x / speed_3x / speed_5x
//     （注意：寫入欄位是底線 dispatch_mode，讀回來時欄位叫 dispatchMode）
//
// 需要 .env：
//   DEROUTER_MGMT_KEY      = management key（與收益模組共用）
//   DEROUTER_CHAT_ID       = 接收調速通知的 Telegram ID
//   DISPATCH_ACCOUNTS      = （選填）上述 JSON 陣列；留空＝不自動調速
//   DISPATCH_MORNING_HOUR  = （選填）日間相位起始的台北小時，預設 8（＝UTC 換日）
//   DISPATCH_ENABLED       = （選填）設 false 可暫停自動調速（仍保留 /speed 手動指令）
// ==========================================
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.derouter.network/api';
const CONTAINERS_URL = `${API_BASE}/containers`;
const EARN_URL = `${API_BASE}/billing/earnings`;
const STATE_FILE = path.join(__dirname, 'dispatch_state.json');
const TZ = 'Asia/Taipei';

const TICK_MS = 60 * 1000;       // 每分鐘檢查時間相位
const EARN_MS = 5 * 60 * 1000;   // 每 5 分鐘檢查當日收益門檻
// 台北 08:00＝UTC 換日、當日收益歸零時刻；可用 DISPATCH_MORNING_HOUR 覆寫
const MORNING_HOUR = (() => {
    const raw = (process.env.DISPATCH_MORNING_HOUR || '').trim();
    if (raw === '') return 8;               // 未設定或留空 → 預設 8
    const h = Number(raw);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 8;
})();

const VALID_MODES = ['humanlike', 'normal', 'speed_2x', 'speed_3x', 'speed_5x'];
const ENABLED = String(process.env.DISPATCH_ENABLED || 'true').toLowerCase() !== 'false';

// ---- 帳號排程設定（來自 .env 的 DISPATCH_ACCOUNTS JSON）----
// 解析失敗或未設定 → 空陣列，代表不做自動調速，只保留 /speed、/quota 手動指令
const ACCOUNTS = (() => {
    const raw = (process.env.DISPATCH_ACCOUNTS || '').trim();
    if (!raw) return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        console.error('[dispatch] DISPATCH_ACCOUNTS 不是合法 JSON，自動調速停用:', e.message);
        return [];
    }
    if (!Array.isArray(parsed)) {
        console.error('[dispatch] DISPATCH_ACCOUNTS 必須是陣列，自動調速停用');
        return [];
    }
    return parsed
        .filter((a) => a && typeof a.email === 'string' && a.email)
        .map((a, i) => ({
            alias: String(a.alias || a.email.split('@')[0] || `acc${i + 1}`).toLowerCase(),
            email: a.email,
            dayMode: VALID_MODES.includes(a.dayMode) ? a.dayMode : null,
            nightMode: VALID_MODES.includes(a.nightMode) ? a.nightMode : null,
            thresholdUsd: Number(a.thresholdUsd) > 0 ? Number(a.thresholdUsd) : null,
            thresholdMode: VALID_MODES.includes(a.thresholdMode) ? a.thresholdMode : 'speed_2x',
        }));
})();

// ---- 狀態持久化（記錄各動作最後執行的台北日期，避免重複）----
function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
    catch (e) { console.error('[dispatch] 無法寫入狀態檔:', e.message); }
}

// ---- API ----
function authHeader() {
    const key = process.env.DEROUTER_MGMT_KEY;
    if (!key) throw new Error('缺少 DEROUTER_MGMT_KEY 環境變數');
    return { Authorization: `Bearer ${key}` };
}
async function fetchContainers() {
    const res = await axios.get(CONTAINERS_URL, { headers: authHeader(), timeout: 15000 });
    return res.data;
}
async function fetchToday() {
    const res = await axios.get(EARN_URL, { headers: authHeader(), timeout: 15000 });
    return Number(res.data.today);
}
// 用 email 從容器清單找出帳號當下的 containerId / accountId / 現在的模式
function findAccount(containers, email) {
    for (const c of containers || []) {
        for (const a of (c.accounts || [])) {
            if (a.email === email) {
                return { containerId: c.id, accountId: a.id, mode: a.dispatchMode };
            }
        }
    }
    return null;
}
async function setDispatch(containerId, accountId, mode) {
    await axios.patch(
        `${CONTAINERS_URL}/${containerId}/accounts/${accountId}`,
        { dispatch_mode: mode },
        { headers: { ...authHeader(), 'Content-Type': 'application/json' }, timeout: 15000 }
    );
}
// 啟動 / 暫停帳號（帳號層級，與儀表板帳號列的 stop/restart 按鈕相同：
// restart＝啟動、stop＝暫停）。務必 POST 不帶 body、不帶 Content-Type——
// 之前帶 `{}` body 時 stop 後容器曾進 error，改為與網頁請求完全一致。
async function setStatus(containerId, accountId, status) {
    const action = status === 'running' ? 'restart' : 'stop';
    await axios.post(
        `${CONTAINERS_URL}/${containerId}/accounts/${accountId}/${action}`,
        undefined,
        { headers: authHeader(), timeout: 60000 }
    );
}
// 列出所有容器裡的所有帳號（附 containerId），給動態選單用
function listAccounts(containers) {
    const out = [];
    for (const c of containers || []) {
        for (const a of (c.accounts || [])) {
            out.push({ containerId: c.id, accountId: a.id, email: a.email, mode: a.dispatchMode, status: a.status, containerStatus: c.status, containerError: c.error_message, banned: a.banned, expired: a.expired });
        }
    }
    return out;
}
// callback_data 放不下完整 UUID，用 accountId 前 8 碼即時比對（每次都查最新清單）
function findByIdPrefix(containers, prefix) {
    return listAccounts(containers).find((a) => a.accountId.startsWith(prefix)) || null;
}
function statusLabel(a) {
    if (a.banned) return '🚫 被封鎖';
    if (a.expired) return '⌛ 已過期';
    if (a.containerStatus === 'error') return '⚠️ 容器錯誤';
    // 帳號運作中的值是 'active'（'running' 是容器層級的值）；容器沒在跑就不算運作中
    return (a.containerStatus === 'running' && a.status === 'active') ? '▶️ 運作中' : '⏸ 已暫停';
}
// 某容器的各帳號額度（5 小時／週剩餘百分比、重置時間等）
async function fetchBudgets(containerId) {
    const res = await axios.get(`${CONTAINERS_URL}/${containerId}/budget`, { headers: authHeader(), timeout: 15000 });
    return Array.isArray(res.data) ? res.data : [];
}

// 指令用的短代號 → email（來自 DISPATCH_ACCOUNTS 的 alias）
const WHO_EMAIL = Object.fromEntries(ACCOUNTS.map((a) => [a.alias, a.email]));
// dispatch_mode → 顯示名稱
function modeLabel(m) {
    return { humanlike: 'Human-like', normal: 'Normal', speed_2x: 'Speed 2x', speed_3x: 'Speed 3x', speed_5x: 'Speed 5x' }[m] || m || '未知';
}
// UTC ISO 時間 → 台北 MM/DD HH:mm
function fmtTaipei(iso) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat('zh-TW', {
        timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
}

// ---- 台北現在的日期與小時 ----
function taipeiNow() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        hour: parseInt(get('hour'), 10),
    };
}

// ==========================================
// 主啟動函式
// ==========================================
function initDispatch(bot) {
    if (!process.env.DEROUTER_MGMT_KEY || !process.env.DEROUTER_CHAT_ID) {
        console.warn('[dispatch] 未設定 DEROUTER_MGMT_KEY 或 DEROUTER_CHAT_ID，調速模組略過啟動');
        return;
    }
    const CHAT_ID = process.env.DEROUTER_CHAT_ID;
    const OWNER_ID = Number(CHAT_ID);
    let state = loadState();
    const notify = (t) => bot.sendMessage(CHAT_ID, t).catch((e) => console.error('[dispatch] 通知失敗:', e.message));

    // 依 email 設定模式；回傳實際採用的模式，找不到或已是目標則不重複打
    async function applyMode(email, mode) {
        const containers = await fetchContainers();
        const acc = findAccount(containers, email);
        if (!acc) { notify(`自動調速：找不到帳號 ${email}，本次略過`); return null; }
        if (acc.mode === mode) return mode; // 已是目標模式，省一次寫入
        await setDispatch(acc.containerId, acc.accountId, mode);
        return mode;
    }

    // ---- 每分鐘：依台北時間切換日/夜相位（每相位每日一次，重啟自動補位）----
    // 夜間相位 00:00–(MORNING_HOUR-1):59 → 各帳號切到自己的 nightMode
    // 日間相位 MORNING_HOUR:00–23:59     → 各帳號切到自己的 dayMode
    async function scheduleTick() {
        if (!ENABLED || ACCOUNTS.length === 0) return;
        try {
            const { date, hour } = taipeiNow();
            const night = hour < MORNING_HOUR;
            const flag = night ? 'nightDate' : 'morningDate';
            if (state[flag] === date) return;          // 這個相位今天已經跑過
            const applied = [];
            for (const acc of ACCOUNTS) {
                const mode = night ? acc.nightMode : acc.dayMode;
                if (!mode) continue;                   // 這個帳號沒設定此相位 → 不動
                await applyMode(acc.email, mode);
                applied.push(`${acc.alias} → ${mode}`);
            }
            state[flag] = date;
            if (!night) state.thresholdDates = {};     // 新的一天，重置「已因門檻降速」旗標
            saveState(state);
            if (applied.length > 0) {
                notify(`自動調速（${night ? '夜間標準' : '日間衝量'}）：${applied.join('、')}`);
            }
        } catch (e) {
            console.error('[dispatch] 相位排程失敗:', e.message);
        }
    }

    // ---- 每 5 分鐘：當日收益達帳號門檻 → 切到 thresholdMode ----
    // 僅日間相位、僅當帳號仍停在早上設定的 dayMode 時才動（避免蓋掉手動調整），每日一次
    async function thresholdTick() {
        if (!ENABLED) return;
        const targets = ACCOUNTS.filter((a) => a.thresholdUsd != null);
        if (targets.length === 0) return;
        try {
            const { date, hour } = taipeiNow();
            if (hour < MORNING_HOUR) return;          // 夜間相位不套用
            if (!state.thresholdDates) state.thresholdDates = {};
            const pending = targets.filter((a) => state.thresholdDates[a.alias] !== date);
            if (pending.length === 0) return;         // 今天全都降過了
            const today = await fetchToday();
            const hit = pending.filter((a) => today >= a.thresholdUsd);
            if (hit.length === 0) return;
            const containers = await fetchContainers();
            for (const t of hit) {
                const acc = findAccount(containers, t.email);
                if (!acc) continue;
                if (t.dayMode && acc.mode !== t.dayMode) continue; // 已被手動改過 → 不覆蓋
                if (acc.mode !== t.thresholdMode) {
                    await setDispatch(acc.containerId, acc.accountId, t.thresholdMode);
                }
                state.thresholdDates[t.alias] = date;
                saveState(state);
                notify(`自動調速：${t.alias} 當日收益達 $${today.toFixed(2)}（≥ $${t.thresholdUsd}）→ ${t.thresholdMode}`);
            }
        } catch (e) {
            console.error('[dispatch] 門檻檢查失敗:', e.message);
        }
    }

    // ---- 互動選單：即時列出所有帳號 → 選帳號 → 調速度或啟動/暫停 ----
    // 選單以 inline keyboard 呈現，callback_data 格式：sp|<action>|<accountId前8碼>|...
    async function accountMenu() {
        const containers = await fetchContainers();
        const accounts = listAccounts(containers);
        if (accounts.length === 0) {
            return { text: '目前沒有任何帳號', reply_markup: { inline_keyboard: [[{ text: '關閉', callback_data: 'sp|x' }]] } };
        }
        const rows = accounts.map((a) => [{
            text: `${statusLabel(a)}　${a.email}　${modeLabel(a.mode)}`,
            callback_data: `sp|pick|${a.accountId.slice(0, 8)}`,
        }]);
        rows.push([{ text: '取消', callback_data: 'sp|x' }]);
        return { text: '目前的帳號（點選以調整）：', reply_markup: { inline_keyboard: rows } };
    }
    function accountDetailMenu(a) {
        const id8 = a.accountId.slice(0, 8);
        const mk = (m) => ({ text: (a.mode === m ? '✓ ' : '') + modeLabel(m), callback_data: `sp|set|${id8}|${m}` });
        const toggle = (a.containerStatus === 'running' && a.status === 'active')
            ? { text: '⏸ 暫停帳號', callback_data: `sp|st|${id8}|stopped` }
            : { text: '▶️ 啟動帳號', callback_data: `sp|st|${id8}|running` };
        return {
            text: `${a.email}\n狀態：${statusLabel(a)}・速度：${modeLabel(a.mode)}\n選擇動作：`,
            reply_markup: {
                inline_keyboard: [
                    [mk('humanlike'), mk('normal')],
                    [mk('speed_2x'), mk('speed_3x'), mk('speed_5x')],
                    [toggle],
                    [{ text: '‹ 返回', callback_data: 'sp|back' }, { text: '取消', callback_data: 'sp|x' }],
                ],
            },
        };
    }

    // ---- 手動調速指令（僅本人）----
    // /speed                    → 互動選單（即時列出所有帳號 → 調速/啟停）
    // /speed <email開頭> <mode> → 快速直接套用（代號＝DISPATCH_ACCOUNTS 裡的 alias）
    bot.onText(/^\/speed(?:@\S+)?(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i, async (msg, match) => {
        if (msg.from.id !== OWNER_ID) return;
        const who = (match[1] || '').toLowerCase();
        const mode = (match[2] || '').toLowerCase();
        if (who || mode) { // 快速路徑
            if (!VALID_MODES.includes(mode)) {
                return bot.sendMessage(msg.chat.id,
                    '用法：/speed <email開頭或代號> <humanlike|normal|speed_2x|speed_3x|speed_5x>\n（或直接 /speed 用選單）',
                    { message_thread_id: msg.message_thread_id });
            }
            try {
                let email = WHO_EMAIL[who]; // alias 優先
                if (!email) {
                    const containers = await fetchContainers();
                    const hits = listAccounts(containers).filter((a) => a.email.toLowerCase().startsWith(who));
                    if (hits.length === 0) {
                        return bot.sendMessage(msg.chat.id, `找不到 email 以「${who}」開頭的帳號`, { message_thread_id: msg.message_thread_id });
                    }
                    if (hits.length > 1) {
                        return bot.sendMessage(msg.chat.id, `「${who}」符合多個帳號：\n${hits.map((a) => a.email).join('\n')}\n請多打幾個字`, { message_thread_id: msg.message_thread_id });
                    }
                    email = hits[0].email;
                }
                const applied = await applyMode(email, mode);
                bot.sendMessage(msg.chat.id, applied ? `已將 ${email} 設為 ${modeLabel(mode)}` : `找不到 ${email} 帳號`,
                    { message_thread_id: msg.message_thread_id });
            } catch (e) {
                bot.sendMessage(msg.chat.id, `調速失敗：${e.message}`, { message_thread_id: msg.message_thread_id });
            }
            return;
        }
        try {
            const menu = await accountMenu();
            bot.sendMessage(msg.chat.id, menu.text, { reply_markup: menu.reply_markup, message_thread_id: msg.message_thread_id });
        } catch (e) {
            bot.sendMessage(msg.chat.id, `讀取帳號失敗：${e.message}`, { message_thread_id: msg.message_thread_id });
        }
    });

    // ---- 處理選單按鈕點擊 ----
    bot.on('callback_query', async (query) => {
        const data = query.data || '';
        if (!data.startsWith('sp|')) return; // 只處理本模組的按鈕
        if (query.from.id !== OWNER_ID) return bot.answerCallbackQuery(query.id, { text: '無權限', show_alert: true });
        const msg = query.message;
        const editOpts = { chat_id: msg.chat.id, message_id: msg.message_id };
        const parts = data.split('|');
        const action = parts[1];
        try {
            if (action === 'x') {
                await bot.editMessageText('已取消', editOpts);
            } else if (action === 'back') {
                const menu = await accountMenu();
                await bot.editMessageText(menu.text, { ...editOpts, reply_markup: menu.reply_markup });
            } else if (action === 'pick') {
                const containers = await fetchContainers();
                const acc = findByIdPrefix(containers, parts[2]);
                if (!acc) { await bot.editMessageText('找不到這個帳號（可能已被移除），請重新 /speed', editOpts); }
                else {
                    const menu = accountDetailMenu(acc);
                    await bot.editMessageText(menu.text, { ...editOpts, reply_markup: menu.reply_markup });
                }
            } else if (action === 'set') {
                const idp = parts[2], mode = parts[3];
                if (!VALID_MODES.includes(mode)) { return bot.answerCallbackQuery(query.id, { text: '參數錯誤' }); }
                const containers = await fetchContainers();
                const acc = findByIdPrefix(containers, idp);
                if (!acc) { await bot.editMessageText('找不到這個帳號（可能已被移除），請重新 /speed', editOpts); }
                else {
                    if (acc.mode !== mode) await setDispatch(acc.containerId, acc.accountId, mode);
                    await bot.editMessageText(`已將 ${acc.email} 設為 ${modeLabel(mode)}`, editOpts);
                }
            } else if (action === 'st') {
                const idp = parts[2], status = parts[3];
                if (!['running', 'stopped'].includes(status)) { return bot.answerCallbackQuery(query.id, { text: '參數錯誤' }); }
                const containers = await fetchContainers();
                const acc = findByIdPrefix(containers, idp);
                if (!acc) { await bot.editMessageText('找不到這個帳號（可能已被移除），請重新 /speed', editOpts); }
                else {
                    const isRunning = acc.containerStatus === 'running' && acc.status === 'active';
                    if ((status === 'running') !== isRunning) await setStatus(acc.containerId, acc.accountId, status);
                    await bot.editMessageText(
                        `${status === 'running' ? '▶️ 已啟動' : '⏸ 已暫停'} ${acc.email}`, editOpts);
                }
            }
            bot.answerCallbackQuery(query.id);
        } catch (e) {
            try { await bot.editMessageText(`操作失敗：${e.message}`, editOpts); } catch { /* ignore */ }
            bot.answerCallbackQuery(query.id, { text: '失敗' });
        }
    });

    // ---- 額度查詢（僅本人）：/quota ----
    bot.onText(/^\/(quota|額度|budget)(?:@\S+)?\b/i, async (msg) => {
        if (msg.from.id !== OWNER_ID) return;
        try {
            const containers = await fetchContainers();
            const emailOf = {};
            for (const c of containers || []) for (const a of (c.accounts || [])) emailOf[a.id] = a.email;
            const out = ['DeRouter 剩餘額度'];
            const covered = new Set(); // 有額度資料的 accountId
            for (const c of containers || []) {
                const budgets = await fetchBudgets(c.id);
                for (const b of budgets) {
                    covered.add(b.accountId);
                    const email = emailOf[b.accountId] || String(b.accountId).slice(0, 8);
                    const warn = b.fiveHourPct <= 0 ? '（5H 已用罄）' : b.weeklyPct <= 0 ? '（週額度用罄）' : '';
                    out.push(
                        '',
                        `${email}（${b.plan}）${warn}`,
                        `　5 小時剩 ${b.fiveHourPct ?? '—'}%・週剩 ${b.weeklyPct ?? '—'}%`,
                        `　5H 重置 ${fmtTaipei(b.resetAt)}・週重置 ${fmtTaipei(b.weeklyResetAt)}`
                    );
                }
            }
            // 平台對「暫停/剛加入還沒跑過」的帳號不會回額度資料，逐一列出原因，不再無聲空白
            const missing = listAccounts(containers).filter((a) => !covered.has(a.accountId));
            for (const a of missing) {
                out.push('', `${a.email}（${statusLabel(a)}）`, '　尚無額度資料（通常帳號啟動並開始跑任務後才會出現）');
            }
            if (covered.size === 0 && missing.length === 0) out.push('', '目前沒有任何帳號');
            bot.sendMessage(msg.chat.id, out.join('\n'), { message_thread_id: msg.message_thread_id });
        } catch (e) {
            bot.sendMessage(msg.chat.id, `讀取額度失敗：${e.message}`, { message_thread_id: msg.message_thread_id });
        }
    });

    if (ENABLED) {
        scheduleTick();                       // 啟動時先補到正確相位
        setInterval(scheduleTick, TICK_MS);   // 每分鐘檢查相位
        setInterval(thresholdTick, EARN_MS);  // 每 5 分鐘檢查收益門檻
    }
    const summary = ACCOUNTS.length === 0
        ? '未設定 DISPATCH_ACCOUNTS，僅 /speed 手動'
        : ACCOUNTS.map((a) => `${a.alias}：${String(MORNING_HOUR).padStart(2, '0')}:00→${a.dayMode || '不動'}`
            + (a.thresholdUsd != null ? `、當日≥$${a.thresholdUsd}→${a.thresholdMode}` : '')
            + `、00:00→${a.nightMode || '不動'}`).join('；');
    console.log(`✅ DeRouter 自動調速模組已啟動（${ENABLED ? '排程開啟' : '排程停用'}；${summary}）`);
}

module.exports = { initDispatch };
