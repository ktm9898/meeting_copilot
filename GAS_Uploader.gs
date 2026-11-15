/**
 * Meeting Copilot - 구글 시트 데이터 자동 수신 스크립트
 * 
 * [설치 및 사용법]
 * 1. 데이터가 담길 구글 시트를 엽니다.
 * 2. 상단 메뉴 [확장 프로그램] -> [Apps Script] 클릭
 * 3. 기존 코드를 지우고 이 파일 내용 전체를 복사해서 붙여넣습니다.
 * 4. 우측 상단 [배포] -> [새 배포] 클릭
 * 5. 유형 선택: [웹 앱]
 *    - 설명: Meeting Copilot Uploader
 *    - 다음 사용자 권한으로 실행: [나]
 *    - 액세스 권한 있는 사용자: [모든 사용자]
 * 7. (선택/권장) 최고 성능 음성인식(Groq Whisper) 활성화:
 *    - 좌측 톱니바퀴 [프로젝트 설정] -> 하단 [스크립트 속성] -> [스크립트 속성 추가]
 *    - 속성: GROQ_API_KEY / 값: gsk_... (Groq API 키)
 *    - 속성: AUTH_PIN / 값: 1234 (접속 보안 PIN)
 */

function getAuthPin() {
  var pin = PropertiesService.getScriptProperties().getProperty("AUTH_PIN");
  return pin ? String(pin).trim() : "";
}

function getGroqApiKey() {
  var key = PropertiesService.getScriptProperties().getProperty("GROQ_API_KEY");
  return key ? String(key).trim() : "";
}

function getDocSelectionState() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty("DOC_SELECTION_STATE");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * 무차별 대입(Brute-Force) 방어: 5회 연속 실패 시 10분(600초)간 접속 완전 차단
 */
function verifyPinWithRateLimit(inputPin) {
  var authPin = getAuthPin();
  if (!authPin) {
    return {
      ok: false,
      error: "AUTH_PIN_NOT_SET",
      message: "구글 시트의 [프로젝트 설정 -> 스크립트 속성]에 AUTH_PIN(비밀번호)을 추가해 주세요."
    };
  }

  var cache = CacheService.getScriptCache();
  if (cache.get("MC_PIN_LOCKOUT")) {
    return {
      ok: false,
      error: "LOCKED_OUT",
      message: "비밀번호 5회 연속 오류로 인해 10분간 접속이 차단되었습니다."
    };
  }

  if (!inputPin || String(inputPin).trim() !== authPin) {
    var failCount = parseInt(cache.get("MC_PIN_FAILS") || "0", 10) + 1;
    if (failCount >= 5) {
      cache.put("MC_PIN_LOCKOUT", "true", 600); // 10분 차단
      cache.remove("MC_PIN_FAILS");
      return {
        ok: false,
        error: "LOCKED_OUT",
        message: "비밀번호 5회 연속 오류로 인해 10분간 접속이 차단되었습니다."
      };
    } else {
      cache.put("MC_PIN_FAILS", String(failCount), 600);
      return {
        ok: false,
        error: "Unauthorized: Invalid PIN",
        message: "비밀번호가 올바르지 않습니다. (" + failCount + "/5회 오류)"
      };
    }
  }

  // 성공 시 실패 카운트 초기화
  cache.remove("MC_PIN_FAILS");
  return { ok: true };
}

function normalizeRefState(val) {
  var s = String(val || "").trim().toUpperCase();
  if (s === "N" || s === "제외" || s === "FALSE" || s === "X" || s === "0") return "N";
  if (s === "H" || s === "보류" || s === "대기" || s === "기억" || s === "HOLD") return "H";
  return "Y";
}

/**
 * 기존 5열(A:문서제목...) 또는 6열(A:업무구분, B:문서제목...) 시트를
 * 7열 표준 구조(A:업무구분 | B:참조상태 | C:문서제목 | D:사업구분 | E:핵심내용 요약 | F:주요 키워드 | G:문서원문)로 자동 보정
 */
