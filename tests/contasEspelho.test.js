// contasEspelho.test.js — contas adicionais da MESMA corretora, que recebem as
// ordens decididas para a conta principal (V8.18 — ROADMAP item 14).
//
// COBRE AS FASES 1, 2 E 3a:
//   fase 1 — cadastrar a conta, ler o saldo dela, e provar que NENHUMA ordem sai;
//   fase 2 — a ordem SOMBRA: o que a conta compraria, calculado com o saldo dela,
//            registrado sem nada ir para a corretora;
//   fase 3a — livro de lotes e carteira virtual PRÓPRIOS da conta, com a ordem
//            executada em SIMULAÇÃO. Ainda nada vai para a corretora.
// As fases 3b (ordem real) e 4 (saídas por conta) acrescentam casos aqui — e o
// que nunca pode ser afrouxado é o da regra imutável 4 por conta.
//
// O invariante que atravessa o arquivo inteiro: **a conta principal não muda de
// comportamento**. Se um teste da principal precisar ser afrouxado para um caso
// do espelho passar, é o espelho que está errado. Rodar com: npm test

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { executarRodada, limparEstadoAtivosEmMemoria } from '../src/nucleo/orquestrador.js';
import { pareceMesmaConta, espelharContasSecundarias, saidasAutomaticasDasContas } from '../src/nucleo/contasEspelho.js';
import { abrirPosicao } from '../src/posicoes/posicoes.js';
import { invalidarCatalogo, contasCache, apiContaCache } from '../src/nucleo/catalogo.js';
import { migrarV1paraV2 } from '../src/migracao/migrarV1paraV2.js';
import {
  inicializarPersistencia,
  listarContas,
  listarAtivos,
  listarPlataformas,
  salvarConta,
  salvarApiConta,
  salvarAtivo,
  obterAtivo,
  obterApiConta,
  obterEstadoConta,
  listarOperacoesConta,
  obterOperacoesExecutadasDesdeAtivo,
  obterPosicoesAbertasAtivo,
  obterPosicoesAtivoPorModo,
} from '../src/firebase/firebaseClient.js';

/** Todos os lotes da conta espelho no modo simulação, abertos ou fechados. */
const obterPosicoesAtivoPorModoConta = () => obterPosicoesAtivoPorModo('MB', 'BTC', 'simulacao', 'amigo');

beforeEach(async () => {
  await inicializarPersistencia({ modo: 'memoria' });
  invalidarCatalogo();
  limparEstadoAtivosEmMemoria();
  await migrarV1paraV2();
});

test('conta espelho nasce ATIVA e em SIMULAÇÃO — nenhuma ordem real por engano', async () => {
  // O padrão importa: a fase 3 do plano (ordem de verdade no dinheiro de outra
  // pessoa) tem de ser um ato deliberado, nunca o que acontece se o dono
  // esquecer de configurar um campo.
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  const [conta] = await listarContas('MB');

  assert.equal(conta.id, 'amigo');
  assert.equal(conta.nome, 'Conta do João');
  assert.equal(conta.ativa, true);
  assert.equal(conta.modo_simulacao, true, 'sem dizer nada, a conta espelha em SIMULAÇÃO');
});

test('a conta espelho NÃO vira plataforma nem ativo — as duas árvores não se cruzam', async () => {
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });

  const plataformas = (await listarPlataformas()).map((p) => p.id);
  assert.deepEqual(plataformas, ['MB'], 'conta não é plataforma');

  const ativos = (await listarAtivos('MB')).map((a) => a.id).sort();
  assert.deepEqual(ativos, ['BTC', 'ETH', 'SOL'], 'conta não aparece entre os ativos');
});

test('a credencial da conta NÃO cai no .env da conta principal', async () => {
  // É conta de TERCEIRO: herdar a chave do dono por fallback mandaria a ordem
  // do amigo para a conta dele. O fallback existe só para a plataforma.
  const original = process.env.MB_API_TOKEN_ID;
  process.env.MB_API_TOKEN_ID = 'chave-do-dono';
  try {
    await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
    const api = await obterApiConta('MB', 'amigo');
    assert.notEqual(api.mb_api_token_id, 'chave-do-dono');
    assert.ok(!api.mb_api_token_id, 'sem credencial própria, a conta fica sem credencial');
  } finally {
    if (original === undefined) delete process.env.MB_API_TOKEN_ID;
    else process.env.MB_API_TOKEN_ID = original;
  }
});

