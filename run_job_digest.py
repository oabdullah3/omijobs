import os
import json
import random
import sqlite3
import smtplib
import time
import traceback
import warnings
from datetime import datetime
from urllib.parse import urlparse, urljoin
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

warnings.filterwarnings("ignore", module="duckduckgo_search") 
from ddgs import DDGS
from playwright.sync_api import sync_playwright
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv() 

# ==========================================
# CONFIGURATION (Environment Driven)
# ==========================================
DB_PATH = os.environ.get("DB_PATH", "seen_jobs.db")
MAX_RESULTS_PER_QUERY = int(os.environ.get("MAX_RESULTS_PER_QUERY", 8))
MAX_SCRAPE_LENGTH = int(os.environ.get("MAX_SCRAPE_LENGTH", 8000))
PLAYWRIGHT_TIMEOUT_MS = int(os.environ.get("PLAYWRIGHT_TIMEOUT_MS", 20000))

LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://openrouter.ai/api/v1")
LLM_API_KEY = os.environ.get("LLM_API_KEY")
LLM_MODEL = os.environ.get("LLM_MODEL", "google/gemini-1.5-flash:free")
LLM_TEMPERATURE = float(os.environ.get("LLM_TEMPERATURE", 0.0))

client = OpenAI(
    base_url=LLM_BASE_URL,
    api_key=LLM_API_KEY,
    max_retries=2,    
    timeout=30.0,     
)

run_errors = []
STEALTH_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

# ==========================================
# ERROR MAILER
# ==========================================
def send_crash_email(error_traceback):
    sender = os.environ.get("GMAIL_SENDER")
    password = os.environ.get("GMAIL_APP_PASSWORD")
    
    if not sender or not password:
        print("❌ Cannot send crash email: Missing credentials.")
        return

    msg = MIMEMultipart()
    msg['From'] = sender
    msg['To'] = sender 
    msg['Subject'] = "🚨 AI Job Hunter: Critical Workflow Failure"
    
    body = f"Your daily AI job scraper encountered a fatal error and stopped running.\n\nDetails:\n{error_traceback}"
    msg.attach(MIMEText(body, 'plain'))
    
    try:
        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
            server.login(sender, password)
            server.send_message(msg)
        print("📧 Crash email sent successfully.")
    except Exception as e:
        print(f"❌ Failed to send crash email: {e}")

# ==========================================
# CONTEXT LOADING
# ==========================================
def get_context():
    print("📂 Loading context (Resume & Instructions)...")
    cv_path_md = os.path.join("context", "resume.md")
    cv_path_txt = os.path.join("context", "resume.txt")
    if os.path.exists(cv_path_txt):
        with open(cv_path_txt, "r", encoding="utf-8") as f:
            cv_text = f.read()
        print("  -> Loaded resume from local file (resume.txt).")
    elif os.path.exists(cv_path_md):
        with open(cv_path_md, "r", encoding="utf-8") as f:
            cv_text = f.read()
        print("  -> Loaded resume from local file (resume.md).")
    else:
        cv_text = os.environ.get("RESUME_TEXT", "No resume provided.")
        print("  -> Loaded resume from environment variables.")

    instructions_path = os.path.join("context", "instructions.txt")
    if os.path.exists(instructions_path):
        with open(instructions_path, "r", encoding="utf-8") as f:
            instructions = f.read()
        print("  -> Loaded instructions from local file.")
    else:
        instructions = os.environ.get("INSTRUCTIONS_TEXT", "Find jobs matching this resume.")
        print("  -> Loaded instructions from environment variables.")

    return cv_text, instructions

