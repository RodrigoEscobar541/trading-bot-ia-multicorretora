// posicoes.test.js — posições independentes (lotes): lucro por posição,
// reconciliação com o saldo (compras manuais/depósitos/saques) e ciclo de
// vida, agora com escopo (plataforma, ativo). Persistência em memória.
// Rodar com: npm test

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  lucroDaPosicao,
  precoMinimoVendaLucrativa,
  reconciliarComSaldo,
  abrirPosicao,
  listarPosicoesAbertas,
  fecharPosicao,
  atualizarCicloDeVida,
  sincronizarPosicoesComSaldo,
  precoMedioDasPosicoes,
} from '../src/posicoes/posicoes.js';
import {
  inicializarPersistencia,
  salvarPlataforma,
  salvarAtivo,
  obterPosicoesAtivoPorModo,
  obterPosicoesAbertasAtivo,
  registrarPosicaoAtivo,
  lerDocBruto,
} from '../src/firebase/firebaseClient.js';
import { backfillPosicoesAbertaModo } from '../src/migracao/migrarV1paraV2.js';

const CONFIG = { taxa_compra_percentual: 1.5, taxa_venda_percentual: 1.5 };
const ESCOPO = { plataforma: 'MB', ativo: 'BTC' };

beforeEach(async () => {
  await inicializarPersistencia({ modo: 'memoria' }); // backend novo a cada teste
});

// ------------------------------------------------------------ funções puras

test('lucro da posição usa o preço de compra DO lote, não a média da carteira', () => {
  const p = { quantidade: 0.001, preco_compra: 600000 };
  // venda 610: bruto 610 − 600 = 10; taxas 9 + 9.15 → −8.15
  const lucro = lucroDaPosicao(p, 610000, CONFIG);
  assert.ok(Math.abs(lucro - -8.15) < 1e-9, `lucro = ${lucro}`);
  // venda 640: bruto 40; taxas 9 + 9.6 → +21.40
  assert.ok(lucroDaPosicao(p, 640000, CONFIG) > 0);
});

test('preço mínimo de venda lucrativa embute as duas taxas (+3,05% com 1,5%/1,5%)', () => {
  const minimo = precoMinimoVendaLucrativa(600000, CONFIG);
  // 600000 × 1.015 / 0.985 = 618274.11...
  assert.ok(Math.abs(minimo - 618274.11) < 0.02, `minimo = ${minimo}`);
  const p = { quantidade: 0.001, preco_compra: 600000 };
  assert.ok(lucroDaPosicao(p, minimo + 1, CONFIG) > 0);
  assert.ok(lucroDaPosicao(p, minimo - 1, CONFIG) < 0);
});

test('reconciliação: ativo a mais no saldo vira nova posição externa ao preço atual', () => {
  const abertas = [{ id: 'a', status: 'LUCRO', origem: 'bot', quantidade: 0.01, abertura: '2026-01-01' }];
  const r = reconciliarComSaldo(abertas, 0.015, 320000);
  assert.deepEqual(r.reducoes, []);
  assert.equal(r.nova.quantidade, 0.005);
  assert.equal(r.nova.preco_compra, 320000);
});

test('reconciliação: ativo a menos abate primeiro das externas, depois FIFO', () => {
  const abertas = [
    { id: 'bot_velha', status: 'MONITORANDO', origem: 'bot', quantidade: 0.01, abertura: '2026-01-01' },
    { id: 'externa', status: 'MONITORANDO', origem: 'externa', quantidade: 0.004, abertura: '2026-01-02' },
    { id: 'bot_nova', status: 'LUCRO', origem: 'bot', quantidade: 0.006, abertura: '2026-01-03' },
  ];
  // saldo caiu de 0.02 para 0.009: sai 0.011 → externa inteira (0.004) +
  // 0.007 da bot mais antiga (fica 0.003)
  const r = reconciliarComSaldo(abertas, 0.009, 320000);
  assert.equal(r.nova, null);
  assert.deepEqual(r.reducoes, [
    { id: 'externa', quantidade: 0, fechar: true },
    { id: 'bot_velha', quantidade: 0.003, fechar: false },
  ]);
});

test('reconciliação: diferença de arredondamento é ruído, não movimentação', () => {
  const abertas = [{ id: 'a', status: 'LUCRO', origem: 'bot', quantidade: 0.01, abertura: '2026-01-01' }];
  const r = reconciliarComSaldo(abertas, 0.01000001, 320000);
  assert.equal(r.nova, null);
  assert.deepEqual(r.reducoes, []);
});

// ------------------------------------------------- ciclo de vida + persistência

test('ciclo de vida: posição vira LUCRO com lucro positivo e MONITORANDO sem ele', async () => {
  const p = await abrirPosicao({
    ...ESCOPO,
    modo: 'simulacao',
    origem: 'bot',
    quantidade: 0.001,
    preco_compra: 600000,
  });
  assert.equal(p.status, 'ABERTA');

  let [atualizada] = await atualizarCicloDeVida('MB', 'BTC', [p], 640000, CONFIG); // acima do mínimo
  assert.equal(atualizada.status, 'LUCRO');
  assert.ok(atualizada.lucro_se_vender_agora > 0);

  [atualizada] = await atualizarCicloDeVida('MB', 'BTC', [atualizada], 610000, CONFIG); // abaixo do mínimo
  assert.equal(atualizada.status, 'MONITORANDO');
  assert.ok(atualizada.lucro_se_vender_agora < 0);
});

