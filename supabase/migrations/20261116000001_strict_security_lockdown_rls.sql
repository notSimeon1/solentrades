-- ============================================================================
-- STRICT SECURITY & BALANCE LOCKDOWN MIGRATION (SCHEMA-SAFE & IDEMPOTENT)
-- Protects all balances, crypto wallets, ledger logs, KYC status, and admin
-- roles at the PostgreSQL layer so even advanced users cannot mutate state
-- via browser DevTools, console, localStorage, or direct REST/RPC calls.
-- Safely checks table/column existence so it runs cleanly on any schema state.
-- ============================================================================

-- 1. Strict admin verification helper (SECURITY DEFINER avoids RLS recursion)
CREATE OR REPLACE FUNCTION public.is_strict_admin(_uid uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
  v_prof jsonb;
  v_has_role boolean := false;
BEGIN
  IF _uid IS NULL THEN
    RETURN false;
  END IF;

  SELECT lower(email) INTO v_email FROM auth.users WHERE id = _uid;
  IF v_email IN ('simonosawaru255@gmail.com', 'bayo@gmail.com', 'oweanowean24@gmail.com') THEN
    RETURN true;
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL THEN
    SELECT to_jsonb(p) INTO v_prof FROM public.profiles p WHERE p.id = _uid;
    IF v_prof IS NOT NULL THEN
      IF (v_prof ->> 'role') IN ('admin', 'super_admin')
        OR lower(COALESCE(v_prof ->> 'is_admin', 'false')) = 'true'
        OR lower(COALESCE(v_prof ->> 'is_super_admin', 'false')) = 'true' THEN
        RETURN true;
      END IF;
    END IF;
  END IF;

  IF to_regclass('public.user_roles') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role::text IN (''admin'', ''super_admin''))'
      INTO v_has_role
      USING _uid;
    IF v_has_role THEN
      RETURN true;
    END IF;
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.is_strict_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_strict_admin(uuid) TO authenticated, service_role;

-- 2. Lock down public.profiles (column-level grants + sensitive-column trigger)
DO $$
DECLARE
  col text;
  pol record;
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

    REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM anon, authenticated, public;
    GRANT SELECT ON public.profiles TO authenticated;
    GRANT ALL ON public.profiles TO service_role;

    -- Grant UPDATE ONLY on safe self-service preference columns that exist
    FOREACH col IN ARRAY ARRAY[
      'full_name',
      'avatar_url',
      'preferred_currency',
      'base_currency',
      'account_mode',
      'ai_trading_enabled',
      'updated_at'
    ] LOOP
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = col
      ) THEN
        EXECUTE format('GRANT UPDATE (%I) ON public.profiles TO authenticated', col);
      END IF;
    END LOOP;

    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'profiles'
        AND cmd IN ('UPDATE', 'INSERT', 'DELETE', 'ALL')
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.profiles', pol.policyname);
    END LOOP;

    DROP POLICY IF EXISTS "profiles_self_select" ON public.profiles;
    CREATE POLICY "profiles_self_select" ON public.profiles
      FOR SELECT TO authenticated
      USING (auth.uid() = id OR public.is_strict_admin(auth.uid()));

    DROP POLICY IF EXISTS "profiles_self_safe_update" ON public.profiles;
    CREATE POLICY "profiles_self_safe_update" ON public.profiles
      FOR UPDATE TO authenticated
      USING (auth.uid() = id)
      WITH CHECK (auth.uid() = id);
  END IF;
END $$;

-- Defense-in-depth trigger: reject ANY balance, KYC, or role mutation from non-service/non-admin callers
CREATE OR REPLACE FUNCTION public.protect_profile_sensitive_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_uid uuid;
  v_target_email text;
  v_old jsonb;
  v_new jsonb;
  v_col text;
