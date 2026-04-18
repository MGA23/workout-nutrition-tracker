function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8'
    }
  })
}

function extractJson(text) {
  if (!text) return null

  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text

  const firstBrace = candidate.indexOf('{')
  const lastBrace = candidate.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null

  const raw = candidate.slice(firstBrace, lastBrace + 1)
  try {
    return JSON.parse(raw)
  } catch (_) {
    return null
  }
}

function normalizeGenerated(generated) {
  const safe = {}
  for (let i = 0; i < 7; i += 1) {
    const day = generated?.[i] || generated?.[String(i)] || {}
    const exercises = Array.isArray(day.exercises) ? day.exercises : []
    const meals = Array.isArray(day?.nutrition?.meals) ? day.nutrition.meals : []
    const goals = day?.nutrition?.goals || {}

    safe[i] = {
      dayId: i,
      exercises: exercises.map((ex, idx) => ({
        id: ex.id ?? `g-${i}-${idx}`,
        name: ex.name || `Exercise ${idx + 1}`,
        sets: Number.isFinite(Number(ex.sets)) ? Number(ex.sets) : 3,
        reps: ex.reps || '10-12',
        videoUrl: ''
      })),
      nutrition: {
        preWorkout: day?.nutrition?.preWorkout?.name ? { name: day.nutrition.preWorkout.name } : null,
        goals: {
          protein: Number.isFinite(Number(goals.protein)) ? Number(goals.protein) : 150,
          carbs: Number.isFinite(Number(goals.carbs)) ? Number(goals.carbs) : 150
        },
        meals: meals.map((meal, idx) => ({
          id: meal.id ?? idx,
          name: meal.name || `وجبة ${idx + 1}: عنصر 100g: 20g بروتين، 20g كارب`
        }))
      }
    }
  }
  return safe
}

async function fetchWithTimeout(url, options, timeoutMs = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    return response
  } finally {
    clearTimeout(timer)
  }
}

export async function onRequestPost(context) {
  const { request, env } = context

  if (!env.GEMINI_API_KEY) {
    return jsonResponse({ error: 'Missing GEMINI_API_KEY in environment variables.' }, 500)
  }

  let body
  try {
    body = await request.json()
  } catch (_) {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400)
  }

  const profile = body?.profile || {}
  const weekDays = Array.isArray(body?.weekDays) ? body.weekDays : []
  const exercisePool = Array.isArray(body?.exercisePool) ? body.exercisePool : []

  const prompt = `Generate a compact 7-day gym+nutrition plan in Arabic, valid JSON only.

Inputs:
profile=${JSON.stringify(profile)}
weekDays=${JSON.stringify(weekDays)}
exercisePool=${JSON.stringify(exercisePool)}

Output JSON schema:
{
  "summary": "Arabic short summary",
  "generated": {
    "0": {
      "dayId": 0,
      "exercises": [{ "id": "any", "name": "string", "sets": 3, "reps": "10-12", "videoUrl": "" }],
      "nutrition": {
        "preWorkout": { "name": "قبل التمرين: موز 120g: 0g بروتين، 25g كارب + واي بروتين 30g: 25g بروتين، 0g كارب" } or null,
        "goals": { "protein": 160, "carbs": 170 },
        "meals": [
          { "id": 0, "name": "وجبة 1: دجاج 200g: 60g بروتين، 0g كارب + رز 200g: 0g بروتين، 56g كارب" }
        ]
      }
    }
  }
}

Rules:
1) Strict valid JSON only (no markdown).
2) For every meal name keep exact parseable format: "عنوان: مكون وزنg: Xg بروتين، Yg كارب + ...".
3) Keep plan practical for beginner/intermediate.
4) Respect excluded foods if present.
5) Include all days 0..6.
6) Keep response concise and minimal tokens.
`

  let geminiResp
  try {
    geminiResp = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          },
        ],
        generationConfig: {
          temperature: 0.4,
          topP: 0.9,
          maxOutputTokens: 1200,
          responseMimeType: 'text/plain'
        }
      })
    }, 45000)
  } catch (error) {
    if (error?.name === 'AbortError') {
      return jsonResponse({ error: 'Gemini request timeout after 45s.' }, 504)
    }
    return jsonResponse({ error: 'Gemini request failed before response.', details: String(error?.message || error) }, 502)
  }

  if (!geminiResp.ok) {
    const text = await geminiResp.text()
    return jsonResponse({ error: 'Gemini API request failed.', details: text }, 502)
  }

  const geminiData = await geminiResp.json()
  const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const parsed = extractJson(text)

  if (!parsed || !parsed.generated) {
    return jsonResponse({ error: 'Gemini response was not valid JSON.', raw: text }, 502)
  }

  return jsonResponse({
    summary: parsed.summary || 'تم إنشاء الخطة عبر Gemini.',
    generated: normalizeGenerated(parsed.generated)
  })
}
