// migracaoV2.test.js — persistência V2 (árvore plataformas/) e migração
// V1 → V2 (V2_Plan.MD §E). Persistência em memória — nada de rede.
// Rodar com: npm test

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  inicializarPersistencia,
  salvarDocBruto,
  adicionarDocBruto,
  // V2
  listarPlataformas,
  obterPlataforma,
  obterApiPlataforma,
  obterTemplatePlataforma,
  salvarTemplatePlataforma,
  obterEstadoPlataforma,
  listarAtivos,
  obterAtivo,
  salvarAtivo,
  obterEstadoAtivo,
  obterEstatisticasAtivo,
  obterHistoricoRecenteAtivo,
  obterUltimaOperacaoExecutadaAtivo,
  obterPosicoesAtivoPorModo,
  obterContextoAtivo,
  salvarContextoAtivo,
  CONFIG_ATIVO_PADRAO,
} from '../src/firebase/firebaseClient.js';
import { migrarV1paraV2 } from '../src/migracao/migrarV1paraV2.js';

beforeEach(async () => {
  await inicializarPersistencia({ modo: 'memoria' }); // backend novo a cada teste
});

// ------------------------------------------------------------ cliente V2 puro

test('obterAtivo mescla manifest e config com os padrões', async () => {
  await salvarAtivo('MB', 'BTC', {
    manifest: { id: 'BTC', nome: 'Bitcoin', par: 'BTC-BRL' },
    config: { taxa_compra_percentual: 0.7 },
  });
  const ativo = await obterAtivo('MB', 'BTC');
  assert.equal(ativo.manifest.par, 'BTC-BRL');
  assert.equal(ativo.manifest.mercado24h, true); // padrão
  assert.equal(ativo.config.taxa_compra_percentual, 0.7);
  assert.equal(ativo.config.orcamento_percentual, CONFIG_ATIVO_PADRAO.orcamento_percentual);
});

test('salvarAtivo faz merge profundo — atualizar um campo da config não apaga o resto', async () => {
  await salvarAtivo('MB', 'BTC', {
    manifest: { id: 'BTC', par: 'BTC-BRL' },
    config: { taxa_compra_percentual: 0.7, orcamento_percentual: 40 },
  });
  await salvarAtivo('MB', 'BTC', { config: { modo_simulacao: false } });
  const ativo = await obterAtivo('MB', 'BTC');
  assert.equal(ativo.config.modo_simulacao, false);
  assert.equal(ativo.config.orcamento_percentual, 40); // preservado
  assert.equal(ativo.manifest.par, 'BTC-BRL'); // preservado
});

test('template e prompt incrementam a versão a cada edição (auditoria)', async () => {
  const v1 = await salvarTemplatePlataforma('MB', '# primeiro');
  assert.equal(v1.versao, 1);
  const v2 = await salvarTemplatePlataforma('MB', '# segundo');
  assert.equal(v2.versao, 2);
  const lido = await obterTemplatePlataforma('MB');
  assert.equal(lido.conteudo, '# segundo');
  assert.ok(lido.atualizado_em);
});

test('contexto do ativo guarda o texto e a data de atualização', async () => {
  await salvarContextoAtivo('MB', 'BTC', 'Halving se aproximando; fluxo de ETFs positivo.');
  const ctx = await obterContextoAtivo('MB', 'BTC');
  assert.match(ctx.texto, /Halving/);
  assert.ok(ctx.atualizado_em);
});

// ------------------------------------------------------------------- migração

