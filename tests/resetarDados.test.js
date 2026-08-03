// resetarDados.test.js — as partes PURAS do script de reset (scripts/resetar-dados.mjs).
//
// O que estes testes guardam: um reset errado apaga o que não devia e o backup
// só descobre isso depois. Os casos abaixo são as formas conhecidas de errar —
// levar a Toro junto sem pedir, apagar a carteira real do dono, semear caixa
// numa plataforma que não existe. Rodar com: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planoDeReset,
  parsearCaixa,
  decidirSeSegue,
  CAMPOS_ESTADO_PLATAFORMA,
  SUBCOLECOES_DO_ATIVO,
} from '../scripts/resetar-dados.mjs';

const PARQUE = [
  { id: 'MB', assistida: false, ativos: ['BTC', 'ETH'] },
  { id: 'BN', assistida: false, ativos: ['BTC'] },
  { id: 'TORO', assistida: true, ativos: ['MXRF11', 'WRLD11'] },
];

test('a plataforma ASSISTIDA fica de fora por padrão', () => {
  // As posições da Toro espelham papéis que o dono tem de verdade na corretora.
  // Apagá-las sem ele ter vendido desencontra o sistema da realidade.
  const p = planoDeReset({ plataformas: PARQUE });
  assert.deepEqual(p.plataformas.map((x) => x.id), ['MB', 'BN']);
  assert.deepEqual(p.ignoradas, ['TORO']);
});

test('--incluir-toro traz a assistida, mas a carteira REAL continua preservada', () => {
  const p = planoDeReset({ plataformas: PARQUE, incluirToro: true });
  const toro = p.plataformas.find((x) => x.id === 'TORO');
  assert.ok(toro, 'a Toro entrou no plano');
  assert.equal(toro.preservaCarteiraManual, true);
  // O que se limpa da plataforma nunca inclui a carteira do dono nem a conexão.
  assert.ok(!CAMPOS_ESTADO_PLATAFORMA.includes('carteira_manual'));
  assert.ok(!CAMPOS_ESTADO_PLATAFORMA.includes('conexao'));
});

test('o caixa é semeado só onde foi pedido; o resto fica vazio', () => {
  const p = planoDeReset({ plataformas: PARQUE, caixa: { MB: 1500 } });
  assert.equal(p.plataformas.find((x) => x.id === 'MB').caixa, 1500);
  assert.equal(p.plataformas.find((x) => x.id === 'BN').caixa, null);
});

test('caixa para plataforma inexistente é apontado, nunca ignorado', () => {
  // Digitar "TT=500" quando a TT não está no parque é engano — e engano em
  // reset custa caro. O script para em vez de seguir achando que fez.
  const p = planoDeReset({ plataformas: PARQUE, caixa: { MB: 1000, TT: 500 } });
  assert.deepEqual(p.caixaSemPlataforma, ['TT']);
});

test('caixa pedido para a Toro sem --incluir-toro também é apontado', () => {
  const p = planoDeReset({ plataformas: PARQUE, caixa: { TORO: 100 } });
  assert.deepEqual(p.caixaSemPlataforma, ['TORO']);
});

test('os prompts são preservados por padrão — o reset é de DADOS', () => {
  const p = planoDeReset({ plataformas: PARQUE });
  assert.ok(p.globais.includes('renda_real'));
  assert.ok(p.globais.includes('relatorio_decisoes'));
  assert.ok(!p.globais.includes('supervisao'), 'a camada de prompt não some sem pedir');

  const comPrompts = planoDeReset({ plataformas: PARQUE, manterPrompts: false });
  assert.ok(comPrompts.globais.includes('supervisao'));
});

test('o histórico de operação inteiro entra na limpeza', () => {
  // Se uma subcoleção ficar de fora, o reset é parcial e a medição nova nasce
  // contaminada — que é exatamente o que ele existe para evitar.
  for (const sub of ['historico', 'operacoes', 'posicoes', 'operacoes_manuais']) {
    assert.ok(SUBCOLECOES_DO_ATIVO.includes(sub), `${sub} precisa ser apagada`);
  }
});

