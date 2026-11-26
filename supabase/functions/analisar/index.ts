import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { MERCADOS, VALIDADE_DIAS_PADRAO, chaveProduto, validarPreco, expirou } from "./preco.ts";

// Limite mensal do Pellie Pro (controla o custo da IA): 100 análises por mês. Conta pele, cabelo, SOS Espinha e produtos escaneados (a identificação e a comparação do mesmo produto contam como UMA). Textos do assistente e da rotina não entram na conta. Sem assinatura, só a PRIMEIRA análise de pele é gratuita (cadastro, ainda sem login).
const LIMITE_PLUS_MES = 100;
const LIMITE_ESPINHA_DIA = 3;     // SOS Espinha: fotos por dia (controla custo)
const LIMITE_ANON_IP_DIA = 10;     // análises grátis por rede em 24h (sem conta)
const LIMITE_ANON_GLOBAL_DIA = 400; // teto diário de análises sem conta (controla custo)
// Haiku em todas as etapas (20/11/2026, para baixar o custo). TESTE: a COMPARAÇÃO DE PRODUTO (produto_cmp) roda no Haiku COM pensamento (o padrão dele); as outras etapas rodam no Haiku SEM pensamento.
// TESTE (20/11/2026): a reserva no Sonnet está DESLIGADA, para ver como o Haiku se sai sozinho. Se o Haiku falhar, a pessoa recebe a mensagem de erro e a análise não conta no limite. Para ligar de novo: USAR_RESERVA = true.
// O Haiku 5.5 pensa por padrão e o pensamento conta nos tokens de saída (e no tempo).
const MODELO_PADRAO = "claude-haiku-5-5";
const MODELO_RESERVA = "claude-sonnet-5-5";
const USAR_RESERVA = false;
const MODELO_POR_TIPO: Record<string, string> = {};
const COM_PENSAMENTO = new Set(["produto_cmp"]);
const MAX_SAIDA_POR_TIPO: Record<string, number> = { produto_cmp: 8000 };
const MAX_IMG_B64 = 6_000_000;
const MAX_CTX = 2000;
const MAX_PROMPT = 5000;
// Preço de referência (compartilhado): validade configurável por segredo PRECO_VALIDADE_DIAS (padrão 90 dias).
const PRECO_DIAS = Math.max(1, Math.min(365, Number(Deno.env.get("PRECO_VALIDADE_DIAS") ?? VALIDADE_DIAS_PADRAO) || VALIDADE_DIAS_PADRAO));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const FIM = "Não faça diagnóstico, não cite doenças, não tente identificar a pessoa. Seja realista e prudente: uma foto não substitui avaliação presencial.";

