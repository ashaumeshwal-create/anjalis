// ═══════════════════════════════════════════════════════════════
// ANJALIS — Production Backend (Node.js + Express)
// Deploy on Railway.app (free tier)
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Razorpay   = require('razorpay');
const crypto     = require('crypto');
const jwt        = require('jsonwebtoken');

const app  = express();
const PORT = process.env.PORT || 4000;

// ──────────────────────────────────────────────────────────────
// SUPABASE CLIENT (service role — bypasses RLS for server ops)
// ──────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ──────────────────────────────────────────────────────────────
// RAZORPAY
// ──────────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ──────────────────────────────────────────────────────────────
// MIDDLEWARE
// ──────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simple request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// JWT Auth middleware
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token provided' });
  try {
    const token = header.replace('Bearer ', '');
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Admin-only middleware
function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ══════════════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════════════

// POST /auth/signup
app.post('/auth/signup', async (req, res) => {
  const { email, password, first_name, last_name, role = 'user' } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    // Create auth user in Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email, password,
      email_confirm: true,
      user_metadata: { first_name, last_name, role }
    });
    if (authError) return res.status(400).json({ error: authError.message });

    // Create profile row
    const { error: profileError } = await supabase.from('profiles').insert({
      id:             authData.user.id,
      email,
      first_name,
      last_name,
      role,
      wallet_balance: 0,
    });
    if (profileError) return res.status(400).json({ error: profileError.message });

    // Issue JWT
    const token = jwt.sign(
      { id: authData.user.id, email, role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, user: { id: authData.user.id, email, first_name, last_name, role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/login
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Invalid credentials' });

    const { data: profile } = await supabase
      .from('profiles').select('*').eq('id', data.user.id).single();

    const token = jwt.sign(
      { id: data.user.id, email, role: profile.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, user: profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/me
app.get('/auth/me', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('profiles').select('*').eq('id', req.user.id).single();
  if (error) return res.status(404).json({ error: 'User not found' });
  res.json(data);
});

// ══════════════════════════════════════════════════════════════
// EXPERTS ROUTES
// ══════════════════════════════════════════════════════════════

// GET /experts — list all approved experts (with optional category filter)
app.get('/experts', async (req, res) => {
  const { category, status } = req.query;
  let query = supabase
    .from('experts')
    .select(`
      *,
      profile:profiles(first_name, last_name, avatar_url)
    `)
    .eq('is_verified', true);

  if (category) query = query.eq('category', category);
  if (status)   query = query.eq('online_status', status);

  const { data, error } = await query.order('rating', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /experts/:id
app.get('/experts/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('experts')
    .select(`*, profile:profiles(*)`)
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Expert not found' });
  res.json(data);
});

// PUT /experts/:id/status  — expert updates own online status
app.put('/experts/:id/status', authMiddleware, async (req, res) => {
  const { status } = req.body; // 'online' | 'offline' | 'busy'
  const { error } = await supabase
    .from('experts')
    .update({ online_status: status, last_seen: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id); // only own record
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════
// SESSION ROUTES
// ══════════════════════════════════════════════════════════════

// POST /sessions/start
app.post('/sessions/start', authMiddleware, async (req, res) => {
  const { expert_id, type } = req.body; // type: 'call' | 'chat'

  // Check wallet balance
  const { data: profile } = await supabase
    .from('profiles').select('wallet_balance').eq('id', req.user.id).single();
  if (!profile || profile.wallet_balance < 5)
    return res.status(400).json({ error: 'Insufficient wallet balance' });

  // Check expert availability
  const { data: expert } = await supabase
    .from('experts').select('*').eq('id', expert_id).single();
  if (!expert) return res.status(404).json({ error: 'Expert not found' });
  if (expert.online_status !== 'online')
    return res.status(400).json({ error: 'Expert is not available' });

  // Create session
  const { data: session, error } = await supabase.from('sessions').insert({
    user_id:    req.user.id,
    expert_id,
    type,
    rate_per_min: type === 'call' ? expert.call_rate_per_min : expert.chat_rate_per_min,
    status:     'active',
    started_at: new Date().toISOString(),
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Set expert to busy
  await supabase.from('experts')
    .update({ online_status: 'busy' }).eq('id', expert_id);

  // Agora token generation (if call)
  let agoraToken = null;
  if (type === 'call' && process.env.AGORA_APP_ID) {
    // In real app: generate Agora RTC token here
    agoraToken = 'agora_token_placeholder';
  }

  res.json({ session, agoraToken, channelName: `session_${session.id}` });
});

// POST /sessions/:id/tick — called every 60s to bill the user
app.post('/sessions/:id/tick', authMiddleware, async (req, res) => {
  const { data: session } = await supabase
    .from('sessions').select('*, expert:experts(*)').eq('id', req.params.id).single();
  if (!session || session.status !== 'active')
    return res.status(400).json({ error: 'Session not active' });

  const ratePerTick = session.rate_per_min; // per minute
  const COMMISSION  = 0.20; // 20%

  // Deduct from wallet via RPC
  const { error: deductError } = await supabase.rpc('deduct_wallet', {
    p_user_id: req.user.id,
    p_amount:  ratePerTick
  });
  if (deductError) {
    // End session if wallet is empty
    await endSessionDB(session.id, req.user.id);
    return res.status(400).json({ error: 'Insufficient balance, session ended' });
  }

  // Log transaction
  await supabase.from('transactions').insert({
    user_id:     req.user.id,
    type:        'debit',
    amount:      ratePerTick,
    description: `${session.type === 'call' ? 'Call' : 'Chat'} session — 1 minute`,
    session_id:  session.id,
  });

  // Credit expert (80% of rate)
  await supabase.rpc('credit_wallet', {
    p_user_id: session.expert.user_id,
    p_amount:  ratePerTick * (1 - COMMISSION)
  });

  // Update duration
  await supabase.from('sessions')
    .update({ duration_seconds: session.duration_seconds + 60 })
    .eq('id', session.id);

  // Get updated balance
  const { data: updatedProfile } = await supabase
    .from('profiles').select('wallet_balance').eq('id', req.user.id).single();

  res.json({ success: true, wallet_balance: updatedProfile.wallet_balance });
});

// POST /sessions/:id/end
app.post('/sessions/:id/end', authMiddleware, async (req, res) => {
  const { data: session } = await supabase
    .from('sessions').select('*').eq('id', req.params.id).single();
  if (!session) return res.status(404).json({ error: 'Session not found' });

  await endSessionDB(session.id, session.user_id);
  res.json({ success: true, session });
});

async function endSessionDB(sessionId, userId) {
  const now = new Date();
  const { data: session } = await supabase
    .from('sessions').select('*').eq('id', sessionId).single();

  const duration = session
    ? Math.floor((now - new Date(session.started_at)) / 1000)
    : 0;

  await supabase.from('sessions').update({
    status: 'completed',
    ended_at: now.toISOString(),
    duration_seconds: duration,
    amount_charged: (duration / 60) * (session?.rate_per_min || 0),
  }).eq('id', sessionId);

  // Set expert back to online
  if (session?.expert_id) {
    await supabase.from('experts')
      .update({ online_status: 'online' }).eq('id', session.expert_id);
  }
}

// GET /sessions — user's own sessions
app.get('/sessions', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .select(`*, expert:experts(*, profile:profiles(first_name,last_name))`)
    .eq('user_id', req.user.id)
    .order('started_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ══════════════════════════════════════════════════════════════
// WALLET ROUTES
// ══════════════════════════════════════════════════════════════

// POST /wallet/create-order — create Razorpay order
app.post('/wallet/create-order', authMiddleware, async (req, res) => {
  const { amount } = req.body; // in rupees
  if (!amount || amount < 100)
    return res.status(400).json({ error: 'Minimum top-up is ₹100' });

  try {
    const order = await razorpay.orders.create({
      amount:   amount * 100, // Razorpay takes paise
      currency: 'INR',
      receipt:  `rcpt_${Date.now()}`,
      notes:    { user_id: req.user.id }
    });
    res.json({ order_id: order.id, amount, currency: 'INR' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /wallet/verify — verify payment & credit wallet
app.post('/wallet/verify', authMiddleware, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body;

  // Verify signature
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSig !== razorpay_signature)
    return res.status(400).json({ error: 'Invalid payment signature' });

  // Credit wallet
  const { error } = await supabase.rpc('credit_wallet', {
    p_user_id: req.user.id,
    p_amount:  amount
  });
  if (error) return res.status(500).json({ error: error.message });

  // Log transaction
  await supabase.from('transactions').insert({
    user_id:    req.user.id,
    type:       'credit',
    amount,
    description:'Wallet top-up via Razorpay',
    payment_id: razorpay_payment_id,
  });

  const { data: profile } = await supabase
    .from('profiles').select('wallet_balance').eq('id', req.user.id).single();

  res.json({ success: true, new_balance: profile.wallet_balance });
});

// GET /wallet/transactions
app.get('/wallet/transactions', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ══════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ══════════════════════════════════════════════════════════════

// GET /admin/stats
app.get('/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  const [users, experts, sessions, revenue] = await Promise.all([
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    supabase.from('experts').select('id', { count: 'exact', head: true }).eq('is_verified', true),
    supabase.from('sessions').select('id', { count: 'exact', head: true })
      .gte('started_at', new Date(new Date().setDate(1)).toISOString()),
    supabase.from('transactions').select('amount').eq('type','debit')
      .gte('created_at', new Date(new Date().setDate(1)).toISOString()),
  ]);
  const totalRevenue = (revenue.data || []).reduce((s, t) => s + t.amount, 0);
  res.json({
    total_users:    users.count,
    total_experts:  experts.count,
    monthly_sessions: sessions.count,
    monthly_revenue:  totalRevenue,
    commission:       totalRevenue * 0.20,
  });
});

// GET /admin/users
app.get('/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('profiles').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /admin/experts
app.get('/admin/experts', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('experts').select('*, profile:profiles(*)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PUT /admin/experts/:id/verify — approve expert
app.put('/admin/experts/:id/verify', authMiddleware, adminMiddleware, async (req, res) => {
  const { error } = await supabase
    .from('experts').update({ is_verified: true }).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// GET /admin/sessions — all sessions
app.get('/admin/sessions', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .select(`*, user:profiles!sessions_user_id_fkey(*), expert:experts(*, profile:profiles(*))`)
    .order('started_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /admin/transactions
app.get('/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('transactions').select('*, user:profiles(*)')
    .order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ══════════════════════════════════════════════════════════════
// PROFILE ROUTES
// ══════════════════════════════════════════════════════════════

// PUT /profile
app.put('/profile', authMiddleware, async (req, res) => {
  const { first_name, last_name, phone, city } = req.body;
  const { data, error } = await supabase
    .from('profiles')
    .update({ first_name, last_name, phone, city, updated_at: new Date().toISOString() })
    .eq('id', req.user.id)
    .select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════════════
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', service: 'anjalis-api' });
});

app.get('/', (_req, res) => {
  res.json({ message: 'Anjalis API is running 🚀', docs: '/health' });
});

// ──────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ Anjalis API running on port ${PORT}`));
