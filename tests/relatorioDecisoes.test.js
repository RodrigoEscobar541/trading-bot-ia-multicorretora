// relatorioDecisoes.test.js — métricas das decisões (V7, análise · parte 1).
//
// As funções medidas são PURAS: recebem operações/posições prontas e devolvem
// números. Os casos abaixo são os do episódio real que motivou o módulo
// (ROADMAP V6.6.1): a IA que não vendia e os stops fechando no vermelho.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resumirOperacoes,
  consolidar,
  razaoRiscoRetorno,
  assimetriaRealizada,
  deltaDecisoes,
  mediana,
  capturaDoPico,
  formatarRelatorio,
} from '../src/nucleo/relatorioDecisoes.js';

const venda = (extra = {}) => ({
  tipo: 'VENDA', status: 'executada', horario: '2026-07-24T10:00:00Z',
  valor: 1000, taxa: 7, lucro_liquido: 10, posicoes: [], ...extra,
});
const compra = (extra = {}) => ({
  tipo: 'COMPRA', status: 'executada', horario: '2026-07-24T09:00:00Z',
  valor: 1000, taxa: 7, ...extra,
});

// -------------------------------------------------- assimetria realizada (V6.7)
// Esta métrica existe porque a melhor (R:R) não tinha amostra: em 2026-07-25,
// 0 dos 23 lotes fechados em produção carregavam `stop_loss_inicial`. Os casos
// abaixo usam os números REAIS medidos naquele dia.

test('assimetria = ganho médio ÷ perda média, e < 1 é o desenho perdedor', () => {
  // Números de produção (BRL, 2026-07-25): 15 ganhos somando 61,01 e 7 perdas
  // somando -89,08. Acerto de 68% e ainda assim dinheiro perdido — é exatamente
  // o quadro que a taxa de acerto esconde e que esta métrica revela.
  const ganhos = [11.68, 3.75, 5.53, 5.25, 4.58, 6.14, 4.6, 7.31, 0.42, 0.31, 5.57, 2.39, 3.27, 0.08, 0.13];
  const perdas = [-0.87, -54.8, -17.19, -7.35, -2.1, -5.75, -1.02];
  const a = assimetriaRealizada([...ganhos, ...perdas]);

  assert.equal(a.n, 22);
  assert.equal(a.ganhos, 15);
  assert.equal(a.perdas, 7);
  assert.ok(Math.abs(a.ganho_medio - 4.07) < 0.01, `ganho médio ${a.ganho_medio}`);
  assert.ok(Math.abs(a.perda_media - 12.73) < 0.01, `perda média ${a.perda_media}`);
  assert.ok(Math.abs(a.razao - 0.32) < 0.01, `razão ${a.razao}`);
  assert.ok(a.razao < 1, 'perde mais do que ganha');
  // Acerto alto E esperança negativa ao mesmo tempo: o achado da V6.7.
  assert.ok(a.taxa_acerto > 0.68, `acerto ${a.taxa_acerto}`);
  assert.ok(a.esperanca < 0, `esperança ${a.esperanca}`);
  // O maior ganho é uma fração da pior perda — a assimetria invertida na veia.
  assert.equal(a.maior_ganho, 11.68);
  assert.equal(a.maior_perda, 54.8);
});

test('assimetria > 1 quando os ganhos são maiores que as perdas', () => {
  const a = assimetriaRealizada([30, 20, -5, -5]);
  assert.equal(a.razao, 5);
  assert.ok(a.esperanca > 0);
});

test('sem um dos lados não existe razão — e inventá-la seria pior que omitir', () => {
  const soGanhos = assimetriaRealizada([10, 20]);
  assert.equal(soGanhos.razao, null);
  assert.equal(soGanhos.perdas, 0);
  assert.equal(soGanhos.taxa_acerto, 1);
  assert.ok(soGanhos.esperanca > 0); // o que dá para dizer, continua dito

  const soPerdas = assimetriaRealizada([-10, -20]);
  assert.equal(soPerdas.razao, null);
  assert.equal(soPerdas.ganhos, 0);
  assert.equal(soPerdas.maior_perda, 20);
});

test('assimetria ignora lucro ausente e devolve null sem amostra nenhuma', () => {
  assert.equal(assimetriaRealizada([]), null);
  assert.equal(assimetriaRealizada([null, undefined, NaN]), null);
  const a = assimetriaRealizada([10, null, -5, 'x']);
  assert.equal(a.n, 2);
});

