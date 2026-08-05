import os
import json
import sqlite3
import smtplib
import traceback
import warnings
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

warnings.filterwarnings("ignore", module="duckduckgo_search") 
from ddgs import DDGS
from playwright.sync_api import sync_playwright
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv() 

# ==========================================
# CONFIGURATION 
# ==========================================
DB_PATH = os.environ.get("DB_PATH", "seen_jobs.db")
MAX_RESULTS_PER_QUERY = int(os.environ.get("MAX_RESULTS_PER_QUERY", 10))
MAX_SCRAPE_LENGTH = int(os.environ.get("MAX_SCRAPE_LENGTH", 6000))
PLAYWRIGHT_TIMEOUT_MS = int(os.environ.get("PLAYWRIGHT_TIMEOUT_MS", 20000))

# Generic LLM Routing
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://openrouter.ai/api/v1")
LLM_API_KEY = os.environ.get("LLM_API_KEY")
LLM_MODEL = os.environ.get("LLM_MODEL", "google/gemini-1.5-flash:free")
LLM_TEMPERATURE = float(os.environ.get("LLM_TEMPERATURE", 0.0))

client = OpenAI(
    base_url=LLM_BASE_URL,
    api_key=LLM_API_KEY,
    max_retries=2,
)

# Global list to track non-fatal errors during the run
run_errors = []

# ==========================================
# ERROR MAILER (Fatal Crashes)
# ==========================================
def send_crash_email(error_traceback):
    """Sends an SOS email if the entire script crashes."""
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
    cv_path = os.path.join("context", "resume.md")
    if os.path.exists(cv_path):
        with open(cv_path, "r", encoding="utf-8") as f:
            cv_text = f.read()
        print("  -> Loaded resume from local file.")
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
# AI QUERY GENERATION
# ==========================================
def generate_search_queries(cv_text, instructions):
    print("🧠 Asking AI to generate search queries (this may take a few seconds)...")
    prompt = f"""
    You are an AI job-hunting agent. Based on the user's resume and explicit instructions, 
    generate an array of AT LEAST 10 search engine queries to find relevant job openings.
    
    RULES:
    1. Queries must be simple and natural (e.g., "Quantitative Risk Intern Hong Kong").
    2. DO NOT use advanced operators (no 'site:', no 'OR', no quotes, no parentheses).
    3. Generate at least 10 different variations to cast a wide net.
    
    RESUME: {cv_text}
    INSTRUCTIONS: {instructions}
    
    Respond STRICTLY with raw JSON. Do not include markdown. Structure:
    {{"queries": ["query 1", "query 2"]}}
    """
    try:
        response = client.chat.completions.create(
            model=LLM_MODEL, 
            messages=[{"role": "user", "content": prompt}],
            temperature=LLM_TEMPERATURE
        )
        clean_json = response.choices[0].message.content.replace("```json", "").replace("```", "").strip()
        data = json.loads(clean_json)
        queries = data.get("queries", ["Finance jobs Hong Kong"])
        print(f"✅ AI successfully generated {len(queries)} queries.")
        return queries
    except Exception as e:
        error_msg = f"Failed to generate dynamic queries: {e}"
        print(f"❌ {error_msg}")
        run_errors.append(error_msg)
        return ["Finance intern Hong Kong", "Data Science intern Hong Kong", "Quantitative Risk intern Hong Kong"]

# ==========================================
# CORE PIPELINE
# ==========================================
def setup_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("CREATE TABLE IF NOT EXISTS seen_urls (url TEXT PRIMARY KEY)")
    conn.commit()
    return conn

def get_new_job_urls(conn, queries):
    urls = set() 
    cursor = conn.cursor()
    print("\n🌐 Starting web search...")
    
    for q in queries:
        print(f"  🔍 Searching DuckDuckGo for: {q}")
        try:
            results = DDGS().text(q, max_results=MAX_RESULTS_PER_QUERY)
            if not results:
                print(f"     -> 0 results for '{q}'.")
                continue
                
            for res in results:
                url = res.get('href')
                if url:
                    cursor.execute("SELECT 1 FROM seen_urls WHERE url=?", (url,))
                    if not cursor.fetchone():
                        urls.add(url)
        except Exception as e:
            error_msg = f"DuckDuckGo search failed for query '{q}': {e}"
            print(f"  ❌ {error_msg}")
            run_errors.append(error_msg)
            
    print(f"✅ Total unique new URLs found across all searches: {len(urls)}")
    return list(urls)