# ==========================================
# DATABASE & AGENT MEMORY
# ==========================================
def setup_db():
    print(f"📦 Opening database: {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS processed_urls (
            url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    c.execute("SELECT COUNT(*) FROM processed_urls")
    processed_count = c.fetchone()[0]
    print(f"  -> {processed_count} URLs already processed (restored from cache if a hit)")
    conn.commit()
    return conn

def get_learning_context(conn):
    cursor = conn.cursor()
    cursor.execute("SELECT url, status FROM processed_urls")
    rows = cursor.fetchall()
    
    if not rows:
        return "No historical memory yet. Explore broadly."
        
    domain_stats = {}
    for url, status in rows:
        domain = urlparse(url).netloc.lower()
        if domain.startswith("www."):
            domain = domain[4:]
        if domain not in domain_stats:
            domain_stats[domain] = {"success": 0, "fail": 0}
        if status == "RECOMMENDED":
            domain_stats[domain]["success"] += 1
        else:
            domain_stats[domain]["fail"] += 1

    successful_domains = sorted(
        [d for d, s in domain_stats.items() if s["success"] > 0],
        key=lambda x: domain_stats[x]["success"], reverse=True
    )
    
    failed_domains = sorted(
        [d for d, s in domain_stats.items() if s["success"] == 0 and s["fail"] >= 2],
        key=lambda x: domain_stats[x]["fail"], reverse=True
    )

    context = "HISTORICAL AGENT MEMORY:\n"
    if successful_domains:
        context += f"- High-Yield Domains: {', '.join(successful_domains[:10])}\n"
    if failed_domains:
        context += f"- Low-Yield / Blocked Domains to Avoid: {', '.join(failed_domains[:15])}\n"
        
    return context

# ==========================================
# AI QUERY GENERATION
# ==========================================
def generate_search_queries(cv_text, instructions, memory_context):
    current_year = datetime.now().year
    
    print("🧠 Asking AI to generate adaptive search queries...")
    prompt = f"""
    You are an autonomous AI job-hunting agent. Generate AT LEAST 12 targeted search engine queries 
    to find direct, active job postings in Hong Kong based on the user's profile and current date.
    
    CURRENT YEAR: {current_year}
    USER RESUME: {cv_text}
    USER INSTRUCTIONS: {instructions}
    {memory_context}
    
    RULES:
    1. Target active opportunities for {current_year} or upcoming hiring cycles.
    2. Leverage high-yield domain patterns from memory where applicable.
    3. Keep queries natural and focused on target roles and locations.
    
    Respond STRICTLY with raw JSON: {{"queries": ["query 1", "query 2"]}}
    """
    try:
        response = client.chat.completions.create(
            model=LLM_MODEL, 
            messages=[{"role": "user", "content": prompt}],
            temperature=LLM_TEMPERATURE
        )
        clean_json = response.choices[0].message.content.replace("```json", "").replace("```", "").strip()
        data = json.loads(clean_json)
        return data.get("queries", ["Finance jobs Hong Kong"])
    except Exception as e:
        print(f"❌ Query generation failed: {e}")
        return ["Finance intern Hong Kong", "Quantitative Risk intern Hong Kong"]

def get_new_job_urls(conn, queries):
    urls = set() 
    cursor = conn.cursor()
    print("\n🌐 Starting web search...")
    
    for q in queries:
        print(f"  🔍 Searching DuckDuckGo for: {q}")
        for attempt in range(3):
            try:
                results = DDGS().text(q, max_results=MAX_RESULTS_PER_QUERY)
                if results:
                    for res in results:
                        url = res.get('href', '')
                        if url:
                            cursor.execute("SELECT 1 FROM processed_urls WHERE url=?", (url,))
                            if not cursor.fetchone():
                                urls.add(url)
                break
            except Exception as e:
                wait = (attempt + 1) * 5
                print(f"  ⚠️ Search attempt {attempt + 1}/3 failed for '{q}': {e}")
                if attempt < 2:
                    print(f"     Retrying in {wait}s...")
                    time.sleep(wait)
                else:
                    print(f"  ❌ All retries exhausted for '{q}'")
        time.sleep(random.uniform(1.0, 2.0))
            
    print(f"✅ Total initial URLs found: {len(urls)}")
    return list(urls)

# ==========================================
# DYNAMIC SCRAPER (Extracts Page Text & DOM Links)
# ==========================================
def scrape_page(url):
    """
    Extracts text and DOM hyperlinks without any hardcoded filtering.
    """
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent=STEALTH_USER_AGENT,
                viewport={'width': 1920, 'height': 1080},
                extra_http_headers={'Accept-Language': 'en-US,en;q=0.9'}
            )
            page = context.new_page()
            page.goto(url, timeout=PLAYWRIGHT_TIMEOUT_MS, wait_until="domcontentloaded")
            
            text = page.locator("body").inner_text()[:MAX_SCRAPE_LENGTH]
            
            # Extract distinct hyperlinks from the page DOM for LLM inspection
            extracted_links = []
            links = page.locator("a").all()
            for link in links[:50]:
                try:
                    anchor_text = link.inner_text().strip()
                    href = link.get_attribute("href")
                    if href and anchor_text:
                        full_url = urljoin(url, href)
                        if full_url != url:
                            extracted_links.append({"text": anchor_text[:60], "url": full_url})
                except Exception:
                    continue
                    
            browser.close()
            return text, extracted_links
    except Exception as e:
        print(f"  ⚠️ Scraping failed for {url}: {e}")
        return "", []

