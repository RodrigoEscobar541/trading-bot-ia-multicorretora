// travaLucro.test.js — a TRAVA DE LUCRO (V8.11, CLAUDE.md §10.8).
//
// POR QUE ELA EXISTE, em números de produção (2026-08-05, 23 lotes fechados
// desde o reset): topo mediano do lote +1,09%, maior topo de todos +3,07%. Com
// a folga em 5%, o chão do trailing só passa a travar lucro acima de +5,3% (TT)
// — patamar que NENHUM lote alcançou. A trava de lucro do sistema não estava
// apertada demais: era inalcançável, e todo lote vencedor devolvia o movimento
// inteiro até morrer no stop (17 stops, −36,54 × 6 vendas no lucro, +11,23).
//
// A CAUSA era um número fazendo dois trabalhos opostos: o chão que protege do
// prejuízo precisa ser LARGO (aguentar o ruído do dia); o que realiza lucro
// precisa ser ESTREITO (menor que o movimento típico). A V8.8 fundiu os dois.
//
// O CONTRATO que este arquivo guarda — nenhum destes pode ser afrouxado:
//   1. a trava NUNCA fica abaixo do breakeven do lote;
//   2. ela só arma depois de o PICO passar do gatilho;
//   3. ela só sobe;
//   4. lote sem lucro na hora da venda NÃO é vendido por ela (é assunto do stop);
//   5. a venda passa pelo `avaliar()` de sempre — nenhuma via de venda nova foi
//      criada, então a regra imutável 4 continua valendo por construção.
//
// Rodar com: npm test

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  avaliarTravaLucro,
  posicoesComTravaFurada,
  travaLucroConfig,
  breakevenPosicao,
  TRAVA_LUCRO_GATILHO_PADRAO,
  TRAVA_LUCRO_DEVOLUCAO_PADRAO,
} from '../src/regras/regrasEngine.js';
import { invalidarCatalogo } from '../src/nucleo/catalogo.js';
import { limparEstadoAtivosEmMemoria } from '../src/nucleo/orquestrador.js';
import { migrarV1paraV2 } from '../src/migracao/migrarV1paraV2.js';
import {
  inicializarPersistencia,
  obterAtivo,
  obterPosicoesAtivoPorModo,
  obterOperacoesDesdeAtivo,
} from '../src/firebase/firebaseClient.js';

// Taxas do MB (0,7% por perna) — o breakeven de um lote comprado a 100 fica em
// ~101,41. É o número que separa "trava" de "prejuízo" em quase todo teste aqui.
const CONFIG = {
  taxa_compra_percentual: 0.7,
  taxa_venda_percentual: 0.7,
  minimo_ordem_quantidade: 0.00001,
  trava_lucro_gatilho_percentual: 1.0,
  trava_lucro_devolucao_percentual: 0.8,
};

const lote = (extra = {}) => ({
  id: 'pos_1',
  status: 'MONITORANDO',
  quantidade: 1,
  preco_compra: 100,
  preco_maximo: 100,
  trava_lucro: null,
  ...extra,
});

// ------------------------------------------------------ avaliarTravaLucro

test('não arma enquanto o pico não passa do gatilho acima do breakeven', () => {
  // breakeven ≈ 101,41; gatilho de 1% ⇒ só arma a partir de ~102,42.
  const { aplicar } = avaliarTravaLucro({
    posicoes_abertas: [lote({ preco_maximo: 102 })],
    preco_atual: 102,
    config: CONFIG,
  });
  assert.equal(aplicar.length, 0);
});

test('arma quando o pico passa do gatilho, a devolução abaixo do pico', () => {
  const { aplicar } = avaliarTravaLucro({
    posicoes_abertas: [lote({ preco_maximo: 110 })],
    preco_atual: 110,
    config: CONFIG,
  });
  assert.equal(aplicar.length, 1);
  assert.equal(aplicar[0].trava_lucro, 109.12); // 110 × (1 − 0,8%)
  assert.equal(aplicar[0].trava_lucro_anterior, null);
});

test('A TRAVA NUNCA FICA ABAIXO DO BREAKEVEN — é o que a impede de dar prejuízo', () => {
  // Devolução absurda (20%): 103 × 0,8 = 82,4, bem abaixo da compra. O piso do
  // breakeven é que segura. Sem ele a trava viraria um segundo stop-loss, e um
  // stop-loss estreito é exatamente o defeito que a V8.8 corrigiu.
  const config = { ...CONFIG, trava_lucro_devolucao_percentual: 20 };
  const p = lote({ preco_maximo: 103 });
  const { aplicar } = avaliarTravaLucro({ posicoes_abertas: [p], preco_atual: 103, config });
  assert.equal(aplicar.length, 1);
  const breakeven = breakevenPosicao(p, config);
  assert.ok(aplicar[0].trava_lucro >= Math.round(breakeven * 100) / 100 - 0.01);
  assert.ok(aplicar[0].trava_lucro > p.preco_compra, 'nunca abaixo do preço de compra');
});