/** Semeia um retrato fiel dos dados V1 de produção (coleções planas antigas). */
async function semearV1() {
  await salvarDocBruto('config', 'bot', {
    api_key_ia: 'chave-ia',
    api_key_mb_id: 'id-mb',
    api_key_mb_secret: 'secret-mb',
    modelos_ia: ['gemini-3.5-flash', 'gemini-3.1-flash-lite'],
    tempo_entre_analises_minutos: 20,
    percentual_minimo_variacao: 0.4,
    tempo_reset_dias: 10,
    taxa_compra_percentual: 0.7,
    taxa_venda_percentual: 0.7,
    modo_simulacao: true,
  });
  await salvarDocBruto('estado', 'bot', {
    preco_ultima_analise: 331000,
    horario_ultima_analise: '2026-07-12T14:58:00Z',
    ultima_decisao_ia: { acao: 'COMPRAR', percentual: 20, horario: '2026-07-12T14:58:00Z' },
    carteira_simulacao: {
      saldo_brl: 2500.5,
      saldo_btc: 0.00725981,
      custo_total_brl: 2397.07,
      inicializada_em: '2026-07-01T00:00:00Z',
    },
    sincronizacao_saldos_reais: { saldo_brl: 2500.5, saldo_btc: 0.00725981, em: '2026-07-12T14:58:00Z' },
    patrimonio_inicio_dia: { data: '2026-07-12', modo: 'simulacao', valor: 4900 },
  });
  await salvarDocBruto('estatisticas', 'simulacao', { lucro_total_brl: 42.5, quantidade_operacoes: 3 });
  await adicionarDocBruto(
    'operacoes',
    {
      id: 'op_20260712_145839',
      tipo: 'COMPRA',
      status: 'executada',
      modo: 'simulacao',
      preco: 331087,
      quantidade_btc: 0.00034395,
      valor_brl: 115.61,
      taxa_mb: 1.73,
      horario: '2026-07-12T14:58:39Z',
    },
    'op_20260712_145839',
  );
  await adicionarDocBruto(
    'posicoes',
    {
      id: 'pos_20260712_145839',
      modo: 'simulacao',
      origem: 'bot',
      status: 'MONITORANDO',
      quantidade_btc: 0.00034395,
      preco_compra: 331087,
      abertura: '2026-07-12T14:58:39Z',
    },
    'pos_20260712_145839',
  );
  await adicionarDocBruto('historico', {
    tipo: 'analise',
    modo: 'simulacao',
    horario: '2026-07-12T14:58:39Z',
    preco_atual: 331087,
    patrimonio_brl: 4900.55,
    posicoes: [{ id: 'pos_x', quantidade_btc: 0.001 }],
  });
  await adicionarDocBruto('historico', { tipo: 'verificacao', horario: '2026-07-12T15:13:00Z', preco_atual: 331100 });
}

test('migração completa: plataforma, api, template, carteira, ativo, históricos', async () => {
  await semearV1();
  const r = await migrarV1paraV2();
  assert.equal(r.migrado, true);
  assert.deepEqual(r.resumo, { historico: 2, operacoes: 1, posicoes: 1 });

  // Plataforma
  const mb = await obterPlataforma('MB');
  assert.equal(mb.nome, 'Mercado Bitcoin');
  assert.equal(mb.conector, 'mb');
  assert.deepEqual(mb.modelos_ia, ['gemini-3.5-flash', 'gemini-3.1-flash-lite']);

  // Credenciais renomeadas (api_key_mb_id → api_key_id)
  const api = await obterApiPlataforma('MB');
  assert.equal(api.api_key_ia, 'chave-ia');
  assert.equal(api.api_key_id, 'id-mb');
  assert.equal(api.api_key_secret, 'secret-mb');

  // Template semeado do promptBase.md
  const template = await obterTemplatePlataforma('MB');
  assert.ok(template.conteudo.length > 100);
  assert.equal(template.versao, 1);

  // Carteira virtual por plataforma (saldo_moeda + saldos por ativo)
  const estadoPlat = await obterEstadoPlataforma('MB');
  assert.equal(estadoPlat.carteira_virtual.saldo_moeda, 2500.5);
  assert.equal(estadoPlat.carteira_virtual.saldos.BTC, 0.00725981);
  assert.equal(estadoPlat.sincronizacao_saldos_reais.saldo_moeda, 2500.5);

  // Ativos: BTC ligado com a config da V1; ETH/SOL desligados com orçamento 0
  const ativos = await listarAtivos('MB');
  assert.deepEqual(ativos.map((a) => a.id).sort(), ['BTC', 'ETH', 'SOL']);
  const btc = await obterAtivo('MB', 'BTC');
  assert.equal(btc.config.ativo, true);
  assert.equal(btc.config.taxa_compra_percentual, 0.7);
  assert.equal(btc.config.tempo_entre_analises_minutos, 20);
  assert.equal(btc.config.orcamento_percentual, 100);
  assert.equal(btc.manifest.par, 'BTC-BRL');
  const eth = await obterAtivo('MB', 'ETH');
  assert.equal(eth.config.ativo, false);
  assert.equal(eth.config.orcamento_percentual, 0);
  assert.equal(eth.manifest.par, 'ETH-BRL');

  // Estado do ativo; circuit breaker vira referência da PLATAFORMA por modo
  const estadoBtc = await obterEstadoAtivo('MB', 'BTC');
  assert.equal(estadoBtc.preco_ultima_analise, 331000);
  assert.equal(estadoBtc.ultima_decisao_ia.acao, 'COMPRAR');
  assert.equal(estadoPlat.patrimonio_inicio_dia.simulacao.valor, 4900);

  // Estatísticas com campos genéricos (lucro_total_brl → lucro_total)
  const stats = await obterEstatisticasAtivo('MB', 'BTC', 'simulacao');
  assert.equal(stats.lucro_total, 42.5);
  assert.equal(stats.quantidade_operacoes, 3);

  // Operações com id preservado; campos renomeados para os genéricos
  const ultimaOp = await obterUltimaOperacaoExecutadaAtivo('MB', 'BTC');
  assert.equal(ultimaOp.id, 'op_20260712_145839');
  assert.equal(ultimaOp.quantidade, 0.00034395);
  assert.equal(ultimaOp.valor, 115.61);
  assert.equal(ultimaOp.taxa, 1.73);
  assert.equal(ultimaOp.quantidade_btc, undefined);

  // Posições com id preservado; quantidade_btc → quantidade
  const posicoes = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  assert.equal(posicoes.length, 1);
  assert.equal(posicoes[0].id, 'pos_20260712_145839');
  assert.equal(posicoes[0].quantidade, 0.00034395);

  // Histórico copiado, inclusive snapshots de posições convertidos
  const historico = await obterHistoricoRecenteAtivo('MB', 'BTC', 10);
  assert.equal(historico.length, 2);
  const analise = historico.find((h) => h.tipo === 'analise');
  assert.equal(analise.posicoes[0].quantidade, 0.001);
  assert.equal(analise.patrimonio, 4900.55); // patrimonio_brl → patrimonio
});

