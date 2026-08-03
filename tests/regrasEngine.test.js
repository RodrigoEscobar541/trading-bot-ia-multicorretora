// regrasEngine.test.js — o Motor de Regras é a última barreira antes de
// qualquer execução; cada regra da seção 10 do CLAUDE.md tem teste próprio.
// V2: campos genéricos (saldo_moeda/saldo_ativo/quantidade/valor), mínimos
// vindos da config do ativo e orçamento por ativo. Rodar com: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  avaliar,
  avaliarStopLoss,
  avaliarTrailingStop,
  validarStopLossCompra,
  validarAjustesStopLoss,
  calcularLucroLiquidoVenda,
  precoMinimoVendaLucrativa,
  taxaCompraPercentualEfetiva,
  breakevenPosicao,
  lucroRealizadoVenda,
  limiteDivergenciaEfetivo,
  STOP_LOSS_MAX_DISTANCIA_FALLBACK,
  STOP_LOSS_TRAILING_PADRAO,
} from '../src/regras/regrasEngine.js';

const CONFIG = {
  percentual_max_diferenca_execucao: 1.0,
  taxa_compra_percentual: 1.5,
  taxa_venda_percentual: 1.5,
  minimo_ordem_valor: 10,
  minimo_ordem_quantidade: 0.00001,
  orcamento_percentual: 100,
};

// Toda COMPRA precisa declarar o chao (V6.6) — 336.000 fica 4% abaixo do preco
// de execucao usado nos testes: dentro do teto de distancia padrao (15%) e com
// folga suficiente (>= 3%, o padrao do Motor) para nao ser alargado na V8.8.
const compra = (extra = {}) => ({
  acao: 'COMPRAR',
  percentual: 35,
  stop_loss: 336000,
  stop_loss_motivo: 'abaixo do fundo recente',
  valida: true,
  ...extra,
});

const base = (extra = {}) => ({
  decisao: compra(),
  carteira: { saldo_moeda: 5000, saldo_ativo: 0.014 },
  preco_analise: 350000,
  preco_execucao: 350000,
  ordens_abertas: [],
  config: CONFIG,
  ...extra,
});

// ------------------------------------------------------------- lucro líquido

test('fórmula do lucro líquido desconta as duas taxas', () => {
  // venda 4900, custo 4760, taxa compra 71.40, taxa venda 73.50 → -4.90
  const lucro = calcularLucroLiquidoVenda({
    quantidade: 0.014,
    preco_venda: 350000,
    preco_compra: 340000,
    taxa_compra_percentual: 1.5,
    taxa_venda_percentual: 1.5,
  });
  assert.ok(Math.abs(lucro - -4.9) < 1e-9, `lucro = ${lucro}`);
});

test('lucro REALIZADO desconta as taxas ABSOLUTAS informadas (não os percentuais da config)', () => {
  // venda 1100, custo 1000, taxa compra real 7, taxa venda real 11 → 82
  const lucro = lucroRealizadoVenda({
    quantidade: 0.01,
    preco_venda: 110000,
    preco_compra: 100000,
    taxa_compra: 7,
    taxa_venda: 11,
  });
  assert.ok(Math.abs(lucro - 82) < 1e-9, `lucro = ${lucro}`);
});

test('venda aprovada repassa a taxa_compra REAL da posição na ordem (p/ o lucro realizado)', () => {
  const abertas = [posicao({ id: 'pos_a', taxa_compra: 5 })];
  const r = avaliar(vendaBase(360000, abertas, ['pos_a']));
  assert.equal(r.status, 'aprovada');
  assert.equal(r.ordem.posicoes[0].taxa_compra, 5);
});

test('venda aprovada de posição SEM taxa_compra (externa) repassa null', () => {
  const abertas = [posicao({ id: 'pos_ext', origem: 'externa' })]; // sem taxa_compra
  const r = avaliar(vendaBase(360000, abertas, ['pos_ext']));
  assert.equal(r.status, 'aprovada');
  assert.equal(r.ordem.posicoes[0].taxa_compra, null);
});

// ----------------------------------------------------------------- AGUARDAR

test('AGUARDAR não gera ordem nem rejeição', () => {
  const r = avaliar(base({ decisao: { acao: 'AGUARDAR', percentual: 0, valida: true } }));
  assert.equal(r.status, 'aguardar');
  assert.equal(r.aprovada, false);
  assert.equal(r.ordem, null);
});

test('resposta inválida da IA (fallback) fica como aguardar', () => {
  const r = avaliar(
    base({ decisao: { acao: 'AGUARDAR', percentual: 0, valida: false, motivo_invalidez: 'x' } }),
  );
  assert.equal(r.status, 'aguardar');
});

// ---------------------------------------------------------- 1. saldo/percentual

test('COMPRAR aprovada calcula valor em centavos exatos', () => {
  const r = avaliar(base());
  assert.equal(r.status, 'aprovada');
  assert.deepEqual(r.ordem, {
    tipo: 'COMPRA',
    valor: 1750,
    preco_execucao: 350000,
    stop_loss: 336000,
    stop_loss_motivo: 'abaixo do fundo recente',
    stop_loss_truncado: false,
    stop_loss_alargado: false,
    stop_loss_distancia_percentual: 4,
    trailing_percentual: null, // a IA não declarou: vale o padrão do ativo
  });
});

