# 🚀 ANJALIS — Complete Deployment Guide
### Step-by-step: Supabase · Railway · Netlify · Agora · Razorpay

---

## 📁 YOUR FILE STRUCTURE
```
anjalis/
├── frontend/
│   └── index.html          ← Upload to GitHub, deploy via Netlify
├── backend/
│   ├── server.js           ← Deploy on Railway
│   ├── package.json
│   └── .env.example        ← Copy to .env, fill in keys
└── supabase/
    └── schema.sql          ← Run in Supabase SQL Editor
```

---

# STEP 1 — SUPABASE (Database + Auth)
> **Free tier:** 500MB DB · 50,000 users · 2GB bandwidth

### 1.1 Create Account
1. Go to **supabase.com** → Click **"Start your project"**
2. Sign up with GitHub (fastest)
3. Click **"New project"**
4. Fill in:
   - **Name:** `anjalis`
   - **Database Password:** Save this somewhere safe!
   - **Region:** `Southeast Asia (Singapore)` — closest to India
5. Click **"Create new project"** — wait ~2 minutes

### 1.2 Run the Database Schema
1. In your Supabase project, click **"SQL Editor"** (left sidebar)
2. Click **"New query"**
3. Open `supabase/schema.sql` and **paste the entire contents**
4. Click **"Run"** (Ctrl+Enter)
5. You should see: `Anjalis database schema created successfully! 🎉`

### 1.3 Get Your Keys
1. Go to **Settings → API** (left sidebar)
2. Copy these three values:
   ```
   Project URL:        https://abcdefgh.supabase.co
   anon public key:    eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   service_role key:   eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...  ← KEEP SECRET!
   ```

### 1.4 Enable Realtime (for live expert status)
1. Go to **Database → Replication** (left sidebar)
2. Click **"supabase_realtime"**
3. Toggle ON for these tables: `sessions`, `experts`, `notifications`

### 1.5 Configure Auth
1. Go to **Authentication → Providers**
2. Make sure **Email** is enabled
3. Go to **Authentication → URL Configuration**
4. Add your Netlify URL to **"Site URL"**: `https://anjalis.netlify.app`

---

# STEP 2 — RAZORPAY (Payments)
> **Free to start:** No monthly fee, ~2% per transaction

### 2.1 Create Account
1. Go to **razorpay.com** → Click **"Sign Up"**
2. Fill in your business details (required for live payments)
3. Verify your email and phone

### 2.2 Get API Keys
1. Go to **Settings → API Keys**
2. Click **"Generate Test Key"**
3. Copy:
   ```
   Key ID:     rzp_test_XXXXXXXXXXXXXXXXXX
   Key Secret: XXXXXXXXXXXXXXXXXXXXXXXX   ← KEEP SECRET!
   ```
4. For live payments later: Generate **Live Keys** (requires KYC)

### 2.3 Configure Webhooks (for payment verification)
1. Go to **Settings → Webhooks**
2. Click **"Add New Webhook"**
3. Set **Webhook URL**: `https://your-railway-app.railway.app/wallet/verify`
4. Select event: `payment.captured`
5. Save

---

# STEP 3 — AGORA (Voice & Video Calls)
> **Free tier:** 10,000 call minutes/month FREE

### 3.1 Create Account
1. Go to **agora.io** → Click **"Sign Up Free"**
2. Verify your email

### 3.2 Create a Project
1. Go to **Console → Project Management**
2. Click **"Create a Project"**
3. Fill in:
   - **Project Name:** `Anjalis`
   - **Use Case:** `One-to-one calling`
   - **Authentication:** `Secured mode` (recommended)
4. Click **"Submit"**

### 3.3 Get Your Credentials
1. In your project, click the **edit (pencil) icon**
2. Copy:
   ```
   App ID:          xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   App Certificate: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  ← For token generation
   ```

### 3.4 Enable Token Authentication
1. In Console → Your Project → Edit
2. Enable **"Primary Certificate"**
3. Your backend uses these to generate secure call tokens

---

# STEP 4 — RAILWAY (Backend API)
> **Free tier:** $5 credit/month (covers ~500 hours)

### 4.1 Create Account
1. Go to **railway.app** → Click **"Start a New Project"**
2. Sign up with **GitHub** (required for deployment)

