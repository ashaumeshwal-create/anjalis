// ═══════════════════════════════════════════════════════════════
// ANJALIS — Production Backend (Node.js + Express)
// Deploy on Railway.app
// FIXED: Real Agora tokens, WebSocket chat, proper billing, CORS
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const http       = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const Razorpay   = require('razorpay');
const crypto     = require('crypto');
const jwt        = require('jsonwebtoken');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 4000;

// ──────────────────────────────────────────────────────────────
// SOCKET.IO — Real-time chat
// ──────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST']
  }
});

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
let razorpay;
try {
  razorpay = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
} catch (e) {
  console.warn('⚠️  Razorpay init failed (keys missing?) — wallet top-up will use demo mode');
}

// ──────────────────────────────────────────────────────────────
// AGORA — RTC Token generation
// ──────────────────────────────────────────────────────────────
const AGORA_APP_ID   = process.env.AGORA_APP_ID;
const AGORA_APP_CERT = process.env.AGORA_APP_CERT;

// Minimal Agora RTC token builder (AccessToken2007)
// For production, use: npm i agora-access-token
function buildAgoraToken(channelName, uid, expireSeconds = 3600) {
  if (!AGORA_APP_ID || !AGORA_APP_CERT) return null;
  try {
    const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
    const expireTime = Math.floor(Date.now() / 1000) + expireSeconds;
    return RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID, AGORA_APP_CERT, channelName, uid, RtcRole.PUBLISHER, expireTime
    );
  } catch {
    // If agora-access-token not installed, return placeholder
    console.warn('agora-access-token not installed, returning null token');
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// MIDDLEWARE
// ──────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logger
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
    res.status(401).json({ error: 'Invalid or expired token' });
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
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

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
      first_name:     first_name || '',
      last_name:      last_name || '',
      role:           role === 'admin' ? 'user' : role, // prevent self-admin
      wallet_balance: 0,
    });
    if (profileError) {
      console.error('Profile insert error:', profileError);
      return res.status(400).json({ error: profileError.message });
    }

    // Issue JWT
    const token = jwt.sign(
      { id: authData.user.id, email, role: role === 'admin' ? 'user' : role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: authData.user.id, email,
        first_name: first_name || '', last_name: last_name || '',
        role: role === 'admin' ? 'user' : role,
        wallet_balance: 0
      }
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/login
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Invalid email or password' });

    const { data: profile, error: profileErr } = await supabase
      .from('profiles').select('*').eq('id', data.user.id).single();

    if (profileErr) return res.status(404).json({ error: 'Profile not found' });

    const token = jwt.sign(
      { id: data.user.id, email, role: profile.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, user: profile });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/me — get current user profile
app.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles').select('*').eq('id', req.user.id).single();
    if (error) return res.status(404).json({ error: 'User not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// EXPERTS ROUTES
// ══════════════════════════════════════════════════════════════

// GET /experts — list all approved experts
app.get('/experts', async (req, res) => {
  const { category, status } = req.query;
  let query = supabase
    .from('experts')
    .select(`*, profile:profiles(first_name, last_name, avatar_url)`)
    .eq('is_verified', true);

  if (category && category !== 'all') query = query.eq('category', category);
  if (status) query = query.eq('online_status', status);

  const { data, error } = await query.order('rating', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
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

// PUT /experts/:id/status — expert updates own online status
app.put('/experts/:id/status', authMiddleware, async (req, res) => {
  const { status } = req.body;
  if (!['online', 'offline', 'busy'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });

  const { error } = await supabase
    .from('experts')
    .update({ online_status: status, last_seen: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════
// SESSION ROUTES
// ══════════════════════════════════════════════════════════════

// POST /sessions/start
app.post('/sessions/start', authMiddleware, async (req, res) => {
  const { expert_id, type } = req.body;
  if (!expert_id || !type) return res.status(400).json({ error: 'expert_id and type required' });
  if (!['call', 'chat'].includes(type)) return res.status(400).json({ error: 'type must be call or chat' });

  try {
    // Check wallet balance
    const { data: profile } = await supabase
      .from('profiles').select('wallet_balance').eq('id', req.user.id).single();
    if (!profile || profile.wallet_balance < 5)
      return res.status(400).json({ error: 'Insufficient wallet balance. Minimum ₹5 required.' });

    // Check expert availability
    const { data: expert } = await supabase
      .from('experts').select('*').eq('id', expert_id).single();
    if (!expert) return res.status(404).json({ error: 'Expert not found' });
    if (expert.online_status !== 'online')
      return res.status(400).json({ error: 'Expert is currently unavailable' });

    const ratePerMin = type === 'call' ? expert.call_rate_per_min : expert.chat_rate_per_min;
    const channelName = `session_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // Create session
    const { data: session, error } = await supabase.from('sessions').insert({
      user_id:         req.user.id,
      expert_id,
      type,
      rate_per_min:    ratePerMin,
      status:          'active',
      started_at:      new Date().toISOString(),
      agora_channel:   channelName,
      duration_seconds: 0,
      amount_charged:  0,
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Set expert to busy
    await supabase.from('experts')
      .update({ online_status: 'busy' }).eq('id', expert_id);

    // Generate Agora token (for call type)
    let agoraToken = null;
    if (type === 'call') {
      agoraToken = buildAgoraToken(channelName, 0);
    }

    res.json({
      session,
      agoraToken,
      agoraAppId:  AGORA_APP_ID || null,
      channelName,
      rate_per_min: ratePerMin,
      wallet_balance: profile.wallet_balance,
    });
  } catch (err) {
    console.error('Start session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /sessions/:id/tick — called every 60s to bill the user
app.post('/sessions/:id/tick', authMiddleware, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions').select('*, expert:experts(*)').eq('id', req.params.id).single();
    if (!session || session.status !== 'active')
      return res.status(400).json({ error: 'Session not active' });

    const ratePerTick = parseFloat(session.rate_per_min);
    const COMMISSION  = 0.20;

    // Deduct from wallet via RPC
    const { error: deductError } = await supabase.rpc('deduct_wallet', {
      p_user_id: req.user.id,
      p_amount:  ratePerTick
    });
    if (deductError) {
      // End session if wallet is empty
      await endSessionDB(session.id);
      return res.status(400).json({
        error: 'Insufficient balance — session ended',
        session_ended: true
      });
    }

    // Log debit transaction
    await supabase.from('transactions').insert({
      user_id:     req.user.id,
      type:        'debit',
      amount:      ratePerTick,
      description: `${session.type === 'call' ? 'Call' : 'Chat'} — 1 min with ${session.expert?.display_name || 'Expert'}`,
      session_id:  session.id,
    });

    // Credit expert (80% of rate)
    if (session.expert?.user_id) {
      await supabase.rpc('credit_wallet', {
        p_user_id: session.expert.user_id,
        p_amount:  ratePerTick * (1 - COMMISSION)
      });
    }

    // Update session duration & amount
    const newDuration = (session.duration_seconds || 0) + 60;
    const newAmount   = (parseFloat(session.amount_charged) || 0) + ratePerTick;
    await supabase.from('sessions')
      .update({ duration_seconds: newDuration, amount_charged: newAmount })
      .eq('id', session.id);

    // Get updated balance
    const { data: updatedProfile } = await supabase
      .from('profiles').select('wallet_balance').eq('id', req.user.id).single();

    res.json({
      success: true,
      wallet_balance: updatedProfile?.wallet_balance || 0,
      duration_seconds: newDuration,
      amount_charged: newAmount,
    });
  } catch (err) {
    console.error('Tick error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /sessions/:id/end
app.post('/sessions/:id/end', authMiddleware, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions').select('*').eq('id', req.params.id).single();
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const result = await endSessionDB(session.id);

    // Get updated wallet balance
    const { data: profile } = await supabase
      .from('profiles').select('wallet_balance').eq('id', req.user.id).single();

    res.json({
      success: true,
      duration_seconds: result.duration,
      amount_charged: result.amount,
      wallet_balance: profile?.wallet_balance || 0,
    });
  } catch (err) {
    console.error('End session error:', err);
    res.status(500).json({ error: err.message });
  }
});

async function endSessionDB(sessionId) {
  const now = new Date();
  const { data: session } = await supabase
    .from('sessions').select('*').eq('id', sessionId).single();

  const duration = session
    ? Math.floor((now - new Date(session.started_at)) / 1000)
    : 0;
  const amount = (duration / 60) * (parseFloat(session?.rate_per_min) || 0);

  await supabase.from('sessions').update({
    status: 'completed',
    ended_at: now.toISOString(),
    duration_seconds: duration,
    amount_charged: Math.round(amount * 100) / 100,
  }).eq('id', sessionId);

  // Set expert back to online
  if (session?.expert_id) {
    await supabase.from('experts')
      .update({ online_status: 'online' }).eq('id', session.expert_id);
  }

  return { duration, amount: Math.round(amount * 100) / 100 };
}

// GET /sessions — user's own sessions
app.get('/sessions', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select(`*, expert:experts(*, profile:profiles(first_name,last_name))`)
      .eq('user_id', req.user.id)
      .order('started_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /sessions/stats — user session stats
app.get('/sessions/stats', authMiddleware, async (req, res) => {
  try {
    const { data: sessions } = await supabase
      .from('sessions')
      .select('duration_seconds, amount_charged, started_at')
      .eq('user_id', req.user.id)
      .eq('status', 'completed');

    const totalSessions  = sessions?.length || 0;
    const totalSeconds   = sessions?.reduce((s, r) => s + (r.duration_seconds || 0), 0) || 0;
    const totalSpent     = sessions?.reduce((s, r) => s + parseFloat(r.amount_charged || 0), 0) || 0;

    // This week stats
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
    const thisWeek = sessions?.filter(s => new Date(s.started_at) >= weekAgo) || [];
    const weekSessions = thisWeek.length;
    const weekMinutes  = thisWeek.reduce((s, r) => s + (r.duration_seconds || 0), 0) / 60;
    const weekSpent    = thisWeek.reduce((s, r) => s + parseFloat(r.amount_charged || 0), 0);

    res.json({
      total_sessions: totalSessions,
      total_minutes:  Math.round(totalSeconds / 60),
      total_spent:    Math.round(totalSpent * 100) / 100,
      week_sessions:  weekSessions,
      week_minutes:   Math.round(weekMinutes),
      week_spent:     Math.round(weekSpent * 100) / 100,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// WALLET ROUTES
// ══════════════════════════════════════════════════════════════

// POST /wallet/create-order — create Razorpay order
app.post('/wallet/create-order', authMiddleware, async (req, res) => {
  const { amount } = req.body; // in rupees
  if (!amount || amount < 1)
    return res.status(400).json({ error: 'Invalid amount' });

  // If Razorpay is not configured, use demo mode
  if (!razorpay) {
    return res.json({
      order_id: `demo_order_${Date.now()}`,
      amount,
      currency: 'INR',
      demo_mode: true,
      razorpay_key: 'demo',
    });
  }

  try {
    const order = await razorpay.orders.create({
      amount:   Math.round(amount * 100), // Razorpay takes paise
      currency: 'INR',
      receipt:  `rcpt_${Date.now()}_${req.user.id.slice(0, 8)}`,
      notes:    { user_id: req.user.id, platform: 'anjalis' }
    });
    res.json({
      order_id: order.id,
      amount,
      currency: 'INR',
      razorpay_key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('Razorpay order error:', err);
    res.status(500).json({ error: 'Payment gateway error: ' + err.message });
  }
});

// POST /wallet/verify — verify payment & credit wallet
app.post('/wallet/verify', authMiddleware, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount, demo_mode } = req.body;

  // Demo mode — skip signature verification
  if (demo_mode === true) {
    const creditAmt = parseFloat(amount);
    const { error } = await supabase.rpc('credit_wallet', {
      p_user_id: req.user.id,
      p_amount:  creditAmt
    });
    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('transactions').insert({
      user_id:     req.user.id,
      type:        'credit',
      amount:      creditAmt,
      description: 'Wallet top-up (demo mode)',
      payment_id:  `demo_${Date.now()}`,
      order_id:    razorpay_order_id || `demo_order_${Date.now()}`,
    });

    const { data: profile } = await supabase
      .from('profiles').select('wallet_balance').eq('id', req.user.id).single();
    return res.json({ success: true, new_balance: profile?.wallet_balance || creditAmt });
  }

  // Real Razorpay verification
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({ error: 'Missing payment details' });

  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSig !== razorpay_signature)
    return res.status(400).json({ error: 'Invalid payment signature — payment may be tampered' });

  const creditAmt = parseFloat(amount);

  // Credit wallet
  const { error } = await supabase.rpc('credit_wallet', {
    p_user_id: req.user.id,
    p_amount:  creditAmt
  });
  if (error) return res.status(500).json({ error: error.message });

  // Log transaction
  await supabase.from('transactions').insert({
    user_id:     req.user.id,
    type:        'credit',
    amount:      creditAmt,
    description: 'Wallet top-up via Razorpay',
    payment_id:  razorpay_payment_id,
    order_id:    razorpay_order_id,
  });

  const { data: profile } = await supabase
    .from('profiles').select('wallet_balance').eq('id', req.user.id).single();

  res.json({ success: true, new_balance: profile?.wallet_balance || 0 });
});

// GET /wallet/balance — quick balance check
app.get('/wallet/balance', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('profiles').select('wallet_balance').eq('id', req.user.id).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ balance: data?.wallet_balance || 0 });
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
  res.json(data || []);
});

// ══════════════════════════════════════════════════════════════
// CHAT MESSAGES — store & retrieve
// ══════════════════════════════════════════════════════════════

// POST /chat/send — store a chat message
app.post('/chat/send', authMiddleware, async (req, res) => {
  const { session_id, message, sender_role } = req.body;
  if (!session_id || !message) return res.status(400).json({ error: 'Missing fields' });

  const { data, error } = await supabase.from('chat_messages').insert({
    session_id,
    sender_id: req.user.id,
    sender_role: sender_role || 'user',
    message,
  }).select().single();

  if (error) {
    // If table doesn't exist, that's ok — chat still works via socket
    console.warn('Chat message store failed (table may not exist):', error.message);
    return res.json({ success: true, stored: false });
  }

  // Broadcast to socket room
  io.to(`chat_${session_id}`).emit('new_message', {
    id: data?.id,
    message,
    sender_id: req.user.id,
    sender_role: sender_role || 'user',
    created_at: new Date().toISOString(),
  });

  res.json({ success: true, stored: true });
});

// ══════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ══════════════════════════════════════════════════════════════

// GET /admin/stats
app.get('/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const monthStart = new Date(new Date().setDate(1)).toISOString();
    const [users, experts, sessions, revenue] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('experts').select('id', { count: 'exact', head: true }).eq('is_verified', true),
      supabase.from('sessions').select('id', { count: 'exact', head: true })
        .gte('started_at', monthStart),
      supabase.from('transactions').select('amount').eq('type', 'debit')
        .gte('created_at', monthStart),
    ]);
    const totalRevenue = (revenue.data || []).reduce((s, t) => s + parseFloat(t.amount), 0);
    res.json({
      total_users:      users.count || 0,
      total_experts:    experts.count || 0,
      monthly_sessions: sessions.count || 0,
      monthly_revenue:  Math.round(totalRevenue * 100) / 100,
      commission:       Math.round(totalRevenue * 0.20 * 100) / 100,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/users
app.get('/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('profiles').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /admin/experts
app.get('/admin/experts', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('experts').select('*, profile:profiles(*)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// PUT /admin/experts/:id/verify
app.put('/admin/experts/:id/verify', authMiddleware, adminMiddleware, async (req, res) => {
  const { error } = await supabase
    .from('experts').update({ is_verified: true }).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// GET /admin/sessions
app.get('/admin/sessions', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .select(`*, user:profiles!sessions_user_id_fkey(*), expert:experts(*, profile:profiles(*))`)
    .order('started_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /admin/transactions
app.get('/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('transactions').select('*, user:profiles(*)')
    .order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
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
// CONFIG ROUTE (safe public config for frontend)
// ══════════════════════════════════════════════════════════════
app.get('/config', (_req, res) => {
  res.json({
    razorpay_key:  process.env.RAZORPAY_KEY_ID || null,
    agora_app_id:  process.env.AGORA_APP_ID || null,
    supabase_url:  process.env.SUPABASE_URL || null,
    supabase_anon: process.env.SUPABASE_ANON_KEY || null,
    demo_mode:     !razorpay,
  });
});

// ══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════════════
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok', version: '2.0.0', service: 'anjalis-api',
    features: {
      razorpay: !!razorpay,
      agora:    !!AGORA_APP_ID,
      realtime: true,
    }
  });
});

app.get('/', (_req, res) => {
  res.json({ message: 'Anjalis API v2.0 is running 🚀', docs: '/health' });
});

// ══════════════════════════════════════════════════════════════
// SOCKET.IO — Real-time chat + session events
// ══════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Join a chat room
  socket.on('join_session', (sessionId) => {
    socket.join(`chat_${sessionId}`);
    console.log(`${socket.id} joined chat_${sessionId}`);
  });

  // Chat message
  socket.on('chat_message', (data) => {
    io.to(`chat_${data.session_id}`).emit('new_message', {
      message:     data.message,
      sender_id:   data.sender_id,
      sender_role: data.sender_role || 'user',
      created_at:  new Date().toISOString(),
    });
  });

  // Session ended
  socket.on('session_ended', (data) => {
    io.to(`chat_${data.session_id}`).emit('session_ended', data);
  });

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// ──────────────────────────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ Anjalis API v2.0 running on port ${PORT}`);
  console.log(`   Razorpay: ${razorpay ? '✅' : '⚠️ demo mode'}`);
  console.log(`   Agora:    ${AGORA_APP_ID ? '✅' : '⚠️ not configured'}`);
  console.log(`   Socket.IO: ✅ ready`);
});
