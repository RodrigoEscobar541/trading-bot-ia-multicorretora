// poeira.test.js — a SOBRA DE VENDA que a corretora não aceita de volta
// (V8.20, CLAUDE.md §11.1).
//
// O QUE ACONTECEU, em números de produção (22/08/2026): BN/BNB e BN/SOL tinham
// juntos 234 operações com `status: erro` — 90% de todo o histórico dos dois
// ativos — repetindo a cada ~10 minutos desde 20/08. Sempre a mesma mensagem:
// "quantidade 0.00091488 abaixo do lote mínimo do par BNBBRL (minQty 0.001)".
//
// O CICLO que produzia isso, e ele se fecha sozinho:
//   1. a Binance cobra a taxa da COMPRA no próprio ativo, então quem compra
//      0,035 BNB fica com 0,03491488 na conta;
//   2. a venda trunca a quantidade ao `stepSize` do par (0,001) e vende 0,034 —
//      sempre sobra um resto;
//   3. a reconciliação via saldo sobrando e abria uma posição `externa` com o
//      resto;
//   4. o preço subia, a trava de lucro armava nesse resto, e o Motor passava a
//      pedir uma ordem que a corretora recusa — para sempre.
//
// O filtro de mínimo EXISTIA e não pegou nada: ele olhava
// `minimo_ordem_quantidade`, um número digitado na config que estava em
// 0,00001 — cem vezes menor que o lote real da Binance. Por isso o critério
// aqui é o VALOR da ordem, que é a mesma grandeza em qualquer corretora.
//
// O CONTRATO que este arquivo guarda:
//   1. sobra que não dá para vender NÃO vira posição — mas também não some em
//      silêncio: ela é reportada em `poeira` e segue no saldo do ativo;
//   2. sobra que CRESCEU até passar do mínimo vira posição normalmente;
//   3. sem preço ou sem config não há como julgar, e a posição nasce (na
//      dúvida, o antigo comportamento);
//   4. nenhum dos três caminhos de venda monta ordem abaixo do mínimo;
//   5. o mínimo vale sobre o TOTAL da ordem, nunca sobre o lote isolado —
//      lotes pequenos vendidos JUNTOS somam uma ordem válida, e foi assim que a
//      poeira de BN/SOL saiu da carteira em 19 e 20/08.
//
// Rodar com: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconciliarComSaldo } from '../src/posicoes/posicoes.js';
import {
  avaliar,
  avaliarStopLoss,
  posicoesComTravaFurada,
  ordemAbaixoDoMinimo,
} from '../src/regras/regrasEngine.js';

// Config real de BN/BNB no dia do incidente: mínimo de R$ 10 por ordem e um
// mínimo de quantidade que não protegia nada.
const CONFIG = {
  taxa_compra_percentual: 0.1,
  taxa_venda_percentual: 0.1,
  percentual_max_diferenca_execucao: 1,
  minimo_ordem_valor: 10,
  minimo_ordem_quantidade: 0.00001,
  trava_lucro_gatilho_percentual: 1,
  trava_lucro_devolucao_percentual: 0.9,
};

// A poeira de verdade: 0,00091488 BNB, que a 3.337 vale R$ 3,05.
const POEIRA_QTD = 0.00091488;
const PRECO_BNB = 3337;

// ------------------------------------------------- reconciliação (a origem)

test('POEIRA: sobra abaixo do mínimo da ordem NÃO vira posição', () => {
  const abertas = [];
  const r = reconciliarComSaldo(abertas, POEIRA_QTD, PRECO_BNB, CONFIG);
  assert.equal(r.nova, null, 'a sobra de R$ 3,05 não pode virar posição');
  assert.deepEqual(r.reducoes, []);
  assert.ok(r.poeira, 'a sobra é reportada — não some em silêncio');
  assert.equal(r.poeira.quantidade, POEIRA_QTD);
  assert.ok(r.poeira.valor < r.poeira.minimo);
});

test('POEIRA: o caso exato de 20/08 — vendeu 0,034 de 0,03491488 e sobrou o resto', () => {
  // A posição do lote foi fechada na venda; o saldo na Binance ficou com o
  // resto que o truncamento ao stepSize deixou para trás.
  const r = reconciliarComSaldo([], 0.03491488 - 0.034, PRECO_BNB, CONFIG);
  assert.equal(r.nova, null);
  assert.ok(r.poeira);
});

test('sobra que CRESCEU até passar do mínimo vira posição normalmente', () => {
  // Mesmo ativo, sobra acumulada até valer mais que os R$ 10 da ordem.
  const qtd = 0.005; // × 3.337 = R$ 16,69
  const r = reconciliarComSaldo([], qtd, PRECO_BNB, CONFIG);
  assert.equal(r.nova.quantidade, qtd);
  assert.equal(r.nova.preco_compra, PRECO_BNB);
  assert.equal(r.poeira, undefined);
});

test('sem config ou sem preço a posição NASCE — na dúvida, o comportamento antigo', () => {
  assert.ok(reconciliarComSaldo([], POEIRA_QTD, PRECO_BNB).nova, 'sem config, nasce');
  assert.ok(reconciliarComSaldo([], POEIRA_QTD, PRECO_BNB, {}).nova, 'config sem mínimo, nasce');
  assert.ok(reconciliarComSaldo([], POEIRA_QTD, null, CONFIG).nova, 'sem preço, nasce');
});

