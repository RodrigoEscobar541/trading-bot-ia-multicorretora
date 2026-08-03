// iaClient.js — ÚNICO ponto de contato com a API do Gemini (CLAUDE.md §9).
//
// A IA recebe apenas o prompt base (promptBase.md) + o JSON estruturado do
// cenário (CLAUDE.md §6.1). Ela nunca recebe credenciais, ferramentas, imagens
// ou acesso a rede — apenas interpreta e devolve a decisão (regras.md §1.1).
//
// Dois consumidores, o mesmo transporte:
//   - `decidir()`   — o ANALISTA, a cada ciclo de cada ativo (devolve decisão
//                     já validada; resposta malformada vira AGUARDAR).
//   - `consultar()` — o SUPERVISOR semanal (V7.2), que audita o analista e
//                     devolve texto JSON cru para quem chamou validar. Ele NÃO
//                     decide ordem nenhuma, então não faz sentido reaproveitar
//                     o validador de decisão nem o fallback AGUARDAR.
// Ambos passam pela MESMA cadeia de modelos com fallback — a disciplina de
// fronteira é que nenhum outro módulo conheça a API do Gemini.
//
// Contrato de erros (CLAUDE.md §14):
//   - Falha de rede/timeout/HTTP da API da IA → lança ErroIA; quem chama loga
//     e PULA a iteração (não vira AGUARDAR — a análise simplesmente não houve).
//   - HTTP 200 com conteúdo malformado → NÃO lança: loga como erro e devolve
//     decisão segura AGUARDAR com `valida: false` (a análise houve, e a
//     resposta inválida fica registrada no histórico).
//
// Desacoplamento (CLAUDE.md §15): este módulo é a única fronteira com o
// provedor. Trocar/adicionar IA = criar outro client com a mesma assinatura
// `decidir(cenario, opcoes)`; nenhum outro módulo conhece detalhes do Gemini.

import { readFileSync } from 'node:fs';
import { log } from '../utils/logger.js';
import { validarResposta } from './validadorResposta.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// CADEIA de modelos, do melhor para o reserva (config `modelos_ia`).
// Cada modelo tem quota diária PRÓPRIA no plano gratuito (20/dia cada);
// quando um responde 429 (quota), 404 (aposentado para novos usuários) ou
// erro transitório, o próximo assume — multiplicando a quota diária efetiva
// e blindando o bot contra aposentadorias de modelo. Verificados em 2026-07:
const MODELOS_PADRAO = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite'];
const TIMEOUT_MS = 45_000;

// O supervisor semanal (V7.2) manda MUITO mais texto que uma análise (o retrato
// da semana inteira) e recebe de volta a camada de prompt reescrita: 45 s não
// bastam e o corte de tokens padrão truncaria a resposta no meio do markdown.
const TIMEOUT_SUPERVISOR_MS = 180_000;

// Temperatura baixa: decisão consistente e conservadora, não criatividade.
const TEMPERATURA = 0.2;

const promptBase = readFileSync(new URL('./promptBase.md', import.meta.url), 'utf8');

export class ErroIA extends Error {
  constructor(mensagem, { status = null, cadeiaEsgotada = false } = {}) {
    super(mensagem);
    this.name = 'ErroIA';
    this.status = status;
    // `cadeiaEsgotada`: TODOS os modelos falharam (tipicamente quota diária
    // estourada). Marcado aqui para quem trata o erro poder avisar o dono sem
    // precisar interpretar a mensagem — o iaClient não conhece notificação.
    this.cadeiaEsgotada = cadeiaEsgotada;
  }
}

/** Decisão segura usada quando a IA responde em formato inválido. */
function decisaoFallback(motivo) {
  return {
    acao: 'AGUARDAR',
    percentual: 0,
    confianca: null,
    justificativa: `Resposta da IA inválida (${motivo}) — aguardando por segurança.`,
    valida: false,
    motivo_invalidez: motivo,
  };
}

