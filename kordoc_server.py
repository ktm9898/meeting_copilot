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
            boundary_str = content_type.split("boundary=")[1].split(";")[0].strip('"')
            boundary = boundary_str.encode()
            parts = body.split(b"--" + boundary)

            file_bytes = None
            filename = "document.hwp"
            api_key = ""
            webhook_url = ""

            for part in parts:
                if b'Content-Disposition' in part:
                    try:
                        headers_part, content = part.split(b"\r\n\r\n", 1)
                        content = content.rsplit(b"\r\n", 1)[0]
                        headers_str = headers_part.decode('utf-8', errors='ignore')

                        if 'name="file"' in headers_str:
                            file_bytes = content
                            if 'filename="' in headers_str:
                                filename = headers_str.split('filename="')[1].split('"')[0]
                        elif 'name="apiKey"' in headers_str:
                            api_key = content.decode('utf-8', errors='ignore').strip()
                        elif 'name="webhookUrl"' in headers_str:
                            webhook_url = content.decode('utf-8', errors='ignore').strip()
                    except Exception as p_err:
                        pass

            if not file_bytes:
                self._send_json(400, {"error": "업로드된 파일이 없습니다."})
                return

            print(f"[Kordoc Parsing] Filename: {filename} ({len(file_bytes)} bytes)")
            print(f"[Debug Info] API Key Present: {bool(api_key)}, Webhook URL Present: {bool(webhook_url)}")

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

            # 2. Gemini AI 고도화 프롬프트 기반 문서 구조 분석 및 주제별 자동 분할
            default_doc_title = os.path.splitext(filename)[0]
            chunks = []

            if api_key:
                try:
                    print("[Gemini AI] Analyzing document structure & generating semantic sub-topic chunks...")
                    prompt = f"""당신은 공문서, 사업계획서, 성과보고서 분석 전문 수석 데이터분석가입니다.
아래에 제공되는 [문서 원문 텍스트]의 전체 구조와 목차(Chapter), 사업 분야를 정밀하게 분석하여, 회의 지원 지식 DB로 활용할 수 있도록 논리적 주제 단위의 지식 DB 항목 배열(JSON Array)로 분할해 주세요.

[문서 원문 텍스트]
{parsed_text[:16000]}

[분할 및 수집 핵심 지침]
1. 문서 구조 판단 & 분할 기준:
   - 단일 안내문/짧은 공문 (1~2쪽): 억지로 나누지 말고 1개 항목으로 통합 작성하세요.
   - 중대형 보고서/업무계획서/성과집: 문서에 포함된 목차 구분(예: Ⅰ. 일반현황, Ⅱ. 주요성과, Ⅲ. 금융지원 성과, Ⅳ. 경영지원 성과, Ⅴ. 상권지원 성과 등)이나 사업 영역별로 반드시 3개~7개의 별개 지식 DB 항목(JSON Array)으로 분할하세요.

2. 각 주제 항목 필수 필드 정의:
   - title: 문서 전체 대표 제목 (예: "{default_doc_title}")
   - category: 해당 세부 단락이 다루는 핵심 사업구분 (예: 경영기획, 금융지원, 부실관리, 경영지원, 상권지원 등 단정한 1개 단어)
   - summary: 해당 세부 주제의 구체적 핵심 내용 및 수치 성과 요약 (마침표로 명확히 끝나는 완성형 2~4문장)
   - keywords: 회의 중 음성 인식과 직접 자동 매칭될 해당 주제의 핵심 단어 4~7개 (문자열 배열)
   - fullText: 해당 세부 주제에 속하는 본문 텍스트 원문 내용 (문자열)"""

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
                            "required": ["title", "category", "summary", "keywords", "fullText"]
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
                    import traceback
                    print(f"[Warning] Gemini Smart Chunking failed: {ai_err}")
                    traceback.print_exc()

            if not chunks:
                self._send_json(500, {"error": f"Gemini AI 스마트 분할 실패: API 키(Gemini 2.5 Flash)를 확인해 주시거나 잠시 후 다시 시도해 주세요."})
                return

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