function ensureSheetColumns(sheet) {
  if (!sheet || sheet.getLastRow() < 1) return;
  try {
    var maxCols = Math.max(sheet.getLastColumn(), 3);
    var headerRow = sheet.getRange(1, 1, 1, maxCols).getValues()[0];
    var h0 = String(headerRow[0] || "").trim();
    var h1 = String(headerRow[1] || "").trim();
    var lastRow = sheet.getLastRow();

    if (h0 === "문서제목") {
      // 기존 5열 구조 -> 맨 앞에 A열(업무구분), B열(참조상태) 2개 열 자동 추가
      sheet.insertColumnsBefore(1, 2);
      sheet.getRange(1, 1, 1, 2).setValues([["업무구분", "참조상태"]])
        .setBackground("#1a1a2e").setFontColor("#ffffff").setFontWeight("bold");
      if (lastRow >= 2) {
        var defaultRows = [];
        for (var r = 2; r <= lastRow; r++) defaultRows.push(["미분류", "Y"]);
        sheet.getRange(2, 1, lastRow - 1, 2).setValues(defaultRows);
      }
    } else if ((h0 === "업무구분" || h0 === "구분") && h1 === "문서제목") {
      // 6열 구조(A:업무구분, B:문서제목) -> B열 위치에 '참조상태' 열 자동 추가
      sheet.insertColumnBefore(2);
      sheet.getRange(1, 2).setValue("참조상태")
        .setBackground("#1a1a2e").setFontColor("#ffffff").setFontWeight("bold");
      if (lastRow >= 2) {
        var defaultStates = [];
        for (var r2 = 2; r2 <= lastRow; r2++) defaultStates.push(["Y"]);
        sheet.getRange(2, 2, lastRow - 1, 1).setValues(defaultStates);
      }
    }
  } catch (e) {
    // 권한 제한 등 예외 시 무시하고 열 개수에 맞춰 읽기 수행
  }
}

function updateSheetDocSelectionOnSheet(sheet, docTypeLabel, docStates) {
  if (!sheet || sheet.getLastRow() < 2 || !docStates) return 0;
  ensureSheetColumns(sheet);
  var lastRow = sheet.getLastRow();
  var numRows = lastRow - 1;
  // B열(참조상태, col=2)과 C열(문서제목, col=3) 일괄 읽기
  var bcValues = sheet.getRange(2, 2, numRows, 2).getValues();
  var newBValues = [];
  var changed = false;

  for (var i = 0; i < bcValues.length; i++) {
    var curB = String(bcValues[i][0] || "").trim();
    var rawTitle = String(bcValues[i][1] || "");
    var trimmedTitle = rawTitle.trim();
    var keyExact = docTypeLabel + "|" + (rawTitle || "제목없음");
    var keyTrim = docTypeLabel + "|" + (trimmedTitle || "제목없음");
    var targetState = docStates[keyExact] || docStates[keyTrim];

    if (targetState === "Y" || targetState === "H" || targetState === "N") {
      newBValues.push([targetState]);
      if (curB !== targetState) changed = true;
    } else {
      var fallback = normalizeRefState(curB);
      newBValues.push([fallback]);
      if (curB !== fallback) changed = true;
    }
  }

  if (changed && newBValues.length > 0) {
    sheet.getRange(2, 2, numRows, 1).setValues(newBValues);
  }
  return newBValues.length;
}

