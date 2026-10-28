document.addEventListener('DOMContentLoaded', () => {
  const resumeInput = document.getElementById('resumeText');
  const jdInput = document.getElementById('jdText');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const btnText = document.getElementById('btnText');
  const btnSpinner = document.getElementById('btnSpinner');
  const loadSampleBtn = document.getElementById('loadSampleBtn');
  const resultsWrapper = document.getElementById('resultsWrapper');
  const scoreDisplay = document.getElementById('scoreDisplay');
  const scoreBar = document.getElementById('scoreBar');
  const keywordsList = document.getElementById('keywordsList');
  const skillMatrixBody = document.getElementById('skillMatrixBody');
  const deficitSkillsList = document.getElementById('deficitSkillsList');
  const bulletsContainer = document.getElementById('bulletsContainer');
  let suggestedHeadline = document.getElementById('suggestedHeadline');
  const copyBulletsBtn = document.getElementById('copyBulletsBtn');
  const copyStatus = document.getElementById('copyStatus');
  const analysisError = document.getElementById('analysisError');
  const feedbackForm = document.getElementById('feedbackForm');
  const feedbackSubmit = document.getElementById('feedbackSubmit');
  const feedbackStatus = document.getElementById('feedbackStatus');

  // Pre-filled sample data for quick testing and recording demos
  const SAMPLE_RESUME = `Software Engineer with 8+ years building high-throughput systems in C++ and Go.
- Maintained core telecom and IPC infrastructure for low-latency call routing.
- Worked on database replication and container monitoring tools using REST APIs.
- Built an internal tool for analyzing Jira tickets using LLMs.
- Managed deployments and configuration using Consul and Vault.`;

  const SAMPLE_JD = `Senior Distributed Systems Engineer (Golang / Cloud)
Key Requirements:
- 5+ years designing distributed consensus and high-availability backends (Raft, Paxos, or etcd).
- Strong proficiency in Go, microservices architectures, and gRPC streaming.
- Experience with Kubernetes container orchestration, Prometheus telemetry, and zero-trust security.
- Demonstrated ability to optimize high-throughput distributed systems under strict SLA latency targets.`;

  loadSampleBtn.addEventListener('click', () => {
    resumeInput.value = SAMPLE_RESUME;
    jdInput.value = SAMPLE_JD;
  });

  feedbackForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    feedbackStatus.textContent = '';
    feedbackSubmit.disabled = true;
    feedbackSubmit.textContent = 'Sending...';

    try {
      const formData = new FormData(feedbackForm);
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(formData)),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `Server returned HTTP ${response.status}`);
      }

      feedbackStatus.textContent = data.message || 'Thank you for your feedback.';
      feedbackStatus.className = 'text-sm text-forest-700';
      feedbackForm.reset();
    } catch (err) {
      console.error('Feedback submission failed:', err);
      feedbackStatus.textContent = err instanceof Error ? err.message : 'Could not send feedback. Please try again later.';
      feedbackStatus.className = 'text-sm text-red-700';
    } finally {
      feedbackSubmit.disabled = false;
      feedbackSubmit.textContent = 'Send Feedback';
    }
  });

  analyzeBtn.addEventListener('click', async () => {
    const resumeText = resumeInput.value.trim();
    const jdText = jdInput.value.trim();

    if (!resumeText || !jdText) {
      alert('Please provide both the candidate resume and the target job description.');
      return;
    }

    analysisError?.classList.add('hidden');
    setLoading(true);

    try {
      const response = await fetch('/api/analyze-and-tailor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeText, jdText }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server returned HTTP ${response.status}`);
      }

      const data = await response.json();
      const tokenBox = document.getElementById('tokenTelemetry');
      const tokenBreakdown = document.getElementById('tokenBreakdown');
      const tokenTotalDisplay = document.getElementById('tokenTotalDisplay');

      if (data.tokens && tokenBox) {
        tokenBox.classList.remove('hidden');
        const matrixTotal = (data.tokens.matrix_prompt_tokens || 0) + (data.tokens.matrix_completion_tokens || 0);
        const tailorTotal = (data.tokens.tailor_prompt_tokens || 0) + (data.tokens.tailor_completion_tokens || 0);
        
        tokenBreakdown.textContent = `Matrix: ${matrixTotal} tokens | Tailoring: ${tailorTotal} tokens`;
        tokenTotalDisplay.textContent = `Total Tokens: ${data.tokens.total_tokens_used}`;
      } else if (tokenBox) {
        tokenBox.classList.add('hidden');
      }
      renderResults(data);
    } catch (err) {
      console.error('Analysis request failed:', err);
      if (analysisError) {
        analysisError.textContent = `Analysis failed: ${err instanceof Error ? err.message : 'Unexpected error'}`;
        analysisError.classList.remove('hidden');
      }
    } finally {
      setLoading(false);
    }
  });

  function setLoading(isLoading) {
    if (isLoading) {
      analyzeBtn.disabled = true;
      btnSpinner.classList.remove('hidden');
      btnText.textContent = 'Orchestrating Nemotron Agents...';
    } else {
      analyzeBtn.disabled = false;
      btnSpinner.classList.add('hidden');
      btnText.textContent = 'Run Multi-Agent Screening';
    }
  }

  function renderResults(data) {
    const evaluation = data.evaluation || {};
    const rawScore = Number(evaluation.initial_score);
    const initialScore = Number.isFinite(rawScore) ? Math.min(Math.max(rawScore, 0), 100) : 0;
    const missingKeywords = Array.isArray(evaluation.missing_keywords) ? evaluation.missing_keywords : [];
    const skillMatrix = Array.isArray(evaluation.skill_matrix)
      ? [...evaluation.skill_matrix].sort((a, b) => (Number(b.match_pct) || 0) - (Number(a.match_pct) || 0))
      : [];
    const deficitSkills = Array.isArray(evaluation.deficit_skills) ? evaluation.deficit_skills : [];
    const tailoring = data.tailoring || {};
    const optimizedBullets = Array.isArray(tailoring.tailored_bullets)
      ? tailoring.tailored_bullets
      : (Array.isArray(data.tailored_bullets) ? data.tailored_bullets : []);
    const hasTailoring = Boolean(tailoring.suggested_headline || optimizedBullets.length);

    // Animate Score Counter
    animateScore(initialScore);

    // Keywords
    keywordsList.innerHTML = '';
    missingKeywords.forEach((kw) => {
      const tag = document.createElement('span');
      tag.className = 'px-3 py-1 rounded-lg text-xs font-semibold bg-red-100 text-red-800 border border-red-200';
      tag.textContent = `+ ${kw}`;
      keywordsList.appendChild(tag);
    });

    if (skillMatrixBody) {
      skillMatrixBody.innerHTML = '';
    }
    if (skillMatrixBody && skillMatrix.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 4;
      cell.className = 'px-3 py-4 text-sm text-forest-600';
      cell.textContent = 'No skill-level evaluation was returned.';
      row.appendChild(cell);
      skillMatrixBody.appendChild(row);
    } else if (skillMatrixBody) {
      skillMatrix.forEach((item) => {
        const row = document.createElement('tr');
        [item.skill, item.candidate_level, item.target_level, item.match_pct == null ? '' : `${item.match_pct}%`]
          .forEach((value) => {
            const cell = document.createElement('td');
            cell.className = 'border-t border-sand-300 px-3 py-3 text-sm text-forest-900';
            cell.textContent = value == null ? '' : String(value);
            row.appendChild(cell);
          });
        skillMatrixBody.appendChild(row);
      });
    }

    if (deficitSkillsList) {
      deficitSkillsList.innerHTML = '';
    }
    if (deficitSkillsList && deficitSkills.length === 0) {
      const item = document.createElement('li');
      item.textContent = 'No experience-depth gaps returned.';
      deficitSkillsList.appendChild(item);
    } else if (deficitSkillsList) {
      deficitSkills.forEach((skill) => {
        const item = document.createElement('li');
        item.textContent = `More demonstrated experience needed: ${skill}`;
        deficitSkillsList.appendChild(item);
      });
    }

    if (!suggestedHeadline) {
      suggestedHeadline = document.createElement('p');
      suggestedHeadline.className = 'mb-4 text-sm font-semibold text-forest-800';
      bulletsContainer.parentNode.insertBefore(suggestedHeadline, bulletsContainer);
    }
    suggestedHeadline.textContent = tailoring.suggested_headline || '';
    suggestedHeadline.classList.toggle('hidden', !tailoring.suggested_headline);

    bulletsContainer.innerHTML = '';
    if (optimizedBullets.length === 0) {
      const emptyState = document.createElement('p');
      emptyState.className = 'text-sm text-forest-600';
      emptyState.textContent = hasTailoring
        ? 'No tailored bullets were returned.'
        : 'Tailoring was not returned. Please rerun the analysis; if it persists, update or restart the backend.';
      bulletsContainer.appendChild(emptyState);
    } else {
      optimizedBullets.forEach((bullet) => {
        const box = document.createElement('div');
        box.className = 'p-3.5 rounded-xl bg-white border border-sand-300 text-sm text-forest-900 leading-relaxed flex items-start gap-2.5';
        const check = document.createElement('span');
        check.className = 'text-forest-700 font-bold';
        check.textContent = '✓';
        const text = document.createElement('span');
        text.textContent = bullet;
        box.append(check, text);
        bulletsContainer.appendChild(box);
      });
    }

    copyBulletsBtn.disabled = optimizedBullets.length === 0;
    copyBulletsBtn.classList.toggle('opacity-50', optimizedBullets.length === 0);
    if (copyStatus) {
      copyStatus.textContent = '';
    }

    resultsWrapper.classList.remove('hidden');
    resultsWrapper.scrollIntoView({ behavior: 'smooth' });
  }

  function animateScore(target) {
    let current = 0;
    scoreBar.style.width = '0%';
    const interval = setInterval(() => {
      current = Math.min(current + 2, target);
      scoreDisplay.textContent = current;
      scoreBar.style.width = `${current}%`;
      if (current >= target) {
        clearInterval(interval);
      }
    }, 20);
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Continue with the fallback for browsers that reject clipboard permissions.
      }
    }

    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.select();
    let copied;
    try {
      copied = document.execCommand('copy');
    } finally {
      textArea.remove();
    }
    if (!copied) {
      throw new Error('Clipboard access is unavailable. Use HTTPS or copy the text manually.');
    }
  }

  copyBulletsBtn.addEventListener('click', async () => {
    const text = Array.from(bulletsContainer.children)
      .map((box) => box.querySelector('span:last-child')?.textContent)
      .filter(Boolean)
      .map((bullet) => `• ${bullet}`)
      .join('\n');

    if (!text) {
      if (copyStatus) {
        copyStatus.textContent = 'There are no optimized bullets to copy.';
      }
      return;
    }

    try {
      await copyText(text);
      if (copyStatus) {
        copyStatus.textContent = 'Copied to clipboard.';
      }
    } catch (err) {
      console.error('Clipboard copy failed:', err);
      if (copyStatus) {
        copyStatus.textContent = err instanceof Error ? err.message : 'Could not copy the bullets.';
      }
    }
  });
});