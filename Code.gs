function myFunction() {

}


// ==========================================
// 1. CONFIGURATION (ส่วนตั้งค่าระบบ)
// ==========================================
const SPREADSHEET_ID = '1B2FYoLxKPTim1rZOiLzTbXyJTA4tX2Qv4zI0JAZSmJM';

// Secret อ่านจาก Script Properties (ดูวิธีตั้งค่าใน setConfig() ด้านล่าง)
const LINE_CHANNEL_ACCESS_TOKEN = _getConfig('LINE_CHANNEL_ACCESS_TOKEN');
const GEMINI_API_KEY = _getConfig('GEMINI_API_KEY');
const PRICE_SHEET_NAME = 'PriceList';          // ชื่อแท็บเก็บราคาสินค้า
const PRICE_FILE_ID = '1B2FYoLxKPTim1rZOiLzTbXyJTA4tX2Qv4zI0JAZSmJM'; // ไฟล์ Google export Product (ไว้เช็คเวลาแก้ไขล่าสุด)

// model ตัวแรก = ตัวหลัก, ตัวหลัง = ตัวสำรองเมื่อตัวหลักโดน 503 (demand สูง)
const GEMINI_MODELS_IMAGE = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const GEMINI_MODELS_TEXT  = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

// รายชื่อบัญชีปลายทางที่อนุญาตให้บันทึกข้อมูล
const ALLOWED_RECEIVERS = [
  "วีรชาติ",
  "พวงประ",
  "ทองสุขโพนทอง",
  "ทองสุข โพนทอง",
  "THONGSUK"
];

// Cache ระดับ execution (ใช้ซ้ำในรอบเดียว ไม่ต้อง openById ซ้ำ ๆ)
let _spreadsheetInstance = null;
let _priceSheetInstance  = null;

function _getConfig(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

// ==========================================
// CONFIG MANAGEMENT — ค่า config อยู่นอกโค้ด (Script Properties)
// เซ็ตผ่าน clasp: clasp run setConfig --params '<json array>'
// ค่าจริงอยู่ในไฟล์ config.local.json (ไม่ขึ้น Git / ไม่ถูก push ขึ้น script)
// ==========================================
function setConfig(props) {
  const map = typeof props === 'string' ? JSON.parse(props) : (props || {});
  const p = PropertiesService.getScriptProperties();
  const keys = Object.keys(map);
  keys.forEach(function (k) { p.setProperty(k, String(map[k])); });
  return 'OK: ตั้งค่าแล้ว ' + keys.length + ' properties: ' + keys.join(', ');
}

// ตรวจว่า config พร้อมครบไหม (ไม่แสดงค่าลับ)
function verifyConfig() {
  const required = ['LINE_CHANNEL_ACCESS_TOKEN', 'GEMINI_API_KEY', 'MAIN_SHEET_NAME'];
  const p = PropertiesService.getScriptProperties();
  const missing = required.filter(function (k) { return !p.getProperty(k); });
  return missing.length === 0
    ? 'OK: Config ครบถ้วน'
    : 'MISSING: ' + missing.join(', ');
}

// ==========================================
// SETUP — สร้างไฟล์สรุปสลิปใหม่ในโฟลเดอร์ Drive + คัดลอก PriceList จากไฟล์เดิม
// รันครั้งเดียว (ผ่าน clasp run) แล้วนำ spreadsheetId ที่คืนกลับไปอัปเดต
// SPREADSHEET_ID และ PRICE_FILE_ID ใน Code.gs
// ==========================================
function createRecordSpreadsheet() {
  const folderId = '1TkNqB6wW5GWmeV4f5rTQuJFcmDcGfLba';
  const fileName = 'สรุปสลิปธนาคารโพนทอง';

  const newSs = SpreadsheetApp.create(fileName);
  const newId = newSs.getId();
  DriveApp.getFileById(newId).moveTo(DriveApp.getFolderById(folderId));

  const mainSheet = newSs.getSheets()[0];
  mainSheet.setName('โอนเงิน');
  mainSheet.appendRow(['เวลาบันทึก', 'กลุ่ม LINE', 'จำนวนเงิน', 'ผู้รับ', 'ธนาคารผู้รับ', 'ผู้ชำระ', 'ธนาคารผู้ชำระ', 'เลขอ้างอิง', 'วันที่', 'LINE ID']);

  const oldPrice = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PRICE_SHEET_NAME);
  if (oldPrice) {
    const data = oldPrice.getDataRange().getValues();
    if (data.length > 0) {
      const priceSheet = newSs.insertSheet(PRICE_SHEET_NAME);
      priceSheet.getRange(1, 1, data.length, data[0].length).setValues(data);
    }
  }

  return {
    spreadsheetId: newId,
    url: newSs.getUrl(),
    sheetName: mainSheet.getSheetName(),
    note: 'อัปเดต SPREADSHEET_ID และ PRICE_FILE_ID ใน Code.gs เป็น spreadsheetId นี้'
  };
}