test('a trava SÓ SOBE: pico mais alto eleva, pico mais baixo não rebaixa', () => {
  const sobe = avaliarTravaLucro({
    posicoes_abertas: [lote({ preco_maximo: 120, trava_lucro: 109.12 })],
    preco_atual: 120,
    config: CONFIG,
  });
  assert.equal(sobe.aplicar[0].trava_lucro, 119.04);

  // Preço caiu, mas o PICO é a régua e ele não desce. Com a trava já em 119,04,
  // nada a fazer — e nunca um valor menor.
  const desce = avaliarTravaLucro({
    posicoes_abertas: [lote({ preco_maximo: 120, trava_lucro: 119.04 })],
    preco_atual: 112,
    config: CONFIG,
  });
  assert.equal(desce.aplicar.length, 0);
});

test('movimento abaixo do limiar de ruído não vira escrita no banco', () => {
  // Sem isto seria uma escrita por posição por tick — 1.440 por dia por lote.
  const { aplicar } = avaliarTravaLucro({
    posicoes_abertas: [lote({ preco_maximo: 110.02, trava_lucro: 109.12 })],
    preco_atual: 110.02,
    config: CONFIG,
  });
  assert.equal(aplicar.length, 0);
});

test('gatilho 0 ou devolução 0 DESLIGA a trava naquele ativo', () => {
  for (const off of [
    { trava_lucro_gatilho_percentual: 0 },
    { trava_lucro_devolucao_percentual: 0 },
  ]) {
    const config = { ...CONFIG, ...off };
    assert.equal(travaLucroConfig(config).ligada, false);
    const { aplicar } = avaliarTravaLucro({
      posicoes_abertas: [lote({ preco_maximo: 130 })],
      preco_atual: 130,
      config,
    });
    assert.equal(aplicar.length, 0, `deveria estar desligada com ${JSON.stringify(off)}`);
    assert.equal(
      posicoesComTravaFurada({
        posicoes_abertas: [lote({ preco_maximo: 130, trava_lucro: 129 })],
        preco_atual: 120,
        config,
      }).length,
      0,
    );
  }
});

test('config ausente cai nos padrões do Motor', () => {
  const { gatilho, devolucao, ligada } = travaLucroConfig({});
  assert.equal(gatilho, TRAVA_LUCRO_GATILHO_PADRAO);
  assert.equal(devolucao, TRAVA_LUCRO_DEVOLUCAO_PADRAO);
  assert.equal(ligada, true);
});

test('lote sem preco_maximo (anterior à V8.5) usa o preço de agora e não fica de fora', () => {
  const p = lote({ preco_maximo: null });
  const { aplicar } = avaliarTravaLucro({ posicoes_abertas: [p], preco_atual: 110, config: CONFIG });
  assert.equal(aplicar.length, 1);
  assert.equal(aplicar[0].trava_lucro, 109.12);
});

// --------------------------------------------------- posicoesComTravaFurada

test('trava furada com lucro entra na lista de venda', () => {
  const furadas = posicoesComTravaFurada({
    posicoes_abertas: [lote({ preco_maximo: 110, trava_lucro: 109.12 })],
    preco_atual: 109,
    config: CONFIG,
  });
  assert.equal(furadas.length, 1);
  assert.ok(furadas[0].lucro_liquido_previsto > 0, 'a trava só vende no lucro');
});

test('O CASO DA PBR: trava armada, preço desabou para o vermelho — NÃO vende', () => {
  // Foi o lote que motivou tudo isto: comprado a 18,64, topo em 19,45 (+4,35%),
  // e o preço voltou a 18,60. A trava está armada lá em cima e o preço a furou
  // com folga — mas vender agora seria prejuízo, e a trava não faz isso. Daqui
  // para baixo quem cuida é o stop-loss largo, como sempre foi.
  const config = { ...CONFIG, taxa_compra_percentual: 0, taxa_venda_percentual: 0.02 };
  const furadas = posicoesComTravaFurada({
    posicoes_abertas: [lote({ preco_compra: 18.64, preco_maximo: 19.45, trava_lucro: 19.29, quantidade: 1.29 })],
    preco_atual: 18.6,
    config,
  });
  assert.equal(furadas.length, 0);
});

