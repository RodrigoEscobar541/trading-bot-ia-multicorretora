// ttRest.js — conta, saldos, posições, ordens e sessões de mercado da API da
// Tastytrade (autenticado via ttAuth).
//
// Submódulo do conector TT (src/conectores/tt/conectorTT.js). Regras:
//   - Todas as ordens são A MERCADO (regras.md §9) — compra por VALOR usa o
//     tipo 'Notional Market' (fração de ação); venda usa 'Market' por
//     quantidade com action 'Sell to Close'.
//   - Antes da ordem real, um DRY-RUN captura as taxas calculadas pela
//     corretora (fee-calculation) — é a taxa registrada na operação, sem o
//     usuário precisar digitar nada. Falha no dry-run não impede a ordem.
//   - Este módulo NÃO decide nada: só executa o que o Motor de Regras aprovou.
//     Em execução real, quem chama NUNCA reenvia ordem sem confirmar que a
//     anterior não foi criada (proteção contra duplicidade — CLAUDE.md §14).

import { ErroTT, requisitar } from './ttHttp.js';
import { autenticar } from './ttAuth.js';

const n = (v) => (v === undefined || v === null ? 0 : Number(v));

// Cache do número da conta (não muda durante a vida do processo).
const contas = new Map(); // refreshToken → accountNumber

/** Número da conta: o configurado (tt_account_id) ou a primeira do cliente. */
export async function obterContaId(credenciais) {
  if (credenciais.contaId) return credenciais.contaId;
  const cache = contas.get(credenciais.refreshToken);
  if (cache) return cache;

  const token = await autenticar(credenciais);
  const dados = await requisitar('GET', '/customers/me/accounts', { token, ambiente: credenciais.ambiente });
  const conta = dados?.items?.[0]?.account?.['account-number'];
  if (!conta) {
    throw new ErroTT('nenhuma conta encontrada para as credenciais informadas', { endpoint: '/customers/me/accounts' });
  }
  contas.set(credenciais.refreshToken, conta);
  return conta;
}

/**
 * Saldos da conta no formato do contrato dos conectores:
 *   { moeda: 'USD', saldo_moeda, saldos: { SIMBOLO: qtd } }
 * Caixa = cash-balance; saldos = posições LONG de ações (instrument-type
 * Equity), na quantidade de ações (fracionária quando for o caso).
 */
export async function obterSaldos(credenciais) {
  const token = await autenticar(credenciais);
  const contaId = await obterContaId(credenciais);
  const [saldo, posicoes] = await Promise.all([
    requisitar('GET', `/accounts/${contaId}/balances`, { token, ambiente: credenciais.ambiente }),
    requisitar('GET', `/accounts/${contaId}/positions`, { token, ambiente: credenciais.ambiente }),
  ]);

  const saldos = {};
  for (const p of posicoes?.items ?? []) {
    if (p?.['instrument-type'] !== 'Equity') continue;
    if (p['quantity-direction'] === 'Short') continue;
    const qtd = n(p.quantity);
    if (qtd > 0) saldos[p.symbol] = qtd;
  }
  return { moeda: 'USD', saldo_moeda: n(saldo?.['cash-balance']), saldos };
}

// Status que ainda podem virar execução — qualquer um deles bloqueia o par
// na regra 2 do Motor (tratamento conservador).
const STATUS_VIVOS = new Set([
  'Received', 'Routed', 'In Flight', 'Live', 'Contingent',
  'Cancel Requested', 'Replace Requested',
]);

/** Ordens ABERTAS (vivas) no símbolo — regra 2 do Motor de Regras. */
export async function obterOrdensAbertas(credenciais, simbolo) {
  const token = await autenticar(credenciais);
  const contaId = await obterContaId(credenciais);
  const dados = await requisitar('GET', `/accounts/${contaId}/orders/live`, {
    token,
    ambiente: credenciais.ambiente,
  });
  return (dados?.items ?? []).filter(
    (o) =>
      STATUS_VIVOS.has(o?.status) &&
      (o?.['underlying-symbol'] === simbolo || (o?.legs ?? []).some((l) => l?.symbol === simbolo)),
  );
}

