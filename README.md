# AI Job Hunter & Daily Digest 🕵️‍♂️💼

An autonomous, AI-powered job scraping agent. It reads your resume, dynamically generates targeted web searches, scrapes live job listings using a headless browser, evaluates each role against your profile using an LLM of your choice, and emails you a ranked daily digest of top matches.

## Features
- **Dynamic Search Generation:** AI analyzes your resume and search instructions to generate targeted search queries automatically.
- **Provider-Agnostic LLM Integration:** Works seamlessly with OpenRouter, DeepSeek, OpenAI, Groq, or any OpenAI-compatible API endpoint.
- **Headless Scraping:** Uses Playwright to render JavaScript and bypass complex job board architectures.
- **Smart Filtering:** Evaluates raw job page content against your CV and outputs structured JSON ratings.
- **Deduplication:** SQLite database prevents duplicate job notifications across runs.
- **Error Resilient:** Catches page-level timeouts gracefully and dispatches alert emails upon critical system failures.
- **100% Free Automation:** Built to run automatically using GitHub Actions and free/low-cost API tiers.

---

## 🛠️ Local Setup Instructions

### 1. Clone & Set Up Virtual Environment
Open your terminal and execute:
```bash
# Clone the repository
git clone [https://github.com/yourusername/ai-job-hunter.git](https://github.com/yourusername/ai-job-hunter.git)
cd ai-job-hunter

# Create a virtual environment
python -m venv venv

# Activate the virtual environment
# On Windows:
venv\Scripts\activate
# On Mac/Linux:
source venv/bin/activate

```

### 2. Install Dependencies

Install the required packages and Playwright's headless browser binaries:

```bash
# Install Python requirements
python -m pip install --upgrade pip
pip install -r requirements.txt

# Install Chromium browser binary
python -m playwright install chromium

```

### 3. Configure Environment Variables

Create a file named `.env` in the root directory. Configure your email settings and select your preferred LLM provider below:

```text
# ==========================================
# LLM PROVIDER CONFIGURATION (Select One)
# ==========================================

# --- Option A: OpenRouter (Default Free Options) ---
LLM_BASE_URL="[https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)"
LLM_API_KEY="sk-or-v1-your-openrouter-key"
LLM_MODEL="google/gemini-1.5-flash:free"

# --- Option B: DeepSeek ---
# LLM_BASE_URL="[https://api.deepseek.com](https://api.deepseek.com)"
# LLM_API_KEY="sk-your-deepseek-key"
# LLM_MODEL="deepseek-chat"

# --- Option C: OpenAI Direct ---
# LLM_BASE_URL="[https://api.openai.com/v1](https://api.openai.com/v1)"
# LLM_API_KEY="sk-proj-your-openai-key"
# LLM_MODEL="gpt-4o-mini"

# --- Option D: Any Custom OpenAI-Compatible Provider ---
# LLM_BASE_URL="https://your-custom-endpoint/v1"
# LLM_API_KEY="your-api-key"
# LLM_MODEL="your-model-name"

# ==========================================
# EMAIL & SCRAPER CONFIGURATION
# ==========================================
GMAIL_SENDER="your_email@gmail.com"
GMAIL_APP_PASSWORD="your_16_char_app_password"
TARGET_EMAIL="person1@gmail.com, person2@gmail.com"  # comma-separated list — one or many

# Where the dedup history (SQLite) lives. Each value = a separate history,
# e.g. seen_jobs_fin.db for finance searches, seen_jobs_tech.db for tech.
DB_PATH="seen_jobs.db"
MAX_RESULTS_PER_QUERY=10
MAX_SCRAPE_LENGTH=6000
PLAYWRIGHT_TIMEOUT_MS=20000
LLM_TEMPERATURE=0.0

```

### 4. Provide Resume & Instructions

The script employs a hybrid context loader. For local development:

1. Create a directory named `context/` in the root folder.
2. Create `context/resume.md` (or `.txt`) containing your full resume.
3. Create `context/instructions.txt` specifying your search parameters (e.g., target roles, acceptable locations, experience caps).

*(Note: The `context/` directory and `.env` file are pre-configured in `.gitignore` to protect sensitive personal data).*

### 5. Execute Locally

Run the script manually:

```bash
python run_job_digest.py

```

---

## ☁️ GitHub Actions Deployment

Run this workflow automatically on a daily schedule in the cloud.

### 1. Repository Privacy & Context Handling

* **If your repository is PRIVATE:** You can commit `context/resume.md` and `context/instructions.txt` directly. Simply remove `context/` from your `.gitignore` file before committing.
* **If your repository is PUBLIC:** Keep `context/` in `.gitignore`. Instead, pass your context via GitHub Secrets (`RESUME_TEXT` and `INSTRUCTIONS_TEXT`).