test('o reset SEMPRE desliga o modo vendas', () => {
  // `global/controle` não é apagado pelo reset, então o flag da liquidação
  // sobreviveria à limpeza. O bot voltaria liquidando uma carteira vazia — e
  // como liquidação bloqueia COMPRAR, a medição nova nunca começaria. O sintoma
  // ("o robô não compra nada") não aponta para a causa, e é o tipo de armadilha
  // que só se descobre dias depois.
  assert.equal(planoDeReset({ plataformas: PARQUE }).desligaModoVendas, true);
  assert.equal(planoDeReset({ plataformas: PARQUE, incluirToro: true }).desligaModoVendas, true);
  assert.equal(planoDeReset({ plataformas: [] }).desligaModoVendas, true);
});

test('o reset SEMPRE invalida o estado que o bot guarda em memória', () => {
  // Apagar `dados/estado` no Firestore não alcança a cópia em RAM do
  // orquestrador, que só lê esses documentos no boot. Sem a invalidação, o bot
  // segue filtrando a variação contra o preço de ANTES do reset e regrava os
  // contadores de decisão antigos nos documentos recém nascidos — foi o que
  // aconteceu em 2026-07-27, e contamina justamente a primeira medição da
  // janela nova, que é tudo o que o reset existe para proteger.
  assert.equal(planoDeReset({ plataformas: PARQUE }).invalidaEstadoEmMemoria, true);
  assert.equal(planoDeReset({ plataformas: PARQUE, incluirToro: true }).invalidaEstadoEmMemoria, true);
  // Vale mesmo sem nenhuma plataforma alvo: o que precisa ser descartado é a
  // memória do processo, não o conteúdo de uma plataforma específica.
  assert.equal(planoDeReset({ plataformas: [] }).invalidaEstadoEmMemoria, true);
});

test('bot que NÃO confirmou a parada aborta o reset antes de apagar', () => {
  // Era o buraco: a espera devolvia false e o script apagava assim mesmo, com um
  // ciclo possivelmente escrevendo no meio. Isso anula a única proteção que ele
  // tem — e o resíduo entraria pela porta que o próprio script deixou aberta.
  const parado = decidirSeSegue({ confirmou: false });
  assert.equal(parado.segue, false);
  assert.match(parado.motivo, /nada foi apagado/);
  // O aviso precisa dizer o que fazer: a operação fica TRAVADA e o dono
  // descobriria isso pela dashboard sem entender por quê.
  assert.match(parado.motivo, /TRAVADA/);

  assert.equal(decidirSeSegue({ confirmou: true }).segue, true);
});

test('a porta de escape existe, mas precisa ser PEDIDA na linha de comando', () => {
  // Caso legítimo: o dono parou o processo (pm2 stop) e o heartbeat ainda não
  // sumiu. Seguir é correto ali — só não pode ser o padrão.
  assert.equal(decidirSeSegue({ confirmou: false, forcado: true }).segue, true);
  assert.equal(decidirSeSegue({ confirmou: false, forcado: false }).segue, false);
  assert.equal(decidirSeSegue({}).segue, false, 'sem argumento nenhum, o seguro é PARAR');
});

test('parsearCaixa entende a lista e recusa valor inválido', () => {
  assert.deepEqual(parsearCaixa('MB=1000,BN=500.5'), { MB: 1000, BN: 500.5 });
  assert.deepEqual(parsearCaixa('mb=10'), { MB: 10 }); // aceita minúscula
  assert.deepEqual(parsearCaixa(null), {});
  assert.deepEqual(parsearCaixa(''), {});

  // Silenciar um valor quebrado semearia caixa errado, e o robô opera em cima.
  assert.throws(() => parsearCaixa('MB=abc'), /valor inválido/);
  assert.throws(() => parsearCaixa('MB=-5'), /valor inválido/);
  assert.throws(() => parsearCaixa('=100'), /sem plataforma/);
});

test('importar o script NÃO executa nada', async () => {
  // O módulo só roda quando chamado direto pela linha de comando. Se importar
  // disparasse o reset, um `npm test` apagaria a produção.
  const mod = await import('../scripts/resetar-dados.mjs');
  assert.equal(typeof mod.planoDeReset, 'function');
});