const PROMPTS: Record<string, { img: boolean; db: string; texto: (c: string) => string }> = {
  pele: {
    img: true, db: "pele",
    texto: (c) => `Você é uma esteticista que avalia a pele do rosto em uma foto, só para cuidados cosméticos. A pessoa informou: ${c}.
Responda SOMENTE com um JSON.
Se não houver um rosto visível, ou a foto estiver escura, borrada ou com filtro forte, responda {"erro":"frase curta em português pedindo outra foto"}.
Caso contrário, responda neste formato:
{"tipo":"Normal|Mista|Oleosa|Seca|Sensível","resumo":"uma frase em português descrevendo o que você realmente vê NESTA foto (brilho, poros, manchas, textura, vermelhidão)","oleo":0-100,"hid":0-100,"poros":0-100,"manchas":0-100,"linhas":0-100,"verm":0-100,"desafio":"oleo|poros|linhas|manchas|verm|resseca","desafio_regioes":["onde ele mais aparece, entre testa|olhos|nariz|bochechas|queixo"],"ponto_forte":"3 a 5 palavras em português sobre o que está BOM nesta pele, como 'boa hidratação' ou 'tom uniforme'","zonas":{"manchas":["regiões onde há manchas visíveis, entre testa|olhos|nariz|bochechas|queixo, ou []"],"verm":["regiões onde há vermelhidão visível, entre testa|olhos|nariz|bochechas|queixo, ou []"]},"prioridades":["3 frases curtas de cuidado, em português"],"atencao":null ou "uma frase, só se algo na foto merecer avaliação de um dermatologista"}
Significado das notas: oleo = brilho e oleosidade; hid = hidratação (alto é bom); poros = quanto aparecem; manchas; linhas = linhas finas; verm = vermelhidão. "desafio" é o ponto que MAIS se destaca de negativo nesta foto (resseca = pele sem hidratação ou descamando).
Avalie somente o que aparece NESTA foto, sem notas médias nem respostas genéricas: use valores baixos (0-25) quando não houver o problema e altos (65-100) quando ele for claro. Não seja genérica: duas pessoas diferentes devem receber resultados diferentes. Se a pessoa informou um incômodo, use isso só como contexto e não como resposta pronta: o que decide é a foto.
${FIM}`,
  },
  cabelo: {
    img: true, db: "cabelo",
    texto: (c) => `Você é uma especialista em cuidados capilares que avalia o cabelo em uma foto, só para cuidados cosméticos. A pessoa informou: ${c}.
Responda SOMENTE com um JSON.
Se não houver cabelo visível, ou a foto estiver escura ou borrada, responda {"erro":"frase curta em português pedindo outra foto"}.
Caso contrário, use este formato:
{"tipo":"Liso|Ondulado|Cacheado|Crespo","resumo":"uma frase em português, citando o que você vê neste cabelo","raiz":0-100,"pontas":0-100,"poro":0-100,"danos":0-100,"frizz":0-100,"atencao":null ou "uma frase, só se algo na foto merecer avaliação de um tricologista ou dermatologista"}
Avalie o que aparece NESTA foto, sem notas médias: use valores baixos quando não houver o problema e altos quando ele for claro.
Notas: raiz = oleosidade da raiz; pontas = ressecamento das pontas; poro = porosidade (alta absorve e perde água rápido); danos = quebra, pontas duplas e dano visível; frizz.
${FIM}`,
  },
  produto: {
    img: true, db: "produto",
    texto: (c) => `Você é uma esteticista que avalia se um produto de cuidados com a pele combina com uma pessoa. Perfil da pessoa: ${c}.
A imagem mostra a embalagem de um produto, frente e/ou lista de ingredientes. Leia o que estiver legível: nome, tipo, ativos e ingredientes. O rótulo pode estar em coreano, japonês ou outro idioma: leia, traduza os ingredientes para o português e avalie normalmente.
Responda SOMENTE com um JSON.
Se a imagem não mostrar um produto de skincare, ou não der para ler nada útil, responda {"erro":"frase curta em português pedindo outra foto, de preferência do rótulo com os ingredientes"}.
Caso contrário, use este formato:
{"produto":"nome como aparece, ou null","categoria":"limpador|sérum|hidratante|protetor solar|esfoliante|máscara|outro","veredito":"serve|cuidado|evitar","nota":0-100,"ativos":["até 4 ativos principais"],"motivos":["até 3 motivos a favor, em português"],"cuidados":["até 3 pontos de atenção em português, incluindo misturas problemáticas com a rotina atual"],"uso":"uma frase sobre quando e como encaixar na rotina","evitar_encontrados":["ingredientes da lista de evitar da pessoa que aparecem no rótulo, ou []"],"favoritos_encontrados":["ingredientes favoritos da pessoa que aparecem no rótulo, ou []"],"perfis":["até 3 tipos de pele ou condições para os quais combina, como Mista, Acneica, Sensível"],"lista_lida":true ou false}
Use lista_lida true só se leu a lista de ingredientes. Se não leu, avalie pelo tipo e pelo que o rótulo diz e deixe isso claro em cuidados.
Não faça diagnóstico e não prometa resultado. Se houver ativos fortes (retinoide, ácidos), lembre de introduzir aos poucos e usar protetor solar. Seja prudente.`,
  },
  // Scanner Pro, etapa 1: só identificar o produto pelo que está NA FOTO.
  produto_id: {
    img: true, db: "produto",
    texto: (c) => `Você é uma especialista em cosméticos. A imagem mostra a embalagem de um produto. Identifique o produto SOMENTE pelo que aparece na foto. Contexto da pessoa (só para o idioma e o tipo de uso): ${c}.
O rótulo pode estar em português, inglês, coreano, japonês ou outro idioma: leia e traduza para o português.
Responda SOMENTE com um JSON.
Se a imagem não mostrar um produto cosmético de pele ou cabelo, ou não der para ler nada útil, responda {"erro":"frase curta em português pedindo outra foto, mostrando o nome do produto e, se possível, a lista de ingredientes"}.
Caso contrário, use este formato:
{"produto":"nome comercial exatamente como aparece, ou null","marca":"marca como aparece, ou null","variante":"variante ou tipo de pele indicado no nome, ou null","categoria":"limpador|sérum|hidratante|protetor solar|esfoliante|máscara|tônico|maquiagem|cabelo|outro","volume":"como está escrito (ex.: 30 ml), ou null","quantidade":número do volume ou peso, ou null,"unidade":"ml|g|un, ou null","codigo_barras":"dígitos do código de barras, só se estiver legível, ou null","confianca":0-100,"alternativas":[{"produto":"nome","marca":"marca"}],"texto_lido":["até 8 termos ou frases lidos literalmente na embalagem"],"ingredientes_lidos":["ingredientes da lista INCI lidos no rótulo, na ordem, até 30, ou []"],"lista_lida":true ou false,"ativos_declarados":["ativos que a embalagem anuncia, como 'niacinamida 10%', ou []"],"caixa":[x0,y0,x1,y1],"na_mao":true ou false}
confianca = quão seguro você está de que identificou o produto certo pelo que está legível (nome e marca legíveis = alta; só a cor ou o formato = baixa).
alternativas: só se houver dúvida real entre produtos parecidos (até 3); se não houver dúvida, [].
lista_lida = true só se a lista de ingredientes aparece legível na foto.
na_mao = true somente se uma mão ou dedos aparecem segurando o produto ou tocando nele na foto; se o produto está apoiado numa superfície ou não há mão visível, false.
caixa = retângulo justo em volta da embalagem do produto na imagem, em frações de 0 a 1 (x0,y0 = canto superior esquerdo; x1,y1 = canto inferior direito), sem incluir mão, fundo ou barras de tela; se não der para saber, use null.
quantidade, unidade e codigo_barras: só se estiverem escritos e legíveis na embalagem; se não, null.
Nunca invente nome, marca, volume ou ingredientes que não estejam legíveis. Se o nome não estiver legível, use null e confianca baixa.`,
  },
  // Scanner Pro, etapa 2: cruzar o produto confirmado com o perfil (sem foto).
  produto_cmp: {
    img: false, db: "produto",
    texto: (c) => `Você é uma esteticista. Avalie se um produto combina com uma pessoa, só para cuidados cosméticos. Abaixo, em JSON, o que foi lido na embalagem do produto (confirmado pela pessoa) e o perfil dela:
${c}
Responda SOMENTE com um JSON neste formato:
{"resumo":"1 frase curta e personalizada sobre a compatibilidade","finalidade":"2 frases simples: para que o produto serve e o que pode oferecer","por_que":"2 a 3 frases ligando os ativos às necessidades DESTA pessoa, citando pontos do perfil","rotina":{"periodo":"manha|noite|ambos","etapa":"limpeza|tratamento|hidratação|proteção|outro","como":"1 frase sobre como usar","combinar":"1 frase sobre a combinação com a rotina atual, ou null"},"criterios":{"tipo_pele":0,"necessidades":0,"tolerancia":0,"rotina":0},"criterios_motivo":{"tipo_pele":"frase curta","necessidades":"frase curta","tolerancia":"frase curta","rotina":"frase curta"},"ativos":[{"nome":"nome em português","origem":"rotulo|conhecimento","o_que":"o que é","para_que":"para que serve","beneficios":"benefícios conhecidos","cuidados":"cuidados relevantes"}],"alertas":[{"texto":"alerta curto e personalizado","fundamento":"por que esse alerta existe"}],"evitar_encontrados":["ingredientes da lista de evitar da pessoa presentes no produto, ou []"],"nao_confirmado":["o que não deu para confirmar, ou []"]}
Critérios, cada um com nota 0, 1 ou 2:
- tipo_pele: textura e formulação adequadas ao tipo de pele, à oleosidade e à hidratação dela (2 adequado, 1 neutro, 0 inadequado).
- necessidades: quanto os ativos atendem aos desafios do perfil (2 atende bem, 1 em parte, 0 não atende).
- tolerancia: risco de irritação considerando sensibilidade, gestação e ingredientes que ela evita (2 baixo risco, 1 moderado, 0 alto).
- rotina: encaixe na rotina atual sem sobreposição ou excesso de ativos (2 encaixa bem, 1 exige ajuste, 0 conflita).
Regras: em "ativos" (até 6), use origem "rotulo" só para ingredientes presentes em ingredientes_lidos ou ativos_declarados. Use "conhecimento" apenas para ativos amplamente conhecidos DESTE produto quando a lista não foi lida, e liste em nao_confirmado o que não foi confirmado no rótulo. Nunca invente ingredientes nem informações do fabricante.
Alertas só com fundamento real (até 3). Não diga que dois ingredientes são incompatíveis só por aparecerem juntos: considere concentração, formulação, frequência e contexto. Se houver gestação, avise sobre retinoides e ácidos fortes. Se houver ativos fortes, lembre de introduzir aos poucos e usar protetor solar.
${FIM}`,
  },
  espinha: {
    img: true, db: "espinha",
    texto: (c) => `Você é uma esteticista que orienta cuidados cosméticos imediatos para uma espinha ou irritação na pele, vista em uma foto. Contexto da pessoa e produtos que ela TEM em casa: ${c}.
Responda SOMENTE com um JSON.
Se a foto não mostrar pele com uma espinha, cravo ou irritação, ou estiver escura ou borrada, responda {"erro":"frase curta em português pedindo outra foto, mais perto e com boa luz"}.
Caso contrário, use este formato:
{"aspecto":"espinha inflamada|espinha com ponta branca|cravo|cisto profundo|mancha de espinha antiga|irritação ou vermelhidão|outro","resumo":"uma frase em português dizendo o que você vê NESTA foto, sem diagnóstico","agora":["até 4 passos curtos para fazer agora"],"usar":[{"produto":"nome EXATO de um produto da lista que a pessoa tem","como":"como e quando usar neste caso"}],"evitar":["até 3 coisas para NÃO fazer agora"],"acompanhar":[{"quando":"em 2 horas|hoje à noite|amanhã|em 3 dias","o_que":"o que observar ou fazer"}],"faltou":null ou "um tipo de produto que ajudaria e ela não tem, sem citar marca","medico":null ou "uma frase, só se a foto sugerir algo que merece um dermatologista"}
Regras: use em "usar" SOMENTE produtos que estão na lista que a pessoa tem, com o nome igual ao da lista, no máximo 3. Se nenhum servir, deixe "usar" como [] e preencha "faltou". Nunca mande espremer, furar ou arrancar. Não indique remédio nem antibiótico. Se a pessoa está grávida ou amamentando, evite retinoides e salicílico em dose alta e diga isso. Cisto doloroso e profundo, febre, pus que se espalha, muitas lesões novas ou espinha que não melhora em 2 semanas: preencha "medico". Dê no máximo 3 itens em "acompanhar".
${FIM}`,
  },
  // Textos da rotina e marcas de produtos: o app envia o pedido pronto (só para quem é Pellie Pro).
  texto: { img: false, db: "rotina", texto: (c) => c },
};

