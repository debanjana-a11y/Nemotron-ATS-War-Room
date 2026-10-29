# ATS Auditor & Surgical Tailor (Powered by NVIDIA Nemotron-3 on Nebius)
Live: https://nemotron-ats-war-room.onrender.com/

A deterministic ATS screener and automated career strategist built to bridge the gap between candidate resumes and modern engineering job descriptions.

Most AI resume tailors suffer from two major flaws: they hallucinate fake work history to "beat" an ATS, or they confuse a lack of seniority with completely missing skills. This project decouples technical auditing from narrative tailoring. It uses **NVIDIA Nemotron-3-Nano-30B-A3B** hosted on **Nebius Token Factory** to score technical gaps with mathematical precision and generate grounded Google XYZ-formula bullets.

---

## What It Does

1. **Two-Stage Technical Auditing (`/api/analyze-and-tailor`)**
* **Stage 1 (Deterministic Extraction):** Extracts the top 5 mission-critical tools/technologies mandated by the JD. It audits the candidate's career across all roles to distinguish between:
* **Missing Keywords:** Skills entirely absent from the resume (Rank 0 / 0%).
* **Deficit Skills:** Skills the candidate possesses, but where their tenure or depth falls short of the JD's target seniority.


* **Stage 2 (Surgical Tailoring):** Takes the verified gap profile and creates:
* A targeted headline positioning the engineer for the target role without inventing fake titles.
* 2 accomplishment bullets using Google's XYZ formula (`"Accomplished [X] as measured by [Y] by doing [Z]"`), strictly bridging adjacent technical foundations without fabricating experience.




2. **Accurate Token & Cost Telemetry**
* Tracks prompt tokens, completion tokens, and overall inference overhead per evaluation step.



---

## How It Uses NVIDIA Models & Nebius Cloud

