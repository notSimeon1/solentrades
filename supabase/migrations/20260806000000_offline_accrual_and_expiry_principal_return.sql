/*
# Align DB accrual RPCs with offline catch-up, exact-date expiration, and principal return

1. Updates `accrue_daily_bot_profits` to:
   - Process both `'active'` and `'running'` bots
   - Clamp elapsed accrual strictly to `LEAST(now(), expiration_date)`
   - Advance `last_payout_at` to `LEAST(now(), expiration_date)`
   - Mark expired bots as `'completed'` and return `invested_amount` principal to the matching account_mode balance
2. Updates `accrue_copy_trading_profits` to:
   - Process both `'active'` and `'running'` allocations
   - Compute cumulative schedule up to `LEAST(now(), created_at + lock_in_days)` minus `current_profit`
   - Mark expired allocations as `'completed'` and return `allocated_amount` principal
*/

CREATE OR REPLACE FUNCTION public.accrue_daily_bot_profits()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _bot record;
  _effective_now timestamptz;
  _last_cp timestamptz;
  _elapsed_seconds numeric;
  _hourly_rate numeric;
  _profit numeric;
  _principal numeric := 0;
  _is_expired boolean;
  _total_accrued numeric := 0;
  _bots_processed int := 0;
  _mode text;
  _credit numeric;
BEGIN
  FOR _bot IN
    SELECT uab.*, tb.hourly_payout, tb.daily_payout, tb.name as bot_name
    FROM user_active_bots uab
    JOIN trading_bots tb ON uab.bot_id = tb.id
    WHERE uab.status IN ('active', 'running')
  LOOP
    _is_expired := now() >= _bot.expiration_date;
    _effective_now := LEAST(now(), _bot.expiration_date);
    _last_cp := GREATEST(_bot.activation_date, COALESCE(_bot.last_payout_at, _bot.activation_date));
    _elapsed_seconds := GREATEST(0, EXTRACT(EPOCH FROM (_effective_now - _last_cp)));

    _hourly_rate := COALESCE(NULLIF(_bot.hourly_payout, 0), NULLIF(_bot.daily_payout, 0) / 24.0, (_bot.invested_amount * 0.1) / 24.0);
    _profit := ROUND(((_hourly_rate / 3600.0) * _elapsed_seconds)::numeric, 4);

    IF _profit <= 0 AND NOT _is_expired THEN
      CONTINUE;
    END IF;

    _mode := COALESCE(_bot.account_mode, 'live');
    _principal := CASE WHEN _is_expired THEN COALESCE(_bot.invested_amount, 0) ELSE 0 END;
    _credit := COALESCE(_profit, 0) + _principal;

    UPDATE user_active_bots
    SET current_profit = ROUND((current_profit + _profit)::numeric, 4),
        last_payout_at = GREATEST(_last_cp, _effective_now),
        status = CASE WHEN _is_expired THEN 'completed' ELSE status END
    WHERE id = _bot.id AND status IN ('active', 'running');

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF _credit > 0 THEN
      IF _mode = 'demo' THEN
        UPDATE profiles SET demo_balance = ROUND((demo_balance + _credit)::numeric, 4) WHERE id = _bot.user_id;
      ELSE
        UPDATE profiles
        SET live_balance = ROUND((live_balance + _credit)::numeric, 4),
            account_balance = ROUND((account_balance + _credit)::numeric, 4),
            available_cash = ROUND((available_cash + _credit)::numeric, 4)
        WHERE id = _bot.user_id;
      END IF;
    END IF;

    IF _profit >= 0.01 THEN
      INSERT INTO transactions (user_id, type, amount, status, asset_name, account_mode)
      VALUES (_bot.user_id, 'bot_profit', ROUND(_profit, 2), 'completed', _bot.bot_name, _mode);
    END IF;

    IF _is_expired AND _principal > 0 THEN
      INSERT INTO transactions (user_id, type, amount, status, asset_name, account_mode, source_table, source_id)
      VALUES (_bot.user_id, 'bot_principal_return', ROUND(_principal, 2), 'completed', _bot.bot_name || ' — Principal Returned', _mode, 'user_active_bots', _bot.id);
    END IF;

    _total_accrued := _total_accrued + _profit;
    _bots_processed := _bots_processed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'bots_processed', _bots_processed,
    'total_accrued', _total_accrued,
    'timestamp', now()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.accrue_copy_trading_profits()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _alloc record;
  _exp_at timestamptz;
  _effective_now timestamptz;
  _is_expired boolean;
  _elapsed_seconds numeric;
  _daily_profit numeric;
  _target_profit numeric;
  _profit numeric;
  _principal numeric := 0;
  _credit numeric;
  _total_accrued numeric := 0;
  _allocs_processed int := 0;
  _mode text;
