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

function toNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function dayCategoryFromType(dayType = '') {
  if (dayType.includes('Push')) return 'Push'
  if (dayType.includes('Pull')) return 'Pull'
  if (dayType.includes('Legs')) return 'Legs'
  if (dayType.includes('Upper')) return 'Upper'
  if (dayType.includes('Light Activity')) return 'Light'
  return 'Rest'
}

function calcDefaultGoals(profile, dayType = '') {
  const weight = Math.max(40, toNumber(profile?.weight, 75))
  const goal = profile?.goal || 'maintain'
  const proteinPerKg = goal === 'fat_loss' ? 2.2 : goal === 'muscle_gain' ? 2.0 : 1.9
  const carbsPerKg = goal === 'fat_loss' ? 1.8 : goal === 'muscle_gain' ? 3.2 : 2.6

  const multiplier = dayType.includes('Legs')
    ? 1.2
    : (dayType.includes('Push') || dayType.includes('Pull'))
      ? 1
      : dayType.includes('Upper')
        ? 0.9
        : dayType.includes('Light Activity')
          ? 0.75
          : 0.6

  return {
    protein: Math.round(weight * proteinPerKg),
    carbs: Math.round(Math.max(80, weight * carbsPerKg * multiplier))
  }
}

function buildMealName(title, items) {
  const chunks = items.map((item) => `${item.food} ${item.weight}g: ${item.protein}g بروتين، ${item.carbs}g كارب`)
  return `${title}: ${chunks.join(' + ')}`
}

function isParseableMealName(name) {
  if (typeof name !== 'string') return false
  const text = name.trim()
  if (!text || !text.includes(':')) return false
  return text.includes('g بروتين') && text.includes('g كارب')
}

function fallbackNutritionForDay(dayType, profile, dayId) {
  const goals = calcDefaultGoals(profile, dayType)
  const hasWorkout = !dayType.includes('Rest')
  const excluded = String(profile?.excludedFoods || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)

  const proteins = ['دجاج', 'لحم', 'تونة', 'بيض', 'زبادي', 'واي بروتين']
  const carbs = ['رز', 'خبز', 'شوفان', 'موز', 'فاكهة']

  const proteinPool = proteins.filter((f) => !excluded.some((e) => f.toLowerCase().includes(e)))
  const carbPool = carbs.filter((f) => !excluded.some((e) => f.toLowerCase().includes(e)))

  const p = proteinPool.length > 0 ? proteinPool : proteins
  const c = carbPool.length > 0 ? carbPool : carbs

  const pickP = (offset) => p[(dayId + offset) % p.length]
  const pickC = (offset) => c[(dayId + offset) % c.length]

  const meals = [
    {
      id: 0,
      name: buildMealName(hasWorkout ? 'بعد التمرين' : 'وجبة 1', [
        { food: pickP(0), weight: 200, protein: Math.round(goals.protein * 0.38), carbs: 0 },
        { food: pickC(0), weight: 200, protein: 0, carbs: Math.round(goals.carbs * 0.42) }
      ])
    },
    {
      id: 1,
      name: buildMealName('وجبة 2', [
        { food: pickP(1), weight: 180, protein: Math.round(goals.protein * 0.34), carbs: 0 },
        { food: pickC(1), weight: 150, protein: 0, carbs: Math.round(goals.carbs * 0.28) }
      ])
    },
    {
      id: 2,
      name: buildMealName('وجبة 3', [
        { food: pickP(2), weight: 170, protein: Math.round(goals.protein * 0.28), carbs: 0 },
        { food: pickC(2), weight: 120, protein: 0, carbs: Math.max(0, goals.carbs - Math.round(goals.carbs * 0.42) - Math.round(goals.carbs * 0.28)) }
      ])
    }
  ]

  const preWorkout = hasWorkout
    ? {
        name: buildMealName('قبل التمرين', [
          { food: pickC(3), weight: 120, protein: 0, carbs: Math.round(goals.carbs * 0.2) },
          { food: 'واي بروتين', weight: 30, protein: 25, carbs: 0 }
        ])
      }
    : null

  return { preWorkout, goals, meals }
}