test('a assimetria NÃO cruza moedas (ganho em USD não compensa perda em BRL)', () => {
  const brl = resumirOperacoes({
    operacoes: [venda({ lucro_liquido: -50, posicoes: ['p1'] })],
    posicoesPorId: new Map([['p1', { lucro_liquido: -50, fechada_por: 'stop_loss' }]]),
    moeda: 'BRL',
  });
  const usd = resumirOperacoes({
    operacoes: [venda({ lucro_liquido: 66.64, posicoes: ['p2'] })],
    posicoesPorId: new Map([['p2', { lucro_liquido: 66.64, fechada_por: 'lucro' }]]),
    moeda: 'USD',
  });
  const t = consolidar([brl, usd]);

  // Cada moeda tem a SUA assimetria; nenhuma razão global existe.
  assert.equal(t.por_moeda.BRL.assimetria.perdas, 1);
  assert.equal(t.por_moeda.BRL.assimetria.ganhos, 0);
  assert.equal(t.por_moeda.USD.assimetria.ganhos, 1);
  assert.equal(t.por_moeda.USD.assimetria.razao, null);
  // A matéria-prima não fica no doc: o relatório guarda a conclusão.
  assert.equal(t.por_moeda.BRL.lucros, undefined);
});

test('o relatório mostra a assimetria e avisa quando ela está invertida', () => {
  const brl = resumirOperacoes({
    operacoes: [
      venda({ lucro_liquido: 4, posicoes: ['g1'] }),
      venda({ lucro_liquido: -40, posicoes: ['p1'] }),
    ],
    posicoesPorId: new Map([
      ['g1', { lucro_liquido: 4, fechada_por: 'lucro' }],
      ['p1', { lucro_liquido: -40, fechada_por: 'stop_loss' }],
    ]),
    moeda: 'BRL',
  });
  const texto = formatarRelatorio({ ...consolidar([brl]), janela: { dias: 7, inicio: '', fim: '' } });

  assert.match(texto, /Assimetria — BRL/);
  assert.match(texto, /0\.10×/);
  assert.match(texto, /⚠️/);
  assert.match(texto, /taxa de acerto alta não salva isso/);
});

test('o relatório explica por que o R:R está sem amostra (não deixa no ar)', () => {
  // Foi o que aconteceu em produção: a métrica dizia "sem amostra" e ninguém
  // sabia se era falta de operações ou falta de CAMPO. São coisas diferentes.
  const texto = formatarRelatorio({ rr: { amostras: 0 }, janela: { dias: 7, inicio: '', fim: '' } });
  assert.match(texto, /sem amostra/);
  assert.match(texto, /V6\.6\.2/);
});

// ------------------------------------------------------------ risco:retorno

test('R:R usa o chão DECLARADO na entrada, não o que o trailing deixou', () => {
  // Entrada 100, chão inicial 90 → risco 10/unidade. O trailing subiu para 99,
  // mas o risco ACEITO na abertura foi 10 — é ele que dá sentido ao retorno.
  const rr = razaoRiscoRetorno({
    preco_compra: 100, stop_loss_inicial: 90, stop_loss: 99,
    quantidade: 2, lucro_liquido: 40,
  });
  assert.equal(rr.risco, 20);
  assert.equal(rr.razao, 2);
});

test('posição sem chão declarado fica FORA da amostra', () => {
  // Externa/manual/pré-V6.6: sem risco conhecido. Melhor não medir do que
  // inventar um denominador.
  assert.equal(razaoRiscoRetorno({ preco_compra: 100, quantidade: 1, lucro_liquido: 5 }), null);
  assert.equal(razaoRiscoRetorno({ preco_compra: 100, stop_loss_inicial: 100, quantidade: 1, lucro_liquido: 5 }), null);
});

test('R:R negativo quando o lote saiu no prejuízo', () => {
  const rr = razaoRiscoRetorno({ preco_compra: 100, stop_loss_inicial: 95, quantidade: 1, lucro_liquido: -5 });
  assert.equal(rr.razao, -1);
});

test('mediana lida com listas par e ímpar, e com vazia', () => {
  assert.equal(mediana([3, 1, 2]), 2);
  assert.equal(mediana([4, 1, 3, 2]), 2.5);
  assert.equal(mediana([]), null);
});

// --------------------------------------------------------------- resumo

test('separa venda da IA de venda por stop-loss', () => {
  const r = resumirOperacoes({
    operacoes: [
      venda({ posicoes: ['p1'] }),
      venda({ origem_decisao: 'motor_stop_loss', lucro_liquido: -20, posicoes: ['p2'] }),
      compra(),
    ],
    posicoesPorId: new Map([
      ['p1', { fechada_por: 'lucro', lucro_liquido: 10 }],
      ['p2', { fechada_por: 'stop_loss', lucro_liquido: -20 }],
    ]),
  });
  assert.equal(r.compras, 1);
  assert.equal(r.vendas, 2);
  assert.equal(r.vendas_por_stop, 1);
  assert.equal(r.fechamentos.lucro.positivas, 1);
  assert.equal(r.fechamentos.stop_loss.negativas, 1);
  assert.equal(r.lucro_realizado, -10);
});