function appendRowsFromSheet(sheet, docTypeLabel, list) {
  if (!sheet || sheet.getLastRow() < 2) return;
  ensureSheetColumns(sheet);

  var maxCols = Math.max(sheet.getLastColumn(), 7);
  var headerRow = sheet.getRange(1, 1, 1, maxCols).getValues()[0];
  var h0 = String(headerRow[0] || "").trim();
  var h1 = String(headerRow[1] || "").trim();
  var h2 = String(headerRow[2] || "").trim();

  // 7열 구조: A:업무구분 | B:참조상태 | C:문서제목 | D:사업구분/소제목 | E:핵심내용 요약 | F:주요 키워드 | G:문서원문
  var is7Col = (h1 === "참조상태" || h1 === "선택" || h2 === "문서제목");
  // 6열 구조 호환: A:업무구분 | B:문서제목 | C:사업구분 | D:요약 | E:키워드 | F:문서원문
  var is6Col = (!is7Col && (h0 === "업무구분" || h0 === "구분" || h1 === "문서제목"));

  var numCols = is7Col ? 7 : (is6Col ? 6 : 5);
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (is7Col) {
      if (!row[2] && !row[4] && !row[6]) continue;
      list.push({
        docType: docTypeLabel,
        workGroup: String(row[0] || "").trim() || "미분류",
        refState: normalizeRefState(row[1]),
        title: String(row[2] || ""),
        category: String(row[3] || ""),
        summary: String(row[4] || ""),
        keywords: String(row[5] || ""),
        fullText: String(row[6] || "")
      });
    } else if (is6Col) {
      if (!row[1] && !row[3] && !row[5]) continue;
      list.push({
        docType: docTypeLabel,
        workGroup: String(row[0] || "").trim() || "미분류",
        refState: "Y",
        title: String(row[1] || ""),
        category: String(row[2] || ""),
        summary: String(row[3] || ""),
        keywords: String(row[4] || ""),
        fullText: String(row[5] || "")
      });
    } else {
      if (!row[0] && !row[2] && !row[4]) continue;
      list.push({
        docType: docTypeLabel,
        workGroup: "미분류",
        refState: "Y",
        title: String(row[0] || ""),
        category: String(row[1] || ""),
        summary: String(row[2] || ""),
        keywords: String(row[3] || ""),
        fullText: String(row[4] || "")
      });
    }
  }
}

/**
 * 탭 순서와 무관하게 '업무문서' 탭을 안전하게 찾는 함수
 * ('업무문서' 탭 우선 검색 -> 없으면 'Sheet1'/'시트1' 또는 예약되지 않은 첫 시트를 찾아 '업무문서'로 자동 이름 변경)
 */
function getMainWorkSheet(ss) {
  var sheet = ss.getSheetByName("업무문서");
  if (sheet) return sheet;

  sheet = ss.getSheetByName("Sheet1") || ss.getSheetByName("시트1");
  if (!sheet) {
    var reserved = { "참고자료": true, "분석기록": true, "STT기록": true };
    var allSheets = ss.getSheets();
    for (var i = 0; i < allSheets.length; i++) {
      if (!reserved[allSheets[i].getName()]) {
        sheet = allSheets[i];
        break;
      }
    }
  }
  if (!sheet) {
    sheet = ss.insertSheet("업무문서", 0);
  } else {
    var curName = sheet.getName();
    if (curName === "Sheet1" || curName === "시트1") {
      try { sheet.setName("업무문서"); } catch (e) {}
    }
  }
  return sheet;
}

function readKnowledgeDBRows(ss) {
  var list = [];
  // 1) '업무문서' 탭 (탭 순서와 무관하게 이름으로 안전하게 탐색)
  var mainSheet = getMainWorkSheet(ss);
  appendRowsFromSheet(mainSheet, "업무문서", list);

  // 2) '참고자료' 탭이 존재하면 함께 읽기 -> '참고자료'
  var refSheet = ss.getSheetByName("참고자료");
  if (refSheet && (!mainSheet || refSheet.getSheetId() !== mainSheet.getSheetId())) {
    appendRowsFromSheet(refSheet, "참고자료", list);
  }
  return list;
}

function getOrCreateSheetWithHeaders(ss, sheetName, headers) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground("#1a1a2e");
    headerRange.setFontColor("#ffffff");
    headerRange.setFontWeight("bold");
  }
  return sheet;
}

function formatNowKST() {
  return Utilities.formatDate(new Date(), "GMT+9", "yyyy-MM-dd HH:mm");
}

