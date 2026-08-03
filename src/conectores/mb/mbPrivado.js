// mbPrivado.js — dados PRIVADOS/execução da API v4 do Mercado Bitcoin (autenticado).
//
// Submódulo do conector MB (src/conectores/mb/conectorMB.js): saldo, ordens
// abertas, criação e cancelamento de ordens. Autentica com o par API Token
// ID + Secret gerado no painel do MB. Nenhum arquivo fora de
// src/conectores/mb/ pode chamar a API do MB diretamente.
//
// Regras relevantes:
//   - Todas as ordens são A MERCADO (regras.md §9) — nunca limitadas.
//   - Este módulo NÃO decide nada: só executa o que o Motor de Regras aprovou.
//   - Erros viram ErroMB tipado; quem chama loga e trata (CLAUDE.md §3.1/§14).
//     Em execução real, quem chama NUNCA reenvia ordem automaticamente sem
//     confirmar que a anterior não foi criada (proteção contra duplicidade).
//
// O token Bearer expira; é cacheado e renovado com margem de 60s.

import { ErroMB, USER_AGENT } from './mbPublico.js';
import { registrarSegredo } from '../../utils/logger.js';

const BASE_URL = 'https://api.mercadobitcoin.net/api/v4';
const TIMEOUT_MS = 15_000;
const MARGEM_RENOVACAO_MS = 60_000;

// Cache do token por credencial (login) — renovado quando perto de expirar.
const tokens = new Map(); // login → { accessToken, expiraEmMs }