function getSpreadsheet() {
  if (!_spreadsheetInstance) {
    _spreadsheetInstance = SpreadsheetApp.openById(SPREADSHEET_ID);
  }
  return _spreadsheetInstance;
}

function getPriceSheet() {
  if (!_priceSheetInstance) {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    _priceSheetInstance = ss.getSheetByName(PRICE_SHEET_NAME);
  }
  return _priceSheetInstance;
}

// ผูกแท็บสำหรับบันทึก: ใช้ชื่อจาก MAIN_SHEET_NAME ถ้ากำหนดไว้ ไม่ได้ผูกกับแท็บที่ active อยู่
function getMainSheet() {
  const sheetName = _getConfig('MAIN_SHEET_NAME');
  if (sheetName) {
    const named = getSpreadsheet().getSheetByName(sheetName);
    if (named) return named;
  }
  return getSpreadsheet().getSheets()[0];
}

// ==========================================
// 2. MAIN WEBHOOK (จุดรับข้อมูลและคัดแยก Text / Image)
// ==========================================
function doPost(e) {
  const lock = LockService.getScriptLock();
  let acquired = false;
  try {
    const body = getWebhookBody(e);
    if (!body || !body.events || body.events.length === 0) {
      return okResponse(); // LINE ส่ง ping / ตรวจสอบ webhook
    }

    // กัน LINE retry ประมวลผลซ้ำพร้อมกัน (ซ้ำซ้อนการบันทึกและข้อความ)
    acquired = lock.tryLock(30000);
    if (!acquired) return okResponse();

    body.events.forEach(function (event) {
      try {
        processEvent(event);
      } catch (err) {
        console.error('Error processing event: ' + err.toString());
      }
    });

    return okResponse();
  } catch (err) {
    console.error('doPost error: ' + err.toString());
    return okResponse();
  } finally {
    if (acquired) {
      try { lock.releaseLock(); } catch (e) {}
    }
  }
}

function getWebhookBody(e) {
  if (!e || !e.postData || !e.postData.contents) return null;
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    return null;
  }
}

function okResponse() {
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
                       .setMimeType(ContentService.MimeType.JSON);
}

// HEALTH: ตรวจว่า deployment ตอบสนอง (ข้อมูลไม่ไวต่อความปลอดภัย)
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, service: 'SupplierPaymentBot' }))
                       .setMimeType(ContentService.MimeType.JSON);
}

// ใช้ตรวจสอบว่าโค้ดกำลังบันทึกไปแท็บไหน (รันใน Script Editor แล้วดู Execution log)
function testWriteRow() {
  const sheet = getMainSheet();
  console.log('testWriteRow -> will write to sheet: [' + sheet.getSheetName() + '] (index 0)');
  console.log('รายละเอียดฟังก์ชัน getMainSheet() กำลังชี้ไปที่: ' + sheet.getSheetName());
}

function processEvent(event) {
  if (!event || event.type !== 'message') return;

  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    console.error('CONFIG_ERROR: ยังไม่ได้รัน setConfig() -> ไม่มี LINE token');
    return;
  }
  if (!GEMINI_API_KEY) {
    console.error('CONFIG_ERROR: ยังไม่ได้รัน setConfig() -> ไม่มี Gemini key');
    return;
  }

  // Dedup กัน event เดิมถูก LINE retry ซ้ำหลังประมวลผลสำเร็จแล้ว
  const dedupKey = 'EVT_' + String(event.webhookEventId || (event.message && event.message.id) || event.timestamp || '');
  if (dedupKey !== 'EVT_') {
    const cache = CacheService.getScriptCache();
    if (cache.get(dedupKey)) return;
  }

  if (event.message.type === 'image') {
    handleImageMessage(event);
  } else if (event.message.type === 'text') {
    handleTextMessage(event);
  }

  if (dedupKey !== 'EVT_') {
    try { CacheService.getScriptCache().put(dedupKey, '1', 21600); } catch (e) {}
  }
}

function handleTextMessage(event) {
  const userText = event.message.text.trim();
  const replyToken = event.replyToken;
  if (!replyToken) return;

  // 🟢 ส่วนตรวจจับคำสั่งเช็คราคาและสต็อกสินค้า (#ราคา)
  if (userText.startsWith('#ราคา')) {
    const keyword = userText.replace('#ราคา', '').trim();
    console.log('Received #ราคา command with keyword: ' + keyword);

    if (keyword !== '') {
      const replyMessage = searchPriceList(keyword);
      console.log('Search Result Message:\n' + replyMessage);
      sendSimpleText(event, replyMessage);
    } else {
      console.log('Keyword is empty, sending warning message.');
      sendSimpleText(event, "⚠️ กรุณาพิมพ์คำค้นหาหลังคำว่า #ราคา เช่น #ราคา ปูอัด");
    }
    return;
  }

  // 🔵 ส่วนเดิม: รายงานการรับเงินสด / เงินโอน
  if (userText.includes('รับสด') || userText.includes('รับเงินสด') || userText.includes('รับเงินโอน') || userText.includes('รับโอน')) {
    handleMixedPaymentMessage(event, userText);
  }
}