test('conta o que NÃO virou execução (é sinal tão importante quanto o que virou)', () => {
  const r = resumirOperacoes({
    operacoes: [
      { tipo: 'COMPRA', status: 'rejeitada_saldo' },
      { tipo: 'COMPRA', status: 'rejeitada_regras' },
      { tipo: 'COMPRA', status: 'sugerida' },
      { tipo: 'VENDA', status: 'erro' },
    ],
  });
  assert.equal(r.rejeitadas, 2);
  assert.equal(r.sugeridas, 1);
  assert.equal(r.erros, 1);
  assert.equal(r.vendas, 0);
});

test('DIVIDENDO não entra no lucro de trading nem nas contagens', () => {
  const r = resumirOperacoes({
    operacoes: [{ tipo: 'DIVIDENDO', status: 'executada', valor: 12.5, taxa: 0 }],
  });
  assert.equal(r.vendas, 0);
  assert.equal(r.compras, 0);
  assert.equal(r.lucro_realizado, 0);
});

test('taxas pagas são somadas separadamente do lucro', () => {
  const r = resumirOperacoes({ operacoes: [compra({ taxa: 7 }), venda({ taxa: 7, lucro_liquido: 30 })] });
  assert.equal(r.taxas_pagas, 14);
  assert.equal(r.lucro_realizado, 30);
});

// ----------------------------------------------------------- consolidação

test('dinheiro NUNCA se soma entre moedas; contagens sim', () => {
  const total = consolidar([
    resumirOperacoes({ operacoes: [venda({ lucro_liquido: 10 })], moeda: 'BRL' }),
    resumirOperacoes({ operacoes: [venda({ lucro_liquido: 20 })], moeda: 'USD' }),
  ]);
  assert.equal(total.vendas, 2);
  assert.equal(total.por_moeda.BRL.lucro_realizado, 10);
  assert.equal(total.por_moeda.USD.lucro_realizado, 20);
  assert.equal(total.por_moeda.BRL.lucro_realizado + total.por_moeda.USD.lucro_realizado, 30);
});

test('estatísticas de R:R vêm da amostra consolidada', () => {
  const posicoes = new Map([
    ['a', { fechada_por: 'lucro', lucro_liquido: 30, preco_compra: 100, stop_loss_inicial: 90, quantidade: 1 }],
    ['b', { fechada_por: 'lucro', lucro_liquido: 5, preco_compra: 100, stop_loss_inicial: 90, quantidade: 1 }],
  ]);
  const total = consolidar([
    resumirOperacoes({ operacoes: [venda({ posicoes: ['a'] }), venda({ posicoes: ['b'] })], posicoesPorId: posicoes }),
  ]);
  assert.equal(total.rr.amostras, 2);
  assert.equal(total.rr.melhor, 3);
  assert.equal(total.rr.pior, 0.5);
  assert.equal(total.rr.media, 1.75);
});

// ------------------------------------------------------- delta de decisões

// ----------------------------------------------------- captura do pico (V8.5)
// A régua da saída PADRÃO do sistema (§10.2.1). Sem ela, o lote fechado diz
// quanto rendeu e nunca quanto CHEGOU a render — e "o trailing devolve lucro
// demais?" fica sem resposta possível, por mais lotes que se acumule.

test('captura do pico compara o avanço máximo com o avanço que a saída levou', () => {
  // Subiu 10%, saiu com 7% → o chão devolveu 30% do movimento.
  const c = capturaDoPico({ preco_compra: 100, preco_maximo: 110, preco_venda: 107 });
  assert.ok(Math.abs(c.captura - 0.7) < 1e-9);
  assert.ok(Math.abs(c.avanco_maximo - 10) < 1e-9);
});

test('lote sem pico acima da entrada não tem proporção — fica fora, não vira zero', () => {
  // Contá-lo como 0% afundaria a mediana e acusaria um trailing largo que não
  // existe: quem perdeu não devolveu lucro, simplesmente nunca teve.
  assert.equal(capturaDoPico({ preco_compra: 100, preco_maximo: 100, preco_venda: 92 }), null);
  // Lote ANTIGO (aberto antes do campo existir) também sai da amostra em vez de
  // entrar com número inventado — mesma disciplina do `stop_loss_inicial`.
  assert.equal(capturaDoPico({ preco_compra: 100, preco_venda: 107 }), null);
  assert.equal(capturaDoPico({ preco_compra: 100, preco_maximo: 110 }), null); // ainda aberta
});

