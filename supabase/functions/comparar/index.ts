import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Comparador de produtos do Pellie: explicação COMPLEMENTAR por IA.
// A comparação em si é calculada no aplicativo (sem tokens). Esta função só interpreta, em poucas linhas,
// os dados já estruturados de dois produtos já analisados. Nunca recebe fotos nem o histórico da conta.
//
// Modelo CONFIGURÁVEL e independente das outras funções: segredo MODELO_COMPARADOR (padrão: o Haiku 5.5,
// já em uso na função "analisar"). Preços (US$ por milhão de tokens) também configuráveis, só para a estimativa de custo.
const MODELO = Deno.env.get("MODELO_COMPARADOR") || "claude-haiku-5-5";
const PRECO_IN = Number(Deno.env.get("COMPARADOR_PRECO_IN_USD_MTOK") ?? "0.10");
const PRECO_OUT = Number(Deno.env.get("COMPARADOR_PRECO_OUT_USD_MTOK") ?? "0.50");
const PRECO_CACHE = Number(Deno.env.get("COMPARADOR_PRECO_CACHE_USD_MTOK") ?? "0.01");
const PROMPT_V = "cmp-ia-2";
const LIMITE_MES = 20;        // novas explicações por IA por mês (comparações determinísticas não contam)
const LIMITE_RITMO_MIN = 4;   // no máximo 4 explicações novas por minuto
const MAX_DADOS = 6500;       // caracteres do contexto estruturado (≈ 1.500 tokens)
const MAX_SAIDA = 700;        // teto de tokens de saída (meta: ~300)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const DECISOES = ["product_a", "product_b", "equivalent", "complementary", "insufficient_data"];