test('percentual fora de 1..100 ou não inteiro → rejeitada_saldo', () => {
  for (const percentual of [0, 101, -5, 35.5, NaN, 'dez']) {
    const r = avaliar(base({ decisao: { acao: 'COMPRAR', percentual, valida: true } }));
    assert.equal(r.status, 'rejeitada_saldo', `percentual ${percentual}`);
  }
});

test('compra abaixo do mínimo do ativo → rejeitada_saldo', () => {
  const r = avaliar(
    base({
      carteira: { saldo_moeda: 100, saldo_ativo: 0 },
      decisao: compra({ percentual: 5 }), // R$ 5,00 < mínimo R$ 10
    }),
  );
  assert.equal(r.status, 'rejeitada_saldo');
});

test('mínimos vêm da config do ativo (não são constantes do Motor)', () => {
  // Mesmo cenário do teste anterior, mas com mínimo de R$ 2 na config: passa.
  const r = avaliar(
    base({
      carteira: { saldo_moeda: 100, saldo_ativo: 0 },
      decisao: compra({ percentual: 5 }),
      config: { ...CONFIG, minimo_ordem_valor: 2 },
    }),
  );
  assert.equal(r.status, 'aprovada');
});

test('venda de posição abaixo do mínimo de quantidade → rejeitada_saldo', () => {
  const r = avaliar(
    base({
      carteira: { saldo_moeda: 0, saldo_ativo: 0.00005 },
      decisao: { acao: 'VENDER', percentual: 0, posicoes: ['pos_a'], valida: true },
      posicoes_abertas: [
        { id: 'pos_a', status: 'MONITORANDO', origem: 'bot', quantidade: 0.000005, preco_compra: 300000 },
      ],
    }),
  );
  assert.equal(r.status, 'rejeitada_saldo');
});

// ------------------------------------------------- 1b. orçamento por ativo (V2)

test('orçamento limita a base da compra ao teto livre do ativo', () => {
  // Patrimônio 10.000, orçamento 30% → teto 3.000; posições já ocupam 2.000
  // → livre 1.000. Caixa tem 5.000, mas a base é 1.000: 50% → R$ 500.
  const r = avaliar(
    base({
      decisao: compra({ percentual: 50 }),
      config: { ...CONFIG, orcamento_percentual: 30 },
      patrimonio_plataforma: 10000,
      valor_posicoes_ativo: 2000,
    }),
  );
  assert.equal(r.status, 'aprovada');
  assert.equal(r.ordem.valor, 500);
});

test('ativo com orçamento estourado não compra (livre ~0)', () => {
  const r = avaliar(
    base({
      decisao: compra({ percentual: 100 }),
      config: { ...CONFIG, orcamento_percentual: 20 },
      patrimonio_plataforma: 10000,
      valor_posicoes_ativo: 2500, // já acima do teto de 2.000
    }),
  );
  assert.equal(r.status, 'rejeitada_saldo');
  assert.match(r.motivo, /orçamento/);
});

test('orçamento 0% rejeita compra com orientação de configurar', () => {
  const r = avaliar(base({ config: { ...CONFIG, orcamento_percentual: 0 } }));
  assert.equal(r.status, 'rejeitada_saldo');
  assert.match(r.motivo, /orcamento_percentual/);
});

test('sem dados de patrimônio, o teto não se aplica (base = caixa)', () => {
  const r = avaliar(base({ config: { ...CONFIG, orcamento_percentual: 30 } }));
  assert.equal(r.status, 'aprovada');
  assert.equal(r.ordem.valor, 1750); // 35% do caixa de 5.000
});

test('orçamento nunca deixa a compra exceder o caixa', () => {
  // Teto livre (8.000) maior que o caixa (5.000): base continua sendo o caixa.
  const r = avaliar(
    base({
      decisao: compra({ percentual: 100 }),
      config: { ...CONFIG, orcamento_percentual: 80 },
      patrimonio_plataforma: 10000,
      valor_posicoes_ativo: 0,
    }),
  );
  assert.equal(r.status, 'aprovada');
  assert.equal(r.ordem.valor, 5000);
});

// ------------------------------------------------------------ 2. ordens abertas

test('qualquer ordem aberta no par bloqueia a execução', () => {
  const r = avaliar(base({ ordens_abertas: [{ id: 'x', side: 'buy' }] }));
  assert.equal(r.status, 'rejeitada_regras');
  assert.match(r.motivo, /ordem\(ns\) aberta/);
});

// ------------------------------------------------------ 3. divergência de preço

test('divergência de preço >= 1% entre análise e execução rejeita', () => {
  const r = avaliar(base({ preco_execucao: 353500 })); // exatamente 1.0% acima
  assert.equal(r.status, 'rejeitada_regras');
  assert.match(r.motivo, /diverg/);
});

test('divergência abaixo do limite passa', () => {
  const r = avaliar(base({ preco_execucao: 352000 })); // ~0.57%
  assert.equal(r.status, 'aprovada');
});

// --------------------------------- 5. regra de venda (POR POSIÇÃO, CLAUDE.md §11.1)

const posicao = (extra = {}) => ({
  id: 'pos_a',
  status: 'MONITORANDO',
  origem: 'bot',
  quantidade: 0.01,
  preco_compra: 340000,
  ...extra,
});

const vendaBase = (preco_execucao, posicoes_abertas = [posicao()], ids = ['pos_a']) =>
  base({
    decisao: { acao: 'VENDER', percentual: 0, posicoes: ids, valida: true },
    preco_analise: preco_execucao,
    preco_execucao,
    carteira: { saldo_moeda: 0, saldo_ativo: 0.02 },
    posicoes_abertas,
  });