test('trava intacta (preço acima dela) não vende nada', () => {
  const furadas = posicoesComTravaFurada({
    posicoes_abertas: [lote({ preco_maximo: 110, trava_lucro: 109.12 })],
    preco_atual: 109.5,
    config: CONFIG,
  });
  assert.equal(furadas.length, 0);
});

test('lote sem trava armada é ignorado', () => {
  const furadas = posicoesComTravaFurada({
    posicoes_abertas: [lote({ trava_lucro: null })],
    preco_atual: 50,
    config: CONFIG,
  });
  assert.equal(furadas.length, 0);
});

test('lote em VENDA ou FECHADA nunca entra — nem para armar, nem para vender', () => {
  for (const status of ['VENDA', 'FECHADA']) {
    assert.equal(
      avaliarTravaLucro({
        posicoes_abertas: [lote({ status, preco_maximo: 130 })],
        preco_atual: 130,
        config: CONFIG,
      }).aplicar.length,
      0,
    );
    assert.equal(
      posicoesComTravaFurada({
        posicoes_abertas: [lote({ status, preco_maximo: 130, trava_lucro: 129 })],
        preco_atual: 120,
        config: CONFIG,
      }).length,
      0,
    );
  }
});

// ------------------------------------------------------------ ciclo REAL

function conectorFalso({ preco = 100000, saldoMoeda = 1000 } = {}) {
  const candles = Array.from({ length: 100 }, (_, i) => ({
    abertura: preco, maxima: preco * 1.01, minima: preco * 0.99, fechamento: preco,
    volume: 10, horario: new Date(Date.now() - (100 - i) * 9e5).toISOString(),
  }));
  return {
    id: 'falso',
    precoAtual: async (par) => ({ simbolo: par, ultimo: preco, maxima: preco * 1.01, minima: preco * 0.99 }),
    precos: async (pares) => Object.fromEntries(pares.map((p) => [p, { ultimo: preco }])),
    candles: async () => candles,
    saldos: async () => ({ moeda: 'BRL', saldo_moeda: saldoMoeda, saldos: {} }),
    ordensAbertas: async () => [],
    ordemMercado: async () => {
      throw new Error('não deveria criar ordem real em teste');
    },
    aguardarFill: async () => {
      throw new Error('não deveria aguardar fill em teste');
    },
  };
}

beforeEach(async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  invalidarCatalogo();
  limparEstadoAtivosEmMemoria();
  await migrarV1paraV2();
});

async function comprar({ preco, stopLoss, folga = null }) {
  const { executarCicloAtivo } = await import('../src/nucleo/cicloAtivo.js');
  const plataforma = { id: 'MB', modelos_ia: ['falso'], timezone: 'America/Sao_Paulo' };
  const ativo = await obterAtivo('MB', 'BTC');
  if (folga !== null) ativo.config.stop_loss_trailing_percentual = folga;
  const r = await executarCicloAtivo({
    plataforma,
    api: { api_key_ia: 'chave-falsa' },
    ativo,
    ativosDaPlataforma: [ativo],
    conector: conectorFalso({ preco, saldoMoeda: 1000 }),
    decidirFn: async () => ({
      acao: 'COMPRAR', percentual: 20, stop_loss: stopLoss,
      stop_loss_motivo: 'abaixo do fundo', confianca: 80, justificativa: 'T.', valida: true,
    }),
  });
  assert.equal(r.operacao.status, 'executada');
  return { plataforma, ativo, estado: r.estado };
}

const rodar = ({ plataforma, ativo, estado, preco }) =>
  import('../src/nucleo/cicloAtivo.js').then(({ executarCicloAtivo }) =>
    executarCicloAtivo({
      plataforma,
      api: { api_key_ia: 'chave-falsa' },
      ativo,
      ativosDaPlataforma: [ativo],
      conector: conectorFalso({ preco, saldoMoeda: 800 }),
      estado,
      decidirFn: async () => ({ acao: 'AGUARDAR', percentual: 0, justificativa: 'T.', valida: true }),
    }),
  );