test('fechar posição a remove da lista de abertas', async () => {
  const p = await abrirPosicao({ ...ESCOPO, modo: 'simulacao', origem: 'bot', quantidade: 0.001, preco_compra: 300000 });
  await fecharPosicao('MB', 'BTC', p.id, { preco_venda: 320000, lucro_liquido: 10.55, operacao_venda_id: 'op_x' });
  assert.deepEqual(await listarPosicoesAbertas('MB', 'BTC', 'simulacao'), []);
});

test('compra manual na plataforma entra como posição externa vendável', async () => {
  await abrirPosicao({ ...ESCOPO, modo: 'simulacao', origem: 'bot', quantidade: 0.01, preco_compra: 300000 });
  // saldo real subiu 0.002 além das posições conhecidas (compra manual)
  const posicoes = await sincronizarPosicoesComSaldo({
    ...ESCOPO,
    modo: 'simulacao',
    saldo: 0.012,
    preco_atual: 310000,
  });
  assert.equal(posicoes.length, 2);
  const externa = posicoes.find((p) => p.origem === 'externa');
  assert.equal(externa.quantidade, 0.002);
  assert.equal(externa.preco_compra, 310000);
});

test('posições de ativos diferentes não se misturam (escopo por subcoleção)', async () => {
  await abrirPosicao({ ...ESCOPO, modo: 'simulacao', origem: 'bot', quantidade: 0.01, preco_compra: 300000 });
  await abrirPosicao({ plataforma: 'MB', ativo: 'ETH', modo: 'simulacao', origem: 'bot', quantidade: 0.5, preco_compra: 18000, sufixoId: 'eth' });
  const btc = await listarPosicoesAbertas('MB', 'BTC', 'simulacao');
  const eth = await listarPosicoesAbertas('MB', 'ETH', 'simulacao');
  assert.equal(btc.length, 1);
  assert.equal(eth.length, 1);
  assert.equal(eth[0].quantidade, 0.5);
});

test('preço médio informativo pondera as posições abertas', async () => {
  const posicoes = [
    { status: 'LUCRO', quantidade: 0.01, preco_compra: 300000 },
    { status: 'MONITORANDO', quantidade: 0.01, preco_compra: 340000 },
    { status: 'FECHADA', quantidade: 0.05, preco_compra: 100000 }, // fora do cálculo
  ];
  assert.equal(precoMedioDasPosicoes(posicoes), 320000);
});

// ------------------------------------------- aberta_modo (V5_2_Plan.MD §4)

test('aberta_modo: nasce com o modo, zera ao fechar e a query nova só vê abertas', async () => {
  const aberta = await abrirPosicao({ ...ESCOPO, modo: 'simulacao', origem: 'bot', quantidade: 0.001, preco_compra: 300000 });
  assert.equal(aberta.aberta_modo, 'simulacao');

  const fechada = await abrirPosicao({ ...ESCOPO, modo: 'simulacao', origem: 'bot', quantidade: 0.002, preco_compra: 310000, sufixoId: 'b' });
  await fecharPosicao('MB', 'BTC', fechada.id, { preco_venda: 320000, lucro_liquido: 5 });

  // A query do caminho quente devolve SÓ a aberta; a da coleção inteira, as duas.
  const soAbertas = await obterPosicoesAbertasAtivo('MB', 'BTC', 'simulacao');
  assert.deepEqual(soAbertas.map((p) => p.id), [aberta.id]);
  assert.equal((await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao')).length, 2);
});

test('backfill de aberta_modo corrige posições antigas UMA vez (idempotente)', async () => {
  // O backfill navega por plataformas → ativos → posições.
  await salvarPlataforma('MB', { nome: 'Mercado Bitcoin' });
  await salvarAtivo('MB', 'BTC', { manifest: { id: 'BTC' } });
  // Posições "de antes da V5.2": sem o campo aberta_modo.
  await registrarPosicaoAtivo('MB', 'BTC', { id: 'pos_antiga_aberta', modo: 'simulacao', status: 'MONITORANDO' });
  await registrarPosicaoAtivo('MB', 'BTC', { id: 'pos_antiga_fechada', modo: 'simulacao', status: 'FECHADA' });
  assert.deepEqual(await obterPosicoesAbertasAtivo('MB', 'BTC', 'simulacao'), []); // invisíveis à query nova

  const r1 = await backfillPosicoesAbertaModo();
  assert.equal(r1.executado, true);
  assert.equal(r1.posicoes_atualizadas, 2);
  const visiveis = await obterPosicoesAbertasAtivo('MB', 'BTC', 'simulacao');
  assert.deepEqual(visiveis.map((p) => p.id), ['pos_antiga_aberta']); // fechada ficou com null

  // 2ª execução: o marcador global impede novo percurso da coleção.
  const r2 = await backfillPosicoesAbertaModo();
  assert.equal(r2.executado, false);
  assert.ok((await lerDocBruto('global', 'migracoes')).posicoes_aberta_modo_em);
});
