// bnPublico.js — dados PÚBLICOS da API Spot da Binance (sem autenticação).
//
// Submódulo do conector BN (src/conectores/bn/conectorBN.js): ticker 24h,
// tickers em lote, candles (klines), hora do servidor e filtros de símbolo
// (exchangeInfo). Não requer API Key. Nenhum arquivo fora de
// src/conectores/bn/ pode chamar a API da Binance diretamente.
//
// Este módulo apenas lança erros tipados (ErroBN); quem chama decide como
// logar/pular a iteração, para nunca derrubar o loop principal (CLAUDE.md §3.1).

const BASE_URL = 'https://api.binance.com/api/v3';
const TIMEOUT_MS = 10_000;

export class ErroBN extends Error {
  constructor(mensagem, { status = null, endpoint = null, codigo = null } = {}) {
    super(mensagem);
    this.name = 'ErroBN';
    this.status = status;
    this.endpoint = endpoint;
    this.codigo = codigo; // código de erro da Binance (ex.: -1021 = timestamp)
  }
}

async function requisitar(caminho, params = {}) {
  const url = new URL(`${BASE_URL}${caminho}`);
  for (const [chave, valor] of Object.entries(params)) {
    if (valor !== undefined && valor !== null) url.searchParams.set(chave, valor);
  }

  let resposta;
  try {
    resposta = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new ErroBN(`falha de rede ao chamar ${caminho}: ${e.message}`, { endpoint: caminho });
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
      `Binance respondeu HTTP ${resposta.status} em ${caminho}${detalhe ? ` (${detalhe})` : ''}`,
      { status: resposta.status, endpoint: caminho, codigo },
    );
  }
  return resposta.json();
}

const normalizarTicker = (t, simbolo) => ({
  simbolo,
  ultimo: Number(t.lastPrice),
  compra: Number(t.bidPrice),
  venda: Number(t.askPrice),
  maxima: Number(t.highPrice),
  minima: Number(t.lowPrice),
  volume: Number(t.volume), // volume 24h na unidade do ativo (base)
  horario: new Date(Number(t.closeTime)).toISOString(),
});

/**
 * Preço atual e resumo 24h do par (ticker).
 * A API devolve strings; aqui já convertemos para número.
 */
export async function obterTicker(simbolo) {
  const t = await requisitar('/ticker/24hr', { symbol: simbolo });
  if (!t || t.lastPrice === undefined) {
    throw new ErroBN(`ticker ausente para ${simbolo}`, { endpoint: '/ticker/24hr' });
  }
  return normalizarTicker(t, simbolo);
}

/**
 * Tickers de VÁRIOS pares em uma única chamada (base do patrimônio da
 * plataforma no cálculo de orçamento por ativo). Devolve { BTCBRL: ticker }.
 * Pares sem ticker na resposta simplesmente não aparecem no mapa.
 */
export async function obterTickers(simbolos) {
  if (!Array.isArray(simbolos) || simbolos.length === 0) return {};
  // A Binance espera um array JSON SEM espaços: ["BTCBRL","ETHBRL"]
  const dados = await requisitar('/ticker/24hr', { symbols: JSON.stringify(simbolos) });
  const mapa = {};
  for (const t of Array.isArray(dados) ? dados : []) {
    if (t?.symbol && t.lastPrice !== undefined) mapa[t.symbol] = normalizarTicker(t, t.symbol);
  }
  return mapa;
}

// Resoluções aceitas pelo núcleo → intervalo da Binance (mesma grafia; a
// Binance não tem '3h', mas o núcleo só usa 15m e 1h).
const INTERVALOS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']);

/**
 * Candles OHLCV (klines), do mais antigo para o mais recente.
 * resolucao: '1m' | '15m' | '30m' | '1h' | '1d' | ... (grafia da Binance).
 * quantidade: número de candles retroativos a partir de agora (limit).
 */
export async function obterCandles(simbolo, resolucao = '15m', quantidade = 100) {
  if (!INTERVALOS.has(resolucao)) {
    throw new ErroBN(`resolução de candle não suportada pela Binance: ${resolucao}`, { endpoint: '/klines' });
  }
  const dados = await requisitar('/klines', { symbol: simbolo, interval: resolucao, limit: quantidade });
  if (!Array.isArray(dados) || dados.length === 0) {
    throw new ErroBN(`candles ausentes para ${simbolo} (${resolucao})`, { endpoint: '/klines' });
  }
  // Cada kline é um array: [openTime, open, high, low, close, volume, closeTime, ...]
  return dados.map((k) => ({
    horario: new Date(Number(k[0])).toISOString(),
    abertura: Number(k[1]),
    maxima: Number(k[2]),
    minima: Number(k[3]),
    fechamento: Number(k[4]),
    volume: Number(k[5]), // volume na unidade do ativo (base) — igual ao MB
  }));
}

/** Hora do servidor da Binance em ms (base do offset de relógio das chamadas assinadas). */
export async function obterHoraServidor() {
  const dados = await requisitar('/time');
  if (!Number.isFinite(Number(dados?.serverTime))) {
    throw new ErroBN('hora do servidor em formato inesperado', { endpoint: '/time' });
  }
  return Number(dados.serverTime);
}

// Cache dos filtros por símbolo (não mudam durante a vida do processo).
const filtros = new Map(); // simbolo → { stepSize, minQty, minNotional }

/**
 * Filtros de negociação do símbolo (exchangeInfo), cacheados:
 *   stepSize/minQty (LOT_SIZE — a VENDA por quantidade precisa ser múltiplo
 *   do stepSize, senão a Binance rejeita) e minNotional (valor mínimo da ordem).
 */
export async function obterFiltrosSimbolo(simbolo) {
  const cache = filtros.get(simbolo);
  if (cache) return cache;

  const dados = await requisitar('/exchangeInfo', { symbol: simbolo });
  const info = Array.isArray(dados?.symbols) ? dados.symbols[0] : null;
  if (!info?.filters) {
    throw new ErroBN(`exchangeInfo ausente para ${simbolo}`, { endpoint: '/exchangeInfo' });
  }
  const porTipo = Object.fromEntries(info.filters.map((f) => [f.filterType, f]));
  const resultado = {
    stepSize: Number(porTipo.LOT_SIZE?.stepSize ?? 0),
    minQty: Number(porTipo.LOT_SIZE?.minQty ?? 0),
    minNotional: Number(porTipo.NOTIONAL?.minNotional ?? 0),
  };
  filtros.set(simbolo, resultado);
  return resultado;
}

/** Limpa o cache de filtros (apenas para testes). */
export function limparCachesPublicos() {
  filtros.clear();
}
