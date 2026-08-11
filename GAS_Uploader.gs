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
 * 6. [배포] 버튼 클릭 후 생성된 '웹 앱 URL'을 복사하여 Meeting Copilot 설정창에 입력합니다.
 */

function doPost(e) {
  try {
    var data;
    if (e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    } else {
      return responseJSON({ success: false, error: "No post data" });
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

    var items = Array.isArray(data) ? data : [data];
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
  return responseJSON({ status: "ok", message: "Meeting Copilot GAS Uploader is running." });
}

function responseJSON(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