// ==========================================
// 3. CORE LOGIC FOR IMAGE (ปรับโทนข้อความให้นุ่มนวลลงเมื่อสลิปไม่ตรงบัญชี)
// ==========================================
function handleImageMessage(event) {
  let lineGroupName = "แชตส่วนตัว (Direct Message)";
  try {
    const chatType = event.source.type;

    if (chatType === 'group') {
      lineGroupName = getLineGroupNameCached(event.source.groupId);
    } else if (chatType === 'room') {
      lineGroupName = "LINE Room (ไม่มีชื่อกลุ่ม)";
    }

    const imageBytes = getImageFromLine(event.message.id);
    const imageBlob = Utilities.newBlob(imageBytes, 'image/jpeg', 'slip_' + event.message.id + '.jpg');

    const apiResult = getImageTextFromGemini(imageBlob);
    if (apiResult.isThaiBankSlip === false) return;

    const paymentDetails = extractPaymentDetails(apiResult.text);
    if (!paymentDetails) {
      logImageReadFailure(event, lineGroupName, 'ไม่พบข้อมูลจากสลิป');
      return;
    }

    const receiverName = paymentDetails.receiverName.trim();

    // ตรวจสอบความถูกต้องของบัญชีปลายทาง
    const isValidReceiver = ALLOWED_RECEIVERS.some(allowedName => receiverName.includes(allowedName));

    if (!isValidReceiver) {
      // บันทึกสถานะเพื่อส่งตรวจสอบใน Spreadsheet
      saveToSpreadsheet({
        ...paymentDetails,
        receiverName: `รอตรวจสอบบัญชี (${receiverName})`,
        lineGroup: lineGroupName,
        userId: event.source.userId
      });

      // ส่ง Flex Message โทนสีส้มแบบซอฟต์ นุ่มนวล เพื่อให้ช่วยเช็กสลิปผิดใบ
      replyToUser(event, {
        ...paymentDetails,
        paymentType: "สลิปไม่ตรงบัญชี",
        lineGroup: lineGroupName,
        userId: event.source.userId,
        amountDisplay: paymentDetails.amount,
        receiverName: receiverName
      });
      return;
    }

    // กรณีผ่านบัญชีบริษัทปกติ (สีฟ้าโทนเย็น)
    saveToSpreadsheet({
      ...paymentDetails,
      lineGroup: lineGroupName,
      userId: event.source.userId
    });

    replyToUser(event, {
      ...paymentDetails,
      paymentType: "สลิปรูปภาพ",
      lineGroup: lineGroupName,
      userId: event.source.userId,
      amountDisplay: paymentDetails.amount
    });

  } catch (error) {
    console.error('Error Processing Image: ' + error.toString());
    logImageReadFailure(event, lineGroupName, error.toString());
  }
}

// ==========================================
// 4. TEXT PAYMENT LOGIC (คงเดิมสำหรับการพิมพ์รายงาน)
// ==========================================
// alias กันกรณีมีไฟล์อื่นหรือ Trigger เดิมในโปรเจกต์เรียกชื่อเก่า
function handleTextPayment(event, userText) {
  handleMixedPaymentMessage(event, userText);
}