BEGIN
  FOR _alloc IN
    SELECT uca.*, ctt.monthly_roi_min, ctt.monthly_roi_max, ctt.lock_in_days, ctt.tier_name, ctt.strategist_name
    FROM user_copy_allocations uca
    JOIN copy_trading_tiers ctt ON uca.tier_id = ctt.id
    WHERE uca.status IN ('active', 'running')
  LOOP
    _exp_at := _alloc.created_at + make_interval(days => GREATEST(1, COALESCE(_alloc.lock_in_days, 30)));
    _is_expired := now() >= _exp_at;
    _effective_now := LEAST(now(), _exp_at);
    _elapsed_seconds := GREATEST(0, EXTRACT(EPOCH FROM (_effective_now - _alloc.created_at)));

    _daily_profit := (_alloc.allocated_amount * ((_alloc.monthly_roi_min + _alloc.monthly_roi_max) / 2.0) / 100.0 / 30.0);
    _target_profit := ROUND(((_daily_profit / 86400.0) * _elapsed_seconds)::numeric, 4);
    _profit := GREATEST(0, ROUND((_target_profit - COALESCE(_alloc.current_profit, 0))::numeric, 4));

    IF _profit <= 0 AND NOT _is_expired THEN
      CONTINUE;
    END IF;

    _mode := COALESCE(_alloc.account_mode, 'live');
    _principal := CASE WHEN _is_expired THEN COALESCE(_alloc.allocated_amount, 0) ELSE 0 END;
    _credit := _profit + _principal;

    UPDATE user_copy_allocations
    SET current_profit = ROUND((COALESCE(current_profit, 0) + _profit)::numeric, 4),
        status = CASE WHEN _is_expired THEN 'completed' ELSE status END
    WHERE id = _alloc.id AND status IN ('active', 'running');

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF _credit > 0 THEN
      IF _mode = 'demo' THEN
        UPDATE profiles SET demo_balance = ROUND((demo_balance + _credit)::numeric, 4) WHERE id = _alloc.user_id;
      ELSE
        UPDATE profiles
        SET live_balance = ROUND((live_balance + _credit)::numeric, 4),
            account_balance = ROUND((account_balance + _credit)::numeric, 4),
            available_cash = ROUND((available_cash + _credit)::numeric, 4)
        WHERE id = _alloc.user_id;
      END IF;
    END IF;

    IF _profit >= 0.01 THEN
      INSERT INTO transactions (user_id, type, amount, status, asset_name, account_mode)
      VALUES (_alloc.user_id, 'copy_profit', ROUND(_profit, 2), 'completed', _alloc.tier_name || ' - ' || _alloc.strategist_name, _mode);
    END IF;

    IF _is_expired AND _principal > 0 THEN
      INSERT INTO transactions (user_id, type, amount, status, asset_name, account_mode, source_table, source_id)
      VALUES (_alloc.user_id, 'copy_principal_return', ROUND(_principal, 2), 'completed', _alloc.tier_name || ' — Principal Returned', _mode, 'user_copy_allocations', _alloc.id);
    END IF;

    _total_accrued := _total_accrued + _profit;
    _allocs_processed := _allocs_processed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'allocs_processed', _allocs_processed,
    'total_accrued', _total_accrued,
    'timestamp', now()
  );
END;
$$;