async function requisitar(metodo, caminho, { corpo = null, token = null, params = {} } = {}) {
  const url = new URL(`${BASE_URL}${caminho}`);
  for (const [chave, valor] of Object.entries(params)) {
    if (valor !== undefined && valor !== null) url.searchParams.set(chave, valor);
  }

  const headers = {
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    accept: 'application/json',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  let resposta;
  try {
    resposta = await fetch(url, {
      method: metodo,
      headers,
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ErroMB(`falha de rede em ${metodo} ${caminho}: ${e.message}`, { endpoint: caminho });
  }

  if (!resposta.ok) {
    let detalhe = '';
    try {
      const texto = await resposta.text();
      try {
        const erro = JSON.parse(texto);
        detalhe = erro?.message ?? erro?.code ?? '';
      } catch {
        // Corpo não-JSON (ex.: página de bloqueio do Cloudflare): guarda um
        // trecho do texto puro para o diagnóstico não ficar cego.
        detalhe = texto.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
      }
    } catch {
      /* corpo ilegível: segue sem detalhe */
    }
    throw new ErroMB(
      `MB respondeu HTTP ${resposta.status} em ${metodo} ${caminho}${detalhe ? ` (${detalhe})` : ''}`,
      { status: resposta.status, endpoint: caminho },
    );
  }
  if (resposta.status === 204) return null;
  return resposta.json();
}

/** Autentica (ou reaproveita token válido) e devolve o access token. */
async function autenticar({ id, secret }) {
  if (!id || !secret) {
    throw new ErroMB('credenciais do MB ausentes — configure api_key_mb_id/api_key_mb_secret');
  }
  registrarSegredo(id);
  registrarSegredo(secret);

  const cache = tokens.get(id);
  if (cache && Date.now() < cache.expiraEmMs - MARGEM_RENOVACAO_MS) {
    return cache.accessToken;
  }

  const dados = await requisitar('POST', '/authorize', { corpo: { login: id, password: secret } });
  if (!dados?.access_token) {
    throw new ErroMB('autenticação no MB não devolveu access_token', { endpoint: '/authorize' });
  }
  registrarSegredo(dados.access_token);
  tokens.set(id, {
    accessToken: dados.access_token,
    // `expiration` vem em segundos unix; fallback: 5 minutos.
    expiraEmMs: dados.expiration ? Number(dados.expiration) * 1000 : Date.now() + 5 * 60_000,
  });
  return dados.access_token;
}

// Cache do id da conta (não muda durante a vida do processo).
const contas = new Map(); // login → accountId

/** Devolve o id da primeira conta do usuário (padrão para conta única). */
async function obterContaId(credenciais) {
  const cache = contas.get(credenciais.id);
  if (cache) return cache;

  const token = await autenticar(credenciais);
  const lista = await requisitar('GET', '/accounts', { token });
  const conta = Array.isArray(lista) ? lista[0] : null;
  if (!conta?.id) {
    throw new ErroMB('nenhuma conta encontrada para as credenciais informadas', { endpoint: '/accounts' });
  }
  contas.set(credenciais.id, conta.id);
  return conta.id;
}

/**
 * Saldos DISPONÍVEIS (livres para operar) de TODOS os símbolos da conta:
 *   { moeda: 'BRL', saldo_moeda, saldos: { BTC: 0.01, ETH: 0.5, ... } }
 * Base do patrimônio virtual quando a simulação inicia (regras.md §7).
 */
export async function obterSaldos(credenciais) {
  const token = await autenticar(credenciais);
  const contaId = await obterContaId(credenciais);
  const lista = await requisitar('GET', `/accounts/${contaId}/balances`, { token });
  if (!Array.isArray(lista)) {
    throw new ErroMB('resposta de saldos em formato inesperado', { endpoint: 'balances' });
  }
  const saldos = {};
  let saldoMoeda = 0;
  for (const s of lista) {
    const disponivel = Number(s.available ?? 0);
    if (s.symbol === 'BRL') saldoMoeda = disponivel;
    else if (disponivel > 0) saldos[s.symbol] = disponivel;
  }
  return { moeda: 'BRL', saldo_moeda: saldoMoeda, saldos };
}

/** Ordens ABERTAS (status "working") no par — usadas na regra 2 do Motor. */
export async function obterOrdensAbertas(credenciais, simbolo) {
  const token = await autenticar(credenciais);
  const contaId = await obterContaId(credenciais);
  const lista = await requisitar('GET', `/accounts/${contaId}/${simbolo}/orders`, {
    token,
    params: { status: 'working' },
  });
  return Array.isArray(lista) ? lista : [];
}

/**
 * Cria uma ordem A MERCADO já aprovada pelo Motor de Regras.
 *   compra: { lado: 'buy',  valor }        → API usa `cost` (gasta X na moeda)
 *   venda:  { lado: 'sell', quantidade }   → API usa `qty`  (vende X do ativo)
 * Devolve apenas o orderId; a confirmação do fill é feita em obterOrdem().
 */
export async function criarOrdemMercado(credenciais, { simbolo, lado, valor, quantidade }) {
  if (lado !== 'buy' && lado !== 'sell') {
    throw new ErroMB(`lado de ordem inválido: ${lado}`);
  }
  const corpo = { side: lado, type: 'market' };
  if (lado === 'buy') {
    if (!Number.isFinite(valor) || valor <= 0) throw new ErroMB('compra sem valor válido');
    corpo.cost = valor;
  } else {
    if (!Number.isFinite(quantidade) || quantidade <= 0) throw new ErroMB('venda sem quantidade válida');
    corpo.qty = String(quantidade);
  }

  const token = await autenticar(credenciais);
  const contaId = await obterContaId(credenciais);
  const dados = await requisitar('POST', `/accounts/${contaId}/${simbolo}/orders`, { token, corpo });
  if (!dados?.orderId) {
    throw new ErroMB('criação de ordem não devolveu orderId', { endpoint: 'orders' });
  }
  return { orderId: String(dados.orderId) };
}

/**
 * Detalhe de uma ordem, normalizado para o registro de operação (§6.3):
 * status, quantidade executada, valor movimentado, preço médio e taxa cobrada.
 */
export async function obterOrdem(credenciais, orderId, simbolo) {
  const token = await autenticar(credenciais);
  const contaId = await obterContaId(credenciais);
  const o = await requisitar('GET', `/accounts/${contaId}/${simbolo}/orders/${orderId}`, { token });
  if (!o?.id) {
    throw new ErroMB(`ordem ${orderId} não encontrada`, { endpoint: 'orders' });
  }

  const execucoes = Array.isArray(o.executions) ? o.executions : [];
  const qtdExecutada = execucoes.reduce((s, e) => s + Number(e.qty ?? 0), 0) || Number(o.filledQty ?? 0);
  const valorExecutado = execucoes.reduce((s, e) => s + Number(e.qty ?? 0) * Number(e.price ?? 0), 0);
  const precoMedio = qtdExecutada > 0 ? valorExecutado / qtdExecutada : Number(o.avgPrice ?? 0);

  return {
    id: String(o.id),
    status: o.status, // 'working' | 'filled' | 'cancelled' | ...
    lado: o.side,
    quantidade: qtdExecutada,
    valor: valorExecutado,
    preco_medio: precoMedio,
    taxa: Number(o.fee ?? 0),
    bruta: o, // objeto original, para depuração/registro
  };
}

/**
 * Aguarda o fill de uma ordem a mercado (normalmente instantâneo).
 * Consulta a cada `intervaloMs` até `tentativas`; devolve o detalhe final.
 * NUNCA recria a ordem — se não confirmar, quem chama marca `status: "erro"`.
 */
export async function aguardarFill(credenciais, orderId, { simbolo, tentativas = 10, intervaloMs = 1000 } = {}) {
  let detalhe = null;
  for (let i = 0; i < tentativas; i++) {
    detalhe = await obterOrdem(credenciais, orderId, simbolo);
    if (detalhe.status === 'filled') return detalhe;
    if (detalhe.status === 'cancelled') return detalhe;
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
  return detalhe; // não confirmou: devolve o último estado visto
}

// `cancelarOrdem` foi removida na revisão de 2026-07-26: nada a chamava e ela
// não está no CONTRATO dos conectores (src/conectores/conector.js). Todas as
// ordens do sistema são A MERCADO — elas preenchem ou falham, nunca ficam
// pendentes esperando cancelamento. Manter o wrapper sugeria uma capacidade que
// o robô não exerce. Está no histórico do git se um dia houver ordem limitada.
