// catalogo.js — cache em memória (TTL) dos documentos de CONFIGURAÇÃO
// (V5_2_Plan.MD §2.1). Plataformas, chaves, ativos e camadas do prompt só
// mudam quando o usuário edita a dashboard — relê-los no tick de 1 minuto do
// orquestrador custava ~17 mil leituras de Firestore POR DIA com o bot ocioso.
//
// Regras (documentadas no V5_2_Plan.MD §7 — ler antes de mexer):
//   - Edições da dashboard passam a valer em até CATALOGO_TTL_MS (15 min).
//     Fluxos do BOT que escrevam um doc cacheado devem chamar
//     invalidarCatalogo() após a escrita (a dashboard não precisa: o atraso
//     de até 5 min é o comportamento documentado no MANUAL).
//   - Os valores devolvidos são COMPARTILHADOS entre chamadas: quem consome
//     nunca deve mutá-los (filtrar com .filter/spread, nunca .push/atribuição).
//   - Cada documento é cacheado no ESCOPO em que ele varia: global, por
//     plataforma ou por ativo. Guardar um doc global dentro de uma chave por
//     ativo funciona, mas faz N ativos pagarem N leituras do MESMO documento.
//   - O cache fica AQUI (camada de orquestração), nunca dentro do
//     firebaseClient: a persistência continua burra e previsível (migração,
//     testes e os salvar* com read-modify-write de versão nunca veem dado velho).
//   - Testes: chamar invalidarCatalogo() no beforeEach (a persistência em
//     memória é recriada a cada teste; o cache sobreviveria a ela).

import {
  listarPlataformas,
  listarAtivos,
  listarContas,
  obterApiConta,
  obterApiPlataforma,
  obterRegrasGerais,
  obterRegrasGeraisVenda,
  obterTemplatePlataforma,
  obterNoticiasPlataforma,
  obterPromptAtivo,
  obterContextoAtivo,
  obterSupervisao,
  obterConfigSupervisor,
  obterTelegram,
} from '../firebase/firebaseClient.js';

/**
 * Validade do cache — teto do atraso para edições feitas pela dashboard.
 *
 * 15 min desde a V8.14 (era 5): cada expiração relê ~28 documentos de
 * configuração, o que dava ~8 mil leituras/dia só para reconfirmar dados que
 * mudam quando o DONO edita a tela — algumas vezes por semana. A 15 min são
 * ~2,7 mil. O preço é a edição demorar até 15 min para valer, e ele é pago de
 * propósito: em 14/08/2026 a quota de leitura do plano gratuito estourou e o
 * bot passou 3h45 sem analisar nada (ver `controleVivo.js`) — esperar por uma
 * edição é incômodo, ficar cego é risco.
 */
export const CATALOGO_TTL_MS = 15 * 60_000;

const cache = new Map(); // chave → { valor, lidoEm (epoch ms) }

/** Devolve o valor cacheado da chave ou lê com `lerFn` e guarda. */
async function lembrar(chave, lerFn, agoraMs) {
  const entrada = cache.get(chave);
  if (entrada && agoraMs - entrada.lidoEm < CATALOGO_TTL_MS) return entrada.valor;
  const valor = await lerFn();
  cache.set(chave, { valor, lidoEm: agoraMs });
  return valor;
}

/** Todas as plataformas (cacheado). `agoraMs` é injetável para testes. */
export async function plataformasCache({ agoraMs = Date.now() } = {}) {
  return lembrar('plataformas', listarPlataformas, agoraMs);
}

/** Credenciais da plataforma (cacheado). */
export async function apiCache(plataformaId, { agoraMs = Date.now() } = {}) {
  return lembrar(`api/${plataformaId}`, () => obterApiPlataforma(plataformaId), agoraMs);
}

/**
 * Contas ESPELHO da plataforma (cacheado — V8.18). Lidas no tick, então passam
 * pelo catálogo como todo o resto da configuração (invariante V5.2): sem isto,
 * cada rodada pagaria uma leitura por plataforma só para saber que não há
 * conta espelho nenhuma.
 */
export async function contasCache(plataformaId, { agoraMs = Date.now() } = {}) {
  return lembrar(`contas/${plataformaId}`, () => listarContas(plataformaId), agoraMs);
}

/** Credenciais de uma conta espelho (cacheado, como as da plataforma). */
export async function apiContaCache(plataformaId, contaId, { agoraMs = Date.now() } = {}) {
  return lembrar(`api-conta/${plataformaId}/${contaId}`, () => obterApiConta(plataformaId, contaId), agoraMs);
}

/** Ativos da plataforma (cacheado). */
export async function ativosCache(plataformaId, { agoraMs = Date.now() } = {}) {
  return lembrar(`ativos/${plataformaId}`, () => listarAtivos(plataformaId), agoraMs);
}

