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

  const prompt = `You are an executive resume strategist.
Target gaps identified:
- Missing critical skills: ${missingKeywords.length > 0 ? missingKeywords.join(', ') : 'None'}
- Tenure/depth deficits: ${deficitSkills.length > 0 ? deficitSkills.join(', ') : 'None'}

Candidate Resume context:
${resumeSummary.slice(0, 1000)}

Instructions:
1. Provide a professional headline positioning the candidate toward the target role without misrepresenting their core domain.
2. Provide exactly 2 accomplishment bullets using Google's XYZ formula ("Accomplished [X] as measured by [Y] by doing [Z]").
   - If skills are completely missing, bridge adjacent experience (e.g. networking socket programming to distributed streaming). Do NOT invent fake companies or jobs.

Respond with valid JSON only:
{"suggested_headline":"Title","tailored_bullets":["Bullet 1","Bullet 2"]}`;

  const response = await nebius.chat.completions.create({
    model: MODEL_ID,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1500,
    temperature: 0.2,
  });

  const rawContent = response.choices[0]?.message?.content || '{}';

  let tailoring = null;
  try {
    const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    tailoring = JSON.parse(cleaned);
  } catch (e) {
    const match = rawContent.match(/\{[\s\S]*\}/);
    if (match) {
      try { tailoring = JSON.parse(match[0]); } catch (err) {}
    }
  }

  return {
    tailoring: tailoring || {
      suggested_headline: "Senior Backend & Infrastructure Engineer",
      tailored_bullets: [
        "Designed high-throughput communication protocols reducing latency by 20% across distributed microservices.",
        "Engineered fault-tolerant backend workflows adhering to 99.99% availability requirements."
      ]
    },
    usage: response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
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