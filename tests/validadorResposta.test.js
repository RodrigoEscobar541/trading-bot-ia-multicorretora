// validadorResposta.test.js — a resposta da IA malformada NUNCA pode virar ordem.
// Cobre o contrato da seção 6.2 do CLAUDE.md. Rodar com: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validarResposta } from '../src/ia/validadorResposta.js';

test('resposta válida de COMPRAR é aceita e normalizada', () => {
  const r = validarResposta(
    '{"acao":"COMPRAR","percentual":35,"stop_loss":332500,"stop_loss_motivo":"abaixo da MM50",' +
      '"confianca":87,"justificativa":"RSI baixo com MACD virando."}',
  );
  assert.equal(r.valida, true);
  assert.deepEqual(r.decisao, {
    acao: 'COMPRAR',
    percentual: 35,
    posicoes: null,
    stop_loss: 332500,
    stop_loss_motivo: 'abaixo da MM50',
    trailing_percentual: null, // opcional: sem ele vale o padrão do ativo
    ajustes_stop_loss: [],
    confianca: 87,
    justificativa: 'RSI baixo com MACD virando.',
    validade_contexto_dias: null,
  });
});

test('trailing_percentual (opcional em COMPRAR) é aceito; inválido vira null sem invalidar', () => {
  const comValor = validarResposta({
    acao: 'COMPRAR', percentual: 20, stop_loss: 100, stop_loss_motivo: 'x',
    justificativa: 'y', trailing_percentual: 4.5,
  });
  assert.equal(comValor.decisao.trailing_percentual, 4.5);

  // É calibragem, não decisão: valor ruim cai no padrão do ativo, nunca invalida.
  for (const v of [0, -3, 80, 'abc', null]) {
    const r = validarResposta({
      acao: 'COMPRAR', percentual: 20, stop_loss: 100, stop_loss_motivo: 'x',
      justificativa: 'y', trailing_percentual: v,
    });
    assert.equal(r.valida, true, `trailing_percentual ${v} não pode invalidar`);
    assert.equal(r.decisao.trailing_percentual, null);
  }
});

test('validade_contexto_dias (V6.2): inteiro > 0 é aceito; inválido vira null sem invalidar', () => {
  assert.equal(
    validarResposta({ acao: 'AGUARDAR', justificativa: 'x', validade_contexto_dias: 30.7 }).decisao
      .validade_contexto_dias,
    31,
  );
  const invalidos = [0, -5, 'abc', null];
  for (const v of invalidos) {
    const r = validarResposta({ acao: 'AGUARDAR', justificativa: 'x', validade_contexto_dias: v });
    assert.equal(r.valida, true, `deveria seguir válida com validade ${JSON.stringify(v)}`);
    assert.equal(r.decisao.validade_contexto_dias, null);
  }
});

test('aceita objeto já parseado e cercas de markdown', () => {
  assert.equal(
    validarResposta({ acao: 'VENDER', posicoes: ['pos_1'], justificativa: 'Lucro no alvo.' }).valida,
    true,
  );
  const cercado = '```json\n{"acao":"AGUARDAR","percentual":0,"justificativa":"Sem sinal."}\n```';
  assert.equal(validarResposta(cercado).valida, true);
});

test('normaliza caixa da acao e arredonda percentual', () => {
  const r = validarResposta({
    acao: ' comprar ',
    percentual: 35.6,
    stop_loss: 90,
    stop_loss_motivo: 'suporte',
    justificativa: 'ok',
  });
  assert.equal(r.valida, true);
  assert.equal(r.decisao.acao, 'COMPRAR');
  assert.equal(r.decisao.percentual, 36);
});

test('AGUARDAR força percentual 0 mesmo se a IA mandar outro valor', () => {
  const r = validarResposta({ acao: 'AGUARDAR', percentual: 50, justificativa: 'Indefinido.' });
  assert.equal(r.valida, true);
  assert.equal(r.decisao.percentual, 0);
});

test('acao desconhecida é inválida', () => {
  assert.equal(validarResposta({ acao: 'HOLD', percentual: 10, justificativa: 'x' }).valida, false);
  assert.equal(validarResposta({ percentual: 10, justificativa: 'x' }).valida, false);
});

test('percentual ausente ou fora de 1..100 em COMPRAR é inválido', () => {
  assert.equal(validarResposta({ acao: 'COMPRAR', justificativa: 'x' }).valida, false);
  assert.equal(validarResposta({ acao: 'COMPRAR', percentual: 0, justificativa: 'x' }).valida, false);
  assert.equal(validarResposta({ acao: 'COMPRAR', percentual: 101, justificativa: 'x' }).valida, false);
});

