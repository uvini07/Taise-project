// Polaroidy no painel ANTIGO da Taíse (site de Natal, repositório taise-project).
//
// A Taíse usa a plataforma antiga temporariamente, até migrar para a Revela.
// Enquanto isso, a Polaroidy também funciona lá: o painel antigo (index.html,
// Firebase "taisesite") chama esta função, que só conversa com a IA. Os dados
// (agendamentos, pagamentos) são lidos pelo próprio painel com o login da
// Taíse e voltam para cá como resultado das ferramentas. A chave da IA fica só
// na Vercel deste projeto (API_CLAUDE_KEY).
//
// Quando a migração terminar, este arquivo pode ser apagado.
import Anthropic from "@anthropic-ai/sdk";
import { createRemoteJWKSet, jwtVerify } from "jose";

const MODEL = "claude-haiku-5-5";
const PROJECT = "taisesite"; // Firebase do site antigo
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
// Mesma lista de admins do firestore.rules do site antigo.
const ADMINS = (process.env.POLAROIDY_NATAL_ADMINS || "PIyrdiQ5DXVJuRQFSSJ84yLtl7A2").split(",").map((s) => s.trim()).filter(Boolean);
const DAILY_LIMIT = 250;

const noArgs = { type: "object", properties: {}, required: [], additionalProperties: false };
const str = (description) => ({ type: "string", description });
const periodo = {
  type: "object",
  properties: { de: str("Data inicial AAAA-MM-DD"), ate: str("Data final AAAA-MM-DD") },
  required: ["de", "ate"],
  additionalProperties: false,
};

export const TOOLS = [
  { name: "agenda", description: "Lista os ensaios marcados (pendentes e confirmados) entre duas datas, inclusive. Para 'hoje', use a data de hoje nas duas pontas.", strict: true, input_schema: periodo },
  { name: "pedidos_pendentes", description: "Pedidos de agendamento feitos pelo site que ainda esperam a confirmação da Taíse.", strict: true, input_schema: noArgs },
  { name: "resumo_vendas", description: "Resumo da temporada: quantos pedidos, total vendido, quanto já entrou (sinais e quitados), quanto falta receber e vendas por pacote e por lote. Use para 'quanto vendi', 'quanto recebi', 'qual pacote vende mais'.", strict: true, input_schema: noArgs },
  { name: "pagamentos_pendentes", description: "Clientes com pagamento em aberto (sem sinal ou só com sinal), com valor que falta e WhatsApp. Use para 'quem não pagou', 'cobrar clientes'. O painel mostra sozinho um botão 'Cobrar no WhatsApp' para cada uma.", strict: true, input_schema: noArgs },
  { name: "cliente", description: "Busca uma cliente pelo nome (ou parte dele): ensaios, pacote, situação, valores e WhatsApp.", strict: true, input_schema: { type: "object", properties: { nome: str("Nome ou parte do nome") }, required: ["nome"], additionalProperties: false } },
  { name: "horarios_livres", description: "Horários livres da agenda num dia da temporada. Use para 'tenho horário sábado?'.", strict: true, input_schema: { type: "object", properties: { data: str("Dia AAAA-MM-DD") }, required: ["data"], additionalProperties: false } },
  { name: "lista_vip", description: "Situação da lista VIP (ligada, lançada, cadastro aberto) e número de inscritos.", strict: true, input_schema: noArgs },
  { name: "mensagem_whatsapp", description: "Prepara uma mensagem no WhatsApp para uma cliente da agenda. O painel mostra um botão para a Taíse revisar e enviar. Tipos: confirmacao, lembrete, fotos_prontas, depoimento. Para cobrança, use pagamentos_pendentes.", strict: true, input_schema: { type: "object", properties: { cliente: str("Nome da cliente"), tipo: { type: "string", enum: ["confirmacao", "lembrete", "fotos_prontas", "depoimento"] } }, required: ["cliente", "tipo"], additionalProperties: false } },
  { name: "preparar_confirmacao", description: "Quando a Taíse pedir para confirmar um pedido: encontra o pedido pendente pelo nome e mostra um botão 'Confirmar'. Só confirma quando ela toca.", strict: true, input_schema: { type: "object", properties: { cliente: str("Nome da cliente") }, required: ["cliente"], additionalProperties: false } },
  { name: "preparar_pagamento", description: "Quando a Taíse disser que uma cliente pagou: mostra um botão para marcar 'sinal pago' ou 'quitado' com o valor. Só registra quando ela toca. Use valor_reais 0 para o valor sugerido (sinal do pacote ou o saldo todo).", strict: true, input_schema: { type: "object", properties: { cliente: str("Nome da cliente"), marco: { type: "string", enum: ["sinal", "quitado"] }, valor_reais: { type: "number", description: "Valor pago em reais (0 = sugerido)" } }, required: ["cliente", "marco", "valor_reais"], additionalProperties: false } },
];

