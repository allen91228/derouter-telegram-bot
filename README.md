# DeRouter Telegram Bot

用 Telegram 監控 [DeRouter](https://derouter.network) 收益、查詢額度，並自動／手動調整各帳號的派工速度與啟停狀態。

一個人跑多個帳號時，最麻煩的是：不知道今天賺多少、額度快用完沒感覺、想調速度得開後台。這支 bot 把這三件事都搬進 Telegram，並且能依時間相位與當日收益自動調速。

## 功能

**收益推播（`derouter.js`）**
- 每 5 分鐘輪詢一次收益，當日收益每跨過一個門檻（預設每 $1）就推播
- 每天早上（預設台北 08:00，即 UTC 換日時刻）送出前一日損益報告：昨日收益、昨日損益、本期回本進度條、月底推估
- 當日收益跨過設定的達標門檻（例如 $7 / $14）時提醒，並附「平均達標時間」與「比平均早／晚多久」
- `/derouter`（或 `/earn`、`/收益`）即時查詢今日／本週／累計收益

**帳號控制（`dispatch.js`）**
- `/speed` 開互動選單：列出所有帳號的狀態與目前速度，點選即可改速度或啟動／暫停
- `/speed <email開頭或代號> <mode>` 快速直接套用
- `/quota` 查各帳號 5 小時／週剩餘額度與重置時間
- 自動排程：日間相位切到 `dayMode`、夜間相位切到 `nightMode`；當日收益達門檻可再降速

所有指令只有 `DEROUTER_CHAT_ID` 指定的 Telegram user ID 能用，其他人一律忽略。

## 安裝

需要 Node.js 18 以上。

```bash
git clone https://github.com/kennyf506/derouter-telegram-bot.git
cd derouter-telegram-bot
npm install
cp .env.example .env
# 編輯 .env 填入 token、management key、chat id
npm start
```

用 [PM2](https://pm2.keymetrics.io/) 常駐：

```bash
pm2 start index.js --name derouter-bot
pm2 save
```

## 設定

完整說明見 [`.env.example`](.env.example)，以下是必填三項：

| 變數 | 說明 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | 向 [@BotFather](https://t.me/BotFather) 申請的 bot token |
| `DEROUTER_MGMT_KEY` | DeRouter 後台取得的 management key |
| `DEROUTER_CHAT_ID` | 你的 Telegram user ID（向 [@userinfobot](https://t.me/userinfobot) 查詢），也是唯一有權使用指令的人 |

### 自動調速

`DISPATCH_ACCOUNTS` 是一段 JSON 陣列，描述每個帳號在日／夜相位要切到哪個模式：

```json
[
  {
    "alias": "main",
    "email": "you@example.com",
    "dayMode": "speed_5x",
    "nightMode": "normal",
    "thresholdUsd": 14,
    "thresholdMode": "speed_2x"
  },
  {
    "alias": "sub",
    "email": "sub@example.com",
    "dayMode": "speed_2x",
    "nightMode": "normal"
  }
]
```

上面這組的行為是：台北 08:00 起 `main` 衝 5x、`sub` 跑 2x；`main` 當日收益達 $14 就降到 2x 保額度；台北 00:00 起兩個都回 `normal` 休息。留空 `DISPATCH_ACCOUNTS` 就完全不自動調速，只保留手動指令。

可用模式：`humanlike`、`normal`、`speed_2x`、`speed_3x`、`speed_5x`。

幾個設計上的取捨：

- **用 email 而不是 accountId 指定帳號**。帳號移除再加入時 accountId 會變，email 不會，所以每次動作都即時用 email 查出當下的 ID。
- **每個相位每天只執行一次**，用台北日期當旗標寫進狀態檔，重啟不會重複推播；啟動時會依當下時間自動補到正確相位。
- **門檻降速只在帳號仍停在 `dayMode` 時才動**，你手動調過就不會被蓋掉。
- **收益日以 UTC 換日**（台北早上 8 點歸零），與 DeRouter API 的 `today` 欄位一致，所以預設的相位切換點也定在台北 08:00。

## 時區

程式內固定以 `Asia/Taipei` 呈現時間。若要改成其他時區，修改 `derouter.js` 與 `dispatch.js` 開頭的 `TZ` 常數即可，但請注意「收益日」本身是 UTC 換日，與顯示時區無關。

## 狀態檔

執行時會在專案目錄產生 `derouter_state.json` 與 `dispatch_state.json`，記錄已推播過的門檻、昨日收益基準、各相位最後執行日期等，避免重啟後重複發訊息。兩個檔案都已列入 `.gitignore`。

## 免責

這是個人自用工具整理後開源，與 DeRouter 官方無關。API 端點與欄位若有變動可能需要調整。使用前請自行確認符合平台的服務條款。

## License

MIT
