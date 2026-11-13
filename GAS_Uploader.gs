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

function appendRowsFromSheet(sheet, docTypeLabel, list) {
  if (!sheet || sheet.getLastRow() < 2) return;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!row[0] && !row[2] && !row[4]) continue;
    list.push({
      docType: docTypeLabel,
      title: String(row[0] || ""),
      category: String(row[1] || ""),
      summary: String(row[2] || ""),
      keywords: String(row[3] || ""),
      fullText: String(row[4] || "")
    });
  }
}

function readKnowledgeDBRows(ss) {
  var list = [];
  // 1) 첫 번째 기본 시트 -> '업무문서'
  var mainSheet = ss.getSheets()[0];
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

    // 2-1) 참조 문서 선택 상태 클라우드 동기화 저장 (다른 PC / 스마트폰 연동용)
    if (action === "saveDocSelection") {
      var selectionObj = {
        selected: Array.isArray(data.selected) ? data.selected : [],
        known: Array.isArray(data.known) ? data.known : []
      };
      PropertiesService.getScriptProperties().setProperty("DOC_SELECTION_STATE", JSON.stringify(selectionObj));
      return responseJSON({
        success: true,
        action: "saveDocSelection"
      });
    }

    // 3) 기본 동작: 지식 DB 문서 업로드 ('업무문서'는 첫 번째 시트, '참고자료'는 참고자료 탭 자동 생성/사용)
    var docType = (data && data.docType === "참고자료") ? "참고자료" : "업무문서";
    var sheet;
    if (docType === "참고자료") {
      sheet = getOrCreateSheetWithHeaders(ss, "참고자료", ["문서제목", "소제목(목차)", "핵심내용 요약", "주요 키워드", "문서원문"]);
    } else {
      sheet = ss.getSheets()[0];
      if (sheet.getLastRow() === 0) {
        sheet.appendRow(["문서제목", "사업구분", "핵심내용 요약", "주요 키워드", "문서원문"]);
        var headerRange = sheet.getRange(1, 1, 1, 5);
        headerRange.setBackground("#1a1a2e");
        headerRange.setFontColor("#ffffff");
        headerRange.setFontWeight("bold");
      }
    }

    var items = Array.isArray(data) ? data : (data.items || [data]);
    var insertedCount = 0;

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var title = item.title || "제목 없음";
      var category = item.category || "일반";
      var summary = item.summary || "";
      var keywords = Array.isArray(item.keywords) ? item.keywords.join(", ") : (item.keywords || "");
      var fullText = item.fullText || "";

      sheet.appendRow([title, category, summary, keywords, fullText]);
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
  var firstSheetGid = ss.getSheets()[0].getSheetId();
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
