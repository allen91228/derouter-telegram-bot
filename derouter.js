// ==========================================
// 💰 DeRouter 收益推播模組
// ------------------------------------------
// 功能：
//   1. 每 5 分鐘輪詢一次收益，「當日收益」每跨過一個整數美元就提醒（訊息附累計金額）
//   2. 每天早上 8 點（台北時間＝UTC 換日）主動送出前一日總結
//   3. 當日收益跨過每個門檻（預設 $7、$14）時提醒達標，附平均達標時間與早/晚比較
//   4. 指令即時查詢：/derouter（或 /earn、/收益）
//
// 需要 .env 設定：
//   DEROUTER_MGMT_KEY  = 你的 DeRouter management key
//   DEROUTER_CHAT_ID   = 要接收自動推播的 Telegram ID
//   DEROUTER_ALERT_STEP= （選填）每跨過多少美元提醒一次，預設 1
//   DEROUTER_DAILY_HOUR= （選填）每天幾點送總結（台北時間 0–23），預設 8
//   DEROUTER_BILLING_START=（選填）第一期訂閱起始日 YYYY-MM-DD，之後每月自動換期
//   DEROUTER_MONTHLY_COST= （選填）月成本，用於回本進度
//   DEROUTER_DAILY_COST=   （選填）日成本，用於昨日損益
// ==========================================
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API_URL = 'https://api.derouter.network/api/billing/earnings';
const STATE_FILE = path.join(__dirname, 'derouter_state.json');

const POLL_MS = 5 * 60 * 1000;   // 每 5 分鐘輪詢一次
// 每跨過多少美元通知一次（可用 .env 的 DEROUTER_ALERT_STEP 覆寫，預設 1＝每個整數）
const ALERT_STEP = Math.max(1, Number(process.env.DEROUTER_ALERT_STEP) || 1);
// 每天幾點送總結（台北時間 0–23，可用 .env 的 DEROUTER_DAILY_HOUR 覆寫，預設 8＝UTC 換日時刻）
const DAILY_HOUR = (() => {
    const raw = (process.env.DEROUTER_DAILY_HOUR || '').trim();
    if (raw === '') return 8;               // 未設定或留空 → 預設 8
    const h = Number(raw);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 8;
})();
const TZ = 'Asia/Taipei';        // 以台北時間為準

// ---- 訂閱成本（供每日損益報告用；沒設定就只顯示收益不算損益）----
// BILLING_START 是「第一期」的起始日，之後每月同日自動滾入新的一期，不需手動更新
const BILLING_START = (process.env.DEROUTER_BILLING_START || '').trim(); // YYYY-MM-DD
const MONTHLY_COST = Number(process.env.DEROUTER_MONTHLY_COST) || 0;
const DAILY_COST = Number(process.env.DEROUTER_DAILY_COST) || 0;
// 每日「達標」門檻（美元，可多個）。每個門檻各自記錄達標時間與平均，達標時提醒。
// 預設＝日成本與其兩倍（例：7 → 7,14）；可用 DEROUTER_GOAL_TARGETS=7,14 覆寫。
const GOAL_TARGETS = (() => {
    const raw = (process.env.DEROUTER_GOAL_TARGETS || '').trim();
    if (raw) return raw.split(',').map(Number).filter((n) => n > 0).sort((a, b) => a - b);
    return DAILY_COST > 0 ? [DAILY_COST, DAILY_COST * 2] : [];
})();

// 回傳包含 dateStr 那一天的「本期起始日」（從 BILLING_START 每月同日滾動）
// 例：BILLING_START=2026-07-15 → 7/15–8/14 回傳 07-15、8/15 起回傳 08-15…
function currentPeriodStart(dateStr) {
    const [sy, sm, sd] = BILLING_START.split('-').map(Number);
    const [y, mo, day] = dateStr.split('-').map(Number);
    let months = (y - sy) * 12 + (mo - sm);
    if (day < sd) months -= 1;      // 這個月的續訂日還沒到 → 仍屬上一期
    if (months < 0) months = 0;     // dateStr 早於第一期 → 視為第一期
    const total = sm - 1 + months;
    const py = sy + Math.floor(total / 12);
    const pm = (total % 12) + 1;
    const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    const pd = Math.min(sd, lastDay); // 該月沒有這一天（如 31 號）就取月底
    return `${py}-${String(pm).padStart(2, '0')}-${String(pd).padStart(2, '0')}`;
}

