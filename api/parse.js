const formidable = require('formidable');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

module.exports.config = {
  api: {
    bodyParser: false,
  },
};

module.exports = async function handler(req, res) {
  // CORS 헤더 설정
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const parseForm = formidable.formidable || formidable;
    const form = parseForm({
      keepExtensions: true,
      maxFileSize: 50 * 1024 * 1024,
    });

    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve([fields, files]);
      });
    });

    const fileObj = files.file ? (Array.isArray(files.file) ? files.file[0] : files.file) : null;
    const apiKey = fields.apiKey ? (Array.isArray(fields.apiKey) ? fields.apiKey[0] : fields.apiKey) : '';
    const webhookUrl = fields.webhookUrl ? (Array.isArray(fields.webhookUrl) ? fields.webhookUrl[0] : fields.webhookUrl) : '';

    if (!fileObj) {
      return res.status(400).json({ error: '업로드된 파일이 없습니다.' });
    }

    const filePath = fileObj.filepath || fileObj.path;
    const originalFilename = fileObj.originalFilename || 'document';
    
    // 파일 확장자 보존 (Kordoc 파싱 정밀도 향상)
    const ext = path.extname(originalFilename) || '.hwp';
    const tempPathWithExt = `${filePath}${ext}`;
    try {
      fs.copyFileSync(filePath, tempPathWithExt);
    } catch (e) {
      console.warn('Copy temp file failed:', e);
    }

    const targetFile = fs.existsSync(tempPathWithExt) ? tempPathWithExt : filePath;

    // 1. Kordoc 파싱 수행 (npx kordoc)
    let parsedText = '';
    try {
      // kordoc CLI 호출
      const output = execSync(`npx -y kordoc "${targetFile}" --silent`, { encoding: 'utf-8', timeout: 45000 });
      parsedText = output.trim();
    } catch (kordocErr) {
      console.warn('Kordoc CLI parsing failed:', kordocErr.message);
    } finally {
      if (fs.existsSync(tempPathWithExt)) {
        try { fs.unlinkSync(tempPathWithExt); } catch (e) {}
      }
    }

    // PDF / 텍스트 추출 Fallback: Kordoc 결과가 비어있는 경우
    if (!parsedText || parsedText.trim().length === 0) {
      const lowerName = originalFilename.toLowerCase();
      if (lowerName.endsWith('.pdf')) {
        try {
          const pdfParse = require('pdf-parse');
          const dataBuffer = fs.readFileSync(filePath);
          const pdfData = await pdfParse(dataBuffer);
          if (pdfData && pdfData.text) {
            parsedText = pdfData.text.trim();
          }
        } catch (pdfErr) {
          console.warn('pdf-parse fallback failed:', pdfErr.message);
        }
      } else if (lowerName.endsWith('.txt') || lowerName.endsWith('.csv') || lowerName.endsWith('.md')) {
        // 순수 텍스트/CSV 파일만 직접 읽기
        try {
          parsedText = fs.readFileSync(filePath, 'utf-8');
        } catch (e) {}
      }
    }

    // 바이너리 데이터(HWP 바이너리, PDF 바이너리 등) 가 텍스트로 오인된 경우 엄격 제거
    const isBinaryText = (str) => {
      if (!str) return true;
      if (str.includes('%PDF-') || str.includes('FlateDecode') || str.includes('stream')) return true;
      // 렌더링 불가 바이너리 특수문자(, \x00) 비율 검사
      const replacementCharCount = (str.match(//g) || []).length;
      if (replacementCharCount > 5) return true;
      return false;
    };

    if (isBinaryText(parsedText)) {
      parsedText = '';
    }

    if (!parsedText || parsedText.trim().length === 0) {
      return res.status(500).json({ error: '문서 텍스트 파싱 실패: Vercel 서버리스 환경에서 HWP 바이너리 파싱이 차단되었습니다. 텍스트 추출 가능한 PDF/DOCX/TXT 문서이거나 HWPX 포맷을 권장합니다.' });
    }

    // 2. Gemini API로 메타데이터 (제목, 카테고리, 요약, 키워드) 추출
    let metadata = {
      title: originalFilename.replace(/\.[^/.]+$/, ""),
      category: "일반",
      summary: parsedText.slice(0, 300),
      keywords: ["문서", "자동업로드"]
    };

    if (apiKey) {
      try {
        const promptText = `다음 문서 텍스트를 분석하여 JSON 형식으로 작성해 주세요.

[문서 원문 텍스트]
${parsedText.slice(0, 8000)}

[작성 지침]
1. title: 문서의 정확한 공식 제목 또는 적절한 대표 제목 (문자열)
2. category: 사업구분 또는 문서 주제 분야 (예: 경영, 기술, 계약, 기안, 일반 등 짧은 단어 1개)
3. summary: 문서 전체 핵심 내용 요약 (마침표로 명확히 끝나는 2~4문장)
4. keywords: 회의 시 자동 매칭에 사용할 주요 핵심 단어 4~7개 (문자열 배열)

반드시 다른 설명 없이 순수한 JSON 데이터만 응답하세요. 예시:
{"title": "...", "category": "...", "summary": "...", "keywords": ["...", "..."]}`;

        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
          })
        });

        if (geminiRes.ok) {
          const gData = await geminiRes.json();
          const gText = gData?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (gText) {
            const parsedMeta = JSON.parse(gText);
            metadata = {
              title: parsedMeta.title || metadata.title,
              category: parsedMeta.category || metadata.category,
              summary: parsedMeta.summary || metadata.summary,
              keywords: Array.isArray(parsedMeta.keywords) ? parsedMeta.keywords : metadata.keywords
            };
          }
        }
      } catch (aiErr) {
        console.warn('Gemini metadata extraction failed:', aiErr);
      }
    }

    // 3. GAS Webhook으로 구글 시트에 행 추가 요청
    let sheetAppended = false;
    if (webhookUrl) {
      try {
        const payload = {
          title: metadata.title,
          category: metadata.category,
          summary: metadata.summary,
          keywords: metadata.keywords,
          fullText: parsedText.slice(0, 10000) // 구글 시트 셀 용량 감안
        };

        const gasRes = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (gasRes.ok) {
          sheetAppended = true;
        }
      } catch (gasErr) {
        console.error('GAS Webhook request failed:', gasErr);
      }
    }

    return res.status(200).json({
      success: true,
      filename: originalFilename,
      parsedLength: parsedText.length,
      metadata: metadata,
      sheetAppended: sheetAppended
    });

  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: err.message || '서버 오류 발생' });
  }
}