// =====================================================================
// STOP-LOSS (V6.6) — a única porta de venda no prejuízo
// =====================================================================

// ------------------------------------------- validação do chão na COMPRA

test('stop-loss válido é aceito e devolve a distância até o preço', () => {
  const r = validarStopLossCompra({ stop_loss: 336000, preco_execucao: 350000, config: CONFIG });
  assert.equal(r.ok, true);
  assert.equal(r.stop_loss, 336000);
  assert.equal(r.truncado, false);
  assert.equal(r.alargado, false);
  assert.equal(r.distancia_percentual, 4);
});

test('stop-loss no preço atual ou acima dele é RECUSADO (dispararia na hora)', () => {
  for (const v of [350000, 360000]) {
    const r = validarStopLossCompra({ stop_loss: v, preco_execucao: 350000, config: CONFIG });
    assert.equal(r.ok, false, `stop ${v} deveria ser recusado`);
    assert.match(r.motivo, /abaixo do preço/);
  }
});

test('stop-loss distante demais é TRUNCADO no teto, nunca ampliado', () => {
  // 200.000 fica 42,9% abaixo de 350.000; teto padrão de 15% → 297.500.
  const r = validarStopLossCompra({ stop_loss: 200000, preco_execucao: 350000, config: CONFIG });
  assert.equal(r.ok, true);
  assert.equal(r.truncado, true);
  assert.equal(r.stop_loss, 350000 * (1 - STOP_LOSS_MAX_DISTANCIA_FALLBACK / 100));
  assert.ok(r.stop_loss > 200000, 'o chão truncado é mais APERTADO que o pedido');
});

// ------------------------------- FOLGA MÍNIMA DO CHÃO (V8.8)
// O prejuízo do stop-loss não vinha do stop: vinha de chão colado no preço.
// Em 13 stops com prejuízo antes do reset de 2026-07-27, 12 tinham chão posto
// pela IA (ancorado em mm9/mm21 de 15 min, a 0,3%–1% do preço); o trailing do
// Motor, que sempre respeitou a própria distância, não causou nenhum.

test('chão colado no preço na COMPRA é ALARGADO até a folga, nunca rejeitado', () => {
  // Rejeitar seria pior: com folga de 5% e a IA declarando 3,4% (o que ela
  // declarava de verdade), toda compra seria recusada e o robô pararia.
  const config = { ...CONFIG, stop_loss_trailing_percentual: 5 };
  const r = validarStopLossCompra({ stop_loss: 349000, preco_execucao: 350000, config }); // 0,29%
  assert.equal(r.ok, true);
  assert.equal(r.alargado, true);
  assert.equal(r.truncado, false);
  assert.equal(r.stop_loss, 332500); // 350.000 × 0,95
  assert.equal(r.distancia_percentual, 5);
  assert.match(r.motivo, /ruído do dia/);
});

test('a folga do ativo é configurável pelo dono (mesma chave do trailing)', () => {
  for (const [folga, esperado] of [[3, 339500], [5, 332500], [8, 322000]]) {
    const r = validarStopLossCompra({
      stop_loss: 349900,
      preco_execucao: 350000,
      config: { ...CONFIG, stop_loss_trailing_percentual: folga },
    });
    assert.equal(r.stop_loss, esperado, `folga de ${folga}%`);
  }
});

test('ajuste que aperta o chão DENTRO da folga é descartado — o chão largo continua', () => {
  // O caso exato do prejuízo real: "elevação do chão para a mm21", que ficava a
  // 0,4% do preço, e o lote morria na primeira oscilação do dia.
  const config = { ...CONFIG, stop_loss_trailing_percentual: 5 };
  const { aplicar, descartados } = validarAjustesStopLoss({
    ajustes: [{ id: 'pos_a', stop_loss: 358500, motivo: 'elevação para a mm21' }], // 0,42%
    posicoes_abertas: [posicao({ stop_loss: 330000 })],
    preco_atual: 360000,
    config,
  });
  assert.deepEqual(aplicar, []);
  assert.match(descartados[0].motivo, /ruído do dia/);
  assert.match(descartados[0].motivo, /330000.*continua valendo/);
});

test('posição SEM chão recebe o primeiro chão ALARGADO até a folga (melhor que ficar nua)', () => {
  const config = { ...CONFIG, stop_loss_trailing_percentual: 5 };
  const { aplicar } = validarAjustesStopLoss({
    ajustes: [{ id: 'pos_a', stop_loss: 358500, motivo: 'chão da posição externa' }],
    posicoes_abertas: [posicao()], // sem stop_loss
    preco_atual: 360000,
    config,
  });
  assert.equal(aplicar.length, 1);
  assert.equal(aplicar[0].stop_loss, 342000); // 360.000 × 0,95
  assert.equal(aplicar[0].alargado, true);
});

test('a folga nunca passa do teto de distância (senão nenhum chão seria possível)', () => {
  const config = { ...CONFIG, stop_loss_max_distancia_percentual: 4, stop_loss_trailing_percentual: 30 };
  const r = validarStopLossCompra({ stop_loss: 349900, preco_execucao: 350000, config });
  assert.equal(r.stop_loss, 336000); // alargado até o TETO de 4%, não até 30%
  assert.equal(r.alargado, true);
});