/**
 * Camadas GLOBAIS do prompt — as mesmas para todo ativo de toda plataforma.
 * Ficam numa chave PRÓPRIA porque é isso que faz cada ativo pagá-las uma vez
 * por janela de 5 min, e não uma vez por análise: elas viviam dentro da chave
 * por ativo, então 15 ativos analisando releem o mesmo documento global 15
 * vezes (invariante V5.2 — leitura no caminho quente é orçada).
 */
async function globaisPromptCache(agoraMs) {
  return lembrar('prompt/globais', async () => {
    const [regrasGerais, regrasGeraisVenda, supervisao, configSupervisor] = await Promise.all([
      obterRegrasGerais(),
      // Regras do MODO VENDAS (V8). Lidas SEMPRE, mesmo com o modo desligado:
      // são uma leitura a cada 5 min (não por tick), e ler condicionalmente
      // faria a primeira análise da liquidação pegar cache montado sem elas.
      // Quem escolhe qual das duas vai ao prompt é o montadorPrompt.
      obterRegrasGeraisVenda(),
      obterSupervisao(),
      obterConfigSupervisor(),
    ]);
    return {
      regrasGerais,
      regrasGeraisVenda,
      // Kill-switch: desligado, a camada some do prompt do analista NO MESMO
      // ato em que o agente para de rodar — o doc continua guardado (nada é
      // apagado) e religar devolve exatamente o que estava valendo.
      supervisao: configSupervisor?.ativo === false ? null : supervisao,
    };
  }, agoraMs);
}

/** Template da plataforma — comum a todos os ativos DELA (chave por plataforma). */
async function templateCache(plataformaId, agoraMs) {
  return lembrar(`template/${plataformaId}`, () => obterTemplatePlataforma(plataformaId), agoraMs);
}

/**
 * Notícias do JOGO — também por PLATAFORMA: as atualizações do CS2 valem para
 * todas as skins, e guardá-las por ativo faria N itens lerem N vezes o mesmo
 * documento (o erro corrigido em 2026-07-26 — ver CLAUDE.md §2.1).
 * O bot escreve este doc; quem o escreve não precisa invalidar o catálogo,
 * porque um atraso de até 5 min para a nota entrar no prompt é irrelevante
 * (o AVISO já saiu na hora, por outro caminho).
 */
async function noticiasCache(plataformaId, agoraMs) {
  return lembrar(`noticias/${plataformaId}`, () => obterNoticiasPlataforma(plataformaId), agoraMs);
}

/**
 * As camadas EDITÁVEIS do prompt final de um ativo (cacheado):
 * { regrasGerais, regrasGeraisVenda, template, promptAtivo, supervisao, contexto }.
 * As versões dos docs seguem indo para o histórico de cada análise, como sempre.
 *
 * Três chaves de cache, por ESCOPO do documento — global, por plataforma e por
 * ativo. O resultado é montado a cada chamada a partir das partes cacheadas; as
 * partes continuam COMPARTILHADAS e ninguém pode mutá-las (regra do topo).
 *
 * `supervisao` (V7.2) é doc GLOBAL escrito pelo BOT (o agente semanal): quem o
 * grava chama `invalidarCatalogo()`, senão o analista continuaria lendo a
 * camada antiga por até 5 minutos.
 */
export async function camadasPromptCache(plataformaId, ativoId, { agoraMs = Date.now() } = {}) {
  const [globais, template, noticias, doAtivo] = await Promise.all([
    globaisPromptCache(agoraMs),
    templateCache(plataformaId, agoraMs),
    noticiasCache(plataformaId, agoraMs),
    lembrar(`prompt/${plataformaId}/${ativoId}`, async () => {
      const [promptAtivo, contexto] = await Promise.all([
        obterPromptAtivo(plataformaId, ativoId),
        obterContextoAtivo(plataformaId, ativoId),
      ]);
      return { promptAtivo, contexto };
    }, agoraMs),
  ]);
  return { ...globais, template, noticias, ...doAtivo };
}

/** Configuração do supervisor semanal (cacheado — lido no loop do orquestrador). */
export async function supervisorConfigCache({ agoraMs = Date.now() } = {}) {
  return lembrar('supervisor', obterConfigSupervisor, agoraMs);
}

/**
 * Configuração do bot de avisos do Telegram (cacheado). Notificação acontece
 * em ponto quente (toda operação executada), então ela NUNCA pode custar uma
 * leitura nova por evento — daí passar pelo catálogo como o resto da config.
 */
export async function telegramCache({ agoraMs = Date.now() } = {}) {
  return lembrar('telegram', obterTelegram, agoraMs);
}

/** Esvazia o cache inteiro (testes; ou após o BOT escrever um doc cacheado). */
export function invalidarCatalogo() {
  cache.clear();
}