const SYSTEM = `Você é a Polaroidy, a assistente virtual da Taíse (Taise Rufino Fotografia) dentro do painel do site de Natal. Este é o painel antigo, usado temporariamente até a migração para a Revela.

Como responder:
- Português do Brasil, simpático, direto e curto (no máximo uns 6 itens ou linhas). Use **negrito** e listas com "- " quando ajudar.
- Dados (agenda, pedidos, pagamentos, vendas, VIP): SEMPRE use as ferramentas. Nunca invente nomes, horários, valores ou datas. Se a ferramenta não trouxer nada, diga isso.
- Cada ensaio traz "uso_de_imagem" (se a cliente autorizou usar as fotos no site e nas redes) e "pet" (se vai levar pet). Para "quem autorizou imagem" ou "quem leva pet", use a ferramenta agenda no período perguntado (ou a temporada toda) e responda pelos campos. "Não informado" é pedido antigo, feito antes dessas perguntas existirem.
- Quando mostrar o WhatsApp de uma cliente (pelas ferramentas agenda ou cliente), o painel já coloca abaixo da resposta um botão "Mandar mensagem para (nome)". Diga que é só tocar nele.
- Você só lê, sugere e prepara. Nunca envia, cobra, confirma ou registra nada sozinha: para isso aparecem botões abaixo da resposta (Cobrar no WhatsApp, Enviar no WhatsApp, Confirmar, Registrar) e a Taíse decide se toca. Nunca diga que algo já foi feito.
- Em vendas, diferencie "vendido" (valor dos pedidos) de "recebido" (o que já entrou: sinais e quitações marcados na guia Pagamentos).
- Você também ajuda a escrever: legenda de Instagram, texto de campanha de Natal, resposta para cliente. Tom acolhedor, sem exageros.
- Dicas: no máximo 3 sugestões práticas, baseadas nos números.
- Valores no formato R$ 1.234,56. Datas no formato 25/12 (com o dia da semana quando ajudar).
- Onde fica cada coisa no painel (guias no topo): **Agendamentos** (lista de pedidos, confirmar, cancelar, editar, mensagens no WhatsApp, lista VIP), **Agenda** (horários do mês, criar e remover horário ou data), **Pagamentos** (marcar sinal e quitado), **Financeiro** (vendas da temporada por pacote e ao longo do tempo).
- Se não souber ou for algo fora do painel, diga que não sabe.`;

const used = new Map();
function overLimit(uid) {
  const day = new Date().toISOString().slice(0, 10);
  const u = used.get(uid);
  if (!u || u.day !== day) { used.set(uid, { day, n: 1 }); return false; }
  u.n += 1;
  return u.n > DAILY_LIMIT;
}

async function userFrom(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: `https://securetoken.google.com/${PROJECT}`, audience: PROJECT });
    return payload.sub ? payload : null;
  } catch {
    return null;
  }
}

const isText = (v, max) => typeof v === "string" && v.length <= max;

export default async function handler(req, res) {
  // O painel antigo fica em outro endereço: libera a chamada do navegador.
  // Sem cookies; quem protege é o token do Firebase + a lista de admins.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const apiKey = process.env.API_CLAUDE_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "A Polaroidy ainda não foi ligada: falta a chave da IA (API_CLAUDE_KEY) na Vercel." });

  const user = await userFrom(req);
  if (!user) return res.status(401).json({ error: "Entre no painel para usar a Polaroidy." });
  if (!ADMINS.includes(user.sub)) return res.status(403).json({ error: "Esta conta não é administradora do site." });

  const { messages, context = {}, feedback } = req.body || {};
  if (feedback) {
    console.log(JSON.stringify({ polaroidy: "feedback", painel: "natal", good: !!feedback.good, question: String(feedback.question || "").slice(0, 300) }));
    return res.status(200).json({ ok: true });
  }
  if (overLimit(user.sub)) return res.status(429).json({ error: `Você usou as ${DAILY_LIMIT} perguntas de hoje. Amanhã a Polaroidy volta.` });
  if (!Array.isArray(messages) || !messages.length || messages.length > 60 || JSON.stringify(messages).length > 120000) {
    return res.status(400).json({ error: "Conversa inválida ou longa demais. Comece uma nova conversa." });
  }
  const today = isText(context.today, 10) ? context.today : new Date().toISOString().slice(0, 10);
  const weekday = isText(context.weekday, 20) ? context.weekday : "";
  const season = isText(context.season, 60) ? context.season : "";

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: [
        { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
        { type: "text", text: `Hoje é ${weekday} ${today}.${season ? ` Temporada de ensaios: ${season}.` : ""}` },
      ],
      tools: TOOLS,
      output_config: { effort: "low" },
      messages,
    });
    console.log(JSON.stringify({ polaroidy: "uso", painel: "natal", input: response.usage?.input_tokens, output: response.usage?.output_tokens, cache_read: response.usage?.cache_read_input_tokens, tools: response.content.filter((b) => b.type === "tool_use").map((b) => b.name) }));
    return res.status(200).json({ content: response.content, stop_reason: response.stop_reason });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "A Polaroidy está ocupada agora. Tente de novo em instantes." });
    if (err instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: "A chave da IA na Vercel (API_CLAUDE_KEY) não foi aceita." });
    if (err instanceof Anthropic.BadRequestError) return res.status(400).json({ error: "Não consegui entender essa conversa. Comece uma nova." });
    if (err instanceof Anthropic.APIError) return res.status(502).json({ error: "A IA não respondeu agora. Tente de novo." });
    return res.status(500).json({ error: "Erro inesperado na Polaroidy." });
  }
}