test('teto de distância do stop vem da config do ativo quando definido', () => {
  const config = { ...CONFIG, stop_loss_max_distancia_percentual: 5 };
  const r = validarStopLossCompra({ stop_loss: 300000, preco_execucao: 350000, config });
  assert.equal(r.truncado, true);
  assert.equal(r.stop_loss, 332500); // 350.000 × 0,95
});

test('COMPRAR sem stop-loss válido é rejeitada pelo Motor', () => {
  const semStop = avaliar(base({ decisao: compra({ stop_loss: undefined }) }));
  assert.equal(semStop.status, 'rejeitada_regras');
  assert.match(semStop.motivo, /stop-loss/);

  const acimaDoPreco = avaliar(base({ decisao: compra({ stop_loss: 360000 }) }));
  assert.equal(acimaDoPreco.status, 'rejeitada_regras');
});

test('COMPRAR com stop distante é aprovada com o chão já truncado na ordem', () => {
  const r = avaliar(base({ decisao: compra({ stop_loss: 100000 }) }));
  assert.equal(r.status, 'aprovada');
  assert.equal(r.ordem.stop_loss, 297500); // truncado no teto de 15%
  assert.equal(r.ordem.stop_loss_truncado, true);
});

// -------------------------------------------- disparo do stop (avaliarStopLoss)

const stopBase = (preco_atual, posicoes_abertas, extra = {}) => ({
  posicoes_abertas,
  preco_atual,
  config: CONFIG,
  ordens_abertas: [],
  carteira: { saldo_ativo: 1 },
  ...extra,
});

test('preço abaixo do chão dispara a venda MESMO no prejuízo', () => {
  const p = posicao({ stop_loss: 330000 }); // comprada a 340.000
  const r = avaliarStopLoss(stopBase(325000, [p]));
  assert.equal(r.status, 'aprovada');
  assert.equal(r.ordem.tipo, 'VENDA');
  assert.equal(r.ordem.origem, 'stop_loss');
  assert.equal(r.ordem.posicoes[0].id, 'pos_a');
  assert.ok(r.ordem.lucro_liquido_previsto < 0, 'a venda por stop sai no prejuízo — é o ponto dela');
});

test('preço exatamente NO chão dispara (comparação é <=)', () => {
  const r = avaliarStopLoss(stopBase(330000, [posicao({ stop_loss: 330000 })]));
  assert.equal(r.status, 'aprovada');
});

test('preço acima do chão não dispara nada', () => {
  const r = avaliarStopLoss(stopBase(335000, [posicao({ stop_loss: 330000 })]));
  assert.equal(r.aguardar, true);
  assert.equal(r.ordem, null);
});

test('posição SEM stop_loss nunca é vendida pelo stop, por mais que caia', () => {
  const r = avaliarStopLoss(stopBase(1000, [posicao()])); // sem stop_loss, preço despencou
  assert.equal(r.aguardar, true);
  assert.equal(r.ordem, null);
});

test('só as posições com o chão furado são vendidas — as demais ficam intactas', () => {
  const furada = posicao({ id: 'pos_furada', stop_loss: 330000 });
  const intacta = posicao({ id: 'pos_intacta', stop_loss: 300000 });
  const semChao = posicao({ id: 'pos_sem_chao' });
  const r = avaliarStopLoss(stopBase(325000, [furada, intacta, semChao]));
  assert.equal(r.status, 'aprovada');
  assert.deepEqual(r.ordem.posicoes.map((p) => p.id), ['pos_furada']);
});

test('posição já em VENDA ou FECHADA é ignorada pelo stop', () => {
  const emVenda = posicao({ id: 'pos_v', status: 'VENDA', stop_loss: 330000 });
  const fechada = posicao({ id: 'pos_f', status: 'FECHADA', stop_loss: 330000 });
  const r = avaliarStopLoss(stopBase(325000, [emVenda, fechada]));
  assert.equal(r.aguardar, true);
});

test('ordem aberta no par bloqueia a execução do stop (conservador)', () => {
  const r = avaliarStopLoss(
    stopBase(325000, [posicao({ stop_loss: 330000 })], { ordens_abertas: [{ id: 'o1' }] }),
  );
  assert.equal(r.status, 'rejeitada_regras');
  assert.match(r.motivo, /ordem\(ns\) aberta/);
});

test('soma das posições em stop acima do saldo é erro (livro inconsistente)', () => {
  const r = avaliarStopLoss(
    stopBase(325000, [posicao({ stop_loss: 330000, quantidade: 5 })], { carteira: { saldo_ativo: 1 } }),
  );
  assert.equal(r.status, 'erro');
});

test('avaliar() comum NUNCA vende no prejuízo, mesmo com o chão furado', () => {
  // A porta do prejuízo é só o avaliarStopLoss: o caminho da IA segue travado.
  const p = posicao({ stop_loss: 330000 });
  const r = avaliar(vendaBase(325000, [p], ['pos_a']));
  assert.equal(r.status, 'rejeitada_regras');
  assert.match(r.motivo, /nunca vender no prejuízo/);
});

// ------------------------------------------------- ajustes (trailing stop)

const posAberta = (extra = {}) => posicao({ ...extra });