test('as contas e as credenciais passam pelo CATÁLOGO (nada de leitura por tick)', async () => {
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  await salvarApiConta('MB', 'amigo', { mb_api_token_id: 'chave-do-amigo' });

  assert.equal((await contasCache('MB')).length, 1);
  assert.equal((await apiContaCache('MB', 'amigo')).mb_api_token_id, 'chave-do-amigo');

  // Gravar de novo NÃO muda o que o catálogo devolve — é a prova de que a
  // leitura está cacheada e não acontece a cada tick.
  await salvarConta('MB', 'outra', { nome: 'Segunda' });
  assert.equal((await contasCache('MB')).length, 1, 'ainda o valor cacheado');
  invalidarCatalogo();
  assert.equal((await contasCache('MB')).length, 2, 'depois de invalidar, relê');
});

test('FASE 1: conta espelho com credencial quebrada NÃO derruba a rodada da principal', async () => {
  // O contrato é o mesmo do Telegram: conta espelho é acessório. Um erro nela
  // não pode chegar perto do ciclo da conta que opera de verdade.
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  await salvarApiConta('MB', 'amigo', { mb_api_token_id: 'chave-invalida', mb_api_token_secret: 'x' });
  await salvarAtivo('MB', 'BTC', { config: { ativo: false } }); // nada a analisar
  invalidarCatalogo();

  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('corretora fora do ar'); };
  try {
    const resumo = await executarRodada({ decidirFn: async () => ({}) });
    assert.deepEqual(resumo, [], 'a rodada terminou normalmente, sem lançar');
  } finally {
    globalThis.fetch = fetchOriginal;
  }

  // E o erro ficou REGISTRADO na conta, que é o ponto: a dashboard precisa
  // mostrar "não autenticou" em vez de um silêncio.
  const estado = await obterEstadoConta('MB', 'amigo');
  assert.equal(estado.conexao?.ok, false);
  assert.ok(estado.conexao?.erro, 'o motivo da falha fica salvo');
  assert.equal(estado.saldo, undefined, 'sem autenticar, não há saldo para mostrar');
});

test('FASE 1: conta DESATIVADA nem é consultada', async () => {
  await salvarConta('MB', 'amigo', { nome: 'Conta do João', ativa: false });
  await salvarAtivo('MB', 'BTC', { config: { ativo: false } });
  invalidarCatalogo();

  const fetchOriginal = globalThis.fetch;
  let bateu = false;
  globalThis.fetch = async () => { bateu = true; throw new Error('não deveria consultar'); };
  try {
    await executarRodada({ decidirFn: async () => ({}) });
  } finally {
    globalThis.fetch = fetchOriginal;
  }
  assert.equal(bateu, false, 'conta desativada não gera chamada à corretora');
  assert.deepEqual(await obterEstadoConta('MB', 'amigo'), {}, 'e não escreve estado nenhum');
});

test('FASE 1: nenhuma ordem é enviada — a conta espelho ainda não opera', async () => {
  // A trava desta fase. Quando as fases 3 e 4 chegarem, este teste muda de
  // forma DELIBERADA, e o commit que o mudar é o que assume o risco.
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  await salvarApiConta('MB', 'amigo', { mb_api_token_id: 'k', mb_api_token_secret: 's' });
  invalidarCatalogo();

  const fetchOriginal = globalThis.fetch;
  const chamadas = [];
  globalThis.fetch = async (url, init = {}) => {
    chamadas.push(`${init.method ?? 'GET'} ${String(url)}`);
    throw new Error('sem rede no teste');
  };
  try {
    await executarRodada({ decidirFn: async () => ({}) });
  } finally {
    globalThis.fetch = fetchOriginal;
  }
  const ordens = chamadas.filter((c) => /\/orders?\b/i.test(c) || c.startsWith('POST'));
  assert.deepEqual(ordens, [], 'nenhuma chamada de criação de ordem saiu nesta fase');
});

// ============================================================ FASE 2 — sombra
// A conta espelho calcula a ordem que SERIA enviada, com o saldo REAL dela, e
// registra o resultado. Nada vai para a corretora.