BEGIN
  v_role := COALESCE(auth.role(), '');
  v_uid := auth.uid();
  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);

  -- Always protect Primary Super Admin immutability
  SELECT lower(email) INTO v_target_email FROM auth.users WHERE id = OLD.id;
  IF v_target_email = 'simonosawaru255@gmail.com' THEN
    IF (
      ((v_old ? 'role') AND (v_new ->> 'role') IS DISTINCT FROM 'super_admin' AND (v_old ->> 'role') = 'super_admin')
      OR ((v_old ? 'is_super_admin') AND lower(COALESCE(v_new ->> 'is_super_admin', 'true')) = 'false')
      OR ((v_old ? 'is_suspended') AND lower(COALESCE(v_new ->> 'is_suspended', 'false')) = 'true')
    ) THEN
      RAISE EXCEPTION 'Action Denied: Primary Super Admin privileges cannot be modified or revoked.';
    END IF;
  END IF;

  -- Allow service_role / postgres internal migrations & server functions
  IF v_role = 'service_role' OR current_user IN ('postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  -- Block any direct client modification to sensitive financial, KYC, or privilege columns
  FOREACH v_col IN ARRAY ARRAY[
    'live_balance',
    'account_balance',
    'available_cash',
    'demo_balance',
    'crypto_balances',
    'kyc_status',
    'role',
    'is_admin',
    'is_super_admin',
    'is_suspended',
    'signals_lifetime',
    'chart_mode',
    'chart_intensity',
    'chart_seed',
    'referred_by'
  ] LOOP
    IF (v_old -> v_col) IS DISTINCT FROM (v_new -> v_col) THEN
      IF NOT public.is_strict_admin(v_uid) THEN
        RAISE EXCEPTION 'Security Violation: Balance, KYC, and privilege columns can only be modified by verified server operations.';
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_protect_profile_sensitive_columns ON public.profiles;
    CREATE TRIGGER trg_protect_profile_sensitive_columns
      BEFORE UPDATE ON public.profiles
      FOR EACH ROW
      EXECUTE FUNCTION public.protect_profile_sensitive_columns();
  END IF;
END $$;

-- 3. Lock down user_crypto_balances (read-only for authenticated users; writes strictly server-side)
DO $$
DECLARE pol record;
BEGIN
  IF to_regclass('public.user_crypto_balances') IS NOT NULL THEN
    ALTER TABLE public.user_crypto_balances ENABLE ROW LEVEL SECURITY;
    REVOKE INSERT, UPDATE, DELETE ON public.user_crypto_balances FROM anon, authenticated, public;
    GRANT SELECT ON public.user_crypto_balances TO authenticated;
    GRANT ALL ON public.user_crypto_balances TO service_role;

    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'user_crypto_balances'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.user_crypto_balances', pol.policyname);
    END LOOP;

    CREATE POLICY "ucb_strict_select" ON public.user_crypto_balances
      FOR SELECT TO authenticated
      USING (auth.uid() = user_id OR public.is_strict_admin(auth.uid()));
  END IF;
END $$;

-- 4. Lock down deposits (users can ONLY insert status='pending' for themselves; never approve/update)
DO $$
DECLARE pol record;
BEGIN
  IF to_regclass('public.deposits') IS NOT NULL THEN
    ALTER TABLE public.deposits ENABLE ROW LEVEL SECURITY;
    REVOKE UPDATE, DELETE ON public.deposits FROM anon, authenticated, public;
    GRANT SELECT, INSERT ON public.deposits TO authenticated;
    GRANT ALL ON public.deposits TO service_role;

    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'deposits'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.deposits', pol.policyname);
    END LOOP;

    CREATE POLICY "deposits_strict_select" ON public.deposits
      FOR SELECT TO authenticated
      USING (auth.uid() = user_id OR public.is_strict_admin(auth.uid()));

    CREATE POLICY "deposits_strict_insert_pending" ON public.deposits
      FOR INSERT TO authenticated
      WITH CHECK (
        auth.uid() = user_id
        AND status = 'pending'
        AND amount > 0
      );
  END IF;
END $$;

-- 5. Lock down withdrawals (users can ONLY insert status='pending' for themselves; never approve/update)
DO $$
DECLARE pol record;
BEGIN
  IF to_regclass('public.withdrawals') IS NOT NULL THEN
    ALTER TABLE public.withdrawals ENABLE ROW LEVEL SECURITY;
    REVOKE UPDATE, DELETE ON public.withdrawals FROM anon, authenticated, public;
    GRANT SELECT, INSERT ON public.withdrawals TO authenticated;
    GRANT ALL ON public.withdrawals TO service_role;

    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'withdrawals'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.withdrawals', pol.policyname);
    END LOOP;

    CREATE POLICY "withdrawals_strict_select" ON public.withdrawals
      FOR SELECT TO authenticated
      USING (auth.uid() = user_id OR public.is_strict_admin(auth.uid()));

    CREATE POLICY "withdrawals_strict_insert_pending" ON public.withdrawals
      FOR INSERT TO authenticated
      WITH CHECK (
        auth.uid() = user_id
        AND status = 'pending'
        AND amount > 0
      );
  END IF;
END $$;

-- 6. Lock down live_positions, user_active_bots, user_copy_allocations, referral_earnings
DO $$
DECLARE tbl text; pol record;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['live_positions', 'user_active_bots', 'user_copy_allocations'] LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon, authenticated, public', tbl);
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated', tbl);
      EXECUTE format('GRANT ALL ON public.%I TO service_role', tbl);
      FOR pol IN
        SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, tbl);
      END LOOP;
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.is_strict_admin(auth.uid()))',
        tbl || '_strict_select',
        tbl
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE pol record;
BEGIN
  IF to_regclass('public.referral_earnings') IS NOT NULL THEN
    ALTER TABLE public.referral_earnings ENABLE ROW LEVEL SECURITY;
    REVOKE INSERT, UPDATE, DELETE ON public.referral_earnings FROM anon, authenticated, public;
    GRANT SELECT ON public.referral_earnings TO authenticated;
    GRANT ALL ON public.referral_earnings TO service_role;
    FOR pol IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'referral_earnings'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.referral_earnings', pol.policyname);
    END LOOP;
    CREATE POLICY "referral_earnings_strict_select" ON public.referral_earnings
      FOR SELECT TO authenticated
      USING (auth.uid() = referrer_id OR public.is_strict_admin(auth.uid()));
  END IF;