test('CICLO REAL: o lote sobe, devolve o pico e é VENDIDO NO LUCRO pela trava', async () => {
  const ctx = await comprar({ preco: 100000, stopLoss: 95000 });

  // Sobe 6%: a trava arma em 0,8% abaixo do pico.
  const r1 = await rodar({ ...ctx, preco: 106000 });
  let [posicao] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  assert.equal(posicao.trava_lucro, 105152); // 106.000 × (1 − 0,8%)
  assert.ok(posicao.trava_lucro_em, 'a trava carimba quando foi armada');

  // Devolve o pico: a trava é furada e o Motor realiza — sem chamar a IA.
  let chamouIA = false;
  const r2 = await import('../src/nucleo/cicloAtivo.js').then(({ executarCicloAtivo }) =>
    executarCicloAtivo({
      plataforma: ctx.plataforma,
      api: { api_key_ia: 'chave-falsa' },
      ativo: ctx.ativo,
      ativosDaPlataforma: [ctx.ativo],
      conector: conectorFalso({ preco: 105000, saldoMoeda: 800 }),
      estado: r1.estado,
      decidirFn: async () => {
        chamouIA = true;
        return { acao: 'AGUARDAR', percentual: 0, justificativa: 'T.', valida: true };
      },
    }),
  );

  assert.equal(chamouIA, false, 'a trava é do Motor: a IA não é consultada');
  assert.equal(r2.tipo, 'trava_lucro');
  assert.equal(r2.operacao.status, 'executada');
  assert.equal(r2.operacao.origem_decisao, 'motor_trava_lucro');
  assert.ok(r2.operacao.lucro_liquido > 0, 'a trava só realiza lucro');

  [posicao] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  assert.equal(posicao.status, 'FECHADA');
  assert.equal(posicao.fechada_por, 'lucro');
});

test('CICLO REAL: a trava NÃO vende quando o preço já voltou ao vermelho', async () => {
  // O mesmo desenho do lote da PBR, agora de ponta a ponta: sobe o suficiente
  // para armar a trava (pico +3%, breakeven em +1,41%) e depois volta para
  // baixo do breakeven. A trava fica de pé, mas nenhuma venda sai — o lote
  // continua sob o stop-loss largo, que é quem cuida de prejuízo.
  const ctx = await comprar({ preco: 100000, stopLoss: 95000 });
  const r1 = await rodar({ ...ctx, preco: 103000 });
  const [armada] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  assert.ok(armada.trava_lucro > 0, 'a trava precisa estar armada para o teste valer');

  const r2 = await rodar({ ...ctx, estado: r1.estado, preco: 101000 });
  assert.notEqual(r2.tipo, 'trava_lucro');

  const [posicao] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  assert.notEqual(posicao.status, 'FECHADA');
  const vendas = (await obterOperacoesDesdeAtivo('MB', 'BTC', '2000-01-01T00:00:00Z')).filter(
    (o) => o.tipo === 'VENDA',
  );
  assert.equal(vendas.length, 0, 'nenhuma venda no vermelho pode sair da trava');
});

test('CICLO REAL: o stop-loss tem precedência sobre a trava', async () => {
  // Se o preço furou os dois de uma vez, quem manda é o chão de proteção: ele é
  // o único que pode vender no prejuízo, e recusar a venda ali deixaria o lote
  // à deriva.
  const ctx = await comprar({ preco: 100000, stopLoss: 95000 });
  const r1 = await rodar({ ...ctx, preco: 106000 });

  const r2 = await rodar({ ...ctx, estado: r1.estado, preco: 90000 });
  assert.equal(r2.tipo, 'stop_loss');
  assert.equal(r2.operacao.origem_decisao, 'motor_stop_loss');

  const [posicao] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  assert.equal(posicao.fechada_por, 'stop_loss');
});

test('REGRESSÃO V8.11: com a folga de 5% o chão nem chegava à compra; a trava realiza mesmo assim', async () => {
  // A situação exata do lote que motivou a versão, com a folga que estava em
  // produção (5%): o preço sobe 4% e volta. Perfil de TODOS os 23 lotes
  // fechados até 2026-08-05 (topo mediano +1,09%, maior +3,07%) — nenhum
  // chegava perto dos +6,7% que a folga de 5% exigia no MB para travar o
  // primeiro centavo de lucro.
  //
  // Este teste roda com a folga ANTIGA de propósito: prova que a trava conserta
  // o problema por conta própria, sem depender de ninguém ter calibrado a folga
  // direito. Se um dia a folga voltar a 5%, o lucro continua sendo realizado.
  const ctx = await comprar({ preco: 100000, stopLoss: 95000, folga: 5 });
  const r1 = await rodar({ ...ctx, preco: 104000 }); // +4%

  const [aberta] = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  // O chão do trailing continua ABAIXO da compra — é o defeito, e ele segue lá.
  assert.ok(aberta.stop_loss < aberta.preco_compra, 'a folga de 5% não trava nada num movimento de 4%');
  // A trava, essa, já está acima do breakeven.
  assert.ok(aberta.trava_lucro > breakevenPosicao(aberta, { taxa_compra_percentual: 0.7, taxa_venda_percentual: 0.7 }));

  const r2 = await rodar({ ...ctx, estado: r1.estado, preco: 103100 }); // devolveu 0,86%
  assert.equal(r2.tipo, 'trava_lucro');
  assert.ok(r2.operacao.lucro_liquido > 0);
});