test('migração é idempotente: segunda chamada não faz nada', async () => {
  await semearV1();
  assert.equal((await migrarV1paraV2()).migrado, true);
  const segunda = await migrarV1paraV2();
  assert.equal(segunda.migrado, false);
  assert.match(segunda.motivo, /já concluída/);
});

test('migração interrompida no meio é RETOMADA sem duplicar nada', async () => {
  await semearV1();
  // Simula a interrupção: plataforma criada (marcador antigo de idempotência),
  // histórico copiado pela metade, operações/posições ainda não copiadas —
  // e SEM o marcador de conclusão.
  await salvarDocBruto('plataformas', 'MB', { nome: 'Mercado Bitcoin', conector: 'mb' });
  await adicionarDocBruto('plataformas/MB/ativos/BTC/historico', {
    tipo: 'analise',
    modo: 'simulacao',
    horario: '2026-07-12T14:58:39Z', // mesmo horario do doc V1 → não pode duplicar
    preco_atual: 331087,
  });

  const r = await migrarV1paraV2();
  assert.equal(r.migrado, true);
  assert.equal(r.retomada, true);
  // 1 dos 2 docs de histórico já existia (dedupe por horario) → copia só 1.
  assert.deepEqual(r.resumo, { historico: 1, operacoes: 1, posicoes: 1 });

  const historico = await obterHistoricoRecenteAtivo('MB', 'BTC', 10);
  assert.equal(historico.length, 2); // sem duplicatas
  const posicoes = await obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao');
  assert.equal(posicoes.length, 1);
  assert.equal(posicoes[0].quantidade, 0.00034395);

  // Depois da retomada, está concluída de verdade.
  const terceira = await migrarV1paraV2();
  assert.equal(terceira.migrado, false);
  assert.match(terceira.motivo, /já concluída/);
});

test('instalação nova (sem dados V1) semeia a árvore com os padrões', async () => {
  const r = await migrarV1paraV2();
  assert.equal(r.migrado, true);
  assert.deepEqual(r.resumo, { historico: 0, operacoes: 0, posicoes: 0 });

  const plataformas = await listarPlataformas();
  assert.deepEqual(plataformas.map((p) => p.id), ['MB']);

  const btc = await obterAtivo('MB', 'BTC');
  assert.equal(btc.config.ativo, true);
  assert.equal(btc.config.modo_simulacao, true); // padrão seguro
  assert.equal(btc.config.taxa_compra_percentual, CONFIG_ATIVO_PADRAO.taxa_compra_percentual);

  const estadoPlat = await obterEstadoPlataforma('MB');
  assert.equal(estadoPlat.carteira_virtual, null);
});