function handleMixedPaymentMessage(event, userText) {
  const replyToken = event.replyToken;
  try {
    const chatType = event.source.type;
    let lineGroupName = "แชตส่วนตัว (Direct Message)";
    if (chatType === 'group') {
      lineGroupName = getLineGroupNameCached(event.source.groupId);
    }

    const today = new Date();
    const dd = today.getDate() < 10 ? '0' + today.getDate() : today.getDate();
    const mm = (today.getMonth() + 1) < 10 ? '0' + (today.getMonth() + 1) : (today.getMonth() + 1);
    const yyyy = today.getFullYear();
    const formattedCurrentDate = `${dd}/${mm}/${yyyy}`;

    const aiUrls = GEMINI_MODELS_TEXT.map(m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_API_KEY}`);
    const promptText = `Analyze this logistics and payment text/slip to extract cash and transfer details accurately.
    Text: "${userText}"

    Business Context:
    - The business owner/receiver is "พวงประกา นนพิทักษ์" (ห้องเย็นทองสุข) and "วีรชาติ  บุญสวัสดิ์" . Any transfer to this name or shop means they are the RECEIVER (รับโอน).

    Rules:
    1. 'cash': number after 'รับสด'. Ignore 'บาท' or other words.
    2. 'transfer': number associated with 'รับโอน', 'โอน', or money sent to "พวงประกา" / "วีรชาติ" / "ห้องเย็นทองสุข". 
      - CRITICAL: Make sure the transfer amount is moving TO the business owner, not paid out to others.
    3. 'bank': Identify the Thai bank name from the text or slip context (e.g., กสิกรไทย (KBank), ไทยพาณิชย์ (SCB), กรุงไทย (KTB), กรุงเทพ (BBL), ออมสิน (GSB), promptpay, etc.). If not found, set to "ไม่ระบุ".
    4. Set numbers to 0 if not found.
    5. 'type': if both > 0 set "แบ่งจ่าย", if only cash > 0 set "สดอย่างเดียว", if only transfer > 0 set "โอนอย่างเดียว".

    Return ONLY JSON: {"cash": 0, "transfer": 0, "bank": "กสิกรไทย", "type": "โอนอย่างเดียว"}`;

    const payload = {
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: { responseMimeType: "application/json" }
    };

    const rawText = callGeminiUrls(aiUrls, payload);
    const resultJson = JSON.parse(rawText.trim());

    const baseDetails = {
      lineGroup: lineGroupName, referenceNo: "-", date: formattedCurrentDate,
      userId: event.source.userId, senderName: "คนจัดส่ง", senderBank: "เงินสด", receiverBank: "เงินสด"
    };

    let hasRecorded = false;
    let amountDisplay = "";

    if (resultJson.type === "สดอย่างเดียว" && Number(resultJson.cash) > 0) {
      saveToSpreadsheet({ ...baseDetails, amount: resultJson.cash, receiverName: "รับสด" });
      amountDisplay = resultJson.cash;
      hasRecorded = true;
    }
    else if (resultJson.type === "โอนอย่างเดียว" && Number(resultJson.transfer) > 0) {
      saveToSpreadsheet({ ...baseDetails, amount: resultJson.transfer, receiverName: "รับโอน", receiverBank: "ธนาคาร", senderBank: "รอยืนยัน" });
      amountDisplay = resultJson.transfer;
      hasRecorded = true;
    }
    else if (resultJson.type === "แบ่งจ่าย") {
      if (Number(resultJson.cash) > 0) {
        saveToSpreadsheet({ ...baseDetails, amount: resultJson.cash, receiverName: "รับสด" });
      }
      if (Number(resultJson.transfer) > 0) {
        saveToSpreadsheet({ ...baseDetails, amount: resultJson.transfer, receiverName: "รับโอน", receiverBank: "ธนาคาร", senderBank: "รอยืนยัน" });
      }
      amountDisplay = `สด ${resultJson.cash} / โอน ${resultJson.transfer}`;
      hasRecorded = true;
    }

    if (hasRecorded) {
      replyToUser(event, {
        ...baseDetails,
        paymentType: resultJson.type,
        amountDisplay: amountDisplay,
        receiverName: resultJson.type === "แบ่งจ่าย" ? "รับผสม (สด+โอน)" : (resultJson.type === "สดอย่างเดียว" ? "รับสด" : "รับโอน"),
        receiverBankDisplay: resultJson.type === "สดอย่างเดียว" ? "เงินสด" : "ธนาคาร"
      });
    } else {
      sendSimpleText(event, "⚠️ ไม่พบยอดเงินในข้อความที่ส่งมา กรุณาพิมพ์รูปแบบ เช่น \"รับสด 500\" หรือ \"รับโอน 500\" ครับ");
    }

  } catch (error) {
    console.error('Error Processing Text Message: ' + error.toString());
    if (replyToken) {
      try { sendSimpleText(event, "❌ เกิดข้อผิดพลาดในการประมวลผลข้อความ โปรดลองใหม่อีกครั้งครับ"); } catch (e) {}
    }
  }
}

// ==========================================
// 5. API CONNECTION & DATA PROCESSING
// ==========================================
// เรียก Gemini พร้อม retry อัตโนมัติ: ลอง model ทั้งหมด ตัวละไม่เกิน 3 ครั้ง
// 429 (quota) / 503 (demand สูง) / 5xx = transient ให้รอแล้วลองใหม่
function callGeminiUrls(urls, payload) {
  let lastErr = null;
  for (let i = 0; i < urls.length; i++) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response = null;
      try {
        response = UrlFetchApp.fetch(urls[i], {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
      } catch (e) {
        lastErr = e;
        if (attempt < 2) { Utilities.sleep(1000 * (attempt + 1)); continue; }
        break;
      }
      const code = response.getResponseCode();
      if (code === 200) {
        const data = JSON.parse(response.getContentText());
        const part = (data.candidates && data.candidates[0] &&
                      data.candidates[0].content && data.candidates[0].content.parts)
          ? data.candidates[0].content.parts[0] : null;
        if (!part || part.text === undefined) {
          throw new Error('Gemini API: no text found in response');
        }
        return part.text;
      }
      if ((code === 429 || code >= 500) && attempt < 2) {
        Utilities.sleep(2000 * (attempt + 1));
        continue;
      }
      lastErr = new Error('Gemini API ' + code + ': ' + response.getContentText());
      break;
    }
  }
  throw lastErr || new Error('Gemini API: all retries failed');
}

function getImageTextFromGemini(imageBlob) {
  const urls = GEMINI_MODELS_IMAGE.map(m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_API_KEY}`);
  const base64Image = Utilities.base64Encode(imageBlob.getBytes());

  const promptText = "You are a specialized Thai Bank Slip verifier.\n" +
                     "Analyze if the image is a valid Thai Bank Transfer Slip.\n" +
                     "Return ONLY a JSON object with keys: isThaiBankSlip, referenceNo, amount, datetime, senderBank, senderName, receiverBank, receiverName. \n" +
                     " in case of  Extract the senderName from this slip accurately. If there are prefixes like Mr./Mrs./Ms., you may keep or remove them according to standard naming. Return the result strictly in JSON format with the key 'senderName'. If the name cannot be identified, set 'senderName' to null.";

  const payload = {
    contents: [{
      parts: [ { text: promptText }, { inlineData: { mimeType: "image/jpeg", data: base64Image } } ]
    }],
    generationConfig: { responseMimeType: "application/json" }
  };

  const text = callGeminiUrls(urls, payload);

  let parsed = null;
  try { parsed = JSON.parse(text.trim()); } catch (e) { parsed = null; }
  const isSlip = parsed ? (parsed.isThaiBankSlip !== false) : true;

  return { isThaiBankSlip: isSlip, text: text };
}