async function sha256(t: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const PROMPT = (dados: string) => `Você é uma esteticista que explica, em português do Brasil e em poucas linhas, a comparação entre dois produtos cosméticos (A e B) para UMA pessoa. Só cuidados cosméticos.
DADOS (JSON, já calculados pelo aplicativo; não existem outros dados):
${dados}
Responda SOMENTE com um JSON neste formato:
{"decision":"product_a|product_b|equivalent|complementary|insufficient_data","summary":"até 2 frases objetivas","reasons":["até 3 motivos curtos"],"cautions":["até 3 pontos de atenção curtos"],"limitations":["até 2 limites desta comparação"]}
Regras:
- "decision" deve ser IGUAL a "decisao_base" dos dados. Você só explica; não muda a decisão.
- Use SOMENTE informações presentes nos dados. Não invente ingredientes, preços, notas ou efeitos. Não escreva valores em reais nem porcentagens que não estejam nos dados.
- Considere o perfil da pessoa, os ativos, a tolerância, os alertas e o encaixe na rotina. Se faltar informação, diga em "limitations".
- Sem diagnóstico, sem garantia de resultado, sem alegação médica. Não diga que o mais barato é melhor. Tom acolhedor e prudente.
- Refira-se aos produtos pelo NOME (campo "nome" de cada um), nunca por "A" ou "B", porque a ordem pode ser invertida na tela.`;

// Frases que não passam: dinheiro, garantias e alegações médicas.
const PROIBIDO = /r\$|reais|garant|cura\b|curar|trata[rm]? (a |o )?(doen|dermat|acne grave)|clinicamente|comprovad[oa] (cientific|clinic)|100 ?%/i;

function limpar(s: unknown, max: number, permitidos: Set<string>): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim().slice(0, max);
  if (!t || PROIBIDO.test(t)) return null;
  // números só se vierem dos dados enviados (a IA não pode inventar pontuações)
  for (const n of t.match(/\d+(?:[.,]\d+)?/g) ?? []) if (!permitidos.has(n.replace(",", "."))) return null;
  return t;
}
function validar(r: any, base: string, dados: string) {
  if (!r || typeof r !== "object") return null;
  const permitidos = new Set<string>((dados.match(/\d+(?:\.\d+)?/g) ?? []));
  const lista = (a: unknown, n: number, m: number) =>
    (Array.isArray(a) ? a : []).map((x) => limpar(x, m, permitidos)).filter((x): x is string => !!x).slice(0, n);
  const out = {
    decision: base, // a decisão é a do aplicativo; o texto da IA apenas a explica
    summary: limpar(r.summary, 260, permitidos) ?? "",
    reasons: lista(r.reasons, 3, 150),
    cautions: lista(r.cautions, 3, 150),
    limitations: lista(r.limitations, 2, 130),
  };
  if (!out.summary && !out.reasons.length) return null;
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405);
  const t0 = Date.now();

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ codigo: "sem_chave", erro: "A explicação ainda não foi ativada no servidor." }, 503);

  // 1) Autenticação: só contas logadas.
  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: u } = await userClient.auth.getUser();
  const user = u?.user ?? null;
  if (!user) return json({ codigo: "login", erro: "Entre na sua conta para continuar." }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ erro: "Pedido inválido" }, 400); }
  const admin = createClient(url, serviceKey);

  // 2) Assinatura e consentimento verificados no servidor (nada vem do cliente).
  const { data: perfil } = await admin.from("profiles").select("plano, plus_ate, consentimento_versao").eq("id", user.id).maybeSingle();
  if (!perfil?.consentimento_versao) return json({ codigo: "consentimento", erro: "Aceite a Política de Privacidade para continuar." }, 403);
  const plus = perfil?.plano === "plus" && (!perfil.plus_ate || new Date(perfil.plus_ate) > new Date());
  if (!plus) return json({ codigo: "plus", erro: "Assine o Pellie Pro para usar este recurso." }, 403);

  const ini = new Date(); ini.setDate(1); ini.setHours(0, 0, 0, 0);
  const saldo = async () => {
    const { count } = await admin.from("comparacoes_ia").select("id", { count: "exact", head: true })
      .eq("user_id", user.id).gte("criado_em", ini.toISOString()).eq("status", "ok");
    return { usadas: count ?? 0, limite: LIMITE_MES };
  };
  if (body?.acao === "saldo") return json({ ok: true, ...(await saldo()) });

  // 3) Validação do pedido.
  const chaveCli = String(body?.chave ?? "");
  const base = String(body?.base ?? "");
  const dados = typeof body?.dados === "string" ? body.dados : JSON.stringify(body?.dados ?? "");
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(chaveCli) || !DECISOES.includes(base) || dados.length < 20) return json({ erro: "Pedido inválido" }, 400);
  if (dados.length > MAX_DADOS) return json({ codigo: "grande", erro: "Comparação grande demais para explicar." }, 413);
  if (base === "insufficient_data") return json({ codigo: "dados", erro: "Faltam dados para explicar esta comparação." }, 422);

  // 4) Chave do cache: do app + versão do prompt + modelo + usuária (nunca compartilhado entre contas).
  const chave = (await sha256(`${user.id}|${chaveCli}|${PROMPT_V}|${MODELO}`)).slice(0, 48);

  // 5) Reserva atômica: cache, idempotência, ritmo e cota mensal na mesma transação.
  const { data: rv, error: eRv } = await admin.rpc("reservar_comparacao", { p_user: user.id, p_chave: chave, p_limite: LIMITE_MES, p_ritmo: LIMITE_RITMO_MIN });
  if (eRv || !rv) return json({ codigo: "ia", erro: "Não consegui preparar a explicação agora. Tente de novo." }, 502);
  const logUso = async (extra: Record<string, unknown>) => {
    try { await admin.from("uso_ia").insert({ user_id: user.id, tipo: "comparar", funcao: "comparador", modelo: MODELO, ...extra }); } catch (_e) { /* nunca derruba */ }
  };
  if (rv.estado === "cache") {
    await logUso({ tokens_in: 0, tokens_out: 0, tokens_cache: 0, ok: true, cache_hit: true, custo_usd: 0, latencia_ms: Date.now() - t0 });
    return json({ ok: true, cache: true, resultado: rv.resultado, ...(await saldo()) });
  }
  if (rv.estado === "em_andamento") return json({ codigo: "em_andamento", erro: "Já estou preparando esta explicação. Aguarde alguns segundos." }, 409);
  if (rv.estado === "ritmo") return json({ codigo: "ritmo", erro: "Muitos pedidos seguidos. Tente de novo em instantes." }, 429);
  if (rv.estado === "limite") return json({ codigo: "limite_ia", erro: `Você usou as ${LIMITE_MES} explicações por IA deste mês. A comparação continua disponível.`, usadas: rv.usadas, limite: LIMITE_MES }, 429);
  const id = rv.id as string;
  const falhar = async (usage: any, motivo: string) => {
    await admin.from("comparacoes_ia").update({ status: "falhou", atualizado_em: new Date().toISOString() }).eq("id", id);
    await logUso({ tokens_in: usage?.input_tokens ?? 0, tokens_out: usage?.output_tokens ?? 0, tokens_cache: usage?.cache_read_input_tokens ?? 0, ok: false, cache_hit: false, latencia_ms: Date.now() - t0 });
    return json({ codigo: motivo, erro: "Não consegui preparar a explicação agora. A comparação continua disponível." }, 502);
  };

  // 6) Chamada ao modelo (contexto compacto, saída curta em JSON, sem fotos).
  try {
    const corpo: Record<string, unknown> = { model: MODELO, max_tokens: MAX_SAIDA, messages: [{ role: "user", content: PROMPT(dados) }] };
    if (MODELO.includes("haiku")) corpo.thinking = { type: "disabled" };
    const chamar = () => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(corpo),
    });
    let r = await chamar();
    if (r.status === 400 && corpo.thinking) { delete corpo.thinking; r = await chamar(); }
    if (!r.ok) return await falhar(null, "ia");
    const out = await r.json();
    const usage = out?.usage ?? null;
    const txt: string = (out?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const m = txt.match(/\{[\s\S]*\}/);
    let bruto: any = null;
    try { bruto = m ? JSON.parse(m[0]) : null; } catch { bruto = null; }
    const resultado = validar(bruto, base, dados);
    if (!resultado) return await falhar(usage, "formato");

    const ti = usage?.input_tokens ?? 0, to = usage?.output_tokens ?? 0, tc = usage?.cache_read_input_tokens ?? 0;
    const custo = (ti * PRECO_IN + to * PRECO_OUT + tc * PRECO_CACHE) / 1e6;
    await admin.from("comparacoes_ia").update({ status: "ok", resultado, modelo: MODELO, atualizado_em: new Date().toISOString() }).eq("id", id);
    await logUso({ tokens_in: ti, tokens_out: to, tokens_cache: tc, ok: true, cache_hit: false, custo_usd: Number(custo.toFixed(6)), latencia_ms: Date.now() - t0 });
    return json({ ok: true, cache: false, resultado, tokens: { entrada: ti, saida: to }, ...(await saldo()) });
  } catch (_e) {
    return await falhar(null, "ia");
  }
});