### 4.2 Prepare Your Backend Files
1. Create a new **GitHub repository** called `anjalis-backend`
2. Upload these files to it:
   - `server.js`
   - `package.json`
   - (Do NOT upload `.env` — you'll set vars in Railway dashboard)

### 4.3 Deploy on Railway
1. In Railway dashboard → **"New Project"**
2. Click **"Deploy from GitHub repo"**
3. Select your `anjalis-backend` repository
4. Railway auto-detects Node.js and starts deploying

### 4.4 Add Environment Variables
1. In your Railway project, click your service
2. Go to **"Variables"** tab
3. Click **"Add Variable"** for each:

```
SUPABASE_URL            = https://YOUR_ID.supabase.co
SUPABASE_SERVICE_KEY    = eyJ... (service_role key from Supabase)
JWT_SECRET              = paste_a_random_64_char_string_here
RAZORPAY_KEY_ID         = rzp_test_XXXXXXXXX
RAZORPAY_KEY_SECRET     = your_razorpay_secret
AGORA_APP_ID            = your_agora_app_id
AGORA_APP_CERT          = your_agora_certificate
FRONTEND_URL            = https://anjalis.netlify.app
NODE_ENV                = production
```

💡 **Generate JWT_SECRET**: Go to random.org and generate a 64-character string, or use:
`openssl rand -base64 64` in any terminal/Replit.

### 4.5 Get Your Railway URL
1. Go to your service → **"Settings"** tab
2. Under **"Domains"**, click **"Generate Domain"**
3. Copy your URL like: `https://anjalis-backend.railway.app`
4. Test it: open `https://anjalis-backend.railway.app/health` in browser
5. You should see: `{"status":"ok","service":"anjalis-api"}`

---

# STEP 5 — NETLIFY (Frontend)
> **Free tier:** 100GB bandwidth · Unlimited sites

### 5.1 Create Account
1. Go to **netlify.com** → **"Sign up with GitHub"**

### 5.2 Upload Frontend to GitHub
1. Create a new GitHub repo called `anjalis-frontend`
2. Upload `frontend/index.html`

### 5.3 Before Uploading — Update API URL
Open `index.html` and find this line near the bottom:
```javascript
const API_URL = 'http://localhost:4000';
```
Change it to your Railway URL:
```javascript
const API_URL = 'https://anjalis-backend.railway.app';
```

### 5.4 Deploy on Netlify
1. Netlify dashboard → **"Add new site"** → **"Import from GitHub"**
2. Select `anjalis-frontend`
3. Build settings:
   - **Build command:** (leave blank)
   - **Publish directory:** `.`
4. Click **"Deploy site"**

### 5.5 Custom Domain (Optional)
1. Site settings → **"Domain management"**
2. Click **"Change site name"** → type `anjalis-app`
3. Your URL: `https://anjalis-app.netlify.app`

---

# STEP 6 — CONNECT FRONTEND TO BACKEND

In `index.html`, the demo login buttons already work locally.
To connect to your real Supabase + Railway backend, add these to the `<script>` section:

```javascript
const API_BASE = 'https://anjalis-backend.railway.app';

// Real login (replaces demo doLogin function)
async function doLogin() {
  const email = document.getElementById('login-email').value;
  const pass  = document.getElementById('login-pass').value;
  const res   = await fetch(API_BASE + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pass })
  });
  const data = await res.json();
  if (!res.ok) { showToast(data.error, '❌'); return; }
  localStorage.setItem('anjalis_token', data.token);
  closeAuth();
  launchUser(data.user.first_name + ' ' + data.user.last_name, data.user.email, data.user.role);
  showToast('Welcome back!');
}
```

---

# 🔑 ALL KEYS SUMMARY CHECKLIST

Copy this and fill it in as you complete each step:

```
✅ Supabase Project URL:        _________________________________
✅ Supabase Anon Key:           _________________________________
✅ Supabase Service Role Key:   _________________________________  (keep secret!)

✅ Razorpay Key ID:             _________________________________
✅ Razorpay Key Secret:         _________________________________  (keep secret!)

✅ Agora App ID:                _________________________________
✅ Agora App Certificate:       _________________________________  (keep secret!)

✅ Railway App URL:             _________________________________
✅ Netlify App URL:             _________________________________

✅ JWT Secret:                  _________________________________  (keep secret!)
```

---

# 📋 DEPLOYMENT CHECKLIST

- [ ] Supabase project created
- [ ] Schema SQL executed successfully
- [ ] Realtime enabled for sessions, experts, notifications
- [ ] Razorpay account created, test keys copied
- [ ] Agora account created, App ID copied
- [ ] GitHub repos created (frontend + backend)
- [ ] Railway backend deployed with all env vars
- [ ] Railway health check returns OK
- [ ] Frontend index.html updated with Railway URL
- [ ] Netlify deployed from GitHub
- [ ] Test login/signup on live site
- [ ] Test wallet top-up (use Razorpay test card: 4111 1111 1111 1111)
- [ ] Test call/chat session

---

# 🧪 RAZORPAY TEST CARDS

Use these to test payments without real money:
```
Card Number:  4111 1111 1111 1111
Expiry:       Any future date (e.g., 12/26)
CVV:          Any 3 digits (e.g., 123)
OTP:          1234 (for test mode)
```

---

# 💰 ESTIMATED COSTS AT SCALE

| Service | Free Tier | Paid (when you outgrow free) |
|---------|-----------|------------------------------|
| Supabase | 500MB DB, 50K users | $25/month (Pro) |
| Railway | $5 credit/month | ~$10-20/month |
| Netlify | 100GB bandwidth | $19/month (Pro) |
| Agora | 10K min/month | ~$0.99/1000 min |
| Razorpay | Free | ~2% per transaction |

**Total startup cost: ₹0** (everything fits in free tiers for first ~1000 users)

---

# 🆘 COMMON ISSUES

**Railway deploy fails:**
- Check `package.json` has `"start": "node server.js"`
- Make sure all env vars are set in Railway dashboard

**Supabase connection error:**
- Check SUPABASE_URL includes `https://`
- Use SERVICE_KEY (not anon key) in backend

**Razorpay payment fails:**
- Ensure you're using TEST keys (rzp_test_...) in development
- Check webhook URL is correct in Razorpay dashboard

**CORS error in browser:**
- Add your Netlify URL to `FRONTEND_URL` env var in Railway
- Restart Railway deployment after changing vars

---

*Built with ❤️ · Anjalis Platform 2025*
