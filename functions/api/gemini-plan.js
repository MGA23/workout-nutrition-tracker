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

export async function onRequestPost(context) {
  const { request, env } = context

  if (!env.DEEPSEEK_API_KEY) {
    return jsonResponse({ error: 'Missing DEEPSEEK_API_KEY in environment variables.' }, 500)
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

  const prompt = `
You are a fitness programming assistant.

Task:
- Build a 7-day weekly plan in JSON only.
- Include exercises and nutrition for each day.
- Use user profile and available days/exercises.

User profile:
${JSON.stringify(profile, null, 2)}

Week days:
${JSON.stringify(weekDays, null, 2)}

Exercise pool:
${JSON.stringify(exercisePool, null, 2)}

STRICT output format (JSON only):
{
  "summary": "Arabic short summary",
  "generated": {
    "0": {
      "dayId": 0,
      "exercises": [{ "id": "string", "name": "string", "sets": 3, "reps": "10-12", "videoUrl": "" }],
      "nutrition": {
        "preWorkout": { "name": "قبل التمرين: موز 120g: 0g بروتين، 25g كارب + واي 30g: 25g بروتين، 0g كارب" } or null,
        "goals": { "protein": 160, "carbs": 170 },
        "meals": [
          { "id": 0, "name": "بعد التمرين: دجاج 200g: 60g بروتين، 0g كارب + رز 200g: 0g بروتين، 56g كارب" }
        ]
      }
    },
    "1": { ... },
    ... up to "6"
  }
}

Rules:
- Meal name format must remain exact and parseable: "عنوان: مكون وزنg: Xg بروتين، Yg كارب + ..."
- Keep plans realistic for beginner/intermediate.
- Respect excluded foods when possible.
- Return Arabic summary.
`

  const deepseekResp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: 'You are a fitness programming assistant. Return valid JSON only.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.8,
      top_p: 0.9,
      max_tokens: 4000
    })
  })

  if (!deepseekResp.ok) {
    const text = await deepseekResp.text()
    return jsonResponse({ error: 'DeepSeek API request failed.', details: text }, 502)
  }

  const deepseekData = await deepseekResp.json()
  const text = deepseekData?.choices?.[0]?.message?.content || ''
  const parsed = extractJson(text)

  if (!parsed || !parsed.generated) {
    return jsonResponse({ error: 'DeepSeek response was not valid JSON.', raw: text }, 502)
  }

  return jsonResponse({
    summary: parsed.summary || 'تم إنشاء الخطة عبر DeepSeek.',
    generated: normalizeGenerated(parsed.generated)
  })
}