const PLATAFORMA = { id: 'MB', nome: 'Mercado Bitcoin', conector: 'mb', moeda: 'BRL' };

/** Conector falso da CONTA espelho — o de ordem lança, e é essa a prova. */
const conectorDaConta = (saldoMoeda, saldos = {}) => () => ({
  id: 'falso-conta',
  saldos: async () => ({ moeda: 'BRL', saldo_moeda: saldoMoeda, saldos: structuredClone(saldos) }),
  ordemMercado: async () => { throw new Error('a FASE 2 não pode enviar ordem'); },
  aguardarFill: async () => { throw new Error('a FASE 2 não pode aguardar fill'); },
});

const compraDaPrincipal = {
  id: 'op_principal_1', status: 'executada', tipo: 'COMPRA',
  preco: 100000, quantidade: 0.002, valor: 200,
};
const avaliacaoDaPrincipal = { aprovada: true, ordem: { preco_execucao: 100000, valor: 200, quantidade: 0.002 } };
// Toda COMPRA carrega o chão obrigatório (regra V6.6). A primeira versão deste
// teste esqueceu, e o Motor recusou a sombra — de propósito. Fica registrado:
// a sombra passa pelo MESMO `avaliar()` da principal, e não ganha desconto.
const decisaoComprar = {
  acao: 'COMPRAR', percentual: 20, valida: true, justificativa: 'T.',
  stop_loss: 92000, stop_loss_motivo: 'abaixo do fundo recente',
};

async function ativoParaSombra() {
  const ativo = await obterAtivo('MB', 'BTC');
  ativo.config.orcamento_percentual = 100;
  ativo.config.minimo_ordem_valor = 10;
  ativo.config.minimo_ordem_quantidade = 0.000001;
  return ativo;
}

test('pareceMesmaConta: pega a segunda chave da MESMA conta, e só ela', () => {
  const base = { moeda: 'BRL', saldo_moeda: 1172.00012568, saldos: { BNB: 0.00091488, SOL: 0.000179 } };

  // O caso real de 21/08: o dono criou uma 2ª chave na própria conta.
  assert.equal(pareceMesmaConta(base, structuredClone(base)), true);

  // Um centavo de diferença já é outra conta.
  assert.equal(pareceMesmaConta(base, { ...base, saldo_moeda: 1172.00012569 }), false);
  // Mesmo caixa, cripto diferente → contas diferentes.
  assert.equal(pareceMesmaConta(base, { ...base, saldos: { BNB: 0.00091488 } }), false);
  // Moedas diferentes nunca são a mesma conta.
  assert.equal(pareceMesmaConta(base, { ...base, moeda: 'USD' }), false);
  // Sem dado, não se afirma nada.
  assert.equal(pareceMesmaConta(null, base), false);
  assert.equal(pareceMesmaConta(base, null), false);
});

test('FASE 2: a sombra dimensiona pelo saldo DA CONTA, não pelo da principal', async () => {
  // É a pergunta que a fase existe para responder. A principal comprou R$ 200
  // com R$ 1.000; a conta espelho tem R$ 5.000, então os mesmos 20% dão R$ 1.000.
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  await salvarApiConta('MB', 'amigo', { mb_api_token_id: 'k', mb_api_token_secret: 's' });
  invalidarCatalogo();

  const [sombra] = await espelharContasSecundarias({
    plataforma: PLATAFORMA,
    ativo: await ativoParaSombra(),
    decisao: decisaoComprar,
    avaliacao: avaliacaoDaPrincipal,
    operacao: compraDaPrincipal,
    saldosPrincipal: { moeda: 'BRL', saldo_moeda: 1000, saldos: {} },
    criarConectorFn: conectorDaConta(5000),
  });

  assert.equal(sombra.status, 'simulada', 'aprovada vira ordem SIMULADA no livro da conta (fase 3a)');
  assert.equal(sombra.aprovada, true);
  assert.equal(sombra.valor, 1000, '20% de R$ 5.000');
  assert.equal(sombra.principal.valor, 200, 'e guarda o que a principal fez, lado a lado');
  assert.equal(sombra.saldo_conta, 5000);
  assert.equal(sombra.mesma_conta_da_principal, false);
});

