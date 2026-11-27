-- Medição do scanner (27/11/2026): o tempo de cada etapa de um escaneamento, gravado pelo próprio app.
-- Sem dados pessoais além do user_id; cada pessoa só pode inserir os próprios registros e ninguém lê pelo app.
create table if not exists public.scanner_tempos (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  criado_em timestamptz not null default now(),
  modo text not null check (modo in ('scanner', 'comparador')),
  area text check (area in ('pele', 'cabelo', 'corpo')),
  auto_conf boolean not null default false,      -- confirmação automática (confiança >= 90%)
  antecipado boolean not null default false,     -- a comparação já tinha começado em segundo plano
  atalho boolean not null default false,         -- identificação veio do atalho do código de barras
  ms_id integer check (ms_id between 0 and 600000),       -- foto escolhida -> produto identificado
  ms_conf integer check (ms_conf between 0 and 600000),   -- tempo na tela de confirmação
  ms_cmp integer check (ms_cmp between 0 and 600000),     -- confirmação -> nota na tela
  ms_total integer check (ms_total between 0 and 900000), -- foto escolhida -> nota na tela
  ok boolean not null default true
);
create index if not exists scanner_tempos_criado_idx on public.scanner_tempos (criado_em desc);
alter table public.scanner_tempos enable row level security;
revoke all on public.scanner_tempos from anon, authenticated;
grant insert on public.scanner_tempos to authenticated;
create policy "tempos: inserir os proprios" on public.scanner_tempos
  for insert to authenticated with check (user_id = (select auth.uid()));
