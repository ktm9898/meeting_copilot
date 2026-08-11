"""
kordoc_server.py - 내 컴퓨터(로컬) Kordoc 파서 전용 백엔드 서버

기능:
1. 웹 앱(index.html)에서 HWP, HWPX, PDF, XLSX, DOCX 문서 업로드 수신
2. 내 컴퓨터에 설치된 'kordoc' CLI(npx kordoc)로 100% 정밀 파싱
3. Gemini 2.5 Flash API로 문서제목, 사업구분, 요약, 핵심키워드 자동 추출
4. 구글 앱스 스크립트(GAS) Webhook으로 구글 시트에 행 추가
"""

import os
import sys
import json
import subprocess
import tempfile
import urllib.request
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 5000

class KordocHandler(BaseHTTPRequestHandler):
    def _set_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(200)
        self._set_cors_headers()
        self.end_headers()

    def do_GET(self):
        self.send_response(200)
        self._set_cors_headers()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        response = {"status": "ok", "message": "Meeting Copilot Local Kordoc Server is running"}
        self.wfile.write(json.dumps(response, ensure_ascii=False).encode('utf-8'))

    def do_POST(self):
        if self.path != '/upload':
            self.send_response(404)
            self.end_headers()
            return

        try:
            content_type = self.headers.get('Content-Type', '')
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)

            # Multipart form-data 파싱
            boundary = content_type.split("boundary=")[1].encode()
            parts = body.split(b"--" + boundary)

            file_bytes = None
            filename = "document.hwp"
            api_key = ""
            webhook_url = ""

            for part in parts:
                if b'Content-Disposition' in part:
                    headers_part, content = part.split(b"\r\n\r\n", 1)
                    content = content.rsplit(b"\r\n", 1)[0]
                    headers_str = headers_part.decode('utf-8', errors='ignore')

                    if 'name="file"' in headers_str:
                        file_bytes = content
                        if 'filename="' in headers_str:
                            filename = headers_str.split('filename="')[1].split('"')[0]
                    elif 'name="apiKey"' in headers_str:
                        api_key = content.decode('utf-8').strip()
                    elif 'name="webhookUrl"' in headers_str:
                        webhook_url = content.decode('utf-8').strip()

            if not file_bytes:
                self._send_json(400, {"error": "업로드된 파일이 없습니다."})
                return

            print(f"[Kordoc Parsing] Filename: {filename} ({len(file_bytes)} bytes)")

            # 임시 파일 저장 (확장자 유지)
            ext = os.path.splitext(filename)[1] or ".hwp"
            with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
                tmp.write(file_bytes)
                tmp_path = tmp.name

            parsed_text = ""
            try:
                # 1. 내 컴퓨터의 Kordoc CLI 실행 (npx kordoc)
                cmd = f'npx -y kordoc "{tmp_path}" --silent'
                res = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='utf-8', errors='ignore', timeout=60)
                parsed_text = res.stdout.strip()
            except Exception as e:
                print(f"[Warning] Kordoc parse warning: {e}")

            finally:
                if os.path.exists(tmp_path):
                    try:
                        os.remove(tmp_path)
                    except:
                        pass

            if not parsed_text or len(parsed_text.strip()) == 0:
                self._send_json(500, {"error": "Kordoc 문서 텍스트 파싱 실패 (암호화 문서 또는 스캔 전용 이미지 문서 여부를 확인해 주세요)"})
                return

            print(f"[Kordoc Parsing Complete] Extracted length: {len(parsed_text)}")

            # 2. Gemini AI 스마트 주제별 2단계(Two-Pass) 자동 분할
            default_doc_title = os.path.splitext(filename)[0]
            chunks = []

            if api_key:
                try:
                    # [1단계 질의] 이 문서의 목차/주제가 몇 개로 나뉘는지 주제 목록 분석
                    print("[Gemini AI Step 1] Analyzing document outline & sub-topic topics...")
                    step1_prompt = f"""다음 문서 텍스트의 목차, 장(Chapter), 세부 사업/주제를 분석하여 이 문서가 포함하고 있는 주제 목록(JSON 배열)을 작성하세요.

[문서 원문 텍스트]
{parsed_text[:15000]}

작성 형식 (JSON Array of strings):
["1. 일반현황", "2. 주요성과", "3. 금융지원 성과", "4. 경영지원 성과", "5. 상권지원 성과"]"""

                    gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
                    req_data1 = json.dumps({
                        "contents": [{"parts": [{"text": step1_prompt}]}],
                        "generationConfig": {
                            "temperature": 0.1,
                            "responseMimeType": "application/json",
                            "responseSchema": {
                                "type": "ARRAY",
                                "items": {"type": "STRING"}
                            }
                        }
                    }).encode('utf-8')

                    req1 = urllib.request.Request(gemini_url, data=req_data1, headers={'Content-Type': 'application/json'})
                    topic_list = ["전체 개요"]
                    with urllib.request.urlopen(req1) as resp1:
                        g_res1 = json.loads(resp1.read().decode('utf-8'))
                        g_text1 = g_res1['candidates'][0]['content']['parts'][0]['text']
                        topic_list = json.loads(g_text1)

                    print(f"[Gemini AI Step 1 Result] Detected {len(topic_list)} topics: {topic_list}")

                    # [2단계 질의] 감지된 주제 목록에 맞춰 각 주제별로 요약, 키워드, 본문을 분할 작성
                    print(f"[Gemini AI Step 2] Generating structured rows for identified {len(topic_list)} topics...")
                    step2_prompt = f"""다음 문서 원문 텍스트를 위에서 분석한 {len(topic_list)}개의 주제({json.dumps(topic_list, ensure_ascii=False)})별로 각각 구분하여, 주제별 지식 DB 항목 객체들의 배열(JSON Array)을 작성하세요.

[문서 원문 텍스트]
{parsed_text[:15000]}

[각 주제별 생성 지침]
- title: 문서 전체 대표 제목 (예: "{default_doc_title}")
- category: 감지된 세부 주제명 (예: 금융지원, 상권지원 등 1단어)
- summary: 해당 세부 주제 내용에 대한 핵심 요약 (2~4문장)
- keywords: 해당 세부 주제와 매칭될 주요 핵심 단어 4~7개 (문자열 배열)
- fullText: 해당 세부 주제에 속하는 본문 텍스트 (문자열)"""

                    schema_json = {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "title": {"type": "STRING"},
                                "category": {"type": "STRING"},
                                "summary": {"type": "STRING"},
                                "keywords": {"type": "ARRAY", "items": {"type": "STRING"}},
                                "fullText": {"type": "STRING"}
                            },
                            "required": ["title", "category", "summary", "keywords", "fullText"]
                        }
                    }

                    req_data2 = json.dumps({
                        "contents": [{"parts": [{"text": step2_prompt}]}],
                        "generationConfig": {
                            "temperature": 0.2,
                            "responseMimeType": "application/json",
                            "responseSchema": schema_json
                        }
                    }).encode('utf-8')

                    req2 = urllib.request.Request(gemini_url, data=req_data2, headers={'Content-Type': 'application/json'})
                    with urllib.request.urlopen(req2) as resp2:
                        g_res2 = json.loads(resp2.read().decode('utf-8'))
                        g_text2 = g_res2['candidates'][0]['content']['parts'][0]['text']
                        parsed_json = json.loads(g_text2)

                        if isinstance(parsed_json, list) and len(parsed_json) > 0:
                            chunks = parsed_json
                        elif isinstance(parsed_json, dict):
                            chunks = [parsed_json]
                except Exception as ai_err:
                    print(f"[Warning] Gemini Two-Pass Smart Chunking failed: {ai_err}")

            if not chunks:
                chunks = [{
                    "title": default_doc_title,
                    "category": "일반",
                    "summary": parsed_text[:300],
                    "keywords": ["문서", "자동업로드"],
                    "fullText": parsed_text[:10000]
                }]

            print(f"[Smart Chunking Result] Total {len(chunks)} sub-topic rows generated")

            # 3. 구글 앱스 스크립트 Webhook으로 구글 시트에 N개 행 일괄 저장
            sheet_appended = False
            if webhook_url:
                try:
                    print(f"[Google Sheets] Appending {len(chunks)} rows to sheet...")
                    payload_items = []
                    for item in chunks:
                        payload_items.append({
                            "title": item.get("title", default_doc_title),
                            "category": item.get("category", "일반"),
                            "summary": item.get("summary", ""),
                            "keywords": item.get("keywords", []),
                            "fullText": item.get("fullText", parsed_text[:10000])
                        })

                    payload = json.dumps(payload_items).encode('utf-8')
                    gas_req = urllib.request.Request(webhook_url, data=payload, headers={'Content-Type': 'application/json'})
                    with urllib.request.urlopen(gas_req) as gas_res:
                        sheet_appended = True
                        print(f"[Google Sheets] {len(chunks)} rows appended successfully")
                except Exception as gas_err:
                    print(f"[Error] Google Sheets append failed: {gas_err}")

            self._send_json(200, {
                "success": True,
                "filename": filename,
                "parsedLength": len(parsed_text),
                "chunkCount": len(chunks),
                "sheetAppended": sheet_appended
            })

        except Exception as err:
            print(f"[Error] Server error: {err}")
            self._send_json(500, {"error": str(err)})

    def _send_json(self, status_code, obj):
        self.send_response(status_code)
        self._set_cors_headers()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(obj, ensure_ascii=False).encode('utf-8'))

def run_server():
    server_address = ('', PORT)
    httpd = HTTPServer(server_address, KordocHandler)
    print(f"[OK] Meeting Copilot Local Kordoc Server Started! (http://localhost:{PORT})")
    print("[Info] Ready for document upload requests. (Press Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")

if __name__ == '__main__':
    run_server()