// Só as 6 notas numéricas (sem foto, sem texto): base para comparar com outras análises da Pellie.
const NOTAS = ["oleo", "hid", "poros", "manchas", "linhas", "verm"];
function soNotas(r: any) {
  const o: Record<string, number> = {};
  for (const k of NOTAS) { const v = Number(r?.[k]); if (Number.isFinite(v)) o[k] = Math.max(0, Math.min(100, Math.round(v))); }
  return Object.keys(o).length === NOTAS.length ? o : null;
}

async function hashIp(ip: string, salt: string) {
  const d = new TextEncoder().encode(ip + "|" + salt);
  const h = await crypto.subtle.digest("SHA-256", d);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Texto curto e seguro para entrar no prompt de preço (sem aspas, chaves nem quebras de linha).
const limpo = (s: unknown, n = 80) => String(s ?? "").replace(/["{}\\\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ codigo: "sem_chave", erro: "A análise ainda não foi ativada no servidor." }, 503);

  const auth = req.headers.get("Authorization") ?? "";
  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: auth } } });
  const { data: u } = await userClient.auth.getUser();
  const user = u?.user ?? null;

  let body: any;
  try { body = await req.json(); } catch { return json({ erro: "Pedido inválido" }, 400); }
  const tipo = String(body?.tipo ?? "");
  const P = PROMPTS[tipo];
  if (!P) return json({ erro: "Tipo de análise inválido" }, 400);
  const longo = tipo === "texto" || tipo === "produto_cmp";
  const contexto = String(tipo === "texto" ? (body?.prompt ?? "") : (body?.contexto ?? "")).slice(0, longo ? MAX_PROMPT : MAX_CTX);
  if (longo && contexto.length < 10) return json({ erro: "Pedido inválido" }, 400);
  const imagem = String(body?.imagem ?? "");
  const mediaType = String(body?.media_type ?? "image/jpeg");
  if (P.img) {
    if (!imagem) return json({ erro: "Envie uma foto" }, 400);
    if (imagem.length > MAX_IMG_B64) return json({ erro: "Foto muito grande. Tente outra." }, 413);
    if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) return json({ erro: "Formato de foto não aceito" }, 400);
  }

  const admin = createClient(url, serviceKey);
  let userId: string | null = null;
  let anonId: number | null = null;
  let gratis = false;

  if (user) {
    userId = user.id;
    const { data: perfil } = await admin.from("profiles").select("plano, plus_ate, consentimento_versao").eq("id", user.id).maybeSingle();
    // LGPD: sem consentimento registrado, nada é enviado para a IA.
    if (!perfil?.consentimento_versao) return json({ codigo: "consentimento", erro: "Aceite a Política de Privacidade para continuar." }, 403);
    const plus = perfil?.plano === "plus" && (!perfil.plus_ate || new Date(perfil.plus_ate) > new Date());
    if (!plus) {
      // Assinatura verificada no servidor: sem Pellie Pro, só a primeira análise de pele.
      if (tipo !== "pele") return json({ codigo: "plus", erro: "Assine o Pellie Pro para usar este recurso." }, 403);
      const { count: jaFez } = await admin.from("analises").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("tipo", "pele");
      if ((jaFez ?? 0) >= 1) return json({ codigo: "plus", erro: "Sua análise gratuita já foi usada. Assine o Pellie Pro para continuar." }, 403);
      gratis = true;
    }
    if (!gratis) {
      const ini = new Date(); ini.setDate(1); ini.setHours(0, 0, 0, 0);
      // Conta análises (pele, cabelo, espinha, produto). A comparação do produto (produto_cmp) e os textos não contam, para cada produto valer 1.
      // A comparação e os textos não são barrados aqui: só a etapa de entrada (foto) é limitada; quem já identificou o produto pode terminar a comparação.
      if (tipo !== "produto_cmp" && tipo !== "texto") {
        const { count } = await admin.from("analises").select("id", { count: "exact", head: true }).eq("user_id", user.id).gte("criado_em", ini.toISOString()).in("tipo", ["pele", "cabelo", "espinha", "produto"]).or("resultado->>etapa.is.null,resultado->>etapa.neq.produto_cmp");
        if ((count ?? 0) >= LIMITE_PLUS_MES) return json({ codigo: "limite_mes", erro: "Você chegou ao limite de 100 análises deste mês." }, 429);
      }
      if (tipo === "espinha") {
        const desde24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const { count: nEsp } = await admin.from("analises").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("tipo", "espinha").gte("criado_em", desde24);
        if ((nEsp ?? 0) >= LIMITE_ESPINHA_DIA) return json({ codigo: "limite_dia", erro: "Você já usou o SOS Espinha 3 vezes hoje. Tente de novo amanhã." }, 429);
      }
    }
  } else {
    // Cadastro sem login: só a análise de PELE, com consentimento informado pelo app, limitada por rede e por dia.
    if (tipo !== "pele") return json({ codigo: "login", erro: "Entre na sua conta para continuar." }, 401);
    const consent = String(body?.consent ?? "");
    if (!consent) return json({ codigo: "consentimento", erro: "Aceite a Política de Privacidade para continuar." }, 403);
    const ip = (req.headers.get("x-forwarded-for") ?? req.headers.get("cf-connecting-ip") ?? "desconhecido").split(",")[0].trim();
    const ipHash = await hashIp(ip, serviceKey.slice(0, 16));
    const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count: nIp } = await admin.from("analises_anon").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("criado_em", desde);
    if ((nIp ?? 0) >= LIMITE_ANON_IP_DIA) return json({ codigo: "limite_gratis", erro: "Você já fez a análise gratuita por aqui. Entre na sua conta para continuar." }, 429);
    const { count: nAll } = await admin.from("analises_anon").select("id", { count: "exact", head: true }).gte("criado_em", desde);
    if ((nAll ?? 0) >= LIMITE_ANON_GLOBAL_DIA) return json({ codigo: "limite_gratis", erro: "Muita gente usando agora. Tente de novo mais tarde." }, 429);
    const { data: ra, error: eA } = await admin.from("analises_anon").insert({ ip_hash: ipHash, consentimento_versao: consent.slice(0, 20) }).select("id").single();
    if (eA || !ra) return json({ erro: "Não consegui iniciar a análise" }, 500);
    anonId = ra.id;
    gratis = true;
  }

  let regId: number | null = null;
  if (userId) {
    const { data: reg, error: eReg } = await admin.from("analises").insert({ user_id: userId, tipo: P.db }).select("id").single();
    if (eReg || !reg) return json({ erro: "Não consegui iniciar a análise" }, 500);
    regId = reg.id;
  }
  const devolver = async () => {
    if (regId !== null) await admin.from("analises").delete().eq("id", regId);
    if (anonId !== null) await admin.from("analises_anon").delete().eq("id", anonId);
  };

  try {
    // ---- Preço de referência (só na comparação do scanner, SEM chamada extra de IA) ----
    // 1) Procura no banco compartilhado. 2) Se existir e estiver vigente, reutiliza e NÃO pede preço à IA.
    // 3) Se não existir (ou venceu), pede a estimativa NA MESMA chamada que já faz a comparação, e valida no servidor.
    let precoEv: string | null = null;
    let pedirPreco = false;
    let precoCtx: { pais: string; moeda: string; chave: any; ref: any } | null = null;
    let precoCache: any = null;
    let precoVelha: any = null;
    if (tipo === "produto_cmp") {
      const pais = String(body?.pais ?? "").toUpperCase().slice(0, 2);
      const ref = body?.ref && typeof body.ref === "object" ? body.ref : null;
      const mk = MERCADOS[pais];
      if (!mk) precoEv = "sem_mercado";
      else if (!ref) precoEv = "sem_ref";
      else {
        const ch = chaveProduto({ codigo: ref.codigo, marca: ref.marca, nome: ref.nome, variante: ref.variante, qtd: ref.qtd, un: ref.un, volume: ref.volume });
        if (!ch.stable || !ch.key) precoEv = "ambiguo_" + ch.motivo;   // sem volume/marca/nome: não inventa e não guarda como referência global
        else {
          precoCtx = { pais, moeda: mk.cur, chave: ch, ref };
          const { data: row, error: eRow } = await admin.from("product_price_cache")
            .select("price_min, price_max, source, expires_at, updated_at")
            .eq("product_key", ch.key).eq("country_code", pais).eq("currency", mk.cur).maybeSingle();
          if (!eRow && row && !expirou(row.expires_at)) { precoCache = row; precoEv = "hit"; }
          else { precoVelha = !eRow && row ? row : null; pedirPreco = true; precoEv = eRow ? "erro_cache_pediu" : precoVelha ? "vencida_pediu" : "miss_pediu"; }
        }
      }
    }
    const content: any[] = [];
    if (P.img) content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: imagem } });
    let textoPrompt = P.texto(contexto || "sem informações");
    if (pedirPreco && precoCtx) {
      const r = precoCtx.ref, q = precoCtx.chave.qtd;
      textoPrompt += `\nInclua também, no mesmo JSON, o campo "market_price":{"status":"available|insufficient_data","country":"${precoCtx.pais}","currency":"${precoCtx.moeda}","estimated_min":número ou null,"estimated_max":número ou null}.\nEstime a faixa de preço de varejo, em ${precoCtx.moeda}, de "${limpo(r.marca)} ${limpo(r.nome)}${r.variante ? " " + limpo(r.variante) : ""}" na embalagem de ${q.n} ${q.u}, no mercado ${precoCtx.pais}. É uma estimativa aproximada, feita de memória, e não uma cotação de lojas. Não pesquise. Se não conhecer este produto neste tamanho com segurança, use status "insufficient_data" com min e max null. Nunca invente números.`;
    }
    content.push({ type: "text", text: textoPrompt });

    // Chama a IA e devolve o texto + o uso de tokens (para medir o custo real).
    const chamar = async (modelo: string) => {
      const corpoIA: Record<string, unknown> = { model: modelo, max_tokens: MAX_SAIDA_POR_TIPO[tipo] ?? 2500, messages: [{ role: "user", content }] };
      if (modelo === MODELO_PADRAO && !COM_PENSAMENTO.has(tipo)) corpoIA.thinking = { type: "disabled" };
      let r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(corpoIA),
      });
      // Se a API recusar o parâmetro de pensamento, repete sem ele (não derruba a análise).
      if (r.status === 400 && corpoIA.thinking) {
        delete corpoIA.thinking;
        r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify(corpoIA),
        });
      }
      if (!r.ok) return { ok: false, txt: "", usage: null as any };
      const out = await r.json();
      const txt: string = (out?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      return { ok: true, txt, usage: out?.usage ?? null };
    };
    const ler = (txt: string) => {
      const m = txt.match(/\{[\s\S]*\}/);
      try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
    };
    let usoId: number | null = null;
    const logUso = async (modelo: string, usage: any, ok: boolean) => {
      try {
        const { data } = await admin.from("uso_ia").insert({
          user_id: userId, tipo, modelo,
          tokens_in: usage?.input_tokens ?? 0, tokens_out: usage?.output_tokens ?? 0,
          tokens_cache: usage?.cache_read_input_tokens ?? 0, ok,
          preco_evento: tipo === "produto_cmp" ? precoEv : null,
        }).select("id").single();
        usoId = data?.id ?? null;
      } catch (_e) { /* o registro de uso nunca derruba a análise */ }
    };

    let modelo = MODELO_POR_TIPO[tipo] ?? MODELO_PADRAO;
    let a = await chamar(modelo);
    let resultado: any = a.ok ? ler(a.txt) : null;
    await logUso(modelo, a.usage, !!resultado);
    // Reserva no Sonnet: desligada durante o teste do Haiku (USAR_RESERVA = false).
    if (!resultado && USAR_RESERVA && modelo !== MODELO_RESERVA) {
      modelo = MODELO_RESERVA;
      a = await chamar(modelo);
      resultado = a.ok ? ler(a.txt) : null;
      await logUso(modelo, a.usage, !!resultado);
    }
    if (!resultado) {
      await devolver();
      return a.ok
        ? json({ codigo: "formato", erro: "Não consegui ler o resultado. Tente outra foto." }, 502)
        : json({ codigo: "ia", erro: "A análise não funcionou agora. Tente de novo." }, 502);
    }
    if (resultado.erro) { await devolver(); return json({ ok: true, resultado }); }

    // ---- Preço: valida a estimativa no servidor e guarda como referência compartilhada ----
    if (tipo === "produto_cmp") {
      const mp = resultado.market_price;
      delete resultado.market_price;   // o app recebe só o campo normalizado "preco"
      const deLinha = (row: any, extra: Record<string, unknown> = {}) => ({
        status: "available", min: Number(row.price_min), max: Number(row.price_max), cur: precoCtx!.moeda, pais: precoCtx!.pais,
        fonte: row.source, at: row.updated_at, shared: true, ...extra,
      });
      if (precoCache) {
        resultado.preco = deLinha(precoCache, { hit: true });
      } else if (pedirPreco && precoCtx) {
        const v = validarPreco(mp, { pais: precoCtx.pais, moeda: precoCtx.moeda });
        if (v.ok && v.min !== null && v.max !== null) {
          const q = precoCtx.chave.qtd, r = precoCtx.ref;
          const { data: reg } = await admin.rpc("registrar_preco_ref", {
            p_key: precoCtx.chave.key, p_brand: limpo(r.marca), p_name: limpo(r.nome, 160), p_variant: r.variante ? limpo(r.variante) : null,
            p_category: r.cat ? limpo(r.cat, 40) : null, p_barcode: String(precoCtx.chave.key).startsWith("gtin:") ? String(precoCtx.chave.key).slice(5) : null,
            p_qty: q.n, p_unit: q.u, p_country: precoCtx.pais, p_currency: precoCtx.moeda, p_min: v.min, p_max: v.max, p_model: modelo, p_dias: PRECO_DIAS,
          });
          if (reg === "mantido") {
            // Outro pedido gravou primeiro (ou a referência ainda vale): usa a que está no banco, para todos verem o mesmo número.
            const { data: atual } = await admin.from("product_price_cache").select("price_min, price_max, source, expires_at, updated_at")
              .eq("product_key", precoCtx.chave.key).eq("country_code", precoCtx.pais).eq("currency", precoCtx.moeda).maybeSingle();
            resultado.preco = atual ? deLinha(atual) : { status: "available", min: v.min, max: v.max, cur: precoCtx.moeda, pais: precoCtx.pais, fonte: "ai_estimate", at: new Date().toISOString(), shared: false };
            precoEv = "gerado_ja_existia";
          } else if (reg === "inserido" || reg === "atualizado") {
            resultado.preco = { status: "available", min: v.min, max: v.max, cur: precoCtx.moeda, pais: precoCtx.pais, fonte: "ai_estimate", at: new Date().toISOString(), shared: true };
            precoEv = reg === "atualizado" ? "gerado_atualizou" : "gerado";
          } else {
            resultado.preco = { status: "insufficient_data", cur: precoCtx.moeda, pais: precoCtx.pais };
            precoEv = "rejeitado_banco";
          }
        } else {
          precoEv = v.motivo === "sem_dados" ? "sem_dados" : "rejeitado_" + v.motivo;
          resultado.preco = precoVelha ? deLinha(precoVelha, { stale: true }) : { status: "insufficient_data", cur: precoCtx.moeda, pais: precoCtx.pais };
        }
      } else {
        resultado.preco = { status: "insufficient_data" };
      }
      if (usoId !== null && precoEv) { try { await admin.from("uso_ia").update({ preco_evento: precoEv }).eq("id", usoId); } catch (_e) { /* métrica */ } }
    }

    // Histórico por usuário: cada etapa do scanner fica guardada em "analises" (resultado em JSON, sem a foto).
    if (regId !== null) await admin.from("analises").update({ resultado: tipo === "texto" ? null : { etapa: tipo, ...resultado } }).eq("id", regId);
    if (anonId !== null && tipo === "pele") { const n = soNotas(resultado); if (n) await admin.from("analises_anon").update({ notas: n }).eq("id", anonId); }
    return json({ ok: true, resultado });
  } catch (_e) {
    await devolver();
    return json({ codigo: "ia", erro: "A análise não funcionou agora. Tente de novo." }, 502);
  }
});
