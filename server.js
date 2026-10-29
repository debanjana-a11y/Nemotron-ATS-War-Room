import express from 'express';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import cors from 'cors';
import { Resend } from 'resend';

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


const AUDITOR_MODEL = process.env.AUDITOR_MODEL || 'nvidia/Nemotron-3_5-Lightning';
const SCREENING_MODEL = process.env.SCREENING_MODEL || 'nvidia/Nemotron-3_5-Lightning';
const TAILOR_MODEL = process.env.TAILOR_MODEL || 'nvidia/Nemotron-3_5-Lightning';

console.log(`Using models: AUDITOR_MODEL=${AUDITOR_MODEL}, SCREENING_MODEL=${SCREENING_MODEL}, TAILOR_MODEL=${TAILOR_MODEL}`);

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

  const { RESEND_API_KEY, FEEDBACK_TO_EMAIL, FEEDBACK_FROM_EMAIL } = process.env;
  if (!RESEND_API_KEY || !FEEDBACK_TO_EMAIL || !FEEDBACK_FROM_EMAIL) {
    feedbackSubmissions.delete(clientIp);
    console.error('Feedback email is not configured. Set RESEND_API_KEY, FEEDBACK_TO_EMAIL, and FEEDBACK_FROM_EMAIL.');
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
    const resend = new Resend(RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: FEEDBACK_FROM_EMAIL,
      to: [FEEDBACK_TO_EMAIL],
      subject: `ATS War Room feedback: ${trimmedCategory}`,
      text: emailText,
      ...(trimmedEmail ? { replyTo: trimmedEmail } : {}),
    });

    if (error) {
      const providerStatus = error.statusCode;
      console.error(`Feedback email provider rejected the request (${error.name || 'unknown'}).`);
      feedbackSubmissions.delete(clientIp);
      const errorMessage = providerStatus === 401
        ? 'Email service rejected its API key. Check RESEND_API_KEY in Render.'
        : providerStatus === 403
          ? 'Email service denied this sender or recipient. Verify your sender domain and check Resend sending restrictions.'
          : providerStatus === 400 || providerStatus === 422
            ? 'Email service rejected the message configuration. Check FEEDBACK_FROM_EMAIL and the Resend sender requirements.'
            : providerStatus === 429
              ? 'Email service rate limit reached. Please try again later.'
              : 'Email service is temporarily unavailable. Please try again later.';
      return res.status(502).json({ error: errorMessage });
    }

    return res.status(200).json({ message: 'Thank you for your feedback.' });
  } catch (err) {
    console.error('Feedback email request failed:', err.message);
    feedbackSubmissions.delete(clientIp);
    return res.status(502).json({ error: 'Could not send feedback right now. Please try again later.' });
  }
});

const LEVEL_MAP = {
  0: 'Missing / Not Found (0 yrs)',
  1: 'Beginner / Incidental (1-2 yrs)',
  2: 'Intermediate (2-5 yrs)',
  3: 'Advanced (5-8 yrs)',
  4: 'Expert / Top Match (8+ yrs)'
};

function cleanAndParseJSON(rawContent) {
  try {
    const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    const match = rawContent.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (err) {}
    }
    return null;
  }
}