test('ajuste que SOBE o chão é aplicado', () => {
  // Abaixo do preço de compra (340k): chão de proteção puro, longe da faixa
  // de taxa — o valor pedido é aplicado exatamente como veio.
  const { aplicar, descartados } = validarAjustesStopLoss({
    ajustes: [{ id: 'pos_a', stop_loss: 335000, motivo: 'trailing' }],
    posicoes_abertas: [posAberta({ stop_loss: 330000 })],
    preco_atual: 360000,
    config: CONFIG,
  });
  assert.deepEqual(descartados, []);
  assert.equal(aplicar.length, 1);
  assert.equal(aplicar[0].stop_loss, 335000);
  assert.equal(aplicar[0].elevado_breakeven, false);
});

test('ajuste que BAIXA o chão é descartado', () => {
  const { aplicar, descartados } = validarAjustesStopLoss({
    ajustes: [{ id: 'pos_a', stop_loss: 320000 }],
    posicoes_abertas: [posAberta({ stop_loss: 330000 })],
    preco_atual: 360000,
    config: CONFIG,
  });
  assert.deepEqual(aplicar, []);
  assert.match(descartados[0].motivo, /só pode subir/);
});

test('posição SEM chão pode receber o primeiro stop pela IA', () => {
  const { aplicar } = validarAjustesStopLoss({
    ajustes: [{ id: 'pos_a', stop_loss: 335000, motivo: 'definindo o chão da posição externa' }],
    posicoes_abertas: [posAberta()], // sem stop_loss
    preco_atual: 360000,
    config: CONFIG,
  });
  assert.equal(aplicar.length, 1);
  assert.equal(aplicar[0].stop_loss, 335000);
});

// ------------------------------- trailing cego a taxas (correção pós-V6.6)
// Motivação real: chão subido para ~o preço de compra, stop acionado a +0,07%
// bruto e −0,87 LÍQUIDO. Vender no preço de entrada paga as duas taxas.

test('chão pedido na faixa de prejuízo por taxa sobe até o breakeven real', () => {
  // compra 340.000, taxas 1,5% + 1,5% → breakeven = 340000 × 1,015 / 0,985
  // Preço a 380.000: o breakeven fica 7,8% abaixo dele, com folga sobrando —
  // se estivesse colado no preço, a V8.8 descartaria o ajuste (teste seguinte).
  const breakeven = precoMinimoVendaLucrativa(340000, CONFIG);
  const { aplicar, descartados } = validarAjustesStopLoss({
    ajustes: [{ id: 'pos_a', stop_loss: 340000, motivo: 'travar no preço de entrada' }],
    posicoes_abertas: [posAberta({ stop_loss: 330000 })],
    preco_atual: 380000,
    config: CONFIG,
  });
  assert.deepEqual(descartados, []);
  assert.equal(aplicar[0].stop_loss, breakeven);
  assert.equal(aplicar[0].elevado_breakeven, true);
  // O ponto de tudo: acionado ali, o resultado deixa de ser negativo.
  const lucro = calcularLucroLiquidoVenda({
    quantidade: 1,
    preco_venda: breakeven,
    preco_compra: 340000,
    taxa_compra_percentual: CONFIG.taxa_compra_percentual,
    taxa_venda_percentual: CONFIG.taxa_venda_percentual,
  });
  assert.ok(lucro >= 0, `no breakeven o resultado não pode ser negativo (foi ${lucro})`);
});

test('chão bem ABAIXO do preço de compra não é apertado até o breakeven', () => {
  // Stop de proteção legítimo: apertá-lo inverteria a intenção da IA.
  const { aplicar } = validarAjustesStopLoss({
    ajustes: [{ id: 'pos_a', stop_loss: 332000 }],
    posicoes_abertas: [posAberta({ stop_loss: 330000 })],
    preco_atual: 360000,
    config: CONFIG,
  });
  assert.equal(aplicar[0].stop_loss, 332000);
  assert.equal(aplicar[0].elevado_breakeven, false);
});

test('"proteger a entrada" com o preço ainda perto do breakeven é DESCARTADO', () => {
  // Era o caminho mais comum do prejuízo: a IA sobe o chão para ~o preço de
  // entrada assim que o lote fica levemente positivo. Ali o breakeven está
  // colado no preço, então qualquer chão nessa região é gatilho de ruído — e o
  // resultado observado foi lote atrás de lote morrendo no zero, pagando as
  // duas taxas. Agora o chão largo (330.000) simplesmente continua.
  const breakeven = precoMinimoVendaLucrativa(340000, CONFIG); // ~350.355
  assert.ok(breakeven > 345000, 'pré-condição do teste: preço atual abaixo do breakeven');
  const { aplicar, descartados } = validarAjustesStopLoss({
    ajustes: [{ id: 'pos_a', stop_loss: 341000 }],
    posicoes_abertas: [posAberta({ stop_loss: 330000 })],
    preco_atual: 345000,
    config: CONFIG,
  });
  assert.deepEqual(aplicar, []);
  assert.match(descartados[0].motivo, /ruído do dia/);
});

// ------------------------------- trailing AUTOMÁTICO do Motor (§10.3)
// Medido na PBR: 127 ciclos desde a compra, ~20 chamadas à IA, chão movido UMA
// vez. O trailing do Motor roda em todos os 127.

const CONFIG_TRAILING = { ...CONFIG, stop_loss_trailing_percentual: 3 };

test('trailing do Motor sobe o chão de posição EM LUCRO', () => {
  // compra 340k, breakeven ~350.355; a 400k o chão vai para 3% abaixo = 388k.
  const { aplicar } = avaliarTrailingStop({
    posicoes_abertas: [posAberta({ stop_loss: 330000 })],
    preco_atual: 400000,
    config: CONFIG_TRAILING,
  });
  assert.equal(aplicar.length, 1);
  assert.equal(aplicar[0].stop_loss, 388000);
  assert.equal(aplicar[0].stop_loss_anterior, 330000);
  assert.equal(aplicar[0].percentual, 3);
});

