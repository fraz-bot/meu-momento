-- Atalho pelo código de barras (27/11/2026): guarda a identificação de um produto (feita pela IA) pelo código de barras.
-- Da próxima vez que alguém escanear o mesmo código, a função "analisar" devolve isto sem chamar a IA.
-- Só a função (service_role) lê e grava. Não guarda nada da pessoa nem da foto (só dados do produto).
create table if not exists public.produto_ident_cache (
  codigo text primary key check (codigo ~ '^[0-9]{8,14}$'),
  resultado jsonb not null,
  confianca integer not null check (confianca between 0 and 100),
  lista_lida boolean not null default false,
  usos integer not null default 0,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
alter table public.produto_ident_cache enable row level security;
revoke all on public.produto_ident_cache from anon, authenticated;
grant select, insert, update on public.produto_ident_cache to service_role;
