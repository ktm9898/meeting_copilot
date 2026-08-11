const formidable = require('formidable');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

export const config = {
  api: {
    bodyParser: false, // formidable로 파일 파싱하기 위해 기본 body-parser 비활성화
  },
};

export default async function handler(req, res) {
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
    const form = formidable({
      keepExtensions: true,
      maxFileSize: 50 * 1024 * 1024, // 최대 50MB
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
    
    // 1. Kordoc 파싱 수행 (npx kordoc)
    let parsedText = '';
    try {
      // kordoc CLI 호출
      const output = execSync(`npx -y kordoc "${filePath}" --silent`, { encoding: 'utf-8', timeout: 30000 });
      parsedText = output.trim();
    } catch (kordocErr) {
      console.warn('Kordoc CLI parsing failed, falling back to raw read:', kordocErr.message);
      // Fallback: 텍스트 파일인 경우 직접 읽기
      try {
        parsedText = fs.readFileSync(filePath, 'utf-8');
      } catch (rErr) {
        parsedText = `[파싱 실패] ${originalFilename}`;
      }
    }

    if (!parsedText || parsedText.trim().length === 0) {
      return res.status(500).json({ error: '문서에서 텍스트를 추출할 수 없습니다.' });
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

        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`, {
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
