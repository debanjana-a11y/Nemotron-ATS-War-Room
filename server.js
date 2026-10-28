import express from 'express';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const nebius = new OpenAI({
  baseURL: 'https://api.tokenfactory.nebius.com/v1/',
  apiKey: process.env.NEBIUS_API_KEY,
});

const MODEL_ID = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';

const LEVEL_MAP = {
  0: 'Missing / Not Found (0 yrs)',
  1: 'Beginner (1-2 yrs)',
  2: 'Intermediate (2-5 yrs)',
  3: 'Advanced (5-8 yrs)',
  4: 'Expert / Top Match (8+ yrs)'
};

// 1. EXTRACT & SCORE MATRIX
async function evaluateMatrix(resumeText, jdText) {
  const promptText = `You are a strict ATS Screener and Technical Auditor.

Task:
1. Identify the 5 most critical technical skills/tools mandated by the Job Description (e.g. specific languages, distributed protocols, infrastructure tools).
2. For each of these 5 JD skills, audit the candidate's resume across their ENTIRE career history:
   - If the skill is NOT in the resume at all: evidence must be "Not found" and candidate_rank must be 0.
   - If found: sum up the cumulative years across all matching roles to determine candidate_rank.
   
Ranking scale (for target_rank and candidate_rank):
0 = Not found (0 yrs)
1 = Beginner (1-2 yrs or listed only in skills section without project context)
2 = Intermediate (2-5 yrs across projects)
3 = Advanced (5-8 yrs across projects)
4 = Expert (8+ yrs)

Job Description:
${jdText.slice(0, 1500)}

Candidate Resume:
${resumeText.slice(0, 2000)}

Respond with valid JSON only. Do not wrap in markdown or backticks:
{
  "skills": [
    {
      "skill": "Technology Name",
      "target_rank": 3,
      "candidate_rank": 0,
      "evidence": "Brief citation or Not found"
    }
  ]
}`;

  const response = await nebius.chat.completions.create({
    model: MODEL_ID,
    messages: [{ role: 'user', content: promptText }],
    max_tokens: 3000,
    temperature: 0.0,
  });

  const rawContent = response.choices[0]?.message?.content || '{}';

  let parsed = null;
  try {
    const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const match = rawContent.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch (err) {}
    }
  }

  const extractedSkills = Array.isArray(parsed?.skills) ? parsed.skills : [];

  let totalScore = 0;
  const skill_matrix = extractedSkills.map(item => {
    const targetRank = Math.min(Math.max(Number(item.target_rank) || 2, 1), 4);
    let candidateRank = Number(item.candidate_rank) || 0;
    const evidenceStr = String(item.evidence || '').toLowerCase();

    if (evidenceStr.includes('not found') || candidateRank === 0) {
      candidateRank = 0;
    } else {
      candidateRank = Math.min(Math.max(candidateRank, 0), 4);
    }

    let status = 'missing';
    let match_pct = 0;

    if (candidateRank === 0) {
      status = 'missing';
      match_pct = 0;
    } else if (candidateRank < targetRank) {
      status = 'deficit';
      match_pct = Math.round((candidateRank / targetRank) * 100);
    } else if (candidateRank === targetRank) {
      status = 'met';
      match_pct = 100;
    } else {
      status = 'exceeds';
      match_pct = 100;
    }

    totalScore += match_pct;

    return {
      skill: item.skill,
      candidate_level: LEVEL_MAP[candidateRank],
      target_level: LEVEL_MAP[targetRank],
      match_pct,
      status
    };
  });

  const initial_score = skill_matrix.length > 0 ? Math.round(totalScore / skill_matrix.length) : 0;

  // FIX: Only mark skills as 'missing_keywords' if they are genuinely absent (rank 0 / status 'missing')
  const missing_keywords = skill_matrix
    .filter(s => s.status === 'missing')
    .map(s => s.skill);

  // Experience tenure deficits (tools the candidate knows, but needs more senior framing)
  const deficit_skills = skill_matrix
    .filter(s => s.status === 'deficit')
    .map(s => s.skill);

  return {
    evaluation: {
      initial_score,
      skill_matrix,
      missing_keywords,
      deficit_skills
    },
    usage: response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

// 2. SURGICAL TAILORING
async function tailorForGaps(missingKeywords, deficitSkills, resumeSummary) {
  const gapsToAddress = [...missingKeywords, ...deficitSkills];
  
  if (gapsToAddress.length === 0) {
    return {
      tailoring: {
        suggested_headline: "Candidate profile fully meets target criteria.",
        tailored_bullets: []
      },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
  }

  const prompt = `Act as a truthful resume editor. Use only facts in the resume; never invent metrics, achievements, employers, or experience. Do not claim missing skills.
Gaps: Missing: ${missingKeywords.join(', ') || 'None'}. Needs more depth: ${deficitSkills.join(', ') || 'None'}.
Resume:
${resumeSummary.slice(0, 1000)}
Return only one valid JSON object with exactly these fields: {"suggested_headline":"...","tailored_bullets":["...","..."]}.
Write one concise headline and exactly 2 concise XYZ-style bullets (under 35 words each). If the resume has no metric, do not invent one.`;

  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let tailoring;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await nebius.chat.completions.create({
      model: MODEL_ID,
      messages: [{
        role: 'user',
        content: attempt === 0
          ? prompt
          : `${prompt}\nYour previous output was incomplete or invalid. Return the required compact JSON now; do not add any other text.`,
      }],
      max_tokens: 900,
      temperature: 0,
    });

    usage.prompt_tokens += response.usage?.prompt_tokens || 0;
    usage.completion_tokens += response.usage?.completion_tokens || 0;
    usage.total_tokens += response.usage?.total_tokens || 0;

    const choice = response.choices[0];
    const rawContent = choice?.message?.content || '';
    try {
      const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (
        typeof parsed.suggested_headline === 'string'
        && parsed.suggested_headline.trim()
        && Array.isArray(parsed.tailored_bullets)
        && parsed.tailored_bullets.length === 2
        && parsed.tailored_bullets.every((bullet) => typeof bullet === 'string' && bullet.trim())
      ) {
        tailoring = {
          suggested_headline: parsed.suggested_headline.trim(),
          tailored_bullets: parsed.tailored_bullets.map((bullet) => bullet.trim()),
        };
        break;
      }
    } catch {
      // Retry once with the same concise schema request.
    }

    if (attempt === 1) {
      break;
    }
  }

  if (!tailoring) {
    throw new Error('The tailoring model did not return a complete headline and two bullets. Please retry the analysis.');
  }

  return { tailoring, usage };
}

// Unified Route
app.post('/api/analyze-and-tailor', async (req, res) => {
  try {
    const { resumeText, jdText } = req.body;
    if (!resumeText || !jdText) {
      return res.status(400).json({ error: 'Both resumeText and jdText are required.' });
    }

    const matrixRes = await evaluateMatrix(resumeText, jdText);
    const tailorRes = await tailorForGaps(
      matrixRes.evaluation.missing_keywords,
      matrixRes.evaluation.deficit_skills,
      resumeText
    );

    const tokenMetrics = {
      matrix_prompt_tokens: matrixRes.usage.prompt_tokens,
      matrix_completion_tokens: matrixRes.usage.completion_tokens,
      tailor_prompt_tokens: tailorRes.usage.prompt_tokens,
      tailor_completion_tokens: tailorRes.usage.completion_tokens,
      total_tokens_used: matrixRes.usage.total_tokens + tailorRes.usage.total_tokens
    };

    res.json({
      evaluation: matrixRes.evaluation,
      tailoring: tailorRes.tailoring,
      tokens: tokenMetrics
    });

  } catch (err) {
    console.error('API Error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`ATS Agent listening on port ${PORT}`));