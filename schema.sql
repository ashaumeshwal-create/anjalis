-- ═══════════════════════════════════════════════════════════════
-- ANJALIS — Complete Supabase Database Schema
-- Run this entire file in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────────
-- 1. PROFILES (extends Supabase auth.users)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE public.profiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email           TEXT UNIQUE NOT NULL,
  first_name      TEXT NOT NULL DEFAULT '',
  last_name       TEXT NOT NULL DEFAULT '',
  phone           TEXT,
  city            TEXT,
  avatar_url      TEXT,
  role            TEXT NOT NULL DEFAULT 'user'    -- 'user' | 'expert' | 'admin'
                  CHECK (role IN ('user','expert','admin')),
  wallet_balance  DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─────────────────────────────────────────────────────────────
-- 2. EXPERTS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE public.experts (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  display_name        TEXT NOT NULL,
  category            TEXT NOT NULL
                      CHECK (category IN ('legal','finance','astrology','psychology','health','business','other')),
  title               TEXT NOT NULL,
  description         TEXT,
  experience_years    INTEGER NOT NULL DEFAULT 0,
  call_rate_per_min   DECIMAL(6,2) NOT NULL DEFAULT 10.00,
  chat_rate_per_min   DECIMAL(6,2) NOT NULL DEFAULT 5.00,
  online_status       TEXT NOT NULL DEFAULT 'offline'
                      CHECK (online_status IN ('online','offline','busy')),
  is_verified         BOOLEAN NOT NULL DEFAULT false,
  is_featured         BOOLEAN NOT NULL DEFAULT false,
  rating              DECIMAL(3,2) NOT NULL DEFAULT 5.00,
  total_sessions      INTEGER NOT NULL DEFAULT 0,
  total_earnings      DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  languages           TEXT[] DEFAULT ARRAY['Hindi','English'],
  tags                TEXT[] DEFAULT ARRAY[]::TEXT[],
  last_seen           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_experts_category   ON public.experts(category);
CREATE INDEX idx_experts_status     ON public.experts(online_status);
CREATE INDEX idx_experts_rating     ON public.experts(rating DESC);
CREATE INDEX idx_experts_verified   ON public.experts(is_verified);

CREATE TRIGGER experts_updated_at
  BEFORE UPDATE ON public.experts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─────────────────────────────────────────────────────────────
-- 3. SESSIONS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE public.sessions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES public.profiles(id),
  expert_id         UUID NOT NULL REFERENCES public.experts(id),
  type              TEXT NOT NULL CHECK (type IN ('call','chat')),
  rate_per_min      DECIMAL(6,2) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','completed','cancelled','failed')),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ,
  duration_seconds  INTEGER NOT NULL DEFAULT 0,
  amount_charged    DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  agora_channel     TEXT,           -- Agora RTC channel name
  rating_by_user    SMALLINT CHECK (rating_by_user BETWEEN 1 AND 5),
  review_text       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user_id   ON public.sessions(user_id);
CREATE INDEX idx_sessions_expert_id ON public.sessions(expert_id);
CREATE INDEX idx_sessions_status    ON public.sessions(status);
CREATE INDEX idx_sessions_started   ON public.sessions(started_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 4. TRANSACTIONS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE public.transactions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES public.profiles(id),
  type          TEXT NOT NULL CHECK (type IN ('credit','debit','bonus')),
  amount        DECIMAL(10,2) NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  session_id    UUID REFERENCES public.sessions(id),
  payment_id    TEXT,               -- Razorpay payment ID
  order_id      TEXT,               -- Razorpay order ID
  status        TEXT NOT NULL DEFAULT 'completed'
                CHECK (status IN ('pending','completed','failed','refunded')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transactions_user_id   ON public.transactions(user_id);
CREATE INDEX idx_transactions_created   ON public.transactions(created_at DESC);
CREATE INDEX idx_transactions_type      ON public.transactions(type);

-- ─────────────────────────────────────────────────────────────
-- 5. EXPERT REVIEWS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE public.reviews (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id  UUID NOT NULL REFERENCES public.sessions(id),
  user_id     UUID NOT NULL REFERENCES public.profiles(id),
  expert_id   UUID NOT NULL REFERENCES public.experts(id),
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id) -- one review per session
);

-- Auto-update expert rating after new review
CREATE OR REPLACE FUNCTION update_expert_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.experts SET
    rating = (SELECT AVG(rating)::DECIMAL(3,2) FROM public.reviews WHERE expert_id = NEW.expert_id),
    total_sessions = total_sessions + 1
  WHERE id = NEW.expert_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reviews_update_expert
  AFTER INSERT ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION update_expert_rating();

-- ─────────────────────────────────────────────────────────────
-- 6. WALLET NOTIFICATIONS (for real-time low balance alerts)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE public.notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id),
  type        TEXT NOT NULL,   -- 'low_balance' | 'session_start' | 'payment_success'
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  is_read     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- 7. WALLET RPC FUNCTIONS (atomic balance operations)
-- ─────────────────────────────────────────────────────────────

-- Deduct from wallet (returns error if insufficient)
CREATE OR REPLACE FUNCTION deduct_wallet(p_user_id UUID, p_amount DECIMAL)
RETURNS void AS $$
DECLARE
  current_balance DECIMAL;
BEGIN
  SELECT wallet_balance INTO current_balance
  FROM public.profiles WHERE id = p_user_id FOR UPDATE;

  IF current_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient wallet balance';
  END IF;

  UPDATE public.profiles
  SET wallet_balance = wallet_balance - p_amount
  WHERE id = p_user_id;

  -- Send low balance notification if below ₹100
  IF (current_balance - p_amount) < 100 THEN
    INSERT INTO public.notifications(user_id, type, title, message)
    VALUES (p_user_id, 'low_balance', 'Low Wallet Balance',
      'Your wallet balance is below ₹100. Top up to continue consultations.');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Credit wallet
CREATE OR REPLACE FUNCTION credit_wallet(p_user_id UUID, p_amount DECIMAL)
RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET wallet_balance = wallet_balance + p_amount
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─────────────────────────────────────────────────────────────
-- 8. ROW LEVEL SECURITY (RLS)
-- ─────────────────────────────────────────────────────────────

-- Enable RLS on all tables
ALTER TABLE public.profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviews       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- PROFILES policies
CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Admins can view all profiles"
  ON public.profiles FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- EXPERTS policies — public read, own write
CREATE POLICY "Anyone can view verified experts"
  ON public.experts FOR SELECT USING (is_verified = true);
CREATE POLICY "Experts can update own profile"
  ON public.experts FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "Admins manage all experts"
  ON public.experts FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- SESSIONS policies
CREATE POLICY "Users see own sessions"
  ON public.sessions FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Experts see their sessions"
  ON public.sessions FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.experts WHERE id = expert_id AND user_id = auth.uid())
  );