test('FASE 2: sem saldo, a sombra é registrada REPROVADA com o motivo', async () => {
  // Rejeição também é resultado: é ela que avisa o dono de que, no dia D, a
  // conta do amigo não teria conseguido acompanhar.
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  await salvarApiConta('MB', 'amigo', { mb_api_token_id: 'k' });
  invalidarCatalogo();

  const [sombra] = await espelharContasSecundarias({
    plataforma: PLATAFORMA,
    ativo: await ativoParaSombra(),
    decisao: decisaoComprar,
    avaliacao: avaliacaoDaPrincipal,
    operacao: compraDaPrincipal,
    criarConectorFn: conectorDaConta(0.5), // meio real: nem o mínimo da ordem
  });

  assert.equal(sombra.aprovada, false);
  assert.ok(sombra.motivo, 'o motivo da recusa fica gravado');
  assert.equal(sombra.saldo_conta, 0.5);
});

test('FASE 2: conta com o MESMO saldo da principal é marcada — em real, dobraria a compra', async () => {
  // O caso que aconteceu de verdade em 21/08. Em sombra é inofensivo; na fase 3
  // as duas ordens cairiam na mesma carteira.
  const saldos = { moeda: 'BRL', saldo_moeda: 1172.00012568, saldos: { BNB: 0.00091488 } };
  await salvarConta('MB', 'teste', { nome: 'teste' });
  await salvarApiConta('MB', 'teste', { mb_api_token_id: 'k' });
  invalidarCatalogo();

  const [sombra] = await espelharContasSecundarias({
    plataforma: PLATAFORMA,
    ativo: await ativoParaSombra(),
    decisao: decisaoComprar,
    avaliacao: avaliacaoDaPrincipal,
    operacao: compraDaPrincipal,
    saldosPrincipal: saldos,
    criarConectorFn: conectorDaConta(saldos.saldo_moeda, saldos.saldos),
  });

  assert.equal(sombra.mesma_conta_da_principal, true);
  const estado = await obterEstadoConta('MB', 'teste');
  assert.equal(estado.mesma_conta_da_principal, true, 'e a dashboard consegue avisar');
});

test('FASE 2: VENDA não gera sombra — os ids dos lotes são da carteira da principal', async () => {
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  invalidarCatalogo();

  const sombras = await espelharContasSecundarias({
    plataforma: PLATAFORMA,
    ativo: await ativoParaSombra(),
    decisao: { acao: 'VENDER', percentual: 0, posicoes: ['pos_da_principal'], valida: true },
    avaliacao: { aprovada: true, ordem: { preco_execucao: 100000, posicoes: [{ id: 'pos_da_principal' }] } },
    operacao: { ...compraDaPrincipal, tipo: 'VENDA' },
    criarConectorFn: conectorDaConta(5000),
  });
  assert.deepEqual(sombras, [], 'a saída da conta espelho é trabalho da fase 4');
});

test('FASE 2: operação REJEITADA na principal não vira sombra', async () => {
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  invalidarCatalogo();
  const sombras = await espelharContasSecundarias({
    plataforma: PLATAFORMA,
    ativo: await ativoParaSombra(),
    decisao: decisaoComprar,
    avaliacao: avaliacaoDaPrincipal,
    operacao: { ...compraDaPrincipal, status: 'rejeitada_saldo' },
    criarConectorFn: conectorDaConta(5000),
  });
  assert.deepEqual(sombras, []);
});

test('FASE 2: conta quebrada NÃO derruba as outras nem a chamada inteira', async () => {
  // O contrato do módulo: nunca lançar. A principal já executou quando isto roda.
  await salvarConta('MB', 'quebrada', { nome: 'Quebrada' });
  await salvarConta('MB', 'boa', { nome: 'Boa' });
  invalidarCatalogo();

  const sombras = await espelharContasSecundarias({
    plataforma: PLATAFORMA,
    ativo: await ativoParaSombra(),
    decisao: decisaoComprar,
    avaliacao: avaliacaoDaPrincipal,
    operacao: compraDaPrincipal,
    criarConectorFn: (plat, api) => ({
      saldos: async () => {
        if (!api.mb_api_token_id) throw new Error('credencial ausente');
        return { moeda: 'BRL', saldo_moeda: 3000, saldos: {} };
      },
    }),
  });
  // Nenhuma das duas tem credencial gravada → as duas falham, e mesmo assim a
  // chamada retorna normalmente, sem lançar.
  assert.deepEqual(sombras, []);
});