function extractPaymentDetails(apiResponse) {
  try {
    const parsedContent = JSON.parse(apiResponse.trim());
    let rawDateStr = parsedContent.datetime || '';
    let formattedDate = '';

    if (rawDateStr) {
      // 1. ดึงข้อมูลเวลา (ถ้ามี) ในรูปแบบ HH:mm (24 ชั่วโมง)
      let timeStr = '';
      const timeMatch = rawDateStr.match(/(\d{1,2}):(\d{2})/);
      if (timeMatch) {
        const hours = timeMatch[1].padStart(2, '0');
        const minutes = timeMatch[2];
        timeStr = `${hours}:${minutes}`;
      }

      // 2. Map สำหรับแปลงชื่อเดือนภาษาไทยย่อเป็นตัวเลข
      const thaiMonths = {
        'ม.ค.': 1, 'ก.พ.': 2, 'มี.ค.': 3, 'เม.ย.': 4, 'พ.ค.': 5, 'มิ.ย.': 6,
        'ก.ค.': 7, 'ส.ค.': 8, 'ก.ย.': 9, 'ต.ค.': 10, 'พ.ย.': 11, 'ธ.ค.': 12
      };

      let day, month, year;
      let matched = false;

      // เคสที่ 1: รูปแบบภาษาไทย เช่น "13 ก.ค. 69" หรือ "13 ก.ค. 2569 - 12:01"
      const thaiPattern = /(\d{1,2})\s+([ก-ฮ]{1,2}\.[ก-ฮ]\.)\s+(\d{2,4})/;
      const thaiMatch = rawDateStr.match(thaiPattern);

      if (thaiMatch) {
        day = parseInt(thaiMatch[1]);
        const monthStr = thaiMatch[2];
        month = thaiMonths[monthStr] || 1;
        const tempYear = parseInt(thaiMatch[3]);

        // จัดการแปลงปี พ.ศ. เป็น ค.ศ.
        if (tempYear < 100) {
          year = (2500 + tempYear) - 543; // เช่น 69 -> 2569 -> 2026
        } else {
          year = tempYear - 543; // เช่น 2569 -> 2026
        }
        matched = true;
      }

      // เคสที่ 2: รูปแบบตัวเลขคั่นด้วย - หรือ / เช่น "13/07/2026" หรือ "2026-07-13" หรือ "13/07/69"
      if (!matched) {
        const matches = rawDateStr.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/) ||
                        rawDateStr.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);

        if (matches) {
          // ตรวจสอบโครงสร้างว่าปี 4 หลักอยู่หน้าหรืออยู่หลัง
          if (matches[1].length === 4) {
            year = parseInt(matches[1]);
            month = parseInt(matches[2]);
            day = parseInt(matches[3]);
          } else {
            day = parseInt(matches[1]);
            month = parseInt(matches[2]);
            const tempYear = parseInt(matches[3]);

            if (tempYear < 100) {
              year = (2500 + tempYear) - 543; // กรณี "13/07/69" พ.ศ. 2 หลัก
            } else if (tempYear > 2500) {
              year = tempYear - 543; // กรณี พ.ศ. 4 หลัก
            } else {
              year = tempYear; // กรณี ค.ศ. 4 หลัก
            }
          }
          matched = true;
        }
      }

      // 3. ประกอบเป็น formattedDate ในรูปแบบ DD/MM/YYYY HH:mm (หรือ DD/MM/YYYY หากไม่มีเวลา)
      if (matched) {
        const dStr = String(day).padStart(2, '0');
        const mStr = String(month).padStart(2, '0');

        formattedDate = `${dStr}/${mStr}/${year}`;

        if (timeStr) {
          formattedDate += ` ${timeStr}`;
        }
      }
    }

    // ส่งคืน Object ข้อมูลสลิปโอนเงินตามโครงสร้างเดิม
    return {
      referenceNo: parsedContent.referenceNo || '',
      amount: parsedContent.amount || '',
      date: formattedDate || rawDateStr,
      senderBank: parsedContent.senderBank || 'ไม่ทราบ',
      senderName: parsedContent.senderName || 'ไม่ทราบ',
      receiverBank: parsedContent.receiverBank || 'ไม่ทราบ',
      receiverName: parsedContent.receiverName || 'ไม่ทราบ'
    };

  } catch (e) {
    console.error('Error in extractPaymentDetails: ' + e.toString());
    return null;
  }
}

