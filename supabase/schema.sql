-- MyPocket: Supabase schema + Row Level Security
-- Supabase Dashboard → SQL Editor 에서 이 파일을 실행하세요.

-- 1) cards 테이블 (사용자별 플래시카드)
-- PK는 (user_id, id): 프리셋 id(t1 등)가 사용자마다 같아도 충돌하지 않음
create table if not exists public.cards (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  cat text not null default 'user',
  en text not null,
  ko text not null,
  usage text not null default '',
  ex text not null default '',
  source text not null default 'user',
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists cards_user_id_idx on public.cards (user_id);

-- 2) updated_at 자동 갱신
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists cards_set_updated_at on public.cards;
create trigger cards_set_updated_at
  before update on public.cards
  for each row
  execute function public.set_updated_at();

-- 3) RLS: 본인 데이터만 조회/수정/삭제
alter table public.cards enable row level security;

drop policy if exists "cards_select_own" on public.cards;
create policy "cards_select_own"
  on public.cards for select
  using (auth.uid() = user_id);

drop policy if exists "cards_insert_own" on public.cards;
create policy "cards_insert_own"
  on public.cards for insert
  with check (auth.uid() = user_id);

drop policy if exists "cards_update_own" on public.cards;
create policy "cards_update_own"
  on public.cards for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "cards_delete_own" on public.cards;
create policy "cards_delete_own"
  on public.cards for delete
  using (auth.uid() = user_id);