/** Uma tentativa contra um modelo específico. Lança ErroIA em falha de transporte/HTTP. */
async function chamarModelo(modelo, corpo, apiKey, timeoutMs = TIMEOUT_MS) {
  let resposta;
  try {
    // Chave vai no header (nunca na URL) para não aparecer em mensagens de erro.
    resposta = await fetch(`${BASE_URL}/${modelo}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ErroIA(`falha de rede/timeout ao chamar a IA (${modelo}): ${e.message}`);
  }
  if (!resposta.ok) {
    throw new ErroIA(`API da IA respondeu HTTP ${resposta.status} (${modelo})`, { status: resposta.status });
  }
  return resposta;
}

/**
 * Percorre a CADEIA de modelos e devolve a primeira resposta HTTP 200 obtida,
 * com o modelo que respondeu. Quota esgotada (429), modelo aposentado (404) ou
 * erro transitório passam ao próximo; erro de credencial (401/403) interrompe
 * na hora (trocar de modelo não resolveria). Só lança quando TODOS falham.
 */
async function chamarCadeia(corpo, { apiKey, modelos, timeoutMs = TIMEOUT_MS }) {
  if (!apiKey) {
    throw new ErroIA('API key da IA ausente — configure api_key_ia no Firebase ou GEMINI_API_KEY no .env');
  }
  const cadeia = (Array.isArray(modelos) ? modelos : [modelos]).filter(Boolean);
  if (cadeia.length === 0) {
    throw new ErroIA('nenhum modelo de IA configurado (modelos_ia vazio)');
  }
  let ultimoErro = null;
  for (const modelo of cadeia) {
    try {
      return { resposta: await chamarModelo(modelo, corpo, apiKey, timeoutMs), modelo };
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
      ultimoErro = e;
      log.aviso(`IA: modelo ${modelo} indisponível — tentando o próximo da cadeia`, { erro: e.message });
    }
  }
  throw new ErroIA(`todos os ${cadeia.length} modelos da cadeia falharam — último erro: ${ultimoErro?.message}`, {
    cadeiaEsgotada: true,
  });
}

/**
 * Envia o cenário à IA e devolve a decisão validada:
 *   { acao, percentual, confianca, justificativa, valida, modelo, motivo_invalidez? }
 *
 * Percorre a cadeia de modelos em ordem de prioridade: quota esgotada (429),
 * modelo aposentado (404) ou erro transitório passam ao próximo. Erro de
 * credencial (401/403) interrompe na hora — trocar de modelo não resolveria.
 * Só lança ErroIA quando TODOS os modelos falharem.
 *
 * @param {object} cenario  JSON da análise (CLAUDE.md §6.1) — já pronto, sem cálculos aqui.
 * @param {object} opcoes   { apiKey (obrigatória), modelos (lista em ordem de prioridade),
 *                            promptSistema (montado por montadorPrompt.js — template da
 *                            plataforma + ativo + contexto; sem ele, vale o promptBase.md) }
 */
export async function decidir(cenario, { apiKey, modelos = MODELOS_PADRAO, promptSistema = null } = {}) {
  const corpo = {
    systemInstruction: { parts: [{ text: promptSistema || promptBase }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(cenario, null, 2) }] }],
    generationConfig: {
      temperature: TEMPERATURA,
      responseMimeType: 'application/json',
    },
  };

  const { resposta, modelo: modeloUsado } = await chamarCadeia(corpo, { apiKey, modelos });

  let dados;
  try {
    dados = await resposta.json();
  } catch {
    log.erro('IA: corpo da resposta não é JSON', { modelo: modeloUsado });
    return { ...decisaoFallback('corpo da resposta HTTP não é JSON'), modelo: modeloUsado };
  }

  const texto = dados?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!texto.trim()) {
    const motivoBloqueio = dados?.promptFeedback?.blockReason ?? dados?.candidates?.[0]?.finishReason;
    log.erro('IA: resposta sem conteúdo', { motivo: motivoBloqueio ?? 'desconhecido', modelo: modeloUsado });
    return { ...decisaoFallback(`resposta sem conteúdo (${motivoBloqueio ?? 'desconhecido'})`), modelo: modeloUsado };
  }

  const resultado = validarResposta(texto);
  if (!resultado.valida) {
    // finishReason diferente de STOP (ex.: MAX_TOKENS) explica a maioria dos
    // JSONs quebrados — entra no motivo para diagnóstico direto na dashboard.
    const finishReason = dados?.candidates?.[0]?.finishReason ?? null;
    const motivo = finishReason && finishReason !== 'STOP'
      ? `${resultado.motivo} (finishReason: ${finishReason})`
      : resultado.motivo;
    log.erro('IA: resposta em formato inválido', {
      motivo,
      finish_reason: finishReason,
      trecho: texto.slice(0, 300),
      modelo: modeloUsado,
    });
    return { ...decisaoFallback(motivo), modelo: modeloUsado };
  }

  return { ...resultado.decisao, valida: true, modelo: modeloUsado };
}

/**
 * Consulta GENÉRICA em JSON — usada pelo supervisor semanal (V7.2), que não
 * decide operação nenhuma e por isso não passa pelo validador de decisão.
 *
 * Diferenças deliberadas em relação a `decidir()`:
 *   - devolve o TEXTO cru da resposta (quem chama valida o formato dela);
 *   - timeout longo (o retrato da semana é grande);
 *   - resposta vazia/sem conteúdo LANÇA. Não existe "fallback seguro" aqui: se
 *     o supervisor não respondeu, a camada de prompt anterior simplesmente
 *     continua valendo, e isso é a coisa certa a fazer.
 *
 * @param {object} p
 *   promptSistema — instruções do agente (o .md/supervisor.md, editável na dashboard)
 *   entrada       — objeto que vai como mensagem do usuário (serializado em JSON)
 *   apiKey/modelos — mesmas credenciais e cadeia de fallback do analista
 * @returns {{ texto: string, modelo: string }}
 */
export async function consultar({ promptSistema, entrada, apiKey, modelos = MODELOS_PADRAO } = {}) {
  const corpo = {
    systemInstruction: { parts: [{ text: promptSistema }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(entrada, null, 2) }] }],
    generationConfig: { temperature: TEMPERATURA, responseMimeType: 'application/json' },
  };

  const { resposta, modelo } = await chamarCadeia(corpo, {
    apiKey,
    modelos,
    timeoutMs: TIMEOUT_SUPERVISOR_MS,
  });

  let dados;
  try {
    dados = await resposta.json();
  } catch {
    throw new ErroIA(`corpo da resposta da IA não é JSON (${modelo})`);
  }
  const texto = dados?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!texto.trim()) {
    const motivo = dados?.promptFeedback?.blockReason ?? dados?.candidates?.[0]?.finishReason ?? 'desconhecido';
    throw new ErroIA(`resposta da IA sem conteúdo (${motivo}, ${modelo})`);
  }
  // finishReason ≠ STOP significa resposta CORTADA (tipicamente MAX_TOKENS): o
  // markdown da camada viria truncado no meio e viraria prompt quebrado.
  const finishReason = dados?.candidates?.[0]?.finishReason ?? null;
  if (finishReason && finishReason !== 'STOP') {
    throw new ErroIA(`resposta da IA interrompida (finishReason: ${finishReason}, ${modelo})`);
  }
  return { texto, modelo };
}