// 1. EVALUATE MATRIX (2-HOP ZERO-CONTAMINATION PIPELINE)
async function evaluateMatrix(resumeText, jdText) {
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  // --- HOP 1: Extract Skills Exclusively From JD (Zero Resume Context) ---
  const jdPrompt = `/no_think
Strict ATS Auditor. Output raw JSON only. No intro, no reasoning, no markdown fences.

Rules:
1. Extract 6 to 8 primary technical tools, languages, or protocols required in the Job Description.
2. Keep names atomic (e.g. "Go", "gRPC", "Kubernetes", "Raft", "Paxos", "etcd", "Prometheus").
3. Determine target_rank (1-4):
   - 1 = "familiarity with", "exposure to", or "nice-to-have" (1-2y)
   - 2 = "experience with", "working knowledge", or standard infrastructure tooling (2-5y)
   - 3 = "strong proficiency in", "deep expertise", or core primary language (5-8y)
   - 4 = "architect", "staff/principal", or "subject matter expert" (8+y)

Job Description:
${jdText.slice(0, 4000)}

Output must be this exact JSON structure:
{"skills":[{"skill":"Name","target_rank":2}]}`;

  const jdRes = await nebius.chat.completions.create({
    model: AUDITOR_MODEL,
    messages: [{ role: 'user', content: jdPrompt }],
    max_tokens: 300,
    temperature: 0.0,
    top_p: 0.01,
    seed: 42,
    extra_body: { chat_template_kwargs: { enable_thinking: false } }
  });

  usage.prompt_tokens += jdRes.usage?.prompt_tokens || 0;
  usage.completion_tokens += jdRes.usage?.completion_tokens || 0;
  usage.total_tokens += jdRes.usage?.total_tokens || 0;

  const parsedJd = cleanAndParseJSON(jdRes.choices[0]?.message?.content || '{}');
  const jdSkills = Array.isArray(parsedJd?.skills) ? parsedJd.skills : [];

  if (jdSkills.length === 0) {
    throw new Error("Failed to extract skills from Job Description.");
  }

  // --- HOP 2: Verify Resume Evidence Against the Fixed Skill List ---
  const skillListString = jdSkills.map(s => `"${s.skill}"`).join(', ');

  const auditPrompt = `/no_think
Strict ATS Fact Checker. Output raw JSON only. No intro, no reasoning, no markdown fences.

Task: Check the candidate's resume for these exact skills: [${skillListString}].

Strict Scoring Rules:
1. LITERAL ABSENCE RULE: If the exact tool name does NOT appear in the resume text, candidate_rank MUST BE 0. Never infer adjacent tools (e.g. REST is NOT gRPC; container monitoring is NOT Prometheus; database replication is NOT etcd/Raft).
2. If stated with multi-year career tenure in header/summary (e.g. "8+ years in Go"), candidate_rank = 4.
3. If actively used across work experience bullets, candidate_rank = 2.
4. If mentioned only once or as a side script, candidate_rank = 1.

Candidate Resume:
${resumeText.slice(0, 6000)}

Output must match this exact JSON structure:
{"audit":[{"skill":"Name","candidate_rank":0}]}`;

  const auditRes = await nebius.chat.completions.create({
    model: SCREENING_MODEL,
    messages: [{ role: 'user', content: auditPrompt }],
    max_tokens: 350,
    temperature: 0.0,
    top_p: 0.01,
    seed: 42,
    extra_body: { chat_template_kwargs: { enable_thinking: false } }
  });

  usage.prompt_tokens += auditRes.usage?.prompt_tokens || 0;
  usage.completion_tokens += auditRes.usage?.completion_tokens || 0;
  usage.total_tokens += auditRes.usage?.total_tokens || 0;

  const parsedAudit = cleanAndParseJSON(auditRes.choices[0]?.message?.content || '{}');
  const auditResults = Array.isArray(parsedAudit?.audit) ? parsedAudit.audit : [];
  const auditMap = new Map(auditResults.map(a => [a.skill?.toLowerCase().trim(), Number(a.candidate_rank) || 0]));

  // --- STEP 3: Pure Deterministic JavaScript Scoring ---
  let totalScore = 0;
  const skill_matrix = jdSkills.map(item => {
    const targetRank = Math.min(Math.max(Number(item.target_rank) || 2, 1), 4);
    const candidateRank = Math.min(Math.max(auditMap.get(item.skill?.toLowerCase().trim()) ?? 0, 0), 4);

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

  return {
    evaluation: {
      initial_score,
      skill_matrix,
      missing_keywords: skill_matrix.filter(s => s.status === 'missing').map(s => s.skill),
      deficit_skills: skill_matrix.filter(s => s.status === 'deficit').map(s => s.skill)
    },
    usage
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

  // 1 bullet per deficit skill (capped at 3; fallback to core strengths if 0 deficits)
  const targetSkills = deficitSkills.length > 0 
    ? deficitSkills.slice(0, 3) 
    : ['core systems background'];

  const prompt = `/no_think
Strict Career Tailor. Output raw JSON only. No thinking, no markdown fences.

Rules:
1. STRICT NEGATIVE BOUNDARY: Do NOT claim or write bullets for completely missing skills: [${missingKeywords.join(', ') || 'None'}].
2. TARGET SCOPE: Generate EXACTLY ONE bullet for each of these deficit skills: [${targetSkills.join(', ')}]. Total bullets must equal ${targetSkills.length}.
3. MANDATORY METRIC PLACEHOLDER RULE:
   - Every single bullet MUST include an actionable metric bracket placeholder for the user to customize.
   - Use clear, concrete placeholders like:
     * "[insert % latency reduction]"
     * "[insert throughput: e.g. Xk req/sec]"
     * "[insert % memory/resource drop]"
     * "[insert % time saved]"
     * "[insert scale: e.g. X server nodes]"
   - If the resume already has an explicit number, you may include it, but still pair it with a metric outcome.
   - NEVER output vague statements like "reducing coupling" or "improving efficiency" without a bracketed metric placeholder.
4. NATURAL EXECUTIVE PHRASING:
   - Follow Google XYZ intent (Action + Metric + Method), but DO NOT literally write the template words "Accomplished", "as measured by", or "by doing" in the bullet.
   - Keep each bullet under 35 words.

Candidate Resume:
${resumeSummary.slice(0, 3000)}

Return only one valid JSON object with exactly this structure:
{"suggested_headline":"...","tailored_bullets":["..."]}`;

  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let tailoring = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await nebius.chat.completions.create({
      model: TAILOR_MODEL,
      messages: [{
        role: 'user',
        content: attempt === 0
          ? prompt
          : `${prompt}\nYour previous output missed the metric placeholders. Return valid JSON with exactly ${targetSkills.length} bullets, each containing explicit placeholders like "[insert % latency reduction]".`
      }],
      max_tokens: 500,
      temperature: 0.1,
      top_p: 0.01,
      seed: 42,
      extra_body: { chat_template_kwargs: { enable_thinking: false } }
    });

    usage.prompt_tokens += response.usage?.prompt_tokens || 0;
    usage.completion_tokens += response.usage?.completion_tokens || 0;
    usage.total_tokens += response.usage?.total_tokens || 0;

    const parsed = cleanAndParseJSON(response.choices[0]?.message?.content || '{}');
    if (
      typeof parsed?.suggested_headline === 'string' &&
      parsed.suggested_headline.trim() &&
      Array.isArray(parsed?.tailored_bullets) &&
      parsed.tailored_bullets.length >= 1 &&
      parsed.tailored_bullets.every(b => typeof b === 'string' && b.trim())
    ) {
      tailoring = {
        suggested_headline: parsed.suggested_headline.trim(),
        tailored_bullets: parsed.tailored_bullets.slice(0, targetSkills.length).map(b => b.trim())
      };
      break;
    }
  }

  // Fallback ensuring clean bracket placeholders if parsing fails
  if (!tailoring) {
    tailoring = {
      suggested_headline: "Senior Software Engineer | Backend & Systems Infrastructure",
      tailored_bullets: targetSkills.map(skill => 
        `Optimized backend infrastructure using ${skill}, cutting service overhead by [insert % latency reduction] and maintaining zero regressions across [insert count of servers/nodes].`
      )
    };
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