function saveToSpreadsheet(details) {
  const sheet = getMainSheet(); // ผูกแท็บแรกเสมอ ไม่ขึ้นกับแท็บที่ active อยู่
  console.log('saveToSpreadsheet -> sheet name: [' + sheet.getSheetName() + '] amount: ' + details.amount + ' receiver: ' + details.receiverName);
  sheet.appendRow([
    new Date().toLocaleString('th-TH'), details.lineGroup, details.amount, details.receiverName,
    details.receiverBank, details.senderName, details.senderBank, details.referenceNo, details.date, details.userId
  ]);
}

// ==========================================
// 6. LINE MESSAGING FUNCTIONS (ปรับปรุงโทนสีส้มให้นุ่มนวล มีความเป็นมิตรมากขึ้น)
// ==========================================
function getLineGroupName(groupId) {
  const url = `https://api.line.me/v2/bot/group/${groupId}/summary`;
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
    muteHttpExceptions: true
  });
  return response.getResponseCode() === 200
    ? JSON.parse(response.getContentText()).groupName
    : "กลุ่ม LINE (ไม่ทราบชื่อ)";
}

function getLineGroupNameCached(groupId) {
  const cache = CacheService.getScriptCache();
  const key = 'GROUP_NAME_' + String(groupId);
  const cached = cache.get(key);
  if (cached) return cached;
  const name = getLineGroupName(groupId); // เจอชื่อเดิมเสมอ ไม่เคย cache ค่าว่าง
  if (name) { try { cache.put(key, name, 21600); } catch (e) {} }
  return name;
}

function getImageFromLine(messageId) {
  const response = UrlFetchApp.fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { 'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('LINE get content ' + response.getResponseCode() + ': ' + response.getContentText());
  }
  return response.getBlob().getBytes();
}