# ==========================================
# PURE LLM EVALUATION & LINK SELECTION
# ==========================================
def evaluate_job(text, url, links, cv_text, instructions):
    prompt = f"""
    You are an expert recruiter evaluating a web page for an entry-level candidate.
    
    USER INSTRUCTIONS: {instructions}
    USER RESUME: {cv_text}
    CURRENT PAGE URL: {url}
    CURRENT PAGE TEXT: {text}
    EXTRACTED HYPERLINKS ON PAGE: {json.dumps(links[:30])}
    
    TASKS:
    1. Determine if CURRENT PAGE TEXT describes an ACTIVE, SPECIFIC, SINGLE job posting or graduate program matching the user's instructions.
    2. REJECT if the page is expired, closed, Cloudflare blocked, a general blog, or an educational program prospectus.
    3. If CURRENT PAGE is a search list or board, inspect the EXTRACTED HYPERLINKS array. Pick up to 3 specific sub-URLs that point to individual direct job postings matching the user's target criteria.
    
    Respond STRICTLY with raw JSON:
    {{
        "is_valid_job": true/false,
        "company": "Company Name",
        "title": "Job Title",
        "score": integer 0-100,
        "reason": "1-sentence reason",
        "child_urls_to_visit": ["sub_url_1", "sub_url_2"]
    }}
    """
    try:
        response = client.chat.completions.create(
            model=LLM_MODEL, 
            messages=[{"role": "user", "content": prompt}],
            temperature=LLM_TEMPERATURE
        )
        clean_json = response.choices[0].message.content.replace("```json", "").replace("```", "").strip()
        return json.loads(clean_json)
    except Exception as e:
        print(f"  ❌ LLM evaluation failed for {url}: {e}")
        return None

# ==========================================
# EMAIL DIGEST MAILER
# ==========================================
def send_digest_email(jobs_data):
    sender = os.environ.get("GMAIL_SENDER")
    password = os.environ.get("GMAIL_APP_PASSWORD")
    target_raw = os.environ.get("TARGET_EMAIL", "")
    recipients = [t.strip() for t in target_raw.split(",") if t.strip()]

    if not jobs_data:
        print("\n📭 No new valid job matches to send today.")
        return

    if not recipients:
        print("❌ No recipients configured (TARGET_EMAIL is empty).")
        return

    print(f"\n📧 Sending email digest for {len(jobs_data)} direct job matches to {len(recipients)} recipient(s)...")
    msg = MIMEMultipart()
    msg['From'] = sender
    msg['To'] = ", ".join(recipients)
    msg['Subject'] = f"🎯 Daily Job Digest: {len(jobs_data)} New Direct Match{'es' if len(jobs_data) > 1 else ''}"

    jobs_html = ""
    for job in jobs_data:
        score = job.get('score', 0)
        badge_bg = "#dcfce7" if score >= 80 else "#fef9c3"
        badge_color = "#166534" if score >= 80 else "#854d0e"

        jobs_html += f"""
        <div style="background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 16px;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                <div style="font-size: 18px; font-weight: 700; color: #111827;">
                    {job.get('title', 'Unknown Title')}
                </div>
                <span style="background-color: {badge_bg}; color: {badge_color}; font-size: 13px; font-weight: 600; padding: 4px 10px; border-radius: 12px;">
                    {score}/100 Match
                </span>
            </div>
            <div style="font-size: 14px; font-weight: 600; color: #4b5563; margin-bottom: 12px;">
                🏢 {job.get('company', 'Unknown Company')}
            </div>
            <p style="font-size: 14px; color: #374151; margin: 0 0 16px 0; background-color: #f9fafb; padding: 10px; border-left: 3px solid #3b82f6;">
                <strong>Why it matches:</strong> {job.get('reason', 'Matches criteria.')}
            </p>
            <a href="{job['url']}" target="_blank" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 600; padding: 8px 18px; border-radius: 6px;">
                Apply Directly →
            </a>
        </div>
        """

    email_template = f"""
    <!DOCTYPE html>
    <html>
    <body style="font-family: sans-serif; background-color: #f3f4f6; padding: 24px;">
        <div style="max-width: 600px; margin: 0 auto;">
            <div style="background-color: #1e293b; color: #ffffff; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
                <h1 style="margin: 0; font-size: 20px;">🎯 Daily AI Job Digest</h1>
                <p style="margin: 4px 0 0 0; font-size: 13px; color: #94a3b8;">Direct application links verified</p>
            </div>
            <div style="background-color: #f8fafc; padding: 20px; border-radius: 0 0 8px 8px; border: 1px solid #cbd5e1;">
                {jobs_html}
            </div>
        </div>
    </body>
    </html>
    """

    msg.attach(MIMEText(email_template, 'html'))

    try:
        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
            server.login(sender, password)
            server.send_message(msg)
        print("✅ Digest email sent successfully!")
    except Exception as e:
        print(f"❌ Failed to send email: {e}")

