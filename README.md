# SupplierPayment Bot (บอทสลิปโอนเงิน + เช็คราคา)

บอท LINE Messaging API + Google Apps Script + Gemini API
รับภาพสลิป/ข้อความรายงานรับเงินสด-โอนเงิน → แยกข้อมูลด้วย Gemini → บันทึกลง Google Sheets พร้อมส่งสรุป Flex Message กลับใน LINE และรองรับคำสั่งค้นหาราคาสินค้า `#ราคา`

## สารบัญ

- [ภาพรวม](#ภาพรวม)
- [โครงสร้างโปรเจ็กต์](#โครงสร้างโปรเจ็กต์)
- [ขั้นตอนการทำงาน](#ขั้นตอนการทำงาน)
- [สิ่งที่ต้องเตรียม](#สิ่งที่ต้องเตรียม)
- [การติดตั้ง](#การติดตั้ง)
- [การตั้งค่า Config (Secret อยู่นอกโค้ด)](#การตั้งค่า-config-secret-อยู่นอกโค้ด)
- [การ Deploy Web App และผูก LINE](#การ-deploy-web-app-และผูก-line)
- [การอัปเดตโค้ดในครั้งต่อไป](#การอัปเดตโค้ดในครั้งต่อไป)
- [การแก้ปัญหา (Troubleshooting)](#การแก้ปัญหา-troubleshooting)
- [Git กับ Version Control](#git-กับ-version-control)

## ภาพรวม

| รายการ | ค่า |
|---|---|
| Apps Script ID | `17Zpx8Xai5-QOCW9jPoSsSX_W60OBjw5iEas4ivSVL3asb7XgP_Txyqcm` |
| Webhook URL (Production) | `https://script.google.com/macros/s/AKfycbxleafYWEUIFQLbYqoR_1y0asrzA1mnvYSU9iUlpCJ1DWGnkh1PHtZIsiavjBvQil0O/exec` |
| ไฟล์สรุปสลิป (Spreadsheet ID) | `1B2FYoLxKPTim1rZOiLzTbXyJTA4tX2Qv4zI0JAZSmJM` |
| โฟลเดอร์ Drive ปลายทาง (Root Folder) | `1TkNqB6wW5GWmeV4f5rTQuJFcmDcGfLba` |
| แท็บบันทึกสลิป | `โอนเงิน` (ตั้งผ่าน `MAIN_SHEET_NAME`) |
| แท็บราคาสินค้า | `PriceList` (คอลัมน์ A=ชื่อ, B=ราคา, C=สต็อก) |

> ⚠️ **จุดสำคัญ:** โปรเจ็กต์นี้ **ไม่ได้ผูก (link) กับ GCP project ส่วนตัว**
> จึงใช้ GCP project เริ่มต้นของ Google → หลีกเลี่ยงปัญหา **"Authorize หลุดทุก 7 วัน"**
> ที่เกิดจาก OAuth consent screen ในสถานะ Testing ของ GCP project ที่ผูกเอง

## โครงสร้างโปรเจ็กต์

```
supplier-payment-bot/
├── Code.gs              # โค้ดหลักทั้งหมด (webhook + Gemini + Sheets + LINE)
├── appsscript.json      # manifest (timeZone Asia/Bangkok, webapp: Execute as Me / Anyone)
├── config.example.json  # ตัวอย่างคีย์ config (ไม่มีความลับ)
├── config.local.json    # ค่าจริง LINE token / Gemini key (ห้ามขึ้น Git / ห้าม push ขึ้น Script)
├── .claspignore         # กันไฟล์ลับ/ขยะ ไม่ push ขึ้น Apps Script
├── .gitignore           # กัน config.local.json / .clasp.json ไม่ commit เข้า Git
└── .clasp.json          # scriptId ของโปรเจ็กต์ (สร้างจาก clasp create - ไม่ commit)
```

## ขั้นตอนการทำงาน

```
LINE (ผู้ใช้ส่งสลิป/พิมพ์ข้อความ)
   │  POST webhook
   ▼
doPost()  ── lock + dedup กัน event ซ้ำ
   │
   ├── รูปภาพ  → getImageFromLine() ดาวน์โหลดจาก LINE
   │            → Gemini (image) อ่านสลิป → extractPaymentDetails()
   │            → ตรวจชื่อบัญชีปลายทาง (ALLOWED_RECEIVERS)
   │            → saveToSpreadsheet() → รูปผิดบัญชีบันทึกเป็น "รอตรวจสอบบัญชี"
   │            → ส่ง Flex Message กลับ LINE (reply → push fallback)
   │
   ├── ข้อความ "รับสด/รับโอน..."  → Gemini (text) แยก ยอด/ธนาคาร/ประเภท
   │                               → บันทึกสด/โอน/แบ่งจ่ายลง Sheet → ตอบกลับ
   │
   └── ข้อความ "#ราคา <คำค้น>"    → ค้นจากแท็บ PriceList (cache 5 นาที)
                                    → ตอบราคา + สถานะสต็อก
```

- **Gemini model (หลัก/สำรอง):** `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite`
- **Retry:** ลองทุก model ตัวละไม่เกิน 3 ครั้ง รองรับ 429/503/5xx พร้อม backoff
- **การส่งข้อความ:** พยายาม `reply` ก่อน ถ้า reply token หมดอายุ (ประมวลผลนานเกิน 5 วิ)
  → fallback เป็น `push` ไปหา user/group
- **อ่านสลิปล้มเหลว:** ไม่ push แจ้งเตือน แต่บันทึกแถว `อ่านล้มเหลว` + เหตุผลลง Sheet แทน

## สิ่งที่ต้องเตรียม

1. **LINE Developers** — Messaging API channel (มี Channel access token + Webhook URL)
2. **Gemini API key** — จาก Google AI Studio (Model: `gemini-3.5-flash-lite`)
3. **Google Account (iaumba@gmail.com)** — ถือ LINE bot / Sheets / Drive Folder
4. **เครื่องมือบน PC:**
   - Git (`git --version`)
   - clasp (`clasp.cmd` ที่ติดตั้งจาก npm — บนเครื่องนี้: `C:\tools\node-v20.11.1-win-x64\clasp.cmd`)

## การติดตั้ง

> คำสั่งตัวอย่างใช้ `$clasp = "C:\tools\node-v20.11.1-win-x64\clasp.cmd"`
> (ถ้าลง clasp ใน PATH แล้ว ใช้ `clasp` ตรง ๆ ได้)

### 1) สร้าง/โคลนโปรเจ็กต์

```powershell
mkdir C:\bankslip\supplier-payment-bot
cd C:\bankslip\supplier-payment-bot
```

### 2) ล็อกอิน clasp (ครั้งแรกของเครื่อง)

```powershell
& $clasp login          # เปิด browser เลือกบัญชีที่ถือ LINE/Sheets (iaumba@gmail.com)
```

ก่อนใช้งาน `clasp run` / `clasp push` ให้เปิดใช้**Apps Script API** ครั้งเดียว:
https://script.google.com/home/usersettings → เปิด "Apps Script API"

### 3) สร้างไฟล์ config

คัดลอก `config.example.json` → `config.local.json` แล้วใส่ค่าจริง:

```json
{
  "LINE_CHANNEL_ACCESS_TOKEN": "<token จาก LINE Developers>",
  "GEMINI_API_KEY": "<key จาก Google AI Studio>",
  "MAIN_SHEET_NAME": "โอนเงิน"
}
```

> `config.local.json` **ห้าม commit เข้า Git**, ห้าม push ขึ้น Script
> (กันไว้แล้วใน `.gitignore` และ `.claspignore`)

### 4) สร้างโปรเจ็กต์ Script

```powershell
& $clasp create --type standalone --title "SupplierPayment Bot"
```

> ⚠️ `clasp create` จะโคลน `appsscript.json` เปล่าของ Google มาทับของเรา
> (timeZone กลายเป็น `America/New_York` และ **หายบล็อก `webapp`**) → ต้องแก้กลับเป็น:

```json
{
  "timeZone": "Asia/Bangkok",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  }
}
```

แล้ว push:

```powershell
& $clasp push -f        # -f บังคับ push แม้ clasp คิดว่า "ไม่มีอะไรเปลี่ยน" (bug ที่เจอ)
```

## การตั้งค่า Config (Secret อยู่นอกโค้ด)

ค่า secret จะถูกเก็บใน **Script Properties** ของโปรเจ็กต์ (อ่านด้วย `_getConfig()`)
โค้ดใน Git ไม่มีค่าเหล่านี้ ไม่ว่าใครก็ pull โค้ดไปก็ไม่เห็นความลับ

ค่าที่ต้องมี:

| Key | ตัวอย่าง | หมายเหตุ |
|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | `gkqi...FU=` | Channel access token ของ Messaging API |
| `GEMINI_API_KEY` | `AQ.Ab...` | Gemini API key |
| `MAIN_SHEET_NAME` | `โอนเงิน` | ชื่อแท็บที่ใช้บันทึกสลิป |

**วิธีเซ็ต (เลือกอย่างใดอย่างหนึ่ง):**

- **A. ผ่านฟังก์ชัน helper (วิธีแนะนำ):** push โค้ดขึ้นก่อน แล้วรัน `setConfig(props)`
  โดยใส่ค่าใน `config.local.json` — ถ้า `clasp run` ใช้ได้:
  ```powershell
  $config = Get-Content -Raw config.local.json | ConvertFrom-Json
  & $clasp run setConfig --params (@($config) | ConvertTo-Json -Compress)
  & $clasp run verifyConfig    # ควรได้ "OK: Config ครบถ้วน"
  ```
- **B. ผ่าน Script Editor:** ⚙️ Project Settings → ปุ่ม **Script Properties** →
  เพิ่ม key/value แต่ละตัว หรือรัน `setConfig` เอง

> หมายเหตุ: `clasp run` บนโปรเจ็กต์ที่ใช้ GCP project เริ่มต้นอาจ error
> `NOT_FOUND ... while reading from storage` (เป็น bug ฝั่ง Google)
> ถ้าเจอให้ใช้วิธี B (Script Editor) แทน

## การ Deploy Web App และผูก LINE

### 1) Deploy Web App

**วิธีที่เสถียรที่สุด = deploy ผ่าน Script Editor (UI):**
1. เปิด `https://script.google.com/d/<SCRIPT_ID>/edit` (ล็อกอิน iaumba@gmail.com)
2. กด **Deploy → New deployment** → type: **Web app**
   - Execute as: **Me (iaumba@gmail.com)**
   - Who has access: **Anyone**
3. กด Deploy → copy **Web app URL** (ลงท้ายด้วย `/exec`)

> (ทำไมไม่ใช้ `clasp deploy`? deployment ที่สร้าง/ redeploy ผ่าน clasp API
> มักยังไม่ผ่านขั้น authorize และจะคืน 404/302 จนกว่าจะเปิด URL ใน browser
> สำหรับผู้ที่เป็น owner ครั้งแรก — ใช้ UI จะ authorize ให้ตอน deploy เอง)

### 2) ตั้ง Webhook ใน LINE Developers Console

1. LINE Developers Console → Messaging API channel → **Webhook URL**
2. วาง URL ใหม่ (ลงท้าย `/exec`)
3. **ปุ่ม Verify ขึ้น "302 Found" ให้ข้ามได้เลย**
   (ทุก Apps Script web app ตอบ 302 → redirect ไป `/macros/echo` ก่อน แต่ LINE
   ที่ส่ง webhook จริงจะตาม redirect ได้ — ตัวเก่า/ตัวใหม่ตอบเหมือนกันหมด)
4. เปิด **"Use webhook"** →บันทึก

### 3) ทดสอบ

- ส่งสลิปธนาคาร → ควรได้ Flex Message สีฟ้า + ข้อมูลลงแท็บ "โอนเงิน"
- พิมพ์ `รับสด 500` / `รับโอน 500` → ตอบกลับ + ลง Sheet
- พิมพ์ `#ราคา ปูอัด` → ค้นราคาจากแท็บ PriceList
- สลิปที่อ่านไม่สำเร็จ → แถว `อ่านล้มเหลว` + เหตุผล ถูกบันทึกลง Sheet

## การอัปเดตโค้ดในครั้งต่อไป

```powershell
# แก้โค้ด Code.gs เสร็จแล้ว:
& $clasp push -f                             # push ขึ้น Script (HEAD)
& $clasp version "v<N> - <desc>"             # ตั้งชื่อ version (ถ้าต้องการ)
# Deploy ใหม่:
#   - ใช้ UI: Deploy → Manage deployments → Edit/deploy → เลือก version ใหม่
#   (หรือ clasp deploy แล้วเปิด URL ใน browser เพื่อ authorize)
git add -A
git commit -m "feat: ..."                     # commit ตามสไตล์เดิม
git push                                      # ถ้ามี remote
```

**ไฟล์สรุปสลิป (สร้างครั้งแรก):** ถ้าต้องสร้างสเปรดชีตใหม่ในโฟลเดอร์ + คัดลอก PriceList
ให้รัน `createRecordSpreadsheet()` แล้วนำ `spreadsheetId` กลับไปอัปเดต
`SPREADSHEET_ID` และ `PRICE_FILE_ID` ใน `Code.gs`
(ตอนนี้ชี้อยู่ที่ `1B2FYoLxKPTim1rZOiLzTbXyJTA4tX2Qv4zI0JAZSmJM` แล้ว)

## การแก้ปัญหา (Troubleshooting)

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| Authorize หลุดทุก 7 วัน | โปรเจ็กต์ถูกผูก GCP project ที่ consent screen เป็น Testing → ใช้ GCP เริ่มต้น (ไม่ผูก) เหมือนตัวนี้ และไม่เกิดซ้ำ |
| `clasp run` error `NOT_FOUND ... reading from storage` | bug ของ Apps Script API บน GCP เริ่มต้น → ใช้ตั้ง config ผ่าน Script Editor หรือ URL แทน |
| `clasp push` แสดง "Skipping push." | clasp เทียบ hash แล้วคิดว่าไม่มีอะไรเปลี่ยน → ใช้ `clasp push -f` |
| `clasp create` แล้ว webapp 404 | `clasp create` เขียนทับ manifest → ตรวจ `appsscript.json` ว่ายังมีบล็อก `webapp` อยู่ แล้ว `push -f` อีกครั้ง |
| LINE Verify "302 Found" | redirect ของ Google normal (echo) → LINE จริงตามได้ ข้ามได้ |
| Deployment 404 ทั้ง GET/POST | deployment ไม่ได้ผ่าน authorize → deploy ผ่าน UI หรือเปิด URL ใน browser ของ owner รอบแรก |
| Gemini 503 (demand สูง) | โค้ดมี fallback model + retry อัตโนมัติ 3 รอบ |
| Push quota LINE หมด (429) | ฟรี 500/เดือน → ระบบใช้ reply ก่อน push แค่ fallback |
| อ่านสลิปไม่ได้ (รูปถูกลบ/หมดอายุ) | ต้องดาวน์โหลดรูปจาก LINE ให้เร็วที่สุด — ถ้าล้มเหลวจะบันทึกแถว `อ่านล้มเหลว` + เหตุผลลง Sheet แทน |

## Git กับ Version Control

โปรเจ็กต์ใช้ Git ในโฟลเดอร์ `supplier-payment-bot` หลักการ:

- **Commit สิ่งที่ควร commit:** `Code.gs`, `appsscript.json`, `config.example.json`,
  `.gitignore`, `.claspignore`, เอกสาร
- **ห้าม commit (กันไว้แล้ว):**
  - `config.local.json` — secret จริง
  - `.clasp.json` — scriptId เฉพาะเครื่อง (สร้างใหม่ได้ด้วย clasp create)
- **สไตล์ commit message:** `feat:`, `fix:`, `docs:` + ภาษาไทยสั้นชัดเจน
- Identity ใช้ชื่อ `bankslip <bankslip@local>` ตอน commit ถ้ายังไม่ตั้ง global Git config

### ไฟล์ที่เกี่ยวข้อง (นอกโปรเจ็กต์นี้)

- `C:\bankslip\รหัส.gs` — โค้ดเวอร์ชันก่อนหน้า (ย้ายมาอยู่ที่ `Code.gs` แล้ว)
- `C:\bankslip\บันทึกเงินสด โพนพิสัย` — spec ฟีเจอร์เสริม `sendYesterdayLineReport`
  (รายงานสรุปยอดประจำวัน) ยังไม่ได้ implement ในโปรเจ็กต์นี้