test('depósito de verdade continua virando posição externa', () => {
  const abertas = [{ id: 'a', status: 'LUCRO', origem: 'bot', quantidade: 0.01, abertura: '2026-01-01' }];
  const r = reconciliarComSaldo(abertas, 0.015, 320000, { minimo_ordem_valor: 10 });
  assert.equal(r.nova.quantidade, 0.005, 'R$ 1.600 de BTC não é poeira');
});

test('saída externa (saque) não é afetada pelo filtro de poeira', () => {
  const abertas = [{ id: 'a', status: 'LUCRO', origem: 'bot', quantidade: 0.01, abertura: '2026-01-01' }];
  const r = reconciliarComSaldo(abertas, 0.004, 320000, CONFIG);
  assert.equal(r.nova, null);
  assert.deepEqual(r.reducoes, [{ id: 'a', quantidade: 0.004, fechar: false }]);
});

// --------------------------------------------- os três caminhos de venda

const lotePoeira = (extra = {}) => ({
  id: 'pos_20260820_124538_ext',
  status: 'MONITORANDO',
  origem: 'externa',
  quantidade: POEIRA_QTD,
  preco_compra: PRECO_BNB,
  ...extra,
});

test('TRAVA: a poeira com trava armada não monta decisão nenhuma', () => {
  // O lote de produção: comprado a 3.337, pico em 3.664, trava em 3.631,02.
  // Preço abaixo da trava e lucro positivo — tudo que ela precisa para vender,
  // menos uma ordem que a corretora aceite.
  const furadas = posicoesComTravaFurada({
    posicoes_abertas: [lotePoeira({ preco_maximo: 3664, trava_lucro: 3631.02 })],
    preco_atual: 3600,
    config: CONFIG,
  });
  assert.deepEqual(furadas, [], 'sem ordem possível, nada é pedido');
});

test('TRAVA: o mesmo lote em tamanho vendável continua sendo realizado', () => {
  const furadas = posicoesComTravaFurada({
    posicoes_abertas: [lotePoeira({ quantidade: 0.03, preco_maximo: 3664, trava_lucro: 3631.02 })],
    preco_atual: 3600,
    config: CONFIG,
  });
  assert.equal(furadas.length, 1, 'R$ 108 de ordem é venda normal — a trava não mudou');
  assert.ok(furadas[0].lucro_liquido_previsto > 0);
});

test('STOP-LOSS: chão furado numa poeira devolve AGUARDAR, nunca erro', () => {
  const r = avaliarStopLoss({
    posicoes_abertas: [lotePoeira({ stop_loss: 3200 })],
    preco_atual: 3100,
    config: CONFIG,
  });
  assert.equal(r.status, 'aguardar', 'insistir aqui é o que gerava uma operação com erro a cada ciclo');
  assert.match(r.motivo, /abaixo do mínimo/);
});

test('STOP-LOSS: chão furado num lote de verdade continua vendendo', () => {
  const r = avaliarStopLoss({
    posicoes_abertas: [lotePoeira({ quantidade: 0.03, stop_loss: 3200 })],
    preco_atual: 3100,
    config: CONFIG,
  });
  assert.equal(r.status, 'aprovada');
});

test('IA: VENDER uma poeira é rejeitada por saldo, não vira ordem', () => {
  const r = avaliar({
    decisao: { acao: 'VENDER', percentual: 0, posicoes: ['pos_20260820_124538_ext'], valida: true },
    carteira: { saldo_moeda: 500, saldo_ativo: POEIRA_QTD },
    posicoes_abertas: [lotePoeira()],
    preco_analise: 3600,
    preco_execucao: 3600,
    ordens_abertas: [],
    config: CONFIG,
  });
  assert.equal(r.status, 'rejeitada_saldo');
  assert.match(r.motivo, /abaixo do mínimo/);
});

test('O MÍNIMO É DO TOTAL DA ORDEM: dois lotes pequenos vendidos JUNTOS passam', () => {
  // É assim que a poeira sai da carteira — pegando carona numa venda maior,
  // como aconteceu de verdade em BN/SOL nos dias 19 e 20/08. Filtrar lote a
  // lote quebraria a única limpeza que funciona.
  const grande = { ...lotePoeira(), id: 'pos_grande', quantidade: 0.03 };
  const r = avaliar({
    decisao: { acao: 'VENDER', percentual: 0, posicoes: ['pos_grande', 'pos_20260820_124538_ext'], valida: true },
    carteira: { saldo_moeda: 500, saldo_ativo: 0.03 + POEIRA_QTD },
    posicoes_abertas: [grande, lotePoeira()],
    preco_analise: 3600,
    preco_execucao: 3600,
    ordens_abertas: [],
    config: CONFIG,
  });
  assert.equal(r.status, 'aprovada');
  assert.equal(r.ordem.posicoes.length, 2, 'a poeira sai junto com o lote grande');
});

// ------------------------------------------------------------- a função pura

test('ordemAbaixoDoMinimo se abstém quando não dá para julgar', () => {
  const p = [lotePoeira()];
  assert.equal(ordemAbaixoDoMinimo([], PRECO_BNB, CONFIG), null);
  assert.equal(ordemAbaixoDoMinimo(p, null, CONFIG), null, 'sem preço, não bloqueia');
  assert.equal(ordemAbaixoDoMinimo(p, PRECO_BNB, { minimo_ordem_valor: 0 }), null, 'mínimo 0 desliga');
  assert.ok(ordemAbaixoDoMinimo(p, PRECO_BNB, {}), 'sem config vale o fallback de 10');
});