test('FASE 2: a sombra vive na árvore da CONTA, longe das operações da principal', async () => {
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  await salvarApiConta('MB', 'amigo', { mb_api_token_id: 'k' });
  invalidarCatalogo();

  await espelharContasSecundarias({
    plataforma: PLATAFORMA,
    ativo: await ativoParaSombra(),
    decisao: decisaoComprar,
    avaliacao: avaliacaoDaPrincipal,
    operacao: compraDaPrincipal,
    criarConectorFn: conectorDaConta(5000),
  });

  const daConta = await listarOperacoesConta('MB', 'BTC', 'amigo');
  assert.equal(daConta.length, 1);
  assert.equal(daConta[0].status, 'simulada');

  // E a árvore da principal continua intocada — é o isolamento que protege o
  // caminho que mexe com dinheiro de verdade.
  const daPrincipal = await obterOperacoesExecutadasDesdeAtivo('MB', 'BTC', '2000-01-01T00:00:00Z');
  assert.deepEqual(daPrincipal, [], 'nenhuma sombra vazou para as operações da principal');
});

// ====================================================== FASE 3a — livro próprio
// A conta espelho passa a ter carteira virtual e lotes PRÓPRIOS. A ordem é
// executada em SIMULAÇÃO — continua não indo nada para a corretora.

test('FASE 3a: a compra abre lote no livro DA CONTA e debita a carteira virtual dela', async () => {
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  await salvarApiConta('MB', 'amigo', { mb_api_token_id: 'k' });
  invalidarCatalogo();

  const ativo = await ativoParaSombra();
  const [op] = await espelharContasSecundarias({
    plataforma: PLATAFORMA,
    ativo,
    decisao: decisaoComprar,
    avaliacao: avaliacaoDaPrincipal,
    operacao: compraDaPrincipal,
    criarConectorFn: conectorDaConta(5000),
  });

  assert.equal(op.status, 'simulada');
  assert.ok(op.taxa > 0, 'a taxa é a MESMA função que a principal usa');

  // O lote nasceu na árvore da CONTA...
  const lotes = await obterPosicoesAbertasAtivo('MB', 'BTC', 'simulacao', 'amigo');
  assert.equal(lotes.length, 1);
  assert.equal(lotes[0].quantidade, op.quantidade);
  assert.equal(lotes[0].stop_loss, 92000, 'o chão da decisão da IA transfere — é preço absoluto');
  assert.equal(lotes[0].aberta_modo, 'simulacao', 'invariante V5.2 §4.1 vale igual aqui');

  // ...e NÃO na da principal.
  assert.deepEqual(await obterPosicoesAbertasAtivo('MB', 'BTC', 'simulacao'), []);

  // A carteira virtual da conta foi debitada.
  const estado = await obterEstadoConta('MB', 'amigo');
  assert.equal(estado.carteira_virtual.saldo_moeda, 5000 - op.valor);
  assert.equal(estado.carteira_virtual.saldos.BTC, op.quantidade);
});

test('FASE 3a: a SEGUNDA compra parte da carteira já gasta, não do saldo real', async () => {
  // É a diferença entre a fase 2 e a 3a, e o motivo de o livro existir: sem
  // ele, a conta compraria 20% dos mesmos R$ 5.000 para sempre.
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  await salvarApiConta('MB', 'amigo', { mb_api_token_id: 'k' });
  invalidarCatalogo();
  const ativo = await ativoParaSombra();
  const criarConectorFn = conectorDaConta(5000);

  const [primeira] = await espelharContasSecundarias({
    plataforma: PLATAFORMA, ativo, decisao: decisaoComprar,
    avaliacao: avaliacaoDaPrincipal, operacao: compraDaPrincipal, criarConectorFn,
  });
  const [segunda] = await espelharContasSecundarias({
    plataforma: PLATAFORMA, ativo, decisao: decisaoComprar,
    avaliacao: avaliacaoDaPrincipal, operacao: { ...compraDaPrincipal, id: 'op_principal_2' }, criarConectorFn,
  });

  assert.equal(primeira.valor, 1000, '20% de R$ 5.000');
  assert.ok(segunda.valor < primeira.valor, 'a segunda parte de um caixa menor');
  assert.equal(segunda.saldo_conta, 4000, 'e a base é a carteira virtual, não os R$ 5.000 reais');
  assert.equal(segunda.saldo_real_conta, 5000, 'o saldo real fica visível para o dono comparar');

  assert.equal((await obterPosicoesAbertasAtivo('MB', 'BTC', 'simulacao', 'amigo')).length, 2);
});

