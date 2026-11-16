-- ==============================================================================
-- SOLEN TRADES: FINAL BULLETPROOF SUPABASE ADMIN SQL FIX SCRIPT
-- Copy and run this entire script in your Supabase SQL Editor.
-- ==============================================================================

-- 1. Create app_role enum if it does not exist
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 2. Create user_roles table if missing
CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  app_role text DEFAULT 'user',
  role app_role DEFAULT 'user',
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE (user_id, role)
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- 3. Create helper function for checking roles
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND (role::text = _role OR app_role = _role)
  );
$$;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(_user_id, _role::text);
$$;

-- 4. Automatically grant admin role to your admin emails
DO $$
DECLARE
  r RECORD;
  admin_emails text[] := ARRAY['simonosawaru255@gmail.com', 'bayo@gmail.com', 'oweanowean24@gmail.com'];
BEGIN
  FOR r IN SELECT id, email FROM auth.users WHERE lower(email) = ANY(admin_emails)
  LOOP
    INSERT INTO public.user_roles (user_id, role)
    VALUES (r.id, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;

    RAISE NOTICE 'Granted admin role to %', r.email;
  END LOOP;
END $$;

-- 5. Set up clean RLS policies allowing admins to read/write all operational data
DROP POLICY IF EXISTS "profiles admin select" ON public.profiles;
CREATE POLICY "profiles admin select" ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "profiles admin update" ON public.profiles;
CREATE POLICY "profiles admin update" ON public.profiles
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "deposits admin select" ON public.deposits;
CREATE POLICY "deposits admin select" ON public.deposits
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "deposits admin update" ON public.deposits;
CREATE POLICY "deposits admin update" ON public.deposits
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "withdrawals admin select" ON public.withdrawals;
CREATE POLICY "withdrawals admin select" ON public.withdrawals
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "withdrawals admin update" ON public.withdrawals;
CREATE POLICY "withdrawals admin update" ON public.withdrawals
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "transactions admin select" ON public.transactions;
CREATE POLICY "transactions admin select" ON public.transactions
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "complaints admin select" ON public.complaints;
CREATE POLICY "complaints admin select" ON public.complaints
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "kyc admin select" ON public.kyc_submissions;
CREATE POLICY "kyc admin select" ON public.kyc_submissions
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "settings admin select" ON public.app_settings;
CREATE POLICY "settings admin select" ON public.app_settings
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "platform_settings admin select" ON public.platform_settings;
CREATE POLICY "platform_settings admin select" ON public.platform_settings
  FOR SELECT TO authenticated
  USING (true);

-- Refresh schema cache
NOTIFY pgrst, 'reload schema';
