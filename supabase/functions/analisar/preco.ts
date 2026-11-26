// Preços de referência do Pellie: normalização, chave estável do produto e validação de estimativas.
// Este arquivo é IDÊNTICO em supabase/functions/analisar e supabase/functions/comparar (cada função é publicada separadamente).
// Guarda só informação COMERCIAL do produto. Nunca recebe fotos, perfil nem dados da pessoa.

// Mercados aceitos (país -> moeda). Para ligar um novo mercado, basta acrescentar uma linha.
export const MERCADOS: Record<string, { cur: string }> = {
  BR: { cur: "BRL" }, US: { cur: "USD" }, PT: { cur: "EUR" }, IT: { cur: "EUR" }, ES: { cur: "EUR" },
  FR: { cur: "EUR" }, DE: { cur: "EUR" }, GB: { cur: "GBP" }, CA: { cur: "CAD" },
};

export const VALIDADE_DIAS_PADRAO = 90;
const AMPLITUDE_MAX = 3;      // preço máximo / preço mínimo
const PRECO_MIN_ABS = 1;      // abaixo disso não é um cosmético plausível
const PRECO_MAX_ABS = 3000;   // acima disso é quase certamente um erro da estimativa

export const semAcento = (s: unknown): string =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const ABREV: Record<string, string> = { spf: "fps", gr: "g", grs: "g", lt: "l", lts: "l", mililitros: "ml", mililitro: "ml", gramas: "g", grama: "g" };

// Texto comparável: sem acento, minúsculo, sem pontuação, espaços únicos e abreviações conhecidas unificadas.
export function norm(s: unknown): string {
  return semAcento(s).replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).map((w) => ABREV[w] ?? w).join(" ");
}

export function gtinValido(c: unknown): string | null {
  const d = String(c ?? "").replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(d.length)) return null;
  let soma = 0;
  for (let i = d.length - 2, peso = 3; i >= 0; i--, peso = peso === 3 ? 1 : 3) soma += Number(d[i]) * peso;
  return (10 - (soma % 10)) % 10 === Number(d[d.length - 1]) ? d : null;
}

const UNIDADES: Record<string, [string, number]> = {
  ml: ["ml", 1], l: ["ml", 1000], g: ["g", 1], kg: ["g", 1000],
  "fl oz": ["ml", 29.5735], floz: ["ml", 29.5735], oz: ["oz", 1],
  un: ["un", 1], und: ["un", 1], unid: ["un", 1], unidade: ["un", 1], unidades: ["un", 1], pcs: ["un", 1], caps: ["un", 1], capsulas: ["un", 1], sache: ["un", 1], sachet: ["un", 1],
};

// Quantidade normalizada: ml, g, un ou oz. Aceita (qtd, unidade) ou um texto como "150 ml".
export function parseQtd(qtd: unknown, un?: unknown, texto?: unknown): { n: number; u: string } | null {
  let n = Number(String(qtd ?? "").replace(",", "."));
  let u = norm(un);
  if (!(n > 0) || !u) {
    const m = semAcento(texto).replace(",", ".").match(/(\d+(?:\.\d+)?)\s*(fl\.? ?oz|ml|l|g|kg|oz|un|und|unid|unidades?|caps|capsulas|pcs|sach[eê]t?)\b/);
    if (!m) return null;
    n = Number(m[1]); u = norm(m[2]).replace("fl oz", "floz");
  }
  u = u.replace("fl oz", "floz");
  const def = UNIDADES[u];
  if (!def || !(n > 0) || n > 100000) return null;
  return { n: Math.round(n * def[1] * 10) / 10, u: def[0] };
}

export interface RefProduto { codigo?: unknown; marca?: unknown; nome?: unknown; variante?: unknown; qtd?: unknown; un?: unknown; volume?: unknown; cat?: unknown }
export interface Chave { key: string | null; stable: boolean; motivo: string; qtd: { n: number; u: string } | null }

// Chave estável: 1) código de barras válido; 2) marca + nome + variante + volume + unidade normalizados.
// Embalagens de tamanhos diferentes têm chaves diferentes. Sem volume/marca/nome a identificação é ambígua: não vira referência global.
export function chaveProduto(r: RefProduto): Chave {
  const qtd = parseQtd(r.qtd, r.un, r.volume);
  const g = gtinValido(r.codigo);
  if (g) return { key: "gtin:" + g, stable: true, motivo: "codigo_de_barras", qtd };
  const marca = norm(r.marca);
  let nome = norm(r.nome);
  if (marca && nome.startsWith(marca + " ")) nome = nome.slice(marca.length + 1);
  const variante = norm(r.variante);
  if (!nome) return { key: null, stable: false, motivo: "sem_nome", qtd };
  if (!marca) return { key: null, stable: false, motivo: "sem_marca", qtd };
  if (!qtd) return { key: null, stable: false, motivo: "sem_volume", qtd };
  return { key: `txt:${marca}|${nome}|${variante}|${qtd.n}${qtd.u}`.slice(0, 300), stable: true, motivo: "nome_marca_volume", qtd };
}

export interface Validacao { ok: boolean; min: number | null; max: number | null; motivo: string }

// Confere a COERÊNCIA da estimativa (não prova que o preço corresponde ao mercado real).
export function validarPreco(mp: any, esperado: { pais: string; moeda: string }): Validacao {
  const ruim = (motivo: string): Validacao => ({ ok: false, min: null, max: null, motivo });
  if (!mp || typeof mp !== "object") return ruim("formato");
  if (mp.status !== "available") return ruim("sem_dados");
  const min = typeof mp.estimated_min === "number" ? mp.estimated_min : NaN;
  const max = typeof mp.estimated_max === "number" ? mp.estimated_max : NaN;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return ruim("nao_numerico");
  if (min <= 0 || max <= 0) return ruim("nao_positivo");
  if (max < min) return ruim("max_menor_que_min");
  if (mp.currency && String(mp.currency).toUpperCase() !== esperado.moeda) return ruim("moeda");
  if (mp.country && String(mp.country).toUpperCase() !== esperado.pais) return ruim("pais");
  if (min < PRECO_MIN_ABS || max > PRECO_MAX_ABS) return ruim("fora_do_plausivel");
  if (max / min > AMPLITUDE_MAX) return ruim("amplitude");
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return { ok: true, min: r2(min), max: r2(max), motivo: "ok" };
}

export const expirou = (expiresAt: string | null | undefined, agora = Date.now()): boolean =>
  !expiresAt || new Date(expiresAt).getTime() <= agora;