test('trailing NÃO age em posição fora do lucro — o chão da IA é preservado', () => {
  // Esta é a trava que impede o Motor de desfazer um chão largo escolhido pela
  // IA por volatilidade: a 345k a posição (compra 340k) ainda não cobriu as taxas.
  const { aplicar } = avaliarTrailingStop({
    posicoes_abertas: [posAberta({ stop_loss: 300000 })],
    preco_atual: 345000,
    config: CONFIG_TRAILING,
  });
  assert.deepEqual(aplicar, []);
});

test('trailing NUNCA baixa o chão', () => {
  const { aplicar } = avaliarTrailingStop({
    posicoes_abertas: [posAberta({ stop_loss: 395000 })], // já mais alto que 3% de 400k
    preco_atual: 400000,
    config: CONFIG_TRAILING,
  });
  assert.deepEqual(aplicar, []);
});

test('trailing ignora movimento irrelevante (não escreve por ruído de centavos)', () => {
  // Chão vigente 387.900 contra candidato 388.000: 0,025% do preço, abaixo do mínimo.
  const { aplicar } = avaliarTrailingStop({
    posicoes_abertas: [posAberta({ stop_loss: 387900 })],
    preco_atual: 400000,
    config: CONFIG_TRAILING,
  });
  assert.deepEqual(aplicar, []);
});

test('trailing usa o percentual declarado pela IA NA POSIÇÃO, não o da config', () => {
  const { aplicar } = avaliarTrailingStop({
    posicoes_abertas: [posAberta({ stop_loss: 330000, stop_loss_trailing_percentual: 10 })],
    posicao_ignorada: null,
    preco_atual: 400000,
    config: CONFIG_TRAILING,
  });
  assert.equal(aplicar[0].percentual, 10);
  assert.equal(aplicar[0].stop_loss, 360000);
});

test('trailing cai no padrão do Motor quando nem posição nem config definem', () => {
  const { aplicar } = avaliarTrailingStop({
    posicoes_abertas: [posAberta({ stop_loss: 330000 })],
    preco_atual: 400000,
    config: CONFIG, // sem stop_loss_trailing_percentual
  });
  assert.equal(aplicar[0].percentual, STOP_LOSS_TRAILING_PADRAO);
});

test('trailing dá o PRIMEIRO chão a posição em lucro que não tem nenhum', () => {
  // Caso das posições externas/manuais/pré-V6.6 — como a PBR.
  const { aplicar } = avaliarTrailingStop({
    posicoes_abertas: [posAberta()], // sem stop_loss
    preco_atual: 400000,
    config: CONFIG_TRAILING,
  });
  assert.equal(aplicar.length, 1);
  assert.equal(aplicar[0].stop_loss_anterior, null);
});

test('trailing NÃO sobe o chão enquanto a folga não couber acima do breakeven', () => {
  // Preço logo acima do breakeven: a folga de 3% cairia na faixa
  // [compra, breakeven), onde a venda é prejuízo garantido pelas taxas. Até a
  // V8.7 o Motor elevava o chão ao breakeven — mas ali ele fica a 0,18% do
  // preço, e o lote morria no ruído. Agora o chão largo espera.
  const breakeven = precoMinimoVendaLucrativa(340000, CONFIG_TRAILING); // ~350.355
  assert.ok(351000 * 0.97 < breakeven, 'pré-condição: a folga cairia dentro da faixa de taxa');
  const { aplicar } = avaliarTrailingStop({
    posicoes_abertas: [posAberta({ stop_loss: 330000 })],
    preco_atual: 351000,
    config: CONFIG_TRAILING,
  });
  assert.deepEqual(aplicar, []);
});

test('passado esse ponto, o trailing volta a subir o chão sozinho', () => {
  // 365.000 × 0,97 = 354.050, acima do breakeven (~350.355): agora cabe.
  const { aplicar } = avaliarTrailingStop({
    posicoes_abertas: [posAberta({ stop_loss: 330000 })],
    preco_atual: 365000,
    config: CONFIG_TRAILING,
  });
  assert.equal(aplicar.length, 1);
  assert.equal(aplicar[0].stop_loss, 354050);
});

test('o trailing do Motor é o chão mais ALTO que o sistema admite', () => {
  // Consequência central da V8.8: em posição vencedora, a IA não tem mais como
  // apertar o chão além do automático — qualquer pedido acima dele fica dentro
  // da folga e é recusado. Se ela vê a tendência virando, a resposta é VENDER.
  const automatico = avaliarTrailingStop({
    posicoes_abertas: [posAberta({ stop_loss: 330000 })],
    preco_atual: 400000,
    config: CONFIG_TRAILING,
  }).aplicar[0].stop_loss;
  const { aplicar, descartados } = validarAjustesStopLoss({
    ajustes: [{ id: 'pos_a', stop_loss: automatico + 1000 }],
    posicoes_abertas: [posAberta({ stop_loss: automatico })],
    preco_atual: 400000,
    config: CONFIG_TRAILING,
  });
  assert.deepEqual(aplicar, []);
  assert.match(descartados[0].motivo, /ruído do dia/);
});