def scrape_page_text(url):
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(url, timeout=PLAYWRIGHT_TIMEOUT_MS, wait_until="domcontentloaded")
            text = page.locator("body").inner_text()
            browser.close()
            return text[:MAX_SCRAPE_LENGTH] 
    except Exception as e:
        error_msg = f"Scraping failed for {url}: {e}"
        print(f"  ⚠️ {error_msg}")
        run_errors.append(error_msg)
        return ""

def evaluate_job(text, url, cv_text, instructions):
    prompt = f"""
    You are an expert recruiter. Analyze the job posting text below.
    Determine if it is an actual job listing that matches the user's instructions and resume.
    
    USER INSTRUCTIONS: {instructions}
    USER RESUME: {cv_text}
    JOB TEXT: {text}
    
    Respond STRICTLY with raw JSON. Do not include markdown. Structure:
    {{
        "is_valid_job": true/false,
        "company": "Company Name",
        "title": "Job Title",
        "score": integer 0-100,
        "reason": "1-sentence reason"
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
        error_msg = f"LLM parsing failed for {url}: {e}"
        print(f"  ❌ {error_msg}")
        run_errors.append(error_msg)
        return None

def send_digest_email(jobs_data):
    sender = os.environ.get("GMAIL_SENDER")
    password = os.environ.get("GMAIL_APP_PASSWORD")
    target = os.environ.get("TARGET_EMAIL")

    if not jobs_data and not run_errors:
        print("\n📭 No new jobs and no errors to email today.")
        return

    print(f"\n📧 Formatting email digest for {len(jobs_data)} valid jobs...")
    msg = MIMEMultipart()
    msg['From'] = sender
    msg['To'] = target
    msg['Subject'] = f"Daily AI Job Digest ({len(jobs_data)} new)"

    html_content = "<h2>Top Matches Based on Your Instructions</h2>"
    
    if jobs_data:
        html_content += "<ul>"
        for job in jobs_data:
            html_content += f"""
            <li>
                <strong>{job.get('company', 'Unknown')} - {job.get('title', 'Unknown Title')}</strong><br>
                Match Score: {job.get('score', 0)}/100<br>
                <em>Why: {job.get('reason', 'N/A')}</em><br>
                <a href="{job['url']}">Apply / View Here</a>
            </li><br>
            """
        html_content += "</ul>"
    else:
        html_content += "<p>No new valid jobs found today.</p>"

    # Append any non-fatal warnings to the bottom of the digest
    if run_errors:
        html_content += "<hr><h3>⚠️ Warnings / Skipped Links</h3><ul>"
        for err in run_errors:
            html_content += f"<li><small>{err}</small></li>"
        html_content += "</ul>"

    msg.attach(MIMEText(html_content, 'html'))

    try:
        with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
            server.login(sender, password)
            server.send_message(msg)
        print("✅ Digest email sent successfully!")
    except Exception as e:
        print(f"❌ Failed to send email: {e}")

if __name__ == "__main__":
    try:
        print("🚀 Starting AI Job Hunter...\n")
        
        cv_text, instructions = get_context()
        
        print("")
        dynamic_queries = generate_search_queries(cv_text, instructions)
        
        conn = setup_db()
        urls = get_new_job_urls(conn, dynamic_queries)
        
        valid_jobs = []
        
        if urls:
            print("\n⚙️ Processing Found URLs...")
            
        for url in urls:
            print(f"\nProcessing: {url}")
            print("  -> Scraping page...")
            page_text = scrape_page_text(url)
            
            if page_text:
                print("  -> Page scraped successfully. Evaluating with AI...")
                analysis = evaluate_job(page_text, url, cv_text, instructions)
                
                if analysis and analysis.get("is_valid_job"):
                    print(f"  ✅ MATCH FOUND: {analysis.get('company', 'Unknown')} - {analysis.get('title', 'Unknown')} (Score: {analysis.get('score', 0)}/100)")
                    analysis['url'] = url
                    valid_jobs.append(analysis)
                else:
                    print("  ❌ Not a match or invalid format. Skipping.")
            else:
                print("  ⚠️ No text scraped. Skipping AI evaluation.")
                    
            conn.cursor().execute("INSERT INTO seen_urls (url) VALUES (?)", (url,))
            conn.commit()
            
        valid_jobs = sorted(valid_jobs, key=lambda x: x.get('score', 0), reverse=True)
        send_digest_email(valid_jobs[:15]) 
        conn.close()

    except Exception as e:
        # If the script completely dies
        error_trace = traceback.format_exc()
        print("\n💥 FATAL ERROR ENCOUNTERED:")
        print(error_trace)
        send_crash_email(error_trace)