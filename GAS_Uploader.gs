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

function doPost(e) {
  try {
    var authPin = getAuthPin();
    var data;
    if (e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    } else {
      return responseJSON({ success: false, error: "No post data" });
    }

    // PIN 검증 (설정되어 있을 경우)
    if (authPin) {
      var inputPin = (data && data.pin) ? String(data.pin).trim() : (e.parameter ? String(e.parameter.pin || "").trim() : "");
      if (inputPin !== authPin) {
        return responseJSON({ success: false, error: "Unauthorized: Invalid PIN" });
      }
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    
    // 헤더가 없으면 작성 (1행)
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["문서제목", "사업구분", "핵심내용 요약", "주요 키워드", "문서원문"]);
      // 헤더 스타일링
      var headerRange = sheet.getRange(1, 1, 1, 5);
      headerRange.setBackground("#1a1a2e");
      headerRange.setFontColor("#ffffff");
      headerRange.setFontWeight("bold");
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

      // 새로운 행 추가
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
  var authPin = getAuthPin();
  var inputPin = e.parameter ? String(e.parameter.pin || "").trim() : "";
  
  // 1. 구글 시트 스크립트 속성에 AUTH_PIN이 등록되지 않은 경우
  if (!authPin) {
    return responseJSON({ 
      success: false, 
      error: "AUTH_PIN_NOT_SET", 
      message: "구글 시트의 [프로젝트 설정 -> 스크립트 속성]에 AUTH_PIN(비밀번호)을 추가해 주세요." 
    });
  }

  // 2. 비밀번호 불일치 엄격 차단
  if (inputPin !== authPin) {
    return responseJSON({ 
      success: false, 
      error: "Unauthorized: Invalid PIN", 
      message: "비밀번호가 올바르지 않습니다." 
    });
  }

  // 3. 올바른 비밀번호일 때 Groq API 키 및 시트 CSV 읽기 주소 자동 반환
  var groqApiKey = getGroqApiKey();
  var sheetId = SpreadsheetApp.getActiveSpreadsheet().getId();
  var sheetCsvUrl = "https://docs.google.com/spreadsheets/d/" + sheetId + "/export?format=csv";

  return responseJSON({ 
    success: true, 
    status: "ok", 
    groqApiKey: groqApiKey,
    sheetUrl: sheetCsvUrl,
    message: "Meeting Copilot GAS Uploader is running." 
  });
}

function responseJSON(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