// --- ส่งข้อความไป LINE: พยายาม reply ก่อน ถ้า token หมดอายุ/ล้มเหลว จะ Push แทน ---
function postToLine(path, body) {
  const response = UrlFetchApp.fetch('https://api.line.me/v2/bot' + path, {
    method: 'post',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  return { code: response.getResponseCode(), body: response.getContentText() };
}

function getPushTarget(event) {
  if (!event || !event.source) return null;
  const s = event.source;
  if (s.type === 'group') return s.groupId;
  if (s.type === 'room') return s.roomId;
  return s.userId || null;
}

// ใช้แทนการ push ตอนอ่านสลิปล้มเหลว — บันทึกแถวลง Sheet แทนการส่งข้อความแจ้งเตือน
function logImageReadFailure(event, lineGroupName, reason) {
  try {
    saveToSpreadsheet({
      lineGroup: lineGroupName,
      referenceNo: String((event.message && event.message.id) || '-'),
      date: '-',
      userId: event.source ? event.source.userId : '',
      senderName: 'อ่านล้มเหลว',
      senderBank: String(reason || '') ,
      receiverBank: '-',
      receiverName: 'อ่านล้มเหลว',
      amount: ''
    });
  } catch (e) {
    console.error('logImageReadFailure error: ' + e.toString());
  }
}

function deliverMessages(event, messages) {
  const replyToken = event && event.replyToken;
  if (replyToken) {
    const res = postToLine('/message/reply', { replyToken: replyToken, messages: messages });
    if (res.code === 200) return;
  }
  // Fallback: ถ้า reply ไม่สำเร็จ (token หมดอายุ / ประมวลผลนานเกิน 5 วิ) จะ Push หา user/group แทน
  try {
    const to = getPushTarget(event);
    if (!to) return;
    const res = postToLine('/message/push', { to: to, messages: messages });
    if (res.code !== 200) {
      console.error('LINE push failed (' + res.code + '): ' + res.body);
    }
  } catch (err) {
    console.error('LINE push fallback error: ' + err.toString());
  }
}

function sendSimpleText(event, textMessage) {
  deliverMessages(event, [{
    type: 'text',
    text: String(textMessage || 'ไม่พบข้อมูล')
  }]);
}

function buildPaymentFlexMessage(messageData) {
  let titleText = "❄️ บันทึกสลิปสำเร็จ";
  let statusNotice = "ระบบได้ทำการตรวจสอบและบันทึกสลิปเรียบร้อยแล้ว";
  let themeColor = "#0080FF";
  let receiverBankLine = `[${messageData.receiverBank}] ${messageData.receiverName}`;

  // [ปรับปรุงให้นุ่มนวลลงตามสั่ง] กรณีสลิปไม่ตรงชื่อบริษัท (อาจเป็นสลิปเก่า/สลิปผิด)
  if (messageData.paymentType === "สลิปไม่ตรงบัญชี") {
    titleText = "⏳ บัญชีรบกวนเช็กยอดเงิน";
    statusNotice = "เนื่องจากตรวจพบชื่อบัญชีผู้รับไม่ตรงกลุ่มบริษัท (ลูกค้าอาจส่งรูปสลิปผิดใบ)";
    themeColor = "#fd1414"; // สีส้มโทนเดียวกับกรณีแจ้งเตือนตรวจสอบทั่วไป     //#FD7E14
    receiverBankLine = `[${messageData.receiverBank}] ${messageData.receiverName} (โปรดตรวจสอบ)`;
  }
  else if (messageData.paymentType === "สดอย่างเดียว") {
    titleText = "✓ บันทึกรับเงินสดสำเร็จ";
    statusNotice = "จัดส่งเก็บเงินสดแล้ว";
    themeColor = "#28A745";
    receiverBankLine = messageData.receiverName;
  }
  else if (messageData.paymentType === "โอนอย่างเดียว") {
    titleText = "⏳ บันทึกยอดเงินโอนสำเร็จ";
    statusNotice = "บัญชีรบกวนเช็กยอดเงินเข้าธนาคารอีกครั้ง เนื่องจากไม่มีรูปภาพแนบ";
    themeColor = "#FD7E14";
    receiverBankLine = messageData.receiverName;
  }
  else if (messageData.paymentType === "แบ่งจ่าย") {
    titleText = "❄️ บันทึกแบ่งจ่ายสำเร็จ";
    statusNotice = "แยกยอด สด / โอน ชัดเจนเพื่อป้องกันการทอนเงินผิด";
    themeColor = "#0056B3";
    receiverBankLine = messageData.receiverName;
  }

  if (messageData.paymentType === "สลิปรูปภาพ") {
    receiverBankLine = `[${messageData.receiverBank}] ${messageData.receiverName}`;
  }

  return [{
    type: "flex", altText: "แจ้งเตือนการบันทึกข้อมูลสำเร็จ",
    contents: {
      type: "bubble",
      styles: { body: { backgroundColor: "#F2F7FA" } },
      body: {
        type: "box", layout: "vertical", contents: [
          { type: "text", text: titleText, weight: "bold", color: themeColor, size: "md" },
          { type: "text", text: statusNotice, size: "xs", color: "#556B82", margin: "xs", wrap: true },
          { type: "box", layout: "vertical", margin: "lg", spacing: "sm", contents: [
            { type: "box", layout: "horizontal", contents: [{ type: "text", text: "กลุ่ม LINE:", size: "sm", color: "#556B82", flex: 3 }, { type: "text", text: messageData.lineGroup, size: "sm", color: "#0D2C54", flex: 7, wrap: true }] },
            { type: "box", layout: "horizontal", contents: [{ type: "text", text: "เลขอ้างอิง:", size: "sm", color: "#556B82", flex: 3 }, { type: "text", text: messageData.referenceNo, size: "sm", color: "#0D2C54", flex: 7, wrap: true }] },
            { type: "box", layout: "horizontal", contents: [{ type: "text", text: "จำนวนเงิน:", size: "sm", color: "#556B82", flex: 3 }, { type: "text", text: messageData.amountDisplay + " บาท", size: "sm", color: themeColor, flex: 7, weight: "bold" }] },
            { type: "box", layout: "horizontal", contents: [{ type: "text", text: "ผู้ชำระ:", size: "sm", color: "#556B82", flex: 3 }, { type: "text", text: `[${messageData.senderBank}] ${messageData.senderName}`, size: "sm", color: "#0D2C54", flex: 7, wrap: true }] },
            { type: "box", layout: "horizontal", contents: [{ type: "text", text: "ช่องทางรับเงิน:", size: "sm", color: "#556B82", flex: 3 }, { type: "text", text: receiverBankLine, size: "sm", color: themeColor, flex: 7, wrap: true, weight: "bold" }] },
            { type: "box", layout: "horizontal", contents: [{ type: "text", text: "วันที่ส่งงาน:", size: "sm", color: "#556B82", flex: 3 }, { type: "text", text: messageData.date, size: "sm", color: "#0D2C54", flex: 7, wrap: true }] },
            { type: "separator", margin: "md", color: "#D1E2EC" },
            { type: "text", text: "ขอบคุณลูกค้าที่ชำระเงินค่ะ/ครับ 🙏✨", size: "sm", color: "#0B63C0", weight: "bold", align: "center", margin: "md" }
          ]}
        ]
      }
    }
  }];
}

function replyToUser(event, messageData) {
  deliverMessages(event, buildPaymentFlexMessage(messageData));
}

// ==========================================
// 🔍 SEARCH PRICE FUNCTION (ระบบเช็คราคาและสต็อก)
// ==========================================
function getPriceData() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('PRICE_DATA_JSON');
  if (cached !== null) {
    try { return JSON.parse(cached); } catch (e) {}
  }
  const sheet = getPriceSheet();
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  try {
    const json = JSON.stringify(data);
    if (json.length < 90000) cache.put('PRICE_DATA_JSON', json, 300); // cache 5 นาที
  } catch (e) {}
  return data;
}

function getPriceLastUpdated() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('PRICE_UPDATED_JSON');
  if (cached !== null) return cached;
  const file = DriveApp.getFileById(PRICE_FILE_ID);
  const t = Utilities.formatDate(file.getLastUpdated(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm');
  try { cache.put('PRICE_UPDATED_JSON', t, 300); } catch (e) {}
  return t;
}

function searchPriceList(keyword) {
  try {
    const sheet = getPriceSheet();
    if (!sheet) {
      return `❌ ไม่พบแท็บชื่อ "${PRICE_SHEET_NAME}" ใน Google Sheet ค่ะ`;
    }

    const data = getPriceData();
    console.log('จำนวนแถวทั้งหมด:', data.length);
    const matchedItems = [];
    const searchKeywordLower = keyword.toLowerCase();

    // วนลูปตรวจเช็คคอลัมน์ A (เริ่มแถวที่ 2 ข้ามหัวตาราง)
    for (let i = 1; i < data.length; i++) {
      const productName = String(data[i][0] || ''); // คอลัมน์ A: ชื่อสินค้า
      const price = data[i][1];                      // คอลัมน์ B: ราคาสินค้า
      const stock = Number(data[i][2] || 0);          // คอลัมน์ C: จำนวนสต็อก

      if (productName.toLowerCase().includes(searchKeywordLower)) {
        console.log('เจอสินค้า:', productName, 'ราคา:', price, 'สต็อก:', stock);
        const stockStatus = stock > 0 ? "พร้อมส่ง 🟢" : "หมดสต็อก 🔴";
        const formattedPrice = typeof price === 'number' ? price.toLocaleString('th-TH') : price;

        matchedItems.push({
          name: productName,
          price: formattedPrice,
          status: stockStatus
        });

        // จำกัดผลลัพธ์ไม่เกิน 5 รายการ
        if (matchedItems.length >= 5) {
          break;
        }
      }
    }

    if (matchedItems.length === 0) {
      return `❌ ไม่พบข้อมูลราคาของสินค้าที่มีคำว่า '${keyword}' ในระบบค่ะ`;
    }

    // ดึงเวลาแก้ไขล่าสุด (cache ไว้ ไม่ต้องเรียก DriveApp ทุกครั้ง)
    const lastUpdated = getPriceLastUpdated();

    // จัดรูปแบบข้อความตอบกลับมินิมอล
    let message = `🔍 ผลการค้นหา: "${keyword}"\n`;
    message += `--------------------------------------\n`;

    matchedItems.forEach(item => {
      message += `▪️ ${item.name}\n`;
      message += `ราคา ${item.price}.-  [ ${item.status} ]\n\n`;
    });

    message = message.trim();
    message += `\n--------------------------------------\n`;
    message += `🕒 ข้อมูลล่าสุด ณ วันที่ ${lastUpdated} น.`;

    return message;

  } catch (err) {
    console.error('Error in searchPriceList: ' + err.toString());
    return "❌ เกิดข้อผิดพลาดในการดึงข้อมูลราคาสินค้า";
  }
}