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

            # 2. Gemini AI 스마트 주제별 자동 분할 (Smart Chunking)
            default_doc_title = os.path.splitext(filename)[0]
            chunks = []

            if api_key:
                try:
                    print("[Gemini AI] Analyzing & Smart Chunking document into sub-topics...")
                    prompt = f"""다음은 문서 전체에서 추출한 마크다운/텍스트입니다.
이 문서가 포함하는 세부 목차, 사업 분야, 주요 주제별로 내용을 분석하여 최저 3개~최대 7개의 세부 챕터 항목 배열로 분할 작성해 주세요.

[문서 원문 텍스트]
{parsed_text[:15000]}

[필수 작성 지침]
1. 문서 전체를 1개로 요약하지 마시고, 문서 안의 주요 세부 주제/사업별(예: 일반현황, 금융지원 성과, 경영지원 성과, 상권지원 성과, 자치구 협력 성과 등)로 분할하여 최소 3개 이상의 챕터 배열(Array)을 만들어 주세요.
2. 각 항목의 title에는 문서 전체 제목("{default_doc_title}")을 작성하고, category에는 세부 주제 1단어(예: 금융지원, 상권지원 등)를 입력하세요.
3. summary에는 해당 챕터의 구체적 성과 및 요약을 2~4문장으로 작성하세요.
4. keywords에는 해당 챕터와 자동 매칭될 핵심 단어 4~7개를 배열로 입력하세요."""

                    gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
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
                            "required": ["title", "category", "summary", "keywords"]
                        }
                    }

                    req_data = json.dumps({
                        "contents": [{"parts": [{"text": prompt}]}],
                        "generationConfig": {
                            "temperature": 0.2,
                            "responseMimeType": "application/json",
                            "responseSchema": schema_json
                        }
                    }).encode('utf-8')

                    req = urllib.request.Request(gemini_url, data=req_data, headers={'Content-Type': 'application/json'})
                    with urllib.request.urlopen(req) as response:
                        g_res = json.loads(response.read().decode('utf-8'))
                        g_text = g_res['candidates'][0]['content']['parts'][0]['text']
                        parsed_json = json.loads(g_text)

                        if isinstance(parsed_json, list) and len(parsed_json) > 0:
                            chunks = parsed_json
                        elif isinstance(parsed_json, dict):
                            chunks = [parsed_json]
                except Exception as ai_err:
                    print(f"[Warning] Gemini Smart Chunking failed, fallback to single item: {ai_err}")

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
