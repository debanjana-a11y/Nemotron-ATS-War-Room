import express from 'express';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import cors from 'cors';
import nodemailer from 'nodemailer';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const feedbackSubmissions = new Map();
const FEEDBACK_COOLDOWN_MS = 60_000;

const nebius = new OpenAI({
  baseURL: 'https://api.tokenfactory.nebius.com/v1/',
  apiKey: process.env.NEBIUS_API_KEY,
});

const MODEL_ID = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';

app.post('/api/feedback', async (req, res) => {
  const { name = '', email = '', category = '', message = '', website = '' } = req.body || {};
  if (website) {
    return res.status(200).json({ message: 'Thank you for your feedback.' });
  }

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedEmail = typeof email === 'string' ? email.trim() : '';
  const trimmedCategory = typeof category === 'string' ? category.trim() : '';
  const trimmedMessage = typeof message === 'string' ? message.trim() : '';

  if (
    trimmedName.length > 100
    || trimmedEmail.length > 254
    || (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail))
    || !['Feedback', 'Bug report', 'Feature request'].includes(trimmedCategory)
    || trimmedMessage.length < 10
    || trimmedMessage.length > 5000
  ) {
    return res.status(400).json({ error: 'Please provide a valid category and feedback message (10-5000 characters).' });
  }

  const now = Date.now();
  const clientIp = req.ip;
  const lastSubmission = feedbackSubmissions.get(clientIp);
  if (lastSubmission && now - lastSubmission < FEEDBACK_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Please wait a minute before sending more feedback.' });
  }
  feedbackSubmissions.set(clientIp, now);
  if (feedbackSubmissions.size > 5000) {
    for (const [ip, timestamp] of feedbackSubmissions) {
      if (now - timestamp >= FEEDBACK_COOLDOWN_MS) {
        feedbackSubmissions.delete(ip);
      }
    }
  }

  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  const feedbackRecipient = process.env.FEEDBACK_TO_EMAIL || GMAIL_USER;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !feedbackRecipient) {
    feedbackSubmissions.delete(clientIp);
    console.error('Feedback email is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD.');
    return res.status(503).json({ error: 'Feedback email is not configured yet. Please try again later.' });
  }

  const emailText = [
    `Category: ${trimmedCategory}`,
    `Name: ${trimmedName || 'Not provided'}`,
    `Reply email: ${trimmedEmail || 'Not provided'}`,
    '',
    trimmedMessage,
  ].join('\n');

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD.replace(/\s+/g, ''),
      },
    });

    await transporter.sendMail({
      from: { name: 'ATS War Room Feedback', address: GMAIL_USER },
      to: feedbackRecipient,
      replyTo: trimmedEmail || undefined,
      subject: `ATS War Room feedback: ${trimmedCategory}`,
      text: emailText,
    });

    return res.status(200).json({ message: 'Thank you for your feedback.' });
  } catch (err) {
    console.error('Feedback email request failed:', err.message);
    feedbackSubmissions.delete(clientIp);
    return res.status(502).json({ error: 'Could not send feedback right now. Please try again later.' });
  }
});

const LEVEL_MAP = {
  0: 'Missing / Not Found (0 yrs)',
  1: 'Beginner (1-2 yrs)',
  2: 'Intermediate (2-5 yrs)',
  3: 'Advanced (5-8 yrs)',
  4: 'Expert / Top Match (8+ yrs)'
};

// 1. EXTRACT & SCORE MATRIX
async function evaluateMatrix(resumeText, jdText) {
  const promptText = `Strict ATS Auditor. Output raw JSON only. No intro, no reasoning, no markdown fences.

Task:
1. Extract 6 to 8 primary technical tools/skills required in the JD in order of appearance.
2. For each, evaluate candidate's cumulative tenure in the resume:
   - candidate_rank: 0 = Not found (0y), 1 = Listed only/Beginner (1-2y), 2 = Intermediate (2-5y), 3 = Advanced (5-8y), 4 = Expert (8+y).
   - target_rank: based on JD seniority requirements (1-4).

Job Description:
${jdText.slice(0, 1500)}

Candidate Resume:
${resumeText.slice(0, 2000)}

Output this exact JSON structure:
{"skills":[{"skill":"Name","target_rank":3,"candidate_rank":0}]}`;

  const response = await nebius.chat.completions.create({
    model: MODEL_ID,
    messages: [{ role: 'user', content: promptText }],
    max_tokens: 3000,
    temperature: 0.0
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
    // Direct numerical assignment without fragile string checks
    const candidateRank = Math.min(Math.max(Number(item.candidate_rank) || 0, 0), 4);

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

  const missing_keywords = skill_matrix
    .filter(s => s.status === 'missing')
    .map(s => s.skill);

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