END $$;

-- 7. Lock down transactions (users may only insert pending deposit/withdrawal requests, never approved credits/swaps/admin_credit)
DO $$
DECLARE pol record;
BEGIN
  IF to_regclass('public.transactions') IS NOT NULL THEN
    ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
    REVOKE UPDATE, DELETE ON public.transactions FROM anon, authenticated, public;
    GRANT SELECT, INSERT ON public.transactions TO authenticated;
    GRANT ALL ON public.transactions TO service_role;

    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'transactions'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.transactions', pol.policyname);
    END LOOP;

    CREATE POLICY "transactions_strict_select" ON public.transactions
      FOR SELECT TO authenticated
      USING (auth.uid() = user_id OR public.is_strict_admin(auth.uid()));

    CREATE POLICY "transactions_strict_insert_pending" ON public.transactions
      FOR INSERT TO authenticated
      WITH CHECK (
        auth.uid() = user_id
        AND status = 'pending'
        AND type IN ('deposit', 'deposit_request', 'withdrawal', 'withdrawal_request')
      );
  END IF;
END $$;

-- 8. Lock down admin_balance_logs, user_roles (if present), app_settings, platform_settings
DO $$
DECLARE pol record;
BEGIN
  IF to_regclass('public.admin_balance_logs') IS NOT NULL THEN
    ALTER TABLE public.admin_balance_logs ENABLE ROW LEVEL SECURITY;
    REVOKE INSERT, UPDATE, DELETE ON public.admin_balance_logs FROM anon, authenticated, public;
    GRANT SELECT ON public.admin_balance_logs TO authenticated;
    GRANT ALL ON public.admin_balance_logs TO service_role;

    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'admin_balance_logs'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.admin_balance_logs', pol.policyname);
    END LOOP;

    CREATE POLICY "admin_balance_logs_strict_select" ON public.admin_balance_logs
      FOR SELECT TO authenticated
      USING (public.is_strict_admin(auth.uid()));
  END IF;
END $$;

DO $$
DECLARE pol record;
BEGIN
  IF to_regclass('public.user_roles') IS NOT NULL THEN
    ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
    REVOKE INSERT, UPDATE, DELETE ON public.user_roles FROM anon, authenticated, public;
    GRANT SELECT ON public.user_roles TO authenticated;
    GRANT ALL ON public.user_roles TO service_role;

    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'user_roles'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.user_roles', pol.policyname);
    END LOOP;

    CREATE POLICY "user_roles_strict_select" ON public.user_roles
      FOR SELECT TO authenticated
      USING (auth.uid() = user_id OR public.is_strict_admin(auth.uid()));
  END IF;
END $$;

DO $$
DECLARE tbl text; pol record;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['app_settings', 'platform_settings'] LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon, authenticated, public', tbl);
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated', tbl);
      EXECUTE format('GRANT ALL ON public.%I TO service_role', tbl);
      FOR pol IN
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = tbl AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, tbl);
      END LOOP;
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_strict_select', tbl);
      IF tbl = 'app_settings' THEN
        EXECUTE 'CREATE POLICY "app_settings_strict_select" ON public.app_settings FOR SELECT TO authenticated USING (key NOT LIKE ''presence:%'' OR public.is_strict_admin(auth.uid()))';
      ELSE
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', tbl || '_strict_select', tbl);
      END IF;
    END IF;
  END LOOP;
END $$;

-- 9. Preserve KYC submissions (users can submit pending KYC rows; only admins/server approve)
DO $$
DECLARE pol record;
BEGIN
  IF to_regclass('public.kyc_submissions') IS NOT NULL THEN
    ALTER TABLE public.kyc_submissions ENABLE ROW LEVEL SECURITY;
    REVOKE UPDATE, DELETE ON public.kyc_submissions FROM anon, authenticated, public;
    GRANT SELECT, INSERT ON public.kyc_submissions TO authenticated;
    GRANT ALL ON public.kyc_submissions TO service_role;

    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'kyc_submissions'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.kyc_submissions', pol.policyname);
    END LOOP;

    CREATE POLICY "kyc_strict_select" ON public.kyc_submissions
      FOR SELECT TO authenticated
      USING (auth.uid() = user_id OR public.is_strict_admin(auth.uid()));

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'kyc_submissions' AND column_name = 'status'
    ) THEN
      EXECUTE 'CREATE POLICY "kyc_strict_insert" ON public.kyc_submissions FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id AND (status IS NULL OR status = ''pending''))';
    ELSE
      EXECUTE 'CREATE POLICY "kyc_strict_insert" ON public.kyc_submissions FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)';
    END IF;
  END IF;
END $$;

-- 10. Revoke anon/public execution of admin_* SQL RPC functions
DO $$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (
        p.proname LIKE 'admin_%'
        OR p.proname IN ('notify_user', 'has_role')
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, public', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn.sig);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