test('FASE 3a: o ORÇAMENTO do ativo LIMITA a ordem, medido no patrimônio DELA', async () => {
  // A regra 10.1 vale por conta. Com R$ 5.000 de caixa e teto de 10%, os 20%
  // que a IA pediu saem sobre os R$ 500 do orçamento — não sobre os R$ 5.000.
  // (A primeira versão deste teste esperava uma RECUSA na segunda compra; o
  // orçamento não recusa, ele encolhe a ordem. O código estava certo.)
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  await salvarApiConta('MB', 'amigo', { mb_api_token_id: 'k' });
  invalidarCatalogo();
  const ativo = await ativoParaSombra();
  ativo.config.orcamento_percentual = 10;
  const criarConectorFn = conectorDaConta(5000);

  const [primeira] = await espelharContasSecundarias({
    plataforma: PLATAFORMA, ativo, decisao: decisaoComprar,
    avaliacao: avaliacaoDaPrincipal, operacao: compraDaPrincipal, criarConectorFn,
  });
  assert.equal(primeira.aprovada, true);
  assert.equal(primeira.valor, 100, '20% de R$ 500 (o teto), e não de R$ 5.000');

  // E a ordem seguinte encolhe de novo: o orçamento livre já foi ocupado.
  const [segunda] = await espelharContasSecundarias({
    plataforma: PLATAFORMA, ativo, decisao: decisaoComprar,
    avaliacao: avaliacaoDaPrincipal, operacao: { ...compraDaPrincipal, id: 'op_principal_2' }, criarConectorFn,
  });
  assert.ok(segunda.valor < primeira.valor, 'sobra menos orçamento, ordem menor');
});

test('FASE 3a: orçamento 0 não compra nada — como em qualquer ativo do sistema', async () => {
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  await salvarApiConta('MB', 'amigo', { mb_api_token_id: 'k' });
  invalidarCatalogo();
  const ativo = await ativoParaSombra();
  ativo.config.orcamento_percentual = 0;

  const [r] = await espelharContasSecundarias({
    plataforma: PLATAFORMA, ativo, decisao: decisaoComprar,
    avaliacao: avaliacaoDaPrincipal, operacao: compraDaPrincipal,
    criarConectorFn: conectorDaConta(5000),
  });
  assert.equal(r.aprovada, false);
  assert.equal(r.status, 'sombra', 'recusada não vira lote nenhum');
  assert.deepEqual(await obterPosicoesAbertasAtivo('MB', 'BTC', 'simulacao', 'amigo'), []);
});

test('FASE 3a: nem a ordem nem o fill tocam a corretora', async () => {
  // A trava das fases 1 a 3a. O conector da conta LANÇA em ordemMercado e em
  // aguardarFill: se um dia a execução real vazar para cá, este teste quebra.
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  await salvarApiConta('MB', 'amigo', { mb_api_token_id: 'k' });
  invalidarCatalogo();

  const [op] = await espelharContasSecundarias({
    plataforma: PLATAFORMA,
    ativo: await ativoParaSombra(),
    decisao: decisaoComprar,
    avaliacao: avaliacaoDaPrincipal,
    operacao: compraDaPrincipal,
    criarConectorFn: conectorDaConta(5000),
  });
  assert.equal(op.status, 'simulada', 'executou, e executou em simulação');
});

// =========================================== FASE 4 — saídas automáticas
// Os dois chãos do Motor sobre os lotes DA CONTA. É o que torna a divergência
// aceitável: a conta não recebe a venda da IA, mas 81% das vendas do sistema
// são do Motor — e o Motor funciona aqui, de graça.