/** Monta o corpo da ordem a mercado (compra por valor / venda por quantidade). */
export function montarOrdemMercado({ simbolo, lado, valor, quantidade }) {
  if (lado === 'buy') {
    if (!Number.isFinite(valor) || valor <= 0) throw new ErroTT('compra sem valor válido');
    // 'Notional Market': compra por VALOR em USD (fração de ação) — o
    // equivalente direto da compra por `cost` do MB.
    return {
      'time-in-force': 'Day',
      'order-type': 'Notional Market',
      value: Math.round(valor * 100) / 100,
      'value-effect': 'Debit',
      legs: [{ 'instrument-type': 'Equity', symbol: simbolo, action: 'Buy to Open' }],
    };
  }
  if (lado === 'sell') {
    if (!Number.isFinite(quantidade) || quantidade <= 0) throw new ErroTT('venda sem quantidade válida');
    return {
      'time-in-force': 'Day',
      'order-type': 'Market',
      legs: [{ 'instrument-type': 'Equity', symbol: simbolo, quantity: quantidade, action: 'Sell to Close' }],
    };
  }
  throw new ErroTT(`lado de ordem inválido: ${lado}`);
}

// Taxa estimada pelo dry-run, por ordem criada — anexada ao fill em obterOrdem
// (a resposta da ordem em si não traz as taxas).
const taxasEstimadas = new Map(); // orderId → total_fees

/**
 * Cria uma ordem A MERCADO já aprovada pelo Motor de Regras. Antes de enviar,
 * faz um DRY-RUN para capturar as taxas calculadas pela corretora (melhor
 * esforço — indisponibilidade do dry-run não bloqueia a ordem).
 * Devolve { orderId }; a confirmação do fill é feita em aguardarFill().
 */
export async function criarOrdemMercado(credenciais, { simbolo, lado, valor, quantidade }) {
  const corpo = montarOrdemMercado({ simbolo, lado, valor, quantidade });
  const token = await autenticar(credenciais);
  const contaId = await obterContaId(credenciais);

  let taxaEstimada = null;
  try {
    const simulada = await requisitar('POST', `/accounts/${contaId}/orders/dry-run`, {
      token,
      corpo,
      ambiente: credenciais.ambiente,
    });
    const taxas = simulada?.['fee-calculation'];
    if (taxas) taxaEstimada = Math.abs(n(taxas['total-fees']));
  } catch {
    // Dry-run é só para capturar taxas: se falhar, a ordem segue com taxa 0.
  }

  const dados = await requisitar('POST', `/accounts/${contaId}/orders`, {
    token,
    corpo,
    ambiente: credenciais.ambiente,
  });
  const orderId = dados?.order?.id ?? dados?.id;
  if (orderId === undefined || orderId === null) {
    throw new ErroTT('criação de ordem não devolveu id', { endpoint: 'orders' });
  }
  if (taxaEstimada !== null) taxasEstimadas.set(String(orderId), taxaEstimada);
  return { orderId: String(orderId) };
}

// Valor do PEDIDO DE TESTE (§10.11), em USD: casa com o `minimo_ordem_valor`
// com que os ativos da TT nascem. Nada é comprado — o dry-run só valida.
const VALOR_TESTE = 5;

/**
 * PROVA DE EXECUÇÃO (§10.11) — a credencial consegue mesmo mandar ordem?
 *
 * Reaproveita o DRY-RUN que o conector já usa antes de toda ordem real: a
 * corretora valida a ordem inteira e não cria nada.
 *
 * Devolve TRÊS estados, nunca lança:
 *   { ok: true }  → a ordem passaria;
 *   { ok: false } → a credencial foi RECUSADA (sem permissão de negociar);
 *   { ok: null }  → não deu para saber (rede, pregão fechado, saldo).
 *
 * O corte entre `false` e `null` é o `autenticacao` do ErroTT — o mesmo sinal
 * que o streamer de cotações usa para renovar o token (V8.15). Erro de
 * validação de ordem NÃO é falta de permissão e não pode virar alarme.
 */
export async function testarOrdem(credenciais, { simbolo } = {}) {
  if (!simbolo) return { ok: null, erro: 'sem par para testar' };
  try {
    const token = await autenticar(credenciais);
    const contaId = await obterContaId(credenciais);
    const corpo = montarOrdemMercado({ simbolo, lado: 'buy', valor: VALOR_TESTE });
    await requisitar('POST', `/accounts/${contaId}/orders/dry-run`, {
      token,
      corpo,
      ambiente: credenciais.ambiente,
    });
    return { ok: true, erro: null };
  } catch (e) {
    const recusada = e instanceof ErroTT && (e.autenticacao || e.status === 401 || e.status === 403);
    return { ok: recusada ? false : null, erro: e?.message ?? String(e) };
  }
}