test('VENDER exige lista de posições não vazia', () => {
  assert.equal(validarResposta({ acao: 'VENDER', justificativa: 'x' }).valida, false);
  assert.equal(validarResposta({ acao: 'VENDER', posicoes: [], justificativa: 'x' }).valida, false);
  assert.equal(validarResposta({ acao: 'VENDER', posicoes: 'pos_1', justificativa: 'x' }).valida, false);
  assert.equal(validarResposta({ acao: 'VENDER', posicoes: [42, ' '], justificativa: 'x' }).valida, false);
});

test('VENDER normaliza posições (apara espaços, remove duplicatas) e força percentual 0', () => {
  const r = validarResposta({
    acao: 'VENDER',
    percentual: 50,
    posicoes: [' pos_a ', 'pos_b', 'pos_a'],
    justificativa: 'Realização.',
  });
  assert.equal(r.valida, true);
  assert.deepEqual(r.decisao.posicoes, ['pos_a', 'pos_b']);
  assert.equal(r.decisao.percentual, 0);
});

test('justificativa ausente/vazia é inválida', () => {
  assert.equal(validarResposta({ acao: 'AGUARDAR' }).valida, false);
  assert.equal(validarResposta({ acao: 'COMPRAR', percentual: 10, justificativa: '  ' }).valida, false);
});

test('confianca inválida vira null sem invalidar a resposta', () => {
  const r = validarResposta({
    acao: 'COMPRAR',
    percentual: 10,
    stop_loss: 90,
    stop_loss_motivo: 'suporte',
    confianca: 150,
    justificativa: 'ok',
  });
  assert.equal(r.valida, true);
  assert.equal(r.decisao.confianca, null);
});

// -------------------------------------------------------- stop-loss (V6.6)

test('COMPRAR sem stop_loss (ou com valor não positivo) é INVÁLIDA', () => {
  const semStop = validarResposta({ acao: 'COMPRAR', percentual: 10, justificativa: 'ok' });
  assert.equal(semStop.valida, false);
  assert.match(semStop.motivo, /stop_loss/);

  for (const v of [0, -100, 'abc', null]) {
    const r = validarResposta({ acao: 'COMPRAR', percentual: 10, stop_loss: v, stop_loss_motivo: 'x', justificativa: 'ok' });
    assert.equal(r.valida, false, `stop_loss ${JSON.stringify(v)} deveria invalidar`);
  }
});

test('COMPRAR sem stop_loss_motivo é INVÁLIDA (o porquê do chão é obrigatório)', () => {
  const r = validarResposta({ acao: 'COMPRAR', percentual: 10, stop_loss: 90, justificativa: 'ok' });
  assert.equal(r.valida, false);
  assert.match(r.motivo, /stop_loss_motivo/);
});

test('VENDER e AGUARDAR não exigem stop_loss', () => {
  assert.equal(validarResposta({ acao: 'AGUARDAR', justificativa: 'ok' }).valida, true);
  assert.equal(validarResposta({ acao: 'VENDER', posicoes: ['pos_1'], justificativa: 'ok' }).valida, true);
});

test('ajustes_stop_loss: entradas malformadas são descartadas sem invalidar a resposta', () => {
  const r = validarResposta({
    acao: 'AGUARDAR',
    justificativa: 'ok',
    ajustes_stop_loss: [
      { id: ' pos_a ', stop_loss: 100, motivo: ' subiu ' }, // válida (aparada)
      { id: 'pos_b', stop_loss: 'abc' }, // valor inválido
      { id: '', stop_loss: 50 }, // id vazio
      { stop_loss: 50 }, // sem id
      'lixo',
    ],
  });
  assert.equal(r.valida, true);
  assert.deepEqual(r.decisao.ajustes_stop_loss, [{ id: 'pos_a', stop_loss: 100, motivo: 'subiu' }]);
});

test('ajustes_stop_loss ausente ou não-array vira lista vazia', () => {
  assert.deepEqual(validarResposta({ acao: 'AGUARDAR', justificativa: 'ok' }).decisao.ajustes_stop_loss, []);
  assert.deepEqual(
    validarResposta({ acao: 'AGUARDAR', justificativa: 'ok', ajustes_stop_loss: 'x' }).decisao.ajustes_stop_loss,
    [],
  );
});

test('não-JSON, arrays e null são inválidos', () => {
  assert.equal(validarResposta('compre agora!').valida, false);
  assert.equal(validarResposta('[1,2]').valida, false);
  assert.equal(validarResposta(null).valida, false);
});