# ==========================================
# MAIN EXECUTION PIPELINE
# ==========================================
if __name__ == "__main__":
    try:
        print("🚀 Starting AI Job Hunter...\n")
        cv_text, instructions = get_context()
        
        conn = setup_db()
        memory_context = get_learning_context(conn)
        dynamic_queries = generate_search_queries(cv_text, instructions, memory_context)
        
        url_queue = get_new_job_urls(conn, dynamic_queries)
        valid_jobs = []
        processed_set = set()

        print("\n⚙️ Processing Found URLs...")
        
        while url_queue:
            url = url_queue.pop(0)
            if url in processed_set:
                continue
            processed_set.add(url)

            cursor = conn.cursor()
            cursor.execute("SELECT 1 FROM processed_urls WHERE url=?", (url,))
            if cursor.fetchone():
                continue

            print(f"\nProcessing: {url}")
            time.sleep(random.uniform(1.0, 2.0))
            page_text, extracted_links = scrape_page(url)

            if page_text:
                analysis = evaluate_job(page_text, url, extracted_links, cv_text, instructions)
                
                # Check if LLM dynamically selected relevant sub-links from list page
                child_urls = analysis.get("child_urls_to_visit", []) if analysis else []
                if child_urls:
                    print(f"  🔗 AI dynamically selected {len(child_urls)} sub-link(s) to queue.")
                    for child_url in child_urls:
                        if child_url not in processed_set:
                            url_queue.append(child_url)

                is_valid = analysis.get("is_valid_job", False) if analysis else False
                score = analysis.get("score", 0) if analysis else 0
                
                if analysis and is_valid and score >= 60:
                    print(f"  ✅ DIRECT MATCH: {analysis.get('company')} - {analysis.get('title')} (Score: {score}/100)")
                    analysis['url'] = url
                    valid_jobs.append(analysis)
                    
                    conn.cursor().execute("INSERT OR REPLACE INTO processed_urls (url, status) VALUES (?, ?)", (url, "RECOMMENDED"))
                else:
                    reason = analysis.get("reason", "Skipped") if analysis else "Invalid JSON"
                    print(f"  ❌ SKIPPED: {reason}")
                    conn.cursor().execute("INSERT OR REPLACE INTO processed_urls (url, status) VALUES (?, ?)", (url, "FAILED"))
            else:
                print("  ⚠️ Empty page / Scrape failed. Marking FAILED.")
                conn.cursor().execute("INSERT OR REPLACE INTO processed_urls (url, status) VALUES (?, ?)", (url, "FAILED"))

            conn.commit()

        valid_jobs = sorted(valid_jobs, key=lambda x: x.get('score', 0), reverse=True)
        send_digest_email(valid_jobs)
        conn.close()

    except Exception as e:
        error_trace = traceback.format_exc()
        print("\n💥 FATAL ERROR ENCOUNTERED:")
        print(error_trace)
        send_crash_email(error_trace)