/** Abre um lote na conta espelho comprando via espelho, e devolve o lote. */
async function loteNaConta({ orcamento = 100, saldo = 5000, stopLoss = 92000 } = {}) {
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  await salvarApiConta('MB', 'amigo', { mb_api_token_id: 'k' });
  invalidarCatalogo();
  const ativo = await ativoParaSombra();
  ativo.config.orcamento_percentual = orcamento;
  await espelharContasSecundarias({
    plataforma: PLATAFORMA,
    ativo,
    decisao: { ...decisaoComprar, stop_loss: stopLoss },
    avaliacao: avaliacaoDaPrincipal,
    operacao: compraDaPrincipal,
    criarConectorFn: conectorDaConta(saldo),
  });
  const [lote] = await obterPosicoesAbertasAtivo('MB', 'BTC', 'simulacao', 'amigo');
  return { ativo, lote };
}

test('FASE 4: o STOP-LOSS da conta dispara pelo chão DO LOTE DELA', async () => {
  const { ativo, lote } = await loteNaConta({ stopLoss: 95000 });
  assert.equal(lote.stop_loss, 95000);

  const [saida] = await saidasAutomaticasDasContas({
    plataforma: PLATAFORMA, ativo, precoAtual: 94000, criarConectorFn: conectorDaConta(4000),
  });

  assert.ok(saida, 'o chão foi furado e a saída aconteceu');
  assert.equal(saida.origem_decisao, 'motor_stop_loss');
  assert.equal(saida.tipo, 'VENDA');
  assert.equal(saida.status, 'simulada');
  assert.ok(saida.lucro_liquido < 0, 'stop realiza prejuízo — é o objetivo dele');

  const fechado = (await obterPosicoesAtivoPorModoConta())[0];
  assert.equal(fechado.status, 'FECHADA');
  assert.equal(fechado.fechada_por, 'stop_loss');
  assert.equal(fechado.aberta_modo, null, 'sai da query do caminho quente (invariante V5.2)');
  assert.deepEqual(await obterPosicoesAbertasAtivo('MB', 'BTC', 'simulacao', 'amigo'), []);
});

test('FASE 4: acima do chão, nada sai', async () => {
  const { ativo } = await loteNaConta({ stopLoss: 95000 });
  const saidas = await saidasAutomaticasDasContas({
    plataforma: PLATAFORMA, ativo, precoAtual: 99000, criarConectorFn: conectorDaConta(4000),
  });
  assert.deepEqual(saidas, []);
  assert.equal((await obterPosicoesAbertasAtivo('MB', 'BTC', 'simulacao', 'amigo')).length, 1);
});

test('FASE 4: a TRAVA DE LUCRO arma no pico e realiza o ganho da conta', async () => {
  const { ativo } = await loteNaConta({ stopLoss: 92000 });

  // Sobe: arma a trava (nada é vendido enquanto o preço está no topo).
  assert.deepEqual(
    await saidasAutomaticasDasContas({ plataforma: PLATAFORMA, ativo, precoAtual: 106000, criarConectorFn: conectorDaConta(4000) }),
    [],
  );
  const [armado] = await obterPosicoesAbertasAtivo('MB', 'BTC', 'simulacao', 'amigo');
  assert.ok(armado.trava_lucro > 0, 'a trava armou no livro DA CONTA');

  // Devolve o pico: a trava é furada e o Motor realiza.
  const [saida] = await saidasAutomaticasDasContas({
    plataforma: PLATAFORMA, ativo, precoAtual: 105000, criarConectorFn: conectorDaConta(4000),
  });
  assert.ok(saida, 'a trava foi furada');
  assert.equal(saida.origem_decisao, 'motor_trava_lucro');
  assert.ok(saida.lucro_liquido > 0, 'a trava só realiza LUCRO — nunca prejuízo');

  const fechado = (await obterPosicoesAtivoPorModoConta())[0];
  assert.equal(fechado.fechada_por, 'lucro');
});

