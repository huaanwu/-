-- ============================================================
-- StockMaster Supabase Schema v1
-- 在 Supabase SQL Editor 里跑这段,会自动建 8 张表 + RLS
-- ============================================================

-- 启用 UUID 生成
create extension if not exists "pgcrypto";

-- 1. watchlist (自选股)
create table if not exists watchlist (
  user_id uuid references auth.users not null,
  code text not null,
  name text,
  market text,
  added_at bigint,
  updated_at timestamptz default now(),
  primary key (user_id, code)
);

-- 2. holdings (持仓)
create table if not exists holdings (
  user_id uuid references auth.users not null,
  id text not null,
  code text,
  name text,
  market text,
  type text,
  shares double precision,
  cost double precision,
  created_at bigint,
  updated_at timestamptz default now(),
  data jsonb,  -- 兜底存整个 record
  primary key (user_id, id)
);

-- 3. transactions (交易记录)
create table if not exists transactions (
  user_id uuid references auth.users not null,
  id text not null,
  holding_id text,
  code text,
  type text,  -- buy / sell / dividend
  shares double precision,
  price double precision,
  date text,
  fee double precision,
  note text,
  created_at bigint,
  updated_at timestamptz default now(),
  data jsonb,
  primary key (user_id, id)
);

-- 4. journals (复盘笔记)
create table if not exists journals (
  user_id uuid references auth.users not null,
  id text not null,
  code text,
  title text,
  content text,
  date text,
  tags text,
  created_at bigint,
  updated_at bigint,
  data jsonb,
  primary key (user_id, id)
);

-- 5. alerts (提醒规则)
create table if not exists alerts (
  user_id uuid references auth.users not null,
  id text not null,
  code text,
  name text,
  type text,
  value double precision,
  active boolean,
  triggered boolean,
  hit_count integer default 0,
  next_check timestamptz,
  interval_days integer,
  last_hit timestamptz,
  created_at bigint,
  updated_at timestamptz default now(),
  data jsonb,
  primary key (user_id, id)
);

-- 6. funds (基金)
create table if not exists funds (
  user_id uuid references auth.users not null,
  code text not null,
  name text,
  type text,
  shares double precision,
  cost_nav double precision,
  note text,
  added_at bigint,
  updated_at timestamptz default now(),
  data jsonb,
  primary key (user_id, code)
);

-- 7. cashflow (资金流水)
create table if not exists cashflow (
  user_id uuid references auth.users not null,
  id text not null,
  date text,
  type text,
  amount double precision,
  target text,
  note text,
  created_at bigint,
  updated_at timestamptz default now(),
  data jsonb,
  primary key (user_id, id)
);

-- 8. kv (通用键值, 存 accountCash 等)
create table if not exists kv (
  user_id uuid references auth.users not null,
  key text not null,
  value jsonb,
  updated_at timestamptz default now(),
  primary key (user_id, key)
);

-- ============================================================
-- 触发器: 自动更新 updated_at
-- ============================================================
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
declare t text;
begin
  for t in
    select unnest(array['watchlist','holdings','transactions','journals','alerts','funds','cashflow','kv'])
  loop
    execute format('
      drop trigger if exists trg_%I_updated_at on %I;
      create trigger trg_%I_updated_at
        before update on %I
        for each row execute function update_updated_at();
    ', t, t, t, t);
  end loop;
end $$;

-- ============================================================
-- RLS (Row Level Security): 每个用户只能看自己的数据
-- ============================================================
alter table watchlist enable row level security;
alter table holdings enable row level security;
alter table transactions enable row level security;
alter table journals enable row level security;
alter table alerts enable row level security;
alter table funds enable row level security;
alter table cashflow enable row level security;
alter table kv enable row level security;

do $$
declare t text;
begin
  for t in
    select unnest(array['watchlist','holdings','transactions','journals','alerts','funds','cashflow','kv'])
  loop
    -- SELECT: 只能看自己的
    execute format('
      drop policy if exists "%I_select_own" on %I;
      create policy "%I_select_own" on %I
        for select using (auth.uid() = user_id);
    ', t, t, t, t);

    -- INSERT: user_id 必须是自己
    execute format('
      drop policy if exists "%I_insert_own" on %I;
      create policy "%I_insert_own" on %I
        for insert with check (auth.uid() = user_id);
    ', t, t, t, t);

    -- UPDATE: 只能改自己的
    execute format('
      drop policy if exists "%I_update_own" on %I;
      create policy "%I_update_own" on %I
        for update using (auth.uid() = user_id);
    ', t, t, t, t);

    -- DELETE: 只能删自己的
    execute format('
      drop policy if exists "%I_delete_own" on %I;
      create policy "%I_delete_own" on %I
        for delete using (auth.uid() = user_id);
    ', t, t, t, t);
  end loop;
end $$;

-- ============================================================
-- 完成,看到 "Success" 就是好了
-- ============================================================
