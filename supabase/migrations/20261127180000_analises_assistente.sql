-- Assistente (27/11/2026): cada mensagem vira uma linha em analises (tipo 'assistente', resultado null),
-- para o servidor contar o limite diário. O texto da conversa não é guardado no servidor.
alter table public.analises drop constraint if exists analises_tipo_check;
alter table public.analises add constraint analises_tipo_check
  check (tipo = any (array['pele','cabelo','produto','rotina','espinha','assistente']));
create index if not exists analises_user_tipo_data on public.analises (user_id, tipo, criado_em);