function normalizeGeneratedStrict(generated, weekDays, exercisePool, profile) {
  const safe = {}

  const poolByCategory = {
    Push: exercisePool.filter((x) => x.category === 'Push'),
    Pull: exercisePool.filter((x) => x.category === 'Pull'),
    Legs: exercisePool.filter((x) => x.category === 'Legs'),
    Core: exercisePool.filter((x) => x.category === 'Core'),
    Cardio: exercisePool.filter((x) => x.category === 'Cardio')
  }

  function sourceForCategory(category) {
    if (category === 'Upper') return [...poolByCategory.Push, ...poolByCategory.Pull]
    if (category === 'Light') return [...poolByCategory.Cardio, ...poolByCategory.Core]
    return poolByCategory[category] || []
  }

  for (let i = 0; i < 7; i += 1) {
    const dayCfg = weekDays[i] || { id: i, type: 'Rest' }
    const type = dayCfg.type || 'Rest'
    const category = dayCategoryFromType(type)
    const day = generated?.[i] || generated?.[String(i)] || {}
    const source = sourceForCategory(category)
    const allowedNames = new Set(source.map((x) => x.name))

    let exercises = Array.isArray(day.exercises)
      ? day.exercises.map((ex, idx) => ({
          id: ex.id ?? `g-${i}-${idx}`,
          name: ex.name || `Exercise ${idx + 1}`,
          sets: Number.isFinite(Number(ex.sets)) ? Number(ex.sets) : 3,
          reps: ex.reps || '10-12',
          videoUrl: ''
        }))
      : []

    const trainingDay = category !== 'Rest'
    const minExercises = category === 'Light' ? 2 : trainingDay ? 3 : 0
    const maxExercises = category === 'Light' ? 3 : trainingDay ? 5 : 0

    if (trainingDay && source.length > 0) {
      exercises = exercises.map((ex, idx) => {
        if (allowedNames.has(ex.name)) return ex
        const fallback = source[(i + idx) % source.length]
        if (!fallback) return ex
        return {
          id: ex.id ?? `g-${i}-${idx}`,
          name: fallback.name,
          sets: toNumber(fallback.sets, toNumber(ex.sets, 3)),
          reps: fallback.reps || ex.reps || '10-12',
          videoUrl: ''
        }
      })
    }

    if (trainingDay && exercises.length > maxExercises) {
      exercises = exercises.slice(0, maxExercises)
    }

    if (trainingDay) {
      const seen = new Set()
      exercises = exercises.filter((ex) => {
        const key = String(ex.name || '').trim()
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
    }

    if (trainingDay && exercises.length < minExercises) {
      const needed = minExercises - exercises.length
      for (let n = 0; n < needed; n += 1) {
        const item = source[(i + n) % Math.max(1, source.length)]
        if (!item) break
        exercises.push({
          id: `auto-${i}-${n}`,
          name: item.name,
          sets: toNumber(item.sets, 3),
          reps: item.reps || '10-12',
          videoUrl: ''
        })
      }
    }

    if (!trainingDay) exercises = []

    const nutrition = day?.nutrition || {}
    const fallbackNutrition = fallbackNutritionForDay(type, profile, i)
    const meals = Array.isArray(nutrition.meals) ? nutrition.meals.filter(Boolean) : []
    const normalizedMeals = meals.map((meal, idx) => {
      const fallback = fallbackNutrition.meals[idx] || fallbackNutrition.meals[fallbackNutrition.meals.length - 1]
      const candidateName = meal?.name
      return {
        id: meal?.id ?? idx,
        name: isParseableMealName(candidateName) ? candidateName : fallback.name
      }
    })

    safe[i] = {
      dayId: i,
      exercises,
      nutrition: {
        preWorkout: trainingDay
          ? (nutrition.preWorkout?.name && isParseableMealName(nutrition.preWorkout.name)
            ? { name: nutrition.preWorkout.name }
            : fallbackNutrition.preWorkout)
          : null,
        goals: {
          protein: Number.isFinite(Number(nutrition?.goals?.protein)) ? Number(nutrition.goals.protein) : fallbackNutrition.goals.protein,
          carbs: Number.isFinite(Number(nutrition?.goals?.carbs)) ? Number(nutrition.goals.carbs) : fallbackNutrition.goals.carbs
        },
        meals: normalizedMeals.length >= 3
          ? normalizedMeals
          : fallbackNutrition.meals
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
              generated: normalizeGeneratedStrict(parsedFromFailed.generated, weekDays, exercisePool, profile)
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
    generated: normalizeGeneratedStrict(parsed.generated, weekDays, exercisePool, profile)
  })
}