test('FASE 4: REGRA IMUTÁVEL 4 — a TRAVA nunca vende lote sem lucro na conta', async () => {
  // O teste que não pode ser afrouxado.
  //
  // A folga vai a 30% de propósito: com os 2% do padrão, o trailing sobe o chão
  // até 103.880 no pico de 106.000 e QUEM vende a 99.000 é o stop-loss — que é
  // a exceção legítima à regra 4, e não o que este teste mede. (Foi assim que a
  // primeira versão dele falhou: o código estava certo, o teste é que não
  // isolava a trava.) O caso do stop está no teste seguinte.
  const { ativo } = await loteNaConta({ stopLoss: 80000 });
  ativo.config.stop_loss_trailing_percentual = 30;

  await saidasAutomaticasDasContas({ plataforma: PLATAFORMA, ativo, precoAtual: 106000, criarConectorFn: conectorDaConta(4000) });
  const [armado] = await obterPosicoesAbertasAtivo('MB', 'BTC', 'simulacao', 'amigo');
  assert.ok(armado.trava_lucro > 0, 'a trava está armada');
  assert.ok(armado.stop_loss < 99000, 'e o chão ficou LONGE, para o stop não roubar o caso');

  // Preço volta para baixo do empate: a trava está furada, mas o lote está no
  // vermelho. Quem cuida de prejuízo é o stop — a trava não vende, ponto.
  const saidas = await saidasAutomaticasDasContas({
    plataforma: PLATAFORMA, ativo, precoAtual: 99000, criarConectorFn: conectorDaConta(4000),
  });
  assert.deepEqual(saidas, [], 'nenhuma venda no vermelho pode sair da trava');
  assert.equal((await obterPosicoesAbertasAtivo('MB', 'BTC', 'simulacao', 'amigo')).length, 1);
});

test('FASE 4: o STOP-LOSS da conta VENDE no prejuízo — a exceção legítima, e só ela', async () => {
  // O contraponto do teste acima, e o que a primeira versão dele flagrou sem
  // querer: com a folga padrão de 2%, o trailing sobe o chão para 103.880 no
  // pico, e a 99.000 quem vende é o stop. Isso é CERTO: o stop é a única via do
  // Motor autorizada a realizar prejuízo (§10.2), e ela vale igual na conta
  // espelho.
  const { ativo } = await loteNaConta({ stopLoss: 80000 });
  await saidasAutomaticasDasContas({ plataforma: PLATAFORMA, ativo, precoAtual: 106000, criarConectorFn: conectorDaConta(4000) });
  const [comChaoAlto] = await obterPosicoesAbertasAtivo('MB', 'BTC', 'simulacao', 'amigo');
  assert.ok(comChaoAlto.stop_loss > 100000, 'o trailing subiu o chão acima do preço de compra');

  const [saida] = await saidasAutomaticasDasContas({
    plataforma: PLATAFORMA, ativo, precoAtual: 99000, criarConectorFn: conectorDaConta(4000),
  });
  assert.equal(saida.origem_decisao, 'motor_stop_loss', 'quem vendeu foi o stop, não a trava');
  assert.ok(saida.lucro_liquido < 0);
  const fechado = (await obterPosicoesAtivoPorModoConta())[0];
  assert.equal(fechado.fechada_por, 'stop_loss');
});

test('FASE 4: conta SEM lote não gera trabalho nenhum', async () => {
  await salvarConta('MB', 'amigo', { nome: 'Conta do João' });
  invalidarCatalogo();
  const saidas = await saidasAutomaticasDasContas({
    plataforma: PLATAFORMA, ativo: await ativoParaSombra(), precoAtual: 94000,
    criarConectorFn: () => { throw new Error('não deveria nem construir conector'); },
  });
  assert.deepEqual(saidas, []);
});

test('FASE 4: a saída da conta NÃO toca as posições da principal', async () => {
  // O isolamento das duas árvores, agora do lado da venda.
  const { ativo } = await loteNaConta({ stopLoss: 95000 });
  await abrirPosicao({
    plataforma: 'MB', ativo: 'BTC', modo: 'simulacao', origem: 'bot',
    quantidade: 0.01, preco_compra: 100000, stop_loss: 95000,
  });

  await saidasAutomaticasDasContas({
    plataforma: PLATAFORMA, ativo, precoAtual: 94000, criarConectorFn: conectorDaConta(4000),
  });

  const daPrincipal = await obterPosicoesAbertasAtivo('MB', 'BTC', 'simulacao');
  assert.equal(daPrincipal.length, 1, 'o lote da principal continua ABERTO');
  assert.equal(daPrincipal[0].status !== 'FECHADA', true);
});
