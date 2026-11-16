-- ==============================================================================
-- SOLEN TRADES: COMPLETE UNDO / RESTORE NORMAL POLICIES SQL SCRIPT
-- Copy and paste this into your Supabase SQL Editor and run it to completely
-- remove the strict lockdown and restore normal admin panel functionality.
-- ==============================================================================

-- 1. Drop strict trigger & function if they exist
DROP TRIGGER IF EXISTS trg_protect_profile_sensitive_columns ON public.profiles;
DROP FUNCTION IF EXISTS public.protect_profile_sensitive_columns();
DROP FUNCTION IF EXISTS public.is_strict_admin(uuid);

-- 2. Restore full read/write/update access for authenticated users & admins on profiles
DROP POLICY IF EXISTS "profiles_self_select" ON public.profiles;
DROP POLICY IF EXISTS "profiles_self_safe_update" ON public.profiles;
DROP POLICY IF EXISTS "profiles admin select" ON public.profiles;
DROP POLICY IF EXISTS "profiles admin update" ON public.profiles;

CREATE POLICY "profiles select own" ON public.profiles FOR SELECT USING (auth.uid() = id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "profiles update own" ON public.profiles FOR UPDATE USING (auth.uid() = id OR public.has_role(auth.uid(), 'admin')) WITH CHECK (auth.uid() = id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "profiles insert own" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id OR public.has_role(auth.uid(), 'admin'));

-- 3. Restore deposits policies
DROP POLICY IF EXISTS "deposits_strict_select" ON public.deposits;
DROP POLICY IF EXISTS "deposits_strict_insert_pending" ON public.deposits;
DROP POLICY IF EXISTS "deposits admin select" ON public.deposits;
DROP POLICY IF EXISTS "deposits admin update" ON public.deposits;

CREATE POLICY "deposits own insert" ON public.deposits FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "deposits own select" ON public.deposits FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "deposits admin update" ON public.deposits FOR UPDATE USING (public.has_role(auth.uid(), 'admin'));

-- 4. Restore withdrawals policies
DROP POLICY IF EXISTS "withdrawals_strict_select" ON public.withdrawals;
DROP POLICY IF EXISTS "withdrawals_strict_insert_pending" ON public.withdrawals;
DROP POLICY IF EXISTS "withdrawals admin select" ON public.withdrawals;
DROP POLICY IF EXISTS "withdrawals admin update" ON public.withdrawals;

CREATE POLICY "wd own insert" ON public.withdrawals FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "wd own select" ON public.withdrawals FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "wd admin update" ON public.withdrawals FOR UPDATE USING (public.has_role(auth.uid(), 'admin'));

-- 5. Restore transactions policies
DROP POLICY IF EXISTS "transactions_strict_select" ON public.transactions;
DROP POLICY IF EXISTS "transactions_strict_insert_pending" ON public.transactions;
DROP POLICY IF EXISTS "transactions admin select" ON public.transactions;

CREATE POLICY "tx own select" ON public.transactions FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "tx own insert" ON public.transactions FOR INSERT WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "tx admin select" ON public.transactions FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

-- 6. Restore user_crypto_balances
DROP POLICY IF EXISTS "ucb_strict_select" ON public.user_crypto_balances;
DROP POLICY IF EXISTS "ucb admin select" ON public.user_crypto_balances;
DROP POLICY IF EXISTS "ucb admin modify" ON public.user_crypto_balances;

CREATE POLICY "ucb_self_read" ON public.user_crypto_balances FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "ucb_admin_write" ON public.user_crypto_balances FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 7. Grant grants back to authenticated roles
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- 8. Ensure admin email has admin role
DO $$
DECLARE
  r RECORD;
  admin_emails text[] := ARRAY['simonosawaru255@gmail.com', 'bayo@gmail.com', 'oweanowean24@gmail.com'];
BEGIN
  FOR r IN SELECT id, email FROM auth.users WHERE lower(email) = ANY(admin_emails)
  LOOP
    UPDATE public.profiles
    SET role = 'admin', is_admin = true, is_super_admin = true
    WHERE id = r.id;

    INSERT INTO public.user_roles (user_id, role)
    VALUES (r.id, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
SELECT 'Successfully restored normal database policies and admin access!' AS status;