// Mapa do status da Tastytrade para o vocabulário do contrato dos conectores.
const STATUS_FINAL = {
  Filled: 'filled',
  Cancelled: 'cancelled',
  Rejected: 'cancelled',
  Expired: 'cancelled',
  Removed: 'cancelled',
  'Partially Removed': 'cancelled',
};

/**
 * Detalhe de uma ordem, normalizado para o registro de operação (§6.3):
 * status, quantidade executada, valor movimentado, preço médio e taxa
 * (estimativa do dry-run — comissão zero em ações; sobram centavos
 * regulatórios na venda).
 */
export async function obterOrdem(credenciais, orderId, simbolo) {
  const token = await autenticar(credenciais);
  const contaId = await obterContaId(credenciais);
  const o = await requisitar('GET', `/accounts/${contaId}/orders/${orderId}`, {
    token,
    ambiente: credenciais.ambiente,
  });
  if (o?.id === undefined || o?.id === null) {
    throw new ErroTT(`ordem ${orderId} não encontrada`, { endpoint: 'orders' });
  }

  const fills = (o.legs ?? []).flatMap((l) => l?.fills ?? []);
  const qtdExecutada = fills.reduce((s, f) => s + n(f.quantity), 0);
  const valorExecutado = fills.reduce((s, f) => s + n(f.quantity) * n(f['fill-price']), 0);
  const precoMedio = qtdExecutada > 0 ? valorExecutado / qtdExecutada : 0;

  return {
    id: String(o.id),
    status: STATUS_FINAL[o.status] ?? 'working',
    lado: (o.legs?.[0]?.action ?? '').startsWith('Buy') ? 'buy' : 'sell',
    simbolo,
    quantidade: qtdExecutada,
    valor: valorExecutado,
    preco_medio: precoMedio,
    taxa: taxasEstimadas.get(String(o.id)) ?? 0,
    bruta: o, // objeto original, para depuração/registro
  };
}

/**
 * Aguarda o fill de uma ordem a mercado (normalmente instantâneo no pregão).
 * Consulta a cada `intervaloMs` até `tentativas`; devolve o detalhe final.
 * NUNCA recria a ordem — se não confirmar, quem chama marca `status: "erro"`.
 */
export async function aguardarFill(credenciais, orderId, { simbolo, tentativas = 10, intervaloMs = 1000 } = {}) {
  let detalhe = null;
  for (let i = 0; i < tentativas; i++) {
    detalhe = await obterOrdem(credenciais, orderId, simbolo);
    if (detalhe.status === 'filled' || detalhe.status === 'cancelled') return detalhe;
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
  return detalhe; // não confirmou: devolve o último estado visto
}

/**
 * Estado ATUAL do pregão de ações nos EUA, direto da corretora
 * (GET /market-time/sessions/current) — cobre fins de semana, FERIADOS e
 * meio-pregão sem tabela local. Formato:
 *   { aberto, estado, abre_em, fecha_em }
 * `estado` é o cru da API ('Open' | 'Closed' | 'Pre-market' | 'Extended') —
 * o bot só opera com 'Open' (pregão regular).
 */
export async function estadoMercado(credenciais) {
  const token = await autenticar(credenciais);
  const dados = await requisitar('GET', '/market-time/sessions/current', {
    token,
    ambiente: credenciais.ambiente,
    params: { 'instrument-collections[]': ['Equity'] },
  });
  const sessao = dados?.items?.[0];
  if (!sessao?.state) {
    throw new ErroTT('sessão de mercado em formato inesperado', { endpoint: '/market-time/sessions/current' });
  }
  const aberto = sessao.state === 'Open';
  // Próxima abertura: a da sessão do dia se ainda não chegou (madrugada/
  // pré-abertura), senão a da sessão seguinte — a API pula feriados e já
  // devolve o horário certo em dias de meio-pregão.
  const aberturaDoDia = sessao['open-at'] ?? null;
  const aberturaFutura =
    aberturaDoDia && new Date(aberturaDoDia).getTime() > Date.now()
      ? aberturaDoDia
      : sessao['next-session']?.['open-at'] ?? null;
  return {
    aberto,
    estado: sessao.state,
    abre_em: aberto ? null : aberturaFutura,
    fecha_em: sessao['close-at'] ?? null,
  };
}

/** Limpa caches (testes). */
export function limparCachesRest() {
  contas.clear();
  taxasEstimadas.clear();
}