### 2. Configure GitHub Secrets & Variables

In your GitHub Repository, go to **Settings ➡️ Secrets and variables ➡️ Actions**.

#### Secrets (`Repository secrets`)

Add the following required credentials:

* `LLM_API_KEY`: Your API key (from OpenRouter, DeepSeek, OpenAI, etc.).
* `GMAIL_SENDER`: The dispatching Gmail address.
* `GMAIL_APP_PASSWORD`: Your 16-character Google App Password.
* `TARGET_EMAIL`: The destination address(es) for the daily digest. Comma-separate multiple recipients, e.g. `person1@gmail.com, person2@gmail.com`.
* `RESUME_TEXT`: *(Optional if using public repo)* Plain text version of your resume.
* `INSTRUCTIONS_TEXT`: *(Optional if using public repo)* Search parameters and constraints.
* `TARGET_EMAIL_TECH`: *(Optional)* Recipients for the **Tech** digest. Same comma-separated format as `TARGET_EMAIL`.
* `RESUME_TEXT_TECH`: *(Optional)* Resume used by the **Tech** workflow.
* `INSTRUCTIONS_TEXT_TECH`: *(Optional)* Search parameters for the **Tech** workflow.
* `TARGET_EMAIL_FIN`: *(Optional)* Recipients for the **Finance** digest. Same comma-separated format as `TARGET_EMAIL`.
* `RESUME_TEXT_FIN`: *(Optional)* Resume used by the **Finance** workflow.
* `INSTRUCTIONS_TEXT_FIN`: *(Optional)* Search parameters for the **Finance** workflow.

#### Environment Variables (`Repository variables`)

Go to the **Variables** tab under **Actions** and configure your provider parameters:

* `LLM_BASE_URL`: e.g., `https://openrouter.ai/api/v1` or `https://api.deepseek.com`
* `LLM_MODEL`: e.g., `google/gemini-1.5-flash:free` or `deepseek-chat`
* `DB_PATH`: *(Optional)* The SQLite file to cache (e.g., `seen_jobs.db`). Each value gets its own cache lineage, so you can keep separate "seen" histories per search domain. If unset, the workflow defaults to `seen_jobs.db`.
* `DB_PATH_TECH`: *(Optional)* Same as `DB_PATH`, but for the **Tech** workflow. Defaults to `seen_jobs_tech.db`.
* `DB_PATH_FIN`: *(Optional)* Same as `DB_PATH`, but for the **Finance** workflow. Defaults to `seen_jobs_fin.db`.

### 3. Execution

Three workflows live in `.github/workflows/`, one per search scope — each with its own DB, cache, recipients, resume, and instructions:

* **Daily Dynamic Job Digest - General** (`daily_digest.yml`) — uses the base `DB_PATH`, `TARGET_EMAIL`, `RESUME_TEXT`, `INSTRUCTIONS_TEXT`.
* **Daily Dynamic Job Digest - Tech** (`tech_digest.yml`) — uses `DB_PATH_TECH`, `TARGET_EMAIL_TECH`, `RESUME_TEXT_TECH`, `INSTRUCTIONS_TEXT_TECH`.
* **Daily Dynamic Job Digest - Finance** (`fin_digest.yml`) — uses `DB_PATH_FIN`, `TARGET_EMAIL_FIN`, `RESUME_TEXT_FIN`, `INSTRUCTIONS_TEXT_FIN`.

Each workflow will:

* Execute automatically via CRON on a daily schedule, staggered 2 hours apart: General at `00:00 UTC`, Tech at `02:00 UTC`, Finance at `04:00 UTC`.
* Support manual execution via the **Actions** tab by selecting the workflow ➡️ **Run workflow**.
* **Tech & Finance fail fast if unconfigured**: if any scope-specific variable (`TARGET_EMAIL_*`, `RESUME_TEXT_*`, `INSTRUCTIONS_TEXT_*`) is missing, the workflow exits with an error before scraping — emailed to `GMAIL_SENDER` via the crash-email path — so it never runs half-configured and never touches another scope's DB.
* Retain state across runs using `actions/cache` on its `DB_PATH` file to prevent duplicate postings. The cache key is derived from `DB_PATH` plus a per-run id, so each run restores the latest history and writes the updated one back.
* To verify the cache loaded: in the run logs, the "Cache SQLite Database" step shows `Cache restored from key: ...` on a hit (or `Cache not found` on a miss), and the scraper logs `📦 Opening database: ...` with the number of URLs already processed.