test('a captura é MEDIANA e consolidada entre moedas (é proporção, não dinheiro)', () => {
  const pos = (id, maximo, venda) => [id, {
    preco_compra: 100, preco_maximo: maximo, preco_venda: venda, lucro_liquido: 1, fechada_por: 'stop_loss',
  }];
  const brl = resumirOperacoes({
    operacoes: [venda({ posicoes: ['a'] }), venda({ posicoes: ['b'] })],
    posicoesPorId: new Map([pos('a', 110, 107), pos('b', 120, 104)]), // 0,70 e 0,20
    moeda: 'BRL',
  });
  const usd = resumirOperacoes({
    operacoes: [venda({ posicoes: ['c'] })],
    posicoesPorId: new Map([pos('c', 110, 109)]), // 0,90
    moeda: 'USD',
  });

  const t = consolidar([brl, usd]);
  assert.equal(t.captura.amostras, 3, 'proporção não sofre do problema de somar moedas');
  assert.ok(Math.abs(t.captura.mediana - 0.7) < 1e-9, `mediana=${t.captura.mediana}`);
  // Média puxada pelo lote que devolveu quase tudo — é por isso que o número
  // publicado é a mediana, que descreve o lote típico.
  assert.ok(t.captura.avanco_maximo_medio > 10);
});

test('o relatório mostra a captura, e some quando não há amostra', () => {
  const com = formatarRelatorio({
    captura: { amostras: 2, mediana: 0.7, avanco_maximo_medio: 10, avanco_capturado_medio: 7 },
    janela: { dias: 7, inicio: '', fim: '' },
  });
  assert.match(com, /Captura do pico/);
  assert.match(com, /70\.0%/);

  // Relatório antigo (doc gravado antes deste campo) não pode quebrar a
  // formatação nem inventar uma seção vazia.
  const sem = formatarRelatorio({ janela: { dias: 7, inicio: '', fim: '' } });
  assert.ok(!sem.includes('Captura do pico'));
});

test('delta das decisões entre dois retratos', () => {
  const d = deltaDecisoes({ COMPRAR: 12, VENDER: 3, AGUARDAR: 550 }, { COMPRAR: 10, VENDER: 3, AGUARDAR: 400 });
  assert.deepEqual(d, { COMPRAR: 2, VENDER: 0, AGUARDAR: 150, total: 152 });
});

test('contador que andou para TRÁS vale como começo novo, nunca delta negativo', () => {
  // Ativo recriado / estado apagado: o retrato anterior é maior que o atual.
  const d = deltaDecisoes({ COMPRAR: 1, AGUARDAR: 5 }, { COMPRAR: 90, AGUARDAR: 900 });
  assert.equal(d.COMPRAR, 1);
  assert.equal(d.AGUARDAR, 5);
});

test('sem retrato anterior, o delta é o próprio acumulado', () => {
  assert.equal(deltaDecisoes({ AGUARDAR: 7 }, {}).total, 7);
});

// ---------------------------------------------------------- formatação

test('o relatório mostra o que motivou o módulo: quantas vezes a IA agiu', () => {
  const texto = formatarRelatorio({
    janela: { inicio: '2026-07-18T00:00:00Z', fim: '2026-07-25T00:00:00Z', dias: 7 },
    decisoes: { COMPRAR: 12, VENDER: 3, AGUARDAR: 550, total: 565 },
    fechamentos: { stop_loss: { n: 7, positivas: 0, negativas: 7 } },
    por_moeda: { BRL: { lucro_realizado: -89.08, taxas_pagas: 12.3 } },
    rr: { amostras: 2, media: 1.75, mediana: 1.75, melhor: 3, pior: 0.5 },
    vendas: 7, compras: 12, sugeridas: 0, rejeitadas: 0, erros: 0,
  });
  assert.match(texto, /comprar 12 · vender 3 · aguardar 550/);
  assert.match(texto, /agiu em 2\.7% das análises/);
  assert.match(texto, /stop-loss \(Motor\): 7 — 0 no lucro, 7 no prejuízo/);
  assert.match(texto, /-89\.08 BRL/);
  assert.match(texto, /mediana 1\.75×/);
});

test('sem amostra de R:R o relatório diz isso, em vez de mostrar zero', () => {
  const texto = formatarRelatorio({
    janela: { inicio: '2026-07-18', fim: '2026-07-25', dias: 7 },
    decisoes: { COMPRAR: 0, VENDER: 0, AGUARDAR: 10, total: 10 },
    fechamentos: {}, por_moeda: {}, rr: { amostras: 0 },
  });
  assert.match(texto, /sem amostra/);
  assert.match(texto, /nenhuma no período/);
  assert.doesNotMatch(texto, /0\.00×/);
});
