// bnPrivado.js — dados PRIVADOS/execução da API Spot da Binance (autenticado).
//
// Submódulo do conector BN (src/conectores/bn/conectorBN.js): saldos, ordens
// abertas, criação de ordens a mercado e confirmação de fill. Autentica com
// API Key + Secret (assinatura HMAC SHA256 da query string, header
// X-MBX-APIKEY). Nenhum arquivo fora de src/conectores/bn/ pode chamar a API
// da Binance diretamente.
//
// Regras relevantes:
//   - Todas as ordens são A MERCADO (regras.md §9) — nunca limitadas.
//     Compra por VALOR usa `quoteOrderQty` (gasta X na moeda da plataforma);
//     venda usa `quantity`, TRUNCADA ao stepSize do par (LOT_SIZE), senão a
//     Binance rejeita a ordem.
//   - Este módulo NÃO decide nada: só executa o que o Motor de Regras aprovou.
//   - Erros viram ErroBN tipado; quem chama loga e trata (CLAUDE.md §3.1/§14).
//     Em execução real, quem chama NUNCA reenvia ordem automaticamente sem
//     confirmar que a anterior não foi criada (proteção contra duplicidade).
//   - TAXAS: a resposta FULL da ordem traz a comissão REAL de cada fill
//     (`commission` + `commissionAsset`). A comissão é convertida para a
//     moeda da plataforma: na venda já vem na moeda; na compra vem no ativo
//     comprado (quantidade × preço do fill); em BNB (desconto ligado na
//     conta), converte pela cotação BNB×moeda — melhor esforço, com aviso.
//
// O relógio local pode divergir do servidor: o offset é medido em /time e a
// chamada é repetida UMA vez quando a Binance acusa timestamp fora da janela
// (código -1021).

import { createHmac } from 'node:crypto';
import { ErroBN, obterTicker, obterFiltrosSimbolo, obterHoraServidor } from './bnPublico.js';
import { log, registrarSegredo } from '../../utils/logger.js';

const BASE_URL = 'https://api.binance.com/api/v3';
const TIMEOUT_MS = 15_000;
const RECV_WINDOW_MS = 10_000;
const CODIGO_TIMESTAMP_FORA_DA_JANELA = -1021;

// Offset relógio local → servidor (ms), medido sob demanda e re-medido em -1021.
let offsetRelogioMs = null;

// Respostas FULL das ordens criadas neste processo (orderId → resposta bruta):
// ordem a mercado volta EXECUTADA com os fills — aguardarFill lê daqui e só
// consulta a API de novo se a ordem ainda não estiver terminal.
const ordensCriadas = new Map();