// 本期總天數（到下一期起始日為止；+32 天必落在下一期內，再反查其起始日）
function daysInPeriod(periodStart) {
    const start = new Date(`${periodStart}T00:00:00Z`);
    const probe = new Date(start.getTime() + 32 * 86400000).toISOString().slice(0, 10);
    const nextStart = new Date(`${currentPeriodStart(probe)}T00:00:00Z`);
    return Math.round((nextStart - start) / 86400000);
}

// ---- 狀態持久化（避免重啟後重複發提醒）----
function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return { lastAlertAllTime: null, lastDailySent: null };
    }
}
function saveState(s) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
    } catch (e) {
        console.error('[derouter] 無法寫入狀態檔:', e.message);
    }
}

// ---- 打 DeRouter API 拿收益 ----
// 回傳：{ today, todayTasks, week, weekTasks, allTime, allTimeTasks, requestsAll }
async function fetchEarnings() {
    const key = process.env.DEROUTER_MGMT_KEY;
    if (!key) throw new Error('缺少 DEROUTER_MGMT_KEY 環境變數');
    const res = await axios.get(API_URL, {
        headers: { Authorization: `Bearer ${key}` },
        timeout: 15000,
    });
    return res.data;
}

// ---- 把收益資料排版成 Telegram 訊息 ----
function formatEarnings(d) {
    const m = (n) => `$${Number(n).toFixed(4)}`;
    return (
        `💰 <b>DeRouter 收益</b>\n\n` +
        `📅 今日 Today：<b>${m(d.today)}</b>（${d.todayTasks} tasks）\n` +
        `🗓 本週 Week：<b>${m(d.week)}</b>（${d.weekTasks} tasks）\n` +
        `🏆 累計 AllTime：<b>${m(d.allTime)}</b>（${d.allTimeTasks} tasks）\n` +
        `📨 Requests Served：<b>${d.requestsAll}</b>\n\n` +
        `<i>※ today/week 以 UTC 日界計算（UTC 午夜＝台北早上 8 點換日）</i>`
    );
}

// ---- 每日損益報告排版 ----
function formatDaily(d, state, taipeiDate) {
    const m = (n) => `$${Number(n).toFixed(4)}`;
    const yd = state.yesterdayTotal;
    const lines = [`昨日收益：<b>${yd == null ? '（尚無紀錄）' : m(yd)}</b>`];

    if (yd != null && DAILY_COST > 0) {
        const pnl = yd - DAILY_COST;
        const sign = pnl >= 0 ? '+' : '-';
        lines.push(`昨日損益：<b>${sign}$${Math.abs(pnl).toFixed(4)}</b>`);
    }

    if (state.billingStart && state.billingBaseline != null && MONTHLY_COST > 0) {
        const earned = Number(d.allTime) - state.billingBaseline;
        const pct = (earned / MONTHLY_COST) * 100;
        const day = Math.floor(
            (new Date(`${taipeiDate}T00:00:00Z`) - new Date(`${state.billingStart}T00:00:00Z`)) / 86400000
        ) + 1;
        const filled = Math.max(0, Math.min(20, Math.round(pct / 5))); // 20 格，每格 5%
        lines.push(
            '',
            `本期進度（第 ${day} 天）`,
            `　已賺 $${earned.toFixed(2)} ／ 月成本 $${MONTHLY_COST}（${pct.toFixed(1)}%）`,
            `　${'▓'.repeat(filled)}${'░'.repeat(20 - filled)}`
        );
        // 早上 8 點報告時「第 N 天」剛開始，已完成 N-1 個整天；第 1 天資料不足不推估
        const doneDays = day - 1;
        if (doneDays >= 1) {
            const projected = (earned / doneDays) * daysInPeriod(state.billingStart);
            lines.push(`　推估月底約 $${Math.round(projected)}`);
        }
    }

    lines.push('', `累計 AllTime：<b>${m(d.allTime)}</b>`, `Requests Served：<b>${d.requestsAll}</b>`);
    return lines.join('\n');
}

