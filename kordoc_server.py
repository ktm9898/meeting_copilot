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
import time
import json
import subprocess
import tempfile
import urllib.request
import urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

# pythonw.exe(GUI 모드) 실행 시 sys.stdout / sys.stderr가 None이 되어 충돌하는 문제 원천 방지
if sys.stdout is None:
    try:
        sys.stdout = open(os.devnull, 'w', encoding='utf-8')
    except:
        pass
if sys.stderr is None:
    try:
        sys.stderr = open(os.devnull, 'w', encoding='utf-8')
    except:
        pass

PORT = 5000

class KordocHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        try:
            if sys.stderr and not sys.stderr.closed:
                sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format%args))
        except:
            pass

    def _set_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def do_OPTIONS(self):
        self.send_response(204)
        self._set_cors_headers()
        self.end_headers()


    def do_GET(self):
        # 1. API 상태 확인 경로
        if self.path in ['/api/status', '/status']:
            self.send_response(200)
            self._set_cors_headers()
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            response = {"status": "ok", "message": "Meeting Copilot Local Kordoc Server is running"}
            self.wfile.write(json.dumps(response, ensure_ascii=False).encode('utf-8'))
            return

        # 2. 웹앱 정적 파일 (HTML, JS, SVG, JSON 등) 서빙
        req_path = urllib.parse.urlparse(self.path).path
        if req_path in ['/', '', '/index.html']:
            filepath = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.html')
        else:
            clean_path = req_path.lstrip('/')
            filepath = os.path.join(os.path.dirname(os.path.abspath(__file__)), clean_path)

        if os.path.exists(filepath) and os.path.isfile(filepath):
            mime_types = {
                '.html': 'text/html; charset=utf-8',
                '.js': 'application/javascript; charset=utf-8',
                '.json': 'application/json; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.svg': 'image/svg+xml',
                '.png': 'image/png',
                '.ico': 'image/x-icon'
            }
            ext = os.path.splitext(filepath)[1].lower()
            content_type = mime_types.get(ext, 'application/octet-stream')

            try:
                with open(filepath, 'rb') as f:
                    content = f.read()
                self.send_response(200)
                self._set_cors_headers()
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(content)))
                self.end_headers()
                self.wfile.write(content)
                return
            except Exception as read_err:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(f"File read error: {read_err}".encode('utf-8'))
                return

        # 파일이 없으면 404
        self.send_response(404)
        self.end_headers()
        self.wfile.write(b"404 Not Found")

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
            pin = ""
            doc_type = "업무문서"

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
                        elif 'name="pin"' in headers_str:
                            pin = content.decode('utf-8', errors='ignore').strip()
                        elif 'name="docType"' in headers_str:
                            doc_type = content.decode('utf-8', errors='ignore').strip() or "업무문서"
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

            if not api_key:
                self._send_json(400, {"error": "Gemini API 키가 설정되지 않았습니다. 우측 상단 [설정(⚙️)]을 눌러 Gemini API 키를 입력하고 저장해 주세요."})
                return

            last_ai_error = ""
            if api_key:
                max_retries = 3
                retry_delays = [2, 4, 8]  # 지수 백오프: 2초, 4초, 8초 대기

                if doc_type == "참고자료":
                    category_guide = """- category: 해당 세부 단락의 내용을 종합적으로 포괄하는 명료한 '소제목(목차)'.
       * 단순한 단편 추출이 아니라, 해당 분할 단락에 포함된 전체 세부 내용과 요약을 모두 아우를 수 있도록 AI가 자연스러운 대표 소제목으로 작명할 것. (예: 'I. 연구 개요 및 배경', 'II. 지원사업 추진 체계 및 특징', 'III. 지원 효과 분석 및 시사점' 등)"""
                    role_desc = "연구보고서, 정책분석자료, 이슈리포트 전문 수석 연구위원"
                else:
                    category_guide = """- category: 해당 세부 단락이 다루는 핵심 사업구분 (예: 경영기획, 금융지원, 부실관리, 경영지원, 상권지원 등 단정한 1개 단어)"""
                    role_desc = "공문서, 사업계획서, 성과보고서 분석 전문 수석 데이터분석가"

                prompt = f"""당신은 {role_desc}입니다.
아래에 제공되는 [문서 원문 텍스트]의 전체 구조와 내용 흐름을 정밀하게 분석하여, 회의 지원 지식 DB로 활용할 수 있도록 논리적 주제 단위의 지식 DB 항목 배열(JSON Array)로 분할해 주세요.

[문서 원문 텍스트]
{parsed_text[:20000]}

[분할 및 수집 핵심 지침]
1. 문서 구조 판단 & 분할 기준:
   - 단일 안내문/짧은 공문 (1~2쪽): 억지로 나누지 말고 1개 항목으로 통합 작성하세요.
   - 중대형 보고서/업무계획서/성과집: 문서에 포함된 목차 구분이나 사업 영역별로 자연스럽게 3개~7개의 별개 지식 DB 항목(JSON Array)으로 분할하세요.

2. 각 주제 항목 필수 필드 정의:
   - title: 문서 전체 대표 제목 (예: "{default_doc_title}")
   {category_guide}
   - summary: 해당 세부 주제의 구체적 핵심 내용 및 수치 성과 요약 (마침표로 명확히 끝나는 완성형 2~4문장)
   - keywords: 회의 중 음성 인식과 직접 자동 매칭될 해당 주제의 핵심 단어 4~7개 (문자열 배열)
   - fullText: 해당 세부 주제에 속하는 본문 텍스트 및 표 데이터 원문 (요약하지 말고 원문 내용 그대로 유지)"""

                gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key={api_key}"
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

                for attempt in range(max_retries + 1):
                    try:
                        print(f"[Gemini AI] Analyzing document structure (attempt {attempt + 1}/{max_retries + 1})...")
                        req = urllib.request.Request(gemini_url, data=req_data, headers={'Content-Type': 'application/json'})
                        with urllib.request.urlopen(req) as response:
                            g_res = json.loads(response.read().decode('utf-8'))
                            g_text = g_res['candidates'][0]['content']['parts'][0]['text']
                            parsed_json = json.loads(g_text)

                            if isinstance(parsed_json, list) and len(parsed_json) > 0:
                                chunks = parsed_json
                            elif isinstance(parsed_json, dict):
                                chunks = [parsed_json]
                            if chunks:
                                break
                    except urllib.error.HTTPError as http_err:
                        err_body = http_err.read().decode('utf-8', errors='ignore')
                        last_ai_error = f"HTTP {http_err.code}: {err_body[:200]}"
                        print(f"[Warning] Gemini API HTTP Error ({http_err.code}): {last_ai_error}")
                        # 503(과부하/일시 중단) 또는 429(일시 쿼터) 발생 시 지수 백오프 대기 후 재시도
                        if http_err.code in (503, 429, 500) and attempt < max_retries:
                            wait_sec = retry_delays[attempt]
                            print(f"[Retry] Server busy ({http_err.code}). Retrying in {wait_sec}s... ({attempt + 1}/{max_retries})")
                            time.sleep(wait_sec)
                            continue
                        break
                    except Exception as ai_err:
                        import traceback
                        last_ai_error = str(ai_err)
                        print(f"[Warning] Gemini Smart Chunking failed: {ai_err}")
                        traceback.print_exc()
                        if attempt < max_retries:
                            wait_sec = retry_delays[attempt]
                            print(f"[Retry] Unexpected error. Retrying in {wait_sec}s... ({attempt + 1}/{max_retries})")
                            time.sleep(wait_sec)
                            continue
                        break

            if not chunks:
                self._send_json(500, {"error": f"Gemini AI 스마트 분할 실패 ({last_ai_error}): 설정(⚙️)의 Gemini API 키가 올바른지 확인해 주세요."})
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
                            "title": default_doc_title,
                            "category": item.get("category", "일반"),
                            "summary": item.get("summary", ""),
                            "keywords": item.get("keywords", []),
                            "fullText": item.get("fullText", parsed_text[:10000])
                        })

                    payload_obj = {
                        "pin": pin,
                        "docType": doc_type,
                        "items": payload_items
                    }
                    payload = json.dumps(payload_obj).encode('utf-8')
                    gas_req = urllib.request.Request(webhook_url, data=payload, headers={'Content-Type': 'application/json'})
                    with urllib.request.urlopen(gas_req) as gas_res:
                        gas_res_text = gas_res.read().decode('utf-8')
                        try:
                            gas_json = json.loads(gas_res_text)
                            if gas_json.get("success") == True or gas_json.get("status") == "ok":
                                sheet_appended = True
                                print(f"[Google Sheets] {len(chunks)} rows appended successfully!")
                            else:
                                print(f"[Warning] Google Sheets rejected append: {gas_res_text}")
                        except:
                            if "success" in gas_res_text and "false" not in gas_res_text:
                                sheet_appended = True
                except Exception as gas_err:
                    print(f"[Error] Google Sheets append failed: {gas_err}")

            self._send_json(200, {
                "success": True,
                "filename": filename,
                "parsedLength": len(parsed_text),
                "chunks": chunks,
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

def is_port_in_use(port):
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0

def run_server():
    if is_port_in_use(PORT):
        print(f"[Notice] Kordoc server is ALREADY active on port {PORT}. (Skipping duplicate startup)")
        return

    server_address = ('0.0.0.0', PORT)
    ThreadingHTTPServer.allow_reuse_address = False
    try:
        httpd = ThreadingHTTPServer(server_address, KordocHandler)
    except OSError as err:
        if err.errno == 10048 or "Address already in use" in str(err):
            print(f"[Notice] Port {PORT} is already in use.")
            return
        raise err

    print(f"[OK] Meeting Copilot Local Kordoc Server Started! (http://localhost:{PORT})")
    print("[Info] Ready for document upload requests. (Press Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")

if __name__ == '__main__':
    run_server()