function doPost(e) {
  try {
    var data;
    if (e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    } else {
      return responseJSON({ success: false, error: "No post data" });
    }

    var inputPin = (data && data.pin) ? String(data.pin).trim() : (e.parameter ? String(e.parameter.pin || "").trim() : "");
    var authCheck = verifyPinWithRateLimit(inputPin);
    if (!authCheck.ok) {
      return responseJSON({ success: false, error: authCheck.error, message: authCheck.message });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var action = data.action || "uploadDoc";

    // 1) STT 기록 저장 (탭: STT기록, 열: 날짜 | 내용)
    if (action === "saveSTT") {
      var sttSheet = getOrCreateSheetWithHeaders(ss, "STT기록", ["날짜", "내용"]);
      var dateStr = data.date || formatNowKST();
      var content = data.content || "";
      sttSheet.appendRow([dateStr, content]);
      return responseJSON({
        success: true,
        action: "saveSTT",
        message: "STT 기록이 구글 시트에 저장되었습니다.",
        row: sttSheet.getLastRow()
      });
    }

    // 2) 맥락분석 및 자료확인 자동 저장 (탭: 분석기록, 열: 날짜 | 질문 | 답변)
    if (action === "saveAnalysis") {
      var analysisSheet = getOrCreateSheetWithHeaders(ss, "분석기록", ["날짜", "질문", "답변"]);
      var dateStr2 = data.date || formatNowKST();
      var question = data.question || "";
      var answer = data.answer || "";
      analysisSheet.appendRow([dateStr2, question, answer]);
      return responseJSON({
        success: true,
        action: "saveAnalysis",
        message: "분석 및 자료확인 결과가 구글 시트에 자동 저장되었습니다.",
        row: analysisSheet.getLastRow()
      });
    }

    // 2-1) 참조 문서 선택 상태(B열: Y/H/N) 구글 시트 셀 직접 반영 (PC / 스마트폰 / 태블릿 완전 통일 및 시트 직접 수정 완벽 호환)
    if (action === "saveDocSelection") {
      var docStates = (data && data.docStates && typeof data.docStates === "object") ? data.docStates : {};
      var mainSheet = getMainWorkSheet(ss);
      updateSheetDocSelectionOnSheet(mainSheet, "업무문서", docStates);

      var refSheet = ss.getSheetByName("참고자료");
      if (refSheet && (!mainSheet || refSheet.getSheetId() !== mainSheet.getSheetId())) {
        updateSheetDocSelectionOnSheet(refSheet, "참고자료", docStates);
      }

      var selectionObj = {
        selected: Array.isArray(data.selected) ? data.selected : [],
        known: Array.isArray(data.known) ? data.known : [],
        remembered: Array.isArray(data.remembered) ? data.remembered : []
      };
      PropertiesService.getScriptProperties().setProperty("DOC_SELECTION_STATE", JSON.stringify(selectionObj));
      return responseJSON({
        success: true,
        action: "saveDocSelection"
      });
    }

    // 3) 기본 동작: 지식 DB 문서 업로드 ('업무문서' 탭과 '참고자료' 탭을 탭 이름으로 직접 탐색/생성)
    // 7열 표준 구조: A:업무구분 | B:참조상태 | C:문서제목 | D:사업구분/소제목(목차) | E:핵심내용 요약 | F:주요 키워드 | G:문서원문
    var docType = (data && data.docType === "참고자료") ? "참고자료" : "업무문서";
    var topWorkGroup = (data && data.workGroup) ? String(data.workGroup).trim() : "";
    var sheet;
    if (docType === "참고자료") {
      sheet = getOrCreateSheetWithHeaders(ss, "참고자료", ["업무구분", "참조상태", "문서제목", "소제목(목차)", "핵심내용 요약", "주요 키워드", "문서원문"]);
    } else {
      sheet = getMainWorkSheet(ss);
      if (sheet.getLastRow() === 0) {
        sheet.appendRow(["업무구분", "참조상태", "문서제목", "사업구분", "핵심내용 요약", "주요 키워드", "문서원문"]);
        var headerRange = sheet.getRange(1, 1, 1, 7);
        headerRange.setBackground("#1a1a2e");
        headerRange.setFontColor("#ffffff");
        headerRange.setFontWeight("bold");
      }
    }

    // 기존 시트가 5열 또는 6열 구조라면 7열 표준 구조(A:업무구분, B:참조상태)로 자동 보정
    ensureSheetColumns(sheet);

    var items = Array.isArray(data) ? data : (data.items || [data]);
    var insertedCount = 0;

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var workGroup = String(item.workGroup || topWorkGroup || "").trim() || "미분류";
      var refState = normalizeRefState(item.refState || "Y");
      var title = item.title || "제목 없음";
      var category = item.category || "일반";
      var summary = item.summary || "";
      var keywords = Array.isArray(item.keywords) ? item.keywords.join(", ") : (item.keywords || "");
      var fullText = item.fullText || "";

      sheet.appendRow([workGroup, refState, title, category, summary, keywords, fullText]);
      insertedCount++;
    }

    return responseJSON({ 
      success: true, 
      message: insertedCount + "건의 지식 DB 항목이 성공적으로 구글 시트에 추가되었습니다.",
      insertedCount: insertedCount,
      lastInsertedRow: sheet.getLastRow()
    });

  } catch (err) {
    return responseJSON({ success: false, error: err.toString() });
  }
}

