import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Miniatura limpa do produto: tira a mão da foto e reconstrói só a parte da embalagem que ela cobria.
// Só para assinantes do Pellie Pro (controla o custo). Sem a chave GEMINI_API_KEY o app usa o recorte do próprio aparelho.
const MODELO = Deno.env.get("GEMINI_IMAGE_MODEL") ?? "gemini-3.1-flash-image";
const MAX_IMG_B64 = 2_500_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const PROMPT = `Edit this photo of a skincare or hair product being held in a hand.
Remove the hand and fingers completely and rebuild only the parts of the packaging that the fingers were covering, continuing the existing shape, colors and material.
Do NOT change, redraw, translate or invent any text, logo, brand name, label or ingredient on the packaging. If a part of the label was hidden by a finger, leave that part plain instead of inventing text.
Keep the product exactly as it is: same proportions, same colors, same cap and design, standing upright and centered.
Put it on a plain, uniform white background with no shadows and no other objects.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405);

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json({ codigo: "sem_chave", erro: "Recurso ainda não ativado." }, 503);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: u } = await userClient.auth.getUser();
  if (!u?.user) return json({ codigo: "login", erro: "Entre na sua conta." }, 401);

  // Assinatura e consentimento verificados no servidor (mesma regra da análise).
  const admin = createClient(url, serviceKey);
  const { data: perfil } = await admin.from("profiles").select("plano, plus_ate, consentimento_versao").eq("id", u.user.id).maybeSingle();
  if (!perfil?.consentimento_versao) return json({ codigo: "consentimento", erro: "Aceite a Política de Privacidade." }, 403);
  const plus = perfil?.plano === "plus" && (!perfil.plus_ate || new Date(perfil.plus_ate) > new Date());
  if (!plus) return json({ codigo: "plus", erro: "Recurso do Pellie Pro." }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ erro: "Pedido inválido" }, 400); }
  const imagem = String(body?.imagem ?? "");
  const mediaType = String(body?.media_type ?? "image/jpeg");
  if (!imagem || imagem.length > MAX_IMG_B64) return json({ erro: "Foto inválida" }, 413);
  if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) return json({ erro: "Formato não aceito" }, 400);

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mediaType, data: imagem } }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
    });
    if (!r.ok) return json({ codigo: "ia", erro: "Não funcionou agora." }, 502);
    const out = await r.json();
    const parts: any[] = out?.candidates?.[0]?.content?.parts ?? [];
    const img = parts.map((p) => p.inlineData ?? p.inline_data).find((d) => d?.data);
    if (!img) return json({ codigo: "ia", erro: "Sem imagem." }, 502);
    return json({ ok: true, imagem: img.data, media_type: img.mimeType ?? img.mime_type ?? "image/png" });
  } catch (_e) {
    return json({ codigo: "ia", erro: "Não funcionou agora." }, 502);
  }
});