test('trailing ignora posições em VENDA/FECHADA e sem dados', () => {
  const { aplicar } = avaliarTrailingStop({
    posicoes_abertas: [
      posAberta({ id: 'a', status: 'VENDA', stop_loss: 330000 }),
      posAberta({ id: 'b', status: 'FECHADA', stop_loss: 330000 }),
      posAberta({ id: 'c', preco_compra: null }),
    ],
    preco_atual: 400000,
    config: CONFIG_TRAILING,
  });
  assert.deepEqual(aplicar, []);
});

// -------------------------------- taxa de compra EFETIVA no breakeven

test('breakeven usa a taxa REAL paga na compra, não a estimativa da config', () => {
  // MB: config conservadora de 1,5%, mas a corretora cobrou 0,7% de fato.
  const pos = { quantidade: 1, preco_compra: 100000, taxa_compra: 700 };
  assert.equal(Math.round(taxaCompraPercentualEfetiva(pos, CONFIG) * 100) / 100, 0.7);
  const real = breakevenPosicao(pos, CONFIG);
  const pelaConfig = precoMinimoVendaLucrativa(100000, CONFIG);
  assert.ok(real < pelaConfig, 'o breakeven real tem de ser MENOR que o inflado pela config');
});

test('posição sem taxa registrada cai na estimativa da config', () => {
  const pos = { quantidade: 1, preco_compra: 100000, taxa_compra: null }; // externa
  assert.equal(taxaCompraPercentualEfetiva(pos, CONFIG), CONFIG.taxa_compra_percentual);
});

test('taxa de compra ZERO é respeitada (Tastytrade não cobra corretagem)', () => {
  const pos = { quantidade: 1, preco_compra: 100, taxa_compra: 0 };
  assert.equal(taxaCompraPercentualEfetiva(pos, CONFIG), 0);
});

test('posição sem preço de compra conhecido não sofre elevação', () => {
  const { aplicar } = validarAjustesStopLoss({
    ajustes: [{ id: 'pos_a', stop_loss: 345000 }],
    posicoes_abertas: [posAberta({ stop_loss: 330000, preco_compra: null })],
    preco_atual: 360000,
    config: CONFIG,
  });
  assert.equal(aplicar[0].stop_loss, 345000);
  assert.equal(aplicar[0].elevado_breakeven, false);
});

test('ajuste igual ou acima do preço atual é descartado', () => {
  const { aplicar, descartados } = validarAjustesStopLoss({
    ajustes: [{ id: 'pos_a', stop_loss: 360000 }],
    posicoes_abertas: [posAberta({ stop_loss: 330000 })],
    preco_atual: 360000,
    config: CONFIG,
  });
  assert.deepEqual(aplicar, []);
  assert.match(descartados[0].motivo, /abaixo do preço atual/);
});

test('ajuste para posição inexistente é descartado sem afetar os demais', () => {
  const { aplicar, descartados } = validarAjustesStopLoss({
    ajustes: [
      { id: 'fantasma', stop_loss: 339000 },
      { id: 'pos_a', stop_loss: 339000 }, // 5,8% abaixo do preço: respeita a folga
    ],
    posicoes_abertas: [posAberta({ stop_loss: 330000 })],
    preco_atual: 360000,
    config: CONFIG,
  });
  assert.equal(aplicar.length, 1);
  assert.equal(aplicar[0].id, 'pos_a');
  assert.equal(descartados.length, 1);
});

test('lista de ajustes vazia/ausente não produz nada', () => {
  assert.deepEqual(validarAjustesStopLoss({ ajustes: [], posicoes_abertas: [], preco_atual: 1, config: CONFIG }), {
    aplicar: [],
    descartados: [],
  });
});

test('venda de posição com lucro líquido positivo é aprovada e carrega o lucro previsto', () => {
  const r = avaliar(vendaBase(360000)); // bem acima da entrada + taxas
  assert.equal(r.status, 'aprovada');
  assert.equal(r.ordem.tipo, 'VENDA');
  assert.equal(r.ordem.quantidade, 0.01);
  assert.equal(r.ordem.posicoes.length, 1);
  assert.equal(r.ordem.posicoes[0].id, 'pos_a');
  assert.ok(r.ordem.lucro_liquido_previsto > 0);
});

test('venda no prejuízo (mesmo nominalmente positiva, comida pelas taxas) é rejeitada', () => {
  // 350000 > 340000 nominal, mas taxas de 1.5%+1.5% tornam o líquido negativo
  const r = avaliar(vendaBase(350000));
  assert.equal(r.status, 'rejeitada_regras');
  assert.match(r.motivo, /nunca vender no prejuízo/);
});

test('posição no prejuízo é descartada sem travar a venda das posições em lucro', () => {
  const abertas = [
    posicao({ id: 'pos_cara', preco_compra: 360000 }), // no prejuízo a 355k
    posicao({ id: 'pos_barata', preco_compra: 330000 }), // em lucro a 355k
  ];
  const r = avaliar(vendaBase(355000, abertas, ['pos_cara', 'pos_barata']));
  assert.equal(r.status, 'aprovada');
  assert.deepEqual(r.ordem.posicoes.map((p) => p.id), ['pos_barata']);
  assert.equal(r.ordem.posicoes_descartadas.length, 1);
  assert.equal(r.ordem.posicoes_descartadas[0].id, 'pos_cara');
  assert.equal(r.ordem.quantidade, 0.01);
});

