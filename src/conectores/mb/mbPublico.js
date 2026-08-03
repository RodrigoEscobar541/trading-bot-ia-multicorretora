// mbPublico.js — dados PÚBLICOS da API v4 do Mercado Bitcoin (sem autenticação).
//
// Submódulo do conector MB (src/conectores/mb/conectorMB.js): ticker, candles
// e orderbook usados na montagem do JSON da análise. Não requer API Key.
// Nenhum arquivo fora de src/conectores/mb/ pode chamar a API do MB diretamente.
//
// Este módulo apenas lança erros tipados (ErroMB); quem chama decide como
// logar/pular a iteração, para nunca derrubar o loop principal (CLAUDE.md §3.1).

const BASE_URL = 'https://api.mercadobitcoin.net/api/v4';
const TIMEOUT_MS = 10_000;

// Identificação do cliente: sem User-Agent o Node envia o padrão "node", que o
// WAF do MB (Cloudflare) pode barrar com 403 vindo de IP de datacenter
// (incidente de 2026-07-17 no Render). Exportado para o mbPrivado usar o mesmo.
export const USER_AGENT = 'ia-investidora/2.0 (bot pessoal; Node.js)';

export class ErroMB extends Error {
  constructor(mensagem, { status = null, endpoint = null } = {}) {
    super(mensagem);
    this.name = 'ErroMB';
    this.status = status;
    this.endpoint = endpoint;
  }
}

async function requisitar(caminho, params = {}) {
  const url = new URL(`${BASE_URL}${caminho}`);
  for (const [chave, valor] of Object.entries(params)) {
    url.searchParams.set(chave, valor);
  }

  let resposta;
  try {
    resposta = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ErroMB(`falha de rede ao chamar ${caminho}: ${e.message}`, { endpoint: caminho });
  }
  if (!resposta.ok) {
    throw new ErroMB(`MB respondeu HTTP ${resposta.status} em ${caminho}`, {
      status: resposta.status,
      endpoint: caminho,
    });
  }
  return resposta.json();
}

const normalizarTicker = (t, simbolo) => ({
  simbolo,
  ultimo: Number(t.last),
  compra: Number(t.buy),
  venda: Number(t.sell),
  maxima: Number(t.high),
  minima: Number(t.low),
  volume: Number(t.vol),
  horario: new Date(Number(t.date) * 1000).toISOString(),
});

/**
 * Preço atual e resumo 24h do par (ticker).
 * A API devolve strings; aqui já convertemos para número.
 */
export async function obterTicker(simbolo) {
  const dados = await requisitar('/tickers', { symbols: simbolo });
  const t = Array.isArray(dados) ? dados[0] : null;
  if (!t || t.last === undefined) {
    throw new ErroMB(`ticker ausente para ${simbolo}`, { endpoint: '/tickers' });
  }
  return normalizarTicker(t, simbolo);
}

/**
 * Tickers de VÁRIOS pares em uma única chamada (base do patrimônio da
 * plataforma no cálculo de orçamento por ativo). Devolve { 'BTC-BRL': ticker }.
 * Pares sem ticker na resposta simplesmente não aparecem no mapa.
 */
export async function obterTickers(simbolos) {
  if (!Array.isArray(simbolos) || simbolos.length === 0) return {};
  const dados = await requisitar('/tickers', { symbols: simbolos.join(',') });
  const mapa = {};
  for (const t of Array.isArray(dados) ? dados : []) {
    if (t?.pair && t.last !== undefined) mapa[t.pair] = normalizarTicker(t, t.pair);
  }
  return mapa;
}

/**
 * Candles OHLCV, do mais antigo para o mais recente.
 * resolucao: '1m' | '15m' | '30m' | '1h' | '3h' | '1d' | '1w' | '1M'.
 * quantidade: número de candles retroativos a partir de agora (countback).
 */
export async function obterCandles(simbolo, resolucao = '15m', quantidade = 100) {
  const dados = await requisitar('/candles', {
    symbol: simbolo,
    resolution: resolucao,
    to: Math.floor(Date.now() / 1000),
    countback: quantidade,
  });
  const { t, o, h, l, c, v } = dados ?? {};
  if (!Array.isArray(t) || t.length === 0) {
    throw new ErroMB(`candles ausentes para ${simbolo} (${resolucao})`, { endpoint: '/candles' });
  }
  return t.map((ts, i) => ({
    horario: new Date(ts * 1000).toISOString(),
    abertura: Number(o[i]),
    maxima: Number(h[i]),
    minima: Number(l[i]),
    fechamento: Number(c[i]),
    volume: Number(v[i]),
  }));
}

// `obterOrderbook` foi removida na revisão de 2026-07-26: nada a chamava, ela
// não está no CONTRATO dos conectores e nenhum outro conector a implementa —
// usá-la seria escrever comportamento específico do MB no núcleo, que é
// justamente o que a V2 proíbe. Está no histórico do git.