-- TRANSACTIONS policies
CREATE POLICY "Users see own transactions"
  ON public.transactions FOR SELECT USING (user_id = auth.uid());

-- NOTIFICATIONS policies
CREATE POLICY "Users see own notifications"
  ON public.notifications FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users update own notifications"
  ON public.notifications FOR UPDATE USING (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- 9. SEED DATA (sample experts for demo)
-- ─────────────────────────────────────────────────────────────

-- Note: First create auth users manually in Supabase Auth dashboard,
-- then insert their profile + expert records below.

-- Example (replace UUIDs with real ones after creating auth users):
/*
INSERT INTO public.experts (user_id, display_name, category, title, description,
  experience_years, call_rate_per_min, chat_rate_per_min, online_status, is_verified, is_featured, rating, tags) VALUES
('your-uuid-here', 'Dr. Priya Sharma',  'legal',      'Senior Advocate',      'Family law, property, criminal defence.', 14, 18, 10, 'online', true, true, 4.9, ARRAY['Family Law','Property','Criminal']),
('your-uuid-here', 'Rahul Mehta',       'finance',    'Investment Advisor',   'SEBI-registered portfolio & tax advisor.', 10, 22, 12, 'online', true, true, 4.8, ARRAY['Stocks','Mutual Funds','Tax']),
('your-uuid-here', 'Anita Joshi',       'astrology',  'Vedic Astrologer',     'Kundali, marriage, career predictions.',    20, 15,  8, 'online', true, true, 4.9, ARRAY['Kundali','Marriage','Career']),
('your-uuid-here', 'Dr. Kavita Nair',   'psychology', 'Clinical Psychologist','Anxiety, depression, couples therapy.',      8, 25, 14, 'online', true, false, 4.7, ARRAY['Anxiety','Depression','Couples']),
('your-uuid-here', 'Suresh Pillai',     'business',   'Business Consultant',  'Startup strategy and fundraising.',         15, 30, 18, 'offline',true, false, 4.6, ARRAY['Startup','Strategy','Marketing']),
('your-uuid-here', 'Dr. Meera Krishnan','health',     'Ayurvedic Doctor',     'Ayurvedic treatments and wellness.',        12, 20, 11, 'online', true, false, 4.8, ARRAY['Ayurveda','Diet','Lifestyle']);
*/

-- ─────────────────────────────────────────────────────────────
-- 10. REALTIME (enable for live updates)
-- ─────────────────────────────────────────────────────────────
-- In Supabase Dashboard → Database → Replication
-- Enable replication for: sessions, experts, notifications
-- This allows frontend to get real-time expert status updates

-- ─────────────────────────────────────────────────────────────
-- DONE! Schema created successfully.
-- ─────────────────────────────────────────────────────────────
SELECT 'Anjalis database schema created successfully! 🎉' AS status;