test('id desconhecido, posição FECHADA ou em VENDA não são vendáveis', () => {
  const abertas = [
    posicao({ id: 'pos_fechada', status: 'FECHADA' }),
    posicao({ id: 'pos_vendendo', status: 'VENDA' }),
  ];
  const r = avaliar(vendaBase(360000, abertas, ['pos_x', 'pos_fechada', 'pos_vendendo']));
  assert.equal(r.status, 'rejeitada_saldo');
  assert.match(r.motivo, /nenhuma posição executável/);
});

test('posição sem preço de compra é descartada (impossível comprovar lucro)', () => {
  const r = avaliar(vendaBase(360000, [posicao({ preco_compra: null })]));
  assert.equal(r.status, 'rejeitada_saldo');
});

test('VENDER sem a lista de posições do contexto é erro', () => {
  const r = avaliar({ ...vendaBase(360000), posicoes_abertas: null });
  assert.equal(r.status, 'erro');
});

test('soma das posições acima do saldo do ativo é estado inconsistente (erro)', () => {
  const abertas = [posicao({ quantidade: 0.05 })]; // saldo é 0.02
  const r = avaliar(vendaBase(360000, abertas));
  assert.equal(r.status, 'erro');
});

// ------------------------------------------------- 7. estado inconsistente

test('saldos negativos, preços inválidos e dados ausentes viram erro', () => {
  assert.equal(avaliar(base({ carteira: { saldo_moeda: -1, saldo_ativo: 0 } })).status, 'erro');
  assert.equal(avaliar(base({ preco_execucao: NaN })).status, 'erro');
  assert.equal(avaliar(base({ ordens_abertas: null })).status, 'erro');
  assert.equal(avaliar(base({ config: {} })).status, 'erro');
  assert.equal(avaliar(base({ decisao: null })).status, 'erro');
});

// -------------------------------------------------- 3b. divergência dinâmica

test('limite de divergência escala com a volatilidade (fator 0,5x a 2x)', () => {
  assert.equal(limiteDivergenciaEfetivo(1, 2), 1); // volatilidade de referência
  assert.equal(limiteDivergenciaEfetivo(1, 1), 0.5); // dia parado → metade
  assert.equal(limiteDivergenciaEfetivo(1, 4), 2); // dia agitado → dobro
  assert.equal(limiteDivergenciaEfetivo(1, 20), 2); // teto do fator
  assert.equal(limiteDivergenciaEfetivo(1, 0.1), 0.5); // piso do fator
  assert.equal(limiteDivergenciaEfetivo(1, null), 1); // sem volatilidade → base
});

test('dia volátil aceita divergência que o limite base rejeitaria', () => {
  // divergência ~1.43% >= base 1%, mas volatilidade 4% dobra o limite (2%)
  const r = avaliar(base({ preco_execucao: 355000, volatilidade_24h: 4 }));
  assert.equal(r.status, 'aprovada');
});

test('dia parado rejeita divergência que o limite base aceitaria', () => {
  // divergência ~0.57% < base 1%, mas volatilidade 1% derruba o limite a 0.5%
  const r = avaliar(base({ preco_execucao: 352000, volatilidade_24h: 1 }));
  assert.equal(r.status, 'rejeitada_regras');
  assert.match(r.motivo, /limite efetivo 0\.50%/);
});

// ------------------------------------------- 4. circuit breaker de perda diária

const CONFIG_COM_LIMITE = { ...CONFIG, limite_perda_diaria_percentual: 3 };

test('queda diária acima do limite bloqueia novas compras', () => {
  const r = avaliar(
    base({
      config: CONFIG_COM_LIMITE,
      patrimonio_inicio_dia: 10000,
      patrimonio_atual: 9600, // -4% no dia
    }),
  );
  assert.equal(r.status, 'rejeitada_regras');
  assert.match(r.motivo, /circuit breaker/);
});

test('queda dentro do limite não bloqueia compras', () => {
  const r = avaliar(
    base({
      config: CONFIG_COM_LIMITE,
      patrimonio_inicio_dia: 10000,
      patrimonio_atual: 9800, // -2% no dia
    }),
  );
  assert.equal(r.status, 'aprovada');
});

test('circuit breaker não bloqueia vendas com lucro', () => {
  const r = avaliar({
    ...vendaBase(360000),
    config: CONFIG_COM_LIMITE,
    patrimonio_inicio_dia: 10000,
    patrimonio_atual: 9000, // -10% no dia, mas venda reduz exposição
  });
  assert.equal(r.status, 'aprovada');
});

test('limite 0 desativa o circuit breaker; dados ausentes pulam a regra', () => {
  const queda = { patrimonio_inicio_dia: 10000, patrimonio_atual: 9000 };
  assert.equal(
    avaliar(base({ ...queda, config: { ...CONFIG, limite_perda_diaria_percentual: 0 } })).status,
    'aprovada',
  );
  assert.equal(avaliar(base({ config: CONFIG_COM_LIMITE })).status, 'aprovada');
});

// ---------------------------------------------------------------- ordem das regras

test('ordem das regras: saldo insuficiente ganha de divergência de preço', () => {
  const r = avaliar(
    base({
      carteira: { saldo_moeda: 50, saldo_ativo: 0 },
      decisao: compra({ percentual: 1 }), // R$ 0,50 < mínimo
      preco_execucao: 400000, // divergência enorme, mas a regra 1 vem antes
    }),
  );
  assert.equal(r.status, 'rejeitada_saldo');
});