// ---- 記錄 today 的最後數值，UTC 換日時把它存成「昨日總收益」----
// （API 沒有昨日欄位；today 在 UTC 午夜歸零，所以換日前最後一次輪詢的值＝昨日總額）
function trackToday(state, d) {
    const nowDate = new Date().toISOString().slice(0, 10); // UTC 日期
    if (state.todayDate !== nowDate) {
        // 只有在紀錄的日期正好是「昨天」時才採用，避免停機多天後拿到過期數字
        const prev = new Date(`${nowDate}T00:00:00Z`);
        prev.setUTCDate(prev.getUTCDate() - 1);
        const yesterdayStr = prev.toISOString().slice(0, 10);
        state.yesterdayTotal = state.todayDate === yesterdayStr ? state.todayValue : null;
        state.todayDate = nowDate;
    }
    state.todayValue = Number(d.today);
    // 進入新的一期（含第一次啟動）時記下基準：本期已賺＝目前 allTime − 基準
    // 基準扣掉 d.today，讓「換期當天已跑出的收益」也算進新的一期
    if (BILLING_START) {
        const periodStart = currentPeriodStart(nowDate);
        if (state.billingStart !== periodStart) {
            state.billingStart = periodStart;
            state.billingBaseline = Number(d.allTime) - Number(d.today);
        }
    }
    saveState(state);
}

