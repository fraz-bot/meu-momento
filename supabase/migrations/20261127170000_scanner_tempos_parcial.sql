-- Resultado em partes (27/11/2026): tempo até a nota aparecer (antes da análise completa).
alter table public.scanner_tempos add column if not exists ms_parcial integer;