* **Model: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B**`
* We needed an LLM that respects strict JSON schemas, adheres to zero-temperature deterministic auditing rules, and doesn't inject unsolicited prose or markdown fences. Nemotron-3's instruction tuning handles complex ranking scales ($0$ to $4$) and structural constraints reliably without falling into JSON parsing errors.


* **Inference: Nebius Token Factory**
* All model calls run against `[https://api.tokenfactory.nebius.com/v1/](https://api.tokenfactory.nebius.com/v1/)`. Nebius Token Factory provided near-instant TTFT (Time-To-First-Token) and stable high-concurrency inference, allowing our multi-step pipeline (Matrix Extraction $\to$ Tailoring) to complete in seconds with low latency.



---

## Tech Stack

* **Runtime:** Node.js (ES Modules)
* **Framework:** Express.js
* **LLM Client:** OpenAI SDK (configured for Nebius Token Factory)
* **Model:** `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`
* **Environment:** dotenv, cors

---

## Getting Started

### Prerequisites

* Node.js (v18.0.0 or higher recommended)
* A Nebius Token Factory API Key with access to NVIDIA models

### Installation

1. **Clone the repository:**
```bash
git clone https://github.com/your-username/ats-auditor-nemotron.git
cd ats-auditor-nemotron

```


2. **Install dependencies:**
```bash
npm install

```


3. **Configure Environment Variables:**
Create a `.env` file in the root directory:
```env
PORT=3000
NEBIUS_API_KEY=your_nebius_token_factory_key_here

```


4. **Start the server:**
```bash
# Development mode
node server.js

```

The server will start on `http://localhost:3000`.

### Feedback email (Resend)

The feedback form sends mail through the Resend HTTPS API, avoiding SMTP connectivity requirements. Set these server-side environment variables:

```env
RESEND_API_KEY=your_resend_api_key
FEEDBACK_TO_EMAIL=your-inbox@gmail.com
FEEDBACK_FROM_EMAIL=Your App <onboarding@resend.dev>
```

Configure these values in your local `.env` and your host's server-side environment settings. The recipient can be a Gmail inbox. Resend may require a verified sender domain before sending to recipients beyond its testing restrictions. Keep the API key private; never put it in frontend code or commit it.

---

## API Usage

### `POST /api/analyze-and-tailor`

#### Request Body

```json
{
  "resumeText": "Experienced backend engineer with 6+ years in C++, Go, Docker, Consul, and Vault...",
  "jdText": "Looking for a Senior Distributed Systems Engineer with production experience in Go, C++, Kubernetes, Kafka, and etcd..."
}

```

#### Sample Response

```json
{
  "evaluation": {
    "initial_score": 27,
    "missing_keywords": ["etcd", "Kubernetes", "Apache Kafka"],
    "deficit_skills": ["Go", "C++"],
    "skill_matrix": [
      {
        "skill": "Go",
        "candidate_level": "Intermediate (2-5 yrs)",
        "target_level": "Advanced (5-8 yrs)",
        "match_pct": 67,
        "status": "deficit"
      },
      {
        "skill": "etcd",
        "candidate_level": "Missing / Not Found (0 yrs)",
        "target_level": "Advanced (5-8 yrs)",
        "match_pct": 0,
        "status": "missing"
      }
    ]
  },
  "tailoring": {
    "suggested_headline": "Backend Engineer Specializing in Distributed Systems and Cloud Infrastructure",
    "tailored_bullets": [
      "Accomplished increased container health monitoring coverage by 35% as measured by a 20% reduction in incident tickets by building Go-based health-check tools that integrated with Consul and Vault.",
      "Accomplished reduced secret retrieval latency by 30% as measured by a 25% improvement in API response times by designing a Go microservice that orchestrated Vault and Consul configurations."
    ]
  },
  "tokens": {
    "matrix_prompt_tokens": 901,
    "matrix_completion_tokens": 2824,
    "tailor_prompt_tokens": 396,
    "tailor_completion_tokens": 974,
    "total_tokens_used": 5095
  }
}

```

---

## Architecture & Logic Flow

```
[Job Description] 
       │
       ▼ (Hop 1: Prompt-Engineered JD Extraction)
[nvidia/Nemotron-3_5-Lightning] ────► Atomic Requirements Array
                                             │
[Candidate Resume] ──────────────────────────┼───────────────┐
       │                                     │               │
       ▼ (Hop 2: Prompt-Engineered Fact Audit)               │
[nvidia/Nemotron-3_5-Lightning]                              │
       │                                                     │
       ▼ Raw Evidence Ranks (0-4)                            │
[Pure JavaScript Math Engine] ◄──────────────────────────────┘
       │ (100% Deterministic: Gap Sorting & Weighted Arithmetic)
       ├────────────────────────┬────────────────────────────┐
       ▼                        ▼                            ▼
[Match Score %]       [Missing Skills: 0%]         [Deficit Skills: >0%]
                                                             │
                                                             ▼ (Hop 3: Constrained Synthesis)
                                                [nvidia/Nemotron-3-Ultra-550b-a55b]
                                                             │
                                                             ▼
                                                [Truthful XYZ Metric Bullets]

```

---

## Honest Feedback: Nebius Token Factory & NVIDIA Nemotron

Building this workflow provided clear insights into where the developer experience shines and where it can evolve:

### What Worked Really Well

* **Nebius Token Factory DX:** The drop-in OpenAI SDK compatibility made setup take literally less than 3 minutes. No custom client libraries or specialized adapters required.
* **Throughput & Latency:** For multi-step chains where step 2 depends on step 1 output, low latency is critical. Nebius served responses from Nemotron-3 remarkably fast with zero rate-limit hiccups during iterative testing.
* **Nemotron-3-Nano Adherence:** Small/medium models often struggle with multi-tier strict JSON requirements and hallucinate text outside brackets. At `temperature: 0.0`, Nemotron-3-Nano was consistent at returning parseable JSON structures without markdown noise.

### Areas for Improvement & Observations

* **Multi-Role Tenure Aggregation:** Like many smaller parameter models, Nemotron-3 sometimes defaults to scoring only the most recent role's date bracket for repeated technologies (e.g., C++ used across multiple consecutive jobs) unless prompted explicitly with multi-role math instructions.
* **Documentation & Metrics:** Nebius Token Factory's dashboard could benefit from deeper real-time observability, such as visual latency percentiles (p50/p99) alongside token counts directly in the web console.

---

## License

This project is open-source and available under the [MIT License](https://www.google.com/search?q=LICENSE).