// ---- 今日達標的時間工具 ----
// 「收益日」以 UTC 換日（台北早上 8 點），所以達標耗時＝UTC 午夜起經過的分鐘數
function minutesIntoUtcDay() {
    return Math.floor((Date.now() % 86400000) / 60000);
}
function taipeiClock() {
    return new Intl.DateTimeFormat('zh-TW', {
        timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
}
function fmtDuration(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h} 小時 ${m} 分鐘` : `${m} 分鐘`;
}
// 把一組「UTC 日內分鐘數」的平均，換算成台北時鐘 HH:MM
function avgClockTaipei(times) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const t = Math.round((avg + 8 * 60) % 1440); // UTC 分鐘 +8 小時 → 台北
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// ---- 取得「現在」的台北日期字串與小時，用來判斷是否到 DAILY_HOUR ----
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
// 主啟動函式：把整個模組掛到既有的 bot 上
// ==========================================
function initDeRouter(bot) {
    if (!process.env.DEROUTER_MGMT_KEY || !process.env.DEROUTER_CHAT_ID) {
        console.warn('[derouter] 未設定 DEROUTER_MGMT_KEY 或 DEROUTER_CHAT_ID，收益模組略過啟動');
        return;
    }
    const CHAT_ID = process.env.DEROUTER_CHAT_ID;
    const OWNER_ID = Number(CHAT_ID); // 只有本人能用指令查自己的收益
    let state = loadState();

    // ---- 指令：即時查詢（僅限本人）----
    bot.onText(/^\/(derouter|earn|收益)\b/, async (msg) => {
        if (msg.from.id !== OWNER_ID) return; // 非本人一律忽略，保護個人收益隱私
        try {
            const d = await fetchEarnings();
            bot.sendMessage(msg.chat.id, formatEarnings(d), {
                parse_mode: 'HTML',
                message_thread_id: msg.message_thread_id,
            });
        } catch (e) {
            bot.sendMessage(msg.chat.id, `❌ 讀取 DeRouter 收益失敗：${e.message}`, {
                message_thread_id: msg.message_thread_id,
            });
        }
    });

    // ---- 每 5 分鐘輪詢：今日收益每「跨過一個 $ALERT_STEP 關卡」就提醒 ----
    // 以「當日收益」為基礎（每天 UTC 換日歸零、關卡重來），訊息中仍附上累計金額。
    async function poll() {
        try {
            const d = await fetchEarnings();
            trackToday(state, d);                      // 順手記錄，供每日總結算「昨日收益」
            checkDailyGoal(d);                         // 今日是否達各門檻（達標提醒）
            const today = Number(d.today);             // 當日收益（UTC 午夜歸零）
            const at = Number(d.allTime);              // 累計值
            const nowUtcDate = new Date().toISOString().slice(0, 10);
            const levelNow = Math.floor(today / ALERT_STEP); // 今日跨到第幾個關卡

            if (state.todayLevelDate !== nowUtcDate) {
                // 新的一天：today 已歸零，重設每日關卡基準，不發提醒
                state.todayLevelDate = nowUtcDate;
                state.lastTodayLevel = levelNow;
                saveState(state);
            } else if (state.lastTodayLevel == null) {
                state.lastTodayLevel = levelNow;
                saveState(state);
            } else if (levelNow > state.lastTodayLevel) {
                state.lastTodayLevel = levelNow; // 基準推進到目前關卡
                saveState(state);
                bot.sendMessage(
                    CHAT_ID,
                    `DeRouter 今日收益突破 $${levelNow * ALERT_STEP}（目前累計 $${at.toFixed(4)}、${d.allTimeTasks} tasks）`
                );
            }
        } catch (e) {
            console.error('[derouter] 輪詢失敗:', e.message);
        }
    }

    // ---- 今日達標：today 跨過每個 $GOAL_TARGETS 門檻 → 各提醒一次並記錄達標耗時 ----
    // 每個門檻各自維護歷史達標耗時（state.goals[門檻].times，最多 60 筆），用來算平均、比早晚。
    function checkDailyGoal(d) {
        if (GOAL_TARGETS.length === 0) return;
        const today = Number(d.today);
        const nowDate = new Date().toISOString().slice(0, 10); // UTC 收益日
        if (!state.goals) state.goals = {};

        for (const target of GOAL_TARGETS) {
            if (today < target) continue;              // 尚未達此門檻
            const key = String(target);
            const g = state.goals[key] || { date: null, times: [] };
            if (g.date === nowDate) continue;          // 今天此門檻已提醒過

            const mins = minutesIntoUtcDay();
            const prior = Array.isArray(g.times) ? g.times : [];
            let extra = '';
            if (prior.length > 0) {
                extra += `\n平均達標時間 ${avgClockTaipei(prior)}`;
                const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
                const diff = Math.round(avg - mins); // 正＝比平均早
                extra += diff === 0 ? '\n與平均達標時間相同'
                    : diff > 0 ? `\n較平均早了 ${fmtDuration(diff)}達標`
                    : `\n較平均晚了 ${fmtDuration(-diff)}達標`;
            }
            g.date = nowDate;
            g.times = [...prior, mins].slice(-60);
            state.goals[key] = g;
            saveState(state);
            bot.sendMessage(
                CHAT_ID,
                `達成今日 $${target} 目標（${taipeiClock()}，今日收益 $${today.toFixed(4)}）` + extra
            );
        }
    }

    // ---- 每分鐘檢查一次：到台北 08:00（UTC 換日）且今天還沒送過 → 送前一日總結 ----
    async function dailyCheck() {
        const { date, hour } = taipeiNow();
        if (hour === DAILY_HOUR && state.lastDailySent !== date) {
            state.lastDailySent = date;
            saveState(state);
            try {
                const d = await fetchEarnings();
                trackToday(state, d); // 讓換日邏輯先跑，確保 yesterdayTotal／基準已更新
                // 依時段選問候語（早/午/晚），避免半夜還說「早安」
                const greet = DAILY_HOUR < 5 ? '夜深了' :
                              DAILY_HOUR < 12 ? '早安' :
                              DAILY_HOUR < 18 ? '午安' : '晚安';
                bot.sendMessage(
                    CHAT_ID,
                    `<b>${greet}！DeRouter 每日損益報告</b>\n\n` + formatDaily(d, state, date),
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                bot.sendMessage(CHAT_ID, `每日損益報告讀取失敗：${e.message}`);
            }
        }
    }

    poll();                          // 啟動時先跑一次（建立基準）
    setInterval(poll, POLL_MS);      // 每 5 分鐘
    setInterval(dailyCheck, 60 * 1000); // 每分鐘檢查是否到 09:00
    console.log(`✅ DeRouter 收益推播模組已啟動（今日每 $${ALERT_STEP} 提醒、達標門檻 $${GOAL_TARGETS.join('/$') || '—'}、每天 ${String(DAILY_HOUR).padStart(2, '0')}:00 送總結）`);
}

module.exports = { initDeRouter };
