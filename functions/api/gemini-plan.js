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

  if (!env.GROQ_API_KEY) {
    return jsonResponse({ error: 'Missing GROQ_API_KEY in environment variables.' }, 500)
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
        "preWorkout": null,
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
7) Use valid JSON primitives only. Do not write placeholders like "..." or comments.
`

  const modelCandidates = [
    'llama-3.1-8b-instant',
    'llama-3.3-70b-versatile'
  ]

  let providerResp = null
  let lastErrorText = ''

  for (const model of modelCandidates) {
    try {
      const resp = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are a fitness programming assistant. Return valid JSON only.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.15,
          top_p: 0.9,
          max_tokens: 1400
        })
      }, 30000)

      if (resp.ok) {
        providerResp = resp
        break
      }

      const text = await resp.text()
      lastErrorText = text

      // Groq may return json_validate_failed with a parseable failed_generation payload.
      try {
        const errorPayload = JSON.parse(text)
        const failedGeneration = errorPayload?.error?.failed_generation
        if (errorPayload?.error?.code === 'json_validate_failed' && failedGeneration) {
          const parsedFromFailed = extractJson(failedGeneration)
          if (parsedFromFailed?.generated) {
            return jsonResponse({
              summary: parsedFromFailed.summary || 'تم إنشاء الخطة عبر Groq.',
              generated: normalizeGenerated(parsedFromFailed.generated)
            })
          }
        }
      } catch (_) {
        // ignore JSON parse failure and continue fallback flow
      }

      if (resp.status === 404 || resp.status === 429) continue

      return jsonResponse({ error: `Groq API request failed on model ${model}.`, details: text }, 502)
    } catch (error) {
      if (error?.name === 'AbortError') {
        return jsonResponse({ error: 'Groq request timeout after 30s.' }, 504)
      }
      return jsonResponse({ error: 'Groq request failed before response.', details: String(error?.message || error) }, 502)
    }
  }

  if (!providerResp) {
    return jsonResponse({ error: 'No available Groq model worked with this key/limits.', details: lastErrorText }, 502)
  }

  const providerData = await providerResp.json()
  const text = providerData?.choices?.[0]?.message?.content || ''
  const parsed = extractJson(text)

  if (!parsed || !parsed.generated) {
    return jsonResponse({ error: 'Groq response was not valid JSON.', raw: text }, 502)
  }

  return jsonResponse({
    summary: parsed.summary || 'تم إنشاء الخطة عبر Groq.',
    generated: normalizeGenerated(parsed.generated)
  })
}