function doGet(e) {
  var inputPin = e.parameter ? String(e.parameter.pin || "").trim() : "";
  var action = e.parameter ? String(e.parameter.action || "").trim() : "";
  
  var authCheck = verifyPinWithRateLimit(inputPin);
  if (!authCheck.ok) {
    return responseJSON({
      success: false,
      error: authCheck.error,
      message: authCheck.message
    });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 저장된 기록 불러오기 요청 처리 (action=getHistory&type=stt|analysis)
  if (action === "getHistory") {
    var type = e.parameter.type || "all";
    var result = { success: true, sttList: [], analysisList: [] };

    if (type === "stt" || type === "all") {
      var sttSheet = ss.getSheetByName("STT기록");
      if (sttSheet && sttSheet.getLastRow() > 1) {
        var sttValues = sttSheet.getRange(2, 1, sttSheet.getLastRow() - 1, 2).getValues();
        for (var i = sttValues.length - 1; i >= 0; i--) {
          var rawDate = sttValues[i][0];
          var dateFormatted = (rawDate instanceof Date)
            ? Utilities.formatDate(rawDate, "GMT+9", "yyyy-MM-dd HH:mm")
            : String(rawDate || "");
          result.sttList.push({
            date: dateFormatted,
            content: String(sttValues[i][1] || "")
          });
        }
      }
    }

    if (type === "analysis" || type === "all") {
      var analysisSheet = ss.getSheetByName("분석기록");
      if (analysisSheet && analysisSheet.getLastRow() > 1) {
        var anaValues = analysisSheet.getRange(2, 1, analysisSheet.getLastRow() - 1, 3).getValues();
        for (var j = anaValues.length - 1; j >= 0; j--) {
          var rawDate2 = anaValues[j][0];
          var dateFormatted2 = (rawDate2 instanceof Date)
            ? Utilities.formatDate(rawDate2, "GMT+9", "yyyy-MM-dd HH:mm")
            : String(rawDate2 || "");
          result.analysisList.push({
            date: dateFormatted2,
            question: String(anaValues[j][1] || ""),
            answer: String(anaValues[j][2] || "")
          });
        }
      }
    }

    return responseJSON(result);
  }

  // 지식 DB 행만 새로고침 요청 시 (시트가 '비공개'여도 안전하게 직접 반환)
  if (action === "getSheetData") {
    return responseJSON({
      success: true,
      rows: readKnowledgeDBRows(ss),
      docSelection: getDocSelectionState()
    });
  }

  // 기본 로그인 성공 응답: Groq 키 및 지식 DB 행 데이터 직접 반환 (시트 비공개 상태 완벽 지원)
  var sheetId = ss.getId();
  var mainWorkSheet = getMainWorkSheet(ss);
  var firstSheetGid = mainWorkSheet ? mainWorkSheet.getSheetId() : ss.getSheets()[0].getSheetId();
  var sheetCsvUrl = "https://docs.google.com/spreadsheets/d/" + sheetId + "/export?format=csv&gid=" + firstSheetGid;

  return responseJSON({ 
    success: true, 
    status: "ok", 
    groqApiKey: getGroqApiKey(),
    rows: readKnowledgeDBRows(ss),
    docSelection: getDocSelectionState(),
    sheetUrl: sheetCsvUrl,
    message: "Meeting Copilot GAS Uploader is running." 
  });
}

function responseJSON(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
