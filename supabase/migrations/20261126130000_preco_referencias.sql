-- Pellie: banco compartilhado de referências de preço (somente informação COMERCIAL do produto).
-- Nunca guarda fotos, perfil, rotina nem dados da pessoa. Escrita só pelo backend (service_role).
-- Migração aditiva: não altera nem apaga nada existente.

create table if not exists public.product_price_cache (
  id            uuid primary key default gen_random_uuid(),
  product_key   text not null,
  brand         text,
  product_name  text not null,
  variant       text,
  category      text,
  barcode       text,
  quantity      numeric,
  quantity_unit text,
  country_code  text not null,
  currency      text not null,
  price_min     numeric not null,
  price_max     numeric not null,
  source        text not null default 'ai_estimate',   -- futuro: 'observed', 'retailer_api', 'partner'
  model_id      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  constraint ppc_valid_price_range check (price_min > 0 and price_max >= price_min),
  constraint ppc_valid_quantity    check (quantity is null or quantity > 0),
  constraint ppc_valid_country     check (country_code ~ '^[A-Z]{2}$'),
  constraint ppc_valid_currency    check (currency ~ '^[A-Z]{3}$'),
  constraint ppc_valid_key         check (char_length(product_key) between 3 and 300),
  constraint ppc_valid_source      check (source in ('ai_estimate','observed','retailer_api','partner')),
  constraint ppc_unique_product_market unique (product_key, country_code, currency)
);
create index if not exists ppc_expires_idx on public.product_price_cache (expires_at);
create index if not exists ppc_barcode_idx on public.product_price_cache (barcode) where barcode is not null;

alter table public.product_price_cache enable row level security;
create policy ppc_leitura on public.product_price_cache for select to authenticated using (true);
revoke all on public.product_price_cache from anon, authenticated;
grant select on public.product_price_cache to authenticated;   -- leitura; sem política de escrita para clientes

-- Registro do evento de preço em cada chamada de IA do scanner (medição de custo e de reaproveitamento).
alter table public.uso_ia add column if not exists preco_evento text;

-- Escrita idempotente e segura contra concorrência: dois pedidos simultâneos para o mesmo produto/mercado
-- resultam em UMA linha. Referência vigente ou de origem observada nunca é sobrescrita por estimativa de IA.
create or replace function public.registrar_preco_ref(
  p_key text, p_brand text, p_name text, p_variant text, p_category text, p_barcode text,
  p_qty numeric, p_unit text, p_country text, p_currency text,
  p_min numeric, p_max numeric, p_model text, p_dias int default 90
) returns text
language plpgsql security definer set search_path = public as $$
declare ins boolean;
begin
  if p_key is null or char_length(p_key) < 3 or p_key !~ '^(gtin|txt):' then return 'invalido'; end if;
  if p_name is null or p_country !~ '^[A-Z]{2}$' or p_currency !~ '^[A-Z]{3}$' then return 'invalido'; end if;
  if p_min is null or p_max is null or p_min <= 0 or p_max < p_min or p_max / p_min > 3 then return 'invalido'; end if;
  insert into public.product_price_cache as t
    (product_key, brand, product_name, variant, category, barcode, quantity, quantity_unit,
     country_code, currency, price_min, price_max, source, model_id, expires_at)
  values
    (p_key, left(p_brand,80), left(p_name,160), left(p_variant,80), left(p_category,40), left(p_barcode,20), p_qty, left(p_unit,8),
     p_country, p_currency, p_min, p_max, 'ai_estimate', left(p_model,60), now() + make_interval(days => greatest(1, least(p_dias, 365))))
  on conflict (product_key, country_code, currency) do update
    set price_min = excluded.price_min, price_max = excluded.price_max, model_id = excluded.model_id,
        updated_at = now(), expires_at = excluded.expires_at
    where t.source = 'ai_estimate' and t.expires_at <= now()
  returning (xmax = 0) into ins;
  if ins is null then return 'mantido'; end if;
  return case when ins then 'inserido' else 'atualizado' end;
end $$;
revoke all on function public.registrar_preco_ref(text,text,text,text,text,text,numeric,text,text,text,numeric,numeric,text,int) from public, anon, authenticated;
grant execute on function public.registrar_preco_ref(text,text,text,text,text,text,numeric,text,text,text,numeric,numeric,text,int) to service_role;

-- Painel de custo: consultas ao cache, reaproveitamento, estimativas geradas/rejeitadas e tokens por evento.
create or replace view public.vw_preco_metricas with (security_invoker = true) as
select date_trunc('day', criado_em)::date as dia,
       coalesce(preco_evento, 'sem_evento') as evento,
       count(*) as chamadas,
       round(avg(tokens_in)) as tokens_in_medio,
       round(avg(tokens_out)) as tokens_out_medio,
       max(modelo) as modelo
from public.uso_ia
where tipo = 'produto_cmp'
group by 1, 2;
revoke all on public.vw_preco_metricas from anon, authenticated;
grant select on public.vw_preco_metricas to service_role;
