-- Comparador inteligente de produtos (Pellie)
-- Finalidade: (1) cache e cota mensal das explicações por IA do comparador, por usuária;
-- (2) monitoramento de custo (latência, custo estimado, cache) na tabela de uso existente.
-- Aditiva: não altera nem remove nada existente.

-- 1) Monitoramento: novas colunas opcionais em uso_ia
alter table public.uso_ia
  add column if not exists funcao text,
  add column if not exists custo_usd numeric(12,6),
  add column if not exists latencia_ms integer,
  add column if not exists cache_hit boolean not null default false;

-- 2) Cache + reserva de cota das explicações por IA (uma linha por usuária e comparação)
create table if not exists public.comparacoes_ia (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chave text not null check (char_length(chave) between 8 and 128),
  status text not null default 'reservado' check (status in ('reservado','ok','falhou')),
  resultado jsonb,
  modelo text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (user_id, chave)
);
create index if not exists comparacoes_ia_user_mes on public.comparacoes_ia (user_id, criado_em desc);

-- RLS ligada e sem políticas: só a função do servidor (service role) lê e escreve.
alter table public.comparacoes_ia enable row level security;
revoke all on table public.comparacoes_ia from anon, authenticated;

-- 3) Reserva atômica: cache, idempotência, limite de ritmo e cota mensal numa só transação.
create or replace function public.reservar_comparacao(p_user uuid, p_chave text, p_limite integer, p_ritmo integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.comparacoes_ia%rowtype;
  tem boolean := false;
  usadas integer;
  recentes integer;
  ini timestamptz := date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 7));
  select * into r from public.comparacoes_ia where user_id = p_user and chave = p_chave;
  tem := found;
  if tem and r.status = 'ok' then
    return jsonb_build_object('estado','cache','resultado',r.resultado,'modelo',r.modelo,'id',r.id);
  end if;
  if tem and r.status = 'reservado' and r.atualizado_em > now() - interval '90 seconds' then
    return jsonb_build_object('estado','em_andamento');
  end if;
  select count(*) into recentes from public.comparacoes_ia
    where user_id = p_user and status in ('ok','reservado') and criado_em > now() - interval '1 minute';
  if recentes >= p_ritmo then
    return jsonb_build_object('estado','ritmo');
  end if;
  select count(*) into usadas from public.comparacoes_ia
    where user_id = p_user and criado_em >= ini
      and (status = 'ok' or (status = 'reservado' and atualizado_em > now() - interval '5 minutes'))
      and (not tem or id <> r.id);
  if usadas >= p_limite then
    return jsonb_build_object('estado','limite','usadas',usadas,'limite',p_limite);
  end if;
  if tem then
    update public.comparacoes_ia set status='reservado', resultado=null, criado_em=now(), atualizado_em=now() where id = r.id;
    return jsonb_build_object('estado','reservado','id',r.id,'usadas',usadas+1,'limite',p_limite);
  end if;
  insert into public.comparacoes_ia (user_id, chave) values (p_user, p_chave) returning id into r.id;
  return jsonb_build_object('estado','reservado','id',r.id,'usadas',usadas+1,'limite',p_limite);
end;
$$;
revoke all on function public.reservar_comparacao(uuid,text,integer,integer) from public, anon, authenticated;
grant execute on function public.reservar_comparacao(uuid,text,integer,integer) to service_role;