/** Assinatura HMAC SHA256 (hex) da query string — exportada para testes. */
export function assinar(queryString, apiSecret) {
  return createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

async function medirOffsetRelogio() {
  const antes = Date.now();
  const servidor = await obterHoraServidor();
  const depois = Date.now();
  // Aproximação simples: compara com o meio da janela da requisição.
  offsetRelogioMs = servidor - Math.round((antes + depois) / 2);
  return offsetRelogioMs;
}

async function requisitarAssinado(credenciais, metodo, caminho, params = {}) {
  const { apiKey, apiSecret } = credenciais ?? {};
  if (!apiKey || !apiSecret) {
    throw new ErroBN('credenciais da Binance ausentes — configure bn_api_key/bn_api_secret');
  }
  registrarSegredo(apiKey);
  registrarSegredo(apiSecret);
  if (offsetRelogioMs === null) {
    try {
      await medirOffsetRelogio();
    } catch {
      offsetRelogioMs = 0; // sem /time: tenta com o relógio local mesmo
    }
  }

  const executar = async () => {
    const query = new URLSearchParams();
    for (const [chave, valor] of Object.entries(params)) {
      if (valor !== undefined && valor !== null) query.set(chave, valor);
    }
    query.set('recvWindow', RECV_WINDOW_MS);
    query.set('timestamp', Date.now() + offsetRelogioMs);
    query.set('signature', assinar(query.toString(), apiSecret));

    const url = `${BASE_URL}${caminho}?${query.toString()}`;
    let resposta;
    try {
      resposta = await fetch(url, {
        method: metodo,
        headers: { 'X-MBX-APIKEY': apiKey },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new ErroBN(`falha de rede em ${metodo} ${caminho}: ${e.message}`, { endpoint: caminho });
    }

    if (!resposta.ok) {
      let detalhe = '';
      let codigo = null;
      try {
        const erro = await resposta.json();
        detalhe = erro?.msg ?? '';
        codigo = erro?.code ?? null;
      } catch {
        /* corpo não-JSON: segue sem detalhe */
      }
      throw new ErroBN(
        `Binance respondeu HTTP ${resposta.status} em ${metodo} ${caminho}${detalhe ? ` (${detalhe})` : ''}`,
        { status: resposta.status, endpoint: caminho, codigo },
      );
    }
    return resposta.json();
  };

  try {
    return await executar();
  } catch (e) {
    if (e instanceof ErroBN && e.codigo === CODIGO_TIMESTAMP_FORA_DA_JANELA) {
      await medirOffsetRelogio(); // relógio divergiu: re-mede e repete UMA vez
      return executar();
    }
    throw e;
  }
}

/**
 * Saldos DISPONÍVEIS (livres para operar) de TODOS os símbolos da conta:
 *   { moeda: 'BRL', saldo_moeda, saldos: { BTC: 0.01, ETH: 0.5, ... } }
 * Base do patrimônio virtual quando a simulação inicia (regras.md §7).
 */
export async function obterSaldos(credenciais) {
  const moeda = credenciais.moeda;
  const conta = await requisitarAssinado(credenciais, 'GET', '/account');
  if (!Array.isArray(conta?.balances)) {
    throw new ErroBN('resposta de saldos em formato inesperado', { endpoint: '/account' });
  }
  const saldos = {};
  let saldoMoeda = 0;
  for (const b of conta.balances) {
    const disponivel = Number(b.free ?? 0);
    if (b.asset === moeda) saldoMoeda = disponivel;
    else if (disponivel > 0) saldos[b.asset] = disponivel;
  }
  return { moeda, saldo_moeda: saldoMoeda, saldos };
}

/** Ordens ABERTAS no par (NEW/PARTIALLY_FILLED) — usadas na regra 2 do Motor. */
export async function obterOrdensAbertas(credenciais, simbolo) {
  const lista = await requisitarAssinado(credenciais, 'GET', '/openOrders', { symbol: simbolo });
  return Array.isArray(lista) ? lista : [];
}

/**
 * Trunca a quantidade ao múltiplo do stepSize do par (LOT_SIZE), com o mesmo
 * número de casas decimais do step — nunca arredonda para CIMA (venderia mais
 * do que a posição tem). Exportada para testes.
 */
export function truncarAoStep(quantidade, stepSize) {
  if (!Number.isFinite(stepSize) || stepSize <= 0) return quantidade;
  const passos = Math.floor(quantidade / stepSize + 1e-9); // 1e-9 absorve ruído binário
  const casas = Math.max(0, -Math.floor(Math.log10(stepSize) + 1e-9));
  return Number((passos * stepSize).toFixed(casas));
}

/**
 * Cria uma ordem A MERCADO já aprovada pelo Motor de Regras.
 *   compra: { lado: 'buy',  valor }        → API usa `quoteOrderQty`
 *   venda:  { lado: 'sell', quantidade }   → API usa `quantity` (múltiplo do stepSize)
 * A resposta FULL (já executada, com fills) fica cacheada para aguardarFill.
 */
export async function criarOrdemMercado(credenciais, { simbolo, lado, valor, quantidade }) {
  if (lado !== 'buy' && lado !== 'sell') {
    throw new ErroBN(`lado de ordem inválido: ${lado}`);
  }
  const params = { symbol: simbolo, type: 'MARKET', newOrderRespType: 'FULL' };
  if (lado === 'buy') {
    if (!Number.isFinite(valor) || valor <= 0) throw new ErroBN('compra sem valor válido');
    params.side = 'BUY';
    params.quoteOrderQty = valor.toFixed(2); // moeda de cotação: centavos bastam
  } else {
    if (!Number.isFinite(quantidade) || quantidade <= 0) throw new ErroBN('venda sem quantidade válida');
    const filtros = await obterFiltrosSimbolo(simbolo);
    const qty = truncarAoStep(quantidade, filtros.stepSize);
    if (qty <= 0 || qty < filtros.minQty) {
      throw new ErroBN(
        `quantidade ${quantidade} abaixo do lote mínimo do par ${simbolo} (minQty ${filtros.minQty}, step ${filtros.stepSize})`,
      );
    }
    params.side = 'SELL';
    params.quantity = String(qty);
  }

  const dados = await requisitarAssinado(credenciais, 'POST', '/order', params);
  if (dados?.orderId === undefined || dados?.orderId === null) {
    throw new ErroBN('criação de ordem não devolveu orderId', { endpoint: '/order' });
  }
  const orderId = String(dados.orderId);
  ordensCriadas.set(orderId, dados);
  return { orderId };
}

// Status da Binance → status do contrato (working/filled/cancelled).
function statusContrato(status) {
  if (status === 'FILLED') return 'filled';
  if (['CANCELED', 'REJECTED', 'EXPIRED', 'EXPIRED_IN_MATCH'].includes(status)) return 'cancelled';
  return 'working'; // NEW | PARTIALLY_FILLED | PENDING_NEW ...
}

/**
 * Converte as comissões dos fills para a moeda da plataforma:
 *   - commissionAsset = moeda (venda) → soma direta;
 *   - commissionAsset = ativo comprado → quantidade × preço do próprio fill;
 *   - outro ativo (BNB, com desconto ligado) → cotação ATIVO+moeda no momento
 *     (melhor esforço: sem cotação, registra 0 e loga aviso — recomendamos
 *     DESLIGAR o pagamento de taxas em BNB na conta; ver MANUAL).
 */
export async function calcularTaxaNaMoeda(fills, simbolo, moeda) {
  const base = simbolo.endsWith(moeda) ? simbolo.slice(0, -moeda.length) : null;
  const cotacoes = new Map(); // ativo da comissão → preço na moeda (1 consulta por ativo)
  let taxa = 0;
  for (const f of Array.isArray(fills) ? fills : []) {
    const comissao = Number(f.commission ?? 0);
    if (!comissao) continue;
    const ativo = f.commissionAsset;
    if (ativo === moeda) {
      taxa += comissao;
    } else if (ativo === base) {
      taxa += comissao * Number(f.price ?? 0);
    } else {
      if (!cotacoes.has(ativo)) {
        try {
          cotacoes.set(ativo, (await obterTicker(`${ativo}${moeda}`)).ultimo);
        } catch (e) {
          cotacoes.set(ativo, 0);
          log.aviso('comissão em ativo sem cotação na moeda da plataforma — taxa registrada a menor', {
            ativo,
            moeda,
            erro: e.message,
          });
        }
      }
      taxa += comissao * cotacoes.get(ativo);
    }
  }
  return taxa;
}

/** Normaliza uma ordem (com fills) para o registro de operação (§6.3). */
async function normalizarOrdem(o, { simbolo, moeda, fills }) {
  const quantidade = Number(o.executedQty ?? 0);
  const valor = Number(o.cummulativeQuoteQty ?? 0);
  return {
    id: String(o.orderId),
    status: statusContrato(o.status),
    lado: o.side === 'BUY' ? 'buy' : 'sell',
    quantidade,
    valor,
    preco_medio: quantidade > 0 ? valor / quantidade : 0,
    taxa: await calcularTaxaNaMoeda(fills, simbolo, moeda),
    bruta: o, // objeto original, para depuração/registro
  };
}

/**
 * Detalhe de uma ordem consultada na API. GET /order não traz as comissões;
 * elas vêm de GET /myTrades filtrado pelo orderId.
 */
export async function obterOrdem(credenciais, orderId, simbolo) {
  const o = await requisitarAssinado(credenciais, 'GET', '/order', { symbol: simbolo, orderId });
  if (o?.orderId === undefined || o?.orderId === null) {
    throw new ErroBN(`ordem ${orderId} não encontrada`, { endpoint: '/order' });
  }
  let fills = [];
  if (Number(o.executedQty ?? 0) > 0) {
    const trades = await requisitarAssinado(credenciais, 'GET', '/myTrades', { symbol: simbolo, orderId });
    fills = (Array.isArray(trades) ? trades : []).map((t) => ({
      price: t.price,
      qty: t.qty,
      commission: t.commission,
      commissionAsset: t.commissionAsset,
    }));
  }
  return normalizarOrdem(o, { simbolo, moeda: credenciais.moeda, fills });
}

/**
 * Aguarda o fill de uma ordem a mercado. Na Binance a resposta da criação já
 * volta com o estado final e os fills — se ela estiver terminal no cache,
 * nem consulta a API. Caso raro (resposta perdida/ainda working), faz poll.
 * NUNCA recria a ordem — se não confirmar, quem chama marca `status: "erro"`.
 */
export async function aguardarFill(credenciais, orderId, { simbolo, tentativas = 10, intervaloMs = 1000 } = {}) {
  const criada = ordensCriadas.get(String(orderId));
  if (criada && ['filled', 'cancelled'].includes(statusContrato(criada.status))) {
    return normalizarOrdem(criada, { simbolo, moeda: credenciais.moeda, fills: criada.fills });
  }

  let detalhe = null;
  for (let i = 0; i < tentativas; i++) {
    detalhe = await obterOrdem(credenciais, orderId, simbolo);
    if (detalhe.status === 'filled') return detalhe;
    if (detalhe.status === 'cancelled') return detalhe;
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
  return detalhe; // não confirmou: devolve o último estado visto
}

/** Limpa caches do módulo (apenas para testes). */
export function limparCachesPrivados() {
  offsetRelogioMs = null;
  ordensCriadas.clear